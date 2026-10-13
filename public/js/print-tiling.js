/* ============================================================================
   Generic N-up print tiling: lays out a Rows x Columns grid of a design on one printed
   page — columns = recordsPerPage, rows = copiesPerRecord, column-major so each record's
   copies stay adjacent (one cuttable strip). Same layout hr-payroll-print.js hand-built
   for HR Payroll Slip (2 employees x 2 copies = a 2x2 grid); this generalizes it for any
   template that opts in via its doc_templates.copies_per_record / records_per_page /
   tile_fill fields (the template editor's Layout tab > Print Grid). hr-payroll-print.js
   itself is untouched — it stays its own bespoke module.

   Two fill behaviors once there are fewer printed records than grid cells (tile_fill):
     'blank'  — leftover cells stay empty (right when each cell is a specific record, e.g.
                payroll's "2 employees x 2 copies", where a repeat would look like a
                duplicate of the wrong person).
     'repeat' — cycle back through the printed records to fill every cell (right for
                repeating ONE design across its whole grid: print one record as a 1x2 /
                2x2 / 3x3 / etc. sheet of itself). Each tile lays out at the original page
                size, then scales uniformly into its cell without responsive reflow.

   Two modes for how the grid relates to "how many copies of each record" (opts.continuous,
   default false — every existing template keeps its exact current output):
     continuous: false (default) — as above: copiesPerRecord (grid ROWS) *is* the number of
                 copies of each record; the grid always processes a clean "recordsPerPage
                 records at a time" and never splits one record's copies across a page.
     continuous: true  — copiesPerRecord x recordsPerPage is now just a fixed PHYSICAL page
                 shape, independent of copy count. Every record is repeated opts.repeatCount
                 times (default 1), all records' repeats are flattened into one continuous
                 stream in order, and that stream is poured page after page into that fixed
                 grid — e.g. 2 records x repeat 3 into a 2x2 (4-cell) grid: page 1 gets 4
                 cells, page 2 gets the remaining 2. A record's own repeat run CAN end up
                 split across a page (or column) boundary if it doesn't divide evenly into
                 what's left on a page — the deliberate trade-off of "keep pouring" over
                 continuous mode's non-continuous counterpart, which instead keeps every
                 record's copies together by never starting a new record mid-page.

   Used by public/js/views/form-records.js's printRecordsViaTemplate() for every
   form-linked template EXCEPT hr_payroll, which keeps its specialized path.
   Browser global + CommonJS export (for tests).
   ============================================================================ */

/** Usable page height (mm) for the tiling grid, read from a template body's own
    <style data-docpage>@page{size:Wmm Hmm;margin:Mmm}</style> tag (written by the
    template editor's Page Setup) so the grid matches THIS template's own page size,
    not a hardcoded assumption. Falls back to A4 with the print stylesheet's default
    14mm margin when the tag is absent (plain, never-opened-in-the-editor templates). */
function pageContentHeightMm(body) {
  const m = String(body || '').match(/<style data-docpage>@page\{size:([\d.]+)mm\s+([\d.]+)mm;margin:([\d.]+)mm\}<\/style>/i);
  const heightMm = m ? parseFloat(m[2]) : 297;
  const marginMm = m ? parseFloat(m[3]) : 14;
  // Small safety buffer (gap rounding, border-box slop) — same margin hr-payroll-print.js
  // leaves below its own page's 297 - 14*2 = 269mm usable height.
  return Math.max(50, heightMm - marginMm * 2 - 8);
}

function _tileNum(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** The source paper, including margins, is the invariant coordinate space of a tile. */
function tileSourcePage(body) {
  const setup=String(body||'').match(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>([\s\S]*?)<\/style>/i);
  const size=setup?.[1].match(/size:\s*([\d.]+)mm\s+([\d.]+)mm/i),margin=setup?.[1].match(/margin:\s*([\d.]+)mm/i);
  const width=size?Number(size[1]):210,height=size?Number(size[2]):297,m=margin?Number(margin[1]):14;
  return {widthMm:width>0?width:210,heightMm:height>0?height:297,marginMm:Number.isFinite(m)&&m>=0&&m*2<Math.min(width,height)?m:0};
}

/** records: array of opaque record values (whatever renderRecord needs).
    renderRecord(record): renders ONE record's HTML (caller supplies — e.g. a
    renderTemplate(tpl.body, ctx) call already bound to that record's context).
    opts: { copiesPerRecord, recordsPerPage, tileFill, pageContentHeightMm, continuous,
    repeatCount }. continuous/repeatCount are ignored (as if continuous were false) unless
    continuous is truthy — see the module comment for the two modes.
    Returns '' when there's nothing to tile — neither copiesPerRecord nor recordsPerPage is
    above 1, and continuous mode isn't asking for more than 1 copy either — the caller's
    plain one-record-per-page path should run instead; this only kicks in once a template
    opts in. */
function isMultiPageDocument(body) {
  const markup=String(body||'').replace(/<!--[\s\S]*?-->/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const tags=markup.match(/<[a-z][^>]*>/gi)||[];
  if(tags.filter(tag=>/\sdata-doc-design-page(?:\s|=|>)/i.test(tag)).length>1)return true;
  return tags.some(tag=>/\sdata-doc-section-break=["']page["']/i.test(tag)||/\sclass=["'][^"']*\bdoc-pagebreak\b/i.test(tag)||/\sstyle=["'][^"']*(?:break-(?:before|after)\s*:\s*page|page-break-(?:before|after)\s*:\s*always)/i.test(tag));
}

function buildTiledPagesHtml(records, renderRecord, opts) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return '';
  const copies = _tileNum(opts && opts.copiesPerRecord, 1);
  const perPage = _tileNum(opts && opts.recordsPerPage, 1);
  const continuous = !!(opts && opts.continuous);
  const repeatCount = _tileNum(opts && opts.repeatCount, 1);
  if (copies <= 1 && perPage <= 1 && !(continuous && repeatCount > 1)) return '';
  // Render before building cells: legacy templates or record-driven boundaries must also bypass grids.
  const rendered = new Map(list.map(record=>[record,renderRecord(record)]));
  if ([...rendered.values()].some(isMultiPageDocument)) return '';
  renderRecord = record => rendered.get(record);
  const heightMm = (opts && opts.pageContentHeightMm) || 269;
  const gap = v => v == null || !Number.isFinite(Number(v)) ? 6 : Math.max(0,Math.min(30,Number(v)));
  const gapX = gap(opts?.gapXmm), gapY = gap(opts?.gapYmm);
  const fillRepeat = !!(opts && opts.tileFill === 'repeat');

  const css = `
    .tiled-page { page-break-after: always; }
    .tiled-page:last-child { page-break-after: auto; }
    .tiled-grid {
      display: grid; grid-template-columns: repeat(${perPage}, minmax(0, 1fr)); grid-template-rows: repeat(${copies}, minmax(0, 1fr));
      grid-auto-flow: column; column-gap: ${gapX}mm; row-gap: ${gapY}mm; height: ${heightMm}mm;
    }
    /* Clip only the fitted result; lay out text, tables and percentage floats at source size. */
    .tiled-grid > div { position: relative; overflow: hidden; }
    .tiled-cell-inner { position:relative; isolation:isolate; box-sizing:border-box; display:flow-root;
      width:var(--tile-page-width); height:var(--tile-page-height); padding:var(--tile-page-margin);
      transform-origin:top left; }
  `;

  // Outer (fixed-size grid item, clips overflow) / inner .tiled-cell-inner (source paper size,
  // what fitTiledCells() measures/scales) pair — same split hr-payroll-print.js's _cell() uses
  // and for the same reason (see PAGE_CSS's comment there): a record's rendered HTML isn't
  // guaranteed to be exactly one element (a template body is typically a <style> tag followed
  // by one root div by convention, but nothing enforces that), so wrapping it ourselves is what
  // makes ".tiled-grid > div" reliably mean "one record's cell" instead of depending on however
  // many top-level nodes this particular template's markup happens to produce.
  let cellIndex=0;
  const cell = (html) => {
    const suffix='_tile_'+(++cellIndex);
    const content=String(html??'').replace(/\bid=(["'])(doc-heading-[\w-]+)\1/g,(_m,q,id)=>`id=${q}${id}${suffix}${q}`).replace(/\bhref=(["'])#(doc-heading-[\w-]+)\1/g,(_m,q,id)=>`href=${q}#${id}${suffix}${q}`);
    const page=tileSourcePage(html);
    return `<div style="--tile-page-width:${page.widthMm}mm;--tile-page-height:${page.heightMm}mm;--tile-page-margin:${page.marginMm}mm"><div class="tiled-cell-inner">${content}</div></div>`;
  };

  const pages = [];
  if (continuous) {
    // Flatten every record into `repeatCount` consecutive entries — record boundaries no
    // longer align to page/column boundaries the way the non-continuous branch below
    // guarantees. grid-auto-flow: column then pours this flat stream straight down each
    // column (copies cells) before moving to the next (perPage columns) — i.e. the exact
    // same CSS as non-continuous mode; only which record lands in which cell changes.
    const flat = [];
    list.forEach((rec) => { for (let c = 0; c < repeatCount; c++) flat.push(rec); });
    const capacity = copies * perPage;
    for (let i = 0; i < flat.length; i += capacity) {
      const cells = [];
      for (let g = 0; g < capacity; g++) {
        const idx = i + g;
        // leftover cell on the final page: 'repeat' cycles back through the flat (already
        // repeated) stream; 'blank' (default) leaves it empty — same semantics as the
        // non-continuous branch, just over `flat` instead of the raw record list.
        const rec = idx < flat.length ? flat[idx] : (fillRepeat ? flat[idx % flat.length] : null);
        cells.push(rec == null ? '<div></div>' : cell(renderRecord(rec)));
      }
      pages.push(`<div class="tiled-page"><div class="tiled-grid">${cells.join('')}</div></div>`);
    }
  } else {
    for (let i = 0; i < list.length; i += perPage) {
      const group = [];
      for (let g = 0; g < perPage; g++) {
        const idx = i + g;
        if (idx < list.length) group.push(list[idx]);
        // leftover cell: 'repeat' cycles back through the printed records (so a single record
        // fills its whole grid); 'blank' (default) leaves it empty.
        else group.push(fillRepeat ? list[idx % list.length] : null);
      }
      const cells = [];
      group.forEach((rec) => {
        const html = rec == null ? null : renderRecord(rec);
        for (let c = 0; c < copies; c++) cells.push(html == null ? '<div></div>' : cell(html));
      });
      pages.push(`<div class="tiled-page"><div class="tiled-grid">${cells.join('')}</div></div>`);
    }
  }
  return `<style>${css}</style>${pages.join('')}`;
}

/** Fit the entire source-paper layout using one scale factor for both axes. Source width,
    height and margin stay fixed, so text and objects never reflow into the smaller cell.
    Overflow is included in measurement so additional record content is not silently clipped.
    Needs real layout (`scrollHeight`/`clientHeight`), so call this
    against a live DOM after the print HTML has actually rendered — e.g. the preview iframe's
    `load` event in form-records.js's printRecordsViaTemplate() — not against the HTML string
    buildTiledPagesHtml() returns. `root` defaults to `document`; pass an iframe's
    `contentDocument` explicitly when printing from inside one. */
function fitTiledCells(root) {
  const cells = (root || document).querySelectorAll('.tiled-grid > div');
  cells.forEach((cell) => {
    const inner = cell.querySelector('.tiled-cell-inner');
    if (!inner) return;
    inner.style.transform = "";
    const scale = Math.min(_fitScale(Math.max(inner.offsetHeight||0,inner.scrollHeight), cell.clientHeight) || 1, _fitScale(Math.max(inner.offsetWidth||0,inner.scrollWidth), cell.clientWidth) || 1);
    if (scale < 1) {
      inner.style.transformOrigin = 'top left';
      inner.style.transform = `scale(${scale})`;
    }
  });
}

function _fitScale(contentHeight, boxHeight) {
  if (!(contentHeight > 0) || !(boxHeight > 0) || contentHeight <= boxHeight) return null;
  return boxHeight / contentHeight;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTiledPagesHtml, pageContentHeightMm, fitTiledCells, _fitScale, isMultiPageDocument, tileSourcePage };
}
