/* ============================================================================
   DocEditor — full-screen, Word-style visual editor for document templates.
   The editing surface IS the document page (true WYSIWYG). Visual ⇄ HTML/CSS
   modes. Produces/consumes HTML + {{var}} (+ inline {{= formula }}) bodies that
   the renderer (doc-template.js) understands.

   Public (browser): DocEditor.open({ title, name, type, typeOptions, period, periodLabel, body,
                                      copiesPerRecord, recordsPerPage, tileFill,  // print tiling —
                                      // Layout tab's "Print Grid" group (rows/columns/fill mode);
                                      // default 1/1/'blank', handed back to onSave alongside
                                      // name/type/period/body
                                      continuous, repeatCount,  // same group's Continuous toggle +
                                      // Repeat count (default false/1) — decouples "copies per
                                      // record" from the grid shape; see print-tiling.js
                                      getVariables, onSave })
   Pure helpers (CommonJS, for tests): bodyToEditorHtml(body) · serializeEditor(el)
   ============================================================================ */

function escAttr(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function tokenChip(token) {
  const t = token.trim();
  const isCtrl = t[0] === '#' || t[0] === '/';
  const isFormula = t[0] === '=';
  const cls = 'doc-chip' + (isCtrl ? ' doc-chip-ctrl' : '') + (isFormula ? ' doc-chip-fx' : '');
  const shown = isFormula ? t.replace(/^=\s*/, '') : t; // type marker is added via CSS ::before
  return `<span class="${cls}" data-token="${escAttr(t)}" contenteditable="false">${escAttr(shown)}</span>`;
}

// Neutral placeholder shown in the editor canvas for an <img src="{{var}}">, since the real
// value only exists at print time. Swapped back to the {{var}} token on save (data-var-src).
const EDITOR_IMG_PLACEHOLDER = (typeof UI !== 'undefined' && UI.PLACEHOLDER_PHOTO) || 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#dce6f2"/>' +
  '<circle cx="50" cy="38" r="18" fill="#9fb3c8"/><path d="M20 88c4-22 18-32 30-32s26 10 30 32" fill="#9fb3c8"/></svg>'
);

function bodyToEditorHtml(body) {
  let html = String(body == null ? '' : body);
  html = html.replace(/\{\{#items\}\}\s*<tr/g, '<tr data-repeat="items"');
  html = html.replace(/<\/tr>\s*\{\{\/items\}\}/g, '</tr>');
  // A variable inside an <img src="…"> can't become an inline chip without breaking that
  // attribute's HTML (a chip is a <span>, which can't live inside a quoted attribute value) —
  // show a placeholder image instead and remember the real token in data-var-src.
  html = html.replace(/(<img\b[^>]*?)\bsrc=(["'])\{\{\s*([^}]+?)\s*\}\}\2([^>]*>)/gi,
    (_m, pre, _q, tok, post) => `${pre}src="${EDITOR_IMG_PLACEHOLDER}" data-var-src="${escAttr(tok.trim())}"${post}`);
  // Chip-ify remaining {{...}} that sit in text content — never inside a tag's attributes,
  // since a whole <tag ...> is matched and passed through as one atomic (unmodified) unit.
  html = html.replace(/(<[^>]*>)|\{\{\s*([^}]+?)\s*\}\}/g, (m, tag, tok) => (tag ? tag : tokenChip(tok)));
  return html;
}

function serializeEditor(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll('img[data-var-src]').forEach((img) => {
    img.setAttribute('src', '{{' + img.getAttribute('data-var-src') + '}}');
    img.removeAttribute('data-var-src');
  });
  clone.querySelectorAll('.doc-chip').forEach((chip) => {
    chip.replaceWith(chip.ownerDocument.createTextNode('{{' + (chip.getAttribute('data-token') || '') + '}}'));
  });
  clone.querySelectorAll('tr[data-repeat="items"]').forEach((tr) => {
    tr.removeAttribute('data-repeat'); tr.classList.remove('is-repeat');
    const open = tr.ownerDocument.createTextNode('{{#items}}');
    const close = tr.ownerDocument.createTextNode('{{/items}}');
    tr.parentNode.insertBefore(open, tr);
    if (tr.nextSibling) tr.parentNode.insertBefore(close, tr.nextSibling); else tr.parentNode.appendChild(close);
  });
  clone.querySelectorAll('.cell-sel').forEach((c) => c.classList.remove('cell-sel'));
  clone.querySelectorAll('.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide').forEach((el) => el.remove());
  clone.querySelectorAll('.doc-float').forEach((el) => el.classList.remove('selected', 'behind-text', 'multi', 'editing')); // editor-only state; z-index carries the real meaning
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  return clone.innerHTML.trim();
}

/* ---- paste sanitizer (allowlist; keeps our chips/tables, strips Word/web cruft) ---- */
const SANITIZE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'A', 'IMG', 'HR', 'FONT', 'BLOCKQUOTE']);
const SANITIZE_ATTR = { A: ['href'], IMG: ['src', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const SANITIZE_STYLE = ['color', 'background-color', 'background', 'text-align', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration', 'width', 'page-break-after', 'break-after',
  'position', 'left', 'top', 'right', 'bottom', 'height', 'z-index', 'border', 'border-color', 'border-radius'];
const SANITIZE_DATA = ['data-token', 'data-repeat', 'data-checked', 'data-var-src', 'data-float-kind'];

// `position` is scoped to absolute/relative/static — `fixed`/`sticky` can escape the page and
// overlay the app chrome, so a pasted style must not be able to smuggle those in.
function filterStyle(s) {
  return String(s || '').split(';').map((x) => x.trim()).filter(Boolean)
    .filter((d) => {
      const prop = (d.split(':')[0] || '').trim().toLowerCase();
      if (!SANITIZE_STYLE.includes(prop)) return false;
      if (prop === 'position') return /^(absolute|relative|static)$/i.test((d.split(':')[1] || '').trim());
      return true;
    }).join('; ');
}

function sanitizeNode(node, doc) {
  if (node.nodeType === 3) return [doc.createTextNode(node.nodeValue)];
  if (node.nodeType !== 1) return [];
  const tag = node.nodeName;
  const cls = (node.getAttribute && node.getAttribute('class')) || '';
  const special = /\bdoc-(chip|checkbox|pagebreak)\b/.test(cls);
  const kids = [].concat(...[...node.childNodes].map((c) => sanitizeNode(c, doc)));
  if (tag === 'SCRIPT' || tag === 'STYLE') return [];
  if (!SANITIZE_TAGS.has(tag) && !special) return kids; // drop tag, keep contents
  const el = doc.createElement(tag.toLowerCase());
  [...node.attributes].forEach((a) => {
    const n = a.name.toLowerCase();
    if (n.startsWith('on')) return;
    if (n === 'style') { const v = filterStyle(a.value); if (v) el.setAttribute('style', v); return; }
    if (n === 'class') { const keep = (a.value.match(/doc-(chip|chip-ctrl|chip-fx|checkbox|pagebreak|table|striped|shaded|plain|is-repeat|float|float-body|float-shape)/g) || []).join(' '); if (keep) el.setAttribute('class', keep); return; }
    if (n === 'contenteditable') { if (a.value === 'false' || a.value === 'true') el.setAttribute('contenteditable', a.value); return; }
    if (SANITIZE_DATA.includes(n)) { el.setAttribute(n, a.value); return; }
    if ((SANITIZE_ATTR[tag] || []).includes(n)) {
      if (n === 'href' && /^\s*javascript:/i.test(a.value)) return;
      if (n === 'src' && !/^(data:image\/|https?:|\/)/i.test(a.value)) return;
      el.setAttribute(n, a.value);
    }
  });
  kids.forEach((k) => el.appendChild(k));
  return [el];
}

/** Sanitize an HTML string to the allowlist (used on paste). */
function sanitizeHtml(html, doc) {
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return '';
  const box = doc.createElement('div');
  box.innerHTML = String(html == null ? '' : html);
  const out = doc.createElement('div');
  [].concat(...[...box.childNodes].map((c) => sanitizeNode(c, doc))).forEach((n) => out.appendChild(n));
  return out.innerHTML;
}

/* ---- page setup: exact size (mm) + margin travel in the saved body as an @page rule,
   so any custom size (e.g. a CR-80 ID card) is representable, not just A4/Letter. ---- */
const PX_PER_MM = 96 / 25.4;
const PAGE_PRESETS_MM = { a4: [210, 297], letter: [215.9, 279.4] };

/** Which preset (if any) a widthMm x heightMm pair matches, in either orientation. */
function matchPagePreset(widthMm, heightMm) {
  const close = (a, b) => Math.abs(a - b) < 0.5;
  for (const name of Object.keys(PAGE_PRESETS_MM)) {
    const [pw, ph] = PAGE_PRESETS_MM[name];
    if ((close(widthMm, pw) && close(heightMm, ph)) || (close(widthMm, ph) && close(heightMm, pw))) return name;
  }
  return 'custom';
}

/** Parses {widthMm, heightMm, marginMm, preset, rest} from a saved body. Understands both the
    current `size: <W>mm <H>mm` format and the legacy `size: a4|letter portrait|landscape`
    format saved by older versions of this editor, so old templates keep opening correctly. */
function parsePageStyle(body) {
  let widthMm = PAGE_PRESETS_MM.a4[0], heightMm = PAGE_PRESETS_MM.a4[1], marginMm = 14;
  let rest = String(body == null ? '' : body);
  const m = rest.match(/<style data-docpage>([\s\S]*?)<\/style>/i);
  if (m) {
    rest = rest.replace(m[0], '');
    const mmSize = m[1].match(/size:\s*([\d.]+)mm\s+([\d.]+)mm/i);
    if (mmSize) {
      widthMm = parseFloat(mmSize[1]);
      heightMm = parseFloat(mmSize[2]);
    } else {
      const legacy = m[1].match(/size:\s*([a-z0-9]+)?\s*(portrait|landscape)?/i);
      if (legacy) {
        const base = /letter/i.test(legacy[1] || '') ? PAGE_PRESETS_MM.letter : PAGE_PRESETS_MM.a4;
        [widthMm, heightMm] = legacy[2] === 'landscape' ? [base[1], base[0]] : base;
      }
    }
    const marginMatch = m[1].match(/margin:\s*([\d.]+)mm/i);
    if (marginMatch) marginMm = parseFloat(marginMatch[1]);
  }
  return { widthMm, heightMm, marginMm, preset: matchPagePreset(widthMm, heightMm), rest };
}

function pageStyleTag(widthMm, heightMm, marginMm) {
  return `<style data-docpage>@page{size:${widthMm}mm ${heightMm}mm;margin:${marginMm}mm}</style>`;
}

/** mm -> on-screen CSS px (96dpi), for sizing the editing canvas to match the real page. */
function pageDims(widthMm, heightMm) {
  return [Math.round(widthMm * PX_PER_MM), Math.round(heightMm * PX_PER_MM)];
}

/** Replace all occurrences of `find` with `repl` in editable text (skips variable chips). */
function replaceAllInSurface(root, find, repl) {
  if (!find) return 0;
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('.doc-chip')) ? 2 /* REJECT */ : 1 /* ACCEPT */,
  });
  const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
  let count = 0;
  nodes.forEach((t) => { if (t.nodeValue.includes(find)) { count += t.nodeValue.split(find).length - 1; t.nodeValue = t.nodeValue.split(find).join(repl); } });
  return count;
}

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('doc-editor-styles')) return;
  const css = `
    .doc-fs{position:fixed;inset:0;z-index:40;background:var(--bg,#f4f8fd);display:flex;flex-direction:column;--doc-desk:#e7ebf1;--doc-desk-dot:rgba(20,40,80,.09);--doc-paper:#fff;--dt-line:#dbe2ec;--dt-line-strong:#c2cddd}
    @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .doc-fs{--doc-desk:#100f18;--doc-desk-dot:rgba(255,255,255,.06)}}
    :root[data-theme="dark"] .doc-fs{--doc-desk:#100f18;--doc-desk-dot:rgba(255,255,255,.06)}
    .doc-fs-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2),0 2px 8px rgba(15,30,60,.05);position:relative;z-index:2;flex-shrink:0}
    .doc-fs-bar-scroll{display:flex;align-items:center;gap:7px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden}
    .doc-fs-bar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .doc-fs-title{font-weight:700;font-size:13px;color:var(--text,#16243d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;flex-shrink:1;letter-spacing:-.01em}
    .doc-fs-name{font-size:12.5px;font-weight:600;padding:5px 9px;width:150px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-period{font-size:12px;padding:5px 9px;width:92px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-type{padding:5px 7px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:12.5px}
    .doc-fs-type-top{width:82px}
    .doc-fs-name:focus,.doc-fs-period:focus,.doc-fs-type:focus{outline:none;border-color:var(--accent,#2b7fff);box-shadow:0 0 0 3px var(--accent-weak,#e7f1ff)}
    .doc-modes{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--surface-2,#eef4fb);flex-shrink:0}
    .doc-modes button{border:none;background:none;padding:4px 11px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;white-space:nowrap;border-radius:6px;transition:background .12s,color .12s}
    .doc-modes button:hover{color:var(--text,#16243d)}
    .doc-modes button.active{background:var(--surface,#fff);color:var(--text,#16243d);box-shadow:0 1px 2px rgba(15,30,60,.12),0 1px 3px rgba(15,30,60,.08)}
    .doc-fs-bar .btn{flex-shrink:0;padding:6px 12px;font-size:12.5px;font-weight:600;white-space:nowrap;border-radius:8px}
    .doc-tabs{display:flex;gap:1px;padding:0 12px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2);position:relative;z-index:1;flex-shrink:0;overflow-x:auto;overflow-y:hidden}
    .doc-tab{border:none;background:none;padding:9px 15px 8px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;border-bottom:2.5px solid transparent;margin-bottom:-1px;border-radius:6px 6px 0 0;transition:color .12s,background .12s}
    .doc-tab:hover{color:var(--text,#16243d);background:var(--surface-2,#eef4fb)}
    .doc-tab.active{color:var(--accent,#2b7fff);border-bottom-color:var(--accent,#2b7fff)}
    .doc-panel{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;align-items:stretch;padding:5px 10px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-panel.table-panel{background:var(--accent-weak,#e7f1ff)}
    .doc-group{display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0;padding:2px 11px;position:relative}
    .doc-group:not(:first-child)::before{content:"";position:absolute;left:0;top:14%;bottom:14%;width:1px;background:var(--border,#dce6f2)}
    .doc-group:first-child{padding-left:2px}
    .doc-group-row{display:flex;align-items:center;gap:2px}
    .doc-group-cap{font-size:9.5px;color:var(--text-faint,#8a97ad);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;white-space:nowrap;font-weight:600}
    .doc-panel button{min-width:26px;height:26px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text,#16243d);padding:0 6px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;transition:background .1s,color .1s}
    .doc-panel button:hover{background:var(--surface-2,#eef4fb)}
    .doc-panel button:active{background:var(--surface-3,#e6eef8)}
    .doc-panel button.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-panel button:disabled{opacity:.32;cursor:default;pointer-events:none}
    .doc-panel button:focus-visible,.doc-tab:focus-visible,.doc-modes button:focus-visible,.doc-panel select:focus-visible,.doc-tile:focus-visible{outline:2px solid var(--accent,#2b7fff);outline-offset:1px}
    .doc-page .doc-pagebreak{border:0;border-top:2px dashed var(--accent,#2b7fff);opacity:.5;margin:18px 0;height:0}
    .doc-panel select{height:26px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .doc-panel select[data-cmd="formatBlock"]{width:74px}
    .doc-panel select[data-cmd="fontName"]{width:88px}
    .doc-panel select[data-fontsize]{width:46px}
    .doc-panel select[data-tblstyle]{width:90px}
    .doc-panel select.doc-zoomsel{width:66px}
    .doc-panel .tb-sep{width:1px;flex-shrink:0;align-self:center;height:18px;background:var(--border,#dce6f2);margin:0 4px}
    .doc-panel .tb-color{display:inline-flex;align-items:center;gap:3px;font-size:12px;cursor:pointer;padding:0 5px;color:var(--text,#16243d);height:26px;flex-shrink:0;border-radius:6px}
    .doc-panel .tb-color:hover{background:var(--surface-2,#eef4fb)}
    .doc-panel .tb-color input{width:18px;height:18px;border:none;background:none;padding:0;cursor:pointer}
    .doc-panel .btn-variable{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff);font-weight:700}
    .doc-panel .btn-fx{background:var(--success-weak,#e3f6ec);color:var(--success,#168f54);font-weight:700}
    .doc-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:56px;height:46px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:8px;cursor:pointer;font-family:inherit;color:var(--text,#16243d);transition:background .1s}
    .doc-tile:hover{background:var(--surface-2,#eef4fb)}
    .doc-tile .doc-tile-ic{font-size:16px;line-height:1}
    .doc-tile .doc-tile-lbl{font-size:9.5px;font-weight:600;line-height:1;white-space:nowrap}
    .doc-tile-select{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;padding:0 5px}
    .doc-tile-select .doc-tile-lbl{font-size:9.5px;font-weight:600;color:var(--text-muted,#5d6b84);white-space:nowrap}
    .doc-tile-select select{width:82px}
    .doc-tile-select input[type="number"]{width:58px;height:26px;border:1px solid var(--border,#dce6f2);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 5px}
    .doc-tile-select input[type="checkbox"]{width:auto;height:26px;cursor:pointer}
    /* Figma-style "desk": a soft neutral with a faint dot grid, not a flat slab of grey. */
    .doc-canvas{flex:1;overflow:auto;padding:32px;display:flex;justify-content:center;align-items:flex-start;
      background-color:var(--doc-desk,#e7ebf1);
      background-image:radial-gradient(var(--doc-desk-dot,rgba(20,40,80,.09)) 1px,transparent 1px);
      background-size:22px 22px;background-position:-1px -1px}
    /* zoom sizer: real px box == scaled page, so scrollbars are correct; margin:0 auto (not
       justify-content) so a page wider than the viewport still scrolls left instead of clipping */
    .doc-zoom{margin:0 auto;flex:0 0 auto;align-self:flex-start;position:relative}
    .doc-code{flex:1;width:100%;min-height:0;overflow:hidden;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-code-cm .cm-editor{height:100%}
    .doc-code-cm .cm-scroller{padding:8px 12px}
    /* isolation:isolate makes .doc-page its OWN stacking context, so a floating object sent behind
       the text (negative z-index) still paints above the page's white fill — it can't fall through
       the "paper" into the grey canvas the way it did when .doc-page had no stacking context. */
    .doc-page{position:relative;isolation:isolate;width:816px;min-height:1056px;background:var(--doc-paper,#fff);color:#111;padding:56px 64px;box-shadow:0 1px 3px rgba(15,30,60,.08),0 14px 40px rgba(15,30,60,.16);border:1px solid rgba(15,30,60,.07);font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:13px;line-height:1.55;transform-origin:0 0}
    .doc-page:focus{outline:none}
    .doc-page h1{font-size:22px;margin:0 0 4px}.doc-page h2{font-size:17px;margin:0 0 6px}.doc-page h3{font-size:15px}
    /* Tables — one crisp, modern look shared with the print/preview stylesheet (ui.js PRINT_CSS).
       Bare <table> (e.g. pasted) gets light collapsed borders; .doc-table (what Insert Table
       builds) is the rounded, hairline-ruled variant with a proper <thead>. */
    .doc-page table{border-collapse:collapse;margin:12px 0;width:100%;font-size:12.5px}
    .doc-page td,.doc-page th{border:1px solid #d7dee8;padding:7px 10px;min-width:34px;vertical-align:top}
    .doc-page th{background:#f4f7fb;text-align:left;font-weight:600;color:#1a2740}
    .doc-page .doc-table{border-collapse:separate;border-spacing:0;border:1px solid #ccd6e2;border-radius:8px;overflow:hidden}
    .doc-page .doc-table td,.doc-page .doc-table th{border:0;border-bottom:1px solid #e4e9f1;border-right:1px solid #e4e9f1}
    .doc-page .doc-table tr td:last-child,.doc-page .doc-table tr th:last-child{border-right:0}
    .doc-page .doc-table tbody tr:last-child td{border-bottom:0}
    .doc-page .doc-table thead th{background:#f4f7fb;border-bottom:2px solid #ccd6e2}
    .doc-page .doc-table.striped tbody tr:nth-child(even) td{background:#f8fafc}
    .doc-page .doc-table.shaded thead th{background:#16243d;color:#fff;border-bottom-color:#16243d}
    .doc-page .doc-table.plain{border:0}
    .doc-page .doc-table.plain td,.doc-page .doc-table.plain th{border:0}
    .doc-page .doc-table.plain thead th{border-bottom:1px solid #ccd6e2}
    .doc-page .doc-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:12px;margin-bottom:16px;gap:20px}
    .doc-page .doc-meta{text-align:right}
    .doc-page tr.is-repeat>td,.doc-page tr[data-repeat]>td{box-shadow:inset 0 0 0 2px var(--accent,#2b7fff)}
    .doc-page td.cell-sel,.doc-page th.cell-sel{outline:2px solid var(--accent,#2b7fff);outline-offset:-2px;background:rgba(43,127,255,.12)!important}
    .doc-find{display:flex;gap:7px;align-items:center;padding:8px 14px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2);flex-shrink:0}
    .doc-find input{padding:6px 10px;border:1px solid var(--border,#dce6f2);border-radius:7px;font-size:13px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-find input:focus{outline:none;border-color:var(--accent,#2b7fff);box-shadow:0 0 0 3px var(--accent-weak,#e7f1ff)}
    .doc-find button{border:1px solid var(--border,#dce6f2);background:var(--surface-2,#eef4fb);border-radius:7px;padding:6px 11px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text,#16243d);font-family:inherit;transition:background .1s,color .1s}
    .doc-find button:hover{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-page img{max-width:100%}
    .doc-chip{display:inline-block;background:#e7f1ff;color:#1e6ef0;border:1px solid #9ec5ff;border-radius:11px;padding:1px 9px 1px 7px;font-size:12px;font-weight:600;font-family:Consolas,ui-monospace,monospace;white-space:nowrap;line-height:1.5}
    .doc-chip-ctrl{background:#f0e6ff;color:#7a3cff;border-color:#cbb3ff}
    .doc-chip-fx{background:#eafaf0;color:#15803d;border-color:#86d3a6}
    .doc-chip::before{content:'{ }';font-size:9px;font-weight:800;opacity:.55;margin-right:5px;letter-spacing:-1px}
    .doc-chip-ctrl::before{content:'‹›';letter-spacing:0;opacity:.7}
    .doc-chip-fx::before{content:'ƒx';opacity:.9;letter-spacing:0}
    .doc-checkbox{display:inline-block;font-size:16px;cursor:pointer;line-height:1}
    .var-search{width:100%;padding:9px 11px;border:1px solid var(--border-strong,#c6d4e6);border-radius:8px;margin-bottom:10px;font-size:13.5px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .var-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;border-bottom:1px solid var(--border,#eee);padding-bottom:8px}
    .var-tab{border:none;background:none;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--text-muted,#5d6b84);font-family:inherit}
    .var-tab:hover{background:var(--surface-2,#f0f0f0)}
    .var-tab.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff);font-weight:600}
    .var-pick-list{max-height:42vh;overflow:auto}
    .var-pick{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:none;background:none;padding:8px 10px;border-radius:6px;cursor:pointer;color:var(--text,#222);font-size:13px;font-family:inherit}
    .var-pick:hover{background:var(--surface-2,#f0f0f0)}
    .fx-funcs{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 12px}
    .fx-funcs button{border:1px solid var(--border-strong,#c6d4e6);background:var(--surface-2,#eef4fb);border-radius:6px;padding:4px 9px;cursor:pointer;font-family:Consolas,monospace;font-size:12px;color:var(--text,#16243d)}
    .fx-funcs button:hover{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .fx-tip{background:var(--accent-weak,#e7f1ff);color:var(--text,#16243d);border-radius:8px;padding:9px 11px;font-size:12.5px;line-height:1.5;margin-bottom:12px}
    .fx-tip code{background:#fff;border:1px solid var(--border,#ccc);border-radius:4px;padding:0 4px;font-size:12px;color:#168f54}
    .fx-section{border:1px solid var(--border,#dce6f2);border-radius:8px;padding:10px 12px;margin-bottom:10px}
    .fx-h{font-size:12.5px;font-weight:700;color:var(--text,#16243d);margin-bottom:8px}
    .fx-sub{font-weight:400;color:var(--text-faint,#8a97ad);font-size:11.5px;margin-left:6px}
    .fx-input{width:100%;padding:9px 11px;border:1px solid var(--border-strong,#c6d4e6);border-radius:7px;font-family:Consolas,ui-monospace,monospace;font-size:13.5px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .fx-result{margin-top:8px;font-size:13px;color:var(--text-muted,#5d6b84)}
    .fx-result b{font-family:Consolas,monospace}
    .fx-result b.fx-ok{color:var(--success,#168f54)}
    .fx-result b.fx-bad{color:var(--warn,#b7791f)}
    /* document tables must NOT show the app's row-hover highlight */
    .doc-page tbody tr:hover td{background:transparent}
    .doc-page .doc-table.striped tbody tr:nth-child(even):hover td{background:#f8fafc}
    .doc-page .doc-table.shaded thead tr:hover th{background:#16243d}
    .doc-ac{position:fixed;z-index:60;min-width:220px;max-width:300px;background:var(--surface,#fff);border:1px solid var(--border,#ccc);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.3);overflow:auto;max-height:240px;padding:4px}
    .doc-ac-item{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 9px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text,#16243d)}
    .doc-ac-item.active,.doc-ac-item:hover{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-ac-tok{font-family:Consolas,monospace;font-size:11px;color:var(--text-faint,#8a97ad)}
    .doc-preview-float{position:fixed;top:96px;right:28px;width:480px;height:600px;min-width:300px;min-height:240px;background:var(--surface,#fff);border:1px solid var(--border,#dce6f2);border-radius:12px;box-shadow:0 24px 64px rgba(15,30,60,.28),0 2px 8px rgba(15,30,60,.12);display:flex;flex-direction:column;z-index:45;resize:both;overflow:hidden}
    .doc-preview-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--surface-2,#eef4fb);box-shadow:0 1px 0 var(--border,#dce6f2);cursor:move;flex-shrink:0;font-weight:600;font-size:13px;color:var(--text,#16243d);user-select:none}
    .doc-preview-head .grow{flex:1}
    .doc-preview-head button{border:none;background:none;cursor:pointer;color:var(--text-muted,#5d6b84);font-size:15px;padding:2px 7px;border-radius:5px;line-height:1}
    .doc-preview-head button:hover{background:var(--surface-3,#e6eef8)}
    .doc-preview-float iframe{flex:1;border:none;width:100%;background:#fff}
    /* ---- floating objects: shapes / text boxes / promoted images & tables ---- */
    .doc-float{box-sizing:border-box}
    .doc-float.selected{outline:1.5px solid var(--accent,#2b7fff);outline-offset:0;box-shadow:0 0 0 1px rgba(43,127,255,.22),0 3px 16px rgba(43,127,255,.16)}
    /* Islanded floats (text box / promoted table / promoted block) fill their wrapper with an
       editable interior. When SELECTED (move mode) they grow a 12px "grab frame" — press it to
       move, press the interior once more to type. The selection outline hugs the interior (not the
       frame) so "the object fills its box". When .editing (caret is in the interior) the frame +
       handles disappear so they don't cover what you're typing; Escape pops back to move mode. */
    .doc-float.selected[data-float-kind="text"],.doc-float.selected[data-float-kind="table"],.doc-float.selected[data-float-kind="textbox"]{padding:12px;background:rgba(43,127,255,.06);cursor:move;outline:none;box-shadow:none}
    .doc-float.selected[data-float-kind="text"]>:first-child,.doc-float.selected[data-float-kind="table"]>:first-child,.doc-float.selected[data-float-kind="textbox"]>:first-child{cursor:auto;background:var(--doc-paper,#fff);outline:1.5px solid var(--accent,#2b7fff);outline-offset:2px;box-shadow:0 0 0 1px rgba(43,127,255,.18)}
    .doc-float.selected.editing{padding:0;background:transparent;cursor:auto}
    .doc-float.selected.editing>.doc-float-handle{display:none}
    /* one grip stays at the corner while you edit: drag it to resize, click it to get the full
       move/resize handles + grab frame back. */
    .doc-float.selected.editing>.doc-float-handle[data-h="se"]{display:block;width:calc(15px / var(--zoom,1));height:calc(15px / var(--zoom,1));right:calc(-4px / var(--zoom,1));bottom:calc(-4px / var(--zoom,1));border-radius:3px;background:var(--accent,#2b7fff);border:2px solid #fff;box-shadow:0 1px 5px rgba(15,30,60,.4);cursor:nwse-resize}
    .doc-float.selected.editing>:first-child{outline-style:dashed;box-shadow:none}
    /* transient multi-selection ("temporary group") — dashed accent ring, moves/deletes as one */
    .doc-float.multi{outline:1.5px dashed var(--accent,#2b7fff);outline-offset:1px;box-shadow:0 0 0 1px rgba(43,127,255,.14)}
    /* a float sent behind the text is easy to "lose" — a faint dashed ring says it's still there */
    .doc-float.behind-text:not(.selected):not(.multi){outline:1px dashed var(--border-strong,#c6d4e6);outline-offset:2px}
    .doc-float-shape{width:100%;height:100%;box-sizing:border-box}
    .doc-float-body{width:100%;height:100%;box-sizing:border-box;outline:none;overflow:auto;padding:4px}
    .doc-float[data-float-kind="image"] img{width:100%;height:100%;object-fit:contain}
    /* A promoted <table> must FILL its float wrapper both ways so drag-resize actually grows it
       (a bare <table> is content-height, and .doc-page tables carry a 12px vertical margin). Grid
       stretch is the reliable way to make a <table> take a container's height. */
    .doc-float[data-float-kind="table"]{display:grid}
    .doc-float[data-float-kind="table"]>table{margin:0;width:100%;height:100%;align-self:stretch;justify-self:stretch}
    /* handles / toolbars counter-scale by 1/zoom (var --zoom is set on .doc-zoom) so they stay a
       constant on-screen size at any canvas zoom — grabbable when zoomed out, not huge zoomed in */
    .doc-float-handle{position:absolute;width:calc(10px / var(--zoom,1));height:calc(10px / var(--zoom,1));background:#fff;border:1.5px solid var(--accent,#2b7fff);border-radius:2px;box-shadow:0 1px 3px rgba(15,30,60,.3);z-index:1000}
    .doc-float-handle[data-h="nw"]{left:calc(-5px / var(--zoom,1));top:calc(-5px / var(--zoom,1));cursor:nwse-resize}
    .doc-float-handle[data-h="n"]{left:50%;top:calc(-5px / var(--zoom,1));margin-left:calc(-5px / var(--zoom,1));cursor:ns-resize}
    .doc-float-handle[data-h="ne"]{right:calc(-5px / var(--zoom,1));top:calc(-5px / var(--zoom,1));cursor:nesw-resize}
    .doc-float-handle[data-h="e"]{right:calc(-5px / var(--zoom,1));top:50%;margin-top:calc(-5px / var(--zoom,1));cursor:ew-resize}
    .doc-float-handle[data-h="se"]{right:calc(-5px / var(--zoom,1));bottom:calc(-5px / var(--zoom,1));cursor:nwse-resize}
    .doc-float-handle[data-h="s"]{left:50%;bottom:calc(-5px / var(--zoom,1));margin-left:calc(-5px / var(--zoom,1));cursor:ns-resize}
    .doc-float-handle[data-h="sw"]{left:calc(-5px / var(--zoom,1));bottom:calc(-5px / var(--zoom,1));cursor:nesw-resize}
    .doc-float-handle[data-h="w"]{left:calc(-5px / var(--zoom,1));top:50%;margin-top:calc(-5px / var(--zoom,1));cursor:ew-resize}
    .doc-float-toolbar,.doc-promote-bar{position:absolute;left:0;top:0;display:flex;gap:1px;background:var(--surface,#fff);border:1px solid var(--border,#dce6f2);border-radius:9px;padding:3px 4px;box-shadow:0 6px 22px rgba(15,30,60,.18),0 1px 3px rgba(15,30,60,.1);z-index:1001;white-space:nowrap;transform:translateY(calc(-100% - 6px)) scale(calc(1 / var(--zoom,1)));transform-origin:left bottom}
    .doc-float-toolbar button,.doc-promote-bar button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:4px 7px;border-radius:6px;color:var(--text,#16243d);font-family:inherit;transition:background .1s}
    .doc-float-toolbar button:hover,.doc-promote-bar button:hover{background:var(--surface-2,#eef4fb)}
    /* snap alignment guides drawn during a float drag/resize — transient, %-positioned children of
       the page so they scale with it; stripped by serializeEditor as a belt-and-braces measure */
    .doc-page .doc-snap-guide{position:absolute;z-index:1003;pointer-events:none;background:#ff2d78}
    .doc-page .doc-snap-guide.v{top:0;bottom:0;width:calc(1px / var(--zoom,1))}
    .doc-page .doc-snap-guide.h{left:0;right:0;height:calc(1px / var(--zoom,1))}
    @media (max-width:900px){.doc-page{padding:28px 22px}.doc-canvas{padding:10px}}
  `;
  const el = document.createElement('style'); el.id = 'doc-editor-styles'; el.textContent = css;
  document.head.appendChild(el);
}

const FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Calibri', 'Courier New', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

/** One labeled ribbon group: a row of controls + a caption underneath (Word-style). */
function groupHTML(caption, innerHtml) {
  return `<div class="doc-group"><div class="doc-group-row">${innerHtml}</div><span class="doc-group-cap">${caption}</span></div>`;
}

function tabsHTML() {
  return `
    <button type="button" class="doc-tab active" data-tab="home">Home</button>
    <button type="button" class="doc-tab" data-tab="insert">Insert</button>
    <button type="button" class="doc-tab" data-tab="layout">Layout</button>
    <button type="button" class="doc-tab" data-tab="table" style="display:none">Table</button>`;
}

function homePanelHTML() {
  const undo = groupHTML('Undo', `
    <button type="button" data-ex="undo" title="Undo (Ctrl+Z)" disabled>↶</button>
    <button type="button" data-ex="redo" title="Redo (Ctrl+Y)" disabled>↷</button>`);
  const font = groupHTML('Font', `
    <select data-cmd="formatBlock" title="Paragraph style">
      <option value="p">Normal</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
    </select>
    <select data-cmd="fontName" title="Font">${FONTS.map((f) => `<option value="${f}">${f}</option>`).join('')}</select>
    <select data-fontsize title="Font size (pt)">${SIZES.map((s) => `<option value="${s}" ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <span class="tb-sep"></span>
    <button type="button" data-ex="bold" title="Bold"><b>B</b></button>
    <button type="button" data-ex="italic" title="Italic"><i>I</i></button>
    <button type="button" data-ex="underline" title="Underline"><u>U</u></button>
    <button type="button" data-ex="strikeThrough" title="Strikethrough"><s>S</s></button>
    <button type="button" data-ex="superscript" title="Superscript">x²</button>
    <button type="button" data-ex="subscript" title="Subscript">x₂</button>
    <label class="tb-color" title="Text color"><b>A</b><input type="color" data-color="foreColor" value="#16243d"></label>
    <label class="tb-color" title="Highlight">▣<input type="color" data-color="hiliteColor" value="#fff3b0"></label>
    <button type="button" data-ex="removeFormat" title="Clear formatting">⌫</button>`);
  const paragraph = groupHTML('Paragraph', `
    <button type="button" data-ex="justifyLeft" title="Align left">⬅</button>
    <button type="button" data-ex="justifyCenter" title="Align center">⬌</button>
    <button type="button" data-ex="justifyRight" title="Align right">➡</button>
    <button type="button" data-ex="justifyFull" title="Justify">☰</button>
    <button type="button" data-ex="insertUnorderedList" title="Bullet list">•≣</button>
    <button type="button" data-ex="insertOrderedList" title="Numbered list">1≣</button>
    <button type="button" data-ex="outdent" title="Decrease indent">⇤</button>
    <button type="button" data-ex="indent" title="Increase indent">⇥</button>`);
  const editing = groupHTML('Editing', `
    <button type="button" class="doc-tile" data-find title="Find &amp; replace (Ctrl+F)"><span class="doc-tile-ic">🔍</span><span class="doc-tile-lbl">Find</span></button>`);
  return undo + font + paragraph + editing;
}

function tile(kind, value, icon, label, extraClass) {
  return `<button type="button" data-${kind}="${value}" class="doc-tile ${extraClass || ''}" title="${label}">
    <span class="doc-tile-ic">${icon}</span><span class="doc-tile-lbl">${label}</span></button>`;
}

function insertPanelHTML() {
  const illustrations = groupHTML('Illustrations', tile('ins', 'image', '🖼', 'Picture'));
  const shapes = groupHTML('Shapes', tile('ins', 'shape-rect', '▭', 'Rectangle') + tile('ins', 'shape-oval', '⬭', 'Oval') + tile('ins', 'shape-line', '—', 'Line'));
  const tables = groupHTML('Tables', tile('ins', 'table', '▦', 'Table'));
  const links = groupHTML('Links', tile('ins', 'link', '🔗', 'Link'));
  const text = groupHTML('Text', tile('ins', 'checkbox', '☐', 'Checkbox') + tile('ins', 'hr', '―', 'Line')
    + tile('ins', 'pagebreak', '⤓', 'Page Break') + tile('ins', 'textbox', '▭', 'Text Box') + tile('ins', 'signature', '✒', 'Signature Line'));
  const symbols = groupHTML('Symbols', tile('ins', 'symbol', 'Ω', 'Symbol'));
  const template = groupHTML('Template', tile('ins', 'variable', '{ }', 'Variable', 'btn-variable') + tile('ins', 'formula', 'ƒx', 'Formula', 'btn-fx'));
  return illustrations + shapes + tables + links + text + symbols + template;
}

function layoutPanelHTML() {
  const pageSetup = groupHTML('Page Setup', `
    <div class="doc-tile-select"><span class="doc-tile-lbl">Size</span>
      <select class="doc-fs-type doc-pagesize" title="Page size">
        <option value="a4">A4</option><option value="letter">Letter</option><option value="custom">Custom</option>
      </select></div>
    <div class="doc-tile-select doc-orient-wrap"><span class="doc-tile-lbl">Orientation</span>
      <select class="doc-fs-type doc-orient" title="Page orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>
    <div class="doc-tile-select doc-custom-wrap" style="display:none"><span class="doc-tile-lbl">Width (mm)</span>
      <input type="number" class="doc-fs-type doc-custom-w" min="10" max="2000" step="0.1"></div>
    <div class="doc-tile-select doc-custom-wrap" style="display:none"><span class="doc-tile-lbl">Height (mm)</span>
      <input type="number" class="doc-fs-type doc-custom-h" min="10" max="2000" step="0.1"></div>
    <div class="doc-tile-select doc-custom-wrap" style="display:none"><span class="doc-tile-lbl">&nbsp;</span>
      <button type="button" class="icon-btn" data-swap-wh title="Swap width/height (portrait ⇄ landscape)">⇄</button></div>
    <div class="doc-tile-select"><span class="doc-tile-lbl">Margin (mm)</span>
      <input type="number" class="doc-fs-type doc-margin" min="0" max="100" step="0.5"></div>`);
  // Print tiling — repeat this design as a Rows x Columns grid on one printed page (e.g. HR
  // Payroll Slip's "2 employees x 2 copies each" = 2 columns x 2 rows). Doesn't affect the
  // canvas — it's consulted only when this template's records are printed in bulk
  // (public/js/views/form-records.js's printRecordsViaTemplate, via print-tiling.js). The page
  // itself always auto-fits whatever grid you pick; for the CONTENT to look clean at a smaller
  // cell size, design it with relative sizing (%, flexible layout) rather than fixed full-page
  // dimensions — same as any responsive design.
  // Continuous (off by default — every existing template keeps today's exact behavior): when
  // off, Grid rows above IS the repeat count, one clean page-block of Grid-columns records at a
  // time (today's only mode). When on, Grid rows x Grid columns instead becomes a fixed
  // physical page shape, Repeat becomes an independent copies-per-record count, and every
  // record's repeats pour continuously across as many such pages as needed — a record's own
  // repeat run can end up split across a page boundary once the numbers don't divide evenly.
  const copies = groupHTML('Print Grid', `
    <div class="doc-tile-select"><span class="doc-tile-lbl">Grid rows</span>
      <input type="number" class="doc-fs-type doc-copies" min="1" max="6" step="1"></div>
    <div class="doc-tile-select"><span class="doc-tile-lbl">Grid columns</span>
      <input type="number" class="doc-fs-type doc-records-per-page" min="1" max="6" step="1"></div>
    <div class="doc-tile-select"><span class="doc-tile-lbl">If fewer records than cells</span>
      <select class="doc-fs-type doc-tile-fill" title="What to do with leftover grid cells when you print fewer records than the grid holds">
        <option value="blank">Leave blank</option>
        <option value="repeat">Repeat to fill</option>
      </select></div>
    <div class="doc-tile-select"><span class="doc-tile-lbl">Continuous</span>
      <input type="checkbox" class="doc-fs-type doc-continuous" title="Off (default): Grid rows is the repeat count, one page-block of records at a time. On: Grid rows x Grid columns becomes a fixed page shape, Repeat (below) becomes independent, and records pour continuously across as many pages as needed."></div>
    <div class="doc-tile-select doc-repeat-wrap"><span class="doc-tile-lbl">Repeat</span>
      <input type="number" class="doc-fs-type doc-repeat" min="1" max="100" step="1" title="How many copies of each record to print. Only used when Continuous is on — independent of the Grid rows/columns shape above."></div>`);
  const zoom = groupHTML('Zoom', `
    <button type="button" data-zoom="out" title="Zoom out (Ctrl -)">−</button>
    <select class="doc-fs-type doc-zoomsel" title="Zoom level">
      <option value="fit">Fit</option>
      <option value="0.5">50%</option>
      <option value="0.67">67%</option>
      <option value="0.75">75%</option>
      <option value="1" selected>100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="2">200%</option>
      <option value="3">300%</option>
    </select>
    <button type="button" data-zoom="in" title="Zoom in (Ctrl +)">+</button>`);
  const previewGroup = groupHTML('Preview', `
    <button type="button" class="doc-tile" data-preview title="Open a movable preview"><span class="doc-tile-ic">👁</span><span class="doc-tile-lbl">Preview</span></button>`);
  return pageSetup + copies + zoom + previewGroup;
}

function tablePanelHTML() {
  const rowsCols = groupHTML('Rows &amp; Columns', `
    <button type="button" data-tbl="addRow" title="Insert row below">+Row</button>
    <button type="button" data-tbl="delRow" title="Delete row">−Row</button>
    <button type="button" data-tbl="addCol" title="Insert column right">+Col</button>
    <button type="button" data-tbl="delCol" title="Delete column">−Col</button>`);
  const merge = groupHTML('Merge', `
    <button type="button" data-tbl="mergeRight" title="Merge with cell on the right">Merge →</button>
    <button type="button" data-tbl="mergeDown" title="Merge with cell below">Merge ↓</button>
    <button type="button" data-tbl="split" title="Split merged cell">Split</button>`);
  const design = groupHTML('Design', `
    <label class="tb-color" title="Cell shading">▮<input type="color" data-cellbg value="#ffffff"></label>
    <button type="button" data-tbl="width" title="Set column width">↔ Width</button>
    <select data-tblstyle title="Table style"><option value="doc-table">Bordered</option><option value="doc-table striped">Striped</option><option value="doc-table shaded">Shaded header</option><option value="doc-table plain">Plain</option></select>`);
  const template = groupHTML('Template', `
    <button type="button" data-tbl="repeat" title="Repeat this row for each line item">↻ Item row</button>
    <button type="button" data-tbl="fxcell" class="btn-fx" title="Make this cell a formula (=)">= ƒx</button>
    <button type="button" data-tbl="delTable" title="Delete table">🗑</button>`);
  return rowsCols + merge + design + template;
}

/* ---- shared dialogs ---- */
function insertTableDialog(insertHtml, saveSel) {
  saveSel();
  UI.modal({
    title: 'Insert table',
    bodyHTML: `<div class="field-row"><div><label>Rows</label><input type="number" id="tb-rows" value="3" min="1" max="50"></div>
      <div><label>Columns</label><input type="number" id="tb-cols" value="3" min="1" max="20"></div></div>
      <label><input type="checkbox" id="tb-header" checked style="width:auto"> Header row</label>`,
    confirmText: 'Insert',
    onConfirm: (ov) => {
      const rows = Math.max(1, Number(ov.querySelector('#tb-rows').value) || 1);
      const cols = Math.max(1, Number(ov.querySelector('#tb-cols').value) || 1);
      const header = ov.querySelector('#tb-header').checked;
      // Real <thead>/<tbody> split so "Shaded header" / "Striped" styling and the print CSS line up,
      // and so striping counts data rows only. "Rows" is the total incl. the header row.
      const bodyRows = header ? Math.max(1, rows - 1) : rows;
      const cell = (t) => `<${t}>&nbsp;</${t}>`.repeat(cols);
      let html = '<table class="doc-table">';
      if (header) html += `<thead><tr>${cell('th')}</tr></thead>`;
      html += '<tbody>';
      for (let r = 0; r < bodyRows; r++) html += `<tr>${cell('td')}</tr>`;
      html += '</tbody></table><p><br></p>';
      insertHtml(html);
    },
  });
}

function imageDialog(insertHtml, saveSel) {
  saveSel();
  UI.modal({
    title: 'Insert image',
    bodyHTML: `<label>Image URL</label><input id="img-url" placeholder="https://…">
      <label>…or upload a file</label><input type="file" id="img-file" accept="image/*">
      <p class="muted" style="font-size:12px">Tip: you can also drag an image onto the page, or paste one.</p>`,
    confirmText: 'Insert',
    onConfirm: async (ov, showErr) => {
      const url = ov.querySelector('#img-url').value.trim();
      const file = ov.querySelector('#img-file').files[0];
      if (url) { insertHtml(`<img src="${escAttr(url)}" alt="">`); return; }
      if (!file) { showErr('Provide a URL or choose a file'); return false; }
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
      insertHtml(`<img src="${escAttr(dataUrl)}" alt="${escAttr(file.name)}">`);
    },
  });
}

const SYMBOLS = ['₱', '$', '€', '£', '¥', '©', '®', '™', '°', '§', '¶', '•', '★', '✓', '✗', '½', '¼', '¾', '×', '÷', '±', '№'];

function symbolDialog(insertHtml, saveSel) {
  saveSel();
  const m = UI.modal({
    title: 'Insert symbol',
    bodyHTML: `<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px">
      ${SYMBOLS.map((s) => `<button type="button" class="btn secondary" data-sym="${escAttr(s)}" style="font-size:16px;padding:8px 0">${s}</button>`).join('')}
    </div>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      ov.querySelectorAll('[data-sym]').forEach((b) => b.addEventListener('click', () => { insertHtml(b.dataset.sym + '&nbsp;'); m.close(); }));
    },
  });
}

/** In-editor cheat sheet — reached from the "?" button in the top bar. Pure reference,
    no editing side effects, so it takes no editor handles. Tabbed (one topic at a time,
    less to digest per screen) with small inline-SVG "screenshots" of the real chrome so a
    step reads as "look, then do" instead of a wall of text. */
function docEditorHelpDialog() {
  const kbd = (s) => `<span class="k">${s}</span>`;
  const lead = (html) => `<p class="dhg-lead">${html}</p>`;
  const step = (n, html, shot) => `<div class="dhg-step"><div class="dhg-num">${n}</div><div><p>${html}</p>${shot ? `<div class="dhg-shot">${shot}</div>` : ''}</div></div>`;
  const bullet = (html, shot) => `<div class="dhg-step"><div class="dhg-dot"></div><div><p>${html}</p>${shot ? `<div class="dhg-shot">${shot}</div>` : ''}</div></div>`;
  const note = (html) => `<div class="dhg-note">${html}</div>`;

  // ---- small inline-SVG mockups of the real chrome, so a step shows the thing, not just names it.
  // UI-chrome pieces (buttons/selects/handles) use var(--...) so they track the current theme; the
  // variable pill / table live on the white "paper" and are hardcoded light to match doc-editor.js's
  // actual (theme-independent) .doc-chip / .doc-table styling.
  const SHOT_MODES = `<svg viewBox="0 0 176 30" width="176" height="30" role="img" aria-label="Visual and HTML/CSS mode toggle">
    <rect x="1" y="2" width="174" height="26" rx="8" fill="var(--surface-2,#eef4fb)"/>
    <rect x="5" y="6" width="76" height="18" rx="6" fill="var(--surface,#fff)" stroke="var(--border,#dce6f2)"/>
    <text x="43" y="18.5" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--text,#16243d)" font-family="system-ui,sans-serif">Visual</text>
    <text x="128" y="18.5" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--text-muted,#5d6b84)" font-family="system-ui,sans-serif">HTML / CSS</text>
  </svg>`;
  const SHOT_VARFLOW = `<svg viewBox="0 0 300 40" width="300" height="40" role="img" aria-label="Insert Variable button producing an order.no pill">
    <rect x="2" y="2" width="88" height="36" rx="7" fill="var(--accent-weak,#e7f1ff)"/>
    <text x="46" y="18" font-size="12" font-weight="800" text-anchor="middle" fill="var(--accent,#2b7fff)" font-family="Consolas,monospace">{ }</text>
    <text x="46" y="31" font-size="9.5" font-weight="700" text-anchor="middle" fill="var(--accent,#2b7fff)" font-family="system-ui,sans-serif">Variable</text>
    <path d="M98 20h26M118 13l7 7-7 7" fill="none" stroke="var(--text-faint,#8a97ad)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="136" y="8" width="150" height="24" rx="12" fill="#e7f1ff" stroke="#9ec5ff"/>
    <text x="148" y="24" font-size="9" font-weight="800" fill="#1e6ef0" font-family="Consolas,monospace">{ }</text>
    <text x="166" y="24" font-size="11" font-weight="600" fill="#1e6ef0" font-family="Consolas,monospace">order.no</text>
  </svg>`;
  const SHOT_ITEMROW = `<svg viewBox="0 0 330 126" width="330" height="126" role="img" aria-label="A table with one row marked to repeat per line item">
    <rect x="1" y="1" width="328" height="22" fill="#f4f7fb" stroke="#d7dee8"/>
    <line x1="110" y1="1" x2="110" y2="103" stroke="#d7dee8"/>
    <line x1="220" y1="1" x2="220" y2="103" stroke="#d7dee8"/>
    <text x="10" y="15.5" font-size="10" font-weight="700" fill="#1a2740" font-family="system-ui,sans-serif">Item</text>
    <text x="119" y="15.5" font-size="10" font-weight="700" fill="#1a2740" font-family="system-ui,sans-serif">Qty</text>
    <text x="229" y="15.5" font-size="10" font-weight="700" fill="#1a2740" font-family="system-ui,sans-serif">Total</text>
    <rect x="1" y="23" width="328" height="26" fill="#fff" stroke="#d7dee8"/>
    <rect x="1" y="49" width="328" height="18" fill="#fff" stroke="#eef0f4"/>
    <rect x="1" y="67" width="328" height="18" fill="#fbfcfe" stroke="#eef0f4"/>
    <rect x="1" y="85" width="328" height="18" fill="#fff" stroke="#eef0f4"/>
    <rect x="2" y="24" width="326" height="24" fill="none" stroke="#2b7fff" stroke-width="2"/>
    <rect x="9" y="30" width="70" height="12" rx="6" fill="#e7f1ff" stroke="#9ec5ff"/>
    <text x="14" y="39" font-size="8" fill="#1e6ef0" font-family="Consolas,monospace">name</text>
    <rect x="119" y="30" width="64" height="12" rx="6" fill="#e7f1ff" stroke="#9ec5ff"/>
    <text x="124" y="39" font-size="8" fill="#1e6ef0" font-family="Consolas,monospace">quantity</text>
    <rect x="229" y="30" width="72" height="12" rx="6" fill="#e7f1ff" stroke="#9ec5ff"/>
    <text x="234" y="39" font-size="8" fill="#1e6ef0" font-family="Consolas,monospace">line_total</text>
    <rect x="234" y="106" width="92" height="18" rx="6" fill="#e7f1ff" stroke="#2b7fff"/>
    <text x="280" y="118.5" font-size="9.5" font-weight="700" text-anchor="middle" fill="#2b7fff" font-family="system-ui,sans-serif">↻ Item row</text>
  </svg>`;
  const SHOT_FXBTN = `<svg viewBox="0 0 92 40" width="92" height="40" role="img" aria-label="Formula button">
    <rect x="2" y="2" width="88" height="36" rx="7" fill="var(--success-weak,#e3f6ec)"/>
    <text x="46" y="18" font-size="12" font-weight="800" font-style="italic" text-anchor="middle" fill="var(--success,#168f54)" font-family="Georgia,serif">ƒx</text>
    <text x="46" y="31" font-size="9.5" font-weight="700" text-anchor="middle" fill="var(--success,#168f54)" font-family="system-ui,sans-serif">Formula</text>
  </svg>`;
  const SHOT_LAYOUT = `<svg viewBox="0 0 280 38" width="280" height="38" role="img" aria-label="Layout tab: page size, orientation, and margin controls">
    <text x="2" y="9" font-size="7.5" font-weight="700" fill="var(--text-faint,#8a97ad)" font-family="system-ui,sans-serif">SIZE</text>
    <rect x="2" y="13" width="80" height="20" rx="5" fill="var(--surface,#fff)" stroke="var(--border-strong,#c6d4e6)"/>
    <text x="10" y="26.5" font-size="10" fill="var(--text,#16243d)" font-family="system-ui,sans-serif">A4</text>
    <path d="M70 21l4 5 4-5" fill="none" stroke="var(--text-muted,#5d6b84)" stroke-width="1.3"/>
    <text x="94" y="9" font-size="7.5" font-weight="700" fill="var(--text-faint,#8a97ad)" font-family="system-ui,sans-serif">ORIENTATION</text>
    <rect x="94" y="13" width="110" height="20" rx="5" fill="var(--surface,#fff)" stroke="var(--border-strong,#c6d4e6)"/>
    <text x="102" y="26.5" font-size="10" fill="var(--text,#16243d)" font-family="system-ui,sans-serif">Portrait</text>
    <path d="M190 21l4 5 4-5" fill="none" stroke="var(--text-muted,#5d6b84)" stroke-width="1.3"/>
    <text x="216" y="9" font-size="7.5" font-weight="700" fill="var(--text-faint,#8a97ad)" font-family="system-ui,sans-serif">MARGIN (MM)</text>
    <rect x="216" y="13" width="52" height="20" rx="5" fill="var(--surface,#fff)" stroke="var(--border-strong,#c6d4e6)"/>
    <text x="224" y="26.5" font-size="10" fill="var(--text,#16243d)" font-family="system-ui,sans-serif">14</text>
  </svg>`;
  const SHOT_FLOAT = `<svg viewBox="0 0 190 122" width="190" height="122" role="img" aria-label="A selected floating object with resize handles and a corner grip">
    <rect x="34" y="2" width="72" height="16" rx="5" fill="var(--surface,#fff)" stroke="var(--border,#dce6f2)"/>
    <text x="70" y="13.5" font-size="9" text-anchor="middle" fill="var(--text-muted,#5d6b84)" font-family="system-ui,sans-serif">⬆ ⬇ ↩ 🗑</text>
    <rect x="34" y="26" width="122" height="80" fill="var(--surface-2,#eef4fb)" stroke="var(--accent,#2b7fff)" stroke-width="1.5"/>
    <g fill="#fff" stroke="var(--accent,#2b7fff)" stroke-width="1.5">
      <rect x="30" y="22" width="8" height="8"/><rect x="91" y="22" width="8" height="8"/><rect x="152" y="22" width="8" height="8"/>
      <rect x="30" y="62" width="8" height="8"/><rect x="152" y="62" width="8" height="8"/>
      <rect x="30" y="102" width="8" height="8"/><rect x="91" y="102" width="8" height="8"/>
    </g>
    <rect x="150" y="100" width="12" height="12" rx="2" fill="var(--accent,#2b7fff)" stroke="#fff" stroke-width="1.5"/>
  </svg>`;

  const PANES = {
    basics: lead('It behaves like a normal document — type, format, and drop in tables or pictures.')
      + bullet('Switch between the page and its raw code with <b>Visual</b> / <b>HTML&nbsp;/&nbsp;CSS</b> in the top bar.', SHOT_MODES)
      + bullet(`${kbd('Ctrl')}+${kbd('S')} saves. ${kbd('Ctrl')}+${kbd('Z')} / ${kbd('Ctrl')}+${kbd('Y')} undo and redo <i>everything</i> — text, tables, moved objects.`)
      + bullet('<b>👁 Preview</b> (Layout tab) opens a movable preview filled with realistic sample data.')
      + bullet('<b>⚙</b> makes your own named variables. This <b>?</b> guide is always one click away.')
      + note('Nothing on the page is “live” — variables and formulas only turn into real values when the document is printed.'),

    variables: lead('A variable is a blank the system fills in at print time — a name, a number, a date.')
      + step(1, 'Open <b>Insert</b> → <b>{ } Variable</b> — or just type <code>{{ }}</code> right on the page.')
      + step(2, "Pick a field: company name, order number, customer, today's date…")
      + step(3, 'It drops in as a blue pill. On the printed page it becomes the real value.', SHOT_VARFLOW)
      + bullet('Want your own? <b>⚙</b> in the top bar — a fixed value, a bound field, or a saved formula.')
      + bullet('Hide a block when its value is empty: <code>{{#if order.notes}} … {{/if}}</code> (HTML&nbsp;/&nbsp;CSS mode).'),

    repeat: lead('One table row can print once for every line item — 3 of them, or 300.')
      + step(1, 'Insert a table (<b>Insert → Table</b>), or use one that’s already on the page.')
      + step(2, 'In <b>one</b> body row, place the per-item fields — <code>name</code>, <code>quantity</code>, <code>unit_price</code>, <code>line_total</code> — and <code>{{index}}</code> for a row number.')
      + step(3, 'Click into that row → the <b>Table</b> tab appears → <b>Template</b> group → <b>↻ Item row</b>.', SHOT_ITEMROW)
      + note('Mark only the data row — never the header. That one marked row prints once per line item and flows onto new pages by itself.'),

    formulas: lead('<b>ƒx Formula</b> works out numbers — per row, or one grand total.')
      + bullet('Inside an item row: <code>quantity * unit_price</code> — worked out for each row.', SHOT_FXBTN)
      + bullet('A grand total, anywhere: <code>sum(items.line_total)</code>, <code>count(items)</code> — correct at any row count.')
      + bullet('The order’s own figures are ready to use: <code>{{order.subtotal}}</code>, <code>{{order.tax_amount}}</code>, <code>{{order.total}}</code>.')
      + bullet('Add one via <b>Insert → ƒx Formula</b>, or on a table cell via <b>Table</b> tab → <b>= ƒx</b>.'),

    layout: lead('The <b>Layout</b> tab controls the paper and how a long document breaks across pages.')
      + bullet('Paper <b>size</b>, <b>orientation</b>, and <b>margins</b>.', SHOT_LAYOUT)
      + bullet(`<b>Zoom</b> — the −/+/Fit control, ${kbd('Ctrl')}+scroll, or ${kbd('Ctrl')}+${kbd('+')} / ${kbd('-')} / ${kbd('0')}.`)
      + bullet('Long tables split across pages on their own; a real header row reprints on each page.')
      + bullet('Force a new page: <b>Insert → Page Break</b>.'),

    move: lead('Shapes, text boxes, pictures and tables can float — dragged and resized freely.')
      + step(1, 'Click a picture, table, or block → <b>⛶ Make … movable</b> on the small bar that appears.')
      + step(2, '<b>Click once</b> to select — drag the light frame around it to move. <b>Click again</b> inside to start typing.', SHOT_FLOAT)
      + step(3, 'Square handles resize. While typing, one blue corner grip stays — <b>drag</b> it to resize, <b>click</b> it to get the move handles back.')
      + bullet('Pink guide lines snap edges and centres to other objects and the page margins.')
      + bullet(`${kbd('Esc')} steps back out — typing → move → deselected. The toolbar's <b>↩</b> puts an object back into the flowing text.`),
  };

  const TABS = [
    ['basics', '📄', 'Basics'],
    ['variables', '{ }', 'Variables'],
    ['repeat', '↻', 'Repeating rows'],
    ['formulas', 'ƒx', 'Formulas & totals'],
    ['layout', '▭', 'Layout & pages'],
    ['move', '⛶', 'Move & resize'],
  ];
  const navHtml = TABS.map(([key, ic, label], i) => `<button type="button" class="dhg-tab${i === 0 ? ' active' : ''}" data-t="${key}"><span class="dhg-tab-ic">${ic}</span>${UI.esc(label)}</button>`).join('');
  const paneHtml = TABS.map(([key], i) => `<section class="dhg-pane${i === 0 ? ' active' : ''}" data-t="${key}">${PANES[key]}</section>`).join('');

  UI.modal({
    title: 'Template editor — quick guide',
    size: 'lg',
    cancelText: 'Close',
    bodyHTML: `
      <style>
        .dhg{display:grid;grid-template-columns:168px 1fr;gap:0;min-height:380px}
        .dhg-nav{display:flex;flex-direction:column;gap:2px;padding-right:14px;border-right:1px solid var(--border,#dce6f2)}
        .dhg-tab{display:flex;align-items:center;gap:9px;text-align:left;border:none;background:none;font:inherit;font-size:12.5px;font-weight:600;color:var(--text-muted,#5d6b84);padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
        .dhg-tab:hover{background:var(--surface-2,#eef4fb);color:var(--text,#16243d)}
        .dhg-tab.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
        .dhg-tab-ic{display:inline-flex;align-items:center;justify-content:center;width:20px;flex-shrink:0;font-size:12.5px;font-family:Consolas,ui-monospace,monospace}
        .dhg-body{padding-left:20px;min-width:0;max-height:56vh;overflow-y:auto}
        .dhg-pane{display:none}
        .dhg-pane.active{display:block;animation:dhgIn .12s ease}
        @keyframes dhgIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
        .dhg-lead{font-size:13.5px;color:var(--text-muted,#5d6b84);line-height:1.55;margin:0 0 16px}
        .dhg-step{display:grid;grid-template-columns:24px 1fr;gap:11px;margin:0 0 16px}
        .dhg-step:last-child{margin-bottom:0}
        .dhg-num{width:24px;height:24px;border-radius:50%;background:var(--accent,#2b7fff);color:#fff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .dhg-dot{width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .dhg-dot::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--text-faint,#8a97ad)}
        .dhg-step p{margin:0;font-size:13px;line-height:1.55;color:var(--text,#16243d)}
        .dhg-step code{background:var(--surface-2,#eef4fb);border:1px solid var(--border,#dce6f2);border-radius:4px;padding:0 4px;font-family:Consolas,ui-monospace,monospace;font-size:12px}
        .dhg-step .k{display:inline-block;border:1px solid var(--border-strong,#c6d4e6);border-bottom-width:2px;border-radius:5px;padding:0 5px;font-size:10.5px;font-weight:700;background:var(--surface,#fff);color:var(--text,#16243d)}
        .dhg-shot{margin-top:9px;border:1px solid var(--border,#dce6f2);border-radius:9px;padding:12px 14px;background:var(--surface-2,#eef4fb);overflow-x:auto}
        .dhg-shot svg{display:block;max-width:100%;height:auto}
        .dhg-note{background:var(--accent-weak,#e7f1ff);color:var(--text,#16243d);border-radius:9px;padding:10px 12px;font-size:12.5px;line-height:1.55;margin-top:4px}
        @media (max-width:640px){
          .dhg{grid-template-columns:1fr}
          .dhg-nav{flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--border,#dce6f2);padding:0 0 10px;margin-bottom:12px}
          .dhg-body{padding-left:0;max-height:none}
        }
      </style>
      <div class="dhg">
        <nav class="dhg-nav">${navHtml}</nav>
        <div class="dhg-body">${paneHtml}</div>
      </div>`,
    onOpen: (ov) => {
      const nav = ov.querySelector('.dhg-nav');
      const body = ov.querySelector('.dhg-body');
      nav.addEventListener('click', (e) => {
        const b = e.target.closest('[data-t]');
        if (!b) return;
        nav.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b));
        body.querySelectorAll('.dhg-pane').forEach((p) => p.classList.toggle('active', p.dataset.t === b.dataset.t));
        body.scrollTop = 0;
      });
    },
  });
}

/** Variable picker (search + category tabs). insertFn receives the chosen token. */
function variableDialog(saveSel, getVariables, insertFn, opts = {}) {
  saveSel();
  const vars = getVariables ? getVariables() : [];
  const cats = [...new Set(vars.map((v) => v.category || 'Other'))];
  const rowHtml = (v) => `<button type="button" class="var-pick" data-token="${escAttr(v.token || v.key)}">${UI.esc(v.label || v.key)} <span class="muted mono">${escAttr(v.token || ('{{' + v.key + '}}'))}</span></button>`;
  const m = UI.modal({
    title: opts.title || 'Insert variable',
    bodyHTML: `<input class="var-search" id="var-search" placeholder="Search variables…" autocomplete="off">
      <div class="var-tabs" id="var-tabs">${cats.map((c, i) => `<button type="button" class="var-tab ${i === 0 ? 'active' : ''}" data-cat="${escAttr(c)}">${UI.esc(c)}</button>`).join('')}</div>
      <div class="var-pick-list" id="var-list"></div>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      const listEl = ov.querySelector('#var-list'); const search = ov.querySelector('#var-search'); let activeCat = cats[0];
      const wire = () => listEl.querySelectorAll('.var-pick').forEach((b) => b.onclick = () => { insertFn(b.dataset.token); if (!opts.keepOpen) m.close(); });
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const shown = q ? vars.filter((v) => ((v.label || '') + ' ' + (v.token || v.key || '')).toLowerCase().includes(q)) : vars.filter((v) => (v.category || 'Other') === activeCat);
        listEl.innerHTML = shown.length ? shown.map(rowHtml).join('') : '<div class="empty">No matching variables</div>'; wire();
      };
      ov.querySelectorAll('#var-tabs [data-cat]').forEach((b) => b.onclick = () => { activeCat = b.dataset.cat; search.value = ''; ov.querySelectorAll('#var-tabs [data-cat]').forEach((x) => x.classList.toggle('active', x === b)); render(); });
      search.addEventListener('input', () => { const s = !!search.value.trim(); ov.querySelectorAll('#var-tabs [data-cat]').forEach((x) => x.classList.toggle('active', !s && x.dataset.cat === activeCat)); render(); });
      render(); search.focus();
    },
  });
  return m;
}

/** Formula builder — clearly sectioned, with tooltips and a live result. */
function formulaDialog(insertHtml, saveSel, getVariables, initial, sampleContext) {
  saveSel();
  const vars = getVariables ? getVariables() : [];
  const cats = [...new Set(vars.map((v) => v.category || 'Other'))];
  const refOf = (tok) => String(tok).replace(/^\{\{|\}\}$/g, '');
  const itemFields = vars.filter((v) => /item|line/i.test(v.category || '')).map((v) => ({ label: v.label || v.key, ref: refOf(v.token || v.key) }));
  const FNS = [
    { t: 'sum(', d: 'Add up a column of numbers — e.g. sum(items.line_total)' },
    { t: 'avg(', d: 'Average of a column of numbers' },
    { t: 'count(', d: 'How many line items — count(items)' },
    { t: 'min(', d: 'Smallest value' },
    { t: 'max(', d: 'Largest value' },
    { t: 'round(', d: 'Round a number — round(value, 2)' },
  ];
  const OPS = [['+', 'Add'], ['-', 'Subtract'], ['*', 'Multiply'], ['/', 'Divide'], ['(', 'Open bracket'], [')', 'Close bracket']];

  const m = UI.modal({
    title: 'Insert a formula',
    size: 'lg',
    bodyHTML: `
      <div class="fx-tip">A formula calculates a value that shows on the printed document. <b>On each row</b> of an Item row, use fields like <code>quantity * unit_price</code>. For a <b>grand total</b>, <b>sum a column</b> — it stays correct whether there are 3 rows or 300.</div>

      <div class="fx-section">
        <div class="fx-h">1 · Your formula</div>
        <input class="fx-input" id="fx-expr" placeholder="e.g. sum(items.line_total) * 1.12" value="${escAttr(initial || '')}">
        <div class="fx-result">Result on sample data: <b id="fx-out">—</b></div>
      </div>

      <div class="fx-section">
        <div class="fx-h">2 · Sum a whole column <span class="fx-sub">grand totals — work for any number of rows</span></div>
        <div class="fx-funcs" id="fx-cols"></div>
      </div>

      <div class="fx-section">
        <div class="fx-h">3 · Functions &amp; operators <span class="fx-sub">hover for what each does</span></div>
        <div class="fx-funcs" id="fx-fns">
          ${FNS.map((f) => `<button type="button" data-fn="${escAttr(f.t)}" title="${escAttr(f.d)}">${UI.esc(f.t)}</button>`).join('')}
          <span class="tb-sep" style="height:20px"></span>
          ${OPS.map(([o, d]) => `<button type="button" data-fn=" ${escAttr(o)} " title="${escAttr(d)}">${UI.esc(o)}</button>`).join('')}
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-h">4 · Insert a value or per-row field <span class="fx-sub">e.g. unit_price, order.subtotal</span></div>
        <input class="var-search" id="var-search" placeholder="Search variables…" autocomplete="off">
        <div class="var-tabs" id="var-tabs">${cats.map((c, i) => `<button type="button" class="var-tab ${i === 0 ? 'active' : ''}" data-cat="${escAttr(c)}">${UI.esc(c)}</button>`).join('')}</div>
        <div class="var-pick-list" id="var-list"></div>
      </div>`,
    confirmText: 'Insert formula',
    onConfirm: (ov) => {
      const expr = ov.querySelector('#fx-expr').value.trim();
      if (!expr) { UI.toast('Type a formula first', 'error'); return false; }
      insertHtml(tokenChip('= ' + expr) + '&nbsp;');
    },
    onOpen: (ov) => {
      const expr = ov.querySelector('#fx-expr');
      const out = ov.querySelector('#fx-out');
      const put = (t) => { const s = expr.selectionStart ?? expr.value.length; expr.value = expr.value.slice(0, s) + t + expr.value.slice(expr.selectionEnd ?? s); expr.focus(); const p = s + t.length; expr.setSelectionRange(p, p); updateResult(); };
      const updateResult = () => {
        const e = expr.value.trim();
        if (!e) { out.textContent = '—'; out.className = ''; return; }
        try {
          const ev = (typeof evalFormula !== 'undefined') ? evalFormula : null;
          if (!ev) { out.textContent = '(preview unavailable)'; return; }
          const v = ev(e, sampleContext || {});
          out.textContent = (typeof v === 'number') ? (Number.isInteger(v) ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : String(v);
          out.className = 'fx-ok';
        } catch { out.textContent = '⚠ not a valid formula yet'; out.className = 'fx-bad'; }
      };
      expr.addEventListener('input', updateResult);
      ov.querySelectorAll('#fx-fns [data-fn]').forEach((b) => b.onclick = () => put(b.dataset.fn));

      const colsEl = ov.querySelector('#fx-cols');
      colsEl.innerHTML = itemFields.length
        ? itemFields.map((f) => `<button type="button" data-col="${escAttr(f.ref)}" title="Sum of the ${escAttr(f.label)} column across every line item">Σ ${UI.esc(f.label)}</button>`).join('') + '<button type="button" data-col="__count" title="Number of line items">#  Count items</button>'
        : '<span class="muted" style="font-size:12px">Add an “Item row” to your table first, then its columns appear here to sum.</span>';
      colsEl.querySelectorAll('[data-col]').forEach((b) => b.onclick = () => put(b.dataset.col === '__count' ? 'count(items)' : `sum(items.${b.dataset.col})`));

      const listEl = ov.querySelector('#var-list'); const search = ov.querySelector('#var-search'); let activeCat = cats[0];
      const wire = () => listEl.querySelectorAll('.var-pick').forEach((b) => b.onclick = () => put(refOf(b.dataset.token)));
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const shown = q ? vars.filter((v) => ((v.label || '') + ' ' + (v.token || v.key || '')).toLowerCase().includes(q)) : vars.filter((v) => (v.category || 'Other') === activeCat);
        listEl.innerHTML = shown.length ? shown.map((v) => `<button type="button" class="var-pick" data-token="${escAttr(v.token || v.key)}">${UI.esc(v.label || v.key)} <span class="muted mono">${escAttr(refOf(v.token || v.key))}</span></button>`).join('') : '<div class="empty">No matches</div>'; wire();
      };
      ov.querySelectorAll('#var-tabs [data-cat]').forEach((b) => b.onclick = () => { activeCat = b.dataset.cat; search.value = ''; ov.querySelectorAll('#var-tabs [data-cat]').forEach((x) => x.classList.toggle('active', x === b)); render(); });
      search.addEventListener('input', () => { const s = !!search.value.trim(); ov.querySelectorAll('#var-tabs [data-cat]').forEach((x) => x.classList.toggle('active', !s && x.dataset.cat === activeCat)); render(); });
      render(); updateResult(); expr.focus();
    },
  });
  return m;
}

/* ---- wiring ---- */
function wireToolbar(panelsRoot, surface, getVariables, onChange, sampleContext, tabApi, getZoom, onUndo, onRedo) {
  const zoomNow = () => (typeof getZoom === 'function' ? Number(getZoom()) : 1) || 1;
  let savedRange = null;
  const saveSel = () => { const sel = window.getSelection(); if (sel && sel.rangeCount && surface.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { surface.focus(); if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } };
  const exec = (cmd, val) => { restoreSel(); document.execCommand(cmd, false, val); saveSel(); onChange(); };
  const insertHtml = (html) => { restoreSel(); document.execCommand('insertHTML', false, html); saveSel(); onChange(); };
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }

  ['mouseup', 'keyup'].forEach((ev) => surface.addEventListener(ev, () => { saveSel(); updateTableBar(); }));

  panelsRoot.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // Undo/Redo run the editor's own snapshot history (covers floats/tables/page-setup), not the
    // browser's execCommand stack which only ever saw the rich-text edits.
    if (b.dataset.ex === 'undo') { if (onUndo) onUndo(); return; }
    if (b.dataset.ex === 'redo') { if (onRedo) onRedo(); return; }
    exec(b.dataset.ex);
  }));
  panelsRoot.querySelectorAll('select[data-cmd]').forEach((sel) => sel.addEventListener('change', () => exec(sel.dataset.cmd, sel.value)));
  panelsRoot.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('input', () => exec(inp.dataset.color, inp.value)));

  // numeric font size (pt) via the size-7 hack + CSS
  panelsRoot.querySelector('[data-fontsize]').addEventListener('change', (e) => {
    restoreSel();
    document.execCommand('fontSize', false, '7');
    surface.querySelectorAll('font[size="7"]').forEach((f) => { f.removeAttribute('size'); f.style.fontSize = e.target.value + 'pt'; });
    saveSel(); onChange();
  });

  // inserts
  panelsRoot.querySelector('[data-ins="link"]').addEventListener('click', () => { saveSel(); UI.modal({ title: 'Insert link', bodyHTML: `<label>URL</label><input id="lnk" placeholder="https://…">`, confirmText: 'Insert', onConfirm: (ov) => { const u = ov.querySelector('#lnk').value.trim(); if (!u) return false; exec('createLink', u); } }); });
  panelsRoot.querySelector('[data-ins="hr"]').addEventListener('click', () => insertHtml('<hr>'));
  panelsRoot.querySelector('[data-ins="pagebreak"]').addEventListener('click', () => insertHtml('<div class="doc-pagebreak" style="page-break-after:always"></div><p><br></p>'));
  panelsRoot.querySelector('[data-ins="table"]').addEventListener('click', () => insertTableDialog(insertHtml, saveSel));
  panelsRoot.querySelector('[data-ins="image"]').addEventListener('click', () => imageDialog(insertHtml, saveSel));
  panelsRoot.querySelector('[data-ins="checkbox"]').addEventListener('click', () => insertHtml('<span class="doc-checkbox" data-checked="0">&#9744;</span>&nbsp;'));
  panelsRoot.querySelector('[data-ins="variable"]').addEventListener('click', () => variableDialog(saveSel, getVariables, (tok) => insertHtml(tokenChip(tok.replace(/^\{\{|\}\}$/g, '')) + '&nbsp;')));
  panelsRoot.querySelector('[data-ins="formula"]').addEventListener('click', () => formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext));
  panelsRoot.querySelector('[data-ins="symbol"]').addEventListener('click', () => symbolDialog(insertHtml, saveSel));
  panelsRoot.querySelector('[data-ins="textbox"]').addEventListener('click', () => insertFloat('textbox'));
  panelsRoot.querySelector('[data-ins="shape-rect"]').addEventListener('click', () => insertFloat('shape-rect'));
  panelsRoot.querySelector('[data-ins="shape-oval"]').addEventListener('click', () => insertFloat('shape-oval'));
  panelsRoot.querySelector('[data-ins="shape-line"]').addEventListener('click', () => insertFloat('shape-line'));
  panelsRoot.querySelector('[data-ins="signature"]').addEventListener('click', () =>
    insertHtml('<div style="margin-top:24px;width:220px;border-top:1px solid #333;padding-top:4px;text-align:center;font-size:11px">Signature over Printed Name</div><p><br></p>'));

  // ---- table helpers ----
  const cellOf = (node) => { let n = node; while (n && n !== surface) { if (n.nodeName === 'TD' || n.nodeName === 'TH') return n; n = n.parentNode; } return null; };
  const currentCell = () => cellOf(savedRange ? savedRange.startContainer : (window.getSelection().anchorNode));
  function updateTableBar() {
    tabApi.setTableTabVisible(!!currentCell());
  }

  const tbl = {
    addRow() { const c = currentCell(); if (!c) return; const row = c.parentNode; const tr = row.ownerDocument.createElement('tr'); for (let i = 0; i < row.children.length; i++) { const td = row.ownerDocument.createElement('td'); td.innerHTML = '&nbsp;'; tr.appendChild(td); } row.parentNode.insertBefore(tr, row.nextSibling); },
    delRow() { const c = currentCell(); if (!c) return; const row = c.parentNode; const tb = row.parentNode; if (tb.children.length > 1) row.remove(); },
    addCol() { const c = currentCell(); if (!c) return; const idx = c.cellIndex; c.closest('table').querySelectorAll('tr').forEach((tr) => { const cell = tr.ownerDocument.createElement(tr.children[0] && tr.children[0].nodeName === 'TH' ? 'th' : 'td'); cell.innerHTML = '&nbsp;'; tr.insertBefore(cell, tr.children[idx + 1] || null); }); },
    delCol() { const c = currentCell(); if (!c) return; const idx = c.cellIndex; const table = c.closest('table'); if (table.rows[0].cells.length <= 1) return; table.querySelectorAll('tr').forEach((tr) => { if (tr.children[idx]) tr.children[idx].remove(); }); },
    mergeRight() { const c = currentCell(); if (!c) return; const next = c.nextElementSibling; if (!next) return; c.colSpan = (c.colSpan || 1) + (next.colSpan || 1); c.innerHTML += ' ' + next.innerHTML; next.remove(); },
    mergeDown() { const c = currentCell(); if (!c) return; const row = c.parentNode; const below = row.nextElementSibling; if (!below) return; const cell = below.children[c.cellIndex]; if (!cell) return; c.rowSpan = (c.rowSpan || 1) + (cell.rowSpan || 1); c.innerHTML += ' ' + cell.innerHTML; cell.remove(); },
    split() { const c = currentCell(); if (!c) return; const cs = c.colSpan || 1; c.colSpan = 1; c.rowSpan = 1; const row = c.parentNode; for (let i = 1; i < cs; i++) { const td = row.ownerDocument.createElement('td'); td.innerHTML = '&nbsp;'; row.insertBefore(td, c.nextSibling); } },
    width() { const c = currentCell(); if (!c) return; const cur = parseInt(c.style.width) || ''; UI.modal({ title: 'Column width', bodyHTML: `<label>Width in pixels (blank = auto)</label><input id="cw" type="number" value="${cur}" placeholder="e.g. 120">`, confirmText: 'Apply', onConfirm: (ov) => { const w = ov.querySelector('#cw').value; const idx = c.cellIndex; c.closest('table').querySelectorAll('tr').forEach((tr) => { if (tr.children[idx]) tr.children[idx].style.width = w ? w + 'px' : ''; }); } }); },
    repeat() { const c = currentCell(); if (!c) return; const tr = c.parentNode; if (tr.hasAttribute('data-repeat')) { tr.removeAttribute('data-repeat'); tr.classList.remove('is-repeat'); UI.toast('Row no longer repeats'); } else { tr.setAttribute('data-repeat', 'items'); tr.classList.add('is-repeat'); UI.toast('This row will repeat for every line item when printed'); } },
    fxcell() { const c = currentCell(); if (!c) return; formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext); },
    delTable() { const c = currentCell(); if (!c) return; const t = c.closest('table'); UI.confirmDialog('Delete this whole table?', 'Delete').then((ok) => { if (ok) { t.remove(); updateTableBar(); onChange(); } }); },
  };
  panelsRoot.querySelectorAll('[data-tbl]').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault(); const fn = tbl[b.dataset.tbl]; if (fn) { fn(); if (b.dataset.tbl !== 'delTable') onChange(); }
  }));
  panelsRoot.querySelector('[data-cellbg]').addEventListener('input', (e) => { const c = currentCell(); if (c) { c.style.background = e.target.value; onChange(); } });
  panelsRoot.querySelector('[data-tblstyle]').addEventListener('change', (e) => { const c = currentCell(); if (c) { c.closest('table').className = e.target.value; onChange(); } });

  // checkbox toggle
  surface.addEventListener('click', (e) => { const box = e.target.closest('.doc-checkbox'); if (!box) return; const on = box.getAttribute('data-checked') === '1'; box.setAttribute('data-checked', on ? '0' : '1'); box.innerHTML = on ? '&#9744;' : '&#9745;'; onChange(); });

  // transient native color picker (opens within the user gesture)
  const pickColor = (initial, cb) => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = (initial && /^#[0-9a-f]{6}$/i.test(initial)) ? initial : '#ffffff';
    inp.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(inp);
    inp.addEventListener('input', () => cb(inp.value));
    inp.addEventListener('change', () => setTimeout(() => inp.remove(), 150));
    inp.click();
  };

  // ---- Excel-style rectangular cell selection + column resize ----
  const tableOf = (c) => c && c.closest && c.closest('table');
  const clearCellSel = () => surface.querySelectorAll('.cell-sel').forEach((c) => c.classList.remove('cell-sel'));
  const selectedCells = () => [...surface.querySelectorAll('td.cell-sel,th.cell-sel')];
  function markRect(a, b) {
    clearCellSel();
    const table = tableOf(a);
    if (!table || tableOf(b) !== table) { a.classList.add('cell-sel'); return; }
    const rows = [...table.rows];
    const r1 = Math.min(a.parentNode.rowIndex, b.parentNode.rowIndex), r2 = Math.max(a.parentNode.rowIndex, b.parentNode.rowIndex);
    const c1 = Math.min(a.cellIndex, b.cellIndex), c2 = Math.max(a.cellIndex, b.cellIndex);
    for (let r = r1; r <= r2; r++) { const row = rows[r]; if (!row) continue; for (let c = c1; c <= c2; c++) { if (row.cells[c]) row.cells[c].classList.add('cell-sel'); } }
  }
  function mergeSelection() {
    const cells = selectedCells();
    if (cells.length < 2) { tbl.mergeRight(); return; }
    const table = tableOf(cells[0]); const rows = [...table.rows];
    let r1 = Infinity, r2 = -1, c1 = Infinity, c2 = -1;
    cells.forEach((c) => { const ri = c.parentNode.rowIndex, ci = c.cellIndex; r1 = Math.min(r1, ri); r2 = Math.max(r2, ri); c1 = Math.min(c1, ci); c2 = Math.max(c2, ci); });
    const top = rows[r1].cells[c1]; const extra = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const cell = rows[r].cells[c]; if (cell && cell !== top) { const h = cell.innerHTML.trim(); if (h && h !== '&nbsp;') extra.push(h); } }
    top.colSpan = c2 - c1 + 1; top.rowSpan = r2 - r1 + 1;
    if (extra.length) top.innerHTML = (top.innerHTML.trim() === '' || top.innerHTML === '&nbsp;' ? '' : top.innerHTML + ' ') + extra.join(' ');
    for (let r = r2; r >= r1; r--) for (let c = c2; c >= c1; c--) { const cell = rows[r].cells[c]; if (cell && cell !== top) cell.remove(); }
    clearCellSel(); onChange();
  }
  function splitCells() {
    const cells = selectedCells().length ? selectedCells() : (currentCell() ? [currentCell()] : []);
    cells.forEach((c) => {
      const cs = c.colSpan || 1, rs = c.rowSpan || 1; if (cs === 1 && rs === 1) return;
      const row = c.parentNode; const table = c.closest('table'); const ri = row.rowIndex; const ci = c.cellIndex;
      c.colSpan = 1; c.rowSpan = 1;
      for (let i = 1; i < cs; i++) { const td = row.ownerDocument.createElement('td'); td.innerHTML = '&nbsp;'; row.insertBefore(td, c.nextSibling); }
      for (let r = 1; r < rs; r++) { const below = table.rows[ri + r]; if (!below) continue; for (let i = 0; i < cs; i++) { const td = below.ownerDocument.createElement('td'); td.innerHTML = '&nbsp;'; below.insertBefore(td, below.cells[ci] || null); } }
    });
    clearCellSel(); onChange();
  }

  let selAnchor = null, selecting = false, resizeIdx = null, resizeCells = null, resizeX0 = 0, resizeW0 = 0;
  surface.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const cell = e.target.closest('td,th');
    if (!cell || !surface.contains(cell)) { clearCellSel(); return; }
    const rect = cell.getBoundingClientRect();
    if (rect.right - e.clientX <= 6) { // column-resize handle
      e.preventDefault();
      resizeIdx = cell.cellIndex; resizeX0 = e.clientX; resizeW0 = rect.width;
      resizeCells = [...cell.closest('table').rows].map((r) => r.cells[resizeIdx]).filter(Boolean);
      return;
    }
    clearCellSel(); selAnchor = cell; selecting = true;
  });
  surface.addEventListener('mousemove', (e) => {
    if (resizeIdx !== null && resizeCells) { const w = Math.max(24, resizeW0 + (e.clientX - resizeX0)); resizeCells.forEach((c) => { c.style.width = w + 'px'; }); return; }
    if (!selecting) { const cell = e.target.closest('td,th'); surface.style.cursor = cell && (cell.getBoundingClientRect().right - e.clientX <= 6) ? 'col-resize' : ''; return; }
    if (e.buttons === 1 && selAnchor) { const cell = e.target.closest('td,th'); if (cell && cell !== selAnchor && tableOf(cell) === tableOf(selAnchor)) { e.preventDefault(); const s = window.getSelection(); if (s) s.removeAllRanges(); markRect(selAnchor, cell); } }
  });
  document.addEventListener('mouseup', () => { if (resizeIdx !== null) { resizeIdx = null; resizeCells = null; onChange(); } selecting = false; });

  // right-click a cell → design menu (multi-cell when a range is selected)
  surface.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td,th');
    if (!cell || !surface.contains(cell)) return;
    e.preventDefault();
    const multi = selectedCells();
    const act = (fn) => { fn(); onChange(); };
    if (multi.length > 1) {
      const applyAll = (style, val) => act(() => multi.forEach((c) => { c.style[style] = val; }));
      UI.contextMenu(e.clientX, e.clientY, [
        { label: `Merge ${multi.length} cells`, onClick: () => mergeSelection() },
        { label: 'Split cells', onClick: () => splitCells() },
        { label: 'Background…', icon: 'edit', onClick: () => pickColor(cell.style.backgroundColor, (c) => applyAll('background', c)) },
        { label: 'Text color…', icon: 'edit', onClick: () => pickColor(cell.style.color, (c) => applyAll('color', c)) },
        { label: 'Align center', onClick: () => applyAll('textAlign', 'center') },
        { label: 'Bold', onClick: () => applyAll('fontWeight', 'bold') },
      ]);
      return;
    }
    const r = document.createRange(); r.selectNodeContents(cell); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); saveSel();
    UI.contextMenu(e.clientX, e.clientY, [
      { label: 'Cell background…', icon: 'edit', onClick: () => pickColor(cell.style.backgroundColor, (c) => act(() => { cell.style.background = c; })) },
      { label: 'Text color…', icon: 'edit', onClick: () => pickColor(cell.style.color, (c) => act(() => { cell.style.color = c; })) },
      { label: 'Align left', onClick: () => act(() => { cell.style.textAlign = 'left'; }) },
      { label: 'Align center', onClick: () => act(() => { cell.style.textAlign = 'center'; }) },
      { label: 'Align right', onClick: () => act(() => { cell.style.textAlign = 'right'; }) },
      { label: 'Bold cell', onClick: () => act(() => { cell.style.fontWeight = cell.style.fontWeight === 'bold' ? '' : 'bold'; }) },
      { label: 'Insert row below', icon: 'plus', onClick: () => act(tbl.addRow) },
      { label: 'Insert column right', icon: 'plus', onClick: () => act(tbl.addCol) },
      { label: (cell.colSpan > 1 || cell.rowSpan > 1) ? 'Split cell' : 'Merge with right', onClick: () => (cell.colSpan > 1 || cell.rowSpan > 1) ? splitCells() : act(tbl.mergeRight) },
      { label: 'Merge with below', onClick: () => act(tbl.mergeDown) },
      { label: 'Delete row', icon: 'trash', onClick: () => act(tbl.delRow) },
      { label: 'Delete column', icon: 'trash', onClick: () => act(tbl.delCol) },
    ]);
  });

  // ---- VS Code-style {{ autocomplete for variables ----
  let acPopup = null, acItems = [], acIndex = 0, acRange = null;
  const closeAC = () => { if (acPopup) { acPopup.remove(); acPopup = null; acRange = null; } };
  const highlightAC = () => { if (acPopup) acPopup.querySelectorAll('.doc-ac-item').forEach((el, i) => el.classList.toggle('active', i === acIndex)); };
  const acceptAC = (i) => {
    const v = acItems[i]; if (!v || !acRange) return closeAC();
    const r = document.createRange();
    try { r.setStart(acRange.node, acRange.start); r.setEnd(acRange.node, acRange.end); } catch (e) { return closeAC(); }
    r.deleteContents();
    const tok = String(v.token || v.key || '').replace(/^\{\{|\}\}$/g, '');
    const tmp = document.createElement('div'); tmp.innerHTML = tokenChip(tok) + ' ';
    const frag = document.createDocumentFragment(); let last = null;
    while (tmp.firstChild) { last = tmp.firstChild; frag.appendChild(tmp.firstChild); }
    r.insertNode(frag);
    if (last) { const nr = document.createRange(); nr.setStartAfter(last); nr.collapse(true); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(nr); }
    closeAC(); saveSel(); onChange();
  };
  const updateAC = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return closeAC();
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== 3) return closeAC();
    const before = node.textContent.slice(0, range.startOffset);
    const m = before.match(/\{\{([\w. ]*)$/); // "{{" then a partial name, not yet closed
    if (!m) return closeAC();
    const query = m[1].trim().toLowerCase();
    const vars = getVariables ? getVariables() : [];
    acItems = vars.filter((v) => ((v.label || '') + ' ' + (v.token || v.key || '')).toLowerCase().includes(query)).slice(0, 8);
    if (!acItems.length) return closeAC();
    acIndex = 0;
    acRange = { node, start: range.startOffset - m[0].length, end: range.startOffset };
    closeAC();
    acPopup = document.createElement('div'); acPopup.className = 'doc-ac';
    acPopup.innerHTML = acItems.map((v, i) => `<div class="doc-ac-item${i === 0 ? ' active' : ''}" data-i="${i}">${UI.esc(v.label || v.token)} <span class="doc-ac-tok">${escAttr(v.token || v.key)}</span></div>`).join('');
    document.body.appendChild(acPopup);
    let rect = null;
    try { rect = range.getBoundingClientRect(); } catch (e) { /* not available */ }
    if (!rect || (!rect.left && !rect.bottom)) { try { rect = surface.getBoundingClientRect(); } catch (e2) { rect = { left: 40, bottom: 80 }; } }
    acPopup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 290)) + 'px';
    acPopup.style.top = (rect.bottom + 4) + 'px';
    acPopup.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); acceptAC(Number(el.dataset.i)); }));
  };
  surface.addEventListener('input', updateAC);
  surface.addEventListener('keydown', (e) => {
    if (!acPopup) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; highlightAC(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; highlightAC(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAC(acIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAC(); }
  }, true);
  surface.addEventListener('blur', () => setTimeout(closeAC, 150));

  // Excel-style "=" trigger: typing "=" at the start of an empty cell opens the formula builder
  surface.addEventListener('keydown', (e) => {
    if (e.key !== '=' || e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+= is the zoom-in shortcut
    const c = currentCell();
    if (c && c.textContent.trim() === '') { e.preventDefault(); saveSel(); formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext); }
  });

  // drag-drop + paste images
  const embed = (file) => { const fr = new FileReader(); fr.onload = () => insertHtml(`<img src="${escAttr(fr.result)}" alt="${escAttr(file.name || '')}">`); fr.readAsDataURL(file); };
  surface.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
  surface.addEventListener('drop', (e) => { const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => /^image\//.test(f.type)); if (files.length) { e.preventDefault(); saveSel(); files.forEach(embed); } });
  surface.addEventListener('paste', (e) => {
    const cd = e.clipboardData; if (!cd) return;
    const img = [...(cd.items || [])].find((i) => /^image\//.test(i.type));
    if (img) { e.preventDefault(); saveSel(); embed(img.getAsFile()); return; }
    const html = cd.getData('text/html');
    if (html) { e.preventDefault(); saveSel(); insertHtml(sanitizeHtml(html, document)); } // plain text falls through
  });
  surface.addEventListener('input', onChange);

  // reflect active inline-format state on the toolbar (Word-like)
  const STATE = { bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strikeThrough' };
  const reflect = () => {
    if (!surface.isConnected) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !surface.contains(sel.anchorNode)) return;
    Object.keys(STATE).forEach((cmd) => {
      const b = panelsRoot.querySelector(`[data-ex="${cmd}"]`);
      if (b) { try { b.classList.toggle('active', document.queryCommandState(cmd)); } catch (e) { /* ignore */ } }
    });
  };
  document.addEventListener('selectionchange', reflect);

  // ---- floating objects: shapes, text boxes, and images/tables "promoted" to wrap text ----
  const FLOAT_DEFAULTS = {
    'shape-rect': { w: 30, h: 15, html: '<div class="doc-float-shape" style="background:#dce6f2;border:1px solid #5d6b84"></div>' },
    'shape-oval': { w: 30, h: 15, html: '<div class="doc-float-shape" style="border-radius:50%;background:#dce6f2;border:1px solid #5d6b84"></div>' },
    'shape-line': { w: 40, h: 1.2, html: '<div class="doc-float-shape" style="background:#5d6b84"></div>' },
    textbox: { w: 30, h: 12, html: '<div class="doc-float-body" contenteditable="true">Text box</div>' },
  };
  let floatSeq = 0;
  let selectedFloat = null;      // the one float with resize handles + toolbar
  const multiSet = new Set();    // a transient multi-selection ("temporary group") — move/delete together
  let promoteBar = null;
  let promoteTarget = null;
  const pxToPct = (px, total) => (total ? (px / total) * 100 : 0);

  // ---- snap-to-guide during a float drag/resize ----
  // Every position here is in real on-screen CSS px: getBoundingClientRect() already includes the
  // page's CSS scale() and e.clientX is viewport px. So the snap tolerance is a plain screen-px
  // constant (no zoom factor — that's what keeps it a constant *visual* distance), while the
  // min-size clamp multiplies by zoom because it means "12px in the final document", not on screen.
  const SNAP_SCREEN_PX = 6;
  let snapGuideEls = [];
  function clearSnapGuides() { snapGuideEls.forEach((el) => el.remove()); snapGuideEls = []; }
  function drawGuide(orient, posPx, pageRect) {
    const g = document.createElement('div');
    g.className = 'doc-snap-guide ' + orient;
    g.setAttribute('contenteditable', 'false');
    if (orient === 'v') g.style.left = pxToPct(posPx, pageRect.width) + '%';
    else g.style.top = pxToPct(posPx, pageRect.height) + '%';
    surface.appendChild(g);
    snapGuideEls.push(g);
  }
  function nearestLine(v, lines, tol) {
    let best = null; let bd = tol;
    for (const L of lines) { const d = Math.abs(v - L); if (d <= bd) { bd = d; best = L; } }
    return best;
  }
  // left / centre-x / right (and top / middle-y / bottom) of every OTHER float, page-origin px
  function siblingLines(exclude, pageRect) {
    const xs = []; const ys = [];
    surface.querySelectorAll('.doc-float').forEach((f) => {
      if (f === exclude) return;
      const r = f.getBoundingClientRect();
      const l = r.left - pageRect.left; const rt = r.right - pageRect.left;
      const t = r.top - pageRect.top; const b = r.bottom - pageRect.top;
      xs.push(l, (l + rt) / 2, rt);
      ys.push(t, (t + b) / 2, b);
    });
    return { xs, ys };
  }
  // page frame + margin box + page centre, in the same scaled-px space
  function pageLines(pageRect, z) {
    const cs = window.getComputedStyle(surface);
    const padL = (parseFloat(cs.paddingLeft) || 0) * z;
    const padR = (parseFloat(cs.paddingRight) || 0) * z;
    const padT = (parseFloat(cs.paddingTop) || 0) * z;
    const padB = (parseFloat(cs.paddingBottom) || 0) * z;
    const W = pageRect.width; const H = pageRect.height;
    return { xs: [0, padL, W / 2, W - padR, W], ys: [0, padT, H / 2, H - padB, H] };
  }
  // returns a snapped { left, top, w, h }; draws the guide line(s) it snapped to
  function applySnap(floatEl, pageRect, box, op) {
    clearSnapGuides();
    const z = zoomNow();
    const tol = SNAP_SCREEN_PX; // real screen px — no zoom factor (see note above)
    const minPx = 12 * z; // 12px in the final document
    const sib = siblingLines(floatEl, pageRect);
    const pg = pageLines(pageRect, z);
    const xs = pg.xs.concat(sib.xs);
    const ys = pg.ys.concat(sib.ys);
    let { left, top, w, h } = box;
    if (op === 'move') {
      for (const px of [left, left + w / 2, left + w]) {
        const L = nearestLine(px, xs, tol);
        if (L != null) { left += L - px; drawGuide('v', L, pageRect); break; }
      }
      for (const py of [top, top + h / 2, top + h]) {
        const L = nearestLine(py, ys, tol);
        if (L != null) { top += L - py; drawGuide('h', L, pageRect); break; }
      }
    } else { // 'resize:<handle>'
      const hh = op.slice(7);
      if (hh.includes('e')) { const v = left + w; const L = nearestLine(v, xs, tol); if (L != null) { w = Math.max(minPx, L - left); drawGuide('v', left + w, pageRect); } }
      if (hh.includes('w')) { const v = left; const L = nearestLine(v, xs, tol); if (L != null) { const nl = Math.min(L, left + w - minPx); w += left - nl; left = nl; drawGuide('v', left, pageRect); } }
      if (hh.includes('s')) { const v = top + h; const L = nearestLine(v, ys, tol); if (L != null) { h = Math.max(minPx, L - top); drawGuide('h', top + h, pageRect); } }
      if (hh.includes('n')) { const v = top; const L = nearestLine(v, ys, tol); if (L != null) { const nt = Math.min(L, top + h - minPx); h += top - nt; top = nt; drawGuide('h', top, pageRect); } }
    }
    return { left, top, w, h };
  }

  // Tag names that are almost always a short inline run inside running prose (bold word, link,
  // …), never a standalone "field" someone would want to pull out and move — excluded from the
  // generic "click anything to make it a floating/wrap-text object" promotion below, so clicking
  // a bold word mid-sentence doesn't rip it out of the paragraph. TD/TH are excluded too: a table
  // cell should stay a cell (promote the whole <table> instead).
  const PROMOTE_EXCLUDE_TAGS = new Set(['BR', 'HR', 'TD', 'TH', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'A', 'FONT']);

  function clearPromoteBar() { if (promoteBar) { promoteBar.remove(); promoteBar = null; } promoteTarget = null; }

  function deselectFloat() {
    if (!selectedFloat) return;
    selectedFloat.classList.remove('selected', 'editing');
    selectedFloat.querySelectorAll(':scope > .doc-float-handle, :scope > .doc-float-toolbar').forEach((n) => n.remove());
    selectedFloat = null;
    clearSnapGuides();
  }

  // The editable interior of an islanded float (text box / promoted table / promoted block).
  const islandOf = (f) => {
    if (!f) return null;
    const kind = f.getAttribute('data-float-kind');
    if (kind === 'textbox') return f.querySelector(':scope > .doc-float-body');
    if (kind === 'table' || kind === 'text') return f.firstElementChild;
    return null;
  };
  // While the caret sits inside the selected float's interior it's in "edit mode": drop the grab
  // frame + resize handles (the CSS does the hiding) so they don't sit on top of what you're typing.
  const updateEditing = () => {
    if (!selectedFloat) return;
    const island = islandOf(selectedFloat);
    const sel = window.getSelection();
    selectedFloat.classList.toggle('editing', !!(island && sel && sel.anchorNode && island.contains(sel.anchorNode)));
  };
  document.addEventListener('selectionchange', updateEditing);

  function clearMulti() { multiSet.forEach((f) => f.classList.remove('multi')); multiSet.clear(); }

  // Shift-click a float to add/remove it from the transient group. The first shift-click also
  // folds the current single selection in, so "click A, shift-click B" gives {A, B}.
  function toggleMulti(floatEl) {
    if (multiSet.has(floatEl)) {
      floatEl.classList.remove('multi');
      multiSet.delete(floatEl);
    } else {
      if (selectedFloat && selectedFloat !== floatEl) { multiSet.add(selectedFloat); selectedFloat.classList.add('multi'); }
      multiSet.add(floatEl);
      floatEl.classList.add('multi');
    }
    deselectFloat();                 // handles/toolbar belong to single-select mode only
    if (multiSet.size === 1) { const only = [...multiSet][0]; clearMulti(); selectFloat(only); } // back to single
  }

  // The one "get me out of here" call: drop every kind of float selection + the promote bar.
  // Returns true if it actually cleared something (so callers can swallow the Escape key etc).
  function blurFloats() {
    const had = !!selectedFloat || multiSet.size > 0 || !!promoteBar;
    deselectFloat();
    clearMulti();
    clearPromoteBar();
    return had;
  }

  function wrapToolbarHTML(floatEl) {
    const kind = floatEl.getAttribute('data-float-kind');
    let html = `<button type="button" data-float-act="z-up" title="Bring forward">⬆</button>`
      + `<button type="button" data-float-act="z-down" title="Send backward (past the text)">⬇</button>`;
    if (kind === 'image' || kind === 'table' || kind === 'text') html += `<button type="button" data-float-act="inline" title="Put back in the text (stop floating)">↩</button>`;
    if (kind.startsWith('shape-')) html += `<button type="button" data-float-act="fill" title="Fill color">🎨</button><button type="button" data-float-act="border" title="Border color">▢</button>`;
    html += `<button type="button" data-float-act="delete" title="Delete">🗑</button>`;
    return html;
  }

  const HANDLE_POS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  function selectFloat(floatEl) {
    if (selectedFloat === floatEl) return;
    deselectFloat();
    clearPromoteBar();
    floatEl.classList.add('selected');
    floatEl.classList.remove('editing');
    // selecting = "move mode". If a caret is sitting in the interior (e.g. the click that opened
    // the promote bar left one in a table cell), drop it so updateEditing doesn't immediately
    // flip us back into .editing and hide the move/resize handles.
    const island = islandOf(floatEl);
    const sel = window.getSelection();
    if (island && sel && sel.anchorNode && island.contains(sel.anchorNode)) sel.removeAllRanges();
    HANDLE_POS.forEach((h) => {
      const hd = document.createElement('div');
      hd.className = 'doc-float-handle'; hd.setAttribute('data-h', h); hd.setAttribute('contenteditable', 'false');
      // the SE handle doubles as the "grip" shown while editing an islanded float
      if (h === 'se') hd.title = 'Drag to resize · click for the move handles';
      floatEl.appendChild(hd);
    });
    const tb = document.createElement('div');
    tb.className = 'doc-float-toolbar'; tb.setAttribute('contenteditable', 'false');
    tb.innerHTML = wrapToolbarHTML(floatEl);
    floatEl.appendChild(tb);
    selectedFloat = floatEl;
  }

  function insertFloat(kind) {
    const def = FLOAT_DEFAULTS[kind];
    if (!def) return;
    const n = floatSeq++;
    const left = 8 + (n % 6) * 4, top = 8 + (n % 6) * 4;
    const el = document.createElement('div');
    el.className = 'doc-float';
    el.setAttribute('data-float-kind', kind);
    el.setAttribute('contenteditable', 'false');
    el.style.cssText = `position:absolute;left:${left}%;top:${top}%;width:${def.w}%;height:${def.h}%;z-index:1`;
    el.innerHTML = def.html;
    surface.appendChild(el);
    selectFloat(el);
    onChange();
  }

  // New floats start at z:1 (one step in front of the implicit z:0 of normal text); the toolbar's
  // ⬆/⬇ nudge it by ±1 from there. IMG and TABLE are stretched to fill the wrapper so drag-resize
  // grows them (IMG via an inline width/height:100%, TABLE via CSS grid-stretch — see the
  // `.doc-float[data-float-kind="table"]` rules). A generic promoted block ('text') keeps its own
  // sizing — it often has meaningful CSS of its own (a circular photo mask, a fixed-size card).
  function promoteToFloat(target) {
    const kind = target.nodeName === 'IMG' ? 'image' : target.nodeName === 'TABLE' ? 'table' : 'text';
    const rect = target.getBoundingClientRect();
    const pageRect = surface.getBoundingClientRect();
    const leftPct = pxToPct(rect.left - pageRect.left, pageRect.width);
    const topPct = pxToPct(rect.top - pageRect.top, pageRect.height);
    const wPct = pxToPct(rect.width, pageRect.width);
    const hPct = pxToPct(rect.height, pageRect.height);
    const wrap = document.createElement('div');
    wrap.className = 'doc-float';
    wrap.setAttribute('data-float-kind', kind);
    wrap.setAttribute('contenteditable', 'false');
    wrap.style.cssText = `position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;z-index:1`;
    target.parentNode.insertBefore(wrap, target);
    wrap.appendChild(target);
    if (kind === 'table' || kind === 'text') target.setAttribute('contenteditable', 'true');
    if (kind === 'image') { target.style.width = '100%'; target.style.height = '100%'; }
    selectFloat(wrap);
    onChange();
  }

  function unpromoteFloat(floatEl) {
    const inner = floatEl.firstElementChild;
    if (!inner) { floatEl.remove(); deselectFloat(); onChange(); return; }
    inner.style.width = ''; inner.style.height = '';
    inner.removeAttribute('contenteditable');
    floatEl.parentNode.insertBefore(inner, floatEl);
    floatEl.remove();
    deselectFloat();
    onChange();
  }

  function showPromoteBar(target) {
    clearPromoteBar(); deselectFloat();
    const rect = target.getBoundingClientRect();
    const pageRect = surface.getBoundingClientRect();
    // Don't offer to "make movable" a page-spanning container (the outer <div class="doc">, a
    // full-width section…): promoting it turns the whole document into one un-editable block —
    // the classic "I can't get out of it" trap. Nudge the user to pick a specific element.
    const areaRatio = (rect.width * rect.height) / ((pageRect.width * pageRect.height) || 1);
    const blockKids = [...target.children].filter((c) => /^(DIV|P|TABLE|H[1-6]|UL|OL|SECTION|HEADER|FOOTER|FIGURE)$/.test(c.nodeName)).length;
    if (areaRatio > 0.55 || (target.querySelector('table') && blockKids > 1)) {
      if (typeof UI !== 'undefined' && UI.toast) UI.toast('Click the specific block — a table, heading, image — to make it movable');
      return;
    }
    promoteTarget = target;
    promoteBar = document.createElement('div');
    promoteBar.className = 'doc-promote-bar'; promoteBar.setAttribute('contenteditable', 'false');
    // %-positioned (scales with the page) at the target's top-left; the CSS transform lifts it
    // above the target and counter-scales it so it stays a constant on-screen size at any zoom.
    promoteBar.style.left = pxToPct(rect.left - pageRect.left, pageRect.width) + '%';
    promoteBar.style.top = pxToPct(Math.max(0, rect.top - pageRect.top), pageRect.height) + '%';
    const what = target.nodeName === 'IMG' ? 'image' : target.nodeName === 'TABLE' ? 'table' : 'block';
    promoteBar.innerHTML = `<button type="button" data-promote="make" title="Make this a movable, resizable object">⛶ Make ${what} movable</button>`;
    surface.appendChild(promoteBar);
  }

  surface.addEventListener('click', (e) => {
    const actBtn = e.target.closest('.doc-float-toolbar button');
    if (actBtn && selectedFloat) {
      const act = actBtn.dataset.floatAct;
      if (act === 'delete') { const f = selectedFloat; selectedFloat = null; f.remove(); onChange(); return; }
      if (act === 'inline') { unpromoteFloat(selectedFloat); return; }
      if (act === 'z-up' || act === 'z-down') {
        // Clamp to [-2, 60]: below 0 is "behind the text", but there's no reason to go deeper, and
        // staying under the 1000+ handle/toolbar layer keeps a front-most float from covering its
        // own selection chrome. isolation:isolate on .doc-page keeps even -2 on the white paper.
        const cur = parseInt(selectedFloat.style.zIndex, 10) || 0;
        const next = Math.max(-2, Math.min(60, cur + (act === 'z-up' ? 1 : -1)));
        selectedFloat.style.zIndex = String(next);
        selectedFloat.classList.toggle('behind-text', next < 0);
        onChange();
        return;
      }
      if (act === 'fill' || act === 'border') {
        const shape = selectedFloat.querySelector(':scope > .doc-float-shape');
        if (shape) {
          const prop = act === 'fill' ? 'backgroundColor' : 'borderColor';
          pickColor(shape.style[prop] || (act === 'fill' ? '#dce6f2' : '#5d6b84'), (val) => { shape.style[prop] = val; onChange(); });
        }
        return;
      }
      return;
    }
    const promoteBtn = e.target.closest('.doc-promote-bar button');
    if (promoteBtn) { const t = promoteTarget; clearPromoteBar(); if (t) promoteToFloat(t); return; }

    const floatEl = e.target.closest('.doc-float');
    if (floatEl) {
      if (e.shiftKey) { toggleMulti(floatEl); return; }
      clearMulti();
      selectFloat(floatEl);
      return;
    }

    deselectFloat();
    clearMulti();
    const target = e.target;
    const inSurface = target && target !== surface && surface.contains(target) && !target.closest('.doc-float')
      && !target.closest('.doc-chip') && !target.classList.contains('doc-checkbox');
    // A click inside a table lands on a TD/TH (PROMOTE_EXCLUDE_TAGS below skips those — a single
    // cell can't be "made movable" on its own, and popping the bar on every cell click while
    // typing would be noisy). But cells are the ONLY thing you can click INTO in a table, so
    // without this, a table could never be selected for promotion at all — walk up to the
    // enclosing <table> and offer that instead.
    const tableEl = inSurface ? target.closest('table') : null;
    if (tableEl) { showPromoteBar(tableEl); return; }
    if (inSurface && !PROMOTE_EXCLUDE_TAGS.has(target.nodeName)) {
      showPromoteBar(target);
      return;
    }
    clearPromoteBar();
  });

  // Float drag/resize runs on Pointer Events with pointer capture, so a drag survives the pointer
  // leaving the window or passing over the preview <iframe> (plain document mousemove stops firing
  // there). All geometry is kept in getBoundingClientRect() space — which is post-CSS-zoom — so the
  // percentage conversions below need no zoom factor; only the min-size clamp scales with zoom.
  let dragState = null;
  const samePointer = (e) => !dragState || dragState.pointerId == null || e.pointerId == null || e.pointerId === dragState.pointerId;

  surface.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('.doc-float-handle');
    if (handle && selectedFloat) {
      e.preventDefault(); e.stopPropagation();
      const pageRect = surface.getBoundingClientRect();
      const startRect = selectedFloat.getBoundingClientRect();
      dragState = {
        mode: 'resize', h: handle.dataset.h, floatEl: selectedFloat, pageRect,
        startLeft: startRect.left - pageRect.left, startTop: startRect.top - pageRect.top,
        startW: startRect.width, startH: startRect.height, x0: e.clientX, y0: e.clientY,
        pointerId: e.pointerId, captureEl: handle, moved: false,
      };
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* jsdom / unsupported */ }
      return;
    }
    const floatEl = e.target.closest('.doc-float');
    if (!floatEl) return;
    // Shapes/images have no editable interior, so any press starts a drag. Text boxes / promoted
    // tables / promoted blocks have an editable island — a press there must NOT start a drag.
    const editableRoot = islandOf(floatEl);
    const onToolbar = !!e.target.closest('.doc-float-toolbar');
    const onIsland = !!(editableRoot && (e.target === editableRoot || editableRoot.contains(e.target)));
    if (onToolbar) return;
    if (onIsland) {
      // First press on an un-selected islanded float → select it for moving and swallow the caret
      // (Word-style: click once to select, click again to type). A press while it's already
      // selected falls through so the browser drops a caret → that's "enter edit mode".
      if (!e.shiftKey && selectedFloat !== floatEl && !(multiSet.size >= 2 && multiSet.has(floatEl))) {
        e.preventDefault();
        clearMulti();
        selectFloat(floatEl);
      }
      return;
    }
    if (e.shiftKey) return;
    // A press on the selection grab-frame (the padding the CSS adds around the island when
    // selected) targets the wrapper itself → start a move.
    e.preventDefault();

    const groupMove = multiSet.size >= 2 && multiSet.has(floatEl);
    if (!groupMove && selectedFloat !== floatEl) { clearMulti(); selectFloat(floatEl); }
    const pageRect = surface.getBoundingClientRect();
    const startRect = floatEl.getBoundingClientRect();
    dragState = {
      mode: 'move', floatEl, pageRect,
      startLeft: startRect.left - pageRect.left, startTop: startRect.top - pageRect.top,
      startW: startRect.width, startH: startRect.height, x0: e.clientX, y0: e.clientY,
      pointerId: e.pointerId, captureEl: floatEl, moved: false,
      group: groupMove ? [...multiSet].map((f) => {
        const r = f.getBoundingClientRect();
        return { f, sl: r.left - pageRect.left, st: r.top - pageRect.top };
      }) : null,
    };
    try { floatEl.setPointerCapture(e.pointerId); } catch (err) { /* jsdom / unsupported */ }
  });

  const onFloatPointerMove = (e) => {
    if (!dragState || !samePointer(e)) return;
    const { floatEl, pageRect } = dragState;
    const dx = e.clientX - dragState.x0, dy = e.clientY - dragState.y0;
    if (dx || dy) dragState.moved = true;
    const z = zoomNow();
    const minPx = 12 * z;
    if (dragState.mode === 'move') {
      if (dragState.group) { // temporary group: everyone shifts by the same delta, no snapping
        dragState.group.forEach(({ f, sl, st }) => {
          f.style.left = pxToPct(Math.max(0, sl + dx), pageRect.width) + '%';
          f.style.top = pxToPct(Math.max(0, st + dy), pageRect.height) + '%';
        });
        return;
      }
      let box = {
        left: Math.max(0, dragState.startLeft + dx), top: Math.max(0, dragState.startTop + dy),
        w: dragState.startW, h: dragState.startH,
      };
      box = applySnap(floatEl, pageRect, box, 'move');
      floatEl.style.left = pxToPct(box.left, pageRect.width) + '%';
      floatEl.style.top = pxToPct(box.top, pageRect.height) + '%';
      return;
    }
    const { startLeft, startTop, startW, startH, h } = dragState;
    let left = startLeft, top = startTop, w = startW, ht = startH;
    if (h.includes('e')) w = Math.max(minPx, startW + dx);
    if (h.includes('s')) ht = Math.max(minPx, startH + dy);
    if (h.includes('w')) { w = Math.max(minPx, startW - dx); left = startLeft + (startW - w); }
    if (h.includes('n')) { ht = Math.max(minPx, startH - dy); top = startTop + (startH - ht); }
    const box = applySnap(floatEl, pageRect, { left, top, w, h: ht }, 'resize:' + h);
    floatEl.style.left = pxToPct(box.left, pageRect.width) + '%';
    floatEl.style.top = pxToPct(box.top, pageRect.height) + '%';
    floatEl.style.width = pxToPct(box.w, pageRect.width) + '%';
    floatEl.style.height = pxToPct(box.h, pageRect.height) + '%';
  };
  const endFloatDrag = (e) => {
    if (!dragState || (e && !samePointer(e))) return;
    const st = dragState;
    dragState = null;
    try { if (st.captureEl && st.pointerId != null && st.captureEl.releasePointerCapture) st.captureEl.releasePointerCapture(st.pointerId); } catch (err) { /* ignore */ }
    clearSnapGuides();
    if (st.moved) { onChange(); return; } // a plain click that selected a float is not an edit
    // Tapped the edit-mode corner grip (a resize handle) without dragging → hand back the full
    // move/resize chrome so the object can be repositioned.
    if (st.mode === 'resize' && st.floatEl && st.floatEl.classList.contains('editing')) {
      st.floatEl.classList.remove('editing');
      const sel = window.getSelection(); if (sel) sel.removeAllRanges();
      try { surface.focus(); } catch (err) { /* ignore */ }
    }
  };
  document.addEventListener('pointermove', onFloatPointerMove);
  document.addEventListener('pointerup', endFloatDrag);
  document.addEventListener('pointercancel', endFloatDrag);

  const onFloatKeydown = (e) => {
    // Escape while an object is selected clears the selection instead of closing the whole editor.
    // stopImmediatePropagation keeps open()'s document-level onKey (registered after us) from also
    // acting on the same Escape. Two-stage (Word-style): Escape while typing in an islanded float's
    // interior first pops back out to the move/resize handles; a second Escape deselects.
    if (e.key === 'Escape' && (selectedFloat || multiSet.size || promoteBar)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (selectedFloat && selectedFloat.classList.contains('editing')) {
        selectedFloat.classList.remove('editing');
        const sel = window.getSelection(); if (sel) sel.removeAllRanges();
        try { surface.focus(); } catch (err) { /* ignore */ }
      } else {
        blurFloats();
      }
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const active = document.activeElement;
    const typingInside = (f) => active && f.contains(active) && active !== f; // caret is in an editable island
    if (multiSet.size) {
      if ([...multiSet].some(typingInside)) return;
      e.preventDefault();
      multiSet.forEach((f) => f.remove());
      clearMulti();
      onChange();
      return;
    }
    if (!selectedFloat) return;
    if (typingInside(selectedFloat)) return;
    e.preventDefault();
    const f = selectedFloat; selectedFloat = null; f.remove(); onChange();
  };
  document.addEventListener('keydown', onFloatKeydown);

  // Loaded/saved HTML never carries `contenteditable` (serializeEditor strips it from every
  // element before saving, same as it does for the ambient surface) — re-apply it to floats
  // after any full innerHTML reload (initial open + code->visual mode switch) so wrappers go
  // back to being atomic drag/select targets and their editable islands (text box body,
  // promoted table) become typable again.
  function normalizeFloats() {
    // a full innerHTML reload detaches whatever was selected — forget it, don't leave a dangling ref
    selectedFloat = null; multiSet.clear(); clearSnapGuides(); clearPromoteBar();
    surface.querySelectorAll('.doc-float').forEach((el) => {
      el.setAttribute('contenteditable', 'false');
      el.classList.remove('selected', 'multi', 'editing');
      el.classList.toggle('behind-text', (parseInt(el.style.zIndex, 10) || 0) < 0); // restore the hint
      const kind = el.getAttribute('data-float-kind');
      if (kind === 'textbox') { const body = el.querySelector(':scope > .doc-float-body'); if (body) body.setAttribute('contenteditable', 'true'); }
      else if (kind === 'table' || kind === 'text') { const inner = el.firstElementChild; if (inner) inner.setAttribute('contenteditable', 'true'); }
    });
  }

  updateTableBar();
  return {
    teardown() {
      document.removeEventListener('selectionchange', reflect);
      document.removeEventListener('selectionchange', updateEditing);
      document.removeEventListener('pointermove', onFloatPointerMove);
      document.removeEventListener('pointerup', endFloatDrag);
      document.removeEventListener('pointercancel', endFloatDrag);
      document.removeEventListener('keydown', onFloatKeydown);
      clearSnapGuides();
    },
    normalizeFloats,
    blurFloats, // drop any float selection / promote bar (used for click-outside + Escape)
  };
}

function open(opts = {}) {
  ensureStyles();
  const typeOptions = opts.typeOptions || ['sale', 'job', 'generic'];
  const fs = document.createElement('div');
  fs.className = 'doc-fs';
  fs.innerHTML = `
    <div class="doc-fs-bar">
      <div class="doc-fs-bar-scroll">
        <span class="doc-fs-title">${UI.esc(opts.title || 'Template')}</span>
        <input class="doc-fs-name" placeholder="Template name" value="${escAttr(opts.name || '')}">
        <select class="doc-fs-type doc-fs-type-top" title="Template type — which order type this template is used for (or Generic if it's not tied to one)">${typeOptions.map((t) => `<option value="${t}" ${t === (opts.type || typeOptions[0]) ? 'selected' : ''}>${t}</option>`).join('')}</select>
        ${opts.periodLabel ? `<input class="doc-fs-period" placeholder="${escAttr(opts.periodLabel)}" value="${escAttr(opts.period || '')}" title="${escAttr(opts.periodLabel)}">` : ''}
        <div class="doc-modes"><button type="button" data-mode="visual" class="active">Visual</button><button type="button" data-mode="code">HTML / CSS</button></div>
        <button type="button" class="btn secondary" data-preview title="Open a movable preview">👁</button>
        <button type="button" class="btn secondary" data-managevars title="Add / rename / remove variables">⚙</button>
        <button type="button" class="btn secondary" data-help title="Quick guide — variables, repeating rows, formulas">?</button>
      </div>
      <div class="doc-fs-bar-actions">
        <button type="button" class="btn" data-save>Save</button>
        <button type="button" class="btn secondary" data-close title="Close (Esc)">✕ Close</button>
      </div>
    </div>
    <div class="doc-tabs" role="tablist">${tabsHTML()}</div>
    <div class="doc-panel" data-panel="home" role="toolbar" aria-label="Home">${homePanelHTML()}</div>
    <div class="doc-panel" data-panel="insert" role="toolbar" aria-label="Insert" style="display:none">${insertPanelHTML()}</div>
    <div class="doc-panel" data-panel="layout" role="toolbar" aria-label="Layout" style="display:none">${layoutPanelHTML()}</div>
    <div class="doc-panel table-panel" data-panel="table" role="toolbar" aria-label="Table tools" style="display:none">${tablePanelHTML()}</div>
    <div class="doc-canvas"><div class="doc-zoom"><div class="doc-page doc-surface" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="Document body"></div></div></div>
    <div class="doc-code doc-code-cm" style="display:none"></div>`;
  document.body.appendChild(fs);

  const tabsEl = fs.querySelector('.doc-tabs');
  const panels = {
    home: fs.querySelector('[data-panel="home"]'),
    insert: fs.querySelector('[data-panel="insert"]'),
    layout: fs.querySelector('[data-panel="layout"]'),
    table: fs.querySelector('[data-panel="table"]'),
  };
  const panelsRoot = fs; // wireToolbar's data-ex/data-ins/etc lookups span every panel at once
  const tableTabBtn = tabsEl.querySelector('[data-tab="table"]');
  let activeTab = 'home';
  function switchTab(name) {
    if (!panels[name]) return;
    activeTab = name;
    tabsEl.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    Object.keys(panels).forEach((k) => { panels[k].style.display = k === name ? '' : 'none'; });
  }
  tabsEl.querySelectorAll('.doc-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  const tabApi = {
    setTableTabVisible(visible) {
      tableTabBtn.style.display = visible ? '' : 'none';
      if (!visible && activeTab === 'table') switchTab('home');
    },
  };

  const surface = fs.querySelector('.doc-surface');
  const canvas = fs.querySelector('.doc-canvas');
  const codeContainer = fs.querySelector('.doc-code-cm');
  const nameInp = fs.querySelector('.doc-fs-name');
  const typeSel = fs.querySelector('.doc-fs-type');
  const periodInp = fs.querySelector('.doc-fs-period');
  let mode = 'visual';

  // Canvas zoom — the page is CSS-scaled; `.doc-zoom` is a real-px sizer so scrollbars stay right.
  // Declared here (a getter, not the value) so wireToolbar's drag/snap code can read it live.
  let currentZoom = 1;
  const getZoom = () => currentZoom;

  // Snapshot-based undo/redo — built further down (needs the page-setup controls + applyZoom);
  // declared here so onChange / wireToolbar can reference it before it exists.
  let history = null;

  // ---- HTML/CSS code mode: a real CodeMirror editor (syntax highlighting + our own
  // {{variable}}/{{=formula}} autocomplete on top of CM's built-in HTML/CSS completions) —
  // mounted lazily on first switch to code mode, since mounting into a display:none
  // container makes CM mismeasure line layout. ----
  let cmEditor = null;
  function ensureCodeEditor() {
    if (cmEditor) return cmEditor;
    if (typeof window.CMBundle === 'undefined') { UI.toast('Code editor failed to load', 'error'); return null; }
    const theme = document.documentElement.getAttribute('data-theme');
    const dark = theme === 'dark' || (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    cmEditor = window.CMBundle.mount(codeContainer, {
      doc: '',
      onChange: () => onChange(),
      getVariables: opts.getVariables,
      dark,
    });
    return cmEditor;
  }
  const getCode = () => (cmEditor ? cmEditor.getValue() : '');
  const setCode = (text) => { const ed = ensureCodeEditor(); if (ed) ed.setValue(text || ''); };

  // ---- movable / resizable preview (hidden until toggled) ----
  let previewEl = null;
  const currentBody = () => (mode === 'code' ? getCode() : serializeEditor(surface));
  // When the Print Grid controls (copiesInp/perPageInp — declared further down; safe to
  // reference here since this function only ever RUNS after open() has finished setting them
  // up, via togglePreview()/onChange()) are set above 1x1, show the ACTUAL tiled grid instead
  // of a single instance — always fully repeated (tileFill forced to 'repeat' here regardless
  // of the saved setting), since the point of a design-time preview is "what does my grid look
  // like", not simulating a real batch's leftover-cell edge case (that's print-time only).
  //
  // Renders itself directly (renderTemplate + UI.printableHtml on opts.sampleContext) rather
  // than delegating to opts.renderPreview, so it can wrap the result at the SAME pixel width
  // .doc-page uses (pageDims, from the live page-setup controls — currentPageMm/marginInp,
  // declared further down but safe: this only ever runs post-init). Print CSS's <body> has no
  // fixed width, so without this a %-positioned floating object (an image/textbox/shape "made
  // movable") sizes/positions itself against whatever width the resizable preview panel
  // currently happens to be — NOT the real page — and visibly disagrees with the canvas. The
  // preview panel scrolls (its iframe's default behavior) if it's smaller than the true page;
  // opts.renderPreview is kept only as a fallback for a caller that supplies it without
  // sampleContext.
  function refreshPreview() {
    if (!previewEl) return;
    const frame = previewEl.querySelector('iframe');
    try {
      const body = currentBody();
      let inner;
      let isTiled = false;
      if (opts.sampleContext && typeof renderTemplate !== 'undefined') {
        const rows = Math.max(1, Math.min(6, parseInt(copiesInp.value, 10) || 1));
        const cols = Math.max(1, Math.min(6, parseInt(perPageInp.value, 10) || 1));
        const continuous = continuousChk.checked;
        const repeatCount = Math.max(1, Math.min(100, parseInt(repeatInp.value, 10) || 1));
        const renderOneRecord = () => renderTemplate(body, opts.sampleContext);
        if ((rows > 1 || cols > 1 || (continuous && repeatCount > 1)) && typeof buildTiledPagesHtml === 'function') {
          isTiled = true;
          const { heightMm } = currentPageMm();
          const contentHeightMm = Math.max(50, heightMm - (Number(marginInp.value) || 0) * 2 - 8);
          // Continuous still previews with a single sample record — repeated repeatCount times
          // by buildTiledPagesHtml itself — so you can see how many total copies fit on one
          // page of this grid before it spills onto the next (tileFill still forced 'repeat'
          // above so a 1-record preview visually fills its whole grid either way).
          inner = buildTiledPagesHtml([1], renderOneRecord, {
            copiesPerRecord: rows, recordsPerPage: cols, tileFill: 'repeat', pageContentHeightMm: contentHeightMm,
            continuous, repeatCount,
          });
        } else {
          inner = renderOneRecord();
        }
      }
      let html;
      if (inner !== undefined && typeof UI !== 'undefined') {
        const { widthMm, heightMm } = currentPageMm();
        const [pageWpx] = pageDims(widthMm, heightMm);
        html = UI.printableHtml(`<div style="width:${pageWpx}px">${inner}</div>`, 'Preview');
      } else {
        html = opts.renderPreview ? opts.renderPreview(body) : '<p>No preview</p>';
      }
      // Same shrink-to-fit the real print path applies (print-tiling.js's fitTiledCells) so the
      // design-time preview shows what will actually print, not an optimistic grid that then
      // clips a too-tall cell only once you print for real.
      frame.onload = isTiled ? () => { if (typeof fitTiledCells === 'function') fitTiledCells(frame.contentDocument); } : null;
      frame.srcdoc = html;
    } catch { frame.srcdoc = '<p style="color:#b00;font-family:sans-serif;padding:16px">Preview error</p>'; }
  }
  function togglePreview() {
    if (previewEl) { previewEl.remove(); previewEl = null; return; }
    previewEl = document.createElement('div');
    previewEl.className = 'doc-preview-float';
    previewEl.innerHTML = `<div class="doc-preview-head"><span>👁 Preview</span><div class="grow"></div>
      <button type="button" data-pv="refresh" title="Refresh">⟳</button>
      <button type="button" data-pv="close" title="Close">✕</button></div><iframe></iframe>`;
    document.body.appendChild(previewEl);
    previewEl.querySelector('[data-pv="close"]').onclick = () => togglePreview();
    previewEl.querySelector('[data-pv="refresh"]').onclick = refreshPreview;
    // drag by header
    const head = previewEl.querySelector('.doc-preview-head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = previewEl.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      previewEl.style.right = 'auto'; previewEl.style.left = r.left + 'px'; previewEl.style.top = r.top + 'px';
      const move = (ev) => { previewEl.style.left = Math.max(0, ev.clientX - ox) + 'px'; previewEl.style.top = Math.max(0, ev.clientY - oy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      e.preventDefault();
    });
    refreshPreview();
  }

  let dirty = false;
  const onChange = () => { dirty = true; refreshPreview(); if (history) history.scheduleRecord(); };
  const wired = wireToolbar(panelsRoot, surface, opts.getVariables, onChange, opts.sampleContext, tabApi, getZoom,
    () => { if (history) history.undo(); }, () => { if (history) history.redo(); });

  // Press anywhere on the grey "desk" (outside the page) to drop a float selection — the escape
  // hatch when a promoted object covers the whole page and there's no blank spot on it to click.
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.doc-page')) wired.blurFloats();
  });
  // leaving the editing surface commits any pending typing burst to the undo history
  surface.addEventListener('blur', () => { if (history) history.flush(); });

  // page setup: size (preset or custom mm) + orientation (presets only) + margin (mm)
  const sizeSel = fs.querySelector('.doc-pagesize');
  const orientSel = fs.querySelector('.doc-orient');
  const orientWrap = fs.querySelector('.doc-orient-wrap');
  const customWraps = fs.querySelectorAll('.doc-custom-wrap');
  const customWInp = fs.querySelector('.doc-custom-w');
  const customHInp = fs.querySelector('.doc-custom-h');
  const marginInp = fs.querySelector('.doc-margin');
  const copiesInp = fs.querySelector('.doc-copies');
  const perPageInp = fs.querySelector('.doc-records-per-page');
  const tileFillSel = fs.querySelector('.doc-tile-fill');
  const continuousChk = fs.querySelector('.doc-continuous');
  const repeatInp = fs.querySelector('.doc-repeat');
  const repeatWrap = fs.querySelector('.doc-repeat-wrap');
  const pg = parsePageStyle(opts.body || '');

  sizeSel.value = pg.preset;
  orientSel.value = pg.heightMm >= pg.widthMm ? 'portrait' : 'landscape';
  customWInp.value = pg.widthMm;
  customHInp.value = pg.heightMm;
  marginInp.value = pg.marginMm;
  copiesInp.value = opts.copiesPerRecord || 1;
  perPageInp.value = opts.recordsPerPage || 1;
  tileFillSel.value = opts.tileFill === 'repeat' ? 'repeat' : 'blank';
  continuousChk.checked = !!opts.continuous;
  repeatInp.value = opts.repeatCount || 1;

  // Grid rows/columns mean something different depending on Continuous — swap their tooltip
  // and show/hide Repeat (only meaningful in continuous mode) so the panel doesn't imply both
  // "Grid rows is the repeat count" and "Repeat" are simultaneously in effect.
  function syncContinuousUI() {
    const on = continuousChk.checked;
    repeatWrap.style.display = on ? '' : 'none';
    copiesInp.title = on
      ? 'Grid rows: the fixed page shape\'s row count (independent of Repeat, below)'
      : 'How many times to repeat down the page (e.g. 2 = one to keep, one to sign, stacked) — this IS the repeat count while Continuous is off';
    perPageInp.title = on
      ? 'Grid columns: the fixed page shape\'s column count (independent of Repeat, below)'
      : 'How many times to repeat across the page';
  }
  syncContinuousUI();

  function currentPageMm() {
    if (sizeSel.value === 'custom') {
      return { widthMm: Number(customWInp.value) || pg.widthMm, heightMm: Number(customHInp.value) || pg.heightMm };
    }
    const [pw, ph] = PAGE_PRESETS_MM[sizeSel.value] || PAGE_PRESETS_MM.a4;
    return orientSel.value === 'landscape' ? { widthMm: ph, heightMm: pw } : { widthMm: pw, heightMm: ph };
  }
  function syncSizeUI() {
    const isCustom = sizeSel.value === 'custom';
    orientWrap.style.display = isCustom ? 'none' : '';
    customWraps.forEach((w) => { w.style.display = isCustom ? '' : 'none'; });
  }
  const applyCanvas = () => {
    const { widthMm, heightMm } = currentPageMm();
    const [w, h] = pageDims(widthMm, heightMm);
    surface.style.width = w + 'px'; surface.style.minHeight = h + 'px';
    surface.style.padding = Math.round((Number(marginInp.value) || 0) * PX_PER_MM) + 'px';
  };
  [sizeSel, orientSel, customWInp, customHInp, marginInp].forEach((el) =>
    el.addEventListener('change', () => { syncSizeUI(); applyCanvas(); applyZoom(); dirty = true; refreshPreview(); if (history) history.scheduleRecord(); }));
  // Print Grid controls don't touch the editing canvas — just the tiled preview (see
  // refreshPreview above) and what gets saved.
  [copiesInp, perPageInp, tileFillSel, repeatInp].forEach((el) =>
    el.addEventListener('change', () => { dirty = true; refreshPreview(); if (history) history.scheduleRecord(); }));
  continuousChk.addEventListener('change', () => { syncContinuousUI(); dirty = true; refreshPreview(); if (history) history.scheduleRecord(); });
  fs.querySelector('[data-swap-wh]').addEventListener('click', () => {
    const w = customWInp.value; customWInp.value = customHInp.value; customHInp.value = w;
    applyCanvas(); applyZoom(); dirty = true; refreshPreview(); if (history) history.scheduleRecord();
  });
  syncSizeUI();
  applyCanvas();

  surface.innerHTML = bodyToEditorHtml(pg.rest); // initial load is not a "dirty" edit
  wired.normalizeFloats();

  // ---- canvas zoom: Zoom group in the Layout tab, Ctrl+wheel (zoom-to-cursor), Ctrl +/-/0 ----
  const zoomWrap = fs.querySelector('.doc-zoom');
  const zoomSel = fs.querySelector('.doc-zoomsel');
  const ZOOM_LADDER = [0.25, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  let zoomMode = 'manual'; // 'manual' | 'fit'

  function naturalPageSize() {
    const w = parseFloat(surface.style.width) || surface.offsetWidth || 816;
    const minH = parseFloat(surface.style.minHeight) || 0;
    const h = Math.max(surface.offsetHeight || 0, minH) || 1056; // offsetHeight is pre-transform
    return { w, h };
  }
  function computeFit() {
    const availW = (canvas.clientWidth || 0) - 52; // 26px canvas padding each side
    const { w } = naturalPageSize();
    if (w <= 0 || availW <= 0) return 1;
    return Math.max(0.2, Math.min(1, availW / w)); // never auto-zoom past 100%
  }
  function applyZoom() {
    const z = zoomMode === 'fit' ? computeFit() : currentZoom;
    currentZoom = z;
    surface.style.transform = Math.abs(z - 1) < 0.0005 ? '' : 'scale(' + z + ')';
    const { w, h } = naturalPageSize();
    zoomWrap.style.width = Math.round(w * z) + 'px';
    zoomWrap.style.height = Math.round(h * z) + 'px';
    zoomWrap.style.setProperty('--zoom', String(z));
  }
  function syncZoomSel() {
    if (!zoomSel) return;
    if (zoomMode === 'fit') { zoomSel.value = 'fit'; return; }
    const near = ZOOM_LADDER.reduce((a, b) => (Math.abs(b - currentZoom) < Math.abs(a - currentZoom) ? b : a), 1);
    zoomSel.value = String(near);
  }
  function setZoom(z) {
    zoomMode = 'manual';
    currentZoom = Math.max(0.2, Math.min(4, z));
    applyZoom(); syncZoomSel();
  }
  function ladderStep(dir) {
    let i = 0; let bd = Infinity;
    ZOOM_LADDER.forEach((v, k) => { const d = Math.abs(v - currentZoom); if (d < bd) { bd = d; i = k; } });
    return ZOOM_LADDER[Math.max(0, Math.min(ZOOM_LADDER.length - 1, i + dir))];
  }
  if (zoomSel) zoomSel.addEventListener('change', () => {
    if (zoomSel.value === 'fit') { zoomMode = 'fit'; applyZoom(); }
    else setZoom(Number(zoomSel.value));
  });
  fs.querySelectorAll('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => setZoom(ladderStep(b.dataset.zoom === 'in' ? 1 : -1))));
  canvas.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const prev = currentZoom;
    const next = ladderStep(e.deltaY < 0 ? 1 : -1);
    if (next === prev && zoomMode === 'manual') return;
    const r = zoomWrap.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top; // cursor offset within the sizer
    setZoom(next);
    const ratio = currentZoom / prev; // keep the doc point under the cursor fixed
    canvas.scrollLeft += ox * (ratio - 1);
    canvas.scrollTop += oy * (ratio - 1);
  }, { passive: false });

  // keep the sizer in step with content growth (more pages) and window resize (for 'fit')
  let roRaf = 0;
  const zoomRO = (typeof ResizeObserver !== 'undefined')
    ? new ResizeObserver(() => { if (roRaf) return; roRaf = requestAnimationFrame(() => { roRaf = 0; applyZoom(); }); })
    : null;
  if (zoomRO) { zoomRO.observe(surface); zoomRO.observe(canvas); }

  if (computeFit() < 1) zoomMode = 'fit'; // open fitted if an A4 page would overflow the viewport
  applyZoom(); syncZoomSel();

  // ---- snapshot undo / redo (visual mode) -----------------------------------------------------
  // A snapshot = the serialized body + the page-setup control values — everything execCommand's
  // native stack misses (floats, tables, checkboxes, page size/margin). Text-editing bursts are
  // coalesced (SNAP_MS); undo()/redo() flush the pending one first so a quick Ctrl+Z still works.
  history = (() => {
    const SNAP_MS = 350, CAP = 60;
    const stack = [];
    let index = -1, timer = 0, restoring = false;
    const snapshot = () => ({
      body: serializeEditor(surface),
      page: { size: sizeSel.value, orient: orientSel.value, w: customWInp.value, h: customHInp.value, margin: marginInp.value },
    });
    const same = (a, b) => !!a && !!b && a.body === b.body
      && a.page.size === b.page.size && a.page.orient === b.page.orient
      && a.page.w === b.page.w && a.page.h === b.page.h && a.page.margin === b.page.margin;
    function updateButtons() {
      const u = fs.querySelector('[data-ex="undo"]');
      const r = fs.querySelector('[data-ex="redo"]');
      if (u) u.disabled = index <= 0;
      if (r) r.disabled = index >= stack.length - 1;
    }
    function record() {
      if (restoring) return;
      const s = snapshot();
      if (same(s, stack[index])) return;
      stack.splice(index + 1);          // drop any redo tail
      stack.push(s);
      index = stack.length - 1;
      if (stack.length > CAP) { stack.shift(); index--; }
      updateButtons();
    }
    function flush() { if (timer) { clearTimeout(timer); timer = 0; record(); } }
    function scheduleRecord() {
      if (restoring) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; record(); }, SNAP_MS);
    }
    function restore(s) {
      restoring = true;
      try {
        surface.innerHTML = bodyToEditorHtml(s.body);
        wired.normalizeFloats();
        sizeSel.value = s.page.size; orientSel.value = s.page.orient;
        customWInp.value = s.page.w; customHInp.value = s.page.h; marginInp.value = s.page.margin;
        syncSizeUI(); applyCanvas(); applyZoom();
        dirty = true;
        refreshPreview();
        try { surface.focus(); } catch (e) { /* ignore */ }
      } finally { restoring = false; }
      updateButtons();
    }
    return {
      init() { stack.length = 0; stack.push(snapshot()); index = 0; updateButtons(); },
      scheduleRecord,
      flush,
      record,
      cancel() { if (timer) { clearTimeout(timer); timer = 0; } },
      undo() { if (mode !== 'visual') return; flush(); if (index <= 0) return; index--; restore(stack[index]); },
      redo() { if (mode !== 'visual') return; flush(); if (index >= stack.length - 1) return; index++; restore(stack[index]); },
    };
  })();
  history.init();

  // find & replace bar
  let findBar = null;
  function toggleFind() {
    if (findBar) { findBar.remove(); findBar = null; return; }
    findBar = document.createElement('div');
    findBar.className = 'doc-find';
    findBar.innerHTML = `<input class="doc-find-q" placeholder="Find"><input class="doc-find-r" placeholder="Replace with"><button data-f="next">Find next</button><button data-f="all">Replace all</button><button data-f="x" title="Close">✕</button>`;
    fs.insertBefore(findBar, canvas);
    const q = () => findBar.querySelector('.doc-find-q').value;
    findBar.querySelector('[data-f="next"]').onclick = () => { try { if (!(window.find && window.find(q()))) UI.toast('No more matches'); } catch (e) { UI.toast('Find not supported here', 'error'); } };
    findBar.querySelector('[data-f="all"]').onclick = () => { const n = replaceAllInSurface(surface, q(), findBar.querySelector('.doc-find-r').value); UI.toast(n ? `Replaced ${n}` : 'No matches'); if (n) onChange(); };
    findBar.querySelector('[data-f="x"]').onclick = toggleFind;
    findBar.querySelector('.doc-find-q').focus();
  }
  fs.querySelector('[data-find]').addEventListener('click', toggleFind);
  fs.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', togglePreview));
  fs.querySelector('[data-help]').addEventListener('click', docEditorHelpDialog);
  const mvBtn = fs.querySelector('[data-managevars]');
  if (opts.onManageVars) mvBtn.addEventListener('click', () => opts.onManageVars({ refresh: () => { refreshPreview(); } }));
  else mvBtn.style.display = 'none';

  function setMode(next) {
    if (next === mode) return;
    if (history) history.flush(); // commit any pending visual edit before leaving/re-entering
    if (next === 'code') {
      const text = serializeEditor(surface);
      codeContainer.style.display = ''; canvas.style.display = 'none'; tabsEl.style.display = 'none';
      Object.values(panels).forEach((p) => { p.style.display = 'none'; });
      setCode(text);
      if (cmEditor) cmEditor.focus();
    } else {
      surface.innerHTML = bodyToEditorHtml(getCode());
      wired.normalizeFloats();
      codeContainer.style.display = 'none'; canvas.style.display = ''; tabsEl.style.display = '';
      switchTab(activeTab);
      applyZoom(); // content height may have changed → resize the zoom sizer
      if (history) history.record(); // the code-mode result becomes an undo step
    }
    mode = next;
    fs.querySelectorAll('.doc-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    refreshPreview();
  }
  fs.querySelectorAll('.doc-modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  async function close(force) {
    if (dirty && !force) { const ok = await UI.confirmDialog('Discard unsaved changes to this template?', 'Discard'); if (!ok) return; }
    if (wired && wired.teardown) wired.teardown();
    if (history) history.cancel();
    if (cmEditor) cmEditor.destroy();
    if (previewEl) previewEl.remove();
    if (zoomRO) zoomRO.disconnect();
    if (roRaf) cancelAnimationFrame(roRaf);
    fs.remove();
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e) => {
    // wireToolbar's own keydown handler already swallows Escape (via stopImmediatePropagation)
    // when a float is selected; this guard is a backstop so Escape can't close the editor while
    // an object selection is up.
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) { if (!wired.blurFloats()) close(); }
    const k = e.key.toLowerCase();
    // Undo / redo — visual mode only (CodeMirror owns its own history in code mode). preventDefault
    // so the browser's native contenteditable undo doesn't also fire.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'z' && !e.shiftKey) {
      if (mode === 'visual' && !e.defaultPrevented) { e.preventDefault(); history.undo(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'y' || (k === 'z' && e.shiftKey))) {
      if (mode === 'visual' && !e.defaultPrevented) { e.preventDefault(); history.redo(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fs.querySelector('[data-save]').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFind(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(ladderStep(1)); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(ladderStep(-1)); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); }
  };
  document.addEventListener('keydown', onKey);
  fs.querySelector('[data-close]').addEventListener('click', () => close());

  fs.querySelector('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (history) history.flush();
    let body = mode === 'code' ? getCode() : serializeEditor(surface);
    const { widthMm, heightMm } = currentPageMm();
    body = pageStyleTag(widthMm, heightMm, Number(marginInp.value) || 0) + body.replace(/<style data-docpage>[\s\S]*?<\/style>/i, '');
    btn.disabled = true;
    try {
      const copiesPerRecord = Math.max(1, Math.min(6, parseInt(copiesInp.value, 10) || 1));
      const recordsPerPage = Math.max(1, Math.min(6, parseInt(perPageInp.value, 10) || 1));
      const tileFill = tileFillSel.value === 'repeat' ? 'repeat' : 'blank';
      const continuous = continuousChk.checked;
      const repeatCount = Math.max(1, Math.min(100, parseInt(repeatInp.value, 10) || 1));
      const res = opts.onSave ? await opts.onSave({ name: nameInp.value, type: typeSel.value, period: periodInp ? periodInp.value : undefined, body, copiesPerRecord, recordsPerPage, tileFill, continuous, repeatCount }) : true;
      if (res === true || res === undefined) { dirty = false; close(true); }
      else if (typeof res === 'string') UI.toast(res, 'error');
    } catch (err) { UI.toast(err.message, 'error'); } finally { btn.disabled = false; }
  });

  surface.focus();
  return { close, _history: history }; // _history exposed for tests (undo/redo without waiting on the debounce)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle, pageStyleTag, pageDims, replaceAllInSurface };
} else {
  window.DocEditor = { open, bodyToEditorHtml, serializeEditor, sanitizeHtml };
}
