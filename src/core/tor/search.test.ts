import { describe, expect, it } from 'vitest';
import { curatedTorDirectoryHits, torHitsToDisplay } from './search.js';

describe('torHitsToDisplay', () => {
  it('rewrites onion URLs through the Beacon browse proxy', () => {
    const hits = torHitsToDisplay(
      [
        {
          title: 'Tor Project',
          url: 'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/',
          snippet: 'Official site',
          provider: 'Tor directory',
        },
      ],
      'tor',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toMatch(/^\/api\/tor\/browse\?url=/);
    expect(hits[0]?.tags).toContain('onion');
    expect(hits[0]?.domain).toContain('.onion');
  });
});

describe('curatedTorDirectoryHits', () => {
  it('returns onion directory entries for offline Tor mode', () => {
    const hits = curatedTorDirectoryHits('duckduckgo', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.url.includes('.onion'))).toBe(true);
  });
});
