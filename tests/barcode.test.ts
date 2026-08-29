/** Code 128 barcode encoder (public/js/lib/barcode.js) — a browser classic script
    with no deps, loaded into a tiny sandbox the same way tests/frontend-nav.test.ts
    loads nav-config.js. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

interface BarcodeAPI {
  code128svg(text: string, opts?: Record<string, unknown>): string;
  _enc(text: string): number[];
}

function loadBarcode(): BarcodeAPI {
  const file = path.join(import.meta.dirname, '../public/js/lib/barcode.js');
  let src = fs.readFileSync(file, 'utf8');
  // expose the internal encoder for assertions
  src = src.replace(
    'window.Barcode = { code128svg: code128svg };',
    'window.Barcode = { code128svg: code128svg, _enc: encodeValues };'
  );
  const win: { Barcode?: BarcodeAPI } = {};
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return win.Barcode as BarcodeAPI;
}

const B = loadBarcode();

describe('code128 encoder', () => {
  it('produces the documented check digit for "Wikipedia" (88)', () => {
    const v = B._enc('Wikipedia');
    let sum = v[0]!;
    for (let i = 1; i < v.length; i++) sum += v[i]! * i;
    expect(sum % 103).toBe(88);
    expect(v[0]).toBe(104); // Start Code B
  });

  it('uses Code C for an even all-digit string', () => {
    expect(B._enc('12345678')).toEqual([105, 12, 34, 56, 78]);
  });

  it('stays in Code B for short mixed strings', () => {
    const v = B._enc('AB1');
    expect(v[0]).toBe(104);
    expect(v).toEqual([104, 'A'.charCodeAt(0) - 32, 'B'.charCodeAt(0) - 32, '1'.charCodeAt(0) - 32]);
  });

  it('substitutes "?" for characters outside Code 128 B', () => {
    const v = B._enc('A\tB'); // tab (9) is out of range → '?'
    expect(v).toEqual([104, 33, 63 - 32, 34]); // 'A'=33, '?'=31, 'B'=34
  });

  it('renders an <svg> with a white background and black bars', () => {
    const svg = B.code128svg('SKU-42', { height: 50, moduleWidth: 2 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('<g fill="#000">');
    expect(svg).toMatch(/<rect [^>]*height="50"/);
    // the human-readable caption is included
    expect(svg).toContain('>SKU-42<');
  });

  it('returns "" for empty input', () => {
    expect(B.code128svg('')).toBe('');
  });
});
