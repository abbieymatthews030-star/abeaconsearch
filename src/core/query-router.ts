import { isIP } from 'node:net';
import type { DomainLookup } from './lookups/domain.js';
import type { IpLookup } from './lookups/ip.js';
import { isKnownCountryCode } from './plate/countries/index.js';
import type { PlateCheck } from './plate/types.js';
import { CALCULATION_RE, DOMAIN_RE, PLATE_RE } from './query-patterns.js';
import type { SearchEnvelope } from './search/types.js';

/** Aligned with SearchIntent's general bucket for the same search-box idea. */
export type QueryKind = 'domain' | 'ip' | 'calculation' | 'plate' | 'general';

export interface ClassifiedQuery {
  kind: QueryKind;
  value: string;
  /** ISO country code when the query is `plate <CC> <reg>`. */
  country?: string;
}

/**
 * Classify a raw search box query so the universal box can route it to the
 * right lookup. Pure and synchronous — no I/O happens here, only the actual
 * lookups (domain/IP/plate) make network calls.
 */
export function classifyQuery(raw: string): ClassifiedQuery {
  const q = raw.trim();

  // `plate FR AB-123-CD` or `plate AB12CDE` (country optional)
  const plateWithCountry = /^plate\s+([A-Za-z]{2})\s+(\S+)/i.exec(q);
  if (plateWithCountry && isKnownCountryCode(plateWithCountry[1]!)) {
    return {
      kind: 'plate',
      value: plateWithCountry[2]!,
      country: plateWithCountry[1]!.toUpperCase(),
    };
  }

  const plateMatch = /^plate\s+(\S+)/i.exec(q);
  if (plateMatch || PLATE_RE.test(q)) {
    const value = plateMatch?.[1] ?? q.replace(/^plate\s+/i, '').trim();
    if (value) return { kind: 'plate', value };
  }

  if (CALCULATION_RE.test(q)) return { kind: 'calculation', value: q };

  if (isIP(q)) return { kind: 'ip', value: q };

  if (DOMAIN_RE.test(q)) return { kind: 'domain', value: q.toLowerCase() };

  return { kind: 'general', value: q };
}

export interface DomainPrimary {
  kind: 'domain';
  domain: string;
  enabled: boolean;
  data?: DomainLookup;
}

export interface IpPrimary {
  kind: 'ip';
  ip: string;
  enabled: boolean;
  data?: IpLookup;
}

export interface CalculationPrimary {
  kind: 'calculation';
  expression: string;
  result?: number;
  error?: string;
}

export interface PlatePrimary {
  kind: 'plate';
  data: PlateCheck;
}

export type PrimaryResult = DomainPrimary | IpPrimary | CalculationPrimary | PlatePrimary;

export interface UniversalQueryResponse extends SearchEnvelope {
  kind: QueryKind;
  primary: PrimaryResult | null;
}
