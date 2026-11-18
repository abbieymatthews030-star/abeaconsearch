import { loadDotEnv } from '../core/env.js';
import { startServer } from './start.js';

loadDotEnv();

startServer().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
