import type { TrustTier } from './types.js';

export interface TrustVerdict {
  tier: TrustTier;
  reason: string;
}

/**
 * Domains (or parent domains) whose content is treated as `established`: major
 * encyclopedias, wire services, standards bodies and peer-reviewed publishers.
 * Matched on a suffix boundary, so `bbc.co.uk` also covers `www.bbc.co.uk`.
 */
const ESTABLISHED = [
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'britannica.com',
  'reuters.com',
  'apnews.com',
  'bbc.co.uk',
  'bbc.com',
  'nature.com',
  'science.org',
  'sciencedirect.com',
  'springer.com',
  'arxiv.org',
  'acm.org',
  'ieee.org',
  'nih.gov',
  'ncbi.nlm.nih.gov',
  'europepmc.org',
  'ebi.ac.uk',
  'openalex.org',
  'crossref.org',
  'doi.org',
  'doaj.org',
  'archive.org',
  'openlibrary.org',
  'gutenberg.org',
  'mayoclinic.org',
  'nasa.gov',
  'noaa.gov',
  'ecma-international.org',
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
  'iso.org',
  'python.org',
  'developer.mozilla.org',
];

/** Suffixes that mark an official government / academic / IGO domain. */
const OFFICIAL_SUFFIXES = ['.gov', '.mil', '.int', '.edu'];
const OFFICIAL_COMPOUND = [
  '.gov.uk',
  '.gov.au',
  '.gov.ca',
  '.ac.uk',
  '.edu.au',
  '.nhs.uk',
  '.police.uk',
  '.parliament.uk',
];
const OFFICIAL_EXACT = ['europa.eu', 'un.org', 'who.int', 'imf.org', 'worldbank.org', 'oecd.org'];

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** True when `host` equals `suffix` or ends with `.suffix`. */
function hostMatches(host: string, suffix: string): boolean {
  const s = suffix.startsWith('.') ? suffix.slice(1) : suffix;
  return host === s || host.endsWith(`.${s}`);
}

/**
 * Classify how trustworthy a source is from its URL. `extraOfficial` is an
 * operator-provided allowlist (`BEACON_ANSWER_TRUSTED_DOMAINS`) promoted to
 * `official`. A source with no resolvable URL is always `unverified`.
 */
export function classifyTrust(
  url: string | undefined,
  origin: 'index' | 'web',
  extraOfficial: string[] = [],
): TrustVerdict {
  if (!url) {
    return { tier: 'unverified', reason: 'no source URL — not backed by a retrievable page' };
  }
  const host = hostname(url);
  if (!host) {
    return { tier: 'unverified', reason: 'source URL could not be parsed' };
  }

  if (extraOfficial.some((d) => hostMatches(host, d))) {
    return { tier: 'official', reason: `${host} — configured trusted domain` };
  }
  if (OFFICIAL_EXACT.includes(host) || OFFICIAL_COMPOUND.some((s) => hostMatches(host, s))) {
    return { tier: 'official', reason: `${host} — official government / intergovernmental domain` };
  }
  if (OFFICIAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return {
      tier: 'official',
      reason: `${host} — official ${host.slice(host.lastIndexOf('.'))} domain`,
    };
  }
  if (ESTABLISHED.some((d) => hostMatches(host, d))) {
    return { tier: 'established', reason: `${host} — established reference / publisher` };
  }
  return {
    tier: 'community',
    reason:
      origin === 'index'
        ? `${host} — indexed page, trust not independently established`
        : `${host} — live web page, trust not independently established`,
  };
}

/** Numeric weight for ranking; higher is more trustworthy. */
export function trustWeight(tier: TrustTier): number {
  switch (tier) {
    case 'official':
      return 1;
    case 'established':
      return 0.8;
    case 'community':
      return 0.45;
    case 'unverified':
      return 0.15;
  }
}
