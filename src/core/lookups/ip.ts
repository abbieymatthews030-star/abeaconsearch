import { reverse } from 'node:dns/promises';
import { DEFAULT_LOOKUP_TIMEOUT_MS } from '../config.js';
import { entityWithRole, eventDate, fetchRdap, vcardField } from './rdap.js';

export interface IpLookup {
  ip: string;
  reverseDns: string[];
  network?: string;
  networkType?: string;
  networkRange?: string;
  cidrBlocks: string[];
  parentHandle?: string;
  country?: string;
  organization?: string;
  rdapHandle?: string;
  registeredDate?: string;
  updatedDate?: string;
  /** Things that came back empty or unavailable — not errors, just gaps. */
  notices: string[];
}

/** Reverse DNS + RDAP lookup for an IP address. No API key required; never throws. */
export async function lookupIp(ip: string, opts: { timeoutMs?: number } = {}): Promise<IpLookup> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
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
  let networkType: string | undefined;
  let networkRange: string | undefined;
  let parentHandle: string | undefined;
  let registeredDate: string | undefined;
  let updatedDate: string | undefined;
  let cidrBlocks: string[] = [];
  if (rdap) {
    network = rdap.name;
    country = rdap.country;
    rdapHandle = rdap.handle;
    networkType = rdap.type;
    parentHandle = rdap.parentHandle;
    if (rdap.startAddress || rdap.endAddress) {
      networkRange = [rdap.startAddress, rdap.endAddress].filter(Boolean).join(' – ');
    }
    cidrBlocks =
      rdap.cidr0_cidrs?.flatMap((cidr) => {
        const prefix = cidr.v4prefix ?? cidr.v6prefix;
        return prefix && typeof cidr.length === 'number' ? [`${prefix}/${cidr.length}`] : [];
      }) ?? [];
    registeredDate = eventDate(rdap.events, 'registration');
    updatedDate = eventDate(rdap.events, 'last changed');
    const org =
      entityWithRole(rdap.entities, 'registrant') ??
      entityWithRole(rdap.entities, 'administrative');
    organization = org ? vcardField(org.vcardArray, 'fn') : undefined;
  } else {
    notices.push('network data (RDAP) unavailable for this address');
  }

  return {
    ip,
    reverseDns,
    network,
    networkType,
    networkRange,
    cidrBlocks,
    parentHandle,
    country,
    organization,
    rdapHandle,
    registeredDate,
    updatedDate,
    notices,
  };
}
