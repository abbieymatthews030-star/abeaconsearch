import { describe, expect, it } from 'vitest';
import { PlateChecker } from '../checker.js';
import {
  DEFAULT_COUNTRY_CODE,
  listCountries,
  normalizeCountryCode,
  resolveCountry,
} from './index.js';

describe('plate countries registry', () => {
  it('defaults to GB and lists unique ISO codes', () => {
    expect(DEFAULT_COUNTRY_CODE).toBe('GB');
    const countries = listCountries();
    expect(countries.length).toBeGreaterThan(20);
    expect(countries[0]?.code).toBe('GB');
    const codes = countries.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(countries.every((c) => c.example && c.placeholder && c.summary)).toBe(true);
  });

  it('resolves aliases such as UK → GB', () => {
    expect(normalizeCountryCode('uk')).toBe('GB');
    expect(normalizeCountryCode('USA')).toBe('US');
    expect(resolveCountry('UK').code).toBe('GB');
    expect(() => resolveCountry('ZZ')).toThrow(/Unknown plate country/);
  });
});

describe('country format checks', () => {
  const checker = new PlateChecker({ now: () => new Date('2026-09-01T00:00:00Z') });

  it('validates a French SIV plate and skips live vehicle APIs', async () => {
    const report = await checker.check('AB-123-CD', {
      country: 'FR',
      includeVehicleData: true,
      includeMotHistory: true,
    });
    expect(report.valid).toBe(true);
    expect(report.country).toEqual({ code: 'FR', name: 'France' });
    expect(report.format).toBe('fr-siv');
    expect(report.formatted).toBe('AB-123-CD');
    expect(report.checks.find((c) => c.id === 'dvla-record')?.status).toBe('skipped');
    expect(report.checks.find((c) => c.id === 'mot-history')?.status).toBe('skipped');
    expect(report.checks.find((c) => c.id === 'dvla-record')?.detail).toMatch(/France/);
  });

  it('rejects SIV plates that use I/O/U', async () => {
    const report = await checker.check('AI-123-CD', { country: 'FR', includeVehicleData: false });
    expect(report.valid).toBe(false);
    expect(report.summary.status).toBe('invalid');
  });

  it('decodes an Irish county and year', async () => {
    const report = await checker.check('241-D-12345', {
      country: 'IE',
      includeVehicleData: false,
      includeMotHistory: false,
    });
    expect(report.valid).toBe(true);
    expect(report.format).toBe('ie-current');
    expect(report.age?.approxYear).toBe(2024);
    expect(report.region?.region).toBe('Dublin');
    expect(report.formatted).toBe('241-D-12345');
  });

  it('validates Spanish 2000– plates without vowels', async () => {
    const ok = await checker.check('1234 BBC', { country: 'ES', includeVehicleData: false });
    expect(ok.valid).toBe(true);
    expect(ok.format).toBe('es-current');
    const bad = await checker.check('1234 ABA', { country: 'ES', includeVehicleData: false });
    expect(bad.valid).toBe(false);
  });

  it('validates German distinguishing-sign layout', async () => {
    const report = await checker.check('B AB 1234', { country: 'DE', includeVehicleData: false });
    expect(report.valid).toBe(true);
    expect(report.format).toBe('de-standard');
    expect(report.region?.memoryTag).toBe('B');
    expect(report.region?.region).toBe('Distinguishing sign B');
    expect(report.formatted).toBe('B AB 1234');
  });

  it('validates Brazilian Mercosur plates', async () => {
    const report = await checker.check('ABC1D23', { country: 'BR', includeVehicleData: false });
    expect(report.valid).toBe(true);
    expect(report.format).toBe('br-mercosur');
  });

  it('validates Indian RTO plates and BH series year', async () => {
    const rto = await checker.check('MH 12 AB 1234', { country: 'IN', includeVehicleData: false });
    expect(rto.valid).toBe(true);
    expect(rto.region?.memoryTag).toBe('MH');
    const bh = await checker.check('22 BH 1234 AA', { country: 'IN', includeVehicleData: false });
    expect(bh.valid).toBe(true);
    expect(bh.age?.approxYear).toBe(2022);
  });

  it('keeps GB behaviour and country metadata', async () => {
    const report = await checker.check('AB12 CDE', {
      country: 'GB',
      includeVehicleData: false,
      includeMotHistory: false,
    });
    expect(report.valid).toBe(true);
    expect(report.country.code).toBe('GB');
    expect(report.format).toBe('current');
    expect(report.region?.office).toBe('Peterborough');
  });

  it('accepts US general plates and explains state variance', async () => {
    const report = await checker.check('ABC 1234', { country: 'US', includeVehicleData: false });
    expect(report.valid).toBe(true);
    expect(report.format).toBe('us-general');
    expect(report.notices.some((n) => /state/i.test(n))).toBe(true);
  });
});
