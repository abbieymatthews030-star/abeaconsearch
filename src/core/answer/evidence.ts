import { normalizeWhitespace, tokenize } from '../text.js';
import { STOPWORDS } from './extract.js';
import type { EntityMatchType, TrustTier } from './types.js';

/**
 * How well one retrieved source actually supports answering a query — this is
 * what decides whether its text is allowed anywhere near synthesis, not just
 * whether it was fetched successfully. Fetching a page is not the same as
 * that page containing evidence.
 */
export interface SourceEvidence {
  /** Does this source's text actually address the query, independent of its quality? */
  relevanceScore: number;
  /** Is this substantive prose, or navigation/footer/cookie/legal boilerplate? */
  contentQualityScore: number;
  /** Trust-tier weight, reused from {@link TrustTier}. */
  sourceQualityScore: number;
  /** How this source's subject relates to an identity query; 'n/a' when the query isn't identity-shaped. */
  entityMatchType: EntityMatchType;
  /** The name-like phrase this source actually appears to be about (cleaned title), used for clustering. */
  candidateName?: string;
  /** Numeric view of `entityMatchType`, for scoring/confidence math. */
  identityMatchScore: number;
  isBoilerplate: boolean;
  /** True only when this source is allowed to contribute claims to the answer. */
  usableForAnswer: boolean;
  /** Human-readable reason, shown in the UI when a source is found but not used. */
  reason: string;
}

// Generic nav/footer/legal vocabulary — deliberately site-agnostic. A page is
// flagged by *density* of this vocabulary relative to its length, not by
// matching any single word (a real article can legitimately say "privacy").
const BOILERPLATE_PHRASES = [
  'about',
  'press',
  'copyright',
  'contact us',
  'contact',
  'careers',
  'creator',
  'creators',
  'advertise',
  'advertising',
  'developers',
  'developer',
  'terms',
  'terms of service',
  'terms of use',
  'privacy',
  'privacy policy',
  'policy',
  'policies',
  'cookie',
  'cookies',
  'cookie policy',
  'accept cookies',
  'sign in',
  'log in',
  'login',
  'sign up',
  'subscribe',
  'follow us',
  'all rights reserved',
  'rights reserved',
  'help center',
  'help centre',
  'support',
  'sitemap',
  'accessibility',
  'how it works',
  'test new features',
  'skip to content',
  'skip navigation',
  'menu',
  'navigation',
  'share',
  'more options',
];
const BOILERPLATE_RE = new RegExp(
  `\\b(${BOILERPLATE_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

// A run of 4+ short Title-Case "words" with no lowercase function word mixed
// in, right at the start of the text — the signature of a nav/breadcrumb/
// destination-list prefix glued directly onto real content with no sentence
// punctuation between them ("Home Spain Sydney Paris Las Vegas Maui Paris
// facts: Paris is the capital of France..."). Deliberately conservative: it
// requires at least 4 consecutive capitalized tokens and bails if any of
// them is a stopword, so a sentence that simply opens with a short proper
// noun phrase ("New York City is...", "The New York Times reported...") is
// left alone. It will not catch every such prefix, and a real heading that
// happens to be 4+ unrelated capitalized words could still be clipped.
const LEADING_CAPS_RE = /^((?:[A-Z][a-zA-Z]{1,14}[.,]?\s+){4,})/;

/** Strip an apparent leading nav-list prefix from extracted text, if one is clearly present. See {@link LEADING_CAPS_RE}. */
export function stripLeadingNavList(text: string): string {
  const match = LEADING_CAPS_RE.exec(text);
  if (!match) return text;
  const prefix = match[1] ?? '';
  if (prefix.length < 15 || prefix.length > 200) return text;
  if (tokenize(prefix).some((t) => STOPWORDS.has(t))) return text;
  return text.slice(prefix.length).trim();
}

/** Fraction of lowercase→uppercase letter transitions with no space between — "PressCopyrightContact". Real prose essentially never does this. */
function camelJoinDensity(text: string): number {
  if (text.length < 20) return 0;
  const joins = (text.match(/[a-z][A-Z]/g) ?? []).length;
  return joins / text.length;
}

/** Sentence-ending punctuation per character. A long blob with none is a run-on label list, not prose. */
function sentenceEndDensity(text: string): number {
  const enders = (text.match(/[.!?](?:\s|$)/g) ?? []).length;
  return enders / Math.max(text.length, 1);
}

/** Share of words that are ordinary function words. Real prose is full of them; label lists are not. */
function stopwordRatio(text: string): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  const stop = tokens.filter((t) => STOPWORDS.has(t)).length;
  return stop / tokens.length;
}

/** Share of the text's character length covered by boilerplate-vocabulary matches. */
function boilerplateCoverage(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(BOILERPLATE_RE) ?? [];
  const covered = matches.reduce((sum, m) => sum + m.length, 0);
  return covered / text.length;
}

/**
 * Score how much a chunk of extracted text reads like real content versus
 * page chrome. Combines several independent, site-agnostic signals rather
 * than matching any one site's specific wording — the YouTube footer and a
 * random SaaS site's cookie banner fail for the same structural reasons.
 */
export function scoreContentQuality(text: string): { score: number; isBoilerplate: boolean } {
  const clean = normalizeWhitespace(text);
  if (clean.length < 20) return { score: 0, isBoilerplate: true };

  // Unrendered template syntax ("{{ reviewsTotal }}", "{% if x %}") is an
  // unambiguous sign of broken extraction from a client-rendered page (the
  // template never got filled in) — not real content, regardless of how
  // normal the surrounding text looks.
  const templateMatches = clean.match(/\{\{[^{}]{0,80}\}\}|\{%[^{}]{0,80}%\}/g) ?? [];
  if (templateMatches.length >= 2 || templateMatches.join('').length / clean.length > 0.03) {
    return { score: 0.1, isBoilerplate: true };
  }

  const camel = camelJoinDensity(clean);
  // `\bpress\b` never matches inside "AboutPressCopyright" — there's no word
  // boundary between two letters regardless of case. Expand camelCase joins
  // into separated words first so phrase/stopword matching still works on
  // text that was concatenated with no whitespace at all, which is exactly
  // what naive DOM-text extraction does to nav/footer chrome.
  const expanded = clean.replace(/([a-z])([A-Z])/g, '$1 $2');
  const sentences = sentenceEndDensity(clean);
  const stopwords = stopwordRatio(expanded);
  const boilerplate = boilerplateCoverage(expanded);

  // Real prose: low camel-join density, has sentence punctuation, healthy
  // function-word ratio, low boilerplate vocabulary coverage. Each signal is
  // normalized to roughly 0-1 "good". No length-based exemptions: a short
  // real sentence already ends in `.?!`, so it scores fine on its own merits.
  const camelScore = Math.max(0, 1 - camel * 40); // >2.5% join density is already very suspicious
  const sentenceScore = Math.min(1, sentences * 300);
  const stopwordScore = Math.min(1, stopwords / 0.2); // real English prose is rarely under ~20% stopwords
  const boilerplateScore = Math.max(0, 1 - boilerplate * 2.5);

  const score = camelScore * 0.3 + sentenceScore * 0.25 + stopwordScore * 0.2 + boilerplateScore * 0.25;
  return { score, isBoilerplate: score < 0.4 };
}

/** Term coverage of the query against a source's title + body, title weighted higher. */
export function scoreRelevance(query: string, title: string, text: string): number {
  const queryTerms = new Set(tokenize(query).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
  if (queryTerms.size === 0) return 0;
  const titleTerms = new Set(tokenize(title));
  const bodyTerms = new Set(tokenize(text).slice(0, 2000));

  let covered = 0;
  for (const term of queryTerms) {
    if (titleTerms.has(term)) covered += 1;
    else if (bodyTerms.has(term)) covered += 0.6;
  }
  return Math.min(1, covered / queryTerms.size);
}

// Common topic/technical vocabulary that makes a short multi-word query read
// as "about a subject" rather than "about a named person/entity" — a cheap,
// deliberately incomplete mitigation for the fact that real search queries
// are usually typed lowercase, so Title-Case shape can't be used as the
// signal (see `looksLikeIdentityQuery`). This will not catch every topical
// two-word query; see the limitation noted there.
const TOPIC_WORDS = new Set([
  'hooks', 'guide', 'guides', 'tutorial', 'tutorials', 'docs', 'documentation', 'api', 'apis',
  'setup', 'config', 'configuration', 'framework', 'frameworks', 'library', 'libraries', 'basics',
  'overview', 'introduction', 'intro', 'deep', 'dive', 'review', 'reviews', 'comparison', 'compare',
  'vs', 'versus', 'pricing', 'features', 'update', 'updates', 'release', 'releases', 'tips', 'tricks',
  'examples', 'example', 'reference', 'cheatsheet', 'howto', 'faq', 'troubleshooting', 'recipe',
  'recipes', 'weather', 'news', 'results', 'score', 'scores', 'map', 'maps', 'directions', 'calculator',
]);

/**
 * Heuristic: does this query look like it's asking about a specific named
 * person or entity, where "shares one word with the name" is not the same as
 * "is about this person"? An explicitly quoted phrase, or 2-4 short words
 * that aren't ordinary function words or common topic vocabulary.
 *
 * Deliberately casing-independent: real queries are usually typed lowercase
 * ("maiz gustavo", not "Maiz Gustavo"), so Title-Case shape can't be the
 * signal here — only the page *titles* retrieved for the query reliably
 * preserve real capitalization. That trade-off means a short, unfamiliar
 * two-word technical phrase can occasionally be treated as identity-shaped
 * too; the `TOPIC_WORDS` list mitigates the most common cases but is not
 * exhaustive. See the "remaining limitations" note where this is used.
 */
export function looksLikeIdentityQuery(query: string): boolean {
  const t = query.trim();
  if (/^["“].+["”]$/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => {
    if (!/^[\p{L}][\p{L}'-]*$/u.test(w)) return false;
    const lower = w.toLowerCase();
    return !STOPWORDS.has(lower) && !TOPIC_WORDS.has(lower);
  });
}

/** Strip a trailing " - Site Name" / " | Site Name" page-title suffix, kept short so a real subtitle survives. */
export function cleanTitle(title: string): string {
  return normalizeWhitespace(title).replace(/\s*[-|—–]\s*[^-|—–]{2,40}$/, '').trim();
}

/** Does `text` start with 1-4 consecutive Title-Case words — the shape of a proper name? */
function looksNameShaped(text: string): boolean {
  return /^([A-ZÀ-ÞĀ-ſ][\p{L}'-]*\s+){1,3}[A-ZÀ-ÞĀ-ſ][\p{L}'-]*/u.test(text.trim());
}

const IDENTITY_MATCH_SCORE: Record<EntityMatchType, number> = {
  exact: 1,
  partial: 0.35,
  different: 0.05,
  topical: 0.1,
  'n/a': 1,
};

/**
 * Classify how a source's apparent subject relates to an identity-shaped
 * query. This is deliberately conservative: it only ever calls a match
 * "exact" when the whole name phrase appears contiguously, never from
 * scattered tokens or topical overlap — sharing a word is not sharing an
 * identity.
 */
export function classifyEntityMatch(
  query: string,
  title: string,
  text: string,
): { type: EntityMatchType; candidateName?: string } {
  if (!looksLikeIdentityQuery(query)) return { type: 'n/a' };

  const queryPhrase = tokenize(query.replace(/["“”]/g, '')).join(' ');
  if (!queryPhrase) return { type: 'n/a' };

  const cleanedTitle = cleanTitle(title);
  const titlePhrase = tokenize(cleanedTitle).join(' ');
  const haystack = `${cleanedTitle} ${text.slice(0, 500)}`.toLowerCase();

  if (haystack.includes(queryPhrase)) {
    return { type: 'exact', candidateName: titlePhrase || queryPhrase };
  }

  // The title names a *different* specific person/thing (its own name-shaped
  // phrase) that isn't the query — a different entity, not weak evidence for
  // this one.
  if (titlePhrase && titlePhrase !== queryPhrase && looksNameShaped(cleanedTitle)) {
    return { type: 'different', candidateName: titlePhrase };
  }

  const queryTokens = queryPhrase.split(' ');
  const titleTokens = new Set(tokenize(cleanedTitle));
  const sharedInTitle = queryTokens.some((t) => titleTokens.has(t));
  if (sharedInTitle) {
    return { type: 'partial', candidateName: cleanedTitle || undefined };
  }

  return { type: 'topical', candidateName: cleanedTitle || undefined };
}

/** One cluster of sources believed to share a subject — never merged with another cluster without evidence. */
export interface EntityCandidate {
  /** Normalized cluster key (lowercased candidate name, or a generated key for ungrouped sources). */
  key: string;
  /** Display label for this candidate. */
  label: string;
  matchType: EntityMatchType;
  sourceIds: number[];
}

/**
 * Group sources into candidate entities by their (cleaned) apparent subject
 * name. Clustering is intentionally conservative — sources only join the same
 * cluster when their candidate name matches exactly after normalization;
 * anything else becomes its own singleton candidate. That means two sources
 * about the same person under slightly different name spellings won't always
 * merge, but it also means "Maiz Gustavo" and "Gustavo Angel Maddonni" never
 * will, which is the failure mode this exists to prevent.
 */
export function clusterCandidates<
  S extends { id: number; title: string; entityMatchType: EntityMatchType; candidateName?: string },
>(sources: S[]): EntityCandidate[] {
  const clusters = new Map<string, EntityCandidate>();
  for (const source of sources) {
    const name = source.candidateName?.trim();
    // The cluster key is lowercased for case-insensitive matching, but the
    // display label keeps the page's real title casing — `candidateName` is
    // always lowercase (it comes from `tokenize`), so using it as the label
    // too would turn "Maiz Gustavo" into "maiz gustavo" in the UI.
    const key = name ? name.toLowerCase() : `source:${source.id}`;
    const label = cleanTitle(source.title) || name || source.title;
    const existing = clusters.get(key);
    if (existing) {
      existing.sourceIds.push(source.id);
      // An 'exact' match anywhere in the cluster upgrades its label quality.
      if (source.entityMatchType === 'exact') existing.matchType = 'exact';
    } else {
      clusters.set(key, {
        key,
        label,
        matchType: source.entityMatchType,
        sourceIds: [source.id],
      });
    }
  }
  const order: Record<EntityMatchType, number> = { exact: 0, partial: 1, topical: 2, different: 3, 'n/a': 4 };
  return [...clusters.values()].sort((a, b) => order[a.matchType] - order[b.matchType]);
}

const TRUST_QUALITY: Record<TrustTier, number> = {
  official: 1,
  established: 0.8,
  community: 0.45,
  unverified: 0.15,
};

/** Evaluate one retrieved source's evidence quality for `query`. Never throws. */
export function evaluateSource(query: string, title: string, text: string, trust: TrustTier): SourceEvidence {
  const { score: contentQualityScore, isBoilerplate } = scoreContentQuality(text);
  const relevanceScore = scoreRelevance(query, title, text);
  const entity = classifyEntityMatch(query, title, text);
  const identityMatchScore = IDENTITY_MATCH_SCORE[entity.type];
  const sourceQualityScore = TRUST_QUALITY[trust];

  const identityOk = entity.type === 'n/a' || entity.type === 'exact';
  const usableForAnswer = !isBoilerplate && relevanceScore >= 0.2 && identityOk;

  let reason: string;
  if (isBoilerplate) {
    reason = 'extracted content is mostly navigation, footer, or boilerplate text — not usable as evidence';
  } else if (entity.type === 'different') {
    reason = `this page appears to be about "${entity.candidateName}", a different entity than the one searched for`;
  } else if (entity.type === 'partial' || entity.type === 'topical') {
    reason = 'matching page found, but it does not independently establish the identity being searched for';
  } else if (relevanceScore < 0.2) {
    reason = 'page content does not substantively address the query';
  } else {
    reason = 'usable evidence';
  }

  return {
    relevanceScore,
    contentQualityScore,
    sourceQualityScore,
    entityMatchType: entity.type,
    candidateName: entity.candidateName,
    identityMatchScore,
    isBoilerplate,
    usableForAnswer,
    reason,
  };
}
