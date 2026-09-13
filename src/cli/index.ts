#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { loadDotEnv } from '../core/env.js';
import { crawl } from '../core/crawler.js';
import { createLogger } from '../core/logger.js';
import { createPlateChecker, plateCheckToDocument } from '../core/plate/index.js';
import type { CheckStatus } from '../core/plate/types.js';
import { PersistentEngine } from '../core/store.js';
import { documentInputSchema, type DocumentInput } from '../core/types.js';
import { buildApp } from '../server/app.js';

loadDotEnv();

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

async function openEngine(): Promise<{ engine: PersistentEngine; indexFile: string }> {
  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: 'warn' });
  const engine = new PersistentEngine({
    indexFile: config.indexFile,
    debounceMs: 0,
    logger,
  });
  await engine.load();
  return { engine, indexFile: config.indexFile };
}

const program = new Command();
program
  .name('beacon')
  .description('Beacon Search — self-hostable full-text search engine')
  .version(pkg.version);

program
  .command('serve')
  .description('Start the HTTP API + web UI')
  .option('-p, --port <port>', 'port to listen on')
  .option('-H, --host <host>', 'host to bind')
  .action(async (opts: { port?: string; host?: string }) => {
    const config = loadConfig({
      ...(opts.port ? { port: Number(opts.port) } : {}),
      ...(opts.host ? { host: opts.host } : {}),
    });
    const logger = createLogger(config);
    const engine = new PersistentEngine({
      indexFile: config.indexFile,
      debounceMs: config.persistDebounceMs,
      logger,
    });
    await engine.load();
    const app = await buildApp({ config, engine, logger });
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void app.close().then(() => process.exit(0)));
    }
  });

program
  .command('add')
  .description('Add or update a single document')
  .requiredOption('-t, --title <title>', 'document title')
  .option('-b, --body <body>', 'document body text')
  .option('-u, --url <url>', 'source URL')
  .option('-i, --id <id>', 'explicit document id')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--source <source>', 'source label')
  .action(async (opts: Record<string, string | undefined>) => {
    const { engine } = await openEngine();
    const input = documentInputSchema.parse({
      id: opts.id,
      title: opts.title,
      body: opts.body ?? '',
      url: opts.url,
      source: opts.source,
      tags: opts.tags
        ? opts.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    });
    const doc = engine.upsert(input);
    await engine.flush();
    process.stdout.write(`Indexed ${doc.id}\n`);
  });

program
  .command('import <file>')
  .description('Bulk import documents from a JSON file (array or {documents:[...]})')
  .action(async (file: string) => {
    const { engine } = await openEngine();
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { documents?: unknown[] }).documents)
        ? (parsed as { documents: unknown[] }).documents
        : [];
    if (list.length === 0) throw new Error('No documents found in file');
    let count = 0;
    for (const raw of list) {
      const input: DocumentInput = documentInputSchema.parse(raw);
      engine.upsert(input);
      count += 1;
    }
    await engine.flush();
    process.stdout.write(`Imported ${count} documents\n`);
  });

program
  .command('crawl <url>')
  .description('Crawl a website and index its pages')
  .option('-n, --max-pages <n>', 'maximum pages to fetch')
  .option('--all-origins', 'follow links to other domains', false)
  .option('--tags <tags>', 'comma-separated tags to attach')
  .option('--no-robots', 'ignore robots.txt')
  .action(
    async (
      url: string,
      opts: { maxPages?: string; allOrigins?: boolean; tags?: string; robots?: boolean },
    ) => {
      const config = loadConfig();
      const { engine } = await openEngine();
      const result = await crawl(
        {
          url,
          maxPages: opts.maxPages ? Number(opts.maxPages) : config.crawlMaxPages,
          sameOriginOnly: !opts.allOrigins,
          tags: opts.tags
            ? opts.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          userAgent: config.crawlUserAgent,
          timeoutMs: config.crawlTimeoutMs,
          delayMs: config.crawlDelayMs,
          concurrency: config.crawlConcurrency,
          respectRobots: opts.robots !== false,
          // The CLI is run by a local operator, so intranet crawls are allowed.
          allowPrivateHosts: true,
        },
        {
          onPage: (page) => {
            engine.upsert(page);
            process.stdout.write(`  + ${page.url}\n`);
          },
        },
      );
      await engine.flush();
      process.stdout.write(
        `Crawled ${result.pagesCrawled} pages, indexed ${result.pages.length}, ` +
          `${result.errors.length} errors\n`,
      );
    },
  );

program
  .command('search <query>')
  .description('Run a search against the local index')
  .option('-n, --limit <n>', 'number of results', '10')
  .option('--json', 'output raw JSON', false)
  .action(async (query: string, opts: { limit: string; json?: boolean }) => {
    const { engine, indexFile } = await openEngine();
    const response = engine.search({
      q: query,
      limit: Number(opts.limit),
      offset: 0,
      tags: [],
      fuzzy: true,
      prefix: true,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return;
    }
    if (response.total === 0) {
      process.stdout.write(`No results for "${query}" (index: ${indexFile})\n`);
      return;
    }
    process.stdout.write(`${response.total} result(s) in ${response.tookMs}ms\n\n`);
    for (const hit of response.hits) {
      const plainTitle = hit.title.replace(/<\/?mark>/g, '');
      const plainSnippet = hit.snippet.replace(/<\/?mark>/g, '');
      process.stdout.write(`• ${plainTitle}  [${hit.score}]\n`);
      if (hit.url) process.stdout.write(`  ${hit.url}\n`);
      if (plainSnippet) process.stdout.write(`  ${plainSnippet}\n`);
      process.stdout.write('\n');
    }
  });

program
  .command('stats')
  .description('Show index statistics')
  .action(async () => {
    const { engine, indexFile } = await openEngine();
    process.stdout.write(`${JSON.stringify(engine.stats(indexFile), null, 2)}\n`);
  });

program
  .command('plate <registration>')
  .description('Run automatic checks on a UK or Australian number plate')
  .option('--country <code>', 'force interpretation as "GB" or "AU" instead of auto-detecting')
  .option('--no-vehicle', 'skip the DVLA Vehicle Enquiry Service lookup (GB only)')
  .option('--no-mot', 'skip the DVSA MOT history lookup (GB only)')
  .option('--index', 'also store the result in the search index', false)
  .option('--json', 'output raw JSON', false)
  .action(
    async (
      registration: string,
      opts: {
        country?: string;
        vehicle?: boolean;
        mot?: boolean;
        index?: boolean;
        json?: boolean;
      },
    ) => {
      const country = opts.country?.trim().toUpperCase();
      if (country && country !== 'GB' && country !== 'AU') {
        throw new Error(`Unsupported --country "${opts.country}" (expected "GB" or "AU")`);
      }
      const config = loadConfig();
      const checker = createPlateChecker(config);
      const check = await checker.check(registration, {
        country: country as 'GB' | 'AU' | undefined,
        includeVehicleData: opts.vehicle !== false,
        includeMotHistory: opts.mot !== false,
      });

      if (opts.index) {
        const { engine } = await openEngine();
        engine.upsert(plateCheckToDocument(check));
        await engine.flush();
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
        return;
      }

      const icon: Record<CheckStatus, string> = {
        pass: '✔',
        warn: '▲',
        fail: '✘',
        info: 'ℹ',
        skipped: '·',
      };
      process.stdout.write(`\n  ${check.formatted}  —  ${check.summary.headline}\n`);
      process.stdout.write(
        `  country: ${check.country}   format: ${check.format}   valid: ${check.valid ? 'yes' : 'no'}   ` +
          `${check.summary.pass} passed / ${check.summary.warn} warnings / ${check.summary.fail} failed\n\n`,
      );
      for (const item of check.checks) {
        process.stdout.write(`  ${icon[item.status]} ${item.label}: ${item.detail}\n`);
      }
      process.stdout.write(`\n  sources: ${check.sources.join(', ')}\n`);
    },
  );

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
