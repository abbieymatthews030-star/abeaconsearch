import { DEFAULT_HTTP_TIMEOUT_MS } from './config.js';

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Abort the request after this many milliseconds (default 15000). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** A caller-owned signal; aborting it also aborts this request. */
  parentSignal?: AbortSignal;
}

/**
 * `fetch` with an overall timeout and optional forwarding of a parent
 * `AbortSignal`. Behaves like `fetch` otherwise — it rejects on network error or
 * abort, and always clears its timer. Used by every outbound HTTP call so the
 * timeout/abort handling lives in one place.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, fetchImpl = fetch, parentSignal, ...init } = options;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}
