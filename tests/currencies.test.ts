/** currencies.js catalog sanity: unique 3-letter codes, names present, common
    codes included. Sandbox-loaded like the other browser-global config files. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Currency = { code: string; name: string };

function loadCurrencies(): Currency[] {
  const file = path.join(import.meta.dirname, '../public/js/currencies.js');
  const src = fs.readFileSync(file, 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return (mod.exports as { CURRENCIES: Currency[] }).CURRENCIES;
}

const CURRENCIES = loadCurrencies();

describe('currencies catalog', () => {
  it('has a healthy number of entries', () => {
    expect(CURRENCIES.length).toBeGreaterThan(140);
  });

  it('every entry is a 3-letter uppercase code with a name', () => {
    for (const c of CURRENCIES) {
      expect(c.code, `bad code ${JSON.stringify(c)}`).toMatch(/^[A-Z]{3}$/);
      expect(typeof c.name === 'string' && c.name.trim().length > 0, `${c.code} needs a name`).toBe(true);
    }
  });

  it('codes are unique', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('includes the currencies the app defaults to / commonly uses', () => {
    const codes = new Set(CURRENCIES.map((c) => c.code));
    for (const code of ['PHP', 'USD', 'EUR', 'JPY', 'GBP', 'AUD', 'CNY']) {
      expect(codes.has(code), `missing ${code}`).toBe(true);
    }
  });
});
