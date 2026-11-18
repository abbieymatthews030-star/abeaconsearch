import http from 'node:http';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface TorFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max response body bytes to buffer (default 2 MiB). */
  maxBytes?: number;
  /** socks5h URL so Tor resolves .onion names (required for onion hosts). */
  socksUrl: string;
}

export interface TorFetchResult {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
  finalUrl: string;
}

/**
 * HTTP(S) fetch through a Tor SOCKS5h proxy. Uses Node's http/https stack with
 * socks-proxy-agent so DNS for .onion names is resolved inside Tor, not locally.
 */
export async function torFetch(url: string, options: TorFetchOptions): Promise<TorFetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const agent = new SocksProxyAgent(options.socksUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise<TorFetchResult>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = lib.request(
      parsed,
      {
        method: options.method ?? 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'user-agent': 'BeaconSearchTor/1.0',
          ...options.headers,
        },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            fail(new Error(`response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const item of value) headers.append(key, item);
            } else {
              headers.set(key, value);
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers,
            body: Buffer.concat(chunks),
            finalUrl: parsed.toString(),
          });
        });
        res.on('error', fail);
      },
    );

    const onAbort = () => {
      req.destroy();
      fail(new Error('aborted'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('timeout', () => {
      req.destroy();
      fail(new Error(`Tor request timed out after ${timeoutMs}ms`));
    });
    req.on('error', fail);

    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Quick SOCKS reachability probe — fetches Tor Project's check endpoint over Tor. */
export async function probeTorSocks(
  socksUrl: string,
  timeoutMs = 12_000,
): Promise<{ ok: true; exitIp?: string } | { ok: false; error: string }> {
  try {
    const result = await torFetch('https://check.torproject.org/api/ip', {
      socksUrl,
      timeoutMs,
      maxBytes: 4096,
      headers: { accept: 'application/json' },
    });
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, error: `Tor check returned HTTP ${result.status}` };
    }
    const text = result.body.toString('utf8');
    try {
      const json = JSON.parse(text) as { IsTor?: boolean; IP?: string };
      if (json.IsTor === false) {
        return { ok: false, error: 'SOCKS proxy reachable but traffic is not exiting via Tor' };
      }
      return { ok: true, exitIp: typeof json.IP === 'string' ? json.IP : undefined };
    } catch {
      // HTML fallback — presence of the page through the SOCKS path is enough.
      if (/Congratulations|You are using Tor/i.test(text)) return { ok: true };
      return { ok: true };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
