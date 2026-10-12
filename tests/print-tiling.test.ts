/** Generic N-up print tiling (public/js/print-tiling.js): the grid layout any form-linked
    template can opt into via doc_templates.copies_per_record / records_per_page, generalizing
    the 2x2 grid hr-payroll-print.js hand-built for HR Payroll Slip. Loaded into a sandbox, same
    technique as tests/hr-payroll-print.test.ts (no dependencies here, so no require shim needed). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '../public/js');

function loadModule() {
  const src = fs.readFileSync(path.join(DIR, 'print-tiling.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, () => ({}));
  return mod.exports as {
    buildTiledPagesHtml: (records: unknown[], renderRecord: (r: unknown) => string, opts?: Record<string, unknown>) => string;
    pageContentHeightMm: (body: string) => number;
    fitTiledCells: (root: unknown) => void;
    _fitScale: (contentHeight: number, boxHeight: number) => number | null;
  };
}

const { buildTiledPagesHtml, pageContentHeightMm, _fitScale } = loadModule();

describe('pageContentHeightMm', () => {
  it('falls back to A4 with a 14mm margin when the template has no page-setup tag', () => {
    expect(pageContentHeightMm('')).toBe(297 - 14 * 2 - 8);
    expect(pageContentHeightMm('<div>plain body, never opened in the editor</div>')).toBe(297 - 14 * 2 - 8);
  });

  it('reads the template\'s own page size/margin when present', () => {
    const body = '<style data-docpage>@page{size:210mm 400mm;margin:20mm}</style><div>x</div>';
    expect(pageContentHeightMm(body)).toBe(400 - 20 * 2 - 8);
  });

  it('never goes below the 50mm floor for a tiny custom page', () => {
    const body = '<style data-docpage>@page{size:60mm 60mm;margin:20mm}</style>';
    expect(pageContentHeightMm(body)).toBe(50);
  });
});

describe('buildTiledPagesHtml', () => {
  const render = (r: unknown) => `<div class="slip">${String(r)}</div>`;

  it('returns empty when neither copies nor records-per-page is above 1 (caller falls back to its own plain path)', () => {
    expect(buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 1, recordsPerPage: 1 })).toBe('');
    expect(buildTiledPagesHtml(['a'], render, {})).toBe('');
  });

  it('returns empty for an empty record list even when tiling is requested', () => {
    expect(buildTiledPagesHtml([], render, { copiesPerRecord: 2, recordsPerPage: 2 })).toBe('');
  });

  it('duplicates a single record copiesPerRecord times, one record per page (the "half page, 2 copies" case)', () => {
    const html = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 1 });
    // two records, one per page -> 2 pages, each with 2 copies of its own record
    expect((html.match(/class="tiled-page"/g) || []).length).toBe(2);
    expect((html.match(/>a</g) || []).length).toBe(2);
    expect((html.match(/>b</g) || []).length).toBe(2);
    expect(html).toContain('grid-template-columns: repeat(1, minmax(0, 1fr))');
    expect(html).toContain('grid-template-rows: repeat(2, minmax(0, 1fr))');
  });

  it('reproduces hr-payroll-print.js\'s exact 2x2 ordering for records=2, copies=2 (a,a,b,b per page)', () => {
    const html = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
    const order = [...html.matchAll(/<div class="slip">([ab])<\/div>/g)].map((m) => m[1]);
    expect(order).toEqual(['a', 'a', 'b', 'b']);
    expect(html).toContain('grid-auto-flow: column');
  });

  it('pads a partial last group with empty cells so the grid stays fully populated', () => {
    const html = buildTiledPagesHtml(['a', 'b', 'c'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
    const pages = html.split('<div class="tiled-page">').slice(1);
    expect(pages.length).toBe(2);
    // second page: only "c" plus 3 empty placeholder divs (1 record's worth of padding x 2 copies + the padding record itself is 1, so 2 pad cells + c's 2 copies = 4 cells total)
    const page2 = pages[1]!;
    expect((page2.match(/>c</g) || []).length).toBe(2);
    expect((page2.match(/<div><\/div>/g) || []).length).toBe(2);
  });

  it('sizes the grid from the supplied pageContentHeightMm', () => {
    const html = buildTiledPagesHtml(['a'], render, { copiesPerRecord: 2, recordsPerPage: 1, pageContentHeightMm: 180 });
    expect(html).toContain('height: 180mm');
  });

  it('marks every page but the last with page-break-after: always', () => {
    // copiesPerRecord:2 forces tiling even with just 1 record per page
    const html = buildTiledPagesHtml(['a', 'b', 'c', 'd'], render, { copiesPerRecord: 2, recordsPerPage: 1 });
    expect(html).toContain('.tiled-page { page-break-after: always; }');
    expect(html).toContain('.tiled-page:last-child { page-break-after: auto; }');
  });

  // Regression: each grid cell must be its own CSS positioning boundary (position:relative), or
  // a floating object (an image/textbox/shape "made movable" in the template editor) inside the
  // rendered record resolves its %-based position against the shared page instead of its own
  // cell — every copy's float lands at the same spot, oversized (the payslip-logo bug this
  // generalizes from — see hr-payroll-print.test.ts's matching regression test).
  it('gives each grid cell its own positioning boundary for floating template content', () => {
    const html = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
    expect(html).toContain('.tiled-grid > div { position: relative; overflow: hidden; }');
  });

  // Regression: fitTiledCells() must scale a naturally-sized *inner* wrapper, never the
  // fixed-height/overflow:hidden cell itself (same reasoning as hr-payroll-print.js's
  // fitPayslipCells() — see its test file). Wrapping every rendered record ourselves, rather
  // than relying on renderRecord's own output being exactly one element, is also what keeps
  // ".tiled-grid > div" meaning "one record's cell" regardless of a template's own markup shape
  // (e.g. a <style> tag followed by more than one root element).
  it('wraps each rendered record in its own .tiled-cell-inner, inside the (unscaled) grid cell', () => {
    const html = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
    expect(html.split('<div class="tiled-cell-inner">').length - 1).toBe(4);
  });

  it('leaves a blank leftover cell as a plain empty div, not a .tiled-cell-inner wrapper', () => {
    const html = buildTiledPagesHtml(['a'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
    expect(html).toContain('<div></div>');
    expect(html.split('<div class="tiled-cell-inner">').length - 1).toBe(2); // just a's 2 copies
  });

  describe('tileFill: "repeat" — one design filling its whole grid', () => {
    it('repeats a single printed record to fill a 3x3 grid (9 copies, no blanks)', () => {
      const html = buildTiledPagesHtml(['a'], render, { copiesPerRecord: 3, recordsPerPage: 3, tileFill: 'repeat' });
      expect((html.match(/class="tiled-page"/g) || []).length).toBe(1);
      expect((html.match(/>a</g) || []).length).toBe(9);
      expect(html).not.toContain('<div></div>');
    });

    it('cycles back through several records instead of leaving cells blank', () => {
      const html = buildTiledPagesHtml(['a', 'b', 'c'], render, { copiesPerRecord: 2, recordsPerPage: 2, tileFill: 'repeat' });
      // 3 records, 2x2 grid (4 cells/page) -> page 1: a,a,b,b ; page 2: c,c,+ wraps to a,a (cycled, not blank)
      const pages = html.split('<div class="tiled-page">').slice(1);
      expect(pages.length).toBe(2);
      expect(pages[1]).not.toContain('<div></div>');
      expect((pages[1]!.match(/>c</g) || []).length).toBe(2);
      expect((pages[1]!.match(/>a</g) || []).length).toBe(2); // cycled back to the start
    });

    it('defaults to "blank" when tileFill is omitted (unchanged behavior)', () => {
      const html = buildTiledPagesHtml(['a'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
      expect(html).toContain('<div></div>');
    });
  });

  // continuous: true decouples "repeat" from the grid shape — the grid (copiesPerRecord x
  // recordsPerPage) becomes a fixed physical page capacity, and every record's repeatCount
  // copies flatten into one stream poured across as many such pages as needed, splitting a
  // record's own run across a page boundary if the numbers don't divide evenly.
  describe('continuous mode', () => {
    it('fits exactly one page when records x repeat matches the grid capacity', () => {
      // 2 employees x repeat 2 = 4, grid 2x2 (4 cells) -> exactly 1 page
      const html = buildTiledPagesHtml(['a', 'b'], render, {
        copiesPerRecord: 2, recordsPerPage: 2, continuous: true, repeatCount: 2,
      });
      expect((html.match(/class="tiled-page"/g) || []).length).toBe(1);
      const order = [...html.matchAll(/<div class="slip">([ab])<\/div>/g)].map((m) => m[1]);
      expect(order).toEqual(['a', 'a', 'b', 'b']);
    });

    it('splits a record\'s own repeat run across a page boundary rather than starting a new page early (the "2 employees, repeat 3, 2x2 grid -> 4 then 2" case)', () => {
      // 2 employees x repeat 3 = 6 total, grid 2x2 (4 cells/page) -> page 1: 4, page 2: 2
      const html = buildTiledPagesHtml(['a', 'b'], render, {
        copiesPerRecord: 2, recordsPerPage: 2, continuous: true, repeatCount: 3,
      });
      const pages = html.split('<div class="tiled-page">').slice(1);
      expect(pages.length).toBe(2);
      const countOf = (s: string, ch: string) => (s.match(new RegExp(`>${ch}<`, 'g')) || []).length;
      expect(countOf(pages[0]!, 'a')).toBe(3); // all 3 of a's copies plus 1 of b's fill page 1
      expect(countOf(pages[0]!, 'b')).toBe(1);
      expect(countOf(pages[1]!, 'b')).toBe(2); // b's remaining 2 copies land alone on page 2
      expect(countOf(pages[1]!, 'a')).toBe(0);
    });

    it('ignores repeatCount/continuous when continuous is not set (existing behavior unaffected)', () => {
      const withRepeat = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 2, repeatCount: 3 });
      const without = buildTiledPagesHtml(['a', 'b'], render, { copiesPerRecord: 2, recordsPerPage: 2 });
      expect(withRepeat).toBe(without);
    });

    it('activates tiling even with a 1x1 grid when continuous asks for more than 1 copy', () => {
      const html = buildTiledPagesHtml(['a'], render, { copiesPerRecord: 1, recordsPerPage: 1, continuous: true, repeatCount: 3 });
      expect(html).not.toBe('');
      expect((html.match(/class="tiled-page"/g) || []).length).toBe(3);
    });

    it('"repeat" tileFill cycles through the flattened (already-repeated) stream, not the raw record list', () => {
      // 2 employees x repeat 2 = 4 total, grid 2x3 (6 cells) -> 1 page, 2 leftover cells cycle
      const html = buildTiledPagesHtml(['a', 'b'], render, {
        copiesPerRecord: 2, recordsPerPage: 3, continuous: true, repeatCount: 2, tileFill: 'repeat',
      });
      const order = [...html.matchAll(/<div class="slip">([ab])<\/div>/g)].map((m) => m[1]);
      expect(order).toEqual(['a', 'a', 'b', 'b', 'a', 'a']); // wraps back to the start of the flat stream
      expect(html).not.toContain('<div></div>');
    });
  });
});

// _fitScale is the pure-math half of fitTiledCells() (the DOM-measuring half needs a real
// browser layout — scrollHeight/clientHeight — so it isn't exercised here; see print-tiling.js
// and its call sites in form-records.js's printRecordsViaTemplate() and doc-editor.js's
// refreshPreview()). Identical to hr-payroll-print.js's _fitScale — kept as its own copy per
// module's comment rather than a shared import, same as the rest of this file's duplication.
describe('_fitScale', () => {
  it('returns null when content already fits its cell', () => {
    expect(_fitScale(100, 150)).toBeNull();
    expect(_fitScale(150, 150)).toBeNull();
  });

  it('returns the shrink factor needed when content overflows its cell', () => {
    expect(_fitScale(200, 150)).toBeCloseTo(0.75);
  });

  it('treats a zero/negative box height as unmeasured (not yet laid out) rather than dividing by it', () => {
    expect(_fitScale(200, 0)).toBeNull();
  });
});


describe('configurable grid spacing and width fitting',()=>{
 it('supports zero horizontal gap and independent vertical spacing',()=>{
  const html=buildTiledPagesHtml([1],()=>'<p>Content</p>',{copiesPerRecord:2,recordsPerPage:2,gapXmm:0,gapYmm:2.5});
  expect(html).toContain('column-gap: 0mm; row-gap: 2.5mm');
  expect(buildTiledPagesHtml([1],()=>'',{copiesPerRecord:2})).toContain('column-gap: 6mm; row-gap: 6mm');
 });
 it('shrinks wide content even when its height already fits and clears stale transforms',()=>{
  const {fitTiledCells}=loadModule();const inner={scrollHeight:50,scrollWidth:400,style:{transform:'old',transformOrigin:''}};
  const cell={clientHeight:100,clientWidth:200,querySelector:()=>inner};
  fitTiledCells({querySelectorAll:()=>[cell]});expect(inner.style.transform).toBe('scale(0.5)');
  inner.scrollWidth=100;fitTiledCells({querySelectorAll:()=>[cell]});expect(inner.style.transform).toBe('');
 });
});


describe('heading links in grid copies',()=>{
 it('assigns a distinct target to each repeated copy while keeping its own contents link',()=>{
  const html=buildTiledPagesHtml([1],()=>'<a href="#doc-heading-example">Contents</a><h1 id="doc-heading-example">Heading</h1>',{copiesPerRecord:2,recordsPerPage:2,tileFill:'repeat'});
  const ids=[...html.matchAll(/id="(doc-heading-[^"]+)"/g)].map(m=>m[1]);const links=[...html.matchAll(/href="#(doc-heading-[^"]+)"/g)].map(m=>m[1]);expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(4);expect(links).toEqual(ids);
 });
});
