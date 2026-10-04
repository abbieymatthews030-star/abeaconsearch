import type { BeaconDocument } from '../types.js';
import { tokenize } from '../text.js';
import type { SearchIntent } from './types.js';

/**
 * Function words. Duplicated here (rather than imported from the answer
 * extractor) so the search path does not cycle through retrieval.
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'as',
  'by',
  'with',
  'from',
  'into',
  'about',
  'which',
  'who',
  'whom',
  'whose',
  'what',
  'when',
  'where',
  'why',
  'how',
  'can',
  'could',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'will',
  'would',
  'should',
  'may',
  'might',
  'must',
  'not',
  'no',
  'yes',
  'i',
  'you',
  'he',
  'she',
  'they',
  'we',
  'me',
  'my',
  'your',
  'his',
  'her',
  'their',
  'our',
  'so',
  'if',
  'then',
  'than',
  'there',
  'here',
  'out',
  'up',
  'down',
]);

const ENGINE_HELP_RE = /minisearch|beacon search/i;
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|msclkid|dclid|twclid|igshid|mc_eid|mc_cid|yclid|_ga|_gl)$/i,
];

export function isFunctionWord(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

export function significantTokens(query: string): string[] {
  const stripped = query.replace(/["“”]/g, ' ');
  return [...new Set(tokenize(stripped))].filter(
    (token) => token.length > 2 && !STOPWORDS.has(token),
  );
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 99) + 1;
      const ins = (next[j - 1] ?? 99) + 1;
      const sub = (prev[j - 1] ?? 99) + cost;
      next[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j] ?? 99;
  }
  return prev[b.length] ?? 99;
}

/** True for a typo (perfrmance/performance). False for a different word (matthews/matches). */
export function isCloseSpelling(queryTerm: string, indexedTerm: string): boolean {
  if (queryTerm === indexedTerm) return true;
  if (queryTerm.length < 5 || indexedTerm.length < 5) return false;
  if (Math.abs(queryTerm.length - indexedTerm.length) > 1) return false;
  return levenshtein(queryTerm, indexedTerm) <= 1;
}

export function isEngineHelpDoc(doc: { title: string; body: string }): boolean {
  return ENGINE_HELP_RE.test(`${doc.title}\n${doc.body}`);
}

export interface LocalAssessment {
  ok: boolean;
  coverage: number;
  /** 1 for a normal document, lower for internal engine help that only partly relates. */
  helpFactor: number;
}

function tokenHit(
  term: string,
  pool: Set<string>,
  allowPrefix: boolean,
  allowFuzzy: boolean,
): 'exact' | 'prefix' | 'close' | null {
  if (pool.has(term)) return 'exact';
  for (const have of pool) {
    if (
      allowPrefix &&
      term.length >= 4 &&
      (have.startsWith(term) || (term.startsWith(have) && have.length >= 4))
    ) {
      return 'prefix';
    }
    if (allowFuzzy && isCloseSpelling(term, have)) return 'close';
  }
  return null;
}

export function assessLocalHit(
  query: string,
  doc: Pick<BeaconDocument, 'title' | 'body' | 'tags'>,
  options: { fuzzy: boolean; prefix: boolean; intent: SearchIntent },
): LocalAssessment {
  const tokens = significantTokens(query);
  const help = isEngineHelpDoc(doc);
  const helpFactor = help ? 0.35 : 1;
  if (tokens.length === 0) return { ok: query.trim().length === 0, coverage: 0, helpFactor };

  const titleTokens = new Set(tokenize(doc.title));
  const allTokens = new Set(tokenize(`${doc.title} ${doc.body} ${doc.tags.join(' ')}`));
  const kinds = tokens.map((term) => tokenHit(term, allTokens, options.prefix, options.fuzzy));
  const exactCount = kinds.filter((kind) => kind === 'exact').length;
  const anyCount = kinds.filter((kind) => kind !== null).length;
  const coverage = anyCount / tokens.length;

  if (help) {
    const titleHit = tokens.some((term) => titleTokens.has(term));
    const related = titleHit || (exactCount > 0 && coverage >= 0.5);
    if (!related) return { ok: false, coverage, helpFactor };
  }

  if (options.intent === 'person' || options.intent === 'company') {
    const everyName = tokens.every((term) => {
      const kind = tokenHit(term, allTokens, false, options.fuzzy);
      return kind === 'exact' || kind === 'close';
    });
    return { ok: everyName, coverage: everyName ? 1 : coverage, helpFactor: help ? 0.55 : 1 };
  }

  if (anyCount === 0) return { ok: false, coverage, helpFactor };
  if (tokens.length >= 2 && exactCount === 0) return { ok: false, coverage, helpFactor };
  return { ok: coverage >= 0.5, coverage, helpFactor };
}

export function isRelevantLocalHit(
  query: string,
  doc: Pick<BeaconDocument, 'title' | 'body' | 'tags'>,
  options: { fuzzy: boolean; prefix: boolean; intent: SearchIntent },
): boolean {
  return assessLocalHit(query, doc, options).ok;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    const params = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAMS.some((re) => re.test(key)))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
    return `${parsed.protocol}//${parsed.hostname}${path}${search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function domainQuality(domain: string | undefined): number {
  if (!domain) return 0.15;
  if (
    domain.endsWith('.gov') ||
    domain.endsWith('.gov.uk') ||
    domain.endsWith('.edu') ||
    domain.endsWith('.ac.uk')
  ) {
    return 1.3;
  }
  if (domain === 'wikipedia.org' || domain.endsWith('.wikipedia.org')) return 1.15;
  if (
    [
      'bbc.co.uk',
      'bbc.com',
      'reuters.com',
      'apnews.com',
      'github.com',
      'nytimes.com',
      'theguardian.com',
    ].includes(domain)
  ) {
    return 0.9;
  }
  return 0.45;
}

/** Rank a hit from phrase, title, snippet coverage, and source quality — not raw term frequency. */
export function scoreMatch(
  query: string,
  title: string,
  text: string,
  domain: string | undefined,
  helpFactor = 1,
): number {
  const tokens = significantTokens(query);
  const phrase = tokens.join(' ');
  const titleL = title.toLowerCase();
  const textL = text.toLowerCase();
  let score = 0;
  if (phrase && titleL.includes(phrase)) score += 5;
  if (phrase && textL.includes(phrase)) score += 3;
  if (tokens.length > 0) {
    const titleHits = tokens.filter((term) => titleL.includes(term)).length / tokens.length;
    const textHits = tokens.filter((term) => textL.includes(term)).length / tokens.length;
    score += titleHits * 2;
    score += textHits * 1.2;
    if (titleHits === 1) score += 0.4;
  }
  score += domainQuality(domain);
  return Number((score * helpFactor).toFixed(4));
}

export function webHitIsRelevant(
  original: string,
  variant: string,
  title: string,
  snippet: string | undefined,
): boolean {
  const hay = `${title} ${snippet ?? ''}`.toLowerCase();
  const covers = (tokens: string[]) => {
    if (tokens.length === 0) return 0;
    return tokens.filter((term) => hay.includes(term)).length / tokens.length;
  };
  const originalTokens = significantTokens(original);
  const variantTokens = significantTokens(variant);
  // Every query token has to show up. A shared surname ("Matthews") is not a match
  // for a full name, and a shared word is not a match for a phrase.
  if (covers(originalTokens) >= 1) return true;
  const same =
    originalTokens.length === variantTokens.length &&
    originalTokens.every((term, i) => term === variantTokens[i]);
  return !same && covers(variantTokens) >= 1;
}

export function titleKey(title: string): string {
  return tokenize(title.replace(/<[^>]+>/g, ' ')).join(' ');
}
