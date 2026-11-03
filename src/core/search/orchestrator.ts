import { describeWebProviders } from '../answer/providers/web-search.js';
import type { AnswerConfig } from '../config.js';
import { highlight, makeSnippet } from '../text.js';
import type { BeaconDocument, SearchQuery, SearchResponse } from '../types.js';
import type { WebBackend } from './fanout.js';
import { fanOutWebSearch } from './fanout.js';
import { buildSearchActions, detectIntent, stripQuotes } from './intent.js';
import {
  assessLocalHit,
  canonicalUrl,
  domainOf,
  scoreMatch,
  significantTokens,
  titleKey,
  isCloseSpelling,
} from './relevance.js';
import type {
  DisplayHit,
  SearchDiagnostic,
  SearchEnvelope,
  SearchOutcome,
  SynthesisState,
} from './types.js';

export interface Searchable {
  search(query: SearchQuery, options?: { combineWith?: 'AND' | 'OR' }): SearchResponse;
  get(id: string): BeaconDocument | undefined;
}

export type WebMode = 'auto' | 'off' | 'force';

export interface RunSearchOptions {
  query: string;
  search: SearchQuery;
  engine: Searchable;
  config: AnswerConfig;
  /**
   * `auto` keeps the default (local hits win for ordinary searches).
   * `off` never calls the web. `force` always does, including when the
   * local index already matched a general query.
   */
  web?: WebMode;
  /** @deprecated Prefer `web: 'off'`. Kept so existing callers still compile. */
  includeWeb?: boolean;
  /** Test override. When set, these backends are used instead of the configured providers. */
  backends?: WebBackend[];
  signal?: AbortSignal;
}

interface Ranked {
  hit: DisplayHit;
  plainTitle: string;
  domain?: string;
  summaryReady: boolean;
}

const WEB_INTENTS = new Set([
  'person',
  'company',
  'domain',
  'ip',
  'email',
  'username',
  'phone',
  'location',
  'factual',
  'general',
]);

function webModeOf(options: RunSearchOptions): WebMode {
  if (options.web) return options.web;
  if (options.includeWeb === false) return 'off';
  return 'auto';
}

/** Tag filters are AND, matching the local engine. Source matches the chip label (`provider`). */
function passesFilters(item: Ranked, search: SearchQuery): boolean {
  if (search.source && item.hit.provider !== search.source) return false;
  if (search.tags.length > 0 && !search.tags.every((tag) => item.hit.tags.includes(tag))) {
    return false;
  }
  return true;
}

function compareRanked(sort: SearchQuery['sort'], a: Ranked, b: Ranked): number {
  if (sort === 'title') {
    return a.plainTitle.localeCompare(b.plainTitle) || b.hit.score - a.hit.score;
  }
  if (sort === 'newest' || sort === 'oldest') {
    const av = a.hit.updatedAt ?? '';
    const bv = b.hit.updatedAt ?? '';
    if (av !== bv) {
      if (!av) return 1;
      if (!bv) return -1;
      return sort === 'newest' ? bv.localeCompare(av) : av.localeCompare(bv);
    }
  }
  return b.hit.score - a.hit.score;
}

function usefulSuggestion(query: string, suggestion: string | undefined): string | undefined {
  if (!suggestion) return undefined;
  const tokens = significantTokens(query);
  const candidate = suggestion.toLowerCase();
  if (tokens.some((term) => term === candidate || isCloseSpelling(term, candidate)))
    return suggestion;
  return undefined;
}

function indexHits(
  engine: Searchable,
  search: SearchQuery,
  intent: ReturnType<typeof detectIntent>,
): { ranked: Ranked[]; raw: SearchResponse } {
  const wide = engine.search({
    ...search,
    limit: Math.min(80, search.limit + search.offset + 40),
    offset: 0,
  });
  const ranked: Ranked[] = [];
  for (const hit of wide.hits) {
    const doc = engine.get(hit.id);
    if (!doc) continue;
    const assessment = assessLocalHit(search.q, doc, {
      fuzzy: search.fuzzy,
      prefix: search.prefix,
      intent,
    });
    if (!assessment.ok) continue;
    const domain = domainOf(doc.url);
    const plainSnippet = makeSnippet(doc.body, significantTokens(search.q));
    ranked.push({
      hit: {
        id: doc.id,
        title: hit.title,
        url: doc.url,
        snippet: hit.snippet,
        domain,
        origin: 'index',
        provider: doc.source || 'Local index',
        score: scoreMatch(
          search.q,
          doc.title,
          plainSnippet || doc.body.slice(0, 400),
          domain,
          assessment.helpFactor,
        ),
        tags: doc.tags,
        updatedAt: doc.updatedAt,
      },
      plainTitle: doc.title,
      domain,
      summaryReady: assessment.coverage >= 1 && doc.body.trim().length > 40,
    });
  }
  return { ranked, raw: wide };
}

function filteredLocalResponse(
  search: SearchQuery,
  raw: SearchResponse,
  kept: Ranked[],
): SearchResponse {
  const page = kept.slice(search.offset, search.offset + search.limit);
  const facets = { tags: {} as Record<string, number>, sources: {} as Record<string, number> };
  for (const item of kept) {
    for (const tag of item.hit.tags) facets.tags[tag] = (facets.tags[tag] ?? 0) + 1;
    const source = item.hit.provider;
    if (source) facets.sources[source] = (facets.sources[source] ?? 0) + 1;
  }
  return {
    query: search.q.trim(),
    total: kept.length,
    limit: search.limit,
    offset: search.offset,
    tookMs: raw.tookMs,
    hits: page.map((item) => ({
      id: item.hit.id,
      score: item.hit.score,
      title: item.hit.title,
      url: item.hit.url,
      tags: item.hit.tags,
      source: item.hit.provider,
      snippet: item.hit.snippet,
      terms: significantTokens(search.q),
    })),
    facets,
    suggestion: kept.length === 0 ? usefulSuggestion(search.q, raw.suggestion) : undefined,
  };
}

function dedupe(items: Ranked[]): Ranked[] {
  const byUrl = new Map<string, Ranked>();
  const byTitle = new Map<string, Ranked>();
  const out: Ranked[] = [];
  for (const item of items) {
    const urlKey = item.hit.url ? canonicalUrl(item.hit.url) : '';
    const titled = titleKey(item.plainTitle);
    const titleKeyId = item.domain ? `${item.domain}|${titled}` : '';
    const existing =
      (urlKey && byUrl.get(urlKey)) || (titleKeyId && byTitle.get(titleKeyId)) || undefined;
    if (existing) {
      if (item.hit.score > existing.hit.score) {
        existing.hit = item.hit;
        existing.plainTitle = item.plainTitle;
        existing.domain = item.domain;
        existing.summaryReady = item.summaryReady;
      }
      continue;
    }
    out.push(item);
    if (urlKey) byUrl.set(urlKey, item);
    if (titleKeyId) byTitle.set(titleKeyId, item);
  }
  return out;
}

function outcomeFor(results: number, diagnostics: SearchDiagnostic[]): SearchOutcome {
  const providers = diagnostics.filter((item) => item.id !== 'local_index');
  const configured = providers.filter((item) => item.status !== 'not_configured');
  const failed = providers.filter((item) => item.status === 'error');
  if (results > 0 && failed.length > 0) return 'partial';
  if (results > 0) return 'results';
  if (configured.length === 0) return 'unconfigured';
  if (failed.length > 0 && failed.length === configured.length) return 'partial';
  return 'empty';
}

function synthesisFor(query: string, results: Ranked[]): SynthesisState {
  if (!query.trim() || results.length === 0) return 'not_applicable';
  return results.some((item) => item.summaryReady) ? 'possible' : 'insufficient';
}

/**
 * Local index first, then every configured web provider when the index has
 * nothing relevant — and always for queries a document index cannot answer
 * on its own (people, companies, addresses, and open questions).
 */
export async function runUniversalSearch(options: RunSearchOptions): Promise<SearchEnvelope> {
  const started = performance.now();
  const query = options.query;
  const intent = detectIntent(query);

  if (!query.trim()) {
    const local = options.engine.search({ ...options.search, q: '' });
    const results: DisplayHit[] = local.hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      domain: domainOf(hit.url),
      origin: 'index',
      provider: hit.source || 'Local index',
      score: hit.score,
      tags: hit.tags,
      updatedAt: options.engine.get(hit.id)?.updatedAt,
    }));
    return {
      query: '',
      intent,
      outcome: local.total > 0 ? 'results' : 'empty',
      synthesis: 'not_applicable',
      local,
      results,
      total: local.total,
      tookMs: Number((performance.now() - started).toFixed(1)),
      attempted: ['Local index'],
      queriesTried: [],
      diagnostics: [
        {
          id: 'local_index',
          label: 'Local index',
          status: 'ok',
          detail: `${local.total} documents`,
          missingEnv: [],
          resultCount: local.total,
        },
      ],
      actions: [],
    };
  }
  const { ranked: localRanked, raw: rawLocal } = indexHits(
    options.engine,
    { ...options.search, q: query },
    intent,
  );
  const local = filteredLocalResponse({ ...options.search, q: query }, rawLocal, localRanked);

  const webMode = webModeOf(options);
  const shouldWeb =
    webMode !== 'off' &&
    query.trim().length > 0 &&
    WEB_INTENTS.has(intent) &&
    (webMode === 'force' || localRanked.length === 0 || intent !== 'general');

  const specs = options.backends ?? describeWebProviders(options.config);
  const fan = shouldWeb
    ? await fanOutWebSearch({
        backends: specs,
        query,
        intent,
        limit: Math.max(options.search.limit, 8),
        signal: options.signal,
        filter: 'strict',
      })
    : {
        results: [],
        attempts: specs.map((spec) => ({
          id: spec.id,
          label: spec.label,
          status: 'skipped' as const,
          detail:
            webMode === 'off'
              ? 'web search disabled for this request'
              : localRanked.length > 0
                ? 'local results were relevant'
                : 'web search not used for this query',
          missingEnv: spec.provider ? [] : spec.missingEnv,
          resultCount: 0,
        })),
        queriesTried: [] as string[],
      };

  const tokens = significantTokens(query);
  const webRanked: Ranked[] = fan.results.map((result) => {
    const domain = domainOf(result.url);
    const snippet = (result.snippet ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      hit: {
        id: `web:${canonicalUrl(result.url)}`,
        title: highlight(result.title, tokens),
        url: result.url,
        snippet: highlight(snippet.slice(0, 320), tokens),
        domain,
        origin: 'web' as const,
        provider: result.provider,
        score: scoreMatch(stripQuotes(query), result.title, snippet, domain, 1),
        tags: [],
      },
      plainTitle: result.title,
      domain,
      summaryReady: false,
    };
  });

  // When the exact phrase is present, drop leftover single-token collisions
  // such as a different person who only shares a surname.
  const phrase = tokens.join(' ');
  const full = webRanked.filter((item) => {
    const hay = `${item.plainTitle} ${item.hit.snippet.replace(/<[^>]+>/g, ' ')}`.toLowerCase();
    return Boolean(phrase) && hay.includes(phrase);
  });
  const webKept = full.length > 0 ? full : webRanked;

  const search = options.search;
  const merged = dedupe([...localRanked, ...webKept])
    .filter((item) => passesFilters(item, search))
    .sort((a, b) => compareRanked(search.sort, a, b));
  const page = merged.slice(options.search.offset, options.search.offset + options.search.limit);

  const localDiagnostic: SearchDiagnostic = {
    id: 'local_index',
    label: 'Local index',
    status: 'ok',
    detail: localRanked.length > 0 ? `${localRanked.length} relevant` : 'no relevant documents',
    missingEnv: [],
    resultCount: localRanked.length,
  };
  const diagnostics = [localDiagnostic, ...fan.attempts];
  const attempted = [
    'Local index',
    ...fan.attempts
      .filter((item) => item.status === 'ok' || item.status === 'error')
      .map((item) => item.label),
  ];

  return {
    query: query.trim(),
    intent,
    outcome: query.trim()
      ? outcomeFor(merged.length, diagnostics)
      : merged.length > 0
        ? 'results'
        : 'empty',
    synthesis: synthesisFor(query, merged),
    local,
    results: page.map((item) => item.hit),
    total: merged.length,
    tookMs: Number((performance.now() - started).toFixed(1)),
    attempted,
    queriesTried: fan.queriesTried,
    diagnostics,
    actions: query.trim() ? buildSearchActions(query, intent) : [],
  };
}
