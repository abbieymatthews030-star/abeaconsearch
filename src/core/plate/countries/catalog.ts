import { decodeAge } from '../age.js';
import { classifyPlate as classifyGbPlate, formatPlate as formatGbPlate } from '../format.js';
import { lookupMemoryTag } from '../regions.js';
import type { PlateAge, PlateFormat, PlateRegion } from '../types.js';
import { failUnknown, isoDate, matchFormats, spaced, yearsBetween } from './helpers.js';
import type { CountryDefinition, CountryDecodeResult } from './types.js';

/** Irish county / city codes used on 2013–present plates (YY-CC-######). */
const IE_COUNTY_CODES: Record<string, string> = {
  C: 'Cork',
  CE: 'Clare',
  CN: 'Cavan',
  CW: 'Carlow',
  D: 'Dublin',
  DL: 'Donegal',
  G: 'Galway',
  KE: 'Kildare',
  KK: 'Kilkenny',
  KY: 'Kerry',
  L: 'Limerick',
  LD: 'Longford',
  LH: 'Louth',
  LK: 'Limerick',
  LM: 'Leitrim',
  LS: 'Laois',
  MH: 'Meath',
  MN: 'Monaghan',
  MO: 'Mayo',
  OY: 'Offaly',
  RN: 'Roscommon',
  SO: 'Sligo',
  T: 'Tipperary',
  TA: 'Tipperary',
  TS: 'Tipperary South (legacy)',
  W: 'Waterford',
  WD: 'Waterford',
  WH: 'Westmeath',
  WX: 'Wexford',
  WW: 'Wicklow',
};

/** Australian state / territory codes sometimes embedded or used as selectors. */
const AU_STATE_HINTS: Record<string, string> = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  SA: 'South Australia',
  WA: 'Western Australia',
  TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
  NT: 'Northern Territory',
};

function emptyDecode(): CountryDecodeResult {
  return { age: null, region: null };
}

function regionOf(code: string, region: string, office: string, subdivision?: string): PlateRegion {
  return {
    memoryTag: code,
    region,
    office,
    country: subdivision ?? region,
  };
}

function ageFromYear(
  identifier: string,
  year: number,
  reference: Date,
  description: string,
): PlateAge {
  const registeredFrom = new Date(Date.UTC(year, 0, 1));
  return {
    identifier,
    registeredFrom: isoDate(registeredFrom),
    registeredTo: isoDate(new Date(Date.UTC(year, 11, 31))),
    approxYear: year,
    ageYears: yearsBetween(registeredFrom, reference),
    description,
  };
}

const gb: CountryDefinition = {
  code: 'GB',
  name: 'United Kingdom',
  plateLabel: 'number plate',
  example: 'AB12 CDE',
  placeholder: 'AB12 CDE',
  maxInputLength: 16,
  authority: 'DVLA / DVA',
  liveVehicleData: true,
  liveInspectionHistory: true,
  summary: 'Format, age, region + optional DVLA tax/MOT and DVSA MOT history',
  classify: (n) => classifyGbPlate(n),
  formatDisplay: (n, format) => formatGbPlate(n, format as PlateFormat),
  decode: (n, format, reference) => {
    const age = decodeAge(n, format as PlateFormat, reference);
    let region: PlateRegion | null = null;
    if (format === 'current') {
      region = lookupMemoryTag(n.slice(0, 2));
    } else if (format === 'northern-ireland') {
      region = regionOf(
        n.replace(/[0-9]/g, ''),
        'Northern Ireland',
        'Northern Ireland (dateless series)',
        'Northern Ireland',
      );
    }
    return { age, region };
  },
};

const ie: CountryDefinition = {
  code: 'IE',
  name: 'Ireland',
  plateLabel: 'registration plate',
  example: '241-D-12345',
  placeholder: '241-D-12345',
  maxInputLength: 14,
  authority: 'RSA / local authority',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline format, year and county decode (2013–present and older styles)',
  classify: (n) => {
    // 2013–present: YY + period (1=Jan–Jun, 2=Jul–Dec) + county + serial
    // e.g. 241-D-12345 → 2024, first half-year, Dublin
    const current = /^(\d{2})([12])([A-Z]{1,2})(\d{1,6})$/.exec(n);
    if (current) {
      const year = Number(current[1]);
      const county = current[3]!;
      if (year < 13) {
        return {
          format: 'ie-current',
          valid: false,
          reason: 'current-style Irish plates with a period digit started in 2013',
        };
      }
      if (!IE_COUNTY_CODES[county]) {
        return {
          format: 'ie-current',
          valid: false,
          reason: `"${county}" is not a recognised Irish county/city code`,
        };
      }
      return { format: 'ie-current', valid: true };
    }
    // 1987–2012: YY + county + serial (no period digit)
    const legacy = /^(\d{2})([A-Z]{1,2})(\d{1,6})$/.exec(n);
    if (legacy) {
      const year = Number(legacy[1]);
      const county = legacy[2]!;
      if (!IE_COUNTY_CODES[county]) {
        return {
          format: 'ie-1987',
          valid: false,
          reason: `"${county}" is not a recognised Irish county/city code`,
        };
      }
      if (year <= 12 || year >= 87) return { format: 'ie-1987', valid: true };
      return {
        format: 'ie-1987',
        valid: false,
        reason: `year code "${legacy[1]}" is outside the Irish 1987–2012 series`,
      };
    }
    const older = matchFormats(n, [
      { format: 'ie-zz', re: /^ZZ\d{1,5}$/ },
      { format: 'ie-legacy', re: /^[A-Z]{1,3}\d{1,4}$/ },
    ]);
    return older ?? failUnknown('Irish');
  },
  formatDisplay: (n, format) => {
    if (format === 'ie-current') {
      const m = /^(\d{2})([12])([A-Z]{1,2})(\d{1,6})$/.exec(n);
      return m ? `${m[1]}${m[2]}-${m[3]}-${m[4]}` : n;
    }
    if (format === 'ie-1987') {
      const m = /^(\d{2})([A-Z]{1,2})(\d{1,6})$/.exec(n);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : n;
    }
    return n;
  },
  decode: (n, format, reference) => {
    if (format === 'ie-current') {
      const m = /^(\d{2})([12])([A-Z]{1,2})(\d{1,6})$/.exec(n);
      if (!m) return emptyDecode();
      const year = 2000 + Number(m[1]);
      const period = m[2] === '1' ? 'January–June' : 'July–December';
      const county = m[3]!;
      const countyName = IE_COUNTY_CODES[county] ?? county;
      return {
        age: ageFromYear(m[1]!, year, reference, `registered ${period} ${year}`),
        region: regionOf(county, countyName, countyName, countyName),
      };
    }
    if (format === 'ie-1987') {
      const m = /^(\d{2})([A-Z]{1,2})(\d{1,6})$/.exec(n);
      if (!m) return emptyDecode();
      const yearNum = Number(m[1]);
      const year = yearNum >= 87 ? 1900 + yearNum : 2000 + yearNum;
      const county = m[2]!;
      const countyName = IE_COUNTY_CODES[county] ?? county;
      return {
        age: ageFromYear(m[1]!, year, reference, `registered in ${year}`),
        region: regionOf(county, countyName, countyName, countyName),
      };
    }
    return emptyDecode();
  },
};

const fr: CountryDefinition = {
  code: 'FR',
  name: 'France',
  plateLabel: 'plaque d’immatriculation',
  example: 'AB-123-CD',
  placeholder: 'AB-123-CD',
  maxInputLength: 12,
  authority: 'ANTS / SIV',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline SIV (2009–) and FNI format validation',
  classify: (n) => {
    // SIV 2009–: AA999AA — letters exclude I, O, U
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(n)) {
      if (/[IOU]/.test(n)) {
        return {
          format: 'fr-siv',
          valid: false,
          reason: 'SIV plates never use the letters I, O or U',
        };
      }
      return { format: 'fr-siv', valid: true };
    }
    // FNI (pre-2009): 1234AB75 style — up to 4 digits + up to 3 letters + département
    const fni = matchFormats(n, [{ format: 'fr-fni', re: /^\d{1,4}[A-Z]{1,3}\d{2,3}$/ }]);
    return fni ?? failUnknown('French');
  },
  formatDisplay: (n, format) => {
    if (format === 'fr-siv') return spaced(n, [2, 5], '-');
    if (format === 'fr-fni') {
      const m = /^(\d{1,4})([A-Z]{1,3})(\d{2,3})$/.exec(n);
      return m ? `${m[1]} ${m[2]} ${m[3]}` : n;
    }
    return n;
  },
  decode: (n, format) => {
    if (format === 'fr-fni') {
      const dept = n.slice(-2);
      return {
        age: null,
        region: regionOf(dept, `Département ${dept}`, `Préfecture ${dept}`, dept),
      };
    }
    return {
      age: null,
      region: null,
      notices: [
        'French SIV plates (2009–) are national — they do not encode a département or age.',
      ],
    };
  },
};

/**
 * Common German distinguishing signs (Unterscheidungszeichen). Matched
 * longest-first so e.g. BAB1234 → B + AB + 1234 (Berlin), not BA + B + 1234.
 * Umlaut codes are stored both stripped and AE/OE/UE-folded to match normalizePlate.
 */
const DE_CITY_CODES = [
  ...new Set(
    [
      'A',
      'AA',
      'AB',
      'AC',
      'AE',
      'AH',
      'AK',
      'AM',
      'AN',
      'AÖ',
      'AP',
      'AS',
      'AUR',
      'AW',
      'AZ',
      'B',
      'BA',
      'BB',
      'BC',
      'BE',
      'BF',
      'BG',
      'BI',
      'BIT',
      'BK',
      'BL',
      'BM',
      'BN',
      'BO',
      'BOR',
      'BOT',
      'BRA',
      'BRB',
      'BS',
      'BT',
      'BÜS',
      'BZ',
      'C',
      'CB',
      'CE',
      'CO',
      'COC',
      'COE',
      'CUX',
      'D',
      'DA',
      'DAH',
      'DEG',
      'DEL',
      'DGF',
      'DI',
      'DIN',
      'DL',
      'DM',
      'DN',
      'DO',
      'DON',
      'DU',
      'DÜW',
      'E',
      'EA',
      'EB',
      'EBE',
      'ED',
      'EF',
      'EI',
      'EIC',
      'EL',
      'EM',
      'EMD',
      'EMS',
      'EN',
      'ER',
      'ERB',
      'ERH',
      'ES',
      'ESW',
      'EU',
      'F',
      'FB',
      'FD',
      'FF',
      'FG',
      'FL',
      'FN',
      'FO',
      'FR',
      'FRG',
      'FS',
      'FT',
      'FÜ',
      'G',
      'GAP',
      'GC',
      'GE',
      'GER',
      'GF',
      'GG',
      'GI',
      'GL',
      'GM',
      'GÖ',
      'GP',
      'GR',
      'GS',
      'GT',
      'GÜ',
      'GZ',
      'H',
      'HA',
      'HAL',
      'HAM',
      'HAS',
      'HB',
      'HBN',
      'HD',
      'HDL',
      'HE',
      'HF',
      'HG',
      'HH',
      'HI',
      'HK',
      'HL',
      'HM',
      'HN',
      'HO',
      'HOL',
      'HP',
      'HR',
      'HS',
      'HSK',
      'HU',
      'HÜN',
      'HX',
      'HY',
      'IGB',
      'IK',
      'IL',
      'IN',
      'IZ',
      'J',
      'JL',
      'JÜL',
      'K',
      'KA',
      'KB',
      'KC',
      'KE',
      'KEH',
      'KF',
      'KG',
      'KH',
      'KI',
      'KIB',
      'KL',
      'KM',
      'KN',
      'KO',
      'KR',
      'KS',
      'KT',
      'KU',
      'KÜN',
      'KW',
      'KYF',
      'L',
      'LA',
      'LAU',
      'LB',
      'LD',
      'LDK',
      'LDS',
      'LEO',
      'LEV',
      'LG',
      'LI',
      'LIF',
      'LIP',
      'LL',
      'LM',
      'LÖ',
      'LOS',
      'LP',
      'LR',
      'LRO',
      'LU',
      'LÜN',
      'M',
      'MA',
      'MB',
      'MD',
      'ME',
      'MEI',
      'MG',
      'MH',
      'MI',
      'MK',
      'MM',
      'MN',
      'MO',
      'MS',
      'MSP',
      'MSR',
      'MTK',
      'MÜ',
      'MÜL',
      'MÜR',
      'MW',
      'MZ',
      'MZG',
      'N',
      'NB',
      'ND',
      'NDH',
      'NE',
      'NES',
      'NF',
      'NI',
      'NK',
      'NM',
      'NMS',
      'NOH',
      'NOM',
      'NP',
      'NR',
      'NU',
      'NW',
      'OA',
      'OAL',
      'OB',
      'OD',
      'OE',
      'OF',
      'OG',
      'OH',
      'OHA',
      'OHV',
      'OHZ',
      'OL',
      'OPR',
      'OS',
      'OSL',
      'OVP',
      'P',
      'PA',
      'PAF',
      'PAN',
      'PB',
      'PE',
      'PF',
      'PI',
      'PIR',
      'PLÖ',
      'PM',
      'PR',
      'PS',
      'PW',
      'R',
      'RA',
      'RD',
      'RE',
      'REG',
      'RG',
      'RH',
      'RI',
      'RID',
      'RO',
      'ROW',
      'RP',
      'RS',
      'RÜD',
      'RV',
      'RW',
      'RZ',
      'S',
      'SAD',
      'SAL',
      'SB',
      'SC',
      'SDL',
      'SE',
      'SG',
      'SHA',
      'SHG',
      'SHK',
      'SHL',
      'SI',
      'SIG',
      'SIM',
      'SK',
      'SL',
      'SLF',
      'SLK',
      'SLN',
      'SLS',
      'SM',
      'SN',
      'SO',
      'SÖM',
      'SON',
      'SP',
      'SPB',
      'SR',
      'ST',
      'STA',
      'STD',
      'STL',
      'SU',
      'SÜW',
      'SW',
      'SZ',
      'SZB',
      'TBB',
      'TDO',
      'TE',
      'TIR',
      'TÖL',
      'TP',
      'TR',
      'TS',
      'TÜ',
      'TUT',
      'UE',
      'UL',
      'UM',
      'UN',
      'V',
      'VB',
      'VEC',
      'VER',
      'VG',
      'VIE',
      'VK',
      'VR',
      'VS',
      'W',
      'WAF',
      'WAK',
      'WAN',
      'WAT',
      'WB',
      'WE',
      'WEN',
      'WES',
      'WF',
      'WHV',
      'WI',
      'WIL',
      'WK',
      'WL',
      'WM',
      'WN',
      'WND',
      'WO',
      'WOB',
      'WST',
      'WT',
      'WÜ',
      'WUG',
      'WUN',
      'WW',
      'WZ',
      'Z',
      'ZW',
    ].flatMap((c) => {
      const upper = c.toUpperCase();
      const folded = upper.replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE');
      const stripped = upper.normalize('NFD').replace(/\p{M}/gu, '');
      return [folded, stripped].filter((x) => /^[A-Z]+$/.test(x));
    }),
  ),
].sort((a, b) => b.length - a.length || a.localeCompare(b));

function parseGermanPlate(
  n: string,
): { city: string; letters: string; digits: string; suffix: string } | null {
  // Several city codes can prefix the same normalised string (B vs BA). Prefer
  // the parse with a longer identification-letter group, then a shorter city code.
  const candidates: Array<{ city: string; letters: string; digits: string; suffix: string }> = [];
  for (const city of DE_CITY_CODES) {
    if (!n.startsWith(city)) continue;
    const rest = n.slice(city.length);
    const m = /^([A-Z]{1,2})(\d{1,4})([EH]?)$/.exec(rest);
    if (m) {
      candidates.push({ city, letters: m[1]!, digits: m[2]!, suffix: m[3] ?? '' });
    }
  }
  candidates.sort((a, b) => b.letters.length - a.letters.length || a.city.length - b.city.length);
  return candidates[0] ?? null;
}

const de: CountryDefinition = {
  code: 'DE',
  name: 'Germany',
  plateLabel: 'Kennzeichen',
  example: 'B AB 1234',
  placeholder: 'B AB 1234',
  maxInputLength: 14,
  authority: 'Kraftfahrt-Bundesamt / local Zulassungsstelle',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline city-code format validation (distinguishing signs)',
  classify: (n) => {
    if (parseGermanPlate(n)) return { format: 'de-standard', valid: true };
    // Fall back to structural shape when the city code is uncommon / missing from the table
    if (/^[A-Z]{1,3}[A-Z]{1,2}\d{1,4}[EH]?$/.test(n) && n.length >= 4 && n.length <= 9) {
      return { format: 'de-standard', valid: true };
    }
    return failUnknown('German');
  },
  formatDisplay: (n) => {
    const parsed = parseGermanPlate(n);
    if (parsed) {
      return `${parsed.city} ${parsed.letters} ${parsed.digits}${parsed.suffix}`.trim();
    }
    const m = /^([A-Z]{1,3})([A-Z]{1,2})(\d{1,4})([EH]?)$/.exec(n);
    if (!m) return n;
    return `${m[1]} ${m[2]} ${m[3]}${m[4] ?? ''}`.trim();
  },
  decode: (n) => {
    const parsed = parseGermanPlate(n);
    const city = parsed?.city ?? /^([A-Z]{1,3})/.exec(n)?.[1];
    if (!city) return emptyDecode();
    const suffix = parsed?.suffix ?? '';
    const notices: string[] = [];
    if (suffix === 'E') notices.push('E suffix — electric vehicle distinguishing sign.');
    if (suffix === 'H') notices.push('H suffix — historic vehicle (Oldtimer) distinguishing sign.');
    if (!parsed) {
      notices.push(
        'City code was inferred structurally; uncommon distinguishing signs may be split incorrectly.',
      );
    }
    return {
      age: null,
      region: regionOf(city, `Distinguishing sign ${city}`, city, city),
      notices,
    };
  },
};

const es: CountryDefinition = {
  code: 'ES',
  name: 'Spain',
  plateLabel: 'matrícula',
  example: '1234 BBC',
  placeholder: '1234 BBC',
  maxInputLength: 12,
  authority: 'DGT',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline 2000– provincial-less format (no vowels / Q / Ñ)',
  classify: (n) => {
    if (/^\d{4}[A-Z]{3}$/.test(n)) {
      if (/[AEIOUQÑ]/.test(n.slice(4))) {
        return {
          format: 'es-current',
          valid: false,
          reason: 'Spanish plates since 2000 omit vowels and the letters Q and Ñ',
        };
      }
      return { format: 'es-current', valid: true };
    }
    // Pre-2000: provincial code + digits + letters
    const older = matchFormats(n, [{ format: 'es-provincial', re: /^[A-Z]{1,2}\d{4}[A-Z]{1,2}$/ }]);
    return older ?? failUnknown('Spanish');
  },
  formatDisplay: (n, format) => {
    if (format === 'es-current') return spaced(n, [4]);
    const m = /^([A-Z]{1,2})(\d{4})([A-Z]{1,2})$/.exec(n);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : n;
  },
  decode: (n, format) => {
    if (format === 'es-provincial') {
      const prov = n.replace(/\d.*/, '');
      return {
        age: null,
        region: regionOf(prov, `Province code ${prov}`, prov, prov),
      };
    }
    return {
      age: null,
      region: null,
      notices: ['Spanish plates since September 2000 are national and do not encode a province.'],
    };
  },
};

const it: CountryDefinition = {
  code: 'IT',
  name: 'Italy',
  plateLabel: 'targa',
  example: 'AB 123 CD',
  placeholder: 'AB 123 CD',
  maxInputLength: 12,
  authority: 'Motorizzazione / ACI',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline 1994– national format validation',
  classify: (n) => {
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(n)) return { format: 'it-current', valid: true };
    // Pre-1994 provincial: AA 123456 / Roma style
    const older = matchFormats(n, [{ format: 'it-provincial', re: /^[A-Z]{2}\d{5,6}$/ }]);
    return older ?? failUnknown('Italian');
  },
  formatDisplay: (n, format) => {
    if (format === 'it-current') return spaced(n, [2, 5]);
    const m = /^([A-Z]{2})(\d+)$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: (n, format) => {
    if (format === 'it-provincial') {
      const prov = n.slice(0, 2);
      return {
        age: null,
        region: regionOf(prov, `Province ${prov}`, prov, prov),
      };
    }
    return {
      age: null,
      region: null,
      notices: [
        'Italian plates since 1994 are national; the two-letter front code is not a province.',
      ],
    };
  },
};

const nl: CountryDefinition = {
  code: 'NL',
  name: 'Netherlands',
  plateLabel: 'kenteken',
  example: 'X-999-XX',
  placeholder: 'X-999-XX',
  maxInputLength: 12,
  authority: 'RDW',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline sidecode 1–8 pattern validation',
  classify: (n) => {
    const sidecodes: Array<{ format: string; re: RegExp }> = [
      { format: 'nl-sidecode-1', re: /^[A-Z]{2}\d{2}\d{2}$/ }, // XX-99-99
      { format: 'nl-sidecode-2', re: /^\d{2}\d{2}[A-Z]{2}$/ }, // 99-99-XX
      { format: 'nl-sidecode-3', re: /^\d{2}[A-Z]{2}\d{2}$/ }, // 99-XX-99
      { format: 'nl-sidecode-4', re: /^[A-Z]{2}\d{2}[A-Z]{2}$/ }, // XX-99-XX
      { format: 'nl-sidecode-5', re: /^[A-Z]{2}[A-Z]{2}\d{2}$/ }, // XX-XX-99
      { format: 'nl-sidecode-6', re: /^\d{2}[A-Z]{2}[A-Z]{2}$/ }, // 99-XX-XX
      { format: 'nl-sidecode-7', re: /^\d{2}[A-Z]{3}\d$/ }, // 99-XXX-9
      { format: 'nl-sidecode-8', re: /^\d[A-Z]{3}\d{2}$/ }, // 9-XXX-99
      { format: 'nl-sidecode-9', re: /^[A-Z]{2}\d{3}[A-Z]$/ }, // XX-999-X
      { format: 'nl-sidecode-10', re: /^[A-Z]\d{3}[A-Z]{2}$/ }, // X-999-XX
    ];
    return matchFormats(n, sidecodes) ?? failUnknown('Dutch');
  },
  formatDisplay: (n, format) => {
    const map: Record<string, number[]> = {
      'nl-sidecode-1': [2, 4],
      'nl-sidecode-2': [2, 4],
      'nl-sidecode-3': [2, 4],
      'nl-sidecode-4': [2, 4],
      'nl-sidecode-5': [2, 4],
      'nl-sidecode-6': [2, 4],
      'nl-sidecode-7': [2, 5],
      'nl-sidecode-8': [1, 4],
      'nl-sidecode-9': [2, 5],
      'nl-sidecode-10': [1, 4],
    };
    const cuts = map[format];
    return cuts ? spaced(n, cuts, '-') : n;
  },
  decode: (_n, format) => ({
    age: null,
    region: null,
    notices: [
      `Matched Dutch ${format.replace('nl-', '').replace(/-/g, ' ')} — sidecode indicates the series era, not a province.`,
    ],
  }),
};

const be: CountryDefinition = {
  code: 'BE',
  name: 'Belgium',
  plateLabel: 'number plate',
  example: '1-ABC-123',
  placeholder: '1-ABC-123',
  maxInputLength: 12,
  authority: 'DIV',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline current (index + ABC + 123) and older format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'be-current', re: /^\d[A-Z]{3}\d{3}$/ },
      { format: 'be-legacy', re: /^[A-Z]{3}\d{3}$/ },
      { format: 'be-old', re: /^[A-Z]\d{3}[A-Z]{3}$/ },
    ]);
    return hit ?? failUnknown('Belgian');
  },
  formatDisplay: (n, format) => {
    if (format === 'be-current') return spaced(n, [1, 4], '-');
    if (format === 'be-legacy') return spaced(n, [3], '-');
    if (format === 'be-old') {
      const m = /^([A-Z])(\d{3})([A-Z]{3})$/.exec(n);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : n;
    }
    return n;
  },
  decode: emptyDecode,
};

const pt: CountryDefinition = {
  code: 'PT',
  name: 'Portugal',
  plateLabel: 'matrícula',
  example: 'AB-12-CD',
  placeholder: 'AB-12-CD',
  maxInputLength: 12,
  authority: 'IMT',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline 2020– AA-00-AA and earlier 00-AA-00 / AA-00-00 styles',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'pt-2020', re: /^[A-Z]{2}\d{2}[A-Z]{2}$/ },
      { format: 'pt-2005', re: /^\d{2}[A-Z]{2}\d{2}$/ },
      { format: 'pt-1992', re: /^\d{2}[A-Z]{2}\d{2}$/ },
      { format: 'pt-legacy', re: /^[A-Z]{2}\d{2}\d{2}$/ },
    ]);
    return hit ?? failUnknown('Portuguese');
  },
  formatDisplay: (n) => spaced(n, [2, 4], '-'),
  decode: emptyDecode,
};

const se: CountryDefinition = {
  code: 'SE',
  name: 'Sweden',
  plateLabel: 'registreringsskylt',
  example: 'ABC 12D',
  placeholder: 'ABC 12D',
  maxInputLength: 10,
  authority: 'Transportstyrelsen',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline ABC 12D (2019–) and ABC 123 format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'se-current', re: /^[A-Z]{3}\d{2}[A-Z]$/ },
      { format: 'se-classic', re: /^[A-Z]{3}\d{3}$/ },
    ]);
    return hit ?? failUnknown('Swedish');
  },
  formatDisplay: (n, format) => {
    if (format === 'se-current') return spaced(n, [3]);
    if (format === 'se-classic') return spaced(n, [3]);
    return n;
  },
  decode: emptyDecode,
};

const no: CountryDefinition = {
  code: 'NO',
  name: 'Norway',
  plateLabel: 'registreringsskilt',
  example: 'AB 12345',
  placeholder: 'AB 12345',
  maxInputLength: 10,
  authority: 'Statens vegvesen',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline two-letter + 4–5 digit format validation',
  classify: (n) => {
    const hit = matchFormats(n, [{ format: 'no-standard', re: /^[A-Z]{2}\d{4,5}$/ }]);
    return hit ?? failUnknown('Norwegian');
  },
  formatDisplay: (n) => spaced(n, [2]),
  decode: (n) => ({
    age: null,
    region: regionOf(n.slice(0, 2), `Series ${n.slice(0, 2)}`, n.slice(0, 2), n.slice(0, 2)),
  }),
};

const dk: CountryDefinition = {
  code: 'DK',
  name: 'Denmark',
  plateLabel: 'nummerplade',
  example: 'AB 12 345',
  placeholder: 'AB 12 345',
  maxInputLength: 12,
  authority: 'Motorstyrelsen',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline two-letter + five-digit format validation',
  classify: (n) => {
    const hit = matchFormats(n, [{ format: 'dk-standard', re: /^[A-Z]{2}\d{5}$/ }]);
    return hit ?? failUnknown('Danish');
  },
  formatDisplay: (n) => `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4)}`,
  decode: emptyDecode,
};

const fi: CountryDefinition = {
  code: 'FI',
  name: 'Finland',
  plateLabel: 'rekisterikilpi',
  example: 'ABC-123',
  placeholder: 'ABC-123',
  maxInputLength: 10,
  authority: 'Traficom',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline ABC-123 format validation',
  classify: (n) => {
    const hit = matchFormats(n, [{ format: 'fi-standard', re: /^[A-Z]{3}\d{1,3}$/ }]);
    return hit ?? failUnknown('Finnish');
  },
  formatDisplay: (n) => spaced(n, [3], '-'),
  decode: emptyDecode,
};

const at: CountryDefinition = {
  code: 'AT',
  name: 'Austria',
  plateLabel: 'Kennzeichen',
  example: 'W ABC 12',
  placeholder: 'W ABC 12',
  maxInputLength: 12,
  authority: 'BMK / Bezirkshauptmannschaft',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline district-code format validation',
  classify: (n) => {
    // 1–2 letter district + letters + digits (various lengths)
    if (/^[A-Z]{1,2}[A-Z]{1,5}\d{1,5}$/.test(n) && n.length >= 4 && n.length <= 10) {
      return { format: 'at-standard', valid: true };
    }
    return failUnknown('Austrian');
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]{1,2})([A-Z]{1,5})(\d{1,5})$/.exec(n);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : n;
  },
  decode: (n) => {
    const m = /^([A-Z]{1,2})/.exec(n);
    const dist = m?.[1] ?? '';
    return {
      age: null,
      region: regionOf(dist, `District ${dist}`, dist, dist),
    };
  },
};

const ch: CountryDefinition = {
  code: 'CH',
  name: 'Switzerland',
  plateLabel: 'control plate',
  example: 'ZH 123456',
  placeholder: 'ZH 123456',
  maxInputLength: 12,
  authority: 'Cantonal road traffic offices',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline canton code + serial validation',
  classify: (n) => {
    const hit = matchFormats(n, [{ format: 'ch-standard', re: /^[A-Z]{2}\d{1,6}$/ }]);
    return hit ?? failUnknown('Swiss');
  },
  formatDisplay: (n) => spaced(n, [2]),
  decode: (n) => {
    const canton = n.slice(0, 2);
    return {
      age: null,
      region: regionOf(canton, `Canton ${canton}`, canton, canton),
    };
  },
};

const pl: CountryDefinition = {
  code: 'PL',
  name: 'Poland',
  plateLabel: 'tablica rejestracyjna',
  example: 'WW 12345',
  placeholder: 'WW 12345',
  maxInputLength: 12,
  authority: 'Ministry of Infrastructure',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline powiat / voivodeship code format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'pl-standard', re: /^[A-Z]{2,3}\d{4,5}$/ },
      { format: 'pl-standard', re: /^[A-Z]{2,3}\d{3}[A-Z]{2}$/ },
    ]);
    return hit ?? failUnknown('Polish');
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]{2,3})(.+)$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: (n) => {
    const code = n.replace(/[0-9].*$/, '').slice(0, 3);
    return {
      age: null,
      region: regionOf(code, `District code ${code}`, code, code),
    };
  },
};

const cz: CountryDefinition = {
  code: 'CZ',
  name: 'Czechia',
  plateLabel: 'registrační značka',
  example: '1AB 2345',
  placeholder: '1AB 2345',
  maxInputLength: 12,
  authority: 'Ministry of Transport',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline 2001– format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'cz-current', re: /^\d[A-Z]{2}\d{4}$/ },
      { format: 'cz-current', re: /^\d[A-Z]{1,2}\d{4}$/ },
    ]);
    return hit ?? failUnknown('Czech');
  },
  formatDisplay: (n) => spaced(n, [3]),
  decode: emptyDecode,
};

const us: CountryDefinition = {
  code: 'US',
  name: 'United States',
  plateLabel: 'license plate',
  example: 'ABC 1234',
  placeholder: 'ABC 1234',
  maxInputLength: 12,
  authority: 'State DMV / DOR (varies by state)',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline general validation — formats vary by state',
  classify: (n) => {
    if (n.length < 1 || n.length > 8) {
      return {
        format: 'unknown',
        valid: false,
        reason: 'US plates are typically 1–8 characters (varies by state)',
      };
    }
    if (!/^[A-Z0-9]{1,8}$/.test(n)) {
      return failUnknown('US');
    }
    // Extremely short / all-same are still structurally possible (vanity)
    return {
      format: 'us-general',
      valid: true,
      reason: undefined,
    };
  },
  formatDisplay: (n) => {
    // Soft grouping: letters then digits when that split exists
    const m = /^([A-Z]+)(\d+)$/.exec(n) ?? /^(\d+)([A-Z]+)$/.exec(n);
    if (m) return `${m[1]} ${m[2]}`;
    if (n.length === 7) return spaced(n, [3]);
    if (n.length === 6) return spaced(n, [3]);
    return n;
  },
  decode: () => ({
    age: null,
    region: null,
    notices: [
      'US license plate formats are issued by each state and territory — this check only validates a general alphanumeric pattern. Select the correct state DMV records for a definitive lookup; no free nationwide vehicle API is wired here.',
    ],
  }),
};

const ca: CountryDefinition = {
  code: 'CA',
  name: 'Canada',
  plateLabel: 'licence plate',
  example: 'ABCD 123',
  placeholder: 'ABCD 123',
  maxInputLength: 12,
  authority: 'Provincial / territorial issuer',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline general validation — formats vary by province',
  classify: (n) => {
    if (n.length < 2 || n.length > 8 || !/^[A-Z0-9]+$/.test(n)) {
      return {
        format: 'unknown',
        valid: false,
        reason: 'Canadian plates are typically 2–8 alphanumeric characters (varies by province)',
      };
    }
    return { format: 'ca-general', valid: true };
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]+)(\d+)$/.exec(n) ?? /^(\d+)([A-Z]+)$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: () => ({
    age: null,
    region: null,
    notices: [
      'Canadian plates are provincial/territorial. This check validates a general pattern only — live vehicle data is not available through Beacon for Canada.',
    ],
  }),
};

const au: CountryDefinition = {
  code: 'AU',
  name: 'Australia',
  plateLabel: 'number plate',
  example: 'ABC 123',
  placeholder: 'ABC 123',
  maxInputLength: 12,
  authority: 'State / territory road authority',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline common state format validation (NSW, VIC, QLD, …)',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'au-nsw', re: /^[A-Z]{2}\d{2}[A-Z]{2}$/ }, // AA00AA
      { format: 'au-vic', re: /^[A-Z]{3}\d{3}$/ }, // AAA000
      { format: 'au-vic', re: /^\d[A-Z]{2}\d[A-Z]{2}$/ }, // 1AA1AA
      { format: 'au-qld', re: /^\d{3}[A-Z]{3}$/ }, // 000AAA
      { format: 'au-qld', re: /^[A-Z]\d{2}[A-Z]{2}$/ }, // A00AA
      { format: 'au-sa', re: /^S\d{3}[A-Z]{3}$/ }, // S000AAA
      { format: 'au-wa', re: /^1[A-Z]{3}\d{3}$/ }, // 1AAA000
      { format: 'au-wa', re: /^[A-Z]{3}\d{2}[A-Z]$/ },
      { format: 'au-tas', re: /^[A-Z]\d{2}[A-Z]{2}$/ },
      { format: 'au-act', re: /^Y[A-Z]{2}\d{2}[A-Z]$/ }, // YAA00A
      { format: 'au-nt', re: /^[A-Z]{2}\d{2}[A-Z]$/ },
      { format: 'au-general', re: /^[A-Z0-9]{5,7}$/ },
    ]);
    return hit ?? failUnknown('Australian');
  },
  formatDisplay: (n, format) => {
    if (format === 'au-nsw') return spaced(n, [2, 4]);
    if (format === 'au-vic' && /^[A-Z]{3}\d{3}$/.test(n)) return spaced(n, [3]);
    if (format === 'au-qld' && /^\d{3}[A-Z]{3}$/.test(n)) return spaced(n, [3]);
    if (format === 'au-sa') return spaced(n, [1, 4]);
    if (n.length === 6) return spaced(n, [3]);
    return n;
  },
  decode: (_n, format) => {
    const stateKey = format.replace('au-', '').toUpperCase();
    const state = AU_STATE_HINTS[stateKey];
    return {
      age: null,
      region: state ? regionOf(stateKey, state, state, state) : null,
      notices: state
        ? undefined
        : [
            'Australian plates are state/territory-specific. Matched a general pattern — confirm against the issuing state authority for a definitive record.',
          ],
    };
  },
};

const nz: CountryDefinition = {
  code: 'NZ',
  name: 'New Zealand',
  plateLabel: 'number plate',
  example: 'ABC123',
  placeholder: 'ABC123',
  maxInputLength: 10,
  authority: 'NZTA Waka Kotahi',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline ABC123 / ABC12A style validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'nz-current', re: /^[A-Z]{3}\d{2}[A-Z]$/ },
      { format: 'nz-classic', re: /^[A-Z]{2,3}\d{1,4}$/ },
      { format: 'nz-personalised', re: /^[A-Z0-9]{1,6}$/ },
    ]);
    // personalised is too broad — only accept if nothing else matched and length ok
    if (hit?.format === 'nz-personalised' && hit.valid) {
      if (n.length < 2) return failUnknown('New Zealand');
    }
    return hit ?? failUnknown('New Zealand');
  },
  formatDisplay: (n) => n,
  decode: emptyDecode,
};

const inCountry: CountryDefinition = {
  code: 'IN',
  name: 'India',
  plateLabel: 'registration mark',
  example: 'MH 12 AB 1234',
  placeholder: 'MH 12 AB 1234',
  maxInputLength: 16,
  authority: 'State RTO / MoRTH',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline BH / state RTO format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      // BH series (Bharat): 22 BH 1234 AB
      { format: 'in-bh', re: /^\d{2}BH\d{4}[A-Z]{1,2}$/ },
      // Standard: SS NN LL NNNN (state + district + series + number)
      { format: 'in-rto', re: /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/ },
    ]);
    return hit ?? failUnknown('Indian');
  },
  formatDisplay: (n, format) => {
    if (format === 'in-bh') {
      const m = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/.exec(n);
      return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n;
    }
    const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(n);
    return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n;
  },
  decode: (n, format, reference) => {
    if (format === 'in-bh') {
      const year = 2000 + Number(n.slice(0, 2));
      return {
        age: ageFromYear(n.slice(0, 2), year, reference, `BH series year code ${n.slice(0, 2)}`),
        region: regionOf('BH', 'Bharat (national) series', 'BH', 'India'),
      };
    }
    const state = n.slice(0, 2);
    return {
      age: null,
      region: regionOf(state, `State code ${state}`, state, state),
    };
  },
};

const br: CountryDefinition = {
  code: 'BR',
  name: 'Brazil',
  plateLabel: 'placa',
  example: 'ABC1D23',
  placeholder: 'ABC1D23',
  maxInputLength: 10,
  authority: 'DENATRAN / states',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline Mercosur (ABC1D23) and old ABC1234 validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'br-mercosur', re: /^[A-Z]{3}\d[A-Z]\d{2}$/ },
      { format: 'br-old', re: /^[A-Z]{3}\d{4}$/ },
    ]);
    return hit ?? failUnknown('Brazilian');
  },
  formatDisplay: (n) => {
    if (/^[A-Z]{3}\d{4}$/.test(n)) return spaced(n, [3], '-');
    return n;
  },
  decode: emptyDecode,
};

const mx: CountryDefinition = {
  code: 'MX',
  name: 'Mexico',
  plateLabel: 'placa',
  example: 'ABC-12-34',
  placeholder: 'ABC-12-34',
  maxInputLength: 12,
  authority: 'State / federal issuer',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline common federal / state format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'mx-current', re: /^[A-Z]{3}\d{4}$/ }, // ABC1234
      { format: 'mx-current', re: /^[A-Z]{3}\d{2}\d{2}$/ },
      { format: 'mx-motorcycle', re: /^\d{3}[A-Z]{3}$/ },
      { format: 'mx-legacy', re: /^[A-Z]{2,3}\d{2,4}[A-Z]?$/ },
    ]);
    return hit ?? failUnknown('Mexican');
  },
  formatDisplay: (n) => {
    if (/^[A-Z]{3}\d{4}$/.test(n)) return `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}`;
    return n;
  },
  decode: emptyDecode,
};

const ar: CountryDefinition = {
  code: 'AR',
  name: 'Argentina',
  plateLabel: 'patente',
  example: 'AB 123 CD',
  placeholder: 'AB 123 CD',
  maxInputLength: 12,
  authority: 'DNRPA',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline Mercosur AB123CD and older ABC123 formats',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'ar-mercosur', re: /^[A-Z]{2}\d{3}[A-Z]{2}$/ },
      { format: 'ar-old', re: /^[A-Z]{3}\d{3}$/ },
    ]);
    return hit ?? failUnknown('Argentine');
  },
  formatDisplay: (n, format) => {
    if (format === 'ar-mercosur') return spaced(n, [2, 5]);
    if (format === 'ar-old') return spaced(n, [3]);
    return n;
  },
  decode: emptyDecode,
};

const za: CountryDefinition = {
  code: 'ZA',
  name: 'South Africa',
  plateLabel: 'number plate',
  example: 'CA 123-456',
  placeholder: 'CA 123-456',
  maxInputLength: 14,
  authority: 'provincial licensing',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline provincial format validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'za-standard', re: /^[A-Z]{2}\d{6}$/ },
      { format: 'za-standard', re: /^[A-Z]{3}\d{3}[A-Z]{2}$/ }, // GP style
      { format: 'za-standard', re: /^[A-Z]{2}\d{2}[A-Z]{2}[A-Z]{2}$/ },
      { format: 'za-general', re: /^[A-Z]{2,3}\d{3,6}[A-Z]{0,3}$/ },
    ]);
    return hit ?? failUnknown('South African');
  },
  formatDisplay: (n) => {
    if (/^[A-Z]{2}\d{6}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 5)}-${n.slice(5)}`;
    const m = /^([A-Z]{2,3})(\d+)([A-Z]*)$/.exec(n);
    return m ? [m[1], m[2], m[3]].filter(Boolean).join(' ') : n;
  },
  decode: (n) => {
    const code = n.replace(/[0-9].*$/, '').slice(0, 3);
    return {
      age: null,
      region: regionOf(code, `Area code ${code}`, code, code),
    };
  },
};

const sg: CountryDefinition = {
  code: 'SG',
  name: 'Singapore',
  plateLabel: 'vehicle number',
  example: 'SBA1234A',
  placeholder: 'SBA1234A',
  maxInputLength: 12,
  authority: 'LTA',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline prefix + serial + checksum-letter validation',
  classify: (n) => {
    const hit = matchFormats(n, [{ format: 'sg-standard', re: /^[A-Z]{1,3}\d{1,4}[A-Z]$/ }]);
    return hit ?? failUnknown('Singapore');
  },
  formatDisplay: (n) => n,
  decode: (n) => {
    const prefix = n.replace(/\d.*$/, '');
    return {
      age: null,
      region: regionOf(prefix, `Prefix ${prefix}`, prefix, prefix),
    };
  },
};

const hk: CountryDefinition = {
  code: 'HK',
  name: 'Hong Kong',
  plateLabel: 'vehicle registration mark',
  example: 'AB 1234',
  placeholder: 'AB 1234',
  maxInputLength: 10,
  authority: 'Transport Department',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline two-letter + up to four-digit validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'hk-standard', re: /^[A-Z]{2}\d{1,4}$/ },
      { format: 'hk-standard', re: /^[A-Z]\d{1,4}$/ },
    ]);
    return hit ?? failUnknown('Hong Kong');
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]+)(\d+)$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: emptyDecode,
};

const jp: CountryDefinition = {
  code: 'JP',
  name: 'Japan',
  plateLabel: 'number plate',
  example: '品川 500 あ 1234',
  placeholder: '12-3456',
  maxInputLength: 16,
  authority: 'MLIT',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline numeric export / romaji-style pattern only (kana plates need local tools)',
  classify: (n) => {
    // Export / diplomatic / simplified romaji forms commonly entered in Latin script
    const hit = matchFormats(n, [
      { format: 'jp-export', re: /^\d{2,3}\d{4}$/ },
      { format: 'jp-class', re: /^\d{2,3}[A-Z]{0,2}\d{1,4}$/ },
      { format: 'jp-general', re: /^[A-Z0-9]{4,8}$/ },
    ]);
    return hit ?? failUnknown('Japanese (Latin-script approximation)');
  },
  formatDisplay: (n) => {
    if (/^\d{5,7}$/.test(n)) return spaced(n, [n.length - 4], '-');
    return n;
  },
  decode: () => ({
    age: null,
    region: null,
    notices: [
      'Japanese plates normally include hiragana and a land-transport office name. Latin-script checks here are approximate — use the MLIT / local office record for authoritative data.',
    ],
  }),
};

const kr: CountryDefinition = {
  code: 'KR',
  name: 'South Korea',
  plateLabel: 'number plate',
  example: '12가 3456',
  placeholder: '123가4567',
  maxInputLength: 12,
  authority: 'MOLIT',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline numeric pattern for Latin entry (Hangul plates need local tools)',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'kr-numeric', re: /^\d{2,3}\d{4}$/ },
      { format: 'kr-general', re: /^\d{2,3}[A-Z]?\d{4}$/ },
    ]);
    return hit ?? failUnknown('South Korean (Latin-script approximation)');
  },
  formatDisplay: (n) => {
    if (/^\d{6,7}$/.test(n)) return spaced(n, [n.length - 4]);
    return n;
  },
  decode: () => ({
    age: null,
    region: null,
    notices: [
      'Korean plates use Hangul class characters. This Latin-script check is structural only.',
    ],
  }),
};

const ae: CountryDefinition = {
  code: 'AE',
  name: 'United Arab Emirates',
  plateLabel: 'number plate',
  example: 'A 12345',
  placeholder: 'A 12345',
  maxInputLength: 12,
  authority: 'Emirate traffic police',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline emirate category + serial validation',
  classify: (n) => {
    const hit = matchFormats(n, [
      { format: 'ae-standard', re: /^[A-Z]{1,2}\d{1,5}$/ },
      { format: 'ae-standard', re: /^\d{1,2}\d{1,5}$/ },
    ]);
    return hit ?? failUnknown('UAE');
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]+)(\d+)$/.exec(n) ?? /^(\d{1,2})(\d+)$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: (n) => {
    const cat = n.replace(/\d+$/, '') || n.slice(0, 1);
    return {
      age: null,
      region: regionOf(cat, `Category ${cat}`, cat, cat),
      notices: [
        'UAE plates are issued per emirate with different category letters/colours — category alone does not identify the emirate in every series.',
      ],
    };
  },
};

const tr: CountryDefinition = {
  code: 'TR',
  name: 'Türkiye',
  plateLabel: 'plaka',
  example: '34 ABC 123',
  placeholder: '34 ABC 123',
  maxInputLength: 14,
  authority: 'EGM',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline province-code format validation',
  classify: (n) => {
    // 01–81 province + letters + digits
    const hit = matchFormats(n, [{ format: 'tr-standard', re: /^\d{2}[A-Z]{1,3}\d{2,4}$/ }]);
    return hit ?? failUnknown('Turkish');
  },
  formatDisplay: (n) => {
    const m = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(n);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : n;
  },
  decode: (n) => {
    const prov = n.slice(0, 2);
    return {
      age: null,
      region: regionOf(prov, `Province code ${prov}`, prov, prov),
    };
  },
};

const ru: CountryDefinition = {
  code: 'RU',
  name: 'Russia',
  plateLabel: 'регистрационный знак',
  example: 'A123BC 77',
  placeholder: 'A123BC77',
  maxInputLength: 12,
  authority: 'GIBDD',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline ГОСТ format (Latin look-alikes A,B,E,K,M,H,O,P,C,T,Y,X)',
  classify: (n) => {
    // Letters restricted to those that look like Cyrillic on plates
    if (/^[ABEKMHOPCTYX]\d{3}[ABEKMHOPCTYX]{2}\d{2,3}$/.test(n)) {
      return { format: 'ru-standard', valid: true };
    }
    if (/^[A-Z]\d{3}[A-Z]{2}\d{2,3}$/.test(n)) {
      return {
        format: 'ru-standard',
        valid: false,
        reason: 'Russian plates only use letters that resemble Cyrillic: A B E K M H O P C T Y X',
      };
    }
    return failUnknown('Russian');
  },
  formatDisplay: (n) => {
    const m = /^([A-Z]\d{3}[A-Z]{2})(\d{2,3})$/.exec(n);
    return m ? `${m[1]} ${m[2]}` : n;
  },
  decode: (n) => {
    // Prefer 3-digit region codes when present (e.g. 777), else 2-digit.
    const code = n.length >= 9 && /^\d{3}$/.test(n.slice(-3)) ? n.slice(-3) : n.slice(-2);
    return {
      age: null,
      region: regionOf(code, `Region code ${code}`, code, code),
    };
  },
};

const cn: CountryDefinition = {
  code: 'CN',
  name: 'China',
  plateLabel: 'number plate',
  example: '京A12345',
  placeholder: 'A12345',
  maxInputLength: 12,
  authority: 'traffic police / 公安',
  liveVehicleData: false,
  liveInspectionHistory: false,
  summary: 'Offline Latin-serial validation (province character normally required)',
  classify: (n) => {
    // Without CJK province character: letter + alphanumerics
    const hit = matchFormats(n, [
      { format: 'cn-new-energy', re: /^[A-Z][A-Z0-9]{6}$/ },
      { format: 'cn-standard', re: /^[A-Z][A-Z0-9]{5}$/ },
    ]);
    return hit ?? failUnknown('Chinese (Latin-script without province character)');
  },
  formatDisplay: (n) => spaced(n, [1]),
  decode: () => ({
    age: null,
    region: null,
    notices: [
      'Mainland plates begin with a province/municipality character (e.g. 京, 沪). Enter the alphanumeric serial after that character; authoritative lookups need the full plate.',
    ],
  }),
};

/** Ordered for the country picker (GB first, then alphabetical by name). */
export const COUNTRY_DEFINITIONS: CountryDefinition[] = [
  gb,
  ae,
  ar,
  at,
  au,
  be,
  br,
  ca,
  ch,
  cn,
  cz,
  de,
  dk,
  es,
  fi,
  fr,
  hk,
  ie,
  inCountry,
  it,
  jp,
  kr,
  mx,
  nl,
  no,
  nz,
  pl,
  pt,
  ru,
  se,
  sg,
  tr,
  us,
  za,
].sort((a, b) => {
  if (a.code === 'GB') return -1;
  if (b.code === 'GB') return 1;
  return a.name.localeCompare(b.name);
});

export const COUNTRY_BY_CODE: Record<string, CountryDefinition> = Object.fromEntries(
  COUNTRY_DEFINITIONS.map((c) => [c.code, c]),
);

/** Common aliases → ISO code. */
export const COUNTRY_ALIASES: Record<string, string> = {
  UK: 'GB',
  GBR: 'GB',
  GREATBRITAIN: 'GB',
  UNITEDKINGDOM: 'GB',
  ENG: 'GB',
  ENGLAND: 'GB',
  USA: 'US',
  AMERICA: 'US',
  UNITEDSTATES: 'US',
  UAE: 'AE',
  HOLLAND: 'NL',
  NEDERLAND: 'NL',
  CZECH: 'CZ',
  CZECHREPUBLIC: 'CZ',
  CZECHIA: 'CZ',
  SOUTH_KOREA: 'KR',
  SOUTHKOREA: 'KR',
  KOREA: 'KR',
  TURKEY: 'TR',
  TURKIYE: 'TR',
  RSA: 'ZA',
  SOUTHAFRICA: 'ZA',
  NZL: 'NZ',
  AUS: 'AU',
  IND: 'IN',
  SGP: 'SG',
  HKG: 'HK',
  CHE: 'CH',
  SWISS: 'CH',
  DEU: 'DE',
  GERMANY: 'DE',
  FRA: 'FR',
  IRL: 'IE',
  EIRE: 'IE',
  ESP: 'ES',
  ITA: 'IT',
  BRA: 'BR',
  ARG: 'AR',
  MEX: 'MX',
  POL: 'PL',
  PRT: 'PT',
  SWE: 'SE',
  NOR: 'NO',
  DNK: 'DK',
  FIN: 'FI',
  AUT: 'AT',
  BEL: 'BE',
  RUS: 'RU',
  CHN: 'CN',
  JPN: 'JP',
  CAN: 'CA',
};
