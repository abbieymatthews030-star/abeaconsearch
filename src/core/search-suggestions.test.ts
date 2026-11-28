import { describe, expect, it } from 'vitest';
import { buildSearchSuggestions } from '../../web/src/search-suggestions.js';

describe('buildSearchSuggestions', () => {
  it('puts matching recent searches first and deduplicates indexed suggestions', () => {
    expect(
      buildSearchSuggestions(
        'fast',
        ['Fastify docs', 'fast sorting', 'fast'],
        ['Fast history', 'Fastify docs', 'Search history', 'Fast old'],
      ),
    ).toEqual([
      { value: 'Fast history', source: 'recent' },
      { value: 'Fastify docs', source: 'recent' },
      { value: 'Fast old', source: 'recent' },
      { value: 'fast sorting', source: 'index' },
    ]);
  });

  it('ignores recent queries that do not match the typed prefix', () => {
    expect(buildSearchSuggestions('sea', ['searxng'], ['search docs', 'browse history'])).toEqual([
      { value: 'search docs', source: 'recent' },
      { value: 'searxng', source: 'index' },
    ]);
  });

  it('does not show suggestions for short or exact queries', () => {
    expect(buildSearchSuggestions('f', ['fast'], ['fast search'])).toEqual([]);
    expect(buildSearchSuggestions('FAST', ['fast'], ['FAST'])).toEqual([]);
  });

  it('limits the list to four recent and eight total suggestions', () => {
    const recent = Array.from({ length: 6 }, (_, index) => `sea recent ${index}`);
    const indexed = Array.from({ length: 10 }, (_, index) => `sea indexed ${index}`);
    const suggestions = buildSearchSuggestions('sea', indexed, recent);

    expect(suggestions).toHaveLength(8);
    expect(suggestions.filter((suggestion) => suggestion.source === 'recent')).toHaveLength(4);
  });
});
