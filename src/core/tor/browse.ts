import * as cheerio from 'cheerio';
import { isOnionHostname, onionBrowsePath, parseOnionUrl } from './onion.js';
import { torFetch } from './socks-fetch.js';

export interface BrowseOptions {
  socksUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

export type BrowseResult =
  | { kind: 'html'; status: number; html: string; finalUrl: string }
  | { kind: 'raw'; status: number; contentType: string; body: Buffer; finalUrl: string }
  | { kind: 'error'; status: number; message: string };

function rewriteCssUrls(css: string, baseUrl: string): string {
  return css.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi,
    (original, _quote: string | undefined, quoted: string | undefined, unquoted: string) => {
      const value = (quoted ?? unquoted ?? '').trim();
      if (!value || value.startsWith('data:') || value.startsWith('#')) return original;
      try {
        const absolute = new URL(value, baseUrl);
        return isOnionHostname(absolute.hostname)
          ? `url("${onionBrowsePath(absolute.toString())}")`
          : original;
      } catch {
        return original;
      }
    },
  );
}

function rewriteSrcset(srcset: string, baseUrl: string): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const match = /^\s*(\S+)(\s+.*)?$/.exec(candidate);
      if (!match?.[1]) return candidate;
      try {
        const absolute = new URL(match[1], baseUrl);
        if (!isOnionHostname(absolute.hostname)) return candidate;
        return `${onionBrowsePath(absolute.toString())}${match[2] ?? ''}`;
      } catch {
        return candidate;
      }
    })
    .join(',');
}

function rewriteOnionLinks(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);
  $('base').remove();
  const attrs = ['href', 'src', 'action', 'poster', 'data', 'formaction'] as const;
  for (const attr of attrs) {
    $(`[${attr}]`).each((_, el) => {
      const value = $(el).attr(attr);
      if (
        !value ||
        value.startsWith('#') ||
        value.startsWith('mailto:') ||
        value.startsWith('javascript:') ||
        value.startsWith('data:')
      ) {
        return;
      }
      let absolute: URL;
      try {
        absolute = new URL(value, baseUrl);
      } catch {
        return;
      }
      if (!isOnionHostname(absolute.hostname)) return;
      $(el).attr(attr, onionBrowsePath(absolute.toString()));
    });
  }

  $('[srcset]').each((_, el) => {
    const value = $(el).attr('srcset');
    if (value) $(el).attr('srcset', rewriteSrcset(value, baseUrl));
  });
  $('[style]').each((_, el) => {
    const value = $(el).attr('style');
    if (value) $(el).attr('style', rewriteCssUrls(value, baseUrl));
  });
  $('style').each((_, el) => {
    $(el).text(rewriteCssUrls($(el).text(), baseUrl));
  });

  // Strip meta refresh to clearnet; keep onion refreshes rewritten.
  $('meta[http-equiv="refresh"]').each((_, el) => {
    const content = $(el).attr('content') ?? '';
    const match = /url=(.+)$/i.exec(content);
    if (!match?.[1]) return;
    try {
      const target = new URL(match[1].trim().replace(/^['"]|['"]$/g, ''), baseUrl);
      if (isOnionHostname(target.hostname)) {
        $(el).attr('content', content.replace(match[1], onionBrowsePath(target.toString())));
      } else {
        $(el).remove();
      }
    } catch {
      $(el).remove();
    }
  });

  const safeUrl = baseUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const banner = `
<div id="beacon-tor-banner" style="position:sticky;top:0;z-index:99999;background:#4b1d6b;color:#fff;padding:0.65rem 1rem;font:13px/1.4 ui-monospace,Menlo,monospace;border-bottom:2px solid #000">
  <strong style="letter-spacing:0.12em">ABEACON TOR</strong>
  &nbsp;·&nbsp; viewing via Beacon SOCKS
  &nbsp;·&nbsp; <a href="/" style="color:#fff">back to search</a>
  &nbsp;·&nbsp; <span style="opacity:0.85">${safeUrl}</span>
</div>`;
  // Prefer injecting after <body> so the page still paints if markup is odd.
  if ($('body').length) {
    $('body').prepend(banner);
  } else {
    $.root().prepend(banner);
  }
  return $.html();
}

/**
 * Fetch an onion URL through Tor and return either rewritten HTML (so further
 * onion clicks stay inside Beacon) or the raw bytes for non-HTML responses.
 */
export async function browseOnion(rawUrl: string, options: BrowseOptions): Promise<BrowseResult> {
  const parsed = parseOnionUrl(rawUrl);
  if ('error' in parsed) {
    return { kind: 'error', status: 400, message: parsed.error };
  }

  try {
    const result = await torFetch(parsed.toString(), {
      socksUrl: options.socksUrl,
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
      maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
      validateRedirect: (target) => isOnionHostname(target.hostname),
    });

    const contentType = result.headers.get('content-type') ?? 'application/octet-stream';
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      const html = rewriteOnionLinks(result.body.toString('utf8'), result.finalUrl);
      return { kind: 'html', status: result.status || 200, html, finalUrl: result.finalUrl };
    }
    if (/text\/css/i.test(contentType)) {
      return {
        kind: 'raw',
        status: result.status || 200,
        contentType,
        body: Buffer.from(rewriteCssUrls(result.body.toString('utf8'), result.finalUrl)),
        finalUrl: result.finalUrl,
      };
    }
    return {
      kind: 'raw',
      status: result.status || 200,
      contentType,
      body: result.body,
      finalUrl: result.finalUrl,
    };
  } catch (error) {
    return {
      kind: 'error',
      status: 502,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
