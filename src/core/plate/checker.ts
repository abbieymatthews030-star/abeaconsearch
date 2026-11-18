import {
  DEFAULT_COUNTRY_CODE,
  listCountries,
  resolveCountry,
  type CountryDefinition,
} from './countries/index.js';
import { normalizePlate } from './format.js';
import type { MotProvider, VehicleProvider } from './providers/types.js';
import type {
  CheckItem,
  CheckStatus,
  PlateCheck,
  PlateCheckOptions,
  VehicleRecord,
} from './types.js';

export interface PlateCheckerDeps {
  vehicleProvider?: VehicleProvider;
  motProvider?: MotProvider;
  now?: () => Date;
}

function daysUntil(iso: string | undefined, ref: Date): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.round((target - ref.getTime()) / 864e5);
}

export class PlateChecker {
  private readonly vehicleProvider?: VehicleProvider;
  private readonly motProvider?: MotProvider;
  private readonly now: () => Date;

  constructor(deps: PlateCheckerDeps = {}) {
    this.vehicleProvider = deps.vehicleProvider;
    this.motProvider = deps.motProvider;
    this.now = deps.now ?? (() => new Date());
  }

  get capabilities(): {
    vehicleData: boolean;
    motHistory: boolean;
    defaultCountry: string;
    countries: ReturnType<typeof listCountries>;
  } {
    return {
      vehicleData: Boolean(this.vehicleProvider?.configured),
      motHistory: Boolean(this.motProvider?.configured),
      defaultCountry: DEFAULT_COUNTRY_CODE,
      countries: listCountries(),
    };
  }

  /** The wired providers, so callers can reuse them (shared token cache etc.). */
  get providers(): { vehicle?: VehicleProvider; mot?: MotProvider } {
    return { vehicle: this.vehicleProvider, mot: this.motProvider };
  }

  async check(input: string, options: PlateCheckOptions = {}): Promise<PlateCheck> {
    const country = resolveCountry(options.country);
    const parsedRef = options.referenceDate ? new Date(options.referenceDate) : null;
    const reference = parsedRef && !Number.isNaN(parsedRef.getTime()) ? parsedRef : this.now();
    const normalized = normalizePlate(input);
    const classification = country.classify(normalized);
    const formatted = country.formatDisplay(normalized, classification.format);
    const checks: CheckItem[] = [];
    const sources = new Set<string>([`Offline ${country.name} plate analysis`]);
    const notices: string[] = [];

    // 1. Format --------------------------------------------------------------
    checks.push({
      id: 'format',
      label: 'Registration format',
      status: classification.valid ? 'pass' : 'fail',
      detail: classification.valid
        ? `Matches the ${country.name} ${classification.format} plate format`
        : (classification.reason ?? `Not a recognised ${country.name} registration mark`),
      data: { format: classification.format, country: country.code },
    });

    checks.push({
      id: 'characters',
      label: 'Character set',
      status: /^[A-Z0-9]{1,12}$/.test(normalized) && normalized.length >= 1 ? 'pass' : 'fail',
      detail:
        normalized.length === 0
          ? 'No registration characters supplied'
          : `${normalized.length} characters after normalisation`,
    });

    checks.push({
      id: 'country',
      label: 'Country',
      status: 'info',
      detail: `${country.name} (${country.code}) — ${country.authority}`,
      data: { code: country.code, name: country.name },
    });

    // 2. Country-specific age / region / extra offline checks ----------------
    const decoded = country.decode(normalized, classification.format, reference);
    const age = decoded.age;
    const region = classification.valid ? decoded.region : null;

    if (classification.format !== 'unknown') {
      if (age) {
        const isGbCurrent = country.code === 'GB' && classification.format === 'current';
        checks.push({
          id: 'age',
          label: 'Age identifier',
          status: isGbCurrent ? 'pass' : 'info',
          detail: `"${age.identifier}" → ${age.description} (about ${age.ageYears} years old)`,
          data: { ...age },
        });
      } else if (country.code === 'GB' && classification.format === 'current') {
        checks.push({
          id: 'age',
          label: 'Age identifier',
          status: 'fail',
          detail: `"${normalized.slice(2, 4)}" is not a valid age identifier for a date up to ${reference.toISOString().slice(0, 10)} (future or out-of-range plate)`,
        });
      }

      if (region) {
        checks.push({
          id: 'region',
          label: 'Region of registration',
          status: country.code === 'GB' && classification.format === 'current' ? 'pass' : 'info',
          detail: `${region.memoryTag} → ${region.office}, ${region.region} (${region.country})`,
          data: { ...region },
        });
      } else if (country.code === 'GB' && classification.format === 'current') {
        checks.push({
          id: 'region',
          label: 'Region of registration',
          status: 'warn',
          detail: `Memory tag "${normalized.slice(0, 2)}" is not in the DVLA table`,
        });
      } else if (country.code === 'GB' && classification.format === 'northern-ireland') {
        // decode() already sets region for NI; kept for clarity if that ever changes
      }
    }

    if (decoded.checks) checks.push(...decoded.checks);
    if (decoded.notices) notices.push(...decoded.notices);

    // 3. Live vehicle data (GB DVLA today) -----------------------------------
    let vehicle: VehicleRecord | null = null;
    const wantVehicle = options.includeVehicleData ?? true;
    if (wantVehicle && classification.valid && country.liveVehicleData) {
      vehicle = await this.runVehicleLookup(normalized, checks, sources, age, reference);
    } else {
      checks.push({
        id: 'dvla-record',
        label: country.liveVehicleData ? 'DVLA vehicle record' : 'Live vehicle record',
        status: 'skipped',
        detail: !classification.valid
          ? 'Skipped — registration is not structurally valid'
          : !country.liveVehicleData
            ? `Skipped — no free live vehicle API is wired for ${country.name}`
            : 'Skipped — vehicle data lookup was not requested',
      });
    }

    // 4. Inspection history (GB MOT today) -----------------------------------
    let mot: PlateCheck['mot'] = null;
    const wantMot = options.includeMotHistory ?? true;
    if (
      wantMot &&
      classification.valid &&
      country.liveInspectionHistory &&
      this.motProvider?.configured
    ) {
      mot = await this.runMotLookup(normalized, checks, sources, reference);
    } else {
      checks.push({
        id: 'mot-history',
        label: country.liveInspectionHistory ? 'MOT test history' : 'Inspection history',
        status: 'skipped',
        detail: !classification.valid
          ? 'Skipped — registration is not structurally valid'
          : !country.liveInspectionHistory
            ? `Skipped — no free inspection-history API is wired for ${country.name}`
            : wantMot
              ? 'Skipped — DVSA MOT History API credentials are not configured'
              : 'Skipped — MOT history lookup was not requested',
      });
    }

    // 5. Paid / unavailable status guidance
    notices.push(
      country.code === 'GB'
        ? 'Stolen / outstanding finance / write-off status was not checked — those need a paid provider (e.g. an HPI-style check).'
        : `Stolen / finance / write-off / ownership data for ${country.name} was not checked — that typically needs a paid national provider.`,
    );

    const pass = checks.filter((c) => c.status === 'pass').length;
    const warn = checks.filter((c) => c.status === 'warn').length;
    const fail = checks.filter((c) => c.status === 'fail').length;
    const liveSkipped = checks.some(
      (c) => (c.id === 'dvla-record' || c.id === 'mot-history') && c.status === 'skipped',
    );
    const status: PlateCheck['summary']['status'] = !classification.valid
      ? 'invalid'
      : fail > 0
        ? 'fail'
        : warn > 0
          ? 'attention'
          : 'ok';

    const usedReference =
      options.referenceDate && parsedRef && !Number.isNaN(parsedRef.getTime())
        ? reference.toISOString()
        : undefined;

    return {
      input,
      normalized,
      formatted,
      valid: classification.valid,
      format: classification.format,
      country: { code: country.code, name: country.name },
      age,
      region,
      vehicle,
      mot,
      checks,
      summary: {
        status,
        headline: this.headline(status, classification.valid, vehicle, liveSkipped, country),
        pass,
        warn,
        fail,
      },
      sources: [...sources],
      checkedAt: this.now().toISOString(),
      referenceDate: usedReference,
      notices,
    };
  }

  private headline(
    status: PlateCheck['summary']['status'],
    valid: boolean,
    vehicle: VehicleRecord | null,
    liveSkipped: boolean,
    country: CountryDefinition,
  ): string {
    if (!valid) return `Not a valid ${country.name} registration mark`;
    const desc = vehicle?.make
      ? `${[vehicle.colour, vehicle.make].filter(Boolean).join(' ')}${
          vehicle.yearOfManufacture ? ` (${vehicle.yearOfManufacture})` : ''
        }`
      : `Valid ${country.name} registration`;
    if (status === 'ok') {
      return liveSkipped
        ? `${desc} — offline checks passed (live vehicle data not run)`
        : `${desc} — all checks passed`;
    }
    if (status === 'attention') return `${desc} — needs attention`;
    return `${desc} — failed one or more checks`;
  }

  private async runVehicleLookup(
    normalized: string,
    checks: CheckItem[],
    sources: Set<string>,
    age: PlateCheck['age'],
    reference: Date,
  ): Promise<VehicleRecord | null> {
    const providerName = this.vehicleProvider?.name ?? 'DVLA Vehicle Enquiry Service';
    if (!this.vehicleProvider?.configured) {
      checks.push({
        id: 'dvla-record',
        label: 'DVLA vehicle record',
        status: 'skipped',
        detail: `Skipped — ${providerName} API key is not configured`,
      });
      return null;
    }

    const result = await this.vehicleProvider.lookup(normalized);
    if (!result.ok || !result.data) {
      const fallback = {
        status: 'warn' as CheckStatus,
        detail: result.message ?? `${providerName} lookup failed`,
      };
      const map: Record<string, { status: CheckStatus; detail: string }> = {
        not_found: { status: 'warn', detail: 'DVLA has no vehicle for this registration' },
        rate_limited: { status: 'warn', detail: `${providerName} rate limit hit` },
      };
      const m = map[result.reason ?? ''] ?? fallback;
      checks.push({
        id: 'dvla-record',
        label: 'DVLA vehicle record',
        status: m.status,
        detail: m.detail,
      });
      return null;
    }

    const v = result.data;
    sources.add(this.vehicleProvider.name);
    checks.push({
      id: 'dvla-record',
      label: 'DVLA vehicle record',
      status: 'pass',
      detail: [v.colour, v.make, v.fuelType, v.yearOfManufacture].filter(Boolean).join(' · '),
      data: { ...v },
    });

    const taxed = v.taxStatus?.toLowerCase();
    checks.push({
      id: 'tax',
      label: 'Vehicle tax',
      status: taxed === 'taxed' ? 'pass' : taxed === 'sorn' ? 'warn' : taxed ? 'fail' : 'info',
      detail: v.taxStatus
        ? `${v.taxStatus}${v.taxDueDate ? ` (due ${v.taxDueDate})` : ''}`
        : 'Tax status not reported',
    });

    const motStatus = v.motStatus?.toLowerCase();
    const motDays = daysUntil(v.motExpiryDate, reference);
    checks.push({
      id: 'mot-status',
      label: 'MOT status',
      status:
        motStatus === 'valid' && (motDays === null || motDays > 30)
          ? 'pass'
          : motStatus === 'valid'
            ? 'warn'
            : motStatus === 'not valid'
              ? 'fail'
              : 'info',
      detail: v.motStatus
        ? `${v.motStatus}${v.motExpiryDate ? ` — expires ${v.motExpiryDate}` : ''}${
            motDays !== null && motDays <= 30 && motDays >= 0 ? ` (in ${motDays} days)` : ''
          }${motDays !== null && motDays < 0 ? ` (${Math.abs(motDays)} days ago)` : ''}`
        : 'MOT status not reported',
    });

    if (v.markedForExport) {
      checks.push({
        id: 'export',
        label: 'Export marker',
        status: 'warn',
        detail: 'This vehicle is marked for export',
      });
    }

    if (age && typeof v.yearOfManufacture === 'number') {
      const within = Math.abs(v.yearOfManufacture - age.approxYear) <= 1;
      checks.push({
        id: 'year-consistency',
        label: 'Plate age vs manufacture year',
        status: within ? 'pass' : 'warn',
        detail: within
          ? `Manufacture year ${v.yearOfManufacture} matches the age identifier (~${age.approxYear})`
          : `Manufacture year ${v.yearOfManufacture} differs from the plate's age identifier (~${age.approxYear}) — likely a private/cherished plate transfer`,
      });
    }

    return v;
  }

  private async runMotLookup(
    normalized: string,
    checks: CheckItem[],
    sources: Set<string>,
    reference: Date,
  ): Promise<PlateCheck['mot']> {
    const providerName = this.motProvider?.name ?? 'DVSA MOT History API';
    const result = await this.motProvider!.lookup(normalized);
    if (!result.ok || !result.data) {
      const detailMap: Record<string, string> = {
        not_found: 'No MOT history found for this registration (may be new or exempt)',
        rate_limited: `${providerName} rate limit hit`,
      };
      checks.push({
        id: 'mot-history',
        label: 'MOT test history',
        status: 'warn',
        detail: detailMap[result.reason ?? ''] ?? result.message ?? `${providerName} lookup failed`,
      });
      return null;
    }

    const mot = result.data;
    sources.add(this.motProvider!.name);
    const expiryDays = daysUntil(mot.motTestExpiryDate, reference);
    checks.push({
      id: 'mot-history',
      label: 'MOT test history',
      status:
        expiryDays !== null && expiryDays < 0
          ? 'fail'
          : expiryDays !== null && expiryDays <= 30
            ? 'warn'
            : 'pass',
      detail: `${mot.totalTests} tests (${mot.passed} passed, ${mot.failed} failed)${
        mot.motTestExpiryDate ? `; current certificate expires ${mot.motTestExpiryDate}` : ''
      }`,
      data: {
        totalTests: mot.totalTests,
        passed: mot.passed,
        failed: mot.failed,
        latestResult: mot.latestResult,
        latestOdometer: mot.latestOdometer,
      },
    });

    if (mot.mileageAnomaly) {
      checks.push({
        id: 'mileage',
        label: 'Odometer consistency',
        status: 'warn',
        detail: 'Recorded mileage decreases between MOT tests — possible clocking or data error',
      });
    } else if (mot.latestOdometer) {
      checks.push({
        id: 'mileage',
        label: 'Odometer consistency',
        status: 'pass',
        detail: `Mileage increases consistently; latest reading ${mot.latestOdometer.value.toLocaleString()} ${mot.latestOdometer.unit}`,
      });
    }

    return mot;
  }
}
