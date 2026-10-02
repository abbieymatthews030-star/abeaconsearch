import { loadConfig } from '../core/config.js';
import { loadDotEnv } from '../core/env.js';
import { createLogger } from '../core/logger.js';
import { PersistentEngine } from '../core/store.js';
import { buildApp } from './app.js';

loadDotEnv();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

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

  // A single unhandled rejection or stray exception should not silently
  // kill — or silently limp along in — a long-running server. Log it with
  // full context either way; exit only when the process state is no longer
  // trustworthy (a synchronous throw outside any handler).
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception — shutting down');
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
