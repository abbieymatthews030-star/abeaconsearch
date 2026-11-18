import { describe, expect, it } from 'vitest';
import { isOnionHostname, onionBrowsePath, parseOnionUrl } from './onion.js';

describe('onion helpers', () => {
  it('accepts v3 and legacy v2 onion hostnames', () => {
    expect(
      isOnionHostname('2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion'),
    ).toBe(true);
    expect(isOnionHostname('zqktlwiuavvvqqt4ybvgvi7tyo4hjl5xgfkhexgm3og7d2td44abajid.onion')).toBe(
      true,
    );
    expect(isOnionHostname('facebookcorewwwi.onion')).toBe(true);
    expect(isOnionHostname('example.com')).toBe(false);
    expect(isOnionHostname('not-an-onion.onion')).toBe(false);
  });

  it('rejects clearnet and non-http URLs in parseOnionUrl', () => {
    expect(parseOnionUrl('https://example.com/')).toMatchObject({ error: expect.any(String) });
    expect(parseOnionUrl('ftp://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/')).toMatchObject(
      { error: expect.any(String) },
    );
    const ok = parseOnionUrl(
      'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/path',
    );
    expect(ok).toBeInstanceOf(URL);
  });

  it('builds a Beacon browse path for onion links', () => {
    const url = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epylx42ahyhtzjmkd.onion/';
    expect(onionBrowsePath(url)).toBe(`/api/tor/browse?url=${encodeURIComponent(url)}`);
  });
});
