import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type AnswerConfig } from '../config.js';
import { SearchEngine } from '../search-engine.js';
import { AnswerService } from './answer-service.js';
import type { LlmSynthesizer } from './providers/llm.js';
import type { WebSearchProvider } from './providers/web-search.js';

function answerConfig(overrides: Partial<AnswerConfig> = {}): AnswerConfig {
  return loadConfig({ answer: overrides }).answer;
}

function engineWith(docs: Array<{ title: string; body: string; url?: string }>): SearchEngine {
  const engine = new SearchEngine();
  for (const doc of docs) engine.upsert({ ...doc, tags: [] });
  return engine;
}

const PENGUIN_DOC = {
  title: 'Penguins',
  body: 'Penguins are flightless birds. They live almost exclusively in the Southern Hemisphere, especially around Antarctica. Their diet is mainly fish and krill.',
  url: 'https://en.wikipedia.org/wiki/Penguin',
};

describe('AnswerService', () => {
  it('returns a non-empty "none" answer when nothing is retrieved', async () => {
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch: null,
      synthesizers: [],
    });
    const res = await service.answer('what is the airspeed of an unladen swallow');
    expect(res.confidence).toBe('none');
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.disclaimer).toBeTruthy();
    expect(res.sources).toEqual([]);
    expect(res.warnings.join(' ')).toContain('web search is not configured');
  });

  it('weaves index extracts deterministically when no LLM is configured', async () => {
    const service = new AnswerService({
      engine: engineWith([PENGUIN_DOC]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch: null,
      synthesizers: [],
    });
    const res = await service.answer('where do penguins live');
    expect(res.synthesizer).toBe('extractive');
    expect(res.claims.length).toBeGreaterThan(0);
    expect(res.claims[0]?.sourceIds).toContain(1);
    expect(res.answer.toLowerCase()).toContain('hemisphere');
    expect(res.sources[0]?.trust).toBe('established');
    expect(res.sources[0]?.live).toBe(false);
  });

  it('uses a configured LLM synthesizer and verifies its citations', async () => {
    const llm: LlmSynthesizer = {
      name: 'StubLLM',
      kind: 'llm-anthropic',
      configured: true,
      weave: vi.fn(
        async ({ extracts }) => `Penguins live in the Southern Hemisphere [${extracts[0]?.id}].`,
      ),
    };
    const service = new AnswerService({
      engine: engineWith([PENGUIN_DOC]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch: null,
      synthesizers: [llm],
    });
    const res = await service.answer('where do penguins live');
    expect(llm.weave).toHaveBeenCalled();
    expect(res.synthesizer).toBe('llm-anthropic');
    expect(res.claims[0]?.supported).toBe(true);
    expect(res.confidence).toBe('medium');
  });

  it('falls back to the extractive weave when the LLM throws', async () => {
    const llm: LlmSynthesizer = {
      name: 'StubLLM',
      kind: 'llm-anthropic',
      configured: true,
      weave: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const service = new AnswerService({
      engine: engineWith([PENGUIN_DOC]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch: null,
      synthesizers: [llm],
    });
    const res = await service.answer('where do penguins live');
    expect(res.synthesizer).toBe('extractive');
    expect(res.warnings.join(' ')).toContain('StubLLM synthesis failed');
  });

  it('serves a repeated query from cache', async () => {
    const service = new AnswerService({
      engine: engineWith([PENGUIN_DOC]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch: null,
      synthesizers: [],
    });
    const first = await service.answer('where do penguins live');
    const second = await service.answer('where do penguins live');
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('fetches a live web source through the robots / fetch stack', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'Penguin facts', url: 'https://fake.example/penguins', snippet: '' },
      ],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(
        `<html><head><title>Penguin facts</title></head><body><main>Penguins live in the Southern Hemisphere and eat fish.</main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl,
    });
    const res = await service.answer('where do penguins live');
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]?.origin).toBe('web');
    expect(res.sources[0]?.live).toBe(true);
    expect(res.claims.length).toBeGreaterThan(0);
  });

  it('strips tracking params from a web source URL by default', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        {
          title: 'Penguin facts',
          url: 'https://fake.example/penguins?utm_source=newsletter&fbclid=abc123&id=42',
          snippet: '',
        },
      ],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(
        `<html><head><title>Penguin facts</title></head><body><main>Penguins live in the Southern Hemisphere and eat fish.</main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl,
    });
    const res = await service.answer('where do penguins live');
    expect(res.sources[0]?.url).toBe('https://fake.example/penguins?id=42');
  });

  it('leaves URLs untouched when stripTrackingParams is disabled', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'Penguin facts', url: 'https://fake.example/penguins?utm_source=newsletter', snippet: '' },
      ],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(
        `<html><head><title>Penguin facts</title></head><body><main>Penguins live in the Southern Hemisphere and eat fish.</main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true, stripTrackingParams: false }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl,
    });
    const res = await service.answer('where do penguins live');
    expect(res.sources[0]?.url).toBe('https://fake.example/penguins?utm_source=newsletter');
  });

  it('blocks a web source on a private host and records a warning', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [{ title: 'internal', url: 'http://127.0.0.1/secrets', snippet: '' }],
    };
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as unknown as typeof fetch;
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig(),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl,
    });
    const res = await service.answer('what is the internal secret value here');
    expect(res.sources).toEqual([]);
    expect(res.warnings.join(' ')).toMatch(/could not be fetched/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('overfetches candidates so a few failures do not shrink the result below maxSources', async () => {
    // maxSources=2 triggers a request for up to 6 candidates; half of them
    // 404 and should be silently backfilled by the rest rather than
    // shrinking the final result below 2.
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'bad 1', url: 'https://fake.example/bad-1', snippet: '' },
        { title: 'good 1', url: 'https://fake.example/good-1', snippet: '' },
        { title: 'bad 2', url: 'https://fake.example/bad-2', snippet: '' },
        { title: 'good 2', url: 'https://fake.example/good-2', snippet: '' },
        { title: 'bad 3', url: 'https://fake.example/bad-3', snippet: '' },
        { title: 'good 3', url: 'https://fake.example/good-3', snippet: '' },
      ],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (url.includes('/bad-')) return new Response('not found', { status: 404 });
      return new Response(
        `<html><head><title>Penguin facts</title></head><body><main>Penguins live in the Southern Hemisphere and eat fish.</main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ maxSources: 2, allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl,
    });
    const res = await service.answer('where do penguins live');
    expect(res.sources).toHaveLength(2);
    expect(res.sources.every((s) => s.url?.includes('/good-'))).toBe(true);
    // The shortfall was fully made up for — nothing to warn the reader about.
    expect(res.warnings.join(' ')).not.toMatch(/could not be fetched/);
  });
});

describe('identity / entity resolution', () => {
  const YOUTUBE_FOOTER =
    'AboutPressCopyrightContact usCreatorsAdvertiseDevelopersTermsPrivacyPolicy & SafetyHow YouTube worksTest new features© 2026 Google LLC';

  function pageFetch(pages: Record<string, { title: string; body: string }>): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      for (const [path, page] of Object.entries(pages)) {
        if (url.includes(path)) {
          return new Response(
            `<html><head><title>${page.title}</title></head><body><main>${page.body}</main></body></html>`,
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('rejects YouTube-style boilerplate as evidence and reports it plainly instead of repeating it', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [{ title: 'Abbiey Matthews', url: 'https://fake.example/abbiey-matthews', snippet: '' }],
    };
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({ 'abbiey-matthews': { title: 'Abbiey Matthews - YouTube', body: YOUTUBE_FOOTER } }),
    });
    const res = await service.answer('Abbiey Matthews');
    expect(res.answer).not.toContain('AboutPress');
    expect(res.confidence).toBe('none');
    expect(res.sources[0]?.quote).not.toContain('AboutPress');
    expect(res.sources[0]?.usedInAnswer).toBe(false);
    // The detail lives in the candidate summary, not the generic top-level intro.
    const summary = res.candidates?.[0]?.summary ?? '';
    expect(summary).not.toContain('AboutPress');
    expect(summary.toLowerCase()).toContain('navigation');
  });

  it('retains a useful description from the same kind of page when it is actually substantive', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [{ title: 'Abbiey Matthews', url: 'https://fake.example/abbiey-matthews', snippet: '' }],
    };
    const bio =
      'Abbiey Matthews is a software engineer based in Melbourne who builds open-source search tools and writes about backend infrastructure.';
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({ 'abbiey-matthews': { title: 'Abbiey Matthews', body: bio } }),
    });
    const res = await service.answer('Abbiey Matthews');
    expect(res.answer.toLowerCase()).toContain('melbourne');
    expect(res.sources[0]?.usedInAnswer).toBe(true);
  });

  it('never merges distinct entities that only share one word ("maiz gustavo")', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'Maiz Gustavo - Carpentry Australia', url: 'https://fake.example/carpentry', snippet: '' },
        { title: 'Gustavo Angel Maddonni', url: 'https://fake.example/agronomy', snippet: '' },
        { title: 'Los Guardianes del Maiz', url: 'https://fake.example/film', snippet: '' },
      ],
    };
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true, maxSources: 3 }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({
        // Thin, nav-only page content — an exact name match that still isn't
        // enough to answer from alone, matching the reported real-world case.
        carpentry: {
          title: 'Maiz Gustavo - Carpentry Australia',
          body: 'HomeAboutServicesGalleryContactBook a QuoteCall UsOpening Hours',
        },
        agronomy: {
          title: 'Gustavo Angel Maddonni',
          body: 'Gustavo Angel Maddonni is an agronomist studying maize crop physiology and yield responses.',
        },
        film: {
          title: 'Los Guardianes del Maiz',
          body: 'Los Guardianes del Maiz is a documentary film directed by Gustavo Vazquez about traditional maize farming.',
        },
      }),
    });
    // Typed lowercase, like a real search box — not "Maiz Gustavo".
    const res = await service.answer('maiz gustavo');
    expect(res.candidates).toBeDefined();
    expect(res.candidates).toHaveLength(3);
    // No candidate summary claims the other sources are the same person.
    for (const candidate of res.candidates ?? []) {
      expect(candidate.summary).not.toMatch(/agronomist.*carpentry|carpentry.*agronomist/i);
    }
    expect(res.confidence).toBe('none');
    expect(res.identityConfidence).toBeLessThan(0.5);
  });

  it('corroboration from multiple independent exact-match sources raises confidence', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'Abbiey Matthews', url: 'https://fake.example/a', snippet: '' },
        { title: 'Abbiey Matthews', url: 'https://established.example/b', snippet: '' },
      ],
    };
    const bio1 = 'Abbiey Matthews is a software engineer who works on open-source search infrastructure.';
    const bio2 = 'Abbiey Matthews, a software engineer, has contributed to several open-source search projects.';
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true, maxSources: 2, trustedDomains: ['established.example'] }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({ a: { title: 'Abbiey Matthews', body: bio1 }, b: { title: 'Abbiey Matthews', body: bio2 } }),
    });
    const res = await service.answer('Abbiey Matthews');
    expect(res.confidence === 'high' || res.confidence === 'medium').toBe(true);
    expect(res.sources.filter((s) => s.usedInAnswer).length).toBeGreaterThanOrEqual(1);
  });

  it('flags conflicting sources with a search-gap note instead of silently picking one', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [
        { title: 'Fact Page One', url: 'https://fake.example/one', snippet: '' },
        { title: 'Fact Page Two', url: 'https://fake.example/two', snippet: '' },
      ],
    };
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true, maxSources: 2 }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({
        one: { title: 'Fact Page One', body: 'The bridge was completed in 1998 after a long construction project.' },
        two: { title: 'Fact Page Two', body: 'The bridge was not completed in 1998, construction dragged on for years after.' },
      }),
    });
    const res = await service.answer('when was the bridge completed');
    expect(res.searchGaps.some((g) => /disagree/i.test(g))).toBe(true);
  });

  it('produces an "insufficient evidence" response with no useful evidence at all', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [{ title: 'Random Page', url: 'https://fake.example/random', snippet: '' }],
    };
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({ random: { title: 'Random Page', body: YOUTUBE_FOOTER } }),
    });
    const res = await service.answer('completely unrelated topic nobody indexed');
    expect(res.confidence).toBe('none');
    expect(res.claims).toEqual([]);
  });

  it('keeps citation ids correctly mapped to the sources that actually appear in the answer', async () => {
    const webSearch: WebSearchProvider = {
      name: 'StubSearch',
      configured: true,
      search: async () => [{ title: 'Penguin facts', url: 'https://fake.example/penguins', snippet: '' }],
    };
    const service = new AnswerService({
      engine: engineWith([]),
      config: answerConfig({ allowPrivateHosts: true }),
      userAgent: 'test',
      webSearch,
      synthesizers: [],
      fetchImpl: pageFetch({
        penguins: { title: 'Penguin facts', body: 'Penguins live in the Southern Hemisphere and eat fish.' },
      }),
    });
    const res = await service.answer('where do penguins live');
    const citedIds = new Set(res.claims.flatMap((c) => c.sourceIds));
    for (const id of citedIds) {
      expect(res.sources.some((s) => s.id === id)).toBe(true);
    }
    expect(res.sources.find((s) => citedIds.has(s.id))?.usedInAnswer).toBe(true);
  });
});
