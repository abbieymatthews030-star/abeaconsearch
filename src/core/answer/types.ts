/**
 * Types for the "answer weave" layer: a synthesised, cited answer built on top
 * of local-index and live-web retrieval. Shared with the web UI through the
 * `@core` path alias (type-only import, erased at build time).
 */

/** How much a source can be trusted, roughly. */
export type TrustTier = 'official' | 'established' | 'community' | 'unverified';

/** Overall confidence in the woven answer. */
export type AnswerConfidence = 'high' | 'medium' | 'low' | 'none';

/**
 * How a source's apparent subject relates to an identity-shaped query — kept
 * separate from `trust`, which is about the *publisher's* reliability, not
 * whether the page is even about the thing being searched for. A film review
 * site can be perfectly reliable and still be the wrong subject entirely.
 */
export type EntityMatchType = 'exact' | 'partial' | 'different' | 'topical' | 'n/a';

/** Which mechanism produced the prose. */
export type Synthesizer = 'llm-anthropic' | 'llm-openai' | 'extractive';

/** A single source that backs part of the answer. */
export interface AnswerSource {
  /** 1-based index used as the `[n]` citation marker. */
  id: number;
  title: string;
  url?: string;
  /** Where the source came from. */
  origin: 'index' | 'web';
  /** Hostname, when there is a URL. */
  domain?: string;
  trust: TrustTier;
  /** Human-readable reason for the trust tier, e.g. "gov.uk — official domain". */
  trustReason: string;
  /** ISO timestamp: fetch time for web sources, last-updated for index docs. */
  retrievedAt: string;
  /** True when the page was fetched fresh during this request. */
  live: boolean;
  /** The extract from this source that supports the answer — or, when `usedInAnswer` is false, a plain note about why it wasn't usable. */
  quote: string;
  /** False when this source was found but not substantive/relevant/identity-matched enough to cite. */
  usedInAnswer: boolean;
  /** How this source's subject relates to the query — separate from `trust`. 'n/a' for non-identity queries. */
  matchType: EntityMatchType;
}

/** One sentence of the answer plus the sources that support it. */
export interface AnswerClaim {
  text: string;
  /** Source ids backing this sentence; empty means unsupported. */
  sourceIds: number[];
  supported: boolean;
}

/**
 * One possible identity/entity the retrieved sources might refer to, when the
 * evidence doesn't clearly point to a single one. Sources are only ever
 * described within their own candidate — nothing here implies two candidates
 * are the same thing.
 */
export interface AnswerCandidate {
  label: string;
  matchType: EntityMatchType;
  sourceIds: number[];
  /** One or two sentences describing this specific candidate, with `[n]` citations. */
  summary: string;
}

export interface AnswerResponse {
  query: string;
  /** The woven prose, with inline `[n]` citation markers. */
  answer: string;
  /** Sentence-level breakdown of {@link answer}. */
  claims: AnswerClaim[];
  /** Present only when the query looked like an identity search with more than one plausible, unmerged subject. */
  candidates?: AnswerCandidate[];
  sources: AnswerSource[];
  confidence: AnswerConfidence;
  confidenceReason: string;
  /** 0-1: how confident the identity/entity resolution is, for identity-shaped queries (1 when not applicable). */
  identityConfidence: number;
  /** 0-1: average trust-weighted quality of the sources actually used. */
  sourceQuality: number;
  synthesizer: Synthesizer;
  /** Shown to the reader whenever confidence is below `high`. */
  disclaimer?: string;
  /** Non-fatal issues, e.g. "web search not configured", "2 sources unreachable". */
  warnings: string[];
  /** What's missing or uncertain about this answer — unreachable sources, lack of corroboration, detected conflicts. Deterministic, not LLM-generated. */
  searchGaps: string[];
  generatedAt: string;
  tookMs: number;
  /** True when this response was served from the short-lived answer cache. */
  cached: boolean;
}
