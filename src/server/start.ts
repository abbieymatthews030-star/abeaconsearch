import type { Config } from '../core/config.js';
import { loadConfig } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import { PersistentEngine } from '../core/store.js';
import { buildApp } from './app.js';

export interface StartServerOptions {
  config?: Config;
  logger?: Logger;
}

/**
 * Shared bootstrap for `node dist/server` and `beacon serve`:
 * load config → engine → Fastify → listen, with careful shutdown hooks.
 */
export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);

  const engine = new PersistentEngine({
    indexFile: config.indexFile,
    debounceMs: config.persistDebounceMs,
    logger,
  });
  await engine.load();

  const app = await buildApp({ config, engine, logger });
  await app.listen({ host: config.host, port: config.port });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception — shutting down');
    shutdown('uncaughtException');
  });
}
