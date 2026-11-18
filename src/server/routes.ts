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
  type ClassifiedQuery,
  type PrimaryResult,
  type UniversalQueryResponse,
} from '../core/query-router.js';
import { runUniversalSearch } from '../core/search/orchestrator.js';
import type { RuntimeSettingsStore } from '../core/runtime-settings.js';
import type { PersistentEngine } from '../core/store.js';
import {
  browseOnion,
  probeTorSocks,
  searchTorNetwork,
  torHitsToDisplay,
  type TorStatus,
} from '../core/tor/index.js';
import {
  FALSEY,
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

const idParam = z.object({ id: z.string().min(1) });

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
  const answerCaps = ctx.answerService?.capabilities;
  const persistError = ctx.engine.lastPersistError;
  return {
    status: persistError ? ('degraded' as const) : ('ok' as const),
    documents: ctx.engine.size,
    indexEmpty: ctx.engine.size === 0,
    uptimeSeconds: Math.round(process.uptime()),
    lastPersistedAt: ctx.engine.lastPersistedAt,
    lastPersistError: persistError,
    plateChecks: ctx.plateChecker.capabilities,
    answer: answerCaps
      ? {
          ...answerCaps,
          enabled: Boolean(ctx.config.answer.enabled && answerCaps.enabled),
        }
      : { enabled: false as const, autoAnswer: false, webSearch: null, llm: [] as string[] },
    lookups: { enabled: ctx.config.lookups.enabled },
    tor: {
      enabled: ctx.config.tor.enabled,
      socksUrl: ctx.config.tor.socksUrl,
    },
    site: {
      name: ctx.config.site.name,
      url: ctx.config.site.url,
    },
  };
}

function torErrorPage(message: string, url: string): string {
  const safeMsg = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const safeUrl = url.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tor browse error</title>
<style>body{margin:0;font:14px/1.5 ui-monospace,Menlo,monospace;background:#1a0a24;color:#f5f0fa}
main{max-width:36rem;margin:3rem auto;padding:1.5rem;background:#fff;color:#0a0a0a;border:2px solid #000}
a{color:#4b1d6b}</style></head><body><main>
<h1>Could not open onion link</h1>
<p>${safeMsg}</p>
<p><code>${safeUrl}</code></p>
<p><a href="/">← Back to ABEACON</a></p>
</main></body></html>`;
}

async function runTorQuery(
  ctx: RouteContext,
  q: string,
  limit: number,
  offset: number,
): Promise<UniversalQueryResponse> {
  const started = performance.now();
  const emptyLocal = {
    query: q.trim(),
    total: 0,
    limit,
    offset,
    tookMs: 0,
    hits: [],
    facets: { tags: {}, sources: {} },
  };

  if (!ctx.config.tor.enabled) {
    return {
      query: q.trim(),
      intent: 'general',
      outcome: 'unconfigured',
      synthesis: 'not_applicable',
      local: emptyLocal,
      results: [],
      total: 0,
      tookMs: Number((performance.now() - started).toFixed(1)),
      attempted: ['Tor'],
      queriesTried: [q.trim()].filter(Boolean),
      diagnostics: [
        {
          id: 'tor',
          label: 'Tor',
          status: 'not_configured',
          detail: 'Tor is disabled (BEACON_TOR_ENABLED=false)',
          missingEnv: ['BEACON_TOR_ENABLED'],
          resultCount: 0,
        },
      ],
      actions: [],
      kind: 'general',
      primary: null,
    };
  }

  const probe = await probeTorSocks(
    ctx.config.tor.socksUrl,
    Math.min(ctx.config.tor.timeoutMs, 12_000),
  );
  if (!probe.ok) {
    return {
      query: q.trim(),
      intent: 'general',
      outcome: 'partial',
      synthesis: 'not_applicable',
      local: emptyLocal,
      results: [],
      total: 0,
      tookMs: Number((performance.now() - started).toFixed(1)),
      attempted: ['Tor'],
      queriesTried: [q.trim()].filter(Boolean),
      diagnostics: [
        {
          id: 'tor',
          label: 'Tor',
          status: 'error',
          detail: `Tor SOCKS unreachable at ${ctx.config.tor.socksUrl}: ${probe.error}`,
          missingEnv: [],
          resultCount: 0,
        },
      ],
      actions: [],
      kind: 'general',
      primary: null,
    };
  }

  const { hits, diagnostics } = await searchTorNetwork(q, {
    socksUrl: ctx.config.tor.socksUrl,
    timeoutMs: ctx.config.tor.timeoutMs,
    limit: Math.min(Math.max(limit + offset, limit), 40),
  });
  const display = torHitsToDisplay(hits, q);
  const page = display.slice(offset, offset + limit);
  const detailParts = [
    `${hits.length} onion result${hits.length === 1 ? '' : 's'}`,
    diagnostics.ahmia ? `Ahmia: ${diagnostics.ahmia}` : 'Ahmia ok',
    `directory ${diagnostics.directory}`,
  ];

  return {
    query: q.trim(),
    intent: 'general',
    outcome: page.length > 0 ? 'results' : 'empty',
    synthesis: 'not_applicable',
    local: emptyLocal,
    results: page,
    total: display.length,
    tookMs: Number((performance.now() - started).toFixed(1)),
    attempted: ['Tor', 'Ahmia', 'Tor directory'],
    queriesTried: [q.trim()].filter(Boolean),
    diagnostics: [
      {
        id: 'tor',
        label: 'Tor',
        status: diagnostics.ahmia && hits.length === 0 ? 'error' : 'ok',
        detail: detailParts.join(' · '),
        missingEnv: [],
        resultCount: hits.length,
      },
    ],
    actions: [],
    kind: 'general',
    primary: null,
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

function hasHttpStatus(
  error: unknown,
): error is { statusCode: number; message?: string; validation?: unknown } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  );
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
      reply.status(503).send({ error: 'busy', message: error.message });
      return;
    }
    if (error instanceof HttpError) {
      reply
        .status(error.statusCode)
        .send({ error: codeFor(error.statusCode), message: error.message });
      return;
    }
    if (hasHttpStatus(error) && (error.validation || error.statusCode < 500)) {
      const status = error.statusCode ?? 400;
      reply
        .status(status)
        .send({ error: codeFor(status), message: error.message ?? 'Bad request' });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });
}

async function resolvePrimary(
  classified: ClassifiedQuery,
  config: Config,
  plateChecker: PlateChecker,
  engine: PersistentEngine,
): Promise<PrimaryResult | null> {
  switch (classified.kind) {
    case 'domain':
      return config.lookups.enabled
        ? {
            kind: 'domain',
            domain: classified.value,
            enabled: true,
            data: await lookupDomain(classified.value, { timeoutMs: config.lookups.timeoutMs }),
          }
        : { kind: 'domain', domain: classified.value, enabled: false };
    case 'ip':
      return config.lookups.enabled
        ? {
            kind: 'ip',
            ip: classified.value,
            enabled: true,
            data: await lookupIp(classified.value, { timeoutMs: config.lookups.timeoutMs }),
          }
        : { kind: 'ip', ip: classified.value, enabled: false };
    case 'calculation':
      try {
        return {
          kind: 'calculation',
          expression: classified.value,
          result: evaluateExpression(classified.value),
        };
      } catch (err) {
        return {
          kind: 'calculation',
          expression: classified.value,
          error: err instanceof CalculationError ? err.message : 'could not evaluate',
        };
      }
    case 'plate': {
      const data = await plateChecker.check(classified.value, {
        includeVehicleData: true,
        includeMotHistory: true,
      });
      if (config.plate.indexResults) {
        engine.upsert(plateCheckToDocument(data));
        await engine.flush();
      }
      return { kind: 'plate', data };
    }
    default:
      return null;
  }
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
        // Default on: every query fans out to live web providers unless
        // the caller explicitly opts out with web=off / false.
        if (v === undefined) return 'auto';
        if (typeof v === 'boolean') return v ? 'force' : 'off';
        const s = v.trim().toLowerCase();
        if (s === 'force' || s === 'true' || s === 'on' || s === '1') return 'force';
        if (s === 'auto') return 'auto';
        if (FALSEY.has(s)) return 'off';
        return 'auto';
      });

    const universalQuerySchema = searchQuerySchema.extend({
      web: webModeSchema,
      tor: booleanParam(false),
    });

    // --- Universal query ------------------------------------------------------
    // One box, many shapes: classify the raw text, search the local index, and
    // fan out to every configured web provider (DuckDuckGo / Brave / …) so
    // results are open-web-wide — not limited to indexed pages. Domain / IP /
    // plate / calculation cards still attach alongside the result list. With
    // `tor=true`, clearnet search is skipped and results come only from onion /
    // Tor-directory sources. Pass `web=off` for local-index-only.
    app.get('/query', async (request): Promise<UniversalQueryResponse> => {
      const query = universalQuerySchema.parse(request.query);
      if (query.tor) {
        return runTorQuery(ctx, query.q, query.limit, query.offset);
      }
      const classified = classifyQuery(query.q);

      // Search first, then plate primary (which may upsert into the index) so
      // this response never races a half-written plate-check document.
      const envelope = await runUniversalSearch({
        query: query.q,
        search: query,
        engine,
        config: config.answer,
        web: query.web,
      });
      const primary = await resolvePrimary(classified, config, plateChecker, engine);

      return { ...envelope, kind: classified.kind, primary };
    });

    app.get('/tor/status', async (): Promise<TorStatus> => {
      const checkedAt = new Date().toISOString();
      if (!config.tor.enabled) {
        return {
          enabled: false,
          socksUrl: config.tor.socksUrl,
          reachable: false,
          error: 'Tor is disabled (BEACON_TOR_ENABLED=false)',
          checkedAt,
        };
      }
      const probe = await probeTorSocks(
        config.tor.socksUrl,
        Math.min(config.tor.timeoutMs, 15_000),
      );
      if (probe.ok) {
        return {
          enabled: true,
          socksUrl: config.tor.socksUrl,
          reachable: true,
          isTor: true,
          exitIp: probe.exitIp,
          checkedAt,
        };
      }
      return {
        enabled: true,
        socksUrl: config.tor.socksUrl,
        reachable: false,
        error: probe.error,
        checkedAt,
      };
    });

    app.get('/tor/browse', async (request, reply) => {
      if (!config.tor.enabled) {
        throw new HttpError(503, 'Tor is disabled on this Beacon instance');
      }
      const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(request.query);
      const result = await browseOnion(url, {
        socksUrl: config.tor.socksUrl,
        timeoutMs: config.tor.timeoutMs,
      });
      if (result.kind === 'error') {
        reply.status(result.status);
        return reply.type('text/html').send(torErrorPage(result.message, url));
      }
      if (result.kind === 'html') {
        reply.status(result.status);
        return reply.type('text/html; charset=utf-8').send(result.html);
      }
      reply.status(result.status);
      reply.header('content-type', result.contentType);
      return reply.send(result.body);
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
      const errorIds = Object.keys(errors);
      if (errorIds.length > 0) {
        reply.status(400);
        return {
          error: 'validation_error',
          message: `Could not apply settings: ${errorIds.map((id) => `${id}: ${errors[id]}`).join('; ')}`,
          applied,
          errors,
          settings: ctx.settings.list(),
        };
      }
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
      const { id } = idParam.parse(request.params);
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
      const providers = listProviders(providerDeps, probeCache);
      const providerError = providers.some((p) => p.status === 'error');
      const persistError = engine.lastPersistError;
      const status = persistError || providerError ? ('degraded' as const) : ('ok' as const);
      return {
        status,
        uptimeSeconds: Math.round(process.uptime()),
        checkedAt: new Date().toISOString(),
        documents: stats.documents,
        tags: stats.tags,
        sources: stats.sources,
        lastPersistedAt: stats.lastPersistedAt,
        lastPersistError: persistError,
        providers,
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
      const { id } = idParam.parse(request.params);
      const doc = engine.get(id);
      if (!doc) throw new HttpError(404, `No document with id "${id}"`);
      return doc;
    });

    app.post('/documents', async (request, reply) => {
      const input = documentInputSchema.parse(request.body);
      const created = !input.id || !engine.has(input.id);
      const doc = engine.upsert(input);
      await engine.flush();
      reply.status(created ? 201 : 200);
      return doc;
    });

    app.put('/documents/:id', async (request) => {
      const { id } = idParam.parse(request.params);
      const body = documentInputSchema.omit({ id: true }).parse(request.body);
      const doc = engine.upsert({ ...body, id });
      await engine.flush();
      return doc;
    });

    app.delete('/documents/:id', async (request, reply) => {
      const { id } = idParam.parse(request.params);
      if (!engine.remove(id)) throw new HttpError(404, `No document with id "${id}"`);
      await engine.flush();
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
        robotsStatus: result.robotsStatus,
        warnings: result.warnings ?? [],
      };
    });
  };
};
