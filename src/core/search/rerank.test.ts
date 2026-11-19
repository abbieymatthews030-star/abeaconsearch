import { describe, expect, it } from 'vitest';
import { rerankHits } from './rerank.js';
import { classifySourceType } from './source-type.js';
import type { DisplayHit } from './types.js';

function hit(partial: Partial<DisplayHit> & Pick<DisplayHit, 'id' | 'title' | 'provider'>): DisplayHit {
  return {
    snippet: partial.snippet ?? '',
    origin: partial.origin ?? 'web',
    score: partial.score ?? 1,
    tags: partial.tags ?? [],
    url: partial.url,
    domain: partial.domain,
    ...partial,
  };
}

describe('classifySourceType', () => {
  it('labels forums, archives, academic and official hosts', () => {
    expect(
      classifySourceType({ url: 'https://news.ycombinator.com/item?id=1', provider: 'Hacker News' }),
    ).toBe('forum');
    expect(
      classifySourceType({
        url: 'https://web.archive.org/web/20200101/https://example.com/',
        provider: 'Wayback Machine',
      }),
    ).toBe('archive');
    expect(classifySourceType({ url: 'https://arxiv.org/abs/1234', provider: 'arXiv' })).toBe(
      'academic',
    );
    expect(classifySourceType({ url: 'https://www.nhs.uk/conditions/', provider: 'DuckDuckGo' })).toBe(
      'official',
    );
  });
});

describe('rerankHits', () => {
  it('boosts indie / primary / older pages over SEO megasites and records reasons', () => {
    const ranked = rerankHits(
      [
        {
          hit: hit({
            id: 'mega',
            title: 'Widget guide',
            provider: 'DuckDuckGo',
            url: 'https://medium.com/widget-guide',
            domain: 'medium.com',
            snippet: 'Everything about widgets on Medium.',
            score: 4,
          }),
          plainTitle: 'Widget guide',
          domain: 'medium.com',
        },
        {
          hit: hit({
            id: 'indie',
            title: 'Widget notes',
            provider: 'Marginalia',
            url: 'https://tilde.club/~ada/widgets.html',
            domain: 'tilde.club',
            snippet: 'Personal notes on widgets from 2012.',
            score: 3,
          }),
          plainTitle: 'Widget notes',
          domain: 'tilde.club',
          publishedAt: '2012-05-01',
        },
        {
          hit: hit({
            id: 'gov',
            title: 'Official widget standard',
            provider: 'DuckDuckGo',
            url: 'https://www.gov.uk/widget-standard',
            domain: 'gov.uk',
            snippet: 'The official widget standard.',
            score: 3.2,
          }),
          plainTitle: 'Official widget standard',
          domain: 'gov.uk',
        },
      ],
      'widget',
      { now: new Date('2026-01-01T00:00:00Z') },
    );

    expect(ranked[0]?.hit.id).toBe('gov');
    expect(ranked[0]?.hit.sourceType).toBe('official');
    expect(ranked[0]?.hit.rankReasons.some((r) => /official/i.test(r))).toBe(true);

    const indie = ranked.find((row) => row.hit.id === 'indie');
    expect(indie?.hit.sourceType).toBe('blog');
    expect(indie?.hit.rankReasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/independent/i),
        expect.stringMatching(/older page/i),
      ]),
    );

    const mega = ranked.find((row) => row.hit.id === 'mega');
    expect(mega?.hit.rankReasons.some((r) => /SEO/i.test(r))).toBe(true);
    expect(indie!.hit.score).toBeGreaterThan(mega!.hit.score);
  });
});
