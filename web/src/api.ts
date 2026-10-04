// Response types are the backend's own definitions, shared via the `@core`
// path alias (see vite.config.ts / tsconfig.json). These are type-only imports,
// erased at build time — the web bundle never pulls in backend code.
import type {
  BeaconDocument,
  IndexStats,
  SearchHit,
  SearchResponse,
  SuggestResponse,
} from '@core/types';
import type { PlateCheck } from '@core/plate/types';
import type {
  AnswerCandidate,
  AnswerClaim,
  AnswerConfidence,
  AnswerResponse,
  AnswerSource,
  EntityMatchType,
  TrustTier,
} from '@core/answer/types';
import type {
  CalculationPrimary,
  DomainPrimary,
  IpPrimary,
  PlatePrimary,
  PrimaryResult,
  QueryKind,
  UniversalQueryResponse,
} from '@core/query-router';
import type {
  SearchAction,
  SearchDiagnostic,
  SearchIntent,
  SearchOutcome,
  SynthesisState,
} from '@core/search/types';
import type { DomainLookup } from '@core/lookups/domain';
import type { IpLookup } from '@core/lookups/ip';
import type { ProviderStatus } from '@core/providers';

export type {
  AnswerCandidate,
  AnswerClaim,
  AnswerConfidence,
  AnswerResponse,
  AnswerSource,
  BeaconDocument,
  CalculationPrimary,
  DomainLookup,
  DomainPrimary,
  EntityMatchType,
  IndexStats,
  IpLookup,
  IpPrimary,
  PlateCheck,
  PlatePrimary,
  PrimaryResult,
  ProviderStatus,
  QueryKind,
  SearchAction,
  SearchDiagnostic,
  SearchHit,
  SearchIntent,
  SearchOutcome,
  SearchResponse,
  SuggestResponse,
  SynthesisState,
  TrustTier,
  UniversalQueryResponse,
};

/** A setting as returned by GET /api/settings — metadata plus its current live value. */
export interface SettingsEntry {
  id: string;
  label: string;
  description: string;
  type: 'toggle' | 'number' | 'text';
  section: 'sources' | 'ai' | 'advanced';
  advanced: boolean;
  requiresRestart: boolean;
  min?: number;
  max?: number;
  value: boolean | number | string;
  isDefault: boolean;
}

export interface DiagnosticsResponse {
  status: 'ok';
  uptimeSeconds: number;
  checkedAt: string;
  documents: number;
  tags: number;
  sources: number;
  lastPersistedAt: string | null;
  providers: ProviderStatus[];
}

export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'title';

export interface HealthResponse {
  status: 'ok';
  documents: number;
  uptimeSeconds: number;
  plateChecks: { vehicleData: boolean; motHistory: boolean };
  answer: { enabled: boolean; autoAnswer: boolean; webSearch: string | null; llm: string[] };
  lookups: { enabled: boolean };
}

export interface DocumentsResponse {
  total: number;
  limit: number;
  offset: number;
  documents: BeaconDocument[];
}

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export interface SearchParams {
  q: string;
  limit?: number;
  offset?: number;
  tags?: string[];
  source?: string;
  sort?: SearchSort;
  /** AND requires every word; OR matches any. Omit for the default (AND, falling back to OR). */
  combineWith?: 'AND' | 'OR';
  /** Whether a no-exact-match AND query may fall back to a partial (OR) match. Default true. */
  allowPartialMatch?: boolean;
  /** Fuzzy (typo-tolerant) matching. Default true. */
  fuzzy?: boolean;
}

function appendCommonParams(qs: URLSearchParams, params: SearchParams): void {
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  if (params.source) qs.set('source', params.source);
  if (params.sort && params.sort !== 'relevance') qs.set('sort', params.sort);
  if (params.combineWith) qs.set('combineWith', params.combineWith);
  if (params.allowPartialMatch === false) qs.set('allowPartialMatch', 'false');
  if (params.fuzzy === false) qs.set('fuzzy', 'false');
  for (const tag of params.tags ?? []) qs.append('tags', tag);
}

export const api = {
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    appendCommonParams(qs, params);
    return request<SearchResponse>(`/api/search?${qs.toString()}`, { signal });
  },
  /**
   * The universal box: classifies `q` and, alongside the usual local search,
   * attaches a structured "primary" result (domain / IP / calculation / plate).
   */
  query(params: SearchParams, signal?: AbortSignal): Promise<UniversalQueryResponse> {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    appendCommonParams(qs, params);
    return request<UniversalQueryResponse>(`/api/query?${qs.toString()}`, { signal });
  },
  suggest(q: string, signal?: AbortSignal): Promise<SuggestResponse> {
    const qs = new URLSearchParams({ q });
    return request<SuggestResponse>(`/api/suggest?${qs.toString()}`, { signal });
  },
  stats(): Promise<IndexStats> {
    return request<IndexStats>('/api/stats');
  },
  documents(params: { limit?: number; offset?: number } = {}): Promise<DocumentsResponse> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    return request<DocumentsResponse>(`/api/documents?${qs.toString()}`);
  },
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },
  answer(q: string, fresh: boolean, signal?: AbortSignal): Promise<AnswerResponse> {
    const qs = new URLSearchParams({ q });
    if (fresh) qs.set('fresh', 'true');
    return request<AnswerResponse>(`/api/answer?${qs.toString()}`, { signal });
  },
  addDocument(doc: {
    title: string;
    body: string;
    url?: string;
    tags: string[];
    source?: string;
  }): Promise<BeaconDocument> {
    return request<BeaconDocument>('/api/documents', {
      method: 'POST',
      body: JSON.stringify(doc),
    });
  },
  deleteDocument(id: string): Promise<void> {
    return request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  crawl(input: { url: string; maxPages?: number; tags?: string[] }): Promise<{
    startUrl: string;
    pagesCrawled: number;
    documentsIndexed: number;
    errors: Array<{ url: string; error: string }>;
    skipped: Array<{ url: string; reason: string }>;
  }> {
    return request('/api/crawl', { method: 'POST', body: JSON.stringify(input) });
  },
  clearIndex(): Promise<{ ok: boolean; documents: number }> {
    return request('/api/index/clear', { method: 'POST' });
  },
  checkPlate(params: {
    plate: string;
    vehicle?: boolean;
    mot?: boolean;
    index?: boolean;
  }): Promise<PlateCheck> {
    return request<PlateCheck>('/api/plate/check', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
  settings(): Promise<{ settings: SettingsEntry[] }> {
    return request('/api/settings');
  },
  patchSettings(
    patch: Record<string, boolean | number | string>,
  ): Promise<{ applied: string[]; errors: Record<string, string>; settings: SettingsEntry[] }> {
    return request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  },
  resetSettings(ids?: string[]): Promise<{ reset: string[]; settings: SettingsEntry[] }> {
    return request('/api/settings/reset', { method: 'POST', body: JSON.stringify({ ids }) });
  },
  providers(): Promise<{ providers: ProviderStatus[] }> {
    return request('/api/providers');
  },
  testProvider(id: string): Promise<ProviderStatus> {
    return request(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
  },
  diagnostics(): Promise<DiagnosticsResponse> {
    return request('/api/diagnostics');
  },
};
