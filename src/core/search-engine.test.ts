import { describe, expect, it } from 'vitest';
import { SearchEngine } from './search-engine.js';
import type { SearchQuery } from './types.js';

function q(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    q: '',
    limit: 10,
    offset: 0,
    tags: [],
    fuzzy: true,
    prefix: true,
    sort: 'relevance',
    ...overrides,
  };
}

function seed(engine: SearchEngine): void {
  engine.upsert({
    id: 'a',
    title: 'Getting started with Beacon',
    body: 'Beacon Search is a self-hostable full-text search engine.',
    tags: ['docs', 'intro'],
    source: 'handbook',
  });
  engine.upsert({
    id: 'b',
    title: 'Crawling websites',
    body: 'The crawler follows same-origin links and respects robots rules.',
    tags: ['docs', 'crawler'],
    source: 'handbook',
  });
  engine.upsert({
    id: 'c',
    title: 'Release notes',
    body: 'Performance improvements for the search index.',
    tags: ['changelog'],
    source: 'blog',
  });
}

describe('SearchEngine', () => {
  it('indexes and retrieves documents', () => {
    const engine = new SearchEngine();
    const doc = engine.upsert({ title: 'Hello World', body: 'x', tags: [] });
    expect(doc.id).toBe('hello-world');
    expect(engine.get('hello-world')?.title).toBe('Hello World');
    expect(engine.size).toBe(1);
  });

  it('preserves createdAt across updates and bumps updatedAt', async () => {
    const engine = new SearchEngine();
    const first = engine.upsert({ id: 'x', title: 'One', body: '', tags: [] });
    await new Promise((r) => setTimeout(r, 5));
    const second = engine.upsert({ id: 'x', title: 'Two', body: '', tags: [] });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(engine.size).toBe(1);
  });

  it('finds documents by term with title boosting', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: 'crawler' }));
    expect(res.hits[0]?.id).toBe('b');
    expect(res.total).toBe(1);
  });

  it('supports prefix search', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: 'perform', prefix: true }));
    expect(res.hits.map((h) => h.id)).toContain('c');
  });

  it('filters by tag', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: '', tags: ['docs'] }));
    expect(res.total).toBe(2);
    expect(res.hits.every((h) => h.tags.includes('docs'))).toBe(true);
  });

  it('returns facets over the filtered result set', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q());
    expect(res.facets.tags.docs).toBe(2);
    expect(res.facets.sources.handbook).toBe(2);
  });

  it('paginates', () => {
    const engine = new SearchEngine();
    seed(engine);
    const page1 = engine.search(q({ limit: 2, offset: 0 }));
    const page2 = engine.search(q({ limit: 2, offset: 2 }));
    expect(page1.hits).toHaveLength(2);
    expect(page2.hits).toHaveLength(1);
    expect(page1.total).toBe(3);
  });

  it('highlights matched terms in title and snippet', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: 'beacon' }));
    expect(res.hits[0]?.title).toContain('<mark>');
    expect(res.hits[0]?.snippet).toContain('<mark>');
  });

  it('removes documents', () => {
    const engine = new SearchEngine();
    seed(engine);
    expect(engine.remove('a')).toBe(true);
    expect(engine.remove('a')).toBe(false);
    expect(engine.search(q({ q: 'beacon' })).total).toBe(0);
  });

  it('round-trips through a snapshot', () => {
    const engine = new SearchEngine();
    seed(engine);
    const snapshot = engine.toSnapshot();
    const restored = new SearchEngine();
    restored.replaceAll(snapshot.documents);
    expect(restored.size).toBe(3);
    expect(restored.search(q({ q: 'crawler' })).hits[0]?.id).toBe('b');
  });

  it('computes stats', () => {
    const engine = new SearchEngine();
    seed(engine);
    const stats = engine.stats('/tmp/index.json');
    expect(stats.documents).toBe(3);
    expect(stats.topTags[0]).toEqual({ tag: 'docs', count: 2 });
  });

  it('sorts by title and by newest/oldest updatedAt', () => {
    const engine = new SearchEngine();
    seed(engine);
    const byTitle = engine.search(q({ sort: 'title' }));
    expect(byTitle.hits.map((h) => h.id)).toEqual(['b', 'a', 'c']);

    const newest = engine.search(q({ sort: 'newest' }));
    const oldest = engine.search(q({ sort: 'oldest' }));
    expect(newest.hits.map((h) => h.id)).toEqual([...oldest.hits.map((h) => h.id)].reverse());
  });

  it('offers a "did you mean" suggestion for a near-miss query', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: 'crawlr', fuzzy: false }));
    expect(res.total).toBe(0);
    expect(res.suggestion).toBe('crawler');
  });

  it('does not suggest anything for a query that already matches', () => {
    const engine = new SearchEngine();
    seed(engine);
    const res = engine.search(q({ q: 'crawler' }));
    expect(res.suggestion).toBeUndefined();
  });

  it('suggests completions for a partial term', () => {
    const engine = new SearchEngine();
    seed(engine);
    const suggestions = engine.suggest('craw');
    expect(suggestions).toContain('crawler');
  });

  it('returns no suggestions for an empty query', () => {
    const engine = new SearchEngine();
    seed(engine);
    expect(engine.suggest('')).toEqual([]);
  });
});
