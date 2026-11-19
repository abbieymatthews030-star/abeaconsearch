import type { PlateClassification, PlateFormat } from './types.js';

export type { PlateClassification } from './types.js';

/**
 * Strip spaces/punctuation and upper-case a registration mark.
 * Common Latin transcriptions of German umlauts are folded so DE plates
 * typed without diacritics still normalise cleanly.
 */
export function normalizePlate(input: string): string {
  return input
    .toUpperCase()
    .replace(/Ä/g, 'AE')
    .replace(/Ö/g, 'OE')
    .replace(/Ü/g, 'UE')
    .replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '');
}

const CURRENT_RE = /^[A-HJ-PR-Y]{2}[0-9]{2}[A-HJ-PR-Z]{3}$/;
const PREFIX_RE = /^[A-HJ-NP-Y][0-9]{1,3}[A-Z]{3}$/;
const SUFFIX_RE = /^[A-Z]{3}[0-9]{1,3}[A-HJ-NP-Y]$/;
const NI_RE = /^[A-Z]{1,3}[0-9]{1,4}$/; // NI marks contain I or Z in the letter group
const DIPLOMATIC_RE = /^[0-9]{3}[A-Z][0-9]{3}$/;
const DATELESS_RES = [
  /^[0-9]{1,4}[A-Z]{1,3}$/, // 1 ABC / 1234 AB
  /^[A-Z]{1,3}[0-9]{1,4}$/, // ABC 1 / AB 1234
  /^[A-Z]{1,2}[0-9]{1,4}[A-Z]?$/,
];

function looksNorthernIreland(plate: string): boolean {
  const letters = plate.replace(/[0-9]/g, '');
  return NI_RE.test(plate) && /[IZ]/.test(letters) && letters.length >= 1 && letters.length <= 3;
}

/**
 * Classify a normalized registration mark into a UK format era and report
 * whether it is structurally valid.
 */
export function classifyPlate(normalized: string): PlateClassification {
  const plate = normalized;

  if (plate.length === 0) {
    return { format: 'unknown', valid: false, reason: 'empty registration' };
  }
  if (plate.length < 2 || plate.length > 8) {
    return { format: 'unknown', valid: false, reason: 'wrong length for a UK plate' };
  }

  if (CURRENT_RE.test(plate)) {
    return { format: 'current', valid: true };
  }
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(plate)) {
    return {
      format: 'current',
      valid: false,
      reason:
        'current-style layout but uses a letter DVLA never issues here ' +
        '(no I or Q anywhere; no Z in the two-letter area code)',
    };
  }
  if (looksNorthernIreland(plate)) {
    return { format: 'northern-ireland', valid: true };
  }
  if (DIPLOMATIC_RE.test(plate)) {
    return { format: 'diplomatic', valid: true };
  }
  if (PREFIX_RE.test(plate)) {
    return { format: 'prefix', valid: true };
  }
  if (SUFFIX_RE.test(plate)) {
    return { format: 'suffix', valid: true };
  }
  if (DATELESS_RES.some((re) => re.test(plate))) {
    return { format: 'dateless', valid: true };
  }

  return { format: 'unknown', valid: false, reason: 'does not match any known UK plate pattern' };
}

/** Insert the conventional display space for a given format. */
export function formatPlate(normalized: string, format: PlateFormat): string {
  const p = normalized;
  switch (format) {
    case 'current':
      return `${p.slice(0, 4)} ${p.slice(4)}`;
    case 'prefix': {
      const m = /^([A-Z][0-9]{1,3})([A-Z]{3})$/.exec(p);
      return m ? `${m[1]} ${m[2]}` : p;
    }
    case 'suffix': {
      const m = /^([A-Z]{3})([0-9]{1,3}[A-Z])$/.exec(p);
      return m ? `${m[1]} ${m[2]}` : p;
    }
    case 'northern-ireland':
    case 'dateless': {
      const m = /^([A-Z]+)([0-9]+)([A-Z]*)$/.exec(p) ?? /^([0-9]+)([A-Z]+)$/.exec(p);
      return m ? m.slice(1).filter(Boolean).join(' ') : p;
    }
    default:
      return p;
  }
}
