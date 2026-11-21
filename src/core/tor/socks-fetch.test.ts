import { beforeEach, describe, expect, it, vi } from 'vitest';

const response = vi.hoisted(() => ({ body: '', status: 200, location: '' }));

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: {
      request: vi.fn((_url: unknown, _options: unknown, callback: (incoming: unknown) => void) => {
        const request = new EventEmitter();
        Object.assign(request, {
          end: () =>
            queueMicrotask(() => {
              const status = response.status;
              const location = response.location;
              response.status = 200;
              response.location = '';
              const incoming = Object.assign(new EventEmitter(), {
                statusCode: status,
                statusMessage: 'OK',
                headers: location ? { location } : {},
              });
              callback(incoming);
              incoming.emit('data', Buffer.from(response.body));
              incoming.emit('end');
            }),
          destroy: () => undefined,
        });
        return request;
      }),
    },
  };
});

import { probeTorSocks, torFetch } from './socks-fetch.js';

describe('Tor SOCKS verification', () => {
  beforeEach(() => {
    response.status = 200;
    response.body = '';
    response.location = '';
  });

  it('accepts a positive Tor Project check', async () => {
    response.body = JSON.stringify({ IsTor: true, IP: '192.0.2.1' });
    await expect(probeTorSocks('socks5h://127.0.0.1:9050')).resolves.toEqual({
      ok: true,
      exitIp: '192.0.2.1',
    });
  });

  it('follows redirects and returns the final URL', async () => {
    const target =
      'https://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/final';
    response.status = 302;
    response.location = target;
    const result = await torFetch(
      'https://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/start',
      { socksUrl: 'socks5h://127.0.0.1:9050' },
    );

    expect(result.finalUrl).toBe(target);
  });

  it.each(['{"IsTor":false}', '{}', '<html>unexpected response</html>'])(
    'does not report Tor as connected for %s',
    async (body) => {
      response.body = body;
      await expect(probeTorSocks('socks5h://127.0.0.1:9050')).resolves.toMatchObject({
        ok: false,
        error: expect.any(String),
      });
    },
  );
});
