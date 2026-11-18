import { COUNTRY_ALIASES, COUNTRY_BY_CODE, COUNTRY_DEFINITIONS } from './catalog.js';
import type { CountryDefinition, CountryInfo } from './types.js';

export type { CountryCode, CountryDefinition, CountryInfo, CountryDecodeResult } from './types.js';
export { COUNTRY_DEFINITIONS, COUNTRY_BY_CODE } from './catalog.js';

export const DEFAULT_COUNTRY_CODE = 'GB';

/** Normalise a user-supplied country code or alias to an ISO alpha-2 code. */
export function normalizeCountryCode(input: string | undefined | null): string | null {
  if (!input) return null;
  const raw = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!raw) return null;
  if (COUNTRY_BY_CODE[raw]) return raw;
  const aliased = COUNTRY_ALIASES[raw];
  if (aliased && COUNTRY_BY_CODE[aliased]) return aliased;
  return null;
}

/**
 * Resolve a country definition. Unknown codes throw so API validation can
 * surface a clear 400; callers that want a soft default should pass nothing.
 */
export function resolveCountry(code?: string | null): CountryDefinition {
  if (!code || !code.trim()) return COUNTRY_BY_CODE[DEFAULT_COUNTRY_CODE]!;
  const normalized = normalizeCountryCode(code);
  if (!normalized) {
    throw new Error(
      `Unknown plate country "${code}". Use an ISO 3166-1 alpha-2 code such as GB, US, DE, or AU.`,
    );
  }
  return COUNTRY_BY_CODE[normalized]!;
}

/** Public list for the UI / API (no classify/decode functions). */
export function listCountries(): CountryInfo[] {
  return COUNTRY_DEFINITIONS.map(
    ({
      code,
      name,
      plateLabel,
      example,
      placeholder,
      maxInputLength,
      authority,
      liveVehicleData,
      liveInspectionHistory,
      summary,
    }) => ({
      code,
      name,
      plateLabel,
      example,
      placeholder,
      maxInputLength,
      authority,
      liveVehicleData,
      liveInspectionHistory,
      summary,
    }),
  );
}

export function isKnownCountryCode(code: string): boolean {
  return normalizeCountryCode(code) !== null;
}
