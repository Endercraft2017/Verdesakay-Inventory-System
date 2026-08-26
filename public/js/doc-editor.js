/* ============================================================================
   DocEditor — full-screen, Word-style visual editor for document templates.
   The editing surface IS the document page (true WYSIWYG). Visual ⇄ HTML/CSS
   modes. Produces/consumes HTML + {{var}} (+ inline {{= formula }}) bodies that
   the renderer (doc-template.js) understands.

   Public (browser): DocEditor.open({ title, name, type, typeOptions, body,
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
  clone.querySelectorAll('.doc-float-handle,.doc-float-toolbar,.doc-promote-bar').forEach((el) => el.remove());
  clone.querySelectorAll('.doc-float.selected').forEach((el) => el.classList.remove('selected'));
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  return clone.innerHTML.trim();
}

/* ---- paste sanitizer (allowlist; keeps our chips/tables, strips Word/web cruft) ---- */
const SANITIZE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'A', 'IMG', 'HR', 'FONT', 'BLOCKQUOTE']);
const SANITIZE_ATTR = { A: ['href'], IMG: ['src', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const SANITIZE_STYLE = ['color', 'background-color', 'background', 'text-align', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration', 'width', 'page-break-after', 'break-after',
  'position', 'left', 'top', 'right', 'bottom', 'height', 'z-index', 'border', 'border-color', 'border-radius'];
const SANITIZE_DATA = ['data-token', 'data-repeat', 'data-checked', 'data-var-src', 'data-float-kind', 'data-wrap'];

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
    .doc-fs{position:fixed;inset:0;z-index:40;background:var(--bg,#f4f8fd);display:flex;flex-direction:column}
    .doc-fs-bar{display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-fs-bar-scroll{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden}
    .doc-fs-bar-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .doc-fs-title{font-weight:700;font-size:13px;color:var(--text,#16243d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;flex-shrink:1}
    .doc-fs-name{font-size:12.5px;font-weight:600;padding:4px 7px;width:120px;flex-shrink:0;border:1px solid var(--border-strong,#c6d4e6);border-radius:5px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-period{font-size:12px;padding:4px 7px;width:80px;flex-shrink:0;border:1px solid var(--border-strong,#c6d4e6);border-radius:5px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-type{padding:4px 5px;flex-shrink:0;border:1px solid var(--border-strong,#c6d4e6);border-radius:5px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:12.5px}
    .doc-fs-type-top{width:74px}
    .doc-modes{display:inline-flex;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;overflow:hidden;flex-shrink:0}
    .doc-modes button{border:none;background:var(--surface,#fff);padding:4px 9px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;white-space:nowrap}
    .doc-modes button.active{background:var(--accent,#2b7fff);color:#fff}
    .doc-fs-bar .btn{flex-shrink:0;padding:4px 9px;font-size:12.5px;white-space:nowrap}
    .doc-tabs{display:flex;gap:2px;padding:0 10px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0;overflow-x:auto;overflow-y:hidden}
    .doc-tab{border:none;background:none;padding:7px 14px 6px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;border-bottom:2px solid transparent;margin-bottom:-1px}
    .doc-tab:hover{color:var(--text,#16243d)}
    .doc-tab.active{color:var(--accent,#2b7fff);border-bottom-color:var(--accent,#2b7fff)}
    .doc-panel{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;align-items:stretch;padding:4px 8px;background:var(--surface-2,#eef4fb);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-panel.table-panel{background:var(--accent-weak,#e7f1ff)}
    .doc-group{display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0;padding:1px 9px;border-left:1px solid var(--border-strong,#c6d4e6)}
    .doc-group:first-child{border-left:none;padding-left:2px}
    .doc-group-row{display:flex;align-items:center;gap:1px}
    .doc-group-cap{font-size:9.5px;color:var(--text-faint,#8a97ad);text-transform:uppercase;letter-spacing:.04em;margin-top:3px;white-space:nowrap}
    .doc-panel button{min-width:23px;height:23px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:4px;cursor:pointer;font-size:12px;color:var(--text,#16243d);padding:0 5px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
    .doc-panel button:hover{background:var(--surface-3,#e6eef8)}
    .doc-panel button.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-panel button:focus-visible,.doc-tab:focus-visible,.doc-modes button:focus-visible{outline:2px solid var(--accent,#2b7fff);outline-offset:1px}
    .doc-page .doc-pagebreak{border:none;border-top:2px dashed #c33;margin:16px 0;height:0}
    .doc-panel select{height:23px;flex-shrink:0;border:1px solid var(--border-strong,#c6d4e6);border-radius:4px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .doc-panel select[data-cmd="formatBlock"]{width:68px}
    .doc-panel select[data-cmd="fontName"]{width:84px}
    .doc-panel select[data-fontsize]{width:42px}
    .doc-panel select[data-tblstyle]{width:86px}
    .doc-panel .tb-sep{width:1px;flex-shrink:0;align-self:stretch;background:var(--border-strong,#c6d4e6);margin:2px 3px}
    .doc-panel .tb-color{display:inline-flex;align-items:center;gap:2px;font-size:12px;cursor:pointer;padding:0 3px;color:var(--text,#16243d);height:23px;flex-shrink:0;border-radius:4px}
    .doc-panel .tb-color:hover{background:var(--surface-3,#e6eef8)}
    .doc-panel .tb-color input{width:18px;height:18px;border:none;background:none;padding:0;cursor:pointer}
    .doc-panel .btn-variable{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff);font-weight:700}
    .doc-panel .btn-fx{background:#eafaf0;color:#168f54;font-weight:700}
    .doc-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:54px;height:44px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:5px;cursor:pointer;font-family:inherit;color:var(--text,#16243d)}
    .doc-tile:hover{background:var(--surface-3,#e6eef8)}
    .doc-tile .doc-tile-ic{font-size:16px;line-height:1}
    .doc-tile .doc-tile-lbl{font-size:9.5px;font-weight:600;line-height:1;white-space:nowrap}
    .doc-tile-select{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;padding:0 4px}
    .doc-tile-select .doc-tile-lbl{font-size:9.5px;font-weight:600;color:var(--text-muted,#5d6b84);white-space:nowrap}
    .doc-tile-select select{width:80px}
    .doc-tile-select input[type="number"]{width:56px;height:23px;border:1px solid var(--border-strong,#c6d4e6);border-radius:4px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 4px}
    .doc-canvas{flex:1;overflow:auto;background:#8c97a5;padding:26px;display:flex;justify-content:center;align-items:flex-start}
    .doc-code{flex:1;width:100%;min-height:0;overflow:hidden;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-code-cm .cm-editor{height:100%}
    .doc-code-cm .cm-scroller{padding:8px 12px}
    .doc-page{position:relative;width:816px;max-width:100%;min-height:1056px;background:#fff;color:#111;padding:56px 64px;box-shadow:0 6px 30px rgba(0,0,0,.35);font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:13px;line-height:1.5}
    .doc-page:focus{outline:none}
    .doc-page h1{font-size:22px;margin:0 0 4px}.doc-page h2{font-size:17px;margin:0 0 6px}.doc-page h3{font-size:15px}
    .doc-page table{border-collapse:collapse;margin:10px 0;width:100%}
    .doc-page td,.doc-page th{border:1px solid #bbb;padding:6px 9px;min-width:36px;vertical-align:top}
    .doc-page th{background:#f0f0f0;text-align:left}
    .doc-page .doc-table.striped tbody tr:nth-child(even){background:#f7f7f7}
    .doc-page .doc-table.shaded thead th{background:#16243d;color:#fff}
    .doc-page .doc-table.plain td,.doc-page .doc-table.plain th{border:none}
    .doc-page .doc-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:12px;margin-bottom:16px;gap:20px}
    .doc-page .doc-meta{text-align:right}
    .doc-page tr.is-repeat>td,.doc-page tr[data-repeat]>td{box-shadow:inset 0 0 0 2px var(--accent,#2b7fff)}
    .doc-page td.cell-sel,.doc-page th.cell-sel{outline:2px solid var(--accent,#2b7fff);outline-offset:-2px;background:rgba(43,127,255,.12)!important}
    .doc-find{display:flex;gap:6px;align-items:center;padding:7px 12px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-find input{padding:6px 9px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;font-size:13px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-find button{border:1px solid var(--border-strong,#c6d4e6);background:var(--surface-2,#eef4fb);border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12.5px;color:var(--text,#16243d);font-family:inherit}
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
    .doc-page .doc-table.striped tbody tr:hover:nth-child(even){background:#f7f7f7}
    .doc-ac{position:fixed;z-index:60;min-width:220px;max-width:300px;background:var(--surface,#fff);border:1px solid var(--border,#ccc);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.3);overflow:auto;max-height:240px;padding:4px}
    .doc-ac-item{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 9px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text,#16243d)}
    .doc-ac-item.active,.doc-ac-item:hover{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-ac-tok{font-family:Consolas,monospace;font-size:11px;color:var(--text-faint,#8a97ad)}
    .doc-preview-float{position:fixed;top:96px;right:28px;width:480px;height:600px;min-width:300px;min-height:240px;background:var(--surface,#fff);border:1px solid var(--border,#ccc);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.4);display:flex;flex-direction:column;z-index:45;resize:both;overflow:hidden}
    .doc-preview-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface-2,#eef4fb);border-bottom:1px solid var(--border,#ccc);cursor:move;flex-shrink:0;font-weight:600;font-size:13px;color:var(--text,#16243d);user-select:none}
    .doc-preview-head .grow{flex:1}
    .doc-preview-head button{border:none;background:none;cursor:pointer;color:var(--text-muted,#5d6b84);font-size:15px;padding:2px 7px;border-radius:5px;line-height:1}
    .doc-preview-head button:hover{background:var(--surface-3,#e6eef8)}
    .doc-preview-float iframe{flex:1;border:none;width:100%;background:#fff}
    /* ---- floating objects: shapes / text boxes / promoted images & tables ---- */
    .doc-float{box-sizing:border-box}
    .doc-float.selected{outline:2px solid var(--accent,#2b7fff)}
    .doc-float-shape{width:100%;height:100%;box-sizing:border-box}
    .doc-float-body{width:100%;height:100%;box-sizing:border-box;outline:none;overflow:auto;padding:4px}
    .doc-float[data-float-kind="image"] img{width:100%;height:100%}
    .doc-float-handle{position:absolute;width:9px;height:9px;background:var(--accent,#2b7fff);border:1px solid #fff;border-radius:2px;z-index:1000}
    .doc-float-handle[data-h="nw"]{left:-5px;top:-5px;cursor:nwse-resize}
    .doc-float-handle[data-h="n"]{left:50%;top:-5px;margin-left:-5px;cursor:ns-resize}
    .doc-float-handle[data-h="ne"]{right:-5px;top:-5px;cursor:nesw-resize}
    .doc-float-handle[data-h="e"]{right:-5px;top:50%;margin-top:-5px;cursor:ew-resize}
    .doc-float-handle[data-h="se"]{right:-5px;bottom:-5px;cursor:nwse-resize}
    .doc-float-handle[data-h="s"]{left:50%;bottom:-5px;margin-left:-5px;cursor:ns-resize}
    .doc-float-handle[data-h="sw"]{left:-5px;bottom:-5px;cursor:nesw-resize}
    .doc-float-handle[data-h="w"]{left:-5px;top:50%;margin-top:-5px;cursor:ew-resize}
    .doc-float-toolbar,.doc-promote-bar{position:absolute;left:0;top:-30px;display:flex;gap:2px;background:var(--surface,#fff);border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;padding:3px;box-shadow:0 4px 14px rgba(0,0,0,.18);z-index:1001;white-space:nowrap}
    .doc-float-toolbar button,.doc-promote-bar button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:3px 6px;border-radius:4px;color:var(--text,#16243d);font-family:inherit}
    .doc-float-toolbar button:hover,.doc-promote-bar button:hover{background:var(--surface-2,#eef4fb)}
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
    <button type="button" data-ex="undo" title="Undo">↶</button>
    <button type="button" data-ex="redo" title="Redo">↷</button>`);
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
  const previewGroup = groupHTML('Preview', `
    <button type="button" class="doc-tile" data-preview title="Open a movable preview"><span class="doc-tile-ic">👁</span><span class="doc-tile-lbl">Preview</span></button>`);
  return pageSetup + previewGroup;
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
      let html = '<table class="doc-table"><tbody>';
      for (let r = 0; r < rows; r++) { html += '<tr>'; for (let c = 0; c < cols; c++) { const t = header && r === 0 ? 'th' : 'td'; html += `<${t}>&nbsp;</${t}>`; } html += '</tr>'; }
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
function wireToolbar(panelsRoot, surface, getVariables, onChange, sampleContext, tabApi) {
  let savedRange = null;
  const saveSel = () => { const sel = window.getSelection(); if (sel && sel.rangeCount && surface.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { surface.focus(); if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } };
  const exec = (cmd, val) => { restoreSel(); document.execCommand(cmd, false, val); saveSel(); onChange(); };
  const insertHtml = (html) => { restoreSel(); document.execCommand('insertHTML', false, html); saveSel(); onChange(); };
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }

  ['mouseup', 'keyup'].forEach((ev) => surface.addEventListener(ev, () => { saveSel(); updateTableBar(); }));

  panelsRoot.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); exec(b.dataset.ex); }));
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
    if (e.key !== '=') return;
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
  let floatZFront = 1;
  let floatSeq = 0;
  let selectedFloat = null;
  let promoteBar = null;
  let promoteTarget = null;
  const nextFrontZ = () => ++floatZFront;
  const pxToPct = (px, total) => (total ? (px / total) * 100 : 0);

  function clearPromoteBar() { if (promoteBar) { promoteBar.remove(); promoteBar = null; } promoteTarget = null; }

  function deselectFloat() {
    if (!selectedFloat) return;
    selectedFloat.classList.remove('selected');
    selectedFloat.querySelectorAll(':scope > .doc-float-handle, :scope > .doc-float-toolbar').forEach((n) => n.remove());
    selectedFloat = null;
  }

  function wrapToolbarHTML(floatEl) {
    const wrap = floatEl.getAttribute('data-wrap');
    const kind = floatEl.getAttribute('data-float-kind');
    let html = `<button type="button" data-float-act="${wrap === 'behind' ? 'front' : 'behind'}" title="${wrap === 'behind' ? 'Bring in front of text' : 'Send behind text'}">${wrap === 'behind' ? '⬆' : '⬇'}</button>`;
    if (kind === 'image' || kind === 'table') html += `<button type="button" data-float-act="inline" title="In line with text">↩</button>`;
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
    HANDLE_POS.forEach((h) => {
      const hd = document.createElement('div');
      hd.className = 'doc-float-handle'; hd.setAttribute('data-h', h); hd.setAttribute('contenteditable', 'false');
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
    el.setAttribute('data-wrap', 'front');
    el.setAttribute('contenteditable', 'false');
    el.style.cssText = `position:absolute;left:${left}%;top:${top}%;width:${def.w}%;height:${def.h}%;z-index:${nextFrontZ()}`;
    el.innerHTML = def.html;
    surface.appendChild(el);
    selectFloat(el);
    onChange();
  }

  function promoteToFloat(target, mode) {
    const kind = target.nodeName === 'IMG' ? 'image' : 'table';
    const rect = target.getBoundingClientRect();
    const pageRect = surface.getBoundingClientRect();
    const leftPct = pxToPct(rect.left - pageRect.left, pageRect.width);
    const topPct = pxToPct(rect.top - pageRect.top, pageRect.height);
    const wPct = pxToPct(rect.width, pageRect.width);
    const hPct = pxToPct(rect.height, pageRect.height);
    const wrap = document.createElement('div');
    wrap.className = 'doc-float';
    wrap.setAttribute('data-float-kind', kind);
    wrap.setAttribute('data-wrap', mode);
    wrap.setAttribute('contenteditable', 'false');
    wrap.style.cssText = `position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;z-index:${mode === 'behind' ? -1 : nextFrontZ()}`;
    target.parentNode.insertBefore(wrap, target);
    wrap.appendChild(target);
    if (kind === 'table') target.setAttribute('contenteditable', 'true');
    target.style.width = '100%'; target.style.height = '100%';
    selectFloat(wrap);
    onChange();
  }

  function unpromoteFloat(floatEl) {
    const inner = floatEl.querySelector(':scope > img, :scope > table');
    if (!inner) { floatEl.remove(); deselectFloat(); onChange(); return; }
    inner.style.width = ''; inner.style.height = '';
    if (inner.nodeName === 'TABLE') inner.removeAttribute('contenteditable');
    floatEl.parentNode.insertBefore(inner, floatEl);
    floatEl.remove();
    deselectFloat();
    onChange();
  }

  function showPromoteBar(target) {
    clearPromoteBar(); deselectFloat();
    promoteTarget = target;
    const rect = target.getBoundingClientRect();
    const pageRect = surface.getBoundingClientRect();
    promoteBar = document.createElement('div');
    promoteBar.className = 'doc-promote-bar'; promoteBar.setAttribute('contenteditable', 'false');
    promoteBar.style.left = (rect.left - pageRect.left) + 'px';
    promoteBar.style.top = Math.max(0, rect.top - pageRect.top - 30) + 'px';
    promoteBar.innerHTML = '<button type="button" data-promote="front" title="Wrap: in front of text">⬆ In front</button><button type="button" data-promote="behind" title="Wrap: behind text">⬇ Behind</button>';
    surface.appendChild(promoteBar);
  }

  surface.addEventListener('click', (e) => {
    const actBtn = e.target.closest('.doc-float-toolbar button');
    if (actBtn && selectedFloat) {
      const act = actBtn.dataset.floatAct;
      if (act === 'delete') { const f = selectedFloat; selectedFloat = null; f.remove(); onChange(); return; }
      if (act === 'inline') { unpromoteFloat(selectedFloat); return; }
      if (act === 'front' || act === 'behind') {
        selectedFloat.setAttribute('data-wrap', act);
        selectedFloat.style.zIndex = act === 'behind' ? '-1' : String(nextFrontZ());
        const tb = selectedFloat.querySelector(':scope > .doc-float-toolbar'); if (tb) tb.innerHTML = wrapToolbarHTML(selectedFloat);
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
    if (promoteBtn) { const mode = promoteBtn.dataset.promote; const t = promoteTarget; clearPromoteBar(); if (t) promoteToFloat(t, mode); return; }

    const floatEl = e.target.closest('.doc-float');
    if (floatEl) { selectFloat(floatEl); return; }

    deselectFloat();
    const img = e.target.closest('img');
    if (img && surface.contains(img) && !img.closest('.doc-float')) { showPromoteBar(img); return; }
    const table = e.target.closest('table');
    if (table && surface.contains(table) && !table.closest('.doc-float')) { showPromoteBar(table); return; }
    clearPromoteBar();
  });

  let dragState = null;
  surface.addEventListener('mousedown', (e) => {
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
      };
      return;
    }
    const floatEl = e.target.closest('.doc-float');
    if (!floatEl) return;
    const kind = floatEl.getAttribute('data-float-kind');
    const insideEditable = (kind === 'textbox' && e.target.closest('.doc-float-body'))
      || (kind === 'table' && e.target.closest('table')) || e.target.closest('.doc-float-toolbar');
    if (insideEditable) return;
    e.preventDefault();
    if (selectedFloat !== floatEl) selectFloat(floatEl);
    const pageRect = surface.getBoundingClientRect();
    const startRect = floatEl.getBoundingClientRect();
    dragState = { mode: 'move', floatEl, pageRect, startLeft: startRect.left - pageRect.left, startTop: startRect.top - pageRect.top, x0: e.clientX, y0: e.clientY };
  });
  const onFloatMouseMove = (e) => {
    if (!dragState) return;
    const { floatEl, pageRect } = dragState;
    const dx = e.clientX - dragState.x0, dy = e.clientY - dragState.y0;
    if (dragState.mode === 'move') {
      const left = Math.max(0, dragState.startLeft + dx), top = Math.max(0, dragState.startTop + dy);
      floatEl.style.left = pxToPct(left, pageRect.width) + '%';
      floatEl.style.top = pxToPct(top, pageRect.height) + '%';
      return;
    }
    const { startLeft, startTop, startW, startH, h } = dragState;
    let left = startLeft, top = startTop, w = startW, ht = startH;
    if (h.includes('e')) w = Math.max(12, startW + dx);
    if (h.includes('s')) ht = Math.max(12, startH + dy);
    if (h.includes('w')) { w = Math.max(12, startW - dx); left = startLeft + (startW - w); }
    if (h.includes('n')) { ht = Math.max(12, startH - dy); top = startTop + (startH - ht); }
    floatEl.style.left = pxToPct(left, pageRect.width) + '%';
    floatEl.style.top = pxToPct(top, pageRect.height) + '%';
    floatEl.style.width = pxToPct(w, pageRect.width) + '%';
    floatEl.style.height = pxToPct(ht, pageRect.height) + '%';
  };
  const onFloatMouseUp = () => { if (dragState) { dragState = null; onChange(); } };
  document.addEventListener('mousemove', onFloatMouseMove);
  document.addEventListener('mouseup', onFloatMouseUp);

  const onFloatKeydown = (e) => {
    if (!selectedFloat) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const active = document.activeElement;
    if (active && selectedFloat.contains(active) && active !== selectedFloat) return;
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
    surface.querySelectorAll('.doc-float').forEach((el) => {
      el.setAttribute('contenteditable', 'false');
      const kind = el.getAttribute('data-float-kind');
      if (kind === 'textbox') { const body = el.querySelector(':scope > .doc-float-body'); if (body) body.setAttribute('contenteditable', 'true'); }
      if (kind === 'table') { const t = el.querySelector(':scope > table'); if (t) t.setAttribute('contenteditable', 'true'); }
    });
  }

  updateTableBar();
  return {
    teardown() {
      document.removeEventListener('selectionchange', reflect);
      document.removeEventListener('mousemove', onFloatMouseMove);
      document.removeEventListener('mouseup', onFloatMouseUp);
      document.removeEventListener('keydown', onFloatKeydown);
    },
    normalizeFloats,
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
    <div class="doc-canvas"><div class="doc-page doc-surface" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="Document body"></div></div>
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
  function refreshPreview() {
    if (!previewEl) return;
    const frame = previewEl.querySelector('iframe');
    try { frame.srcdoc = opts.renderPreview ? opts.renderPreview(currentBody()) : '<p>No preview</p>'; }
    catch { frame.srcdoc = '<p style="color:#b00;font-family:sans-serif;padding:16px">Preview error</p>'; }
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
  const onChange = () => { dirty = true; refreshPreview(); };
  const wired = wireToolbar(panelsRoot, surface, opts.getVariables, onChange, opts.sampleContext, tabApi);

  // page setup: size (preset or custom mm) + orientation (presets only) + margin (mm)
  const sizeSel = fs.querySelector('.doc-pagesize');
  const orientSel = fs.querySelector('.doc-orient');
  const orientWrap = fs.querySelector('.doc-orient-wrap');
  const customWraps = fs.querySelectorAll('.doc-custom-wrap');
  const customWInp = fs.querySelector('.doc-custom-w');
  const customHInp = fs.querySelector('.doc-custom-h');
  const marginInp = fs.querySelector('.doc-margin');
  const pg = parsePageStyle(opts.body || '');

  sizeSel.value = pg.preset;
  orientSel.value = pg.heightMm >= pg.widthMm ? 'portrait' : 'landscape';
  customWInp.value = pg.widthMm;
  customHInp.value = pg.heightMm;
  marginInp.value = pg.marginMm;

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
    el.addEventListener('change', () => { syncSizeUI(); applyCanvas(); dirty = true; refreshPreview(); }));
  fs.querySelector('[data-swap-wh]').addEventListener('click', () => {
    const w = customWInp.value; customWInp.value = customHInp.value; customHInp.value = w;
    applyCanvas(); dirty = true; refreshPreview();
  });
  syncSizeUI();
  applyCanvas();

  surface.innerHTML = bodyToEditorHtml(pg.rest); // initial load is not a "dirty" edit
  wired.normalizeFloats();

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
  const mvBtn = fs.querySelector('[data-managevars]');
  if (opts.onManageVars) mvBtn.addEventListener('click', () => opts.onManageVars({ refresh: () => { refreshPreview(); } }));
  else mvBtn.style.display = 'none';

  function setMode(next) {
    if (next === mode) return;
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
    }
    mode = next;
    fs.querySelectorAll('.doc-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    refreshPreview();
  }
  fs.querySelectorAll('.doc-modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  async function close(force) {
    if (dirty && !force) { const ok = await UI.confirmDialog('Discard unsaved changes to this template?', 'Discard'); if (!ok) return; }
    if (wired && wired.teardown) wired.teardown();
    if (cmEditor) cmEditor.destroy();
    if (previewEl) previewEl.remove();
    fs.remove();
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fs.querySelector('[data-save]').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFind(); }
  };
  document.addEventListener('keydown', onKey);
  fs.querySelector('[data-close]').addEventListener('click', () => close());

  fs.querySelector('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    let body = mode === 'code' ? getCode() : serializeEditor(surface);
    const { widthMm, heightMm } = currentPageMm();
    body = pageStyleTag(widthMm, heightMm, Number(marginInp.value) || 0) + body.replace(/<style data-docpage>[\s\S]*?<\/style>/i, '');
    btn.disabled = true;
    try {
      const res = opts.onSave ? await opts.onSave({ name: nameInp.value, type: typeSel.value, period: periodInp ? periodInp.value : undefined, body }) : true;
      if (res === true || res === undefined) { dirty = false; close(true); }
      else if (typeof res === 'string') UI.toast(res, 'error');
    } catch (err) { UI.toast(err.message, 'error'); } finally { btn.disabled = false; }
  });

  surface.focus();
  return { close };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle, pageStyleTag, pageDims, replaceAllInSurface };
} else {
  window.DocEditor = { open, bodyToEditorHtml, serializeEditor, sanitizeHtml };
}
