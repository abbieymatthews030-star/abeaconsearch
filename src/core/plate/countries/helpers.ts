import type { PlateClassification } from '../types.js';

/** Match the first regex that fits; return its format id. */
export function matchFormats(
  normalized: string,
  patterns: Array<{ format: string; re: RegExp; invalidReason?: string }>,
): PlateClassification | null {
  for (const pattern of patterns) {
    if (pattern.re.test(normalized)) {
      if (pattern.invalidReason) {
        return { format: pattern.format, valid: false, reason: pattern.invalidReason };
      }
      return { format: pattern.format, valid: true };
    }
  }
  return null;
}

/** Insert spaces/dashes by slicing a normalized plate at the given cut points. */
export function spaced(normalized: string, cuts: number[], sep = ' '): string {
  if (cuts.length === 0) return normalized;
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(normalized.slice(start, cut));
    start = cut;
  }
  parts.push(normalized.slice(start));
  return parts.filter(Boolean).join(sep);
}

export function failUnknown(countryName: string, hint?: string): PlateClassification {
  return {
    format: 'unknown',
    valid: false,
    reason: hint ?? `does not match a recognised ${countryName} plate pattern`,
  };
}

export function yearsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / (365.25 * 864e5)) * 10) / 10);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
