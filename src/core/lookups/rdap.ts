import { fetchWithTimeout } from '../http.js';

/**
 * Minimal shape of the fields we read from an RDAP response. RDAP
 * (RFC 9083) is the modern, free, no-key replacement for WHOIS; `rdap.org`
 * is the IANA-bootstrapped public redirector, so one host covers every TLD
 * and RIR without per-registry configuration.
 */
export interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

export interface RdapResponse {
  name?: string;
  handle?: string;
  country?: string;
  entities?: RdapEntity[];
  events?: Array<{ eventAction?: string; eventDate?: string }>;
}

// Cloudflare sits in front of rdap.org and 403s requests with no/blank
// User-Agent (Node's fetch sends one Cloudflare treats as a bot) — a normal
// UA string is enough to pass.
const RDAP_USER_AGENT = 'BeaconSearchBot/1.0 (+https://github.com/abbieymatthews030-star/abeaconsearch)';

/** Fetch an RDAP object (e.g. `domain/example.com`, `ip/203.0.113.1`). Never throws. */
export async function fetchRdap(path: string, timeoutMs: number): Promise<RdapResponse | null> {
  try {
    const response = await fetchWithTimeout(`https://rdap.org/${path}`, {
      timeoutMs,
      headers: { accept: 'application/rdap+json', 'user-agent': RDAP_USER_AGENT },
    });
    if (!response.ok) return null;
    return (await response.json()) as RdapResponse;
  } catch {
    return null;
  }
}

export function entityWithRole(
  entities: RdapEntity[] | undefined,
  role: string,
): RdapEntity | undefined {
  return entities?.find((entity) => entity.roles?.includes(role));
}

/** Pull a named field (e.g. `fn` for formatted name) out of a jCard vCardArray. */
export function vcardField(vcardArray: unknown, field: string): string | undefined {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return undefined;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (Array.isArray(entry) && entry[0] === field) {
      const value = entry[entry.length - 1];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

export function eventDate(
  events: RdapResponse['events'],
  action: string,
): string | undefined {
  return events?.find((event) => event.eventAction === action)?.eventDate;
}
