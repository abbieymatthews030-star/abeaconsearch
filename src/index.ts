/**
 * Vercel Fastify zero-config entrypoint.
 * Must live at src/index.ts (or another detected path) and import `fastify`
 * so the platform's entrypoint scanner can recognize the app.
 *
 * Vercel Fluid intercepts `listen()` and routes HTTP into the Fastify app.
 * See https://vercel.com/docs/frameworks/backend/fastify
 */
import Fastify from 'fastify';
import { loadConfig } from './core/config.js';
import { loadDotEnv } from './core/env.js';
import { createLogger } from './core/logger.js';
import { PersistentEngine } from './core/store.js';
import { buildApp } from './server/app.js';

// Keep the Fastify symbol live so scanners see a real import (not side-effect only).
void Fastify;

loadDotEnv();

// Ephemeral filesystem on Vercel Functions — keep the index under /tmp.
if (process.env.VERCEL && !process.env.BEACON_DATA_DIR) {
  process.env.BEACON_DATA_DIR = '/tmp/beacon-data';
}

const config = loadConfig();
const logger = createLogger(config);
const engine = new PersistentEngine({
  indexFile: config.indexFile,
  debounceMs: config.persistDebounceMs,
  logger,
});
await engine.load();

const app = await buildApp({ config, engine, logger });

const port = Number(process.env.PORT) || config.port || 3000;
await app.listen({ host: '0.0.0.0', port });

export default app;
