import { describe, expect, it } from 'vitest';
import { classifyTrust, trustWeight } from './trust.js';

describe('classifyTrust', () => {
  it('marks gov / ac.uk / IGO domains as official', () => {
    expect(classifyTrust('https://www.gov.uk/vat-rates', 'web').tier).toBe('official');
    expect(classifyTrust('https://cam.ac.uk/x', 'web').tier).toBe('official');
    expect(classifyTrust('https://www.cdc.gov/flu', 'web').tier).toBe('official');
    expect(classifyTrust('https://europa.eu/x', 'web').tier).toBe('official');
  });

  it('marks curated reference / publisher domains as established', () => {
    expect(classifyTrust('https://en.wikipedia.org/wiki/Cat', 'web').tier).toBe('established');
    expect(classifyTrust('https://www.reuters.com/world/x', 'web').tier).toBe('established');
    expect(classifyTrust('https://arxiv.org/abs/1234.5678', 'web').tier).toBe('established');
    expect(classifyTrust('https://doi.org/10.1000/xyz', 'web').tier).toBe('established');
    expect(classifyTrust('https://www.wikidata.org/wiki/Q42', 'web').tier).toBe('established');
    expect(classifyTrust('https://archive.org/details/foo', 'web').tier).toBe('established');
  });

  it('marks other URLs as community and missing URLs as unverified', () => {
    expect(classifyTrust('https://some-blog.example/post', 'web').tier).toBe('community');
    expect(classifyTrust(undefined, 'web').tier).toBe('unverified');
    expect(classifyTrust('not a url', 'web').tier).toBe('unverified');
  });

  it('promotes configured trusted domains to official', () => {
    const v = classifyTrust('https://docs.internal.example/x', 'web', ['internal.example']);
    expect(v.tier).toBe('official');
  });

  it('orders trust weights official > established > community > unverified', () => {
    expect(trustWeight('official')).toBeGreaterThan(trustWeight('established'));
    expect(trustWeight('established')).toBeGreaterThan(trustWeight('community'));
    expect(trustWeight('community')).toBeGreaterThan(trustWeight('unverified'));
  });
});
