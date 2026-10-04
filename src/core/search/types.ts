import type { SearchResponse } from '../types.js';

/** Shared search-envelope types. Safe to import from the web UI. */

export type SearchIntent =
  | 'person'
  | 'company'
  | 'domain'
  | 'ip'
  | 'email'
  | 'username'
  | 'phone'
  | 'location'
  | 'factual'
  | 'calculation'
  | 'plate'
  | 'general';

/** What the search itself found. Distinct from whether a summary could be written. */
export type SearchOutcome = 'results' | 'empty' | 'partial' | 'unconfigured';

/** Whether the hits are enough to write a factual summary. Links can still be shown when this is `insufficient`. */
export type SynthesisState = 'possible' | 'insufficient' | 'not_applicable';

export interface DisplayHit {
  id: string;
  /** Highlighted HTML, safe to inject: only `<mark>` tags are added. */
  title: string;
  url?: string;
  /** Highlighted HTML snippet. */
  snippet: string;
  domain?: string;
  origin: 'index' | 'web';
  provider: string;
  score: number;
  tags: string[];
}

export interface SearchDiagnostic {
  id: string;
  label: string;
  status: 'ok' | 'error' | 'not_configured' | 'skipped';
  detail: string;
  /** Env vars or settings that would enable this provider. Empty when nothing is missing. */
  missingEnv: string[];
  tookMs?: number;
  resultCount?: number;
}

export interface SearchAction {
  id: 'web' | 'broaden' | 'exact' | 'spelling' | 'add';
  label: string;
  /** When set, the UI runs this query. `add` opens a source-URL field instead. */
  query?: string;
}

export interface SearchEnvelope {
  query: string;
  intent: SearchIntent;
  outcome: SearchOutcome;
  synthesis: SynthesisState;
  local: SearchResponse;
  results: DisplayHit[];
  total: number;
  tookMs: number;
  /** Human labels for sources that were actually asked, including the local index. */
  attempted: string[];
  /** Query strings sent, in the order they were tried. */
  queriesTried: string[];
  diagnostics: SearchDiagnostic[];
  actions: SearchAction[];
}
