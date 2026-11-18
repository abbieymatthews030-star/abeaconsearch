#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../core/config.js';
import { loadDotEnv } from '../core/env.js';
import { createPlateChecker } from '../core/plate/index.js';
import { buildMcpServer } from './server.js';

loadDotEnv();

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const beaconApiUrl =
    process.env.BEACON_API_URL?.trim() ||
    `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;

  const server = buildMcpServer({ config, beaconApiUrl, version: pkg.version });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const caps = createPlateChecker(config).capabilities;
  // stderr is safe for logs on a stdio MCP server; stdout carries the protocol.
  process.stderr.write(
    `beacon-search MCP server ready (plate providers: ` +
      `VES ${caps.vehicleData ? 'on' : 'off'}, ` +
      `MOT ${caps.motHistory ? 'on' : 'off'}; beacon API ${beaconApiUrl})\n`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`Fatal MCP server error: ${String(error)}\n`);
  process.exit(1);
});
