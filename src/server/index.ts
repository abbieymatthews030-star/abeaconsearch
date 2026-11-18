import { startServer } from './start.js';

/**
 * Node/Docker entrypoint. Always listen on PORT / BEACON_PORT.
 * Vercel Fluid Fastify uses `src/index.ts` instead of this file.
 */
startServer().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
