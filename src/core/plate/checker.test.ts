import { describe, expect, it } from 'vitest';
import { PlateChecker } from './checker.js';
import type { MotProvider, VehicleProvider } from './providers/types.js';
import type { MotSummary, VehicleRecord } from './types.js';

const NOW = () => new Date('2026-09-01T00:00:00Z');

function vehicleProvider(data: Partial<VehicleRecord> | null): VehicleProvider {
  return {
    name: 'stub VES',
    configured: true,
    lookup: async () =>
      data
        ? { ok: true, data: { source: 'stub VES', ...data } }
        : { ok: false, reason: 'not_found' },
  };
}

function motProvider(data: Partial<MotSummary> | null): MotProvider {
  return {
    name: 'stub MOT',
    configured: true,
    lookup: async () =>
      data
        ? {
            ok: true,
            data: {
              totalTests: 0,
              passed: 0,
              failed: 0,
              mileageAnomaly: false,
              tests: [],
              source: 'stub MOT',
              ...data,
            },
          }
        : { ok: false, reason: 'not_found' },
  };
}

describe('PlateChecker (offline)', () => {
  const checker = new PlateChecker({ now: NOW });

  it('passes every check for a well-formed current plate', async () => {
    const report = await checker.check('AB12 CDE');
    expect(report.valid).toBe(true);
    expect(report.format).toBe('current');
    expect(report.summary.status).toBe('ok');
    expect(report.summary.fail).toBe(0);
    expect(report.age?.approxYear).toBe(2012);
    expect(report.region).toMatchObject({ region: 'Anglia', office: 'Peterborough' });
    expect(report.checks.find((c) => c.id === 'dvla-record')?.status).toBe('skipped');
  });

  it('fails an unrecognised registration', async () => {
    const report = await checker.check('NOTAPLATE!!');
    expect(report.valid).toBe(false);
    expect(report.format).toBe('unknown');
    expect(report.summary.status).toBe('invalid');
    expect(report.checks.find((c) => c.id === 'format')?.status).toBe('fail');
  });

  it('flags a future age identifier as a failure', async () => {
    const report = await checker.check('AB77 CDE');
    expect(report.checks.find((c) => c.id === 'age')?.status).toBe('fail');
  });

  it('treats a prefix plate age as informational', async () => {
    const report = await checker.check('A123 BCD');
    expect(report.format).toBe('prefix');
    const age = report.checks.find((c) => c.id === 'age');
    expect(age?.status).toBe('info');
  });

  it('honours a reference date', async () => {
    const report = await checker.check('AB12 CDE', { referenceDate: '2013-01-01T00:00:00Z' });
    expect(report.age?.ageYears).toBeLessThan(1);
  });
});

describe('PlateChecker (Australia)', () => {
  const checker = new PlateChecker({ now: NOW });

  it('auto-detects and validates an AU-shaped plate', async () => {
    const report = await checker.check('ABC123');
    expect(report.country).toBe('AU');
    expect(report.valid).toBe(true);
    expect(report.format).toBe('general-au');
    expect(report.summary.status).toBe('ok');
    expect(report.age).toBeNull();
    expect(report.region).toBeNull();
    expect(report.checks.find((c) => c.id === 'age')?.status).toBe('info');
    expect(report.checks.find((c) => c.id === 'region')?.data?.likelyStates).toContain('Victoria');
  });

  it('skips DVLA/DVSA lookups for an AU plate even when requested', async () => {
    const checker2 = new PlateChecker({
      now: NOW,
      vehicleProvider: {
        name: 'stub VES',
        configured: true,
        lookup: async () => ({ ok: false, reason: 'not_found' }),
      },
    });
    const report = await checker2.check('ABC123', { includeVehicleData: true });
    expect(report.vehicle).toBeNull();
    expect(report.checks.find((c) => c.id === 'dvla-record')?.status).toBe('skipped');
  });

  it('forces AU interpretation via options.country even for a UK-shaped plate', async () => {
    const report = await checker.check('AB12CDE', { country: 'AU' });
    expect(report.country).toBe('AU');
    expect(report.valid).toBe(false);
  });

  it('forces GB interpretation via options.country even for an AU-shaped plate', async () => {
    // AB12CD is a valid NSW-style shape but matches no GB era (current is 7
    // chars; the loose dateless bucket needs a single trailing letter, not two).
    const report = await checker.check('AB12CD', { country: 'GB' });
    expect(report.country).toBe('GB');
    expect(report.valid).toBe(false);
  });

  it('reports an unrecognised plate as unknown country, not GB', async () => {
    const report = await checker.check('NOTAPLATE123456');
    expect(report.country).toBe('unknown');
    expect(report.valid).toBe(false);
    expect(report.summary.status).toBe('invalid');
  });
});

describe('PlateChecker (with providers)', () => {
  it('adds tax, MOT and year-consistency checks from DVLA data', async () => {
    const checker = new PlateChecker({
      now: NOW,
      vehicleProvider: vehicleProvider({
        make: 'FORD',
        colour: 'BLUE',
        yearOfManufacture: 2012,
        taxStatus: 'Taxed',
        taxDueDate: '2027-01-01',
        motStatus: 'Valid',
        motExpiryDate: '2027-05-01',
      }),
    });
    const report = await checker.check('AB12 CDE');
    expect(report.vehicle?.make).toBe('FORD');
    expect(report.checks.find((c) => c.id === 'tax')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'mot-status')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'year-consistency')?.status).toBe('pass');
    expect(report.summary.headline).toContain('FORD');
  });

  it('warns when the manufacture year contradicts the plate age', async () => {
    const checker = new PlateChecker({
      now: NOW,
      vehicleProvider: vehicleProvider({
        make: 'BMW',
        yearOfManufacture: 2004,
        taxStatus: 'Taxed',
      }),
    });
    const report = await checker.check('AB12 CDE');
    expect(report.checks.find((c) => c.id === 'year-consistency')?.status).toBe('warn');
    expect(report.summary.status).toBe('attention');
  });

  it('fails when the vehicle is untaxed', async () => {
    const checker = new PlateChecker({
      now: NOW,
      vehicleProvider: vehicleProvider({ make: 'VW', taxStatus: 'Untaxed' }),
    });
    const report = await checker.check('AB12 CDE');
    expect(report.checks.find((c) => c.id === 'tax')?.status).toBe('fail');
    expect(report.summary.status).toBe('fail');
  });

  it('uses "invalid" only for a malformed mark, "fail" for a valid mark with a failed check', async () => {
    const offline = new PlateChecker({ now: NOW });
    expect((await offline.check('NOPE!')).summary.status).toBe('invalid');
    const taxed = new PlateChecker({
      now: NOW,
      vehicleProvider: vehicleProvider({ make: 'VW', taxStatus: 'Untaxed' }),
    });
    expect((await taxed.check('AB12 CDE')).summary.status).toBe('fail');
  });

  it('summarises MOT history and flags mileage anomalies', async () => {
    const checker = new PlateChecker({
      now: NOW,
      motProvider: motProvider({
        totalTests: 3,
        passed: 2,
        failed: 1,
        motTestExpiryDate: '2027-03-01',
        mileageAnomaly: true,
        latestOdometer: { value: 60000, unit: 'mi' },
      }),
    });
    const report = await checker.check('AB12 CDE');
    expect(report.mot?.totalTests).toBe(3);
    expect(report.checks.find((c) => c.id === 'mot-history')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'mileage')?.status).toBe('warn');
  });

  it('reports provider capabilities', () => {
    const checker = new PlateChecker({ vehicleProvider: vehicleProvider({}), now: NOW });
    expect(checker.capabilities).toEqual({ vehicleData: true, motHistory: false });
  });
});
