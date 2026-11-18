/** v2 (legacy, 16) and v3 (56) onion hostnames — base32 alphabet without padding. */
const ONION_HOST =
  /^(?:[a-z2-7]{56}|[a-z2-7]{16})\.onion$/i;

export function isOnionHostname(hostname: string): boolean {
  const bare = hostname.replace(/\.$/, '').toLowerCase();
  return ONION_HOST.test(bare);
}

/**
 * Accept only http(s) URLs whose host is a real .onion name. Rejects clearnet
 * hosts so the Tor browse proxy cannot be used as an open relay / SSRF trampoline.
 */
export function parseOnionUrl(raw: string): URL | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'only http and https onion URLs are allowed' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'credentials in onion URLs are not allowed' };
  }
  if (!isOnionHostname(parsed.hostname)) {
    return { error: 'host must be a .onion address' };
  }
  return parsed;
}

export function onionBrowsePath(onionUrl: string): string {
  return `/api/tor/browse?url=${encodeURIComponent(onionUrl)}`;
}
