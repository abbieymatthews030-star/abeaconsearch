import { resolve4, resolve6, resolveMx, resolveNs } from 'node:dns/promises';
import { entityWithRole, eventDate, fetchRdap, vcardField } from './rdap.js';

export interface DomainLookup {
  domain: string;
  addresses: string[];
  ipv6Addresses: string[];
  nameservers: string[];
  mailExchanges: string[];
  registrar?: string;
  createdDate?: string;
  updatedDate?: string;
  expiresDate?: string;
  /** Things that came back empty or unavailable — not errors, just gaps. */
  notices: string[];
}

/** DNS + RDAP lookup for a domain name. No API key required; never throws. */
export async function lookupDomain(
  domain: string,
  opts: { timeoutMs?: number } = {},
): Promise<DomainLookup> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const notices: string[] = [];

  const [addresses, ipv6Addresses, nameservers, mxRecords] = await Promise.all([
    resolve4(domain).catch(() => {
      notices.push('no A record');
      return [] as string[];
    }),
    resolve6(domain).catch(() => [] as string[]),
    resolveNs(domain).catch(() => {
      notices.push('no NS record');
      return [] as string[];
    }),
    resolveMx(domain).catch(() => []),
  ]);

  // RFC 7505 "null MX" (a lone root '.' target) decodes to an empty
  // exchange — that's a real "this domain accepts no mail" record, not a gap.
  const nullMx = mxRecords.length > 0 && mxRecords.every((mx) => !mx.exchange);
  if (nullMx) notices.push('domain publishes a null MX (accepts no mail)');

  const rdap = await fetchRdap(`domain/${encodeURIComponent(domain)}`, timeoutMs);
  let registrar: string | undefined;
  let createdDate: string | undefined;
  let updatedDate: string | undefined;
  let expiresDate: string | undefined;
  if (rdap) {
    const registrarEntity = entityWithRole(rdap.entities, 'registrar');
    registrar = registrarEntity ? vcardField(registrarEntity.vcardArray, 'fn') : undefined;
    createdDate = eventDate(rdap.events, 'registration');
    updatedDate = eventDate(rdap.events, 'last changed');
    expiresDate = eventDate(rdap.events, 'expiration');
  } else {
    notices.push('registration data (RDAP) unavailable for this domain');
  }

  return {
    domain,
    addresses,
    ipv6Addresses,
    nameservers: [...nameservers].sort((a, b) => a.localeCompare(b)),
    mailExchanges: mxRecords
      .map((mx) => mx.exchange)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    registrar,
    createdDate,
    updatedDate,
    expiresDate,
    notices,
  };
}
