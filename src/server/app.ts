import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createAnswerService } from '../core/answer/index.js';
import type { Config } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import { createPlateChecker } from '../core/plate/index.js';
import { RuntimeSettingsStore } from '../core/runtime-settings.js';
import { PersistentEngine } from '../core/store.js';
import { apiRoutes, healthPayload, registerErrorHandler, type RouteContext } from './routes.js';

export interface BuildAppOptions {
  config: Config;
  engine?: PersistentEngine;
  logger?: Logger;
  settings?: RuntimeSettingsStore;
}

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Beacon Search</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a2e}code{background:#eee;padding:.15em .4em;border-radius:4px}</style>
</head><body>
<h1>🔦 Beacon Search API is running</h1>
<p>The web UI has not been built yet. Run <code>npm run build:web</code> (or the full
<code>npm run build</code>) and restart, or use the JSON API directly:</p>
<ul>
<li><code>GET /api/health</code></li>
<li><code>GET /api/search?q=your+query</code></li>
<li><code>POST /api/documents</code> — <code>{ "title": "...", "body": "..." }</code></li>
<li><code>POST /api/crawl</code> — <code>{ "url": "https://example.com" }</code></li>
</ul>
</body></html>`;

/** Construct a fully wired Fastify server. Does not start listening. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config);
  const engine =
    options.engine ??
    new PersistentEngine({
      indexFile: config.indexFile,
      debounceMs: config.persistDebounceMs,
      logger,
    });

  // Load any persisted settings overrides before anything reads `config` —
  // it mutates `config` (and its nested objects) in place, so every service
  // built below, and the rate-limit plugin registered next, sees the
  // user's saved values rather than the raw environment defaults.
  const settings =
    options.settings ??
    new RuntimeSettingsStore({
      file: path.join(config.dataDir, 'settings.json'),
      config,
      logger,
    });
  await settings.load();

  const quietRequests = config.logLevel !== 'debug' && config.logLevel !== 'trace';
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config.maxBodyBytes,
    trustProxy: true,
    logController: new LogController({ disableRequestLogging: quietRequests }),
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: config.corsOrigin });

  if (config.rateLimit.max > 0) {
    await app.register(rateLimit, {
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.windowMs,
    });
  }

  const ctx: RouteContext = {
    config,
    engine,
    settings,
    plateChecker: createPlateChecker(config),
    answerService: createAnswerService(config, { engine, logger }),
  };
  await app.register(apiRoutes(ctx), { prefix: '/api' });

  // Back-compat / convenience alias so `/health` works without the prefix.
  app.get('/health', async () => healthPayload(ctx));

  const hasWebBuild = existsSync(path.join(config.webDir, 'index.html'));
  if (hasWebBuild) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply
        .status(404)
        .send({ error: 'not_found', message: `Route ${request.url} not found` });
    });
    logger.info({ webDir: config.webDir }, 'serving web UI');
  } else {
    app.get('/', async (_request, reply) => reply.type('text/html').send(PLACEHOLDER_PAGE));
    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send({ error: 'not_found', message: `Route ${request.url} not found` }),
    );
    logger.warn({ webDir: config.webDir }, 'web build not found; serving API + placeholder only');
  }

  app.decorate('engine', engine);
  app.decorate('appConfig', config);
  app.addHook('onClose', async () => {
    await engine.close();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    engine: PersistentEngine;
    appConfig: Config;
  }
}
