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

  it('retries broader variants after a transient provider failure', async () => {
    const calls: string[] = [];
    const result = await fanOutWebSearch({
      backends: [
        backend('flaky', async (q) => {
          calls.push(q);
          if (q === '"abbiey matthews"') throw new Error('temporary failure');
          if (q === 'abbey matthews') {
            return [
              {
                title: 'Abbey Matthews',
                url: 'https://example.com/abbey',
                snippet: 'Abbey Matthews',
              },
            ];
          }
          return [];
        }),
      ],
      query: 'abbiey matthews',
      intent: 'person',
      limit: 5,
      filter: 'strict',
      budgetMs: 2_000,
    });

    expect(calls).toContain('abbey matthews');
    expect(result.results.map((hit) => hit.url)).toEqual(['https://example.com/abbey']);
    expect(result.attempts[0]?.status).toBe('ok');
    expect(result.attempts[0]?.detail).toMatch(/retried 1 failed response/i);
  });

  it('marks an empty result partial when one completed source is healthy and another times out', async () => {
    const result = await fanOutWebSearch({
      backends: [
        backend('empty', async () => []),
        backend('slow', async (_q, _limit, signal) => {
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
          return [];
        }),
      ],
      query: 'missing result',
      intent: 'general',
      limit: 5,
      filter: 'strict',
      budgetMs: 30,
    });

    expect(result.results).toEqual([]);
    expect(result.attempts.find((item) => item.id === 'empty')?.status).toBe('ok');
    expect(result.attempts.find((item) => item.id === 'slow')?.status).toBe('skipped');
  });
});
