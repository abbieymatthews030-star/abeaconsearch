/** UK vehicle registration mark (VRM / "number plate") analysis types. */

export type PlateFormat =
  | 'current' // 2001–present: AA00 AAA
  | 'prefix' // 1983–2001: A000 AAA
  | 'suffix' // 1963–1983: AAA 000A
  | 'dateless' // pre-1963 and cherished marks
  | 'northern-ireland' // AAA 0000 (contains I or Z)
  | 'diplomatic' // 000 A 000
  | 'unknown';

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
  /** Query the DVLA Vehicle Enquiry Service (needs an API key). */
  includeVehicleData?: boolean;
  /** Query the DVSA MOT history API (needs client credentials). */
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
  age: PlateAge | null;
  region: PlateRegion | null;
  vehicle: VehicleRecord | null;
  mot: MotSummary | null;
  checks: CheckItem[];
  summary: {
    /**
     * `invalid` — not a valid UK registration mark.
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
