import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AnswerBusyError, type AnswerService } from '../core/answer/index.js';
import type { Config } from '../core/config.js';
import { crawl } from '../core/crawler.js';
import { CalculationError, evaluateExpression } from '../core/lookups/calculator.js';
import { lookupDomain } from '../core/lookups/domain.js';
import { lookupIp } from '../core/lookups/ip.js';
import type { PlateChecker } from '../core/plate/checker.js';
import { plateCheckToDocument } from '../core/plate/index.js';
import { ProbeCache, listProviders, testProvider } from '../core/providers.js';
import {
  classifyQuery,
  type PrimaryResult,
  type UniversalQueryResponse,
} from '../core/query-router.js';
import { runUniversalSearch } from '../core/search/orchestrator.js';
import type { RuntimeSettingsStore } from '../core/runtime-settings.js';
import type { PersistentEngine } from '../core/store.js';
import {
  answerQuerySchema,
  booleanParam,
  bulkInputSchema,
  crawlInputSchema,
  documentInputSchema,
  optionalBooleanParam,
  searchQuerySchema,
  suggestQuerySchema,
} from '../core/types.js';

const plateCheckQuerySchema = z.object({
  vehicle: booleanParam(true),
  mot: booleanParam(true),
  index: optionalBooleanParam,
  referenceDate: z.string().datetime().optional(),
});

const plateCheckBodySchema = plateCheckQuerySchema.extend({
  plate: z.string().min(1).max(16),
});

export interface RouteContext {
  config: Config;
  engine: PersistentEngine;
  plateChecker: PlateChecker;
  answerService: AnswerService | null;
  settings: RuntimeSettingsStore;
}

/** Canonical `/health` body, used by both `/health` and `/api/health`. */
export function healthPayload(
  ctx: Pick<RouteContext, 'engine' | 'plateChecker' | 'answerService' | 'config'>,
) {
  return {
    status: 'ok' as const,
    documents: ctx.engine.size,
    uptimeSeconds: Math.round(process.uptime()),
    plateChecks: ctx.plateChecker.capabilities,
    answer: ctx.answerService
      ? ctx.answerService.capabilities
      : { enabled: false as const, autoAnswer: false, webSearch: null, llm: [] as string[] },
    lookups: { enabled: ctx.config.lookups.enabled },
  };
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        error: 'validation_error',
        message: 'Request did not match the expected schema.',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const codeFor = (status: number) =>
      status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'request_error';
    if (error instanceof AnswerBusyError) {
      reply.status(429).send({ error: 'rate_limited', message: error.message });
      return;
    }
    if (error instanceof HttpError) {
      reply
        .status(error.statusCode)
        .send({ error: codeFor(error.statusCode), message: error.message });
      return;
    }
    const err = error as { statusCode?: number; message?: string; validation?: unknown };
    if (err.validation || (typeof err.statusCode === 'number' && err.statusCode < 500)) {
      const status = err.statusCode ?? 400;
      reply.status(status).send({ error: codeFor(status), message: err.message ?? 'Bad request' });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });
}

export const apiRoutes = (ctx: RouteContext): FastifyPluginAsync => {
  return async (app) => {
    const { engine, config, plateChecker } = ctx;

    app.get('/health', async () => healthPayload(ctx));

    app.get('/stats', async () => engine.stats(config.indexFile));

    app.get('/search', async (request) => {
      const query = searchQuerySchema.parse(request.query);
      return engine.search(query);
    });

    const webModeSchema = z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v): 'auto' | 'off' | 'force' => {
        if (v === undefined) return 'auto';
        if (typeof v === 'boolean') return v ? 'auto' : 'off';
        const s = v.trim().toLowerCase();
        if (s === 'force') return 'force';
        if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return 'off';
        return 'auto';
      });

    const universalQuerySchema = searchQuerySchema.extend({
      web: webModeSchema,
    });

    // --- Universal query ------------------------------------------------------
    // One box, many shapes: classify the raw text, search the local index with
    // a relevance gate, and — when that index has nothing useful — ask every
    // configured web provider. Domain / IP / plate / calculation cards still
    // attach alongside the result list.
    app.get('/query', async (request): Promise<UniversalQueryResponse> => {
      const query = universalQuerySchema.parse(request.query);
      const classified = classifyQuery(query.q);

      const primaryPromise: Promise<PrimaryResult | null> = (async () => {
        if (classified.kind === 'domain') {
          return config.lookups.enabled
            ? {
                kind: 'domain' as const,
                domain: classified.value,
                enabled: true,
                data: await lookupDomain(classified.value, { timeoutMs: config.lookups.timeoutMs }),
              }
            : { kind: 'domain' as const, domain: classified.value, enabled: false };
        }
        if (classified.kind === 'ip') {
          return config.lookups.enabled
            ? {
                kind: 'ip' as const,
                ip: classified.value,
                enabled: true,
                data: await lookupIp(classified.value, { timeoutMs: config.lookups.timeoutMs }),
              }
            : { kind: 'ip' as const, ip: classified.value, enabled: false };
        }
        if (classified.kind === 'calculation') {
          try {
            return {
              kind: 'calculation' as const,
              expression: classified.value,
              result: evaluateExpression(classified.value),
            };
          } catch (err) {
            return {
              kind: 'calculation' as const,
              expression: classified.value,
              error: err instanceof CalculationError ? err.message : 'could not evaluate',
            };
          }
        }
        if (classified.kind === 'plate') {
          return {
            kind: 'plate' as const,
            data: await plateChecker.check(classified.value, {
              includeVehicleData: true,
              includeMotHistory: true,
            }),
          };
        }
        return null;
      })();

      const [envelope, primary] = await Promise.all([
        runUniversalSearch({
          query: query.q,
          search: query,
          engine,
          config: config.answer,
          web: query.web,
        }),
        primaryPromise,
      ]);

      return { ...envelope, kind: classified.kind, primary };
    });

    app.get('/suggest', async (request) => {
      const { q, limit } = suggestQuerySchema.parse(request.query);
      return { query: q.trim(), suggestions: engine.suggest(q, limit) };
    });

    app.get('/answer', async (request) => {
      if (!ctx.answerService || !config.answer.enabled) {
        throw new HttpError(404, 'answer synthesis is disabled');
      }
      const { q, fresh, urls } = answerQuerySchema.parse(request.query);
      return ctx.answerService.answer(q, { fresh, urls });
    });

    // --- Settings ---------------------------------------------------------
    app.get('/settings', async () => ({ settings: ctx.settings.list() }));

    const settingsPatchSchema = z
      .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
      .refine((v) => Object.keys(v).length > 0, 'at least one setting is required');

    app.patch('/settings', async (request, reply) => {
      const patch = settingsPatchSchema.parse(request.body);
      const { applied, errors } = await ctx.settings.update(patch);
      if (applied.length === 0 && Object.keys(errors).length > 0) reply.status(400);
      return { applied, errors, settings: ctx.settings.list() };
    });

    const settingsResetSchema = z.object({ ids: z.array(z.string()).optional() });

    app.post('/settings/reset', async (request) => {
      const { ids } = settingsResetSchema.parse(request.body ?? {});
      const reset = await ctx.settings.reset(ids);
      return { reset, settings: ctx.settings.list() };
    });

    // --- Providers (sources) ------------------------------------------------
    const probeCache = new ProbeCache();
    const providerDeps = { config, engine, plateChecker };

    app.get('/providers', async () => ({ providers: listProviders(providerDeps, probeCache) }));

    app.post('/providers/:id/test', async (request) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const current = listProviders(providerDeps, probeCache).find((p) => p.id === id);
      if (!current) throw new HttpError(404, `Unknown provider "${id}"`);
      if (!current.testable) throw new HttpError(400, `"${id}" has nothing to test`);
      const result = await testProvider(id, providerDeps);
      probeCache.set(id, result);
      return listProviders(providerDeps, probeCache).find((p) => p.id === id);
    });

    // --- Diagnostics ---------------------------------------------------------
    app.get('/diagnostics', async () => {
      const stats = engine.stats(config.indexFile);
      return {
        status: 'ok' as const,
        uptimeSeconds: Math.round(process.uptime()),
        checkedAt: new Date().toISOString(),
        documents: stats.documents,
        tags: stats.tags,
        sources: stats.sources,
        lastPersistedAt: stats.lastPersistedAt,
        providers: listProviders(providerDeps, probeCache),
      };
    });

    app.get('/documents', async (request) => {
      const { limit, offset } = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query);
      const all = engine.list();
      return {
        total: all.length,
        limit,
        offset,
        documents: all.slice(offset, offset + limit),
      };
    });

    app.get('/documents/:id', async (request) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const doc = engine.get(id);
      if (!doc) throw new HttpError(404, `No document with id "${id}"`);
      return doc;
    });

    app.post('/documents', async (request, reply) => {
      const input = documentInputSchema.parse(request.body);
      const created = !input.id || !engine.has(input.id);
      const doc = engine.upsert(input);
      reply.status(created ? 201 : 200);
      return doc;
    });

    app.put('/documents/:id', async (request) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const input = documentInputSchema.parse({ ...(request.body as object), id });
      return engine.upsert(input);
    });

    app.delete('/documents/:id', async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      if (!engine.remove(id)) throw new HttpError(404, `No document with id "${id}"`);
      reply.status(204);
      return null;
    });

    app.post('/documents/bulk', async (request, reply) => {
      const { documents } = bulkInputSchema.parse(request.body);
      const stored = documents.map((doc) => engine.upsert(doc));
      await engine.flush();
      reply.status(201);
      return { indexed: stored.length, ids: stored.map((d) => d.id) };
    });

    app.post('/index/clear', async () => {
      engine.clear();
      await engine.flush();
      return { ok: true, documents: engine.size };
    });

    // --- Number plate checker -------------------------------------------------
    const runPlateCheck = async (plate: string, query: z.infer<typeof plateCheckQuerySchema>) => {
      const check = await plateChecker.check(plate, {
        includeVehicleData: query.vehicle,
        includeMotHistory: query.mot,
        referenceDate: query.referenceDate,
      });
      if (query.index ?? config.plate.indexResults) {
        engine.upsert(plateCheckToDocument(check));
        await engine.flush();
      }
      return check;
    };

    app.get('/plate/:plate', async (request) => {
      const { plate } = z.object({ plate: z.string().min(1).max(16) }).parse(request.params);
      const query = plateCheckQuerySchema.parse(request.query);
      return runPlateCheck(plate, query);
    });

    app.post('/plate/check', async (request) => {
      const { plate, ...query } = plateCheckBodySchema.parse(request.body ?? {});
      return runPlateCheck(plate, query);
    });

    app.post('/crawl', async (request) => {
      const input = crawlInputSchema.parse(request.body);
      const result = await crawl(
        {
          url: input.url,
          maxPages: input.maxPages ?? config.crawlMaxPages,
          sameOriginOnly: input.sameOriginOnly,
          tags: input.tags,
          userAgent: config.crawlUserAgent,
          timeoutMs: config.crawlTimeoutMs,
          delayMs: config.crawlDelayMs,
          concurrency: config.crawlConcurrency,
          allowPrivateHosts: config.crawlAllowPrivateHosts,
        },
        {
          logger: app.log,
          onPage: (page) => {
            engine.upsert(page);
          },
        },
      );
      await engine.flush();
      return {
        startUrl: result.startUrl,
        pagesCrawled: result.pagesCrawled,
        documentsIndexed: result.pages.length,
        errors: result.errors,
        skipped: result.skipped,
      };
    });
  };
};
