import { describe, expect, it } from 'vitest';
import { classifyQuery } from './query-router.js';

describe('classifyQuery', () => {
  it('classifies bare domains', () => {
    expect(classifyQuery('example.com')).toEqual({ kind: 'domain', value: 'example.com' });
    expect(classifyQuery('Sub.Example.CO.UK')).toEqual({
      kind: 'domain',
      value: 'sub.example.co.uk',
    });
  });

  it('classifies IPv4 and IPv6 addresses before domains', () => {
    expect(classifyQuery('203.0.113.10')).toEqual({ kind: 'ip', value: '203.0.113.10' });
    expect(classifyQuery('::1')).toEqual({ kind: 'ip', value: '::1' });
  });

  it('classifies arithmetic expressions, but not bare numbers', () => {
    expect(classifyQuery('42 * 18')).toEqual({ kind: 'calculation', value: '42 * 18' });
    expect(classifyQuery('(1+2)*3')).toEqual({ kind: 'calculation', value: '(1+2)*3' });
    expect(classifyQuery('2024')).toEqual({ kind: 'default', value: '2024' });
  });

  it('classifies "plate <reg>" and takes only the first token', () => {
    expect(classifyQuery('plate ABC123 victoria')).toEqual({ kind: 'plate', value: 'ABC123' });
  });

  it('falls back to a plain search for everything else', () => {
    expect(classifyQuery('react hooks')).toEqual({ kind: 'default', value: 'react hooks' });
    expect(classifyQuery('node.js framework')).toEqual({
      kind: 'default',
      value: 'node.js framework',
    });
  });
});
