import { reverse } from 'node:dns/promises';
import { entityWithRole, fetchRdap, vcardField } from './rdap.js';

export interface IpLookup {
  ip: string;
  reverseDns: string[];
  network?: string;
  country?: string;
  organization?: string;
  rdapHandle?: string;
  /** Things that came back empty or unavailable — not errors, just gaps. */
  notices: string[];
}

/** Reverse DNS + RDAP lookup for an IP address. No API key required; never throws. */
export async function lookupIp(
  ip: string,
  opts: { timeoutMs?: number } = {},
): Promise<IpLookup> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const notices: string[] = [];

  const reverseDns = await reverse(ip).catch(() => {
    notices.push('no reverse DNS (PTR) record');
    return [] as string[];
  });

  const rdap = await fetchRdap(`ip/${encodeURIComponent(ip)}`, timeoutMs);
  let network: string | undefined;
  let country: string | undefined;
  let organization: string | undefined;
  let rdapHandle: string | undefined;
  if (rdap) {
    network = rdap.name;
    country = rdap.country;
    rdapHandle = rdap.handle;
    const org = entityWithRole(rdap.entities, 'registrant') ?? entityWithRole(rdap.entities, 'administrative');
    organization = org ? vcardField(org.vcardArray, 'fn') : undefined;
  } else {
    notices.push('network data (RDAP) unavailable for this address');
  }

  return { ip, reverseDns, network, country, organization, rdapHandle, notices };
}
