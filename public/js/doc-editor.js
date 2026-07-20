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

function bodyToEditorHtml(body) {
  let html = String(body == null ? '' : body);
  html = html.replace(/\{\{#items\}\}\s*<tr/g, '<tr data-repeat="items"');
  html = html.replace(/<\/tr>\s*\{\{\/items\}\}/g, '</tr>');
  html = html.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, tok) => tokenChip(tok));
  return html;
}

function serializeEditor(root) {
  const clone = root.cloneNode(true);
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
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  return clone.innerHTML.trim();
}

/* ---- paste sanitizer (allowlist; keeps our chips/tables, strips Word/web cruft) ---- */
const SANITIZE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'A', 'IMG', 'HR', 'FONT', 'BLOCKQUOTE']);
const SANITIZE_ATTR = { A: ['href'], IMG: ['src', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const SANITIZE_STYLE = ['color', 'background-color', 'background', 'text-align', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration', 'width', 'page-break-after', 'break-after'];
const SANITIZE_DATA = ['data-token', 'data-repeat', 'data-checked'];

function filterStyle(s) {
  return String(s || '').split(';').map((x) => x.trim()).filter(Boolean)
    .filter((d) => SANITIZE_STYLE.includes((d.split(':')[0] || '').trim().toLowerCase())).join('; ');
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
    if (n === 'class') { const keep = (a.value.match(/doc-(chip|chip-ctrl|chip-fx|checkbox|pagebreak|table|striped|shaded|plain|is-repeat)/g) || []).join(' '); if (keep) el.setAttribute('class', keep); return; }
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

/* ---- page setup (size/orientation travels in the saved body as an @page rule) ---- */
function parsePageStyle(body) {
  let size = 'a4', orient = 'portrait', rest = String(body == null ? '' : body);
  const m = rest.match(/<style data-docpage>([\s\S]*?)<\/style>/i);
  if (m) {
    rest = rest.replace(m[0], '');
    const mm = m[1].match(/size:\s*([a-z0-9]+)?\s*(portrait|landscape)?/i);
    if (mm) { if (mm[1] && /letter/i.test(mm[1])) size = 'letter'; if (mm[2]) orient = mm[2].toLowerCase(); }
  }
  return { size, orient, rest };
}
function pageStyleTag(size, orient) { return `<style data-docpage>@page{size:${size} ${orient};margin:14mm}</style>`; }
function pageDims(size, orient) {
  const dims = { a4: [794, 1123], letter: [816, 1056] };
  const [w, h] = dims[size] || dims.a4;
  return orient === 'landscape' ? [h, w] : [w, h];
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
    .doc-fs-bar{display:flex;align-items:center;gap:10px;padding:7px 14px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0;flex-wrap:wrap}
    .doc-fs-bar .grow{flex:1}
    .doc-fs-title{font-weight:700;font-size:14px;color:var(--text,#16243d)}
    .doc-fs-name{font-size:13.5px;font-weight:600;padding:6px 9px;min-width:200px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-period{font-size:13px;padding:6px 9px;min-width:130px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-type{padding:6px 7px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-modes{display:inline-flex;border:1px solid var(--border-strong,#c6d4e6);border-radius:7px;overflow:hidden}
    .doc-modes button{border:none;background:var(--surface,#fff);padding:6px 12px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit}
    .doc-modes button.active{background:var(--accent,#2b7fff);color:#fff}
    .doc-ribbon{display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:4px 10px;background:var(--surface-2,#eef4fb);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-ribbon.table-bar{background:var(--accent-weak,#e7f1ff)}
    .doc-ribbon button{min-width:26px;height:26px;border:1px solid transparent;background:none;border-radius:5px;cursor:pointer;font-size:12.5px;color:var(--text,#16243d);padding:0 6px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center}
    .doc-ribbon button:hover{background:var(--surface-3,#e6eef8)}
    .doc-ribbon button.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-ribbon button:focus-visible,.doc-modes button:focus-visible{outline:2px solid var(--accent,#2b7fff);outline-offset:1px}
    .doc-page .doc-pagebreak{border:none;border-top:2px dashed #c33;margin:16px 0;height:0}
    .doc-ribbon select{height:26px;border:1px solid var(--border-strong,#c6d4e6);border-radius:5px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:12px;padding:0 3px}
    .doc-ribbon .tb-sep{width:1px;align-self:stretch;background:var(--border-strong,#c6d4e6);margin:2px 4px}
    .doc-ribbon .tb-color{display:inline-flex;align-items:center;gap:2px;font-size:12.5px;cursor:pointer;padding:0 3px;color:var(--text,#16243d);height:26px;border-radius:5px}
    .doc-ribbon .tb-color:hover{background:var(--surface-3,#e6eef8)}
    .doc-ribbon .tb-color input{width:18px;height:18px;border:none;background:none;padding:0;cursor:pointer}
    .doc-ribbon .btn-variable{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff);font-weight:700}
    .doc-ribbon .btn-fx{background:#eafaf0;color:#168f54;font-weight:700}
    .doc-ribbon .tb-grouplbl{font-size:10px;color:var(--text-faint,#8a97ad);margin:0 4px 0 2px;text-transform:uppercase;letter-spacing:.04em}
    .doc-canvas{flex:1;overflow:auto;background:#8c97a5;padding:26px;display:flex;justify-content:center;align-items:flex-start}
    .doc-code{flex:1;width:100%;border:none;outline:none;padding:18px 20px;font-family:Consolas,ui-monospace,monospace;font-size:13px;line-height:1.6;resize:none;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-page{width:816px;max-width:100%;min-height:1056px;background:#fff;color:#111;padding:56px 64px;box-shadow:0 6px 30px rgba(0,0,0,.35);font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:13px;line-height:1.5}
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
    @media (max-width:900px){.doc-page{padding:28px 22px}.doc-canvas{padding:10px}}
  `;
  const el = document.createElement('style'); el.id = 'doc-editor-styles'; el.textContent = css;
  document.head.appendChild(el);
}

const FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Calibri', 'Courier New', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

function ribbonHTML() {
  return `
    <button type="button" data-ex="undo" title="Undo">↶</button>
    <button type="button" data-ex="redo" title="Redo">↷</button>
    <span class="tb-sep"></span>
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
    <span class="tb-sep"></span>
    <button type="button" data-ex="justifyLeft" title="Align left">⬅</button>
    <button type="button" data-ex="justifyCenter" title="Align center">⬌</button>
    <button type="button" data-ex="justifyRight" title="Align right">➡</button>
    <button type="button" data-ex="justifyFull" title="Justify">☰</button>
    <button type="button" data-ex="insertUnorderedList" title="Bullet list">•≣</button>
    <button type="button" data-ex="insertOrderedList" title="Numbered list">1≣</button>
    <button type="button" data-ex="outdent" title="Decrease indent">⇤</button>
    <button type="button" data-ex="indent" title="Increase indent">⇥</button>
    <span class="tb-sep"></span>
    <button type="button" data-ins="link" title="Insert link">🔗</button>
    <button type="button" data-ins="hr" title="Horizontal line">―</button>
    <button type="button" data-ins="pagebreak" title="Page break">⤓</button>
    <button type="button" data-ins="table" title="Insert table">▦</button>
    <button type="button" data-ins="image" title="Insert image">🖼</button>
    <button type="button" data-ins="checkbox" title="Insert checkbox">☐</button>
    <button type="button" data-ins="variable" class="btn-variable" title="Insert variable">{ }</button>
    <button type="button" data-ins="formula" class="btn-fx" title="Insert formula">ƒx</button>
    <span class="tb-sep"></span>
    <button type="button" data-ex="removeFormat" title="Clear formatting">⌫</button>`;
}

function tableBarHTML() {
  return `
    <span class="tb-grouplbl">Table</span>
    <button type="button" data-tbl="addRow" title="Insert row below">+Row</button>
    <button type="button" data-tbl="delRow" title="Delete row">−Row</button>
    <button type="button" data-tbl="addCol" title="Insert column right">+Col</button>
    <button type="button" data-tbl="delCol" title="Delete column">−Col</button>
    <span class="tb-sep"></span>
    <button type="button" data-tbl="mergeRight" title="Merge with cell on the right">Merge →</button>
    <button type="button" data-tbl="mergeDown" title="Merge with cell below">Merge ↓</button>
    <button type="button" data-tbl="split" title="Split merged cell">Split</button>
    <span class="tb-sep"></span>
    <label class="tb-color" title="Cell shading">▮<input type="color" data-cellbg value="#ffffff"></label>
    <button type="button" data-tbl="width" title="Set column width">↔ Width</button>
    <select data-tblstyle title="Table style"><option value="doc-table">Bordered</option><option value="doc-table striped">Striped</option><option value="doc-table shaded">Shaded header</option><option value="doc-table plain">Plain</option></select>
    <span class="tb-sep"></span>
    <button type="button" data-tbl="repeat" title="Repeat this row for each line item">↻ Item row</button>
    <button type="button" data-tbl="fxcell" class="btn-fx" title="Make this cell a formula (=)">= ƒx</button>
    <button type="button" data-tbl="delTable" title="Delete table">🗑</button>`;
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
function wireToolbar(ribbon, tableBar, surface, getVariables, onChange, sampleContext) {
  let savedRange = null;
  const saveSel = () => { const sel = window.getSelection(); if (sel && sel.rangeCount && surface.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { surface.focus(); if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } };
  const exec = (cmd, val) => { restoreSel(); document.execCommand(cmd, false, val); saveSel(); onChange(); };
  const insertHtml = (html) => { restoreSel(); document.execCommand('insertHTML', false, html); saveSel(); onChange(); };
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }

  ['mouseup', 'keyup'].forEach((ev) => surface.addEventListener(ev, () => { saveSel(); updateTableBar(); }));

  ribbon.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); exec(b.dataset.ex); }));
  ribbon.querySelectorAll('select[data-cmd]').forEach((sel) => sel.addEventListener('change', () => exec(sel.dataset.cmd, sel.value)));
  ribbon.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('input', () => exec(inp.dataset.color, inp.value)));

  // numeric font size (pt) via the size-7 hack + CSS
  ribbon.querySelector('[data-fontsize]').addEventListener('change', (e) => {
    restoreSel();
    document.execCommand('fontSize', false, '7');
    surface.querySelectorAll('font[size="7"]').forEach((f) => { f.removeAttribute('size'); f.style.fontSize = e.target.value + 'pt'; });
    saveSel(); onChange();
  });

  // inserts
  ribbon.querySelector('[data-ins="link"]').addEventListener('click', () => { saveSel(); UI.modal({ title: 'Insert link', bodyHTML: `<label>URL</label><input id="lnk" placeholder="https://…">`, confirmText: 'Insert', onConfirm: (ov) => { const u = ov.querySelector('#lnk').value.trim(); if (!u) return false; exec('createLink', u); } }); });
  ribbon.querySelector('[data-ins="hr"]').addEventListener('click', () => insertHtml('<hr>'));
  ribbon.querySelector('[data-ins="pagebreak"]').addEventListener('click', () => insertHtml('<div class="doc-pagebreak" style="page-break-after:always"></div><p><br></p>'));
  ribbon.querySelector('[data-ins="table"]').addEventListener('click', () => insertTableDialog(insertHtml, saveSel));
  ribbon.querySelector('[data-ins="image"]').addEventListener('click', () => imageDialog(insertHtml, saveSel));
  ribbon.querySelector('[data-ins="checkbox"]').addEventListener('click', () => insertHtml('<span class="doc-checkbox" data-checked="0">&#9744;</span>&nbsp;'));
  ribbon.querySelector('[data-ins="variable"]').addEventListener('click', () => variableDialog(saveSel, getVariables, (tok) => insertHtml(tokenChip(tok.replace(/^\{\{|\}\}$/g, '')) + '&nbsp;')));
  ribbon.querySelector('[data-ins="formula"]').addEventListener('click', () => formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext));

  // ---- table helpers ----
  const cellOf = (node) => { let n = node; while (n && n !== surface) { if (n.nodeName === 'TD' || n.nodeName === 'TH') return n; n = n.parentNode; } return null; };
  const currentCell = () => cellOf(savedRange ? savedRange.startContainer : (window.getSelection().anchorNode));
  function updateTableBar() {
    const inTable = !!currentCell();
    tableBar.style.display = inTable ? '' : 'none';
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
  tableBar.querySelectorAll('[data-tbl]').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault(); const fn = tbl[b.dataset.tbl]; if (fn) { fn(); if (b.dataset.tbl !== 'delTable') onChange(); }
  }));
  tableBar.querySelector('[data-cellbg]').addEventListener('input', (e) => { const c = currentCell(); if (c) { c.style.background = e.target.value; onChange(); } });
  tableBar.querySelector('[data-tblstyle]').addEventListener('change', (e) => { const c = currentCell(); if (c) { c.closest('table').className = e.target.value; onChange(); } });

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
      const b = ribbon.querySelector(`[data-ex="${cmd}"]`);
      if (b) { try { b.classList.toggle('active', document.queryCommandState(cmd)); } catch (e) { /* ignore */ } }
    });
  };
  document.addEventListener('selectionchange', reflect);

  updateTableBar();
  return { teardown() { document.removeEventListener('selectionchange', reflect); } };
}

function open(opts = {}) {
  ensureStyles();
  const typeOptions = opts.typeOptions || ['sale', 'job', 'generic'];
  const fs = document.createElement('div');
  fs.className = 'doc-fs';
  fs.innerHTML = `
    <div class="doc-fs-bar">
      <span class="doc-fs-title">${UI.esc(opts.title || 'Template')}</span>
      <input class="doc-fs-name" placeholder="Template name" value="${escAttr(opts.name || '')}">
      <select class="doc-fs-type">${typeOptions.map((t) => `<option value="${t}" ${t === (opts.type || typeOptions[0]) ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${opts.periodLabel ? `<input class="doc-fs-period" placeholder="${escAttr(opts.periodLabel)}" value="${escAttr(opts.period || '')}" title="${escAttr(opts.periodLabel)}">` : ''}
      <div class="doc-modes"><button type="button" data-mode="visual" class="active">Visual</button><button type="button" data-mode="code">HTML / CSS</button></div>
      <select class="doc-fs-type doc-pagesize" title="Page size"><option value="a4">A4</option><option value="letter">Letter</option></select>
      <select class="doc-fs-type doc-orient" title="Page orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
      <button type="button" class="btn secondary" data-managevars title="Add / rename / remove variables">⚙ Variables</button>
      <button type="button" class="btn secondary" data-find title="Find &amp; replace (Ctrl+F)">🔍 Find</button>
      <button type="button" class="btn secondary" data-preview title="Open a movable preview">👁 Preview</button>
      <div class="grow"></div>
      <button type="button" class="btn" data-save>Save</button>
      <button type="button" class="btn secondary" data-close>Close</button>
    </div>
    <div class="doc-ribbon" role="toolbar" aria-label="Formatting">${ribbonHTML()}</div>
    <div class="doc-ribbon table-bar" role="toolbar" aria-label="Table tools" style="display:none">${tableBarHTML()}</div>
    <div class="doc-canvas"><div class="doc-page doc-surface" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="Document body"></div></div>
    <textarea class="doc-code" spellcheck="false" style="display:none"></textarea>`;
  document.body.appendChild(fs);

  const ribbon = fs.querySelector('.doc-ribbon:not(.table-bar)');
  const tableBar = fs.querySelector('.doc-ribbon.table-bar');
  const surface = fs.querySelector('.doc-surface');
  const canvas = fs.querySelector('.doc-canvas');
  const code = fs.querySelector('.doc-code');
  const nameInp = fs.querySelector('.doc-fs-name');
  const typeSel = fs.querySelector('.doc-fs-type');
  const periodInp = fs.querySelector('.doc-fs-period');
  let mode = 'visual';

  // ---- movable / resizable preview (hidden until toggled) ----
  let previewEl = null;
  const currentBody = () => (mode === 'code' ? code.value : serializeEditor(surface));
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
  const wired = wireToolbar(ribbon, tableBar, surface, opts.getVariables, onChange, opts.sampleContext);

  // page setup (size/orientation)
  const sizeSel = fs.querySelector('.doc-pagesize');
  const orientSel = fs.querySelector('.doc-orient');
  const pg = parsePageStyle(opts.body || '');
  sizeSel.value = pg.size; orientSel.value = pg.orient;
  const applyCanvas = () => { const [w, h] = pageDims(sizeSel.value, orientSel.value); surface.style.width = w + 'px'; surface.style.minHeight = h + 'px'; };
  sizeSel.addEventListener('change', () => { applyCanvas(); dirty = true; refreshPreview(); });
  orientSel.addEventListener('change', () => { applyCanvas(); dirty = true; refreshPreview(); });
  applyCanvas();

  surface.innerHTML = bodyToEditorHtml(pg.rest); // initial load is not a "dirty" edit

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
  fs.querySelector('[data-preview]').addEventListener('click', togglePreview);
  const mvBtn = fs.querySelector('[data-managevars]');
  if (opts.onManageVars) mvBtn.addEventListener('click', () => opts.onManageVars({ refresh: () => { refreshPreview(); } }));
  else mvBtn.style.display = 'none';

  function setMode(next) {
    if (next === mode) return;
    if (next === 'code') { code.value = serializeEditor(surface); code.style.display = ''; canvas.style.display = 'none'; ribbon.style.display = 'none'; tableBar.style.display = 'none'; }
    else { surface.innerHTML = bodyToEditorHtml(code.value); code.style.display = 'none'; canvas.style.display = ''; ribbon.style.display = ''; }
    mode = next;
    fs.querySelectorAll('.doc-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    refreshPreview();
  }
  fs.querySelectorAll('.doc-modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  async function close(force) {
    if (dirty && !force) { const ok = await UI.confirmDialog('Discard unsaved changes to this template?', 'Discard'); if (!ok) return; }
    if (wired && wired.teardown) wired.teardown();
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
    let body = mode === 'code' ? code.value : serializeEditor(surface);
    body = pageStyleTag(sizeSel.value, orientSel.value) + body.replace(/<style data-docpage>[\s\S]*?<\/style>/i, '');
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
  module.exports = { bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle, pageDims, replaceAllInSurface };
} else {
  window.DocEditor = { open, bodyToEditorHtml, serializeEditor, sanitizeHtml };
}
