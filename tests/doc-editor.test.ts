/** DocEditor pure transforms: stored body ⇄ editor HTML round-trip. Uses jsdom for
    the DOM-based serializer; bodyToEditorHtml is pure string→string. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

function load(): {
  bodyToEditorHtml: (b: string) => string;
  serializeEditor: (el: Element) => string;
  sanitizeHtml: (html: string, doc: Document) => string;
  parsePageStyle: (b: string) => { size: string; orient: string; rest: string };
  pageDims: (s: string, o: string) => [number, number];
  replaceAllInSurface: (root: Element, find: string, repl: string) => number;
} {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../public/js/doc-editor.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as never;
}
const { bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle, pageDims, replaceAllInSurface } = load();

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();

function roundTrip(body: string): string {
  const dom = new JSDOM('<!DOCTYPE html><div id="r"></div>');
  const el = dom.window.document.getElementById('r')!;
  el.innerHTML = bodyToEditorHtml(body);
  return serializeEditor(el);
}

describe('doc-editor transforms', () => {
  it('turns {{var}} into a non-editable chip', () => {
    const html = bodyToEditorHtml('Hello {{order.no}}!');
    expect(html).toContain('class="doc-chip"');
    expect(html).toContain('data-token="order.no"');
    expect(html).toContain('contenteditable="false"');
  });

  it('round-trips a plain variable', () => {
    expect(norm(roundTrip('No: {{order.no}}'))).toBe('No: {{order.no}}');
  });

  it('tags variables, formulas and control tokens with distinct chip classes', () => {
    expect(bodyToEditorHtml('{{order.no}}')).toMatch(/class="doc-chip"/);
    expect(bodyToEditorHtml('{{= sum(items.line_total) }}')).toMatch(/doc-chip-fx/);
    expect(bodyToEditorHtml('{{#if order.notes}}')).toMatch(/doc-chip-ctrl/);
    // formula chips round-trip back to {{= … }} (token is trimmed)
    expect(norm(roundTrip('Total {{= sum(items.line_total) }}'))).toBe('Total {{= sum(items.line_total)}}');
  });

  it('round-trips a repeatable item row + cell variables', () => {
    const body = '<table class="doc-table"><tbody>{{#items}}<tr><td>{{name}}</td><td>{{line_total}}</td></tr>{{/items}}</tbody></table>';
    expect(norm(roundTrip(body))).toBe(norm(body));
  });

  it('marks the repeat row in the editor DOM', () => {
    const html = bodyToEditorHtml('<table><tbody>{{#items}}<tr><td>x</td></tr>{{/items}}</tbody></table>');
    expect(html).toContain('data-repeat="items"');
    expect(html).not.toContain('{{#items}}');
  });

  it('preserves checkboxes verbatim', () => {
    const body = 'Agree <span class="doc-checkbox" data-checked="1">&#9745;</span>';
    expect(roundTrip(body)).toContain('class="doc-checkbox"');
    expect(roundTrip(body)).toContain('data-checked="1"');
  });

  it('keeps control tokens (e.g. {{#if}}) as chips that round-trip', () => {
    const body = '{{#if order.notes}}Note: {{order.notes}}{{/if}}';
    expect(norm(roundTrip(body))).toBe(norm(body));
  });
});

describe('sanitizeHtml (paste hardening)', () => {
  const doc = new JSDOM('<!DOCTYPE html><body></body>').window.document;

  it('strips <script> and event handlers', () => {
    const out = sanitizeHtml('<p onclick="evil()">hi<script>steal()</script></p>', doc);
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('hi');
  });

  it('drops disallowed tags but keeps their text', () => {
    const out = sanitizeHtml('<marquee><font color="red">keep</font></marquee>', doc);
    expect(out).not.toMatch(/marquee/i);
    expect(out).toContain('keep');
  });

  it('filters style to a safe allowlist and keeps tables/formatting', () => {
    const out = sanitizeHtml('<table><tr><td style="color:red;position:fixed">x</td></tr></table>', doc);
    expect(out).toMatch(/color:\s*red/);
    expect(out).not.toMatch(/position/);
    expect(out).toMatch(/<table>/);
  });

  it('preserves our variable chips and checkboxes', () => {
    const out = sanitizeHtml('<span class="doc-chip" data-token="order.no">order.no</span><span class="doc-checkbox" data-checked="1">x</span>', doc);
    expect(out).toContain('data-token="order.no"');
    expect(out).toContain('doc-checkbox');
    expect(out).toContain('data-checked="1"');
  });

  it('blocks javascript: links and non-image src', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>', doc)).not.toMatch(/javascript:/i);
    expect(sanitizeHtml('<img src="http://x/y.png">', doc)).toContain('src=');
  });
});

describe('page setup + find/replace helpers', () => {
  const doc = new JSDOM('<!DOCTYPE html><body></body>').window.document;

  it('parses and strips the @page style from a body', () => {
    const body = '<style data-docpage>@page{size:letter landscape;margin:14mm}</style><p>hi</p>';
    const pg = parsePageStyle(body);
    expect(pg.size).toBe('letter');
    expect(pg.orient).toBe('landscape');
    expect(pg.rest).toBe('<p>hi</p>');
  });

  it('defaults to A4 portrait when no @page is present', () => {
    const pg = parsePageStyle('<p>x</p>');
    expect(pg.size).toBe('a4'); expect(pg.orient).toBe('portrait');
  });

  it('computes page dimensions incl. landscape swap', () => {
    expect(pageDims('a4', 'portrait')).toEqual([794, 1123]);
    expect(pageDims('a4', 'landscape')).toEqual([1123, 794]);
    expect(pageDims('letter', 'portrait')).toEqual([816, 1056]);
  });

  it('replaces text but never inside variable chips', () => {
    const root = doc.createElement('div');
    root.innerHTML = 'Hello world <span class="doc-chip" data-token="world">world</span>';
    const n = replaceAllInSurface(root, 'world', 'there');
    expect(n).toBe(1); // only the plain text, not the chip
    expect(root.textContent).toContain('Hello there');
    expect(root.querySelector('.doc-chip')!.textContent).toBe('world'); // chip untouched
  });
});
