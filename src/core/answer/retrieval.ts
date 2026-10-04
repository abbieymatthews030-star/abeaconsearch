import type { AnswerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { hostIsPrivate } from '../net-guard.js';
import { extractReadable, fetchHtml } from '../readable.js';
import { fetchRobots } from '../robots.js';
import type { RobotsRules } from '../robots.js';
import { normalizeWhitespace } from '../text.js';
import type { BeaconDocument, SearchQuery, SearchResponse } from '../types.js';
import { searchQuerySchema } from '../types.js';
import { classifyTrust } from './trust.js';
import type { TrustTier } from './types.js';
import { evaluateSource, stripLeadingNavList, type SourceEvidence } from './evidence.js';
import type { WebSearchProvider } from './providers/web-search.js';
import { fanOutWebSearch, type WebBackend } from '../search/fanout.js';
import { detectIntent } from '../search/intent.js';
import { isRelevantLocalHit } from '../search/relevance.js';

/** A source gathered for answering, with its full body text for extraction. */
export interface RetrievedSource extends SourceEvidence {
  id: number;
  title: string;
  url?: string;
  origin: 'index' | 'web';
  domain?: string;
  trust: TrustTier;
  trustReason: string;
  live: boolean;
  retrievedAt: string;
  /** Plain body text, truncated. */
  text: string;
}

/** Minimal view of the search engine the retriever needs. */
export interface EngineLike {
  search(query: SearchQuery, options?: { combineWith?: 'AND' | 'OR' }): SearchResponse;
  get(id: string): BeaconDocument | undefined;
}

export interface GatherDeps {
  engine: EngineLike;
  webSearch: readonly WebSearchProvider[] | null;
  config: AnswerConfig;
  userAgent: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  signal?: AbortSignal;
}

export interface GatherResult {
  sources: RetrievedSource[];
  warnings: string[];
}

const MAX_SOURCE_CHARS = 4000;
const TRUST_ORDER: Record<TrustTier, number> = {
  official: 0,
  established: 1,
  community: 2,
  unverified: 3,
};

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch {
    return url;
  }
}

// Common cross-site tracking params worth stripping from a URL before it's
// shown or cited — marketing UTM tags and the per-vendor click-id params.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|msclkid|dclid|twclid|igshid|mc_eid|mc_cid|yclid|_ga|_gl)$/i,
];

function stripTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function fromIndex(query: string, deps: GatherDeps, limit: number): RetrievedSource[] {
  const parsed = searchQuerySchema.parse({ q: query, limit });
  // OR-combine: a natural-language question ("where do penguins live") rarely has
  // every token in one document. Relevance is re-checked when grounding claims.
  const response = deps.engine.search(parsed, { combineWith: 'OR' });
  const intent = detectIntent(query);
  const out: RetrievedSource[] = [];
  for (const hit of response.hits) {
    const doc = deps.engine.get(hit.id);
    if (!doc) continue;
    if (!isRelevantLocalHit(query, doc, { fuzzy: true, prefix: true, intent })) continue;
    const text = stripLeadingNavList(normalizeWhitespace(doc.body)).slice(0, MAX_SOURCE_CHARS);
    if (!text) continue;
    const trust = classifyTrust(doc.url, 'index', deps.config.trustedDomains);
    out.push({
      id: 0,
      title: doc.title,
      url: doc.url,
      origin: 'index',
      domain: domainOf(doc.url),
      trust: trust.tier,
      trustReason: trust.reason,
      live: false,
      retrievedAt: doc.updatedAt,
      text,
      ...evaluateSource(query, doc.title, text, trust.tier),
    });
  }
  return out;
}

async function fetchWebPage(
  query: string,
  result: { title: string; url: string; snippet?: string },
  deps: GatherDeps,
  robotsCache: Map<string, RobotsRules>,
): Promise<RetrievedSource | { error: string; url: string }> {
  const { config, userAgent, fetchImpl, signal } = deps;
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    return { error: 'invalid URL', url: result.url };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `unsupported protocol ${parsed.protocol}`, url: result.url };
  }
  if (!config.allowPrivateHosts && (await hostIsPrivate(parsed.hostname))) {
    return { error: 'private or loopback host (blocked)', url: result.url };
  }

  let robots = robotsCache.get(parsed.origin);
  if (!robots) {
    robots = await fetchRobots(parsed.origin, userAgent, fetchImpl ?? fetch, config.fetchTimeoutMs);
    robotsCache.set(parsed.origin, robots);
  }
  if (!robots.isAllowed(parsed.pathname)) {
    return { error: 'blocked by robots.txt', url: result.url };
  }

  const fetched = await fetchHtml(result.url, {
    userAgent,
    timeoutMs: config.fetchTimeoutMs,
    fetchImpl,
    signal,
  });
  if ('error' in fetched) return { error: fetched.error, url: result.url };

  const readable = extractReadable(fetched.html, fetched.finalUrl);
  const text = stripLeadingNavList(normalizeWhitespace(readable?.body ?? '')).slice(
    0,
    MAX_SOURCE_CHARS,
  );
  if (!text) return { error: 'no extractable content', url: result.url };

  const trust = classifyTrust(fetched.finalUrl, 'web', config.trustedDomains);
  const citedUrl = config.stripTrackingParams
    ? stripTrackingParams(fetched.finalUrl)
    : fetched.finalUrl;
  const title = readable?.title || result.title || fetched.finalUrl;
  return {
    id: 0,
    title,
    url: citedUrl,
    origin: 'web',
    domain: domainOf(citedUrl),
    trust: trust.tier,
    trustReason: trust.reason,
    live: true,
    retrievedAt: new Date().toISOString(),
    text,
    ...evaluateSource(query, title, text, trust.tier),
  };
}

/**
 * Gather candidate sources for `query` from the local index and — when a web
 * search provider is configured — from the live web, fetched through the same
 * robots / SSRF-guard / timeout stack the crawler uses.
 */
export async function gatherSources(query: string, deps: GatherDeps): Promise<GatherResult> {
  const warnings: string[] = [];
  const { config } = deps;

  const indexSources = fromIndex(query, deps, Math.max(3, Math.ceil(config.maxSources / 2)));

  let webSources: RetrievedSource[] = [];
  const providers = deps.webSearch ?? [];
  if (providers.length === 0) {
    warnings.push(
      'web search is not configured — set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL. Keyless DuckDuckGo and Wikipedia are off (BEACON_KEYLESS_WEB_SEARCH). Answering from the local index only',
    );
  } else {
    try {
      // Overfetch candidates: a page can be unreachable, robots-blocked, or
      // empty, and simply asking for exactly `maxSources` means any of those
      // silently shrinks the result count. Asking for more up front — capped
      // at what search providers return per page anyway — gives the later
      // trust-ranked selection a real pool to pick the best sources from
      // instead of whatever arbitrary subset happened to succeed.
      const requested = Math.min(config.maxSources * 3, 20);
      const backends: WebBackend[] = providers.map((provider) => ({
        id: provider.name.toLowerCase().replace(/\s+/g, '-'),
        label: provider.name,
        missingEnv: [],
        provider,
      }));
      const fan = await fanOutWebSearch({
        backends,
        query,
        intent: detectIntent(query),
        limit: requested,
        signal: deps.signal,
        filter: 'off',
      });
      for (const attempt of fan.attempts) {
        if (attempt.status === 'error') warnings.push(`${attempt.label} failed: ${attempt.detail}`);
      }
      const results = fan.results;
      const robotsCache = new Map<string, RobotsRules>();
      const settled = await Promise.all(
        results.slice(0, requested).map((r) => fetchWebPage(query, r, deps, robotsCache)),
      );
      let unreachable = 0;
      for (const item of settled) {
        if ('error' in item) {
          unreachable += 1;
          deps.logger?.debug({ url: item.url, reason: item.error }, 'answer: source skipped');
        } else {
          webSources.push(item);
        }
      }
      if (unreachable > 0) {
        deps.logger?.debug(
          { unreachable, requested: results.length },
          'answer: some candidates skipped',
        );
        // Only surface this to the reader when the overfetch didn't make up
        // for it — some failures are expected and already absorbed above.
        if (webSources.length < config.maxSources) {
          warnings.push(
            `${unreachable} web source${unreachable === 1 ? '' : 's'} could not be fetched or read`,
          );
        }
      }
    } catch (error) {
      warnings.push(`web search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Dedupe: drop a web source whose URL matches an index source.
  const indexUrls = new Set(
    indexSources.map((s) => (s.url ? canonicalUrl(s.url) : '')).filter(Boolean),
  );
  const seen = new Set<string>(indexUrls);
  webSources = webSources.filter((s) => {
    const key = s.url ? canonicalUrl(s.url) : `web:${s.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const combined = [...indexSources, ...webSources]
    .sort((a, b) => TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust])
    .slice(0, config.maxSources)
    .map((source, i) => ({ ...source, id: i + 1 }));

  return { sources: combined, warnings };
}
