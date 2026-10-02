import { describe, expect, it, vi } from 'vitest';
import { extractReadable, fetchHtml } from './readable.js';

describe('extractReadable', () => {
  it('prefers <main>, derives a title and separates block text', () => {
    const doc = extractReadable(
      `<html><head><title>Doc Title</title></head><body>
        <nav>skip me</nav>
        <main><h1>Heading</h1><p>First para.</p><p>Second para.</p></main>
      </body></html>`,
      'https://example.test/page',
      ['t'],
    );
    expect(doc?.title).toBe('Doc Title');
    expect(doc?.body).toBe('Heading First para. Second para.');
    expect(doc?.source).toBe('example.test');
    expect(doc?.tags).toEqual(['t']);
  });

  it('strips nav/header/footer/aside even when nested inside <main>', () => {
    const doc = extractReadable(
      `<html><head><title>Doc Title</title></head><body>
        <main>
          <header>Site Header</header>
          <nav>Language: EN FR DE</nav>
          <h1>Heading</h1><p>Real content.</p>
          <aside>Related links</aside>
          <footer>Copyright 2026</footer>
        </main>
      </body></html>`,
      'https://example.test/page',
    );
    expect(doc?.body).toBe('Heading Real content.');
  });

  it('returns null when there is no title and no body', () => {
    expect(
      extractReadable('<html><body><main></main></body></html>', 'https://x.test/'),
    ).toBeNull();
  });
});

describe('fetchHtml', () => {
  it('returns body + final URL for an HTML 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<title>ok</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch;
    const res = await fetchHtml('https://x.test/', { userAgent: 'b', timeoutMs: 100, fetchImpl });
    expect(res).toMatchObject({ html: '<title>ok</title>' });
  });

  it('reports an error for a non-HTML content type', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const res = await fetchHtml('https://x.test/', { userAgent: 'b', timeoutMs: 100, fetchImpl });
    expect('error' in res && res.error).toContain('unsupported content-type');
  });

  it('reports an error for a non-2xx status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    const res = await fetchHtml('https://x.test/', { userAgent: 'b', timeoutMs: 100, fetchImpl });
    expect('error' in res && res.error).toBe('HTTP 503');
  });
});
