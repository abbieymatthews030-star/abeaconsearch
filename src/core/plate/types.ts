/** Vehicle registration mark ("number plate") analysis types — UK and Australia. */

/** Countries with a supported plate classifier. `unknown` = neither matched. */
export type PlateCountry = 'GB' | 'AU' | 'unknown';

/**
 * Structural shape of a current-issue Australian plate. Unlike the UK's DVLA
 * memory-tag system, Australia has no single national scheme that encodes the
 * issuing state in the characters — each state/territory road authority runs
 * its own series, and only the plate's physical border/slogan (not part of
 * the alphanumeric code) names the state. A shape match is a plausibility
 * check, not proof of which state issued it.
 */
export type AuPlateShape =
  | 'nsw-style' // AA00AA — New South Wales' general-issue format
  | 'qld-style' // 000AAA — Queensland's general-issue format
  | 'general-au' // AAA000 — common general-issue shape (VIC/SA/TAS/NT/WA/ACT)
  | 'unknown';

export type PlateFormat =
  | 'current' // 2001–present: AA00 AAA
  | 'prefix' // 1983–2001: A000 AAA
  | 'suffix' // 1963–1983: AAA 000A
  | 'dateless' // pre-1963 and cherished marks
  | 'northern-ireland' // AAA 0000 (contains I or Z)
  | 'diplomatic' // 000 A 000
  | AuPlateShape;

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
  memoryTag: string;
  region: string;
  office: string;
  country: 'England' | 'Wales' | 'Scotland' | 'Northern Ireland' | 'Unknown';
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
   * Force interpretation as this country instead of auto-detecting from the
   * plate's shape. `GB` keeps the original UK-only behaviour (DVLA/DVSA
   * lookups included); `AU` runs the Australian structural checks and skips
   * the UK-only lookups. Omit to auto-detect.
   */
  country?: 'GB' | 'AU';
  /** Query the DVLA Vehicle Enquiry Service (needs an API key; GB only). */
  includeVehicleData?: boolean;
  /** Query the DVSA MOT history API (needs client credentials; GB only). */
  includeMotHistory?: boolean;
  /** Evaluate the plate as if registered/checked on this date (ISO). */
  referenceDate?: string;
}

export interface PlateCheck {
  input: string;
  normalized: string;
  formatted: string;
  valid: boolean;
  /** Which country's rules the plate was checked against. */
  country: PlateCountry;
  format: PlateFormat;
  age: PlateAge | null;
  region: PlateRegion | null;
  vehicle: VehicleRecord | null;
  mot: MotSummary | null;
  checks: CheckItem[];
  summary: {
    /**
     * `invalid` — not a valid registration mark for the detected/selected country.
     * `fail` — valid mark, but a check failed (e.g. untaxed, MOT expired).
     * `attention` — valid mark with warnings only.
     * `ok` — valid mark, everything passed.
     */
    status: 'ok' | 'attention' | 'fail' | 'invalid';
    headline: string;
    pass: number;
    warn: number;
    fail: number;
  };
  sources: string[];
  checkedAt: string;
}
