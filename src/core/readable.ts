import * as cheerio from 'cheerio';
import { fetchWithTimeout } from './http.js';
import { normalizeWhitespace } from './text.js';
import type { DocumentInput } from './types.js';

export interface FetchHtmlOptions {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type FetchHtmlResult = { html: string; finalUrl: string } | { error: string };

/**
 * Fetch a URL expecting HTML. Returns the body and the post-redirect URL, or an
 * `error` string for a non-2xx status, a non-HTML content type, or a network /
 * timeout failure. Shared by the crawler and the answer retriever.
 */
export async function fetchHtml(url: string, options: FetchHtmlOptions): Promise<FetchHtmlResult> {
  const { userAgent, timeoutMs, fetchImpl = fetch, signal } = options;
  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      timeoutMs,
      fetchImpl,
      parentSignal: signal,
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html'))
      return { error: `unsupported content-type "${contentType}"` };
    return { html: await response.text(), finalUrl: response.url || url };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Strip an HTML document down to a searchable `{ title, body }` document.
 * Removes non-content elements, prefers `<main>` over `<body>`, and derives the
 * title from `og:title` / `<title>` / `<h1>` in that order. Returns `null` when
 * there is no usable text and no real title.
 */
export function extractReadable(
  html: string,
  url: string,
  tags: string[] = [],
): DocumentInput | null {
  const $ = cheerio.load(html);
  // `nav`/`header`/`footer`/`aside` are page chrome by HTML-spec definition,
  // not content — strip them wherever they sit (not just outside <main>,
  // since plenty of real pages — Wikipedia included — nest site nav/language
  // pickers inside their main content column).
  $('script, style, noscript, template, svg, iframe, nav, header, footer, aside').remove();
  // Ensure block-level elements are separated by whitespace in the text dump.
  $('h1, h2, h3, h4, h5, h6, p, li, br, div, section, article, header, footer, tr, td, th').append(
    ' ',
  );

  const title =
    normalizeWhitespace($('meta[property="og:title"]').attr('content') ?? '') ||
    normalizeWhitespace($('title').first().text()) ||
    normalizeWhitespace($('h1').first().text()) ||
    url;

  const main = $('main').first();
  const scope = main.length > 0 ? main : $('body');
  const body = normalizeWhitespace(scope.text());
  if (body.length === 0 && title === url) return null;

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  })();

  return {
    title: title.slice(0, 1024),
    body,
    url,
    tags,
    source: host,
  };
}
