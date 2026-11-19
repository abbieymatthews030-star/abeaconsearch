/** Vehicle registration mark / number plate analysis types (worldwide). */

/**
 * Format id for a recognised plate pattern. UK-era ids (`current`, `prefix`,
 * …) are kept for backward compatibility when the country is GB; other
 * countries use ids like `fr-siv`, `us-general`, `ie-current`.
 */
export type PlateFormat =
  | 'current' // GB 2001–present: AA00 AAA
  | 'prefix' // GB 1983–2001: A000 AAA
  | 'suffix' // GB 1963–1983: AAA 000A
  | 'dateless' // GB pre-1963 and cherished marks
  | 'northern-ireland' // GB/NI AAA 0000 (contains I or Z)
  | 'diplomatic' // GB 000 A 000
  | 'unknown'
  | (string & {});

export interface PlateClassification {
  format: PlateFormat;
  valid: boolean;
  reason?: string;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skipped';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Optional structured payload for this check (provider data, ranges, …). */
  data?: Record<string, unknown>;
}

export interface PlateAge {
  identifier: string;
  registeredFrom: string; // ISO date (inclusive)
  registeredTo: string; // ISO date (inclusive)
  approxYear: number;
  ageYears: number;
  description: string;
}

export interface PlateRegion {
  /** Area / memory / issuer / district code when known. */
  memoryTag: string;
  region: string;
  office: string;
  /**
   * Subdivision within the selected country — e.g. England/Wales for GB,
   * a US state name when known, an Irish county, a German city code label.
   */
  country: string;
}

/** Selected issuing country for a plate check. */
export interface PlateCountryRef {
  code: string;
  name: string;
}

export interface VehicleRecord {
  registrationNumber?: string;
  make?: string;
  model?: string;
  colour?: string;
  fuelType?: string;
  yearOfManufacture?: number;
  monthOfFirstRegistration?: string;
  engineCapacity?: number;
  co2Emissions?: number;
  euroStatus?: string;
  taxStatus?: string;
  taxDueDate?: string;
  motStatus?: string;
  motExpiryDate?: string;
  markedForExport?: boolean;
  wheelplan?: string;
  dateOfLastV5CIssued?: string;
  revenueWeight?: number;
  typeApproval?: string;
  source: string;
}

export interface MotTest {
  completedDate?: string;
  testResult?: string;
  expiryDate?: string;
  odometerValue?: number;
  odometerUnit?: string;
  motTestNumber?: string;
  defects: Array<{ text?: string; type?: string; dangerous?: boolean }>;
}

export interface MotSummary {
  registration?: string;
  make?: string;
  model?: string;
  firstUsedDate?: string;
  fuelType?: string;
  primaryColour?: string;
  motTestExpiryDate?: string;
  totalTests: number;
  passed: number;
  failed: number;
  latestResult?: string;
  latestOdometer?: { value: number; unit: string };
  mileageAnomaly: boolean;
  tests: MotTest[];
  source: string;
}

export interface PlateCheckOptions {
  /**
   * ISO 3166-1 alpha-2 country code (or a known alias such as UK → GB).
   * Defaults to GB (United Kingdom).
   */
  country?: string;
  /** Query a live vehicle record when the country supports it (GB: DVLA VES). */
  includeVehicleData?: boolean;
  /** Query inspection history when supported (GB: DVSA MOT). */
  includeMotHistory?: boolean;
  /** Evaluate the plate as if registered/checked on this date (ISO). */
  referenceDate?: string;
}

export interface PlateCheck {
  input: string;
  normalized: string;
  formatted: string;
  valid: boolean;
  format: PlateFormat;
  /** Country the check was run against. */
  country: PlateCountryRef;
  age: PlateAge | null;
  region: PlateRegion | null;
  vehicle: VehicleRecord | null;
  mot: MotSummary | null;
  checks: CheckItem[];
  summary: {
    /**
     * `invalid` — not a valid registration mark for the selected country.
     * `fail` — valid mark, but a check failed (e.g. untaxed, MOT expired).
     * `attention` — valid mark with warnings only.
     * `ok` — valid mark, everything that ran passed.
     */
    status: 'ok' | 'attention' | 'fail' | 'invalid';
    headline: string;
    pass: number;
    warn: number;
    fail: number;
  };
  sources: string[];
  /** Wall-clock time the check ran (ISO). */
  checkedAt: string;
  /** Date the age / expiry maths were evaluated against, when set. */
  referenceDate?: string;
  /** Guidance that is not a pass/fail check (e.g. paid services). */
  notices: string[];
}
