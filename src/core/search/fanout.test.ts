import { describe, expect, it } from 'vitest';
import type { WebSearchProvider } from '../answer/providers/web-search.js';
import { fanOutWebSearch, type WebBackend } from './fanout.js';

function backend(
  id: string,
  search: WebSearchProvider['search'],
  tier: 'fast' | 'deep' = 'fast',
): WebBackend {
  return {
    id,
    label: id,
    missingEnv: [],
    tier,
    provider: { name: id, configured: true, search },
  };
}

describe('fanOutWebSearch', () => {
  it('returns fast hits without waiting for a slow backend once the budget expires', async () => {
    const started = performance.now();
    const result = await fanOutWebSearch({
      backends: [
        backend('fast', async () => [
          { title: 'Quick Hit', url: 'https://example.com/quick', snippet: 'quick hit page' },
        ]),
        backend('slow', async (_q, _limit, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          });
          return [{ title: 'Late', url: 'https://example.com/late', snippet: 'late hit' }];
        }),
      ],
      query: 'quick hit',
      intent: 'general',
      limit: 5,
      filter: 'strict',
      budgetMs: 80,
    });

    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.results.map((hit) => hit.url)).toContain('https://example.com/quick');
    expect(result.results.map((hit) => hit.url)).not.toContain('https://example.com/late');
    const slow = result.attempts.find((item) => item.id === 'slow');
    expect(slow?.status).toBe('skipped');
    expect(slow?.detail).toMatch(/budget/i);
  });

  it('keeps hits that arrived before the budget abort', async () => {
    const result = await fanOutWebSearch({
      backends: [
        backend('ok', async () => [
          { title: 'Ok', url: 'https://example.com/ok', snippet: 'ok result' },
        ]),
      ],
      query: 'ok result',
      intent: 'general',
      limit: 5,
      filter: 'strict',
      budgetMs: 2_000,
    });
    expect(result.results).toHaveLength(1);
    expect(result.attempts[0]?.status).toBe('ok');
  });
});
