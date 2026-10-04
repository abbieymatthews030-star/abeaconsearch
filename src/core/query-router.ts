import { isIP } from 'node:net';
import type { DomainLookup } from './lookups/domain.js';
import type { IpLookup } from './lookups/ip.js';
import type { PlateCheck } from './plate/types.js';
import type { SearchEnvelope } from './search/types.js';

export type QueryKind = 'domain' | 'ip' | 'calculation' | 'plate' | 'default';

export interface ClassifiedQuery {
  kind: QueryKind;
  value: string;
}

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/i;
// Whole string is digits/operators/parens only, with at least one operator —
// a bare number like "2024" is deliberately left as a normal search term.
const CALCULATION_RE = /^[-+]?[\d\s().]+(?:[-+*/^%][-+]?[\d\s().]+)+$/;

/**
 * Classify a raw search box query so the universal box can route it to the
 * right lookup. Pure and synchronous — no I/O happens here, only the actual
 * lookups (domain/IP/plate) make network calls.
 */
export function classifyQuery(raw: string): ClassifiedQuery {
  const q = raw.trim();

  const plateMatch = /^plate\s+(\S+)/i.exec(q);
  if (plateMatch) return { kind: 'plate', value: plateMatch[1] as string };

  if (CALCULATION_RE.test(q)) return { kind: 'calculation', value: q };

  if (isIP(q)) return { kind: 'ip', value: q };

  if (DOMAIN_RE.test(q)) return { kind: 'domain', value: q.toLowerCase() };

  return { kind: 'default', value: q };
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
