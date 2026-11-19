import { DEFAULT_USER_AGENT } from '../../config.js';
import { fetchWithTimeout } from '../../http.js';
import type { WebResult, WebSearchProvider } from './web-search.js';

export interface LongtailProviderConfig {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Marginalia API key; the shared `public` key works without signup (rate-limited). */
  marginaliaApiKey?: string;
}

export interface LongtailToggles {
  wayback: boolean;
  commonCrawl: boolean;
  hackerNews: boolean;
  reddit: boolean;
  marginalia: boolean;
}

function clip(value: string | undefined, max = 320): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function webHit(title: string, url: string, snippet?: string): WebResult {
  return snippet ? { title, url, snippet } : { title, url };
}

function asHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function getJson<T>(
  url: string,
  config: LongtailProviderConfig,
  signal?: AbortSignal,
  headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': DEFAULT_USER_AGENT,
  },
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    headers,
    timeoutMs: config.timeoutMs,
    fetchImpl: config.fetchImpl ?? fetch,
    parentSignal: signal,
  });
  if (response.status === 429 || response.status === 503) {
    throw new Error(`rate limited (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

function looksLikeUrlOrHost(query: string): string | undefined {
  const trimmed = query.trim().replace(/^["']+|["']+$/g, '');
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).hostname;
  } catch {
    /* fall through */
  }
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(trimmed)) {
    return trimmed.split('/')[0]?.toLowerCase();
  }
  return undefined;
}

/** Wayback Machine CDX — archived captures for a host or URL-shaped query. */
export class WaybackMachineProvider implements WebSearchProvider {
  readonly name = 'Wayback Machine';
  readonly configured = true;
  private readonly config: LongtailProviderConfig;

  constructor(config: LongtailProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const host = looksLikeUrlOrHost(query) ?? query.trim().replace(/\s+/g, '');
    if (!host || host.length < 3) return [];
    const capped = Math.min(Math.max(limit, 1), 20);
    const url =
      'https://web.archive.org/cdx/search/cdx' +
      `?url=${encodeURIComponent(host)}` +
      '&matchType=domain&output=json' +
      '&fl=original,timestamp,statuscode,mimetype' +
      '&filter=statuscode:200&collapse=urlkey' +
      `&limit=${capped}`;
    const body = await getJson<unknown>(url, this.config, signal);
    if (!Array.isArray(body) || body.length < 2) return [];
    const rows = body.slice(1) as Array<[string, string, string, string?]>;
    const hits: WebResult[] = [];
    for (const row of rows) {
      if (hits.length >= capped) break;
      const [original, timestamp, status] = row;
      if (!original || status !== '200') continue;
      const archiveUrl = `https://web.archive.org/web/${timestamp}/${original}`;
      const year = timestamp?.slice(0, 4);
      hits.push(
        webHit(
          original,
          archiveUrl,
          clip([year ? `Captured ${year}` : undefined, 'Internet Archive Wayback Machine'].join(' · ')),
        ),
      );
    }
    return hits;
  }
}

/** Common Crawl CDX index — historical crawl snapshots without an API key. */
export class CommonCrawlProvider implements WebSearchProvider {
  readonly name = 'Common Crawl';
  readonly configured = true;
  private readonly config: LongtailProviderConfig;
  private indexApi?: string;

  constructor(config: LongtailProviderConfig) {
    this.config = config;
  }

  private async latestIndex(signal?: AbortSignal): Promise<string> {
    if (this.indexApi) return this.indexApi;
    const collinfo = await getJson<Array<{ 'cdx-api'?: string; cdxApi?: string; id?: string }>>(
      'https://index.commoncrawl.org/collinfo.json',
      this.config,
      signal,
    );
    const first = collinfo.find((row) => row['cdx-api'] || row.cdxApi);
    const api = first?.['cdx-api'] || first?.cdxApi;
    if (!api) throw new Error('Common Crawl collinfo returned no cdx-api');
    this.indexApi = api;
    return api;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const host = looksLikeUrlOrHost(query);
    const needle = host ?? query.trim().replace(/\s+/g, '-');
    if (!needle || needle.length < 3) return [];
    const capped = Math.min(Math.max(limit, 1), 15);
    const indexApi = await this.latestIndex(signal);
    const url =
      `${indexApi}?url=${encodeURIComponent(host ? `${host}/*` : `*.${needle}/*`)}` +
      `&output=json&fl=url,timestamp,status&filter=status:200&limit=${capped}`;
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.config.fetchImpl ?? fetch,
      parentSignal: signal,
    });
    if (response.status === 429 || response.status === 503) {
      throw new Error(`rate limited (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`Common Crawl returned HTTP ${response.status}`);
    const text = await response.text();
    const hits: WebResult[] = [];
    for (const line of text.split('\n')) {
      if (hits.length >= capped) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { url?: string; timestamp?: string; status?: string };
        const pageUrl = asHttpUrl(row.url);
        if (!pageUrl || (row.status && row.status !== '200')) continue;
        const year = row.timestamp?.slice(0, 4);
        hits.push(
          webHit(
            pageUrl,
            pageUrl,
            clip([year ? `Crawled ${year}` : undefined, 'Common Crawl index'].join(' · ')),
          ),
        );
      } catch {
        /* skip malformed NDJSON lines */
      }
    }
    return hits;
  }
}

/** Hacker News via Algolia's public API — no key required. */
export class HackerNewsProvider implements WebSearchProvider {
  readonly name = 'Hacker News';
  readonly configured = true;
  private readonly config: LongtailProviderConfig;

  constructor(config: LongtailProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 20);
    const url =
      'https://hn.algolia.com/api/v1/search' +
      `?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${capped}`;
    const body = await getJson<{
      hits?: Array<{
        title?: string;
        url?: string | null;
        objectID?: string;
        story_text?: string | null;
        num_comments?: number;
        points?: number;
        created_at?: string;
        author?: string;
      }>;
    }>(url, this.config, signal);

    return (body.hits ?? [])
      .map((hit) => {
        const title = hit.title;
        const hnUrl = hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : undefined;
        const url = asHttpUrl(hit.url ?? undefined) || hnUrl;
        if (!title || !url) return null;
        const snippet = [
          hit.points != null ? `${hit.points} points` : undefined,
          hit.num_comments != null ? `${hit.num_comments} comments` : undefined,
          hit.author ? `by ${hit.author}` : undefined,
          hit.created_at?.slice(0, 10),
          hit.story_text || undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        return webHit(title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, capped);
  }
}

/**
 * Reddit public JSON search. Often blocked from datacenter IPs; errors are
 * recorded by the fan-out layer. Optional — works without OAuth.
 */
export class RedditProvider implements WebSearchProvider {
  readonly name = 'Reddit';
  readonly configured = true;
  private readonly config: LongtailProviderConfig;

  constructor(config: LongtailProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 25);
    const url =
      'https://www.reddit.com/search.json' +
      `?q=${encodeURIComponent(query)}&limit=${capped}&sort=relevance&t=all&raw_json=1`;
    const response = await fetchWithTimeout(url, {
      headers: {
        accept: 'application/json',
        'user-agent': `${DEFAULT_USER_AGENT} (deep search)`,
      },
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.config.fetchImpl ?? fetch,
      parentSignal: signal,
    });
    if (response.status === 429 || response.status === 503) {
      throw new Error(`rate limited (HTTP ${response.status})`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) throw new Error(`Reddit returned HTTP ${response.status}`);
    if (!contentType.includes('json')) {
      throw new Error('Reddit blocked the request (non-JSON response)');
    }
    const body = (await response.json()) as {
      data?: {
        children?: Array<{
          data?: {
            title?: string;
            url?: string;
            permalink?: string;
            selftext?: string;
            subreddit?: string;
            score?: number;
            num_comments?: number;
            created_utc?: number;
          };
        }>;
      };
    };

    return (body.data?.children ?? [])
      .map((child) => {
        const post = child.data;
        if (!post?.title) return null;
        const permalink = post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : undefined;
        const url = asHttpUrl(permalink) || asHttpUrl(post.url);
        if (!url) return null;
        const created =
          post.created_utc && Number.isFinite(post.created_utc)
            ? new Date(post.created_utc * 1000).toISOString().slice(0, 10)
            : undefined;
        const snippet = [
          post.subreddit ? `r/${post.subreddit}` : undefined,
          post.score != null ? `${post.score} upvotes` : undefined,
          post.num_comments != null ? `${post.num_comments} comments` : undefined,
          created,
          post.selftext,
        ]
          .filter(Boolean)
          .join(' · ');
        return webHit(post.title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, capped);
  }
}

/** Marginalia — independent / small-web index. Uses shared `public` key when unset. */
export class MarginaliaProvider implements WebSearchProvider {
  readonly name = 'Marginalia';
  readonly configured = true;
  private readonly config: LongtailProviderConfig;

  constructor(config: LongtailProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 20);
    const apiKey = this.config.marginaliaApiKey?.trim() || 'public';
    const url =
      'https://api2.marginalia-search.com/search' +
      `?query=${encodeURIComponent(query)}&count=${capped}`;
    const body = await getJson<{
      results?: Array<{
        url?: string;
        title?: string;
        description?: string;
      }>;
    }>(url, this.config, signal, {
      accept: 'application/json',
      'user-agent': DEFAULT_USER_AGENT,
      'API-Key': apiKey,
    });

    return (body.results ?? [])
      .map((item) => {
        const url = asHttpUrl(item.url);
        const title = item.title || url;
        if (!title || !url) return null;
        return webHit(title, url, clip(item.description));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, capped);
  }
}

/** Long-tail providers used by deep search mode. */
export function createLongtailProviders(
  config: LongtailProviderConfig,
  toggles: LongtailToggles,
): WebSearchProvider[] {
  const out: WebSearchProvider[] = [];
  if (toggles.wayback) out.push(new WaybackMachineProvider(config));
  if (toggles.commonCrawl) out.push(new CommonCrawlProvider(config));
  if (toggles.hackerNews) out.push(new HackerNewsProvider(config));
  if (toggles.reddit) out.push(new RedditProvider(config));
  if (toggles.marginalia) out.push(new MarginaliaProvider(config));
  return out;
}
