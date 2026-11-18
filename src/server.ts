/**
 * Vercel Fastify entrypoint (`src/server.ts`).
 * Local/Docker continue to use `src/server/index.ts` / `dist/server/index.js`.
 */
import { loadDotEnv } from './core/env.js';
import { startServer } from './server/start.js';

loadDotEnv();

await startServer();
