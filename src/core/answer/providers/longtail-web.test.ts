import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { describeWebProviders } from './web-search.js';
import {
  CommonCrawlProvider,
  HackerNewsProvider,
  MarginaliaProvider,
  RedditProvider,
  WaybackMachineProvider,
  createLongtailProviders,
} from './longtail-web.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200, contentType = 'application/json'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('longtail providers', () => {
  it('registers every long-tail source when keyless search is on', () => {
    const config = loadConfig({ answer: { keylessWebSearch: true } }).answer;
    const specs = describeWebProviders(config);
    const longtail = specs.filter((s) => s.tier === 'longtail' && s.provider);
    expect(longtail.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'wayback_machine',
        'common_crawl',
        'hacker_news',
        'reddit',
        'marginalia',
      ]),
    );
    expect(
      createLongtailProviders(
        { timeoutMs: 1000 },
        {
          wayback: true,
          commonCrawl: true,
          hackerNews: true,
          reddit: true,
          marginalia: true,
        },
      ),
    ).toHaveLength(5);
  });

  it('honours per-provider toggles', () => {
    const providers = createLongtailProviders(
      { timeoutMs: 1000 },
      {
        wayback: true,
        commonCrawl: false,
        hackerNews: true,
        reddit: false,
        marginalia: false,
      },
    );
    expect(providers.map((p) => p.name)).toEqual(['Wayback Machine', 'Hacker News']);
  });

  it('maps Wayback CDX rows to archive.org capture URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        ['original', 'timestamp', 'statuscode', 'mimetype'],
        ['http://example.com/', '20020120142510', '200', 'text/html'],
      ]),
    );
    const hits = await new WaybackMachineProvider({ timeoutMs: 2000, fetchImpl }).search(
      'example.com',
      5,
    );
    expect(hits).toEqual([
      {
        title: 'http://example.com/',
        url: 'https://web.archive.org/web/20020120142510/http://example.com/',
        snippet: 'Captured 2002 · Internet Archive Wayback Machine',
      },
    ]);
  });

  it('maps Common Crawl NDJSON to live URLs', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('collinfo.json')) {
        return jsonResponse([
          { id: 'CC-MAIN-TEST', 'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-TEST-index' },
        ]);
      }
      return textResponse(
        [
          JSON.stringify({
            url: 'https://example.com/page',
            timestamp: '20240101120000',
            status: '200',
          }),
          JSON.stringify({
            url: 'https://example.com/other',
            timestamp: '20240102120000',
            status: '200',
          }),
        ].join('\n'),
      );
    });
    const hits = await new CommonCrawlProvider({ timeoutMs: 2000, fetchImpl }).search(
      'example.com',
      5,
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]?.url).toBe('https://example.com/page');
    expect(hits[0]?.snippet).toContain('Common Crawl');
  });

  it('maps Hacker News Algolia hits', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        hits: [
          {
            title: 'Show HN: Beacon',
            url: 'https://example.com/beacon',
            objectID: '123',
            points: 42,
            num_comments: 7,
            author: 'alice',
            created_at: '2024-01-02T00:00:00.000Z',
          },
        ],
      }),
    );
    const hits = await new HackerNewsProvider({ timeoutMs: 2000, fetchImpl }).search('beacon', 5);
    expect(hits).toEqual([
      {
        title: 'Show HN: Beacon',
        url: 'https://example.com/beacon',
        snippet: '42 points · 7 comments · by alice · 2024-01-02',
      },
    ]);
  });

  it('maps Reddit JSON search hits', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          children: [
            {
              data: {
                title: 'Anyone using MiniSearch?',
                permalink: '/r/node/comments/abc/anyone_using_minisearch/',
                selftext: 'Looking for a small full-text index.',
                subreddit: 'node',
                score: 12,
                num_comments: 3,
                created_utc: 1_700_000_000,
              },
            },
          ],
        },
      }),
    );
    const hits = await new RedditProvider({ timeoutMs: 2000, fetchImpl }).search('minisearch', 5);
    expect(hits[0]?.title).toBe('Anyone using MiniSearch?');
    expect(hits[0]?.url).toContain('reddit.com/r/node/comments/abc');
    expect(hits[0]?.snippet).toContain('r/node');
  });

  it('maps Marginalia API results with the public key header', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('API-Key')).toBe('public');
      return jsonResponse({
        results: [
          {
            url: 'https://indie.example/notes',
            title: 'Indie notes',
            description: 'A small personal site about search.',
          },
        ],
      });
    });
    const hits = await new MarginaliaProvider({ timeoutMs: 2000, fetchImpl }).search(
      'indie search',
      5,
    );
    expect(hits).toEqual([
      {
        title: 'Indie notes',
        url: 'https://indie.example/notes',
        snippet: 'A small personal site about search.',
      },
    ]);
  });

  it('surfaces rate limits as errors', async () => {
    const fetchImpl = vi.fn(async () => textResponse('slow down', 429));
    await expect(
      new HackerNewsProvider({ timeoutMs: 2000, fetchImpl }).search('test', 3),
    ).rejects.toThrow(/rate limited/i);
  });
});
