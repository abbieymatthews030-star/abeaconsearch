import { normalizeWhitespace, tokenize } from '../text.js';
import type { RetrievedSource } from './retrieval.js';
import { trustWeight } from './trust.js';

/** A sentence lifted verbatim from a source, tied back to that source's id. */
export interface GroundedClaim {
  text: string;
  sourceId: number;
  score: number;
}

/** Low-signal words excluded from query/claim matching. */
export const STOPWORDS = new Set([
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

/** Distinct, meaningful tokens from a query (stopwords and 1-2 char tokens dropped). */
export function queryKeywords(query: string): string[] {
  const all = [...new Set(tokenize(query))];
  const kept = all.filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return kept.length > 0 ? kept : all;
}

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'no',
  'inc',
  'ltd',
  'co',
  'fig',
  'al',
  'u.s',
  'u.k',
]);

/**
 * Split prose into sentences. Deliberately conservative: it breaks on
 * `.?!` followed by whitespace and an uppercase / digit / quote, then re-joins
 * fragments that split on a known abbreviation or an initial.
 */
export function splitSentences(text: string): string[] {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];
  const rawParts = clean.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z0-9])/);
  const out: string[] = [];
  for (const part of rawParts) {
    const prev = out[out.length - 1];
    const lastWord = prev
      ?.replace(/["')\]]+$/, '')
      .split(/\s+/)
      .pop()
      ?.replace(/\.$/, '')
      .toLowerCase();
    const endsWithInitial = prev ? /\b[A-Za-z]\.$/.test(prev) : false;
    if (prev && (endsWithInitial || (lastWord && ABBREVIATIONS.has(lastWord)))) {
      out[out.length - 1] = `${prev} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Score how well a sentence answers a query. Combines the share of distinct
 * query terms it covers, a small bonus for repeated hits, the source's trust
 * weight, and a penalty for sentences too short or too long to be useful.
 */
export function scoreSentence(sentence: string, queryTerms: string[], weight: number): number {
  if (queryTerms.length === 0) return 0;
  const tokens = tokenize(sentence);
  if (tokens.length === 0) return 0;
  const tokenSet = new Set(tokens);
  const distinctQuery = new Set(queryTerms);

  let covered = 0;
  let hits = 0;
  for (const term of distinctQuery) {
    if (tokenSet.has(term)) {
      covered += 1;
      hits += tokens.filter((t) => t === term).length;
    }
  }
  if (covered === 0) return 0;

  const coverage = covered / distinctQuery.size;
  const len = sentence.length;
  const lengthPenalty = len < 30 ? 0.4 : len > 320 ? 0.6 : 1;

  return (coverage * 2 + Math.min(hits, 6) * 0.08) * weight * lengthPenalty;
}

function tooSimilar(a: string, b: string): boolean {
  const at = new Set(tokenize(a));
  const bt = new Set(tokenize(b));
  if (at.size === 0 || bt.size === 0) return false;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared += 1;
  return shared / Math.min(at.size, bt.size) > 0.8;
}

/**
 * Pick the best-supported sentences across all sources for `query`. At most
 * `perSource` sentences come from any single source; the global list is capped
 * at `max` and near-duplicates are dropped.
 */
export function selectGroundedClaims(
  query: string,
  sources: RetrievedSource[],
  { max = 6, perSource = 2 }: { max?: number; perSource?: number } = {},
): GroundedClaim[] {
  const queryTerms = queryKeywords(query);
  const candidates: GroundedClaim[] = [];

  for (const source of sources) {
    // A source whose text is boilerplate, off-topic, or an unconfirmed
    // identity match never contributes a claim — no amount of coincidental
    // keyword overlap in a nav blob should end up quoted as evidence.
    if (!source.usableForAnswer) continue;
    const weight = trustWeight(source.trust);
    const scored = splitSentences(source.text)
      .map((text) => ({
        text,
        sourceId: source.id,
        score: scoreSentence(text, queryTerms, weight),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, perSource);
    candidates.push(...scored);
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen: GroundedClaim[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= max) break;
    if (chosen.some((c) => tooSimilar(c.text, candidate.text))) continue;
    chosen.push(candidate);
  }
  return chosen;
}

/**
 * Weave grounded claims into a short readable answer with `[n]` markers. This is
 * both the no-LLM answer and the material handed to the LLM. Claims are grouped
 * by source so the citations read naturally.
 */
export function weaveExtractive(claims: GroundedClaim[]): string {
  if (claims.length === 0) return '';
  return claims
    .map((c) => {
      const body = c.text.replace(/[.!?]+$/, '');
      return `${body} [${c.sourceId}].`;
    })
    .join(' ');
}
