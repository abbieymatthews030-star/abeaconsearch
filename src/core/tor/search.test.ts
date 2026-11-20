import { describe, expect, it, vi } from 'vitest';
import { searchTorNetwork, torHitsToDisplay } from './search.js';
import { torFetch } from './socks-fetch.js';

vi.mock('./socks-fetch.js', () => ({ torFetch: vi.fn() }));

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

  describe('Tor search fallback', () => {
    it('uses the Tor proxy for the clearnet index when its onion service fails', async () => {
      const fetch = vi.mocked(torFetch);
      fetch.mockRejectedValueOnce(new Error('onion unavailable'));
      const response = (html: string) => ({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: Buffer.from(html),
        finalUrl: 'https://ahmia.fi/',
      });
      fetch.mockResolvedValueOnce(response('<html></html>'));
      fetch.mockResolvedValueOnce(
        response(
          '<ol class="searchResults"><li class="result"><h4><a href="http://taxiaii6xr62vugl7qin2fzd4rs6dbqgqcrkxwpoud6uilxwklicapad.onion/">Example</a></h4></li></ol>',
        ),
      );

      const result = await searchTorNetwork('example', { socksUrl: 'socks5h://127.0.0.1:9050' });

      expect(result.hits[0]?.title).toBe('Example');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch).toHaveBeenNthCalledWith(
        3,
        expect.stringMatching(/^https:\/\/ahmia\.fi\/search\//),
        expect.objectContaining({ socksUrl: 'socks5h://127.0.0.1:9050' }),
      );
      expect(result.diagnostics.ahmia).toContain('over Tor');
    });
  });
});
