import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Load environment variables from a `.env` file if one exists, without adding a
 * dependency. Uses Node's built-in `process.loadEnvFile` (Node >= 20.12).
 * Existing `process.env` values are not overwritten.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const file = process.env.BEACON_ENV_FILE
    ? path.resolve(cwd, process.env.BEACON_ENV_FILE)
    : path.resolve(cwd, '.env');
  if (!existsSync(file)) return;
  try {
    const loader = (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile;
    if (typeof loader === 'function') loader(file);
  } catch (error) {
    // Defaults still apply, but operators should know their env file was skipped.
    process.stderr.write(
      `[beacon] failed to load env file ${file}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}
