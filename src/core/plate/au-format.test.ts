import { describe, expect, it } from 'vitest';
import { classifyAuPlate, formatAuPlate } from './au-format.js';
import { normalizePlate } from './format.js';

describe('classifyAuPlate', () => {
  const cases: Array<[string, string, boolean]> = [
    ['AB12CD', 'nsw-style', true],
    ['123ABC', 'qld-style', true],
    ['ABC123', 'general-au', true],
    ['HELLOWORLD', 'unknown', false],
    ['', 'unknown', false],
  ];

  it.each(cases)('classifies %s as %s (valid=%s)', (plate, shape, valid) => {
    const result = classifyAuPlate(normalizePlate(plate));
    expect(result.shape).toBe(shape);
    expect(result.valid).toBe(valid);
  });

  it('does not claim a single definitive state for the shared shape', () => {
    const result = classifyAuPlate('ABC123');
    expect(result.likelyStates.length).toBeGreaterThan(1);
  });

  it('gives a single likely state only for the NSW- and QLD-specific shapes', () => {
    expect(classifyAuPlate('AB12CD').likelyStates).toEqual(['New South Wales']);
    expect(classifyAuPlate('123ABC').likelyStates).toEqual(['Queensland']);
  });
});

describe('formatAuPlate', () => {
  it('inserts the conventional spacing per shape', () => {
    expect(formatAuPlate('AB12CD', 'nsw-style')).toBe('AB 12 CD');
    expect(formatAuPlate('123ABC', 'qld-style')).toBe('123 ABC');
    expect(formatAuPlate('ABC123', 'general-au')).toBe('ABC 123');
  });
});
