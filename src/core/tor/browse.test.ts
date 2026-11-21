import { describe, expect, it, vi } from 'vitest';
import { browseOnion } from './browse.js';
import { torFetch } from './socks-fetch.js';

vi.mock('./socks-fetch.js', () => ({ torFetch: vi.fn() }));

const onion = 'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/path/';

describe('onion browser', () => {
  it('keeps links and assets inside the Beacon onion proxy', async () => {
    vi.mocked(torFetch).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: Buffer.from(`
        <base href="https://example.com/">
        <a href="next">Next</a>
        <img src="/logo.png">
        <img srcset="/small.png 1x, /large.png 2x">
        <style>.hero { background: url("/hero.png") }</style>
      `),
      finalUrl: onion,
    });

    const result = await browseOnion(onion, { socksUrl: 'socks5h://127.0.0.1:9050' });

    expect(result.kind).toBe('html');
    if (result.kind !== 'html') return;
    expect(result.html).not.toContain('<base');
    expect(result.html).toContain('/api/tor/browse?url=');
    expect(result.html).toContain(encodeURIComponent(`${onion}next`));
    expect(result.html).toContain(
      encodeURIComponent(
        'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/hero.png',
      ),
    );
    expect(vi.mocked(torFetch)).toHaveBeenCalledWith(
      onion,
      expect.objectContaining({ validateRedirect: expect.any(Function) }),
    );
  });

  it('rewrites URLs in proxied stylesheets', async () => {
    vi.mocked(torFetch).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/css' }),
      body: Buffer.from('@import "/base.css"; .a{background:url(images/a.png)}'),
      finalUrl: onion,
    });

    const result = await browseOnion(onion, { socksUrl: 'socks5h://127.0.0.1:9050' });

    expect(result.kind).toBe('raw');
    if (result.kind !== 'raw') return;
    expect(result.body.toString()).toContain(
      encodeURIComponent(
        'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/path/images/a.png',
      ),
    );
  });
});
