import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../core/config.js';
import { crawl } from '../core/crawler.js';
import type { PlateChecker } from '../core/plate/checker.js';
import { plateCheckToDocument } from '../core/plate/index.js';
import type { PersistentEngine } from '../core/store.js';
import {
  booleanParam,
  bulkInputSchema,
  crawlInputSchema,
  documentInputSchema,
  optionalBooleanParam,
  searchQuerySchema,
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
}

/** Canonical `/health` body, used by both `/health` and `/api/health`. */
export function healthPayload(ctx: Pick<RouteContext, 'engine' | 'plateChecker'>) {
  return {
    status: 'ok' as const,
    documents: ctx.engine.size,
    uptimeSeconds: Math.round(process.uptime()),
    plateChecks: ctx.plateChecker.capabilities,
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
    const codeFor = (status: number) => (status === 404 ? 'not_found' : 'request_error');
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

/** Read a bearer / `X-Beacon-Token` credential off a request. */
function presentedToken(headers: Record<string, unknown>): string {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = headers['x-beacon-token'];
  return typeof header === 'string' ? header.trim() : '';
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const apiRoutes = (ctx: RouteContext): FastifyPluginAsync => {
  return async (app) => {
    const { engine, config, plateChecker } = ctx;

    // Optional write auth: when BEACON_WRITE_TOKEN is set, mutating requests
    // must present it. Reads (and /health) stay open.
    if (config.writeToken) {
      const expected = Buffer.from(config.writeToken);
      app.addHook('onRequest', async (request, reply) => {
        if (READ_METHODS.has(request.method.toUpperCase())) return;
        const candidate = Buffer.from(presentedToken(request.headers));
        const ok = candidate.length === expected.length && timingSafeEqual(candidate, expected);
        if (!ok) {
          reply
            .status(401)
            .header('www-authenticate', 'Bearer realm="beacon", error="invalid_token"')
            .send({
              error: 'unauthorized',
              message: 'A valid write token is required for this operation.',
            });
        }
      });
    }

    app.get('/health', async () => healthPayload(ctx));

    app.get('/stats', async () => engine.stats(config.indexFile));

    app.get('/search', async (request) => {
      const query = searchQuerySchema.parse(request.query);
      return engine.search(query);
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
      reply.status(201);
      return { indexed: stored.length, ids: stored.map((d) => d.id) };
    });

    app.post('/index/clear', async () => {
      engine.clear();
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
