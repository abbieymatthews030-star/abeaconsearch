import { describe, expect, it } from 'vitest';
import { wantsDeepWebSources } from './intent.js';

describe('wantsDeepWebSources', () => {
  it('skips deep sources for everyday person and company lookups', () => {
    expect(wantsDeepWebSources('Abbiey Matthews', 'person')).toBe(false);
    expect(wantsDeepWebSources('Acme Corp', 'company')).toBe(false);
  });

  it('includes deep sources for research-shaped factual queries', () => {
    expect(wantsDeepWebSources('what is CRISPR?', 'factual')).toBe(true);
    expect(wantsDeepWebSources('arxiv transformer attention paper', 'general')).toBe(true);
  });

  it('includes deep sources for a person query that names a paper or DOI', () => {
    expect(wantsDeepWebSources('Ada Lovelace arxiv paper', 'person')).toBe(true);
  });
});
