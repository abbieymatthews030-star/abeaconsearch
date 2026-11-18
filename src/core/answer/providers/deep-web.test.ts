import { describe, expect, it, vi } from 'vitest';
import {
  ArxivProvider,
  CrossrefProvider,
  DoajProvider,
  EuropePmcProvider,
  GutenbergProvider,
  InternetArchiveProvider,
  LocProvider,
  OpenAlexProvider,
  OpenLibraryProvider,
  WikidataProvider,
  createDeepKeylessProviders,
} from './deep-web.js';
import { describeWebProviders } from './web-search.js';
import { loadConfig } from '../../config.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('deep keyless providers', () => {
  it('registers every deep source when keyless search is on', () => {
    const config = loadConfig({ answer: { keylessWebSearch: true } }).answer;
    const specs = describeWebProviders(config);
    const ids = specs.filter((s) => s.provider).map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'duckduckgo',
        'wikipedia',
        'openalex',
        'crossref',
        'arxiv',
        'europe_pmc',
        'wikidata',
        'internet_archive',
        'open_library',
        'doaj',
        'library_of_congress',
        'project_gutenberg',
      ]),
    );
    expect(createDeepKeylessProviders({ timeoutMs: 1000 })).toHaveLength(10);
  });

  it('maps OpenAlex works to landing / DOI URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: 'https://openalex.org/W123',
            doi: 'https://doi.org/10.1000/xyz',
            display_name: 'Quantum widgets',
            publication_year: 2024,
            primary_location: { landing_page_url: 'https://example.edu/paper' },
            abstract_inverted_index: { Quantum: [0], widgets: [1], matter: [2] },
          },
        ],
      }),
    );
    const hits = await new OpenAlexProvider({ timeoutMs: 2000, fetchImpl }).search('quantum', 5);
    expect(hits).toEqual([
      {
        title: 'Quantum widgets',
        url: 'https://example.edu/paper',
        snippet: '2024 · Quantum widgets matter',
      },
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('api.openalex.org/works');
  });

  it('maps Crossref items to DOI URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        message: {
          items: [
            {
              title: ['A Crossref Paper'],
              DOI: '10.5555/example',
              URL: 'https://doi.org/10.5555/example',
              'container-title': ['Journal of Examples'],
              issued: { 'date-parts': [[2020]] },
            },
          ],
        },
      }),
    );
    const hits = await new CrossrefProvider({ timeoutMs: 2000, fetchImpl }).search('example', 3);
    expect(hits[0]).toMatchObject({
      title: 'A Crossref Paper',
      url: 'https://doi.org/10.5555/example',
    });
    expect(hits[0]?.snippet).toContain('2020');
  });

  it('parses arXiv Atom entries', async () => {
    const atom = `<?xml version="1.0"?>
      <feed>
        <entry>
          <title>Learning Stuff</title>
          <id>http://arxiv.org/abs/1234.5678</id>
          <summary>A short summary of the paper.</summary>
        </entry>
      </feed>`;
    const fetchImpl = vi.fn(async () => new Response(atom, { status: 200 }));
    const hits = await new ArxivProvider({ timeoutMs: 2000, fetchImpl }).search('learning', 5);
    expect(hits).toEqual([
      {
        title: 'Learning Stuff',
        url: 'https://arxiv.org/abs/1234.5678',
        snippet: 'A short summary of the paper.',
      },
    ]);
  });

  it('maps Europe PMC hits to PubMed / DOI URLs', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        resultList: {
          result: [
            {
              title: 'CRISPR review',
              pmid: '12345',
              journalTitle: 'Nature',
              pubYear: '2019',
            },
          ],
        },
      }),
    );
    const hits = await new EuropePmcProvider({ timeoutMs: 2000, fetchImpl }).search('crispr', 5);
    expect(hits[0]).toEqual({
      title: 'CRISPR review',
      url: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
      snippet: '2019 · Nature',
    });
  });

  it('maps Wikidata entities', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        search: [
          {
            id: 'Q42',
            label: 'Douglas Adams',
            description: 'English author',
            concepturi: 'http://www.wikidata.org/entity/Q42',
          },
        ],
      }),
    );
    const hits = await new WikidataProvider({ timeoutMs: 2000, fetchImpl }).search('douglas', 5);
    expect(hits[0]?.title).toBe('Douglas Adams');
    expect(hits[0]?.url).toContain('wikidata.org');
  });

  it('maps Internet Archive, Open Library, DOAJ, LoC, and Gutenberg', async () => {
    const archive = new InternetArchiveProvider({
      timeoutMs: 2000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          response: {
            docs: [
              {
                identifier: 'goodytwoshoes00newy',
                title: 'Goody Two-Shoes',
                description: 'A children book',
                mediatype: 'texts',
                year: 1766,
              },
            ],
          },
        }),
      ),
    });
    expect(await archive.search('goody', 3)).toEqual([
      {
        title: 'Goody Two-Shoes',
        url: 'https://archive.org/details/goodytwoshoes00newy',
        snippet: '1766 · texts · A children book',
      },
    ]);

    const openLibrary = new OpenLibraryProvider({
      timeoutMs: 2000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          docs: [
            {
              key: '/works/OL1W',
              title: 'Example Book',
              author_name: ['Ada Lovelace'],
              first_publish_year: 1842,
            },
          ],
        }),
      ),
    });
    expect(await openLibrary.search('ada', 3)).toEqual([
      {
        title: 'Example Book',
        url: 'https://openlibrary.org/works/OL1W',
        snippet: '1842 · Ada Lovelace',
      },
    ]);

    const doaj = new DoajProvider({
      timeoutMs: 2000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          results: [
            {
              bibjson: {
                title: 'Open Access Study',
                year: 2021,
                journal: { title: 'OA Journal' },
                identifier: [{ type: 'doi', id: '10.1234/oa' }],
              },
            },
          ],
        }),
      ),
    });
    expect(await doaj.search('open', 3)).toEqual([
      {
        title: 'Open Access Study',
        url: 'https://doi.org/10.1234/oa',
        snippet: '2021 · OA Journal',
      },
    ]);

    const loc = new LocProvider({
      timeoutMs: 2000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          results: [
            {
              title: 'Lincoln portrait',
              url: 'https://www.loc.gov/item/123/',
              date: '1863',
              description: 'Photograph',
            },
          ],
        }),
      ),
    });
    expect(await loc.search('lincoln', 3)).toEqual([
      {
        title: 'Lincoln portrait',
        url: 'https://www.loc.gov/item/123/',
        snippet: '1863 · Photograph',
      },
    ]);

    const gutenberg = new GutenbergProvider({
      timeoutMs: 2000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          results: [
            {
              id: 11,
              title: 'Alice in Wonderland',
              authors: [{ name: 'Carroll, Lewis' }],
              languages: ['en'],
            },
          ],
        }),
      ),
    });
    expect(await gutenberg.search('alice', 3)).toEqual([
      {
        title: 'Alice in Wonderland',
        url: 'https://www.gutenberg.org/ebooks/11',
        snippet: 'Carroll, Lewis · en',
      },
    ]);
  });
});
