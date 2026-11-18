import { DEFAULT_USER_AGENT } from '../../config.js';
import { fetchWithTimeout } from '../../http.js';
import type { WebResult, WebSearchProvider } from './web-search.js';

interface ProviderConfig {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Polite-pool contact for scholarly APIs that ask for a mailto (Crossref,
 * OpenAlex). Not a monitored inbox — identifies the Beacon bot.
 */
const POLITE_MAILTO = 'beaconsearch-bot@users.noreply.github.com';

const JSON_HEADERS = {
  accept: 'application/json',
  'user-agent': DEFAULT_USER_AGENT,
} as const;

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

function doiUrl(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const cleaned = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  if (!cleaned) return undefined;
  return `https://doi.org/${cleaned}`;
}

/** Rebuild OpenAlex's inverted-index abstract into plain text (best-effort). */
function openAlexAbstract(
  inverted: Record<string, number[]> | undefined,
  maxWords = 60,
): string | undefined {
  if (!inverted) return undefined;
  const slots: Array<{ word: string; pos: number }> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) slots.push({ word, pos });
  }
  if (slots.length === 0) return undefined;
  slots.sort((a, b) => a.pos - b.pos);
  return clip(
    slots
      .slice(0, maxWords)
      .map((s) => s.word)
      .join(' '),
  );
}

async function getJson<T>(
  url: string,
  config: ProviderConfig,
  signal?: AbortSignal,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    headers,
    timeoutMs: config.timeoutMs,
    fetchImpl: config.fetchImpl ?? fetch,
    parentSignal: signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** OpenAlex — open scholarly graph (~240M+ works), no API key required. */
export class OpenAlexProvider implements WebSearchProvider {
  readonly name = 'OpenAlex';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const perPage = Math.min(Math.max(limit, 1), 25);
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
      `&per_page=${perPage}&mailto=${encodeURIComponent(POLITE_MAILTO)}` +
      `&select=id,doi,display_name,title,publication_year,primary_location,abstract_inverted_index`;
    const body = await getJson<{
      results?: Array<{
        id?: string;
        doi?: string;
        display_name?: string;
        title?: string;
        publication_year?: number;
        primary_location?: { landing_page_url?: string; pdf_url?: string };
        abstract_inverted_index?: Record<string, number[]>;
      }>;
    }>(url, this.config, signal);

    return (body.results ?? [])
      .map((work) => {
        const title = work.display_name || work.title;
        const url =
          asHttpUrl(work.primary_location?.landing_page_url) ||
          doiUrl(work.doi) ||
          asHttpUrl(work.id);
        if (!title || !url) return null;
        const year = work.publication_year ? String(work.publication_year) : undefined;
        const abstract = openAlexAbstract(work.abstract_inverted_index);
        const snippet = [year, abstract].filter(Boolean).join(' · ') || undefined;
        return webHit(title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Crossref — DOI registry metadata for journal articles, books, preprints. */
export class CrossrefProvider implements WebSearchProvider {
  readonly name = 'Crossref';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const rows = Math.min(Math.max(limit, 1), 20);
    const url =
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
      `&rows=${rows}&mailto=${encodeURIComponent(POLITE_MAILTO)}`;
    const body = await getJson<{
      message?: {
        items?: Array<{
          title?: string[];
          URL?: string;
          DOI?: string;
          abstract?: string;
          'container-title'?: string[];
          issued?: { 'date-parts'?: number[][] };
        }>;
      };
    }>(url, this.config, signal);

    return (body.message?.items ?? [])
      .map((item) => {
        const title = item.title?.[0];
        const url = asHttpUrl(item.URL) || doiUrl(item.DOI);
        if (!title || !url) return null;
        const year = item.issued?.['date-parts']?.[0]?.[0];
        const venue = item['container-title']?.[0];
        const abstract = item.abstract?.replace(/<[^>]+>/g, ' ');
        const snippet = [year ? String(year) : undefined, venue, abstract]
          .filter(Boolean)
          .join(' · ');
        return webHit(title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** arXiv — physics/CS/math/q-bio preprints via the Atom API. */
export class ArxivProvider implements WebSearchProvider {
  readonly name = 'arXiv';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const max = Math.min(Math.max(limit, 1), 20);
    // Strip characters that are operators in arXiv Lucene-ish syntax.
    const safe = query
      .replace(/[:"()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/ /g, '+');
    if (!safe) return [];
    const url =
      `https://export.arxiv.org/api/query?search_query=all:${safe}` + `&start=0&max_results=${max}`;
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'application/atom+xml', 'user-agent': DEFAULT_USER_AGENT },
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.config.fetchImpl ?? fetch,
      parentSignal: signal,
    });
    if (!response.ok) throw new Error(`arXiv returned HTTP ${response.status}`);
    const xml = await response.text();
    return parseArxivAtom(xml, limit);
  }
}

function parseArxivAtom(xml: string, limit: number): WebResult[] {
  const entries = xml.split(/<entry>/i).slice(1);
  const hits: WebResult[] = [];
  for (const entry of entries) {
    if (hits.length >= limit) break;
    const title = textBetween(entry, 'title')?.replace(/\s+/g, ' ').trim();
    const id = textBetween(entry, 'id');
    const summary = textBetween(entry, 'summary')?.replace(/\s+/g, ' ').trim();
    const url = absUrlFromArxivId(id) || asHttpUrl(id);
    if (!title || !url) continue;
    hits.push(webHit(title, url, clip(summary)));
  }
  return hits;
}

function textBetween(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(block);
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function absUrlFromArxivId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const match = /arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+)/i.exec(id);
  return match?.[1] ? `https://arxiv.org/abs/${match[1].replace(/\.pdf$/i, '')}` : asHttpUrl(id);
}

/** Europe PMC — PubMed + full-text life-science literature, free REST API. */
export class EuropePmcProvider implements WebSearchProvider {
  readonly name = 'Europe PMC';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const pageSize = Math.min(Math.max(limit, 1), 25);
    const url =
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
      `?query=${encodeURIComponent(query)}&format=json&pageSize=${pageSize}&resultType=lite`;
    const body = await getJson<{
      resultList?: {
        result?: Array<{
          title?: string;
          doi?: string;
          pmid?: string;
          pmcid?: string;
          abstractText?: string;
          journalTitle?: string;
          pubYear?: string;
          authorString?: string;
        }>;
      };
    }>(url, this.config, signal);

    return (body.resultList?.result ?? [])
      .map((item) => {
        const title = item.title;
        const url =
          doiUrl(item.doi) ||
          (item.pmcid
            ? `https://europepmc.org/article/PMC/${item.pmcid.replace(/^PMC/i, '')}`
            : undefined) ||
          (item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : undefined);
        if (!title || !url) return null;
        const snippet = [item.pubYear, item.journalTitle, item.abstractText || item.authorString]
          .filter(Boolean)
          .join(' · ');
        return webHit(title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Wikidata — structured entities (people, orgs, places, concepts). */
export class WikidataProvider implements WebSearchProvider {
  readonly name = 'Wikidata';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 20);
    const url =
      'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en' +
      `&uselang=en&type=item&limit=${capped}&search=${encodeURIComponent(query)}`;
    const body = await getJson<{
      search?: Array<{
        id?: string;
        label?: string;
        description?: string;
        url?: string;
        concepturi?: string;
      }>;
    }>(url, this.config, signal);

    return (body.search ?? [])
      .map((item) => {
        const title = item.label || item.id;
        const url =
          asHttpUrl(item.concepturi) ||
          asHttpUrl(item.url) ||
          (item.id ? `https://www.wikidata.org/wiki/${item.id}` : undefined);
        if (!title || !url) return null;
        return webHit(title, url, clip(item.description));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Internet Archive — books, web captures, audio, video, and texts. */
export class InternetArchiveProvider implements WebSearchProvider {
  readonly name = 'Internet Archive';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const rows = Math.min(Math.max(limit, 1), 25);
    const url =
      'https://archive.org/advancedsearch.php' +
      `?q=${encodeURIComponent(query)}` +
      '&fl[]=identifier&fl[]=title&fl[]=description&fl[]=mediatype&fl[]=year' +
      `&rows=${rows}&page=1&output=json`;
    const body = await getJson<{
      response?: {
        docs?: Array<{
          identifier?: string;
          title?: string | string[];
          description?: string | string[];
          mediatype?: string;
          year?: string | number;
        }>;
      };
    }>(url, this.config, signal);

    return (body.response?.docs ?? [])
      .map((doc) => {
        const id = doc.identifier;
        if (!id) return null;
        const title = Array.isArray(doc.title) ? doc.title[0] : doc.title;
        const description = Array.isArray(doc.description) ? doc.description[0] : doc.description;
        const url = `https://archive.org/details/${encodeURIComponent(id)}`;
        const snippet = [doc.year ? String(doc.year) : undefined, doc.mediatype, description]
          .filter(Boolean)
          .join(' · ');
        return webHit(title || id, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Open Library — free book / author catalog (Internet Archive sibling). */
export class OpenLibraryProvider implements WebSearchProvider {
  readonly name = 'Open Library';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 20);
    const url =
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}` +
      `&limit=${capped}&fields=key,title,author_name,first_publish_year,subtitle`;
    const body = await getJson<{
      docs?: Array<{
        key?: string;
        title?: string;
        subtitle?: string;
        author_name?: string[];
        first_publish_year?: number;
      }>;
    }>(url, this.config, signal);

    return (body.docs ?? [])
      .map((doc) => {
        if (!doc.key || !doc.title) return null;
        const path = doc.key.startsWith('/') ? doc.key : `/${doc.key}`;
        const url = `https://openlibrary.org${path}`;
        const snippet = [
          doc.first_publish_year ? String(doc.first_publish_year) : undefined,
          doc.author_name?.slice(0, 3).join(', '),
          doc.subtitle,
        ]
          .filter(Boolean)
          .join(' · ');
        return webHit(doc.title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** DOAJ — Directory of Open Access Journals article search. */
export class DoajProvider implements WebSearchProvider {
  readonly name = 'DOAJ';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const pageSize = Math.min(Math.max(limit, 1), 20);
    const url =
      `https://doaj.org/api/search/articles/${encodeURIComponent(query)}` +
      `?pageSize=${pageSize}&page=1`;
    const body = await getJson<{
      results?: Array<{
        bibjson?: {
          title?: string;
          abstract?: string;
          year?: string | number;
          journal?: { title?: string };
          link?: Array<{ url?: string; type?: string }>;
          identifier?: Array<{ type?: string; id?: string }>;
        };
      }>;
    }>(url, this.config, signal);

    return (body.results ?? [])
      .map((row) => {
        const bib = row.bibjson;
        if (!bib?.title) return null;
        const doi = bib.identifier?.find((id) => id.type?.toLowerCase() === 'doi')?.id;
        const fulltext = bib.link?.find((l) => l.type === 'fulltext')?.url;
        const anyLink = bib.link?.find((l) => l.url)?.url;
        const url = asHttpUrl(fulltext) || doiUrl(doi) || asHttpUrl(anyLink);
        if (!url) return null;
        const snippet = [bib.year ? String(bib.year) : undefined, bib.journal?.title, bib.abstract]
          .filter(Boolean)
          .join(' · ');
        return webHit(bib.title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Library of Congress — US catalog + digitized collections (JSON API). */
export class LocProvider implements WebSearchProvider {
  readonly name = 'Library of Congress';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const capped = Math.min(Math.max(limit, 1), 25);
    const url =
      `https://www.loc.gov/search/?q=${encodeURIComponent(query)}` +
      `&fo=json&c=${capped}&at=results`;
    const body = await getJson<{
      results?: Array<{
        title?: string | string[];
        description?: string | string[];
        url?: string;
        id?: string;
        date?: string;
        original_format?: string | string[];
      }>;
    }>(url, this.config, signal);

    return (body.results ?? [])
      .map((item) => {
        const title = Array.isArray(item.title) ? item.title[0] : item.title;
        const description = Array.isArray(item.description)
          ? item.description[0]
          : item.description;
        const url =
          asHttpUrl(item.url) ||
          (item.id?.startsWith('http') ? asHttpUrl(item.id) : undefined) ||
          (item.id
            ? asHttpUrl(`https://www.loc.gov${item.id.startsWith('/') ? '' : '/'}${item.id}`)
            : undefined);
        if (!title || !url) return null;
        const format = Array.isArray(item.original_format)
          ? item.original_format[0]
          : item.original_format;
        const snippet = [item.date, format, description].filter(Boolean).join(' · ');
        return webHit(title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** Project Gutenberg via Gutendex — public-domain books. */
export class GutenbergProvider implements WebSearchProvider {
  readonly name = 'Project Gutenberg';
  readonly configured = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    const url = `https://gutendex.com/books?search=${encodeURIComponent(query)}`;
    const body = await getJson<{
      results?: Array<{
        id?: number;
        title?: string;
        authors?: Array<{ name?: string }>;
        summaries?: string[];
        languages?: string[];
      }>;
    }>(url, this.config, signal);

    return (body.results ?? [])
      .map((book) => {
        if (!book.id || !book.title) return null;
        const url = `https://www.gutenberg.org/ebooks/${book.id}`;
        const snippet = [
          book.authors
            ?.map((a) => a.name)
            .filter(Boolean)
            .slice(0, 3)
            .join(', '),
          book.languages?.slice(0, 2).join(', '),
          book.summaries?.[0],
        ]
          .filter(Boolean)
          .join(' · ');
        return webHit(book.title, url, clip(snippet));
      })
      .filter((hit): hit is WebResult => hit !== null)
      .slice(0, limit);
  }
}

/** All keyless deep sources that fan out alongside DuckDuckGo / Wikipedia. */
export function createDeepKeylessProviders(config: ProviderConfig): WebSearchProvider[] {
  return [
    new OpenAlexProvider(config),
    new CrossrefProvider(config),
    new ArxivProvider(config),
    new EuropePmcProvider(config),
    new WikidataProvider(config),
    new InternetArchiveProvider(config),
    new OpenLibraryProvider(config),
    new DoajProvider(config),
    new LocProvider(config),
    new GutenbergProvider(config),
  ];
}
