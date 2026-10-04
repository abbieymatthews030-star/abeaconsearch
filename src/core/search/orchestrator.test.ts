import { describe, expect, it } from 'vitest';
import type { WebSearchProvider } from '../answer/providers/web-search.js';
import { loadConfig } from '../config.js';
import { SearchEngine } from '../search-engine.js';
import type { WebBackend } from './fanout.js';
import { spellingVariant } from './intent.js';
import { runUniversalSearch } from './orchestrator.js';
import { isCloseSpelling } from './relevance.js';
import type { SearchQuery } from '../types.js';

function searchQuery(q: string): SearchQuery {
  return {
    q,
    limit: 10,
    offset: 0,
    tags: [],
    fuzzy: true,
    prefix: true,
    sort: 'relevance',
    allowPartialMatch: true,
  };
}

function backend(
  name: string,
  search: WebSearchProvider['search'],
  id = name.toLowerCase(),
): WebBackend {
  return {
    id,
    label: name,
    missingEnv: [],
    provider: { name, configured: true, search },
  };
}

function miniSearchDoc(engine: SearchEngine): void {
  engine.upsert({
    id: 'minisearch-ranking-explained',
    title: 'MiniSearch Ranking Explained',
    body: 'MiniSearch ranks documents using term frequency and field boosting, with title matches weighted higher than body matches.',
    tags: ['search', 'ranking'],
  });
}

const config = loadConfig({ answer: { keylessWebSearch: false } }).answer;

describe('runUniversalSearch', () => {
  it('returns web results for a person-name query', async () => {
    const engine = new SearchEngine();
    miniSearchDoc(engine);
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('DuckDuckGo', async () => [
          {
            title: 'Abbiey Matthews',
            url: 'https://example.com/abbiey-matthews',
            snippet: 'Abbiey Matthews is a software engineer.',
          },
        ]),
      ],
    });

    expect(result.intent).toBe('person');
    expect(result.results.map((hit) => hit.url)).toContain('https://example.com/abbiey-matthews');
    expect(result.results.some((hit) => hit.id === 'minisearch-ranking-explained')).toBe(false);
    expect(result.outcome === 'results' || result.outcome === 'partial').toBe(true);
  });

  it('uses external results when the local index has nothing relevant', async () => {
    const engine = new SearchEngine();
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('Wikipedia', async () => [
          {
            title: 'Abbiey Matthews',
            url: 'https://en.wikipedia.org/wiki/Abbiey_Matthews',
            snippet: 'Abbiey Matthews — biography.',
          },
        ]),
      ],
    });

    expect(result.local.total).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.origin).toBe('web');
    expect(result.results[0]?.domain).toBe('en.wikipedia.org');
  });

  it('rejects an irrelevant MiniSearch local result', async () => {
    const engine = new SearchEngine();
    miniSearchDoc(engine);
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [backend('DuckDuckGo', async () => [])],
    });

    expect(result.results.some((hit) => /minisearch/i.test(hit.title))).toBe(false);
    expect(result.local.hits).toHaveLength(0);
    expect(result.outcome).toBe('empty');
  });

  it('still returns an engine help document when the query is about it', async () => {
    const engine = new SearchEngine();
    miniSearchDoc(engine);
    const result = await runUniversalSearch({
      query: 'minisearch ranking',
      search: searchQuery('minisearch ranking'),
      engine,
      config,
      backends: [backend('DuckDuckGo', async () => [])],
    });

    expect(result.results.some((hit) => hit.id === 'minisearch-ranking-explained')).toBe(true);
  });

  it('returns the other provider when one provider fails', async () => {
    const engine = new SearchEngine();
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend(
          'Brave Search',
          async () => {
            throw new Error('HTTP 503');
          },
          'brave',
        ),
        backend('DuckDuckGo', async () => [
          {
            title: 'Abbiey Matthews',
            url: 'https://example.com/abbiey',
            snippet: 'Abbiey Matthews',
          },
        ]),
      ],
    });

    expect(result.results.map((hit) => hit.url)).toEqual(['https://example.com/abbiey']);
    expect(result.diagnostics.some((item) => item.id === 'brave' && item.status === 'error')).toBe(
      true,
    );
    expect(result.outcome).toBe('partial');
  });

  it('names the missing provider settings when nothing is configured', async () => {
    const engine = new SearchEngine();
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
    });

    expect(result.outcome).toBe('unconfigured');
    expect(result.results).toHaveLength(0);
    const missing = result.diagnostics.flatMap((item) => item.missingEnv).join(' ');
    expect(missing).toContain('BRAVE_SEARCH_API_KEY');
    expect(missing).toContain('TAVILY_API_KEY');
    expect(missing).toContain('SEARXNG_URL');
    expect(missing).toContain('BEACON_KEYLESS_WEB_SEARCH=1');
  });

  it('returns an empty outcome when providers find nothing relevant', async () => {
    const engine = new SearchEngine();
    miniSearchDoc(engine);
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('DuckDuckGo', async () => [
          {
            title: 'MiniSearch Ranking Explained',
            url: 'https://example.com/minisearch',
            snippet: 'Term frequency and field boosting.',
          },
        ]),
      ],
    });

    expect(result.outcome).toBe('empty');
    expect(result.results).toHaveLength(0);
    expect(result.synthesis).toBe('not_applicable');
  });

  it('keeps useful links when there is not enough text to synthesize an answer', async () => {
    const engine = new SearchEngine();
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('DuckDuckGo', async () => [
          {
            title: 'Abbiey Matthews',
            url: 'https://example.com/abbiey-matthews',
            snippet: 'Abbiey Matthews',
          },
        ]),
      ],
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.synthesis).toBe('insufficient');
    expect(result.outcome).toBe('results');
  });

  it('tries the exact quoted name before a spelling variant', async () => {
    const engine = new SearchEngine();
    const calls: string[] = [];
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('DuckDuckGo', async (q) => {
          calls.push(q);
          if (q === '"abbiey matthews"') {
            return [
              {
                title: 'Abbiey Matthews',
                url: 'https://example.com/exact',
                snippet: 'Abbiey Matthews profile',
              },
            ];
          }
          return [];
        }),
      ],
    });

    expect(calls).toEqual(['"abbiey matthews"']);
    expect(result.results[0]?.url).toBe('https://example.com/exact');
    expect(result.queriesTried).toEqual(['"abbiey matthews"']);
  });

  it('falls back to a spelling variant when the exact name finds nothing', async () => {
    const engine = new SearchEngine();
    const calls: string[] = [];
    expect(spellingVariant('abbiey matthews')).toBe('abbey matthews');
    const result = await runUniversalSearch({
      query: 'abbiey matthews',
      search: searchQuery('abbiey matthews'),
      engine,
      config,
      backends: [
        backend('DuckDuckGo', async (q) => {
          calls.push(q);
          if (q.toLowerCase() === 'abbey matthews') {
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
    });

    expect(calls[0]).toBe('"abbiey matthews"');
    expect(calls).toContain('abbiey matthews');
    expect(calls).toContain('abbey matthews');
    expect(result.results.map((hit) => hit.url)).toContain('https://example.com/abbey');
    expect(
      result.actions.some(
        (action) => action.id === 'spelling' && action.query === 'abbey matthews',
      ),
    ).toBe(true);
    expect(result.actions.some((action) => action.id === 'exact')).toBe(true);
    expect(result.actions.some((action) => action.id === 'web')).toBe(true);
    expect(result.actions.some((action) => action.id === 'add')).toBe(true);
  });

  it('does not treat matthews as a fuzzy match for matches', () => {
    expect(isCloseSpelling('matthews', 'matches')).toBe(false);
    expect(isCloseSpelling('perfrmance', 'performance')).toBe(true);
  });
});
