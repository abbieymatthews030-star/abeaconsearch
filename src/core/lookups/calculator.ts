/** Thrown for a malformed or unsafe arithmetic expression. */
export class CalculationError extends Error {}

/**
 * Evaluate a plain arithmetic expression (+ - * / % ^, parens, decimals).
 * A hand-written recursive-descent parser — never `eval`/`Function` — so a
 * query typed into the search box can never reach arbitrary JS execution.
 */
export function evaluateExpression(expression: string): number {
  const s = expression.replace(/\s+/g, '');
  if (!s) throw new CalculationError('empty expression');

  let pos = 0;
  const peek = (): string | undefined => s[pos];
  const fail = (message: string): never => {
    throw new CalculationError(message);
  };

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') return value;
      pos++;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return value;
      pos++;
      const rhs = parseFactor();
      if ((op === '/' || op === '%') && rhs === 0) fail('division by zero');
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
  }

  function parseFactor(): number {
    if (peek() === '-') {
      pos++;
      return -parseFactor();
    }
    if (peek() === '+') {
      pos++;
      return parseFactor();
    }
    const base = parseAtom();
    if (peek() === '^') {
      pos++;
      return Math.pow(base, parseFactor());
    }
    return base;
  }

  function parseAtom(): number {
    if (peek() === '(') {
      pos++;
      const value = parseExpr();
      if (peek() !== ')') fail('missing closing parenthesis');
      pos++;
      return value;
    }
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos] as string)) pos++;
    if (pos === start) fail(`unexpected character "${s[pos] ?? ''}"`);
    const text = s.slice(start, pos);
    const value = Number(text);
    if (Number.isNaN(value)) fail(`"${text}" is not a valid number`);
    return value;
  }

  const result = parseExpr();
  if (pos !== s.length) fail(`unexpected character "${s[pos]}"`);
  if (!Number.isFinite(result)) fail('result is not a finite number');
  return result;
}
