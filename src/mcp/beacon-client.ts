/**
 * Thin HTTP client for a running Beacon Search server. Used by the MCP server so
 * that its `search`/`index` tools operate through the same API (and index file)
 * as everything else, avoiding concurrent-writer races on the snapshot.
 */
import type { BeaconDocument, IndexStats, SearchResponse } from '../core/types.js';

export class BeaconClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...init?.headers,
        },
      });
    } catch (error) {
      throw new Error(
        `Cannot reach the Beacon API at ${this.baseUrl} (${
          error instanceof Error ? error.message : String(error)
        }). Start it with \`beacon serve\` or set BEACON_API_URL.`,
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error(
          `Beacon API HTTP ${response.status} returned non-JSON body: ${text.slice(0, 200)}`,
        );
      }
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message: unknown }).message)
          : `Beacon API returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  health(): Promise<{
    status: 'ok' | 'degraded';
    documents: number;
    uptimeSeconds: number;
    plateChecks: {
      vehicleData: boolean;
      motHistory: boolean;
      defaultCountry?: string;
      countries?: Array<{ code: string; name: string }>;
    };
    answer: { enabled: boolean; autoAnswer: boolean; webSearch: string | null; llm: string[] };
    lookups: { enabled: boolean };
  }> {
    return this.request('/api/health');
  }

  stats(): Promise<IndexStats> {
    return this.request('/api/stats');
  }

  search(params: {
    q: string;
    limit?: number;
    tags?: string[];
    source?: string;
    sort?: 'relevance' | 'newest' | 'oldest' | 'title';
  }): Promise<SearchResponse> {
    const qs = new URLSearchParams({ q: params.q });
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.source) qs.set('source', params.source);
    if (params.sort && params.sort !== 'relevance') qs.set('sort', params.sort);
    for (const tag of params.tags ?? []) qs.append('tags', tag);
    return this.request(`/api/search?${qs.toString()}`);
  }

  addDocument(doc: {
    title: string;
    body: string;
    url?: string;
    tags?: string[];
    source?: string;
  }): Promise<BeaconDocument> {
    return this.request('/api/documents', { method: 'POST', body: JSON.stringify(doc) });
  }
}
