import { describe, expect, it } from 'vitest';
import { detectCountry } from './country.js';

describe('detectCountry', () => {
  it('detects a UK-shaped plate as GB', () => {
    expect(detectCountry('AB12CDE')).toBe('GB');
  });

  it('detects an AU-shaped plate as AU', () => {
    expect(detectCountry('ABC123')).toBe('AU');
  });

  it('falls back to unknown when neither matches', () => {
    expect(detectCountry('HELLOWORLD')).toBe('unknown');
  });

  it('honours an explicit hint over detection', () => {
    expect(detectCountry('AB12CDE', 'AU')).toBe('AU');
    expect(detectCountry('ABC123', 'GB')).toBe('GB');
  });
});
