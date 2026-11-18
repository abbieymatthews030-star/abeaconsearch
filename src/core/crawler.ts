import * as cheerio from 'cheerio';
import type { Logger } from './logger.js';
import { hostIsPrivate } from './net-guard.js';
import { extractReadable, fetchHtml } from './readable.js';
import { fetchRobots, RobotsRules } from './robots.js';
import type { DocumentInput } from './types.js';

export interface CrawlOptions {
  url: string;
  maxPages: number;
  sameOriginOnly: boolean;
  tags: string[];
  userAgent: string;
  timeoutMs: number;
  delayMs: number;
  concurrency: number;
  respectRobots?: boolean;
  /** Allow crawling loopback / private / link-local hosts (SSRF guard). */
  allowPrivateHosts?: boolean;
}

export interface CrawlDeps {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Invoked for every successfully extracted page. */
  onPage?: (page: DocumentInput) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CrawlResult {
  startUrl: string;
  pagesCrawled: number;
  pages: DocumentInput[];
  errors: Array<{ url: string; error: string }>;
  skipped: Array<{ url: string; reason: string }>;
  /** How robots.txt was resolved for this crawl. */
  robotsStatus?: 'ok' | 'missing' | 'error' | 'disabled';
  warnings?: string[];
}

const SKIP_EXTENSION =
  /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|pdf|zip|gz|tar|mp4|mp3|woff2?|ttf|eot)(\?|#|$)/i;

function collectLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = '';
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        out.add(resolved.toString());
      }
    } catch {
      /* ignore malformed hrefs */
    }
  });
  return [...out];
}

/**
 * Breadth-first crawl a website, extracting a searchable document per HTML page.
 * Honours robots.txt (for the configured user agent) unless disabled.
 */
export async function crawl(options: CrawlOptions, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger;
  const respectRobots = options.respectRobots !== false; // default: honour robots.txt
  const start = new URL(options.url);
  const origin = start.origin;

  if (!options.allowPrivateHosts && (await hostIsPrivate(start.hostname))) {
    return {
      startUrl: start.toString(),
      pagesCrawled: 0,
      pages: [],
      errors: [
        {
          url: start.toString(),
          error:
            'refusing to crawl a private or loopback host; set BEACON_CRAWL_ALLOW_PRIVATE=true to override',
        },
      ],
      skipped: [],
    };
  }

  const warnings: string[] = [];
  let robots: RobotsRules;
  let robotsStatus: CrawlResult['robotsStatus'];
  if (respectRobots) {
    const fetched = await fetchRobots(origin, options.userAgent, fetchImpl, options.timeoutMs);
    robots = fetched.rules;
    robotsStatus = fetched.status;
    if (fetched.status === 'error') {
      warnings.push(
        'robots.txt unreachable; proceeding with allow-all (fail-open). Re-check the host if this is unexpected.',
      );
    } else if (fetched.status === 'missing') {
      warnings.push('robots.txt missing or non-OK; proceeding with allow-all.');
    }
  } else {
    robots = new RobotsRules('', options.userAgent);
    robotsStatus = 'disabled';
  }

  const result: CrawlResult = {
    startUrl: start.toString(),
    pagesCrawled: 0,
    pages: [],
    errors: [],
    skipped: [],
    robotsStatus,
    warnings,
  };

  const seen = new Set<string>([start.toString()]);
  let frontier: string[] = [start.toString()];

  while (frontier.length > 0 && result.pagesCrawled < options.maxPages) {
    if (deps.signal?.aborted) break;
    const budget = options.maxPages - result.pagesCrawled;
    const batch = frontier.slice(0, Math.min(options.concurrency, budget));
    frontier = frontier.slice(batch.length);
    const discovered: string[] = [];

    await Promise.all(
      batch.map(async (pageUrl) => {
        const parsed = new URL(pageUrl);
        if (respectRobots && !robots.isAllowed(parsed.pathname)) {
          result.skipped.push({ url: pageUrl, reason: 'blocked by robots.txt' });
          return;
        }
        if (!options.allowPrivateHosts && (await hostIsPrivate(parsed.hostname))) {
          result.skipped.push({ url: pageUrl, reason: 'private or loopback host' });
          return;
        }

        const fetched = await fetchHtml(pageUrl, {
          userAgent: options.userAgent,
          timeoutMs: options.timeoutMs,
          fetchImpl,
          signal: deps.signal,
        });
        if ('error' in fetched) {
          result.errors.push({ url: pageUrl, error: fetched.error });
          return;
        }

        result.pagesCrawled += 1;
        const page = extractReadable(fetched.html, fetched.finalUrl, options.tags);
        if (page) {
          result.pages.push(page);
          await deps.onPage?.(page);
        } else {
          result.skipped.push({ url: pageUrl, reason: 'no extractable content' });
        }

        const $ = cheerio.load(fetched.html);
        for (const link of collectLinks($, fetched.finalUrl)) {
          if (seen.has(link) || SKIP_EXTENSION.test(link)) continue;
          if (options.sameOriginOnly && new URL(link).origin !== origin) continue;
          seen.add(link);
          discovered.push(link);
        }
      }),
    );

    frontier.push(...discovered);
    if (options.delayMs > 0 && frontier.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    logger?.debug({ crawled: result.pagesCrawled, queued: frontier.length }, 'crawl progress');
  }

  return result;
}
