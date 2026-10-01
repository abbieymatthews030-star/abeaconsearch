import { describe, expect, it } from 'vitest';
import { CalculationError, evaluateExpression } from './calculator.js';

describe('evaluateExpression', () => {
  it('evaluates basic arithmetic with correct precedence', () => {
    expect(evaluateExpression('42 * 18')).toBe(756);
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('10 - 2 - 3')).toBe(5);
  });

  it('supports parentheses, exponents, modulo, and unary minus', () => {
    expect(evaluateExpression('(1+2)*3')).toBe(9);
    expect(evaluateExpression('2^10')).toBe(1024);
    expect(evaluateExpression('10 % 3')).toBe(1);
    expect(evaluateExpression('-5 + 3')).toBe(-2);
  });

  it('evaluates a bare number', () => {
    expect(evaluateExpression('5')).toBe(5);
  });

  it('rejects division and modulo by zero', () => {
    expect(() => evaluateExpression('7/0')).toThrow(CalculationError);
    expect(() => evaluateExpression('7%0')).toThrow(CalculationError);
  });

  it('rejects malformed expressions instead of evaluating JS', () => {
    expect(() => evaluateExpression('')).toThrow(CalculationError);
    expect(() => evaluateExpression('1 +')).toThrow(CalculationError);
    expect(() => evaluateExpression('(1+2')).toThrow(CalculationError);
    expect(() => evaluateExpression('process.exit()')).toThrow(CalculationError);
  });
});
