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
  AnswerClaim,
  AnswerConfidence,
  AnswerResponse,
  AnswerSource,
  TrustTier,
} from '@core/answer/types';

export type {
  AnswerClaim,
  AnswerConfidence,
  AnswerResponse,
  AnswerSource,
  BeaconDocument,
  IndexStats,
  PlateCheck,
  SearchHit,
  SearchResponse,
  SuggestResponse,
  TrustTier,
};

export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'title';

export interface HealthResponse {
  status: 'ok';
  documents: number;
  uptimeSeconds: number;
  plateChecks: { vehicleData: boolean; motHistory: boolean };
  answer: { enabled: boolean; webSearch: string | null; llm: string[] };
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
}

export const api = {
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.source) qs.set('source', params.source);
    if (params.sort && params.sort !== 'relevance') qs.set('sort', params.sort);
    for (const tag of params.tags ?? []) qs.append('tags', tag);
    return request<SearchResponse>(`/api/search?${qs.toString()}`, { signal });
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
};
