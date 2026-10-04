import { describe, expect, it } from 'vitest';
import { selectGroundedClaims, splitSentences, weaveExtractive } from './extract.js';
import type { RetrievedSource } from './retrieval.js';

function source(
  partial: Partial<RetrievedSource> & Pick<RetrievedSource, 'id' | 'text'>,
): RetrievedSource {
  return {
    title: 'T',
    origin: 'web',
    trust: 'established',
    trustReason: '',
    live: true,
    retrievedAt: new Date().toISOString(),
    relevanceScore: 1,
    contentQualityScore: 1,
    sourceQualityScore: 0.8,
    entityMatchType: 'n/a',
    identityMatchScore: 1,
    isBoilerplate: false,
    usableForAnswer: true,
    reason: 'usable evidence',
    ...partial,
  };
}

describe('splitSentences', () => {
  it('splits on sentence boundaries but keeps abbreviations and initials together', () => {
    expect(splitSentences('The cat sat. The dog ran.')).toEqual(['The cat sat.', 'The dog ran.']);
    expect(splitSentences('Dr. Smith arrived. He was late.')).toEqual([
      'Dr. Smith arrived.',
      'He was late.',
    ]);
  });
});

describe('selectGroundedClaims', () => {
  it('picks the sentences that best match the query and ties them to their source', () => {
    const sources = [
      source({
        id: 1,
        text: 'Penguins are flightless birds. They live mainly in the Southern Hemisphere. Bananas are yellow.',
      }),
      source({ id: 2, text: 'Completely unrelated text about tax law and invoices.' }),
    ];
    const claims = selectGroundedClaims('where do penguins live', sources);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.sourceId === 1)).toBe(true);
    expect(claims.some((c) => c.text.toLowerCase().includes('hemisphere'))).toBe(true);
  });
});

describe('weaveExtractive', () => {
  it('joins claims with bracketed citation markers', () => {
    const woven = weaveExtractive([
      { text: 'Water boils at 100C', sourceId: 2, score: 1 },
      { text: 'Ice melts at 0C.', sourceId: 3, score: 1 },
    ]);
    expect(woven).toBe('Water boils at 100C [2]. Ice melts at 0C [3].');
  });

  it('returns an empty string when there are no claims', () => {
    expect(weaveExtractive([])).toBe('');
  });
});
