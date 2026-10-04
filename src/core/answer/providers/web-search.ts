import * as cheerio from 'cheerio';
import type { AnswerConfig } from '../../config.js';
import { fetchWithTimeout } from '../../http.js';

export interface WebProviderSpec {
  id: string;
  label: string;
  missingEnv: string[];
  provider: WebSearchProvider | null;
}

export interface WebResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  readonly configured: boolean;
  search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]>;
}

interface ProviderConfig {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Brave Search API — https://brave.com/search/api/ (free tier available). */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'Brave Search';
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string | undefined, config: ProviderConfig) {
    this.apiKey = apiKey?.trim() || undefined;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    if (!this.apiKey) return [];
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'application/json', 'x-subscription-token': this.apiKey },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (body.web?.results ?? [])
      .filter((r): r is { title?: string; url: string; description?: string } => Boolean(r.url))
      .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.description }));
  }
}

/** Tavily Search API — https://tavily.com/ (search built for LLMs). */
export class TavilySearchProvider implements WebSearchProvider {
  readonly name = 'Tavily';
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string | undefined, config: ProviderConfig) {
    this.apiKey = apiKey?.trim() || undefined;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    if (!this.apiKey) return [];
    const response = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: Math.min(limit, 20),
        search_depth: 'basic',
      }),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (body.results ?? [])
      .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
      .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content }));
  }
}

/** A self-hosted SearXNG instance with the JSON output format enabled. */
export class SearxngProvider implements WebSearchProvider {
  readonly name = 'SearXNG';
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string | undefined, config: ProviderConfig) {
    this.baseUrl = baseUrl?.trim().replace(/\/+$/, '') || undefined;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    if (!this.baseUrl) return [];
    const url = `${this.baseUrl}/search?format=json&q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'application/json' },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (body.results ?? [])
      .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
      .slice(0, limit)
      .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content }));
  }
}

const SEARCH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDuckDuckGoUrl(href: string): string | null {
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  let parsed: URL;
  try {
    parsed = new URL(absolute, 'https://duckduckgo.com');
  } catch {
    return null;
  }
  const wrapped = parsed.searchParams.get('uddg');
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped);
    } catch {
      return wrapped;
    }
  }
  if (parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com'))
    return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/**
 * Keyless web search. HTML results first, then the instant-answer JSON API
 * when the HTML endpoint is blocked or empty.
 */
export class DuckDuckGoProvider implements WebSearchProvider {
  readonly name = 'DuckDuckGo';
  readonly configured = true;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProviderConfig) {
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    let htmlError: unknown;
    try {
      const htmlHits = await this.searchHtml(query, limit, signal);
      if (htmlHits.length > 0) return htmlHits;
    } catch (error) {
      htmlError = error;
    }
    try {
      return await this.searchJson(query, limit, signal);
    } catch (error) {
      throw htmlError ?? error;
    }
  }

  private async searchHtml(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<WebResult[]> {
    const response = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': SEARCH_UA,
      },
      body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const hits: WebResult[] = [];
    $('.result, .web-result').each((_, el) => {
      if (hits.length >= limit) return;
      const link = $(el).find('a.result__a').first();
      const href = link.attr('href');
      if (!href) return;
      const url = unwrapDuckDuckGoUrl(href);
      if (!url) return;
      const title = link.text().replace(/\s+/g, ' ').trim() || url;
      const snippet = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim();
      hits.push({ title, url, snippet: snippet || undefined });
    });
    return hits;
  }

  private async searchJson(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<WebResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=0`;
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'application/json', 'user-agent': SEARCH_UA },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      Heading?: string;
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
    };
    const hits: WebResult[] = [];
    if (body.AbstractURL) {
      hits.push({
        title: body.Heading || body.AbstractURL,
        url: body.AbstractURL,
        snippet: body.AbstractText,
      });
    }
    const pushTopic = (topic: { Text?: string; FirstURL?: string }) => {
      if (!topic.FirstURL || !topic.Text || hits.length >= limit) return;
      const [title, ...rest] = topic.Text.split(' - ');
      hits.push({
        title: title || topic.Text,
        url: topic.FirstURL,
        snippet: rest.join(' - ') || undefined,
      });
    };
    for (const topic of body.RelatedTopics ?? []) {
      pushTopic(topic);
      for (const nested of topic.Topics ?? []) pushTopic(nested);
    }
    return hits.slice(0, limit);
  }
}

/** Keyless Wikipedia search. Useful for people, places, and factual queries. */
export class WikipediaProvider implements WebSearchProvider {
  readonly name = 'Wikipedia';
  readonly configured = true;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProviderConfig) {
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json' +
      `&srlimit=${Math.min(limit, 20)}&srprop=snippet&srsearch=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'BeaconSearch/1.0 (+https://github.com/abbieymatthews030-star/abeaconsearch)',
      },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      query?: { search?: Array<{ title?: string; snippet?: string }> };
    };
    return (body.query?.search ?? [])
      .filter((hit): hit is { title: string; snippet?: string } => Boolean(hit.title))
      .slice(0, limit)
      .map((hit) => ({
        title: hit.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        snippet: hit.snippet ? stripTags(hit.snippet) : undefined,
      }));
  }
}

/**
 * Build the single provider selected by `BEACON_ANSWER_WEB_SEARCH`, or `null`
 * when that switch is unset or its credentials are missing.
 */
export function createWebSearchProvider(
  config: AnswerConfig,
  fetchImpl?: typeof fetch,
): WebSearchProvider | null {
  const providerConfig: ProviderConfig = { timeoutMs: config.fetchTimeoutMs, fetchImpl };
  let provider: WebSearchProvider | null = null;
  switch (config.webSearch) {
    case 'brave':
      provider = new BraveSearchProvider(config.braveApiKey, providerConfig);
      break;
    case 'tavily':
      provider = new TavilySearchProvider(config.tavilyApiKey, providerConfig);
      break;
    case 'searxng':
      provider = new SearxngProvider(config.searxngUrl, providerConfig);
      break;
    default:
      return null;
  }
  return provider.configured ? provider : null;
}

/**
 * Every web backend Beacon can use. Keyed providers are active when their
 * credential is set, whether or not `BEACON_ANSWER_WEB_SEARCH` names them.
 * DuckDuckGo and Wikipedia need no key and are on unless keyless search is disabled.
 */
export function describeWebProviders(
  config: AnswerConfig,
  fetchImpl?: typeof fetch,
): WebProviderSpec[] {
  const providerConfig: ProviderConfig = { timeoutMs: config.fetchTimeoutMs, fetchImpl };
  const brave = new BraveSearchProvider(config.braveApiKey, providerConfig);
  const tavily = new TavilySearchProvider(config.tavilyApiKey, providerConfig);
  const searxng = new SearxngProvider(config.searxngUrl, providerConfig);
  const keyless = config.keylessWebSearch !== false;
  const duckduckgo = new DuckDuckGoProvider(providerConfig);
  const wikipedia = new WikipediaProvider(providerConfig);
  return [
    {
      id: 'brave',
      label: 'Brave Search',
      missingEnv: ['BRAVE_SEARCH_API_KEY'],
      provider: brave.configured ? brave : null,
    },
    {
      id: 'tavily',
      label: 'Tavily',
      missingEnv: ['TAVILY_API_KEY'],
      provider: tavily.configured ? tavily : null,
    },
    {
      id: 'searxng',
      label: 'SearXNG',
      missingEnv: ['SEARXNG_URL'],
      provider: searxng.configured ? searxng : null,
    },
    {
      id: 'duckduckgo',
      label: 'DuckDuckGo',
      missingEnv: ['BEACON_KEYLESS_WEB_SEARCH=1'],
      provider: keyless ? duckduckgo : null,
    },
    {
      id: 'wikipedia',
      label: 'Wikipedia',
      missingEnv: ['BEACON_KEYLESS_WEB_SEARCH=1'],
      provider: keyless ? wikipedia : null,
    },
  ];
}

/** Configured providers only, queried together by the search orchestrator. */
export function createWebSearchProviders(
  config: AnswerConfig,
  fetchImpl?: typeof fetch,
): WebSearchProvider[] {
  return describeWebProviders(config, fetchImpl).flatMap((spec) =>
    spec.provider ? [spec.provider] : [],
  );
}
