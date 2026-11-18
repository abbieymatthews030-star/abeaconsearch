import { decodeAge } from './age.js';
import { classifyPlate, formatPlate, normalizePlate } from './format.js';
import { lookupMemoryTag } from './regions.js';
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

  get capabilities(): { vehicleData: boolean; motHistory: boolean } {
    return {
      vehicleData: Boolean(this.vehicleProvider?.configured),
      motHistory: Boolean(this.motProvider?.configured),
    };
  }

  /** The wired providers, so callers can reuse them (shared token cache etc.). */
  get providers(): { vehicle?: VehicleProvider; mot?: MotProvider } {
    return { vehicle: this.vehicleProvider, mot: this.motProvider };
  }

  async check(input: string, options: PlateCheckOptions = {}): Promise<PlateCheck> {
    const parsedRef = options.referenceDate ? new Date(options.referenceDate) : null;
    const reference = parsedRef && !Number.isNaN(parsedRef.getTime()) ? parsedRef : this.now();
    const normalized = normalizePlate(input);
    const classification = classifyPlate(normalized);
    const formatted = formatPlate(normalized, classification.format);
    const checks: CheckItem[] = [];
    const sources = new Set<string>(['Offline plate analysis']);

    // 1. Format --------------------------------------------------------------
    checks.push({
      id: 'format',
      label: 'Registration format',
      status: classification.valid ? 'pass' : 'fail',
      detail: classification.valid
        ? `Matches the UK ${classification.format} plate format`
        : (classification.reason ?? 'Not a recognised UK registration mark'),
      data: { format: classification.format },
    });

    checks.push({
      id: 'characters',
      label: 'Character set',
      status: /^[A-Z0-9]{1,8}$/.test(normalized) && normalized.length >= 2 ? 'pass' : 'fail',
      detail:
        normalized.length === 0
          ? 'No registration characters supplied'
          : `${normalized.length} characters after normalisation`,
    });

    // 2. Age ---------------------------------------------------------------
    const age = decodeAge(normalized, classification.format, reference);
    if (classification.format === 'current') {
      if (age) {
        checks.push({
          id: 'age',
          label: 'Age identifier',
          status: 'pass',
          detail: `"${age.identifier}" → ${age.description} (about ${age.ageYears} years old)`,
          data: { ...age },
        });
      } else {
        checks.push({
          id: 'age',
          label: 'Age identifier',
          status: 'fail',
          detail: `"${normalized.slice(2, 4)}" is not a valid age identifier for a date up to ${reference.toISOString().slice(0, 10)} (future or out-of-range plate)`,
        });
      }
    } else if (age) {
      checks.push({
        id: 'age',
        label: 'Age identifier',
        status: 'info',
        detail: `${age.description} (${classification.format} format, about ${age.ageYears} years old)`,
        data: { ...age },
      });
    }

    // 3. Region (memory tag) --------------------------------------------------
    let region = null as PlateCheck['region'];
    if (classification.format === 'current') {
      region = lookupMemoryTag(normalized.slice(0, 2));
      checks.push({
        id: 'region',
        label: 'Region of registration',
        status: region ? 'pass' : 'warn',
        detail: region
          ? `${normalized.slice(0, 2)} → ${region.office}, ${region.region} (${region.country})`
          : `Memory tag "${normalized.slice(0, 2)}" is not in the DVLA table`,
        data: region ? { ...region } : undefined,
      });
    } else if (classification.format === 'northern-ireland') {
      region = {
        memoryTag: normalized.replace(/[0-9]/g, ''),
        region: 'Northern Ireland',
        office: 'Northern Ireland (dateless series)',
        country: 'Northern Ireland',
      };
      checks.push({
        id: 'region',
        label: 'Region of registration',
        status: 'info',
        detail: 'Northern Ireland dateless format (contains I or Z) — no age can be derived',
      });
    }

    // 4. DVLA Vehicle Enquiry Service ---------------------------------------
    let vehicle: VehicleRecord | null = null;
    if ((options.includeVehicleData ?? true) && classification.valid) {
      vehicle = await this.runVehicleLookup(normalized, checks, sources, age, reference);
    } else {
      checks.push({
        id: 'dvla-record',
        label: 'DVLA vehicle record',
        status: 'skipped',
        detail: !classification.valid
          ? 'Skipped — registration is not structurally valid'
          : 'Skipped — vehicle data lookup was not requested',
      });
    }

    // 5. MOT history -------------------------------------------------------
    let mot: PlateCheck['mot'] = null;
    if (
      (options.includeMotHistory ?? true) &&
      classification.valid &&
      this.motProvider?.configured
    ) {
      mot = await this.runMotLookup(normalized, checks, sources, reference);
    } else {
      checks.push({
        id: 'mot-history',
        label: 'MOT test history',
        status: 'skipped',
        detail: !classification.valid
          ? 'Skipped — registration is not structurally valid'
          : (options.includeMotHistory ?? true)
            ? 'Skipped — DVSA MOT History API credentials are not configured'
            : 'Skipped — MOT history lookup was not requested',
      });
    }

    // 6. Theft / finance — no free open API; guidance only (not a check line)
    const notices: string[] = [
      'Stolen / outstanding finance / write-off status was not checked — those need a paid provider (e.g. an HPI-style check).',
    ];

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
      age,
      region,
      vehicle,
      mot,
      checks,
      summary: {
        status,
        headline: this.headline(status, classification.valid, vehicle, liveSkipped),
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
  ): string {
    if (!valid) return 'Not a valid UK registration mark';
    const desc = vehicle?.make
      ? `${[vehicle.colour, vehicle.make].filter(Boolean).join(' ')}${
          vehicle.yearOfManufacture ? ` (${vehicle.yearOfManufacture})` : ''
        }`
      : 'Valid UK registration';
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

    // Tax
    const taxed = v.taxStatus?.toLowerCase();
    checks.push({
      id: 'tax',
      label: 'Vehicle tax',
      status: taxed === 'taxed' ? 'pass' : taxed === 'sorn' ? 'warn' : taxed ? 'fail' : 'info',
      detail: v.taxStatus
        ? `${v.taxStatus}${v.taxDueDate ? ` (due ${v.taxDueDate})` : ''}`
        : 'Tax status not reported',
    });

    // MOT status (from VES — coarse; MOT history API is more detailed)
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

    // Export marker
    if (v.markedForExport) {
      checks.push({
        id: 'export',
        label: 'Export marker',
        status: 'warn',
        detail: 'This vehicle is marked for export',
      });
    }

    // Year vs plate-age consistency
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
      // `unconfigured` never reaches here — check() guards the call site.
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
