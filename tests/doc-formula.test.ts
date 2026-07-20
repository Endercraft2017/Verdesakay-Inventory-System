/** Formula engine: arithmetic, functions, column sums, refs, safety. Sandbox-loaded. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function load(): { evalFormula: (e: string, s: unknown) => unknown; toNumber: (v: unknown) => number } {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../public/js/doc-formula.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as never;
}
const { evalFormula, toNumber } = load();

describe('doc-formula', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(evalFormula('2 + 3 * 4', {})).toBe(14);
    expect(evalFormula('(2 + 3) * 4', {})).toBe(20);
    expect(evalFormula('10 / 4', {})).toBe(2.5);
  });

  it('guards divide-by-zero', () => {
    expect(evalFormula('5 / 0', {})).toBe(0);
  });

  it('resolves dotted references', () => {
    expect(evalFormula('order.subtotal * 1.12', { order: { subtotal: 100 } })).toBeCloseTo(112);
  });

  it('coerces formatted-number strings', () => {
    expect(toNumber('1,200.00')).toBe(1200);
    expect(evalFormula('a + b', { a: '1,000.50', b: '2,000.50' })).toBe(3001);
  });

  it('sums a column across an items array', () => {
    const scope = { items: [{ line_total: '1,200.00' }, { line_total: 175 }, { line_total: 25 }] };
    expect(evalFormula('sum(items.line_total)', scope)).toBe(1400);
    expect(evalFormula('count(items)', scope)).toBe(3);
    expect(evalFormula('avg(items.line_total)', scope)).toBeCloseTo(466.6667, 3);
  });

  it('supports round(), min(), max()', () => {
    expect(evalFormula('round(3.14159, 2)', {})).toBe(3.14);
    expect(evalFormula('max(items.q)', { items: [{ q: 2 }, { q: 9 }, { q: 5 }] })).toBe(9);
    expect(evalFormula('min(3, 7, 1)', {})).toBe(1);
  });

  it('builds subtotal → tax → grand chains via the scope', () => {
    const scope: Record<string, unknown> = { items: [{ lt: 1000 }, { lt: 375 }] };
    scope.subtotal = evalFormula('sum(items.lt)', scope);
    scope.tax = evalFormula('subtotal * 0.12', scope);
    scope.grand = evalFormula('subtotal + tax', scope);
    expect(scope.subtotal).toBe(1375);
    expect(scope.tax).toBeCloseTo(165);
    expect(scope.grand).toBeCloseTo(1540);
  });

  it('throws on malformed input (caller catches)', () => {
    expect(() => evalFormula('2 +', {})).toThrow();
    expect(() => evalFormula('bogus(', {})).toThrow();
  });
});
