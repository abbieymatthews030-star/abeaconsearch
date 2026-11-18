import { DEFAULT_PLATE_TIMEOUT_MS } from '../../config.js';
import { fetchWithTimeout } from '../../http.js';
import type { VehicleRecord } from '../types.js';
import type { ProviderResult, VehicleProvider } from './types.js';

export interface DvlaVesConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

interface VesResponse {
  registrationNumber?: string;
  make?: string;
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
}

/**
 * Client for the UK Government DVLA Vehicle Enquiry Service (VES) — a free,
 * official API returning tax/MOT status and basic vehicle details. Requires an
 * API key from https://register-for-vehicle-enquiry-service.service.gov.uk/.
 */
export class DvlaVesProvider implements VehicleProvider {
  readonly name = 'DVLA Vehicle Enquiry Service';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DvlaVesConfig = {}) {
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_PLATE_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async lookup(
    normalizedPlate: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<VehicleRecord>> {
    if (!this.apiKey) return { ok: false, reason: 'unconfigured' };

    try {
      const response = await fetchWithTimeout(this.baseUrl, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ registrationNumber: normalizedPlate }),
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        parentSignal: signal,
      });

      if (response.status === 404) return { ok: false, reason: 'not_found' };
      if (response.status === 429) return { ok: false, reason: 'rate_limited' };
      if (!response.ok) {
        return { ok: false, reason: 'error', message: `DVLA VES returned HTTP ${response.status}` };
      }

      const body = (await response.json()) as VesResponse;
      return {
        ok: true,
        data: {
          registrationNumber: body.registrationNumber,
          make: body.make,
          colour: body.colour,
          fuelType: body.fuelType,
          yearOfManufacture: body.yearOfManufacture,
          monthOfFirstRegistration: body.monthOfFirstRegistration,
          engineCapacity: body.engineCapacity,
          co2Emissions: body.co2Emissions,
          euroStatus: body.euroStatus,
          taxStatus: body.taxStatus,
          taxDueDate: body.taxDueDate,
          motStatus: body.motStatus,
          motExpiryDate: body.motExpiryDate,
          markedForExport: body.markedForExport,
          wheelplan: body.wheelplan,
          dateOfLastV5CIssued: body.dateOfLastV5CIssued,
          revenueWeight: body.revenueWeight,
          typeApproval: body.typeApproval,
          source: this.name,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
