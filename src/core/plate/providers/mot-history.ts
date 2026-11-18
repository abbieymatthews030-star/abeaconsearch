import { DEFAULT_PLATE_TIMEOUT_MS } from '../../config.js';
import { fetchWithTimeout } from '../../http.js';
import type { MotSummary, MotTest } from '../types.js';
import type { MotProvider, ProviderResult } from './types.js';

export interface MotHistoryConfig {
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  tokenUrl?: string;
  scope?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration';
const DEFAULT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';

interface MotApiDefect {
  text?: string;
  type?: string;
  dangerous?: boolean;
}
interface MotApiTest {
  completedDate?: string;
  testResult?: string;
  expiryDate?: string;
  odometerValue?: string;
  odometerUnit?: string;
  motTestNumber?: string;
  defects?: MotApiDefect[];
}
interface MotApiVehicle {
  registration?: string;
  make?: string;
  model?: string;
  firstUsedDate?: string;
  fuelType?: string;
  primaryColour?: string;
  motTestExpiryDate?: string;
  motTests?: MotApiTest[];
}

/**
 * Client for the DVSA MOT History API (the 2024 "trade" API). Requires OAuth2
 * client-credentials plus an API key, from
 * https://documentation.history.mot.api.gov.uk/.
 */
export class MotHistoryProvider implements MotProvider {
  readonly name = 'DVSA MOT History API';
  private readonly cfg: Required<Omit<MotHistoryConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: MotHistoryConfig = {}) {
    this.cfg = {
      clientId: config.clientId?.trim() ?? '',
      clientSecret: config.clientSecret?.trim() ?? '',
      apiKey: config.apiKey?.trim() ?? '',
      tokenUrl: config.tokenUrl?.trim() ?? '',
      scope: config.scope?.trim() || DEFAULT_SCOPE,
      baseUrl: config.baseUrl?.trim() || DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs ?? DEFAULT_PLATE_TIMEOUT_MS,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  get configured(): boolean {
    return Boolean(
      this.cfg.clientId && this.cfg.clientSecret && this.cfg.apiKey && this.cfg.tokenUrl,
    );
  }

  private async accessToken(parentSignal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: this.cfg.scope,
    });
    const response = await fetchWithTimeout(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: this.cfg.timeoutMs,
      fetchImpl: this.cfg.fetchImpl,
      parentSignal,
    });
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    const json = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  async lookup(normalizedPlate: string, signal?: AbortSignal): Promise<ProviderResult<MotSummary>> {
    if (!this.configured) return { ok: false, reason: 'unconfigured' };

    try {
      const token = await this.accessToken(signal);
      const response = await fetchWithTimeout(
        `${this.cfg.baseUrl}/${encodeURIComponent(normalizedPlate)}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            'x-api-key': this.cfg.apiKey,
            accept: 'application/json',
          },
          timeoutMs: this.cfg.timeoutMs,
          fetchImpl: this.cfg.fetchImpl,
          parentSignal: signal,
        },
      );

      if (response.status === 404) return { ok: false, reason: 'not_found' };
      if (response.status === 429) return { ok: false, reason: 'rate_limited' };
      if (!response.ok) {
        return { ok: false, reason: 'error', message: `MOT API returned HTTP ${response.status}` };
      }

      const payload = (await response.json()) as MotApiVehicle | MotApiVehicle[];
      const vehicle = Array.isArray(payload) ? payload[0] : payload;
      if (!vehicle) return { ok: false, reason: 'not_found' };

      return { ok: true, data: summarise(vehicle, this.name) };
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function summarise(vehicle: MotApiVehicle, source: string): MotSummary {
  const tests: MotTest[] = (vehicle.motTests ?? []).map((t) => ({
    completedDate: t.completedDate,
    testResult: t.testResult,
    expiryDate: t.expiryDate,
    odometerValue: t.odometerValue ? Number(t.odometerValue) : undefined,
    odometerUnit: t.odometerUnit,
    motTestNumber: t.motTestNumber,
    defects: (t.defects ?? []).map((d) => ({ text: d.text, type: d.type, dangerous: d.dangerous })),
  }));

  const chronological = [...tests].sort((a, b) =>
    (a.completedDate ?? '').localeCompare(b.completedDate ?? ''),
  );
  let mileageAnomaly = false;
  let previous = -Infinity;
  for (const test of chronological) {
    if (typeof test.odometerValue === 'number') {
      if (test.odometerValue + 500 < previous) mileageAnomaly = true;
      previous = Math.max(previous, test.odometerValue);
    }
  }

  const latest = chronological[chronological.length - 1];
  // The trade API has no vehicle-level expiry; use the newest passed test's.
  const latestPassedExpiry = [...chronological]
    .reverse()
    .find((t) => t.testResult?.toUpperCase() === 'PASSED' && t.expiryDate)?.expiryDate;

  return {
    registration: vehicle.registration,
    make: vehicle.make,
    model: vehicle.model,
    firstUsedDate: vehicle.firstUsedDate,
    fuelType: vehicle.fuelType,
    primaryColour: vehicle.primaryColour,
    motTestExpiryDate: vehicle.motTestExpiryDate ?? latestPassedExpiry,
    totalTests: tests.length,
    passed: tests.filter((t) => t.testResult?.toUpperCase() === 'PASSED').length,
    failed: tests.filter((t) => t.testResult?.toUpperCase() === 'FAILED').length,
    latestResult: latest?.testResult,
    latestOdometer:
      latest && typeof latest.odometerValue === 'number'
        ? { value: latest.odometerValue, unit: latest.odometerUnit ?? 'mi' }
        : undefined,
    mileageAnomaly,
    tests: chronological.reverse(),
    source,
  };
}
