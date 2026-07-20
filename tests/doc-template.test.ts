/** Template renderer: variable interpolation, items loop, {{#if}}, HTML-escaping.
    Loads public/js/doc-template.js into a sandbox (browser global + CommonJS guard). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function loadRenderer(): {
  renderTemplate: (body: string, ctx: unknown) => string;
  ORDER_VARIABLES: { group: string; items: { token: string; label: string }[] }[];
} {
  const dir = path.join(import.meta.dirname, '../public/js');
  const src = fs.readFileSync(path.join(dir, 'doc-template.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // shim require so inline {{= …}} formulas can pull in doc-formula.js
  const require2 = (p: string) => {
    const fsrc = fs.readFileSync(path.join(dir, p), 'utf8');
    const m: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', fsrc)(m, m.exports);
    return m.exports;
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require2);
  return mod.exports as never;
}

const { renderTemplate, ORDER_VARIABLES } = loadRenderer();

describe('renderTemplate', () => {
  it('interpolates dotted paths', () => {
    expect(renderTemplate('No: {{order.no}}', { order: { no: 'SO-1' } })).toBe('No: SO-1');
  });

  it('evaluates inline {{= formula }} tokens against the context', () => {
    expect(renderTemplate('{{= 2 + 3 * 4 }}', {})).toBe('14');
    const ctx = { order: { subtotal: 1375 }, items: [{ line_total: 1200 }, { line_total: 175 }] };
    expect(renderTemplate('Grand: {{= sum(items.line_total) * 1.12 }}', ctx)).toBe('Grand: 1,540');
    expect(renderTemplate('{{= bad + }}', {})).toBe(''); // malformed → empty, no throw
  });

  it('renders an empty string for missing variables', () => {
    expect(renderTemplate('[{{order.missing}}]', { order: {} })).toBe('[]');
  });

  it('HTML-escapes interpolated values', () => {
    const out = renderTemplate('{{x}}', { x: '<script>alert(1)</script>' });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('repeats an {{#items}} block with index', () => {
    const out = renderTemplate(
      '{{#items}}{{index}}:{{name}};{{/items}}',
      { items: [{ name: 'A' }, { name: 'B' }] }
    );
    expect(out).toBe('1:A;2:B;');
  });

  it('renders {{#if}} only when truthy (and 0 is falsy)', () => {
    expect(renderTemplate('{{#if v}}YES{{/if}}', { v: 1 })).toBe('YES');
    expect(renderTemplate('{{#if v}}YES{{/if}}', { v: 0 })).toBe('');
    expect(renderTemplate('{{#if v}}YES{{/if}}', {})).toBe('');
  });

  it('handles {{#if}} nested inside {{#items}}', () => {
    const out = renderTemplate(
      '{{#items}}{{name}}{{#if note}}({{note}}){{/if}} {{/items}}',
      { items: [{ name: 'A', note: 'x' }, { name: 'B' }] }
    );
    expect(out).toBe('A(x) B ');
  });

  it('exposes a variable catalog for the editor palette', () => {
    expect(Array.isArray(ORDER_VARIABLES)).toBe(true);
    const tokens = ORDER_VARIABLES.flatMap((g) => g.items.map((i) => i.token));
    expect(tokens).toContain('{{order.no}}');
    expect(tokens.some((t) => t.includes('#items'))).toBe(true);
  });
});
