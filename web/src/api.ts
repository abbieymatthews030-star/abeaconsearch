// Response types are the backend's own definitions, shared via the `@core`
// path alias (see vite.config.ts / tsconfig.json). These are type-only imports,
// erased at build time — the web bundle never pulls in backend code.
import type { BeaconDocument, IndexStats, SearchHit, SearchResponse } from '@core/types';
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
  TrustTier,
};

export interface HealthResponse {
  status: 'ok';
  documents: number;
  uptimeSeconds: number;
  answer: { enabled: boolean; webSearch: string | null; llm: string[] };
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
}

export const api = {
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.source) qs.set('source', params.source);
    for (const tag of params.tags ?? []) qs.append('tags', tag);
    return request<SearchResponse>(`/api/search?${qs.toString()}`, { signal });
  },
  stats(): Promise<IndexStats> {
    return request<IndexStats>('/api/stats');
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
    country?: 'GB' | 'AU';
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
