import { z } from 'zod';

const FALSEY = new Set(['false', '0', 'no', 'off', '']);

/**
 * A boolean that also accepts query-string values. `z.coerce.boolean()` is unsafe
 * here: `Boolean("false") === true`, so `?flag=false` would not disable anything.
 */
export function booleanParam(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === 'boolean') return v;
      return !FALSEY.has(v.trim().toLowerCase());
    });
}

/** Like {@link booleanParam} but stays `undefined` when the value is absent. */
export const optionalBooleanParam = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    return !FALSEY.has(v.trim().toLowerCase());
  });

/** A document stored in the Beacon Search index. */
export interface BeaconDocument {
  id: string;
  title: string;
  body: string;
  url?: string;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted when creating or updating a document. */
export const documentInputSchema = z.object({
  id: z.string().trim().min(1).max(512).optional(),
  title: z.string().trim().min(1).max(1024),
  body: z.string().max(5_000_000).default(''),
  url: z.string().trim().url().max(2048).optional(),
  tags: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  source: z.string().trim().min(1).max(256).optional(),
});
export type DocumentInput = z.infer<typeof documentInputSchema>;

export const bulkInputSchema = z.object({
  documents: z.array(documentInputSchema).min(1).max(10_000),
});

export const searchQuerySchema = z.object({
  q: z.string().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(500).default(10),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().trim().min(1)).max(32)),
  source: z.string().trim().min(1).max(256).optional(),
  fuzzy: booleanParam(true),
  prefix: booleanParam(true),
  sort: z.enum(['relevance', 'newest', 'oldest', 'title']).default('relevance'),
  /** AND requires every term; OR surfaces any match. Omit for the default (AND, falling back to OR). */
  combineWith: z.enum(['AND', 'OR']).optional(),
  /** Whether a no-exact-match AND query may fall back to a partial (OR) match. */
  allowPartialMatch: booleanParam(true),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const suggestQuerySchema = z.object({
  q: z.string().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

export interface SuggestResponse {
  query: string;
  suggestions: string[];
}

const answerUrlSchema = z.string().trim().url().max(2048);

export const answerQuerySchema = z.object({
  q: z.string().trim().min(2).max(1024),
  /** Bypass the short-lived answer cache. */
  fresh: booleanParam(false),
  /**
   * Result URLs from the search the reader is looking at. When present, the
   * answer cites these documents instead of running a second retrieval.
   */
  urls: z
    .union([answerUrlSchema, z.array(answerUrlSchema).max(20)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
});
export type AnswerQuery = z.infer<typeof answerQuerySchema>;

export const crawlInputSchema = z.object({
  url: z.string().trim().url(),
  maxPages: z.coerce.number().int().min(1).max(2000).optional(),
  sameOriginOnly: booleanParam(true),
  tags: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
});
export type CrawlInput = z.infer<typeof crawlInputSchema>;

export interface SearchHit {
  id: string;
  score: number;
  title: string;
  url?: string;
  tags: string[];
  source?: string;
  snippet: string;
  terms: string[];
}

export interface SearchResponse {
  query: string;
  total: number;
  limit: number;
  offset: number;
  tookMs: number;
  hits: SearchHit[];
  facets: {
    tags: Record<string, number>;
    sources: Record<string, number>;
  };
  /** Offered when the query matched nothing but a nearby spelling did. */
  suggestion?: string;
}

export interface IndexStats {
  documents: number;
  tags: number;
  sources: number;
  topTags: Array<{ tag: string; count: number }>;
  topSources: Array<{ source: string; count: number }>;
  indexFile: string;
  lastPersistedAt: string | null;
}

/** On-disk index snapshot format. `version` guards against breaking changes. */
export interface IndexSnapshot {
  version: 1;
  savedAt: string;
  documents: BeaconDocument[];
}
