import * as cheerio from 'cheerio';
import { fetchWithTimeout } from '../http.js';
import { highlight } from '../text.js';
import type { DisplayHit } from '../search/types.js';
import { isOnionHostname, onionBrowsePath } from './onion.js';
import { torFetch } from './socks-fetch.js';

export interface TorSearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: string;
}

export interface TorSearchOptions {
  socksUrl: string;
  timeoutMs?: number;
  limit?: number;
  signal?: AbortSignal;
}

/** Well-known official onion services used as a seeded directory / fallback. */
const DIRECTORY: Array<{ title: string; url: string; body: string; tags: string[] }> = [
  {
    title: 'Tor Project — official site (onion)',
    url: 'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/',
    body: 'Official Tor Project website mirrored as an onion service. Downloads, documentation, and relay information.',
    tags: ['official', 'tor', 'directory'],
  },
  {
    title: 'DuckDuckGo (onion)',
    url: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/',
    body: 'DuckDuckGo search engine over Tor. Clearnet-index-free queries through an onion endpoint.',
    tags: ['search', 'onion'],
  },
  {
    title: 'Ahmia — Tor search engine (onion)',
    url: 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/',
    body: 'Ahmia indexes onion services and filters known abuse material. Search the Tor network safely.',
    tags: ['search', 'directory', 'ahmia'],
  },
  {
    title: 'Proton Mail (onion)',
    url: 'https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion/',
    body: 'Proton Mail onion service for encrypted email over Tor.',
    tags: ['mail', 'privacy'],
  },
  {
    title: 'The New York Times (onion)',
    url: 'https://www.nytimesn7cgmftshazwhfgzm37ukgi5jejopsyktyo365nuoqjjosrnyd.onion/',
    body: 'New York Times onion mirror — journalism reachable without clearnet censorship.',
    tags: ['news', 'official'],
  },
  {
    title: 'BBC News (onion)',
    url: 'https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7b2kvlhj7ndrhjayd.onion/',
    body: 'BBC News onion service.',
    tags: ['news', 'official'],
  },
  {
    title: 'CIA.gov (onion)',
    url: 'http://ciadotgov4sjwlzihbbgxnqg3xiyrg7so2r2o3lt5wz5ypk4s5nlubad.onion/',
    body: 'U.S. Central Intelligence Agency public website onion mirror.',
    tags: ['official', 'government'],
  },
  {
    title: 'Facebook / Meta (onion)',
    url: 'https://www.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshix6cspzqd.onion/',
    body: 'Facebook onion service for Tor access.',
    tags: ['social'],
  },
  {
    title: 'Debian onion package mirrors',
    url: 'http://2s4yqjx5ul6okpp3f2gaunr2syex5jgbfpfvhxxbbjwnfyvjpzaim6yd.onion/',
    body: 'Debian project onion services for packages and documentation.',
    tags: ['software', 'directory'],
  },
  {
    title: 'SecureDrop directory (Freedom of the Press)',
    url: 'http://sdolvtfhatvsysc6l34d65ymdwxcujausv7k3zyq8omg7vvnecqvxad.onion/',
    body: 'SecureDrop — whistleblower submission systems for newsrooms, listed via Freedom of the Press Foundation.',
    tags: ['journalism', 'directory'],
  },
];

const AHMIA_ONION_ORIGIN = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion';
const AHMIA_CLEARNET_ORIGIN = 'https://ahmia.fi';
/** Hostnames that belong to Ahmia itself — never show these as search hits. */
const AHMIA_SELF = new Set([
  'juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion',
  'juhanurmihxlp77nkq76byazcldy2hlmovfu2epylx42ahyhtzjmkd.onion', // legacy
  'ahmia.fi',
  'www.ahmia.fi',
]);

function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreDirectory(query: string, entry: (typeof DIRECTORY)[number]): number {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return 1;
  const hay = `${entry.title} ${entry.body} ${entry.tags.join(' ')} ${entry.url}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (hay.includes(token)) hits += 1;
  }
  return hits;
}

/** Pull a real .onion URL out of an Ahmia redirect or a bare/absolute href. */
function resolveAhmiaHref(href: string): string | null {
  const trimmed = href.trim();
  try {
    const absolute = new URL(trimmed, AHMIA_CLEARNET_ORIGIN);
    const redirect = absolute.searchParams.get('redirect_url');
    if (redirect) {
      const target = new URL(redirect);
      if (isOnionHostname(target.hostname)) return target.toString();
    }
    if (isOnionHostname(absolute.hostname)) return absolute.toString();
  } catch {
    /* fall through */
  }
  const bare = /([a-z2-7]{16}|[a-z2-7]{56})\.onion(?:\/\S*)?/i.exec(trimmed);
  if (bare) return `http://${bare[0].replace(/[)>,.]+$/, '')}`;
  return null;
}

/** Exported for unit tests — parses Ahmia's HTML (including redirect_url wrappers). */
export function parseAhmiaHtml(html: string, limit: number): TorSearchHit[] {
  const $ = cheerio.load(html);
  const hits: TorSearchHit[] = [];
  const seen = new Set<string>();

  const push = (title: string, href: string, snippet: string) => {
    const resolved = resolveAhmiaHref(href);
    if (!resolved) return;
    let url: URL;
    try {
      url = new URL(resolved);
    } catch {
      return;
    }
    if (!isOnionHostname(url.hostname)) return;
    if (AHMIA_SELF.has(url.hostname.toLowerCase())) return;
    const key = url.href.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      title: title.trim() || url.hostname,
      url: url.toString(),
      snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 320),
      provider: 'Ahmia',
    });
  };

  // Ahmia: <ol class="searchResults"><li class="result">… redirect_url=http://….onion
  $('li.result, div.result, .searchResults li, .searchresult, tr').each((_, el) => {
    if (hits.length >= limit) return;
    const root = $(el);
    const anchor =
      root.find('a[href*=".onion"], a[href*="redirect_url"]').first().length > 0
        ? root.find('a[href*=".onion"], a[href*="redirect_url"]').first()
        : root.find('a').first();
    const href = anchor.attr('href') || root.find('cite').first().text();
    if (!href) return;
    const title = anchor.text() || root.find('h4, h3, .title').first().text();
    const snippet =
      root.find('p, .description, .snippet').first().text() || root.find('cite').text() || '';
    push(title, href, snippet);
  });

  if (hits.length < limit) {
    $('a[href*=".onion"], a[href*="redirect_url"]').each((_, el) => {
      if (hits.length >= limit) return;
      const anchor = $(el);
      const href = anchor.attr('href');
      if (!href) return;
      push(anchor.text(), href, '');
    });
  }

  return hits.slice(0, limit);
}

/** Ahmia requires a rotating hidden form field before it will run a search. */
function extractAhmiaFormToken(html: string): { name: string; value: string } | null {
  const match =
    /<input[^>]+type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/i.exec(
      html,
    ) ??
    /<input[^>]+name=["']([^"']+)["'][^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*>/i.exec(
      html,
    );
  if (!match?.[1] || match[1] === 'q') return null;
  return { name: match[1], value: match[2] ?? '' };
}

async function searchAhmiaOverTor(
  query: string,
  options: TorSearchOptions,
  limit: number,
): Promise<{ hits: TorSearchHit[]; error?: string }> {
  try {
    const home = await torFetch(`${AHMIA_ONION_ORIGIN}/`, {
      socksUrl: options.socksUrl,
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
      maxBytes: 500_000,
    });
    const token = extractAhmiaFormToken(home.body.toString('utf8'));
    const qs = new URLSearchParams({ q: query });
    if (token) qs.set(token.name, token.value);
    const result = await torFetch(`${AHMIA_ONION_ORIGIN}/search/?${qs.toString()}`, {
      socksUrl: options.socksUrl,
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
      maxBytes: 1_500_000,
    });
    if (result.status < 200 || result.status >= 400) {
      return { hits: [], error: `Ahmia onion returned HTTP ${result.status}` };
    }
    return { hits: parseAhmiaHtml(result.body.toString('utf8'), limit) };
  } catch (error) {
    return {
      hits: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Clearnet Ahmia still returns .onion URLs — useful when the Ahmia onion is down. */
async function searchAhmiaClearnet(
  query: string,
  options: TorSearchOptions,
  limit: number,
): Promise<{ hits: TorSearchHit[]; error?: string }> {
  try {
    const home = await fetchWithTimeout(`${AHMIA_CLEARNET_ORIGIN}/`, {
      timeoutMs: options.timeoutMs ?? 45_000,
      parentSignal: options.signal,
      headers: {
        accept: 'text/html',
        'user-agent': 'Mozilla/5.0 (compatible; BeaconSearchTor/1.0)',
      },
    });
    if (!home.ok) {
      return { hits: [], error: `Ahmia clearnet home returned HTTP ${home.status}` };
    }
    const homeHtml = await home.text();
    const token = extractAhmiaFormToken(homeHtml);
    const qs = new URLSearchParams({ q: query });
    if (token) qs.set(token.name, token.value);
    const response = await fetchWithTimeout(`${AHMIA_CLEARNET_ORIGIN}/search/?${qs.toString()}`, {
      timeoutMs: options.timeoutMs ?? 45_000,
      parentSignal: options.signal,
      headers: {
        accept: 'text/html',
        'user-agent': 'Mozilla/5.0 (compatible; BeaconSearchTor/1.0)',
        referer: `${AHMIA_CLEARNET_ORIGIN}/`,
      },
    });
    if (!response.ok) {
      return { hits: [], error: `Ahmia clearnet returned HTTP ${response.status}` };
    }
    const html = await response.text();
    const hits = parseAhmiaHtml(html, limit);
    return { hits };
  } catch (error) {
    return {
      hits: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchAhmia(
  query: string,
  options: TorSearchOptions,
): Promise<{ hits: TorSearchHit[]; error?: string }> {
  const limit = options.limit ?? 20;
  const overTor = await searchAhmiaOverTor(query, options, limit);
  if (overTor.hits.length > 0) return overTor;
  const clearnet = await searchAhmiaClearnet(query, options, limit);
  if (clearnet.hits.length > 0) {
    return {
      hits: clearnet.hits,
      error: overTor.error ? `onion unavailable (${overTor.error}); used clearnet index` : undefined,
    };
  }
  return {
    hits: [],
    error: [overTor.error, clearnet.error].filter(Boolean).join(' · ') || 'Ahmia returned no hits',
  };
}

function directoryHits(query: string, limit: number): TorSearchHit[] {
  const ranked = DIRECTORY.map((entry) => ({ entry, score: scoreDirectory(query, entry) }))
    .filter((row) => row.score > 0 || !query.trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked.map(({ entry }) => ({
    title: entry.title,
    url: entry.url,
    snippet: entry.body,
    provider: 'Tor directory',
  }));
}

/**
 * Search onion services via Ahmia over Tor, merging a curated official directory
 * so empty/failed queries still surface known-good onion endpoints.
 */
export async function searchTorNetwork(
  query: string,
  options: TorSearchOptions,
): Promise<{ hits: TorSearchHit[]; diagnostics: { ahmia?: string; directory: number } }> {
  const limit = options.limit ?? 20;
  const q = query.trim();
  const ahmia = q ? await searchAhmia(q, { ...options, limit }) : { hits: [] as TorSearchHit[] };
  const directory = directoryHits(q || 'tor', Math.max(4, Math.min(10, limit)));

  const seen = new Set<string>();
  const merged: TorSearchHit[] = [];
  for (const hit of [...ahmia.hits, ...directory]) {
    const key = hit.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) break;
  }

  return {
    hits: merged,
    diagnostics: {
      ahmia: ahmia.error,
      directory: directory.length,
    },
  };
}

/** Convert Tor hits into the same DisplayHit shape the search UI already renders. */
export function torHitsToDisplay(hits: TorSearchHit[], query: string): DisplayHit[] {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return hits.map((hit, index) => {
    let hostname = hit.url;
    try {
      hostname = new URL(hit.url).hostname;
    } catch {
      /* keep raw */
    }
    return {
      id: `tor:${hit.url}`,
      title: highlight(hit.title, tokens),
      // Browse through Beacon so ordinary browsers can open .onion links.
      url: onionBrowsePath(hit.url),
      snippet: highlight(hit.snippet || hostname, tokens),
      domain: hostname,
      origin: 'web' as const,
      provider: hit.provider,
      score: Math.max(1, 100 - index),
      tags: ['onion', 'tor'],
    };
  });
}
