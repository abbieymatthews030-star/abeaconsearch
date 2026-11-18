import { loadDotEnv } from '../core/env.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { PersistentEngine } from '../core/store.js';
import { buildApp } from './app.js';
import { startServer } from './start.js';

loadDotEnv();

/**
 * After `tsc`, Vercel may pick `package.json#main` (`dist/server/index.js`)
 * as the Fastify entrypoint. On Vercel export the app; locally/Docker listen.
 */
async function buildVercelApp() {
  if (!process.env.BEACON_DATA_DIR) {
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
  return buildApp({ config, engine, logger });
}

const app = process.env.VERCEL ? await buildVercelApp() : null;

if (!process.env.VERCEL) {
  startServer().catch((error: unknown) => {
    process.stderr.write(
      `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  });
}

export default app;
