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
  DeniedCategory,
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
  DeniedCategory,
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
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checkedAt: string;
  documents: number;
  tags: number;
  sources: number;
  lastPersistedAt: string | null;
  lastPersistError?: string | null;
  providers: ProviderStatus[];
}

export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'title';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  documents: number;
  indexEmpty?: boolean;
  uptimeSeconds: number;
  lastPersistedAt?: string | null;
  lastPersistError?: string | null;
  plateChecks: { vehicleData: boolean; motHistory: boolean };
  answer: { enabled: boolean; autoAnswer: boolean; webSearch: string | null; llm: string[] };
  lookups: { enabled: boolean };
  tor?: { enabled: boolean; socksUrl: string };
  site?: { name: string; url: string };
}

export interface TorStatusResponse {
  enabled: boolean;
  socksUrl: string;
  reachable: boolean;
  isTor?: boolean;
  exitIp?: string;
  error?: string;
  checkedAt: string;
}

export interface DocumentsResponse {
  total: number;
  limit: number;
  offset: number;
  documents: BeaconDocument[];
}

const BASE = import.meta.env.VITE_API_BASE ?? '';

function errorMessage(payload: unknown, status: number): string {
  if (!payload || typeof payload !== 'object') return `Request failed with ${status}`;
  const body = payload as {
    message?: unknown;
    issues?: unknown;
    errors?: unknown;
    error?: unknown;
  };
  const code = typeof body.error === 'string' ? body.error : '';
  const base = typeof body.message === 'string' ? body.message : `Request failed with ${status}`;
  const message = code === 'rate_limited' ? `${base} (rate limited)` : base;

  const parts: string[] = [];
  if (Array.isArray(body.issues)) {
    for (const issue of body.issues) {
      if (!issue || typeof issue !== 'object') continue;
      const row = issue as { path?: unknown; message?: unknown };
      const path = typeof row.path === 'string' && row.path ? row.path : '';
      const detail = typeof row.message === 'string' ? row.message : '';
      const part = [path, detail].filter(Boolean).join(': ');
      if (part) parts.push(part);
    }
  }
  if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
    for (const [key, value] of Object.entries(body.errors as Record<string, unknown>)) {
      if (typeof value === 'string' && value) parts.push(`${key}: ${value}`);
    }
  }
  return parts.length > 0 ? `${message} ${parts.join('; ')}` : message;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Network error: ${error.message}`
        : 'Network error talking to the API',
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Request failed with ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(errorMessage(payload, response.status));
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
  /** Prefix matching. Default true. Send false to require whole tokens. */
  prefix?: boolean;
  /** `force` always searches the web; `off` never does. Omit for auto. */
  web?: 'force' | 'off';
  /** Tor mode: onion / Tor-directory results only, opened through Beacon. */
  tor?: boolean;
  /** `deep` fans out to Wayback / Common Crawl / HN / Reddit / Marginalia. */
  mode?: 'normal' | 'deep';
  /** Filter results to one source type. */
  sourceType?: 'forum' | 'archive' | 'official' | 'news' | 'blog' | 'academic';
}

function appendCommonParams(qs: URLSearchParams, params: SearchParams): void {
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  if (params.source) qs.set('source', params.source);
  if (params.sort && params.sort !== 'relevance') qs.set('sort', params.sort);
  if (params.combineWith) qs.set('combineWith', params.combineWith);
  if (params.allowPartialMatch === false) qs.set('allowPartialMatch', 'false');
  if (params.fuzzy === false) qs.set('fuzzy', 'false');
  if (params.prefix === false) qs.set('prefix', 'false');
  if (params.web) qs.set('web', params.web);
  if (params.tor) qs.set('tor', 'true');
  if (params.mode === 'deep') qs.set('mode', 'deep');
  if (params.sourceType) qs.set('sourceType', params.sourceType);
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
  suggest(q: string, signal?: AbortSignal, limit?: number): Promise<SuggestResponse> {
    const qs = new URLSearchParams({ q });
    if (limit !== undefined) qs.set('limit', String(limit));
    return request<SuggestResponse>(`/api/suggest?${qs.toString()}`, { signal });
  },
  stats(): Promise<IndexStats> {
    return request<IndexStats>('/api/stats');
  },
  documents(
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<DocumentsResponse> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    return request<DocumentsResponse>(`/api/documents?${qs.toString()}`, { signal });
  },
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },
  torStatus(signal?: AbortSignal): Promise<TorStatusResponse> {
    return request<TorStatusResponse>('/api/tor/status', { signal });
  },
  answer(
    q: string,
    fresh: boolean,
    signal?: AbortSignal,
    urls?: string[],
  ): Promise<AnswerResponse> {
    const qs = new URLSearchParams({ q });
    if (fresh) qs.set('fresh', 'true');
    for (const url of urls ?? []) qs.append('urls', url);
    return request<AnswerResponse>(`/api/answer?${qs.toString()}`, { signal });
  },
  document(id: string): Promise<BeaconDocument> {
    return request<BeaconDocument>(`/api/documents/${encodeURIComponent(id)}`);
  },
  addDocument(doc: {
    id?: string;
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
  updateDocument(
    id: string,
    doc: { title: string; body: string; url?: string; tags: string[]; source?: string },
  ): Promise<BeaconDocument> {
    return request<BeaconDocument>(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(doc),
    });
  },
  bulkImport(documents: unknown[]): Promise<{ indexed: number; ids: string[] }> {
    return request('/api/documents/bulk', {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
  },
  deleteDocument(id: string): Promise<void> {
    return request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  crawl(input: {
    url: string;
    maxPages?: number;
    tags?: string[];
    sameOriginOnly?: boolean;
  }): Promise<{
    startUrl: string;
    pagesCrawled: number;
    documentsIndexed: number;
    errors: Array<{ url: string; error: string }>;
    skipped: Array<{ url: string; reason: string }>;
    robotsStatus?: 'ok' | 'missing' | 'error' | 'disabled';
    warnings?: string[];
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
    referenceDate?: string;
  }): Promise<PlateCheck> {
    return request<PlateCheck>('/api/plate/check', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
  checkPlateGet(
    plate: string,
    params: {
      vehicle?: boolean;
      mot?: boolean;
      index?: boolean;
      referenceDate?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<PlateCheck> {
    const qs = new URLSearchParams();
    if (params.vehicle !== undefined) qs.set('vehicle', String(params.vehicle));
    if (params.mot !== undefined) qs.set('mot', String(params.mot));
    if (params.index !== undefined) qs.set('index', String(params.index));
    if (params.referenceDate) qs.set('referenceDate', params.referenceDate);
    const query = qs.toString();
    return request<PlateCheck>(
      `/api/plate/${encodeURIComponent(plate)}${query ? `?${query}` : ''}`,
      { signal },
    );
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
