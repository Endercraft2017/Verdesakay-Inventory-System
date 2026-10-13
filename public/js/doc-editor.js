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
                                      continuous, repeatCount, gapXmm:Number(gapXInp.value),gapYmm:Number(gapYInp.value),  // same group's Continuous toggle +
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
  // Only collapse a complete, single-row block. Comments keep other table block
  // boundaries in place: spans/text in a tbody are otherwise foster-parented by HTML parsing.
  html = html.replace(/\{\{\s*#items\s*\}\}\s*(<tr\b[^>]*>(?:(?!<tr\b|\{\{[#/])[\s\S])*?<\/tr>)\s*\{\{\s*\/items\s*\}\}/gi,
    (_m, row) => row.replace(/<tr\b/i, '<tr data-repeat="items"'));
  const stack = [];
  html = html.replace(/(<[^>]*>)|\{\{\s*([#/][^}]+?)\s*\}\}/g, (m, tag, token) => {
    if (tag) {
      const t = tag.match(/^<\s*(\/?)\s*([a-z][\w-]*)/i);
      if (t) {
        const name = t[2].toLowerCase();
        if (t[1]) { const i = stack.lastIndexOf(name); if (i >= 0) stack.splice(i); }
        else if (!/^(br|img|hr|input|meta|link)$/.test(name) && !/\/\s*>$/.test(tag)) stack.push(name);
      }
      return tag;
    }
    return stack.includes('table') && Math.max(stack.lastIndexOf('td'), stack.lastIndexOf('th')) < stack.lastIndexOf('table')
      ? '<!--doc-block:' + encodeURIComponent(token.trim()).replaceAll('-', '%2D') + '-->' : m;
  });
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
  const comments = clone.ownerDocument.createTreeWalker(clone, 128 /* SHOW_COMMENT */);
  const markers = []; let marker;
  while ((marker = comments.nextNode())) if (marker.data.startsWith('doc-block:')) markers.push(marker);
  markers.forEach((node) => {
    try { node.replaceWith(node.ownerDocument.createTextNode('{{' + decodeURIComponent(node.data.slice(10)) + '}}')); } catch { node.remove(); }
  });
  clone.querySelectorAll('.cell-sel').forEach((c) => c.classList.remove('cell-sel'));
  clone.querySelectorAll('.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide,.doc-page-guide').forEach((el) => el.remove());
  clone.querySelectorAll('.doc-float').forEach((el) => el.classList.remove('selected', 'behind-text', 'multi', 'editing')); // editor-only state; z-index carries the real meaning
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  return clone.innerHTML.trim();
}

/** Browser selection adapter for history. Element paths ignore editor-only controls;
 * direct text offsets survive the adjacent text-node merging done by HTML round trips.
 * Anchor/focus are kept separately so backwards selections retain their direction. */
const SELECTION_CHROME = '.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide,.doc-page-guide';
function selectionChildren(node) {
  return [...node.childNodes].filter(n => n.nodeType === 3 || (n.nodeType === 1 && !n.matches(SELECTION_CHROME)));
}
function captureEditorSelection(root) {
  const sel = root.ownerDocument.defaultView.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  function point(node, offset) {
    const parent = node.nodeType === 3 ? node.parentNode : node;
    if (parent.closest?.(SELECTION_CHROME)) return null;
    const path = []; let el = parent;
    while (el !== root) {
      const up = el.parentNode;
      if (!up) return null;
      path.unshift([...up.children].filter(c => !c.matches(SELECTION_CHROME)).indexOf(el));
      el = up;
    }
    let units = 0;
    const children = new Set(selectionChildren(parent));
    const before = node.nodeType === 3 ? [...parent.childNodes].slice(0, [...parent.childNodes].indexOf(node)) : [...parent.childNodes].slice(0, offset);
    for (const child of before) if (children.has(child)) units += child.nodeType === 3 ? child.length : 1;
    if (node.nodeType === 3) units += offset;
    return { path, offset: units };
  }
  const anchor = point(sel.anchorNode, sel.anchorOffset), focus = point(sel.focusNode, sel.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}
function restoreEditorSelection(root, bookmark) {
  if (!bookmark) return false;
  function point(saved) {
    let node = root;
    for (const index of saved.path) {
      node = [...node.children].filter(c => !c.matches(SELECTION_CHROME))[index];
      if (!node) return null;
    }
    let remaining = saved.offset;
    for (const child of selectionChildren(node)) {
      if (child.nodeType === 3) {
        if (remaining <= child.length) return [child, remaining];
        remaining -= child.length;
      } else {
        if (remaining === 0) return [node, [...node.childNodes].indexOf(child)];
        remaining--;
      }
    }
    return [node, node.childNodes.length];
  }
  const anchor = point(bookmark.anchor), focus = point(bookmark.focus);
  if (!anchor || !focus) return false;
  const sel = root.ownerDocument.defaultView.getSelection();
  sel.setBaseAndExtent(...anchor, ...focus);
  return true;
}

/** Model-ready command registry. The browser adapter is intentionally isolated here;
 * later phases can replace one command at a time without changing toolbar/shortcut callers. */
function createDocCommandRegistry(context) {
  const definitions = new Map();
  const native = {
    bold:'format.bold', italic:'format.italic', underline:'format.underline', strikeThrough:'format.strike',
    superscript:'format.superscript', subscript:'format.subscript', removeFormat:'format.clear',
    justifyLeft:'paragraph.left', justifyCenter:'paragraph.center', justifyRight:'paragraph.right', justifyFull:'paragraph.justify',
    insertUnorderedList:'list.bullets', insertOrderedList:'list.numbered', indent:'paragraph.indent', outdent:'paragraph.outdent',
    formatBlock:'paragraph.style', fontName:'format.font', foreColor:'format.color', hiliteColor:'format.highlight',
    createLink:'insert.link', insertHTML:'insert.html', insertText:'insert.text', delete:'edit.deleteSelection',
  };
  for (const [command, id] of Object.entries(native)) definitions.set(id, {
    run: value => context.native(command, value),
    active: () => context.active(command),
  });
  definitions.set('format.size', {run:value=>context.size(value)});
  definitions.set('edit.deleteAtomic', {run:target=>context.deleteAtomic(target)});
  definitions.set('edit.undo', {run:()=>context.undo(),history:true,enabled:()=>context.canUndo?.() ?? true});
  definitions.set('edit.redo', {run:()=>context.redo(),history:true,enabled:()=>context.canRedo?.() ?? true});
  function state(id) {
    const def=definitions.get(id);
    return {enabled:!!def && context.enabled(!!def.history) && def.enabled?.() !== false,active:!!def && !def.history && !!def.active?.()};
  }
  function run(id,value) {
    const def=definitions.get(id);
    if(!def || (!def.history && !context.prepare()) || !state(id).enabled)return false;
    if(def.history){def.run();return true;}
    context.before();
    try {
      const result=def.run(value);if(result===false)return false;
      if(result?.pending)context.pending?.();else context.changed();return true;
    } catch(err) {context.error(err);return false;}
    finally {context.after();}
  }
  return {run,state,idForNative:command=>native[command] || ({undo:'edit.undo',redo:'edit.redo'})[command],
    list:()=>[...definitions.keys()]};
}

/* ---- paste sanitizer (allowlist; keeps our chips/tables, strips Word/web cruft) ---- */
const SANITIZE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'FIGCAPTION', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'A', 'IMG', 'HR', 'FONT', 'BLOCKQUOTE', 'INS', 'DEL']);
const SANITIZE_ATTR = { A: ['href'], IMG: ['src', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const SANITIZE_STYLE = ['color', 'background-color', 'background', 'text-align', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'white-space', 'width', 'page-break-after', 'break-after',
  'position', 'left', 'top', 'right', 'bottom', 'height', 'z-index', 'border', 'border-color', 'border-radius', 'padding', 'margin-bottom', 'line-height', 'display', 'visibility', 'object-fit', 'object-position', 'clip-path', 'filter', 'rotate', 'opacity', 'margin-top', 'margin-left', 'margin-right', 'text-indent', 'vertical-align', 'table-layout', 'border-collapse', 'border-width', 'border-style', 'break-inside', 'page-break-inside','column-count','column-gap','break-before','page-break-before','box-shadow'];
const SANITIZE_DATA = ['data-token', 'data-repeat', 'data-checked', 'data-var-src', 'data-float-kind', 'data-doc-name', 'data-doc-locked', 'data-doc-hidden', 'data-doc-run','data-doc-node', 'data-doc-toc','data-doc-toc-page','data-doc-settings','data-doc-config','data-doc-style','data-doc-style-version','data-doc-design-page','data-doc-page-name','data-doc-page-bg','data-doc-section','data-doc-section-name','data-doc-section-break','data-doc-section-bg','data-doc-section-width','data-doc-section-height','data-doc-section-margin','data-doc-footnote','data-doc-note-ref','data-doc-note-number','data-doc-note-text','data-doc-notes','data-doc-change','data-doc-author','data-doc-date','data-doc-numbering'];

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

/** Explicit URL schemes; normalize browser-ignored controls before checking. */
function safeDocumentUrl(value, image = false) {
  const url = String(value || '').replace(/[\u0000-\u0020\u007f]/g, '');
  if (!url) return false;
  if (image && /^data:image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(url)) return true;
  if (/^(https?:)/i.test(url)) return true;
  if (!image && /^(mailto:|tel:)/i.test(url)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//') && !url.includes('\\');
}

function sanitizeNode(node, doc) {
  if (node.nodeType === 8 && /^doc-sync:[\w-]{1,100}$/.test(node.data)) return [doc.createComment(node.data)];
  if (node.nodeType === 8 && node.data.startsWith('doc-block:')) {
    try { if (/^[#/][^{}<>]+$/.test(decodeURIComponent(node.data.slice(10)))) return [doc.createComment(node.data)]; } catch { /* malformed marker */ }
    return [];
  }
  if (node.nodeType === 3) return [doc.createTextNode(node.nodeValue)];
  if (node.nodeType !== 1) return [];
  if (node.matches('.doc-page-guide,.doc-snap-guide,.doc-float-handle,.doc-float-toolbar,.doc-promote-bar')) return [];
  const tag = node.nodeName;
  const kids = [].concat(...[...node.childNodes].map((c) => sanitizeNode(c, doc)));
  if (tag === 'SCRIPT' || tag === 'STYLE') return [];
  if (!SANITIZE_TAGS.has(tag)) return kids; // drop tag, keep contents
  const el = doc.createElement(tag.toLowerCase());
  [...node.attributes].forEach((a) => {
    const n = a.name.toLowerCase();
    if (n.startsWith('on')) return;
    if (n === 'style') { const v = filterStyle(a.value); if (v) el.setAttribute('style', v); return; }
    if (n === 'class') { const keep = (a.value.match(/doc-(chip|chip-ctrl|chip-fx|checkbox|pagebreak|table|striped|shaded|plain|is-repeat|float|float-body|float-shape|running-header|running-footer|page-number)/g) || []).join(' '); if (keep) el.setAttribute('class', keep); return; }
    if (n === 'contenteditable') { if (a.value === 'false' || a.value === 'true') el.setAttribute('contenteditable', a.value); return; }
    if(n==='id' && /^doc-(?:heading|note|note-ref)-[a-zA-Z0-9_-]{1,150}$/.test(a.value)){el.setAttribute(n,a.value);return;}
    if (SANITIZE_DATA.includes(n)) { el.setAttribute(n, a.value); return; }
    if ((SANITIZE_ATTR[tag] || []).includes(n)) {
      if (n === 'href' && !safeDocumentUrl(a.value)) return;
      if (n === 'src' && !safeDocumentUrl(a.value, true)) return;
      el.setAttribute(n, a.value);
    }
  });
  kids.forEach((k) => el.appendChild(k));
  return [el];
}

/** Contents links are regenerated from semantic headings; no guessed print page numbers. */
function refreshContents(root) {
  const contents=[...root.querySelectorAll('[data-doc-toc]')];if(!contents.length)return;
  const headings=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h=>!h.closest('[data-doc-toc]'));
  const seen=new Set();headings.forEach(h=>{if(!/^doc-heading-[\w-]{1,40}$/.test(h.id)||seen.has(h.id))h.id='doc-heading-'+(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID().slice(0,16):Math.random().toString(36).slice(2));seen.add(h.id);});
  for(const toc of contents){if(toc.closest('[data-doc-locked="true"]'))continue;const list=root.ownerDocument.createElement('ul');list.style.cssText='list-style:none;padding-left:0';headings.forEach(h=>{const item=root.ownerDocument.createElement('li'),link=root.ownerDocument.createElement('a');item.style.marginLeft=((Number(h.tagName.slice(1))-1)*16)+'px';link.href='#'+h.id;const title=h.cloneNode(true);title.querySelectorAll('.doc-chip').forEach(chip=>chip.replaceWith(root.ownerDocument.createTextNode('{{'+chip.dataset.token+'}}')));link.textContent=title.textContent||'Untitled heading';const number=root.ownerDocument.createElement('span');number.dataset.docTocPage=h.id;number.style.cssText='float:right;min-width:32px;text-align:right';item.append(link,number);list.append(item);});const title=root.ownerDocument.createElement('p');title.style.fontWeight='700';title.textContent='Contents';toc.replaceChildren(title,list);toc.contentEditable='false';}
}

// Comments survive browser table parsing; raw loop text would be foster-parented out.
function protectExportBlocks(html){return String(html||'').replace(/(<[^>]*>)|\{\{\s*([#/][^{}<>]+?)\s*\}\}/g,(_m,tag,token)=>tag||'<!--doc-export-token:'+encodeURIComponent(token).replaceAll('-','%2D')+'-->');}
function restoreExportBlocks(html){return String(html||'').replace(/<!--doc-export-token:([^>]*?)-->/g,(_m,value)=>{try{const token=decodeURIComponent(value);return /^[#/][^{}<>]+$/.test(token)?'{{'+token+'}}':'';}catch{return '';}});}

/** Standalone export keeps template CSS/classes while removing executable HTML. */
function sanitizeExportHtml(html,doc) {
  doc=doc||(typeof document!=='undefined'?document:null);if(!doc)return '';
  const box=doc.createElement('template');box.innerHTML=protectExportBlocks(html);
  box.content.querySelectorAll('script,iframe,object,embed,meta,base,link').forEach(el=>el.remove());
  box.content.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes]){const key=attr.name.toLowerCase();if(key.startsWith('on')||key==='srcdoc'||key==='formaction')el.removeAttribute(attr.name);else if(['href','src','action','xlink:href'].includes(key)&&!safeDocumentUrl(attr.value,key==='src'&&el.tagName==='IMG'))el.removeAttribute(attr.name);}});
  return restoreExportBlocks(box.innerHTML);
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
  const m = rest.match(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>([\s\S]*?)<\/style>/i);
  if (m) {
    rest = rest.replace(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>[\s\S]*?<\/style>/gi, '');
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

/** Logical table coordinates include spans and exclude nested table rows. */
function tableGrid(table) {
  const rows = [...table.rows].filter((r) => r.closest('table') === table);
  const grid = [], positions = new Map();
  rows.forEach((row, r) => {
    grid[r] ||= []; let col = 0;
    [...row.cells].forEach((cell) => {
      while (grid[r][col]) col++;
      const width = Math.max(1, cell.colSpan);
      const groupEnd = rows.findIndex((other, i) => i > r && other.parentNode !== row.parentNode);
      const remaining = (groupEnd < 0 ? rows.length : groupEnd) - r;
      const height = cell.rowSpan === 0 ? remaining : Math.min(Math.max(1, cell.rowSpan), remaining);
      const pos = { r, c: col, w: width, h: height }; positions.set(cell, pos);
      for (let y = r; y < r + height; y++) {
        grid[y] ||= [];
        for (let x = col; x < col + width; x++) grid[y][x] = cell;
      }
      col += width;
    });
  });
  return { rows, grid, positions, width: Math.max(0, ...grid.map((r) => r.length)) };
}
function blankTableCell(row, tag) {
  const cell = row.ownerDocument.createElement(tag || (row.cells[0]?.nodeName === 'TH' ? 'th' : 'td'));
  cell.innerHTML = '&nbsp;'; return cell;
}
function insertTableCell(row, cell, col, model) {
  const before = [...row.cells].find((c) => model.positions.get(c)?.c >= col);
  row.insertBefore(cell, before || null);
}
function editTableColumn(cell, remove = false) {
  const model = tableGrid(cell.closest('table')), pos = model.positions.get(cell);
  const col = remove ? pos.c : pos.c + pos.w;
  if (remove && model.width <= 1) return;
  const adjusted = new Set();
  model.rows.forEach((row, r) => {
    const hit = model.grid[r]?.[remove ? col : col - 1], hp = model.positions.get(hit);
    if (hit && (remove || hp.c < col && hp.c + hp.w > col)) {
      if (!adjusted.has(hit)) {
        if (remove) { if (hit.colSpan > 1) hit.colSpan--; else hit.remove(); }
        else hit.colSpan++;
        adjusted.add(hit);
      }
    } else if (!remove) insertTableCell(row, blankTableCell(row), col, model);
  });
}
function editTableRow(cell, remove = false) {
  const table = cell.closest('table'), model = tableGrid(table), pos = model.positions.get(cell);
  const r = remove ? pos.r : pos.r + 1, row = model.rows[pos.r];
  if (remove) {
    if (model.rows.length <= 1) return;
    const next = model.rows[r + 1];
    model.positions.forEach((p, c) => {
      if (p.r < r && p.r + p.h > r) c.rowSpan = p.h - 1;
      else if (p.r === r && p.h > 1 && next && next.parentNode === row.parentNode) {
        c.rowSpan = p.h - 1; insertTableCell(next, c, p.c, model);
      }
    });
    row.remove();
  } else {
    const tr = row.ownerDocument.createElement('tr');
    const crossing = new Set();
    for (let col = 0; col < model.width; col++) {
      const c = model.grid[pos.r]?.[col], p = model.positions.get(c);
      if (p && p.r + p.h > r) crossing.add(c);
      else tr.appendChild(blankTableCell(row));
    }
    crossing.forEach((c) => { if (c.rowSpan !== 0) c.rowSpan++; });
    row.parentNode.insertBefore(tr, row.nextSibling);
  }
}
function mergeTableCells(cells) {
  if (cells.length < 2) return false;
  const table = cells[0].closest('table');
  if (cells.some((c) => c.closest('table') !== table)) return false;
  const model = tableGrid(table), chosen = new Set(cells);
  const positions = cells.map((c) => model.positions.get(c));
  const r1 = Math.min(...positions.map((p) => p.r)), r2 = Math.max(...positions.map((p) => p.r + p.h));
  const c1 = Math.min(...positions.map((p) => p.c)), c2 = Math.max(...positions.map((p) => p.c + p.w));
  if (model.rows.slice(r1, r2).some((r) => r.parentNode !== model.rows[r1].parentNode)) return false;
  for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) if (!chosen.has(model.grid[r]?.[c])) return false;
  const top = model.grid[r1][c1];
  const extra = cells.filter((c) => c !== top).sort((a, b) => {
    const ap = model.positions.get(a), bp = model.positions.get(b); return ap.r - bp.r || ap.c - bp.c;
  }).map((c) => c.innerHTML.trim()).filter((h) => h && h !== '&nbsp;');
  if (extra.length) top.innerHTML += ' ' + extra.join(' ');
  top.colSpan = c2 - c1; top.rowSpan = r2 - r1;
  cells.forEach((c) => { if (c !== top) c.remove(); });
  return true;
}
function splitTableCell(cell) {
  const model = tableGrid(cell.closest('table')), p = model.positions.get(cell);
  if (p.w === 1 && p.h === 1) return;
  cell.colSpan = 1; cell.rowSpan = 1;
  for (let r = p.r; r < p.r + p.h; r++) {
    for (let col = p.c + (r === p.r ? 1 : 0); col < p.c + p.w; col++) {
      insertTableCell(model.rows[r], blankTableCell(model.rows[r], cell.nodeName.toLowerCase()), col, model);
    }
  }
}

/** Consistent stroke icons, independent of emoji fonts and operating system. */
function docIcon(name) {
  const paths = {
    document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 1)"/>',
    textbox: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8h8M12 8v8M10 16h4"/>',
    checkbox: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 12 3 3 7-7"/>',
    pagebreak: '<path d="M4 3h16v6H4ZM4 15h16v6H4ZM2 12h3m3 0h3m3 0h3m3 0h2"/>',
    signature: '<path d="m4 16 9-9 4 4-9 9H4Zm9-9 3-3a2 2 0 0 1 3 3l-2 4M3 22h18"/>',
    'shape-rect': '<rect x="3" y="5" width="18" height="14" rx="1"/>',
    'shape-oval': '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    'shape-line': '<path d="m4 20 16-16"/><circle cx="4" cy="20" r="1"/><circle cx="20" cy="4" r="1"/>',
    hr: '<path d="M3 12h18"/>',
    variable: '<path d="M9 3H7v7l-3 2 3 2v7h2m6-18h2v7l3 2-3 2v7h-2"/>',
    formula: '<path d="M17 4h-4l-3 16H6M7 9h8m2 4 5 7m0-7-5 7"/>',
    symbol: '<path d="M3 20h5v-2a8 8 0 1 1 8 0v2h5"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    preview: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    styles:'<path d="m5 20 7-16 7 16M8 14h8M4 22h16"/>',
    shared:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface,#fff)"/><circle cx="15" cy="17" r="3" fill="var(--surface,#fff)"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
    redo: '<path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
    justifyLeft: '<path d="M4 5h16M4 10h10M4 15h16M4 20h10"/>',
    justifyCenter: '<path d="M4 5h16M7 10h10M4 15h16M7 20h10"/>',
    justifyRight: '<path d="M4 5h16M10 10h10M4 15h16M10 20h10"/>',
    justifyFull: '<path d="M4 5h16M4 10h16M4 15h16M4 20h16"/>',
  };
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.document}</svg>`;
}

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('doc-editor-styles')) return;
  const css = `
    .doc-fs{position:fixed;inset:0;z-index:40;background:var(--bg,#f4f8fd);display:flex;flex-direction:column;--doc-desk:#eef0f3;--doc-desk-dot:transparent;--doc-paper:#fff;--dt-line:#dbe2ec;--dt-line-strong:#c2cddd}
    @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .doc-fs{--doc-desk:#100f18;--doc-desk-dot:rgba(255,255,255,.06)}}
    :root[data-theme="dark"] .doc-fs{--doc-desk:#100f18;--doc-desk-dot:rgba(255,255,255,.06)}
    .doc-fs-bar{display:flex;align-items:center;gap:20px;padding:14px 24px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2),0 2px 8px rgba(15,30,60,.05);position:relative;z-index:2;flex-shrink:0}
    .doc-fs-bar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .doc-fs-title{font-weight:700;font-size:13px;color:var(--text,#16243d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;flex-shrink:1;letter-spacing:-.01em}
    .doc-fs-name{font-size:12.5px;font-weight:600;padding:5px 9px;width:150px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-period{font-size:12px;padding:5px 9px;width:92px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-fs-type{padding:5px 7px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:7px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:12.5px}
    .doc-fs-type-top{width:82px}
    .doc-fs-name:focus,.doc-fs-period:focus,.doc-fs-type:focus{outline:none;border-color:var(--accent,#2b7fff);box-shadow:0 0 0 3px var(--accent-weak,#e7f1ff)}
    .doc-modes{display:inline-flex;gap:2px;padding:2px;border-radius:6px;background:var(--surface-2,#eef4fb);flex-shrink:0}
    .doc-modes button{border:none;background:none;padding:4px 11px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;white-space:nowrap;border-radius:6px;transition:background .12s,color .12s}
    .doc-modes button:hover{color:var(--text,#16243d)}
    .doc-modes button.active{background:var(--surface,#fff);color:var(--text,#16243d);box-shadow:0 1px 2px rgba(15,30,60,.12),0 1px 3px rgba(15,30,60,.08)}
    .doc-fs-bar .btn{flex-shrink:0;padding:6px 12px;font-size:12.5px;font-weight:600;white-space:nowrap;border-radius:8px}
    .doc-tabs{display:flex;gap:1px;padding:0 12px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2);position:relative;z-index:1;flex-shrink:0;overflow-x:auto;overflow-y:hidden}
    .doc-tab{border:none;background:none;padding:9px 15px 8px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-muted,#5d6b84);font-family:inherit;border-bottom:2.5px solid transparent;margin-bottom:-1px;border-radius:6px 6px 0 0;transition:color .12s,background .12s}
    .doc-tab:hover{color:var(--text,#16243d);background:var(--surface-2,#eef4fb)}
    .doc-tab.active{color:var(--accent,#2b7fff);border-bottom-color:var(--accent,#2b7fff)}
    .doc-panel{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;align-items:stretch;padding:8px 20px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0}
    .doc-panel.table-panel{background:var(--accent-weak,#e7f1ff)}
    .doc-group{display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0;padding:2px 11px;position:relative}
    .doc-group:not(:first-child)::before{content:"";position:absolute;left:0;top:14%;bottom:14%;width:1px;background:var(--border,#dce6f2)}
    .doc-group:first-child{padding-left:2px}
    .doc-group-row{display:flex;align-items:center;gap:2px}
    .doc-group-cap{font-size:11px;color:var(--text-faint,#8a97ad);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;white-space:nowrap;font-weight:600}
    .doc-panel button{min-width:32px;height:32px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text,#16243d);padding:0 6px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;transition:background .1s,color .1s}
    .doc-panel button:hover{background:var(--surface-2,#eef4fb)}
    .doc-panel button:active{background:var(--surface-3,#e6eef8)}
    .doc-panel button.active{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-panel button:disabled{opacity:.32;cursor:default;pointer-events:none}
    .doc-panel button:focus-visible,.doc-tab:focus-visible,.doc-modes button:focus-visible,.doc-panel select:focus-visible,.doc-tile:focus-visible{outline:2px solid var(--accent,#2b7fff);outline-offset:1px}
    .doc-page .doc-pagebreak{border:0;border-top:2px dashed var(--accent,#2b7fff);opacity:.5;margin:18px 0;height:0}
    .doc-panel select{height:32px;flex-shrink:0;border:1px solid var(--border,#dce6f2);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .doc-panel select[data-cmd="formatBlock"]{width:104px}
    .doc-panel select[data-cmd="fontName"]{width:116px}
    .doc-panel select[data-fontsize]{width:46px}
    .doc-panel select[data-tblstyle]{width:90px}
    .doc-panel select.doc-zoomsel{width:66px}
    .doc-panel .tb-sep{width:1px;flex-shrink:0;align-self:center;height:18px;background:var(--border,#dce6f2);margin:0 4px}
    .doc-panel .tb-color{display:inline-flex;align-items:center;gap:3px;font-size:12px;cursor:pointer;padding:0 5px;color:var(--text,#16243d);height:32px;flex-shrink:0;border-radius:6px}
    .doc-panel .tb-color:hover{background:var(--surface-2,#eef4fb)}
    .doc-panel .tb-color input{width:18px;height:18px;border:none;background:none;padding:0;cursor:pointer}
    .doc-panel .btn-variable{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff);font-weight:700}
    .doc-panel .btn-fx{background:var(--success-weak,#e3f6ec);color:var(--success,#168f54);font-weight:700}
    .doc-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:72px;height:58px;flex-shrink:0;border:1px solid transparent;background:none;border-radius:8px;cursor:pointer;font-family:inherit;color:var(--text,#16243d);transition:background .1s}
    .doc-tile:hover{background:var(--surface-2,#eef4fb)}
    .doc-tile .doc-tile-ic{font-size:16px;line-height:1}
    .doc-tile .doc-tile-lbl{font-size:11px;font-weight:600;line-height:1;white-space:nowrap}
    .doc-tile-select{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;padding:0 5px}
    .doc-tile-select .doc-tile-lbl{font-size:11px;font-weight:600;color:var(--text-muted,#5d6b84);white-space:nowrap}
    .doc-tile-select select{width:82px}
    .doc-tile-select input[type="number"]{width:58px;height:32px;border:1px solid var(--border,#dce6f2);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:11.5px;padding:0 5px}
    .doc-tile-select input[type="checkbox"]{width:auto;height:32px;cursor:pointer}
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
    .doc-page tr.is-repeat>td,.doc-page tr[data-repeat]>td{box-shadow:inset 0 0 0 1px #bfd1e5}
    .doc-page td.cell-sel,.doc-page th.cell-sel{outline:2px solid var(--accent,#2b7fff);outline-offset:-2px;background:rgba(43,127,255,.12)!important}
    .doc-find{display:flex;gap:7px;align-items:center;padding:8px 14px;background:var(--surface,#fff);box-shadow:0 1px 0 var(--border,#dce6f2);flex-shrink:0}
    .doc-find input{padding:6px 10px;border:1px solid var(--border,#dce6f2);border-radius:7px;font-size:13px;background:var(--surface,#fff);color:var(--text,#16243d)}
    .doc-find input:focus{outline:none;border-color:var(--accent,#2b7fff);box-shadow:0 0 0 3px var(--accent-weak,#e7f1ff)}
    .doc-find button{border:1px solid var(--border,#dce6f2);background:var(--surface-2,#eef4fb);border-radius:7px;padding:6px 11px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text,#16243d);font-family:inherit;transition:background .1s,color .1s}
    .doc-find button:hover{background:var(--accent-weak,#e7f1ff);color:var(--accent,#2b7fff)}
    .doc-page img{max-width:100%}
    .doc-chip{display:inline-block;background:#f0f5fb;color:#45678e;border:1px solid #d2dfed;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:500;font-family:Consolas,ui-monospace,monospace;white-space:nowrap;line-height:1.5}
    [data-doc-run="inline"]>.doc-chip{font-size:inherit;font-weight:inherit;font-style:inherit;font-family:inherit;color:inherit}
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
    .doc-preview-float{position:fixed;top:96px;right:28px;width:480px;height:600px;min-width:300px;min-height:240px;background:var(--surface,#fff);border:1px solid var(--border,#dce6f2);border-radius:12px;box-shadow:0 24px 64px rgba(15,30,60,.28),0 2px 8px rgba(15,30,60,.12);display:flex;flex-direction:column;z-index:45;resize:both;overflow:hidden;max-width:calc(100vw - 32px);max-height:calc(100vh - 120px)}
    .doc-preview-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--surface-2,#eef4fb);box-shadow:0 1px 0 var(--border,#dce6f2);cursor:move;flex-shrink:0;font-weight:600;font-size:13px;color:var(--text,#16243d);user-select:none}
    .doc-preview-head .grow{flex:1}
    .doc-preview-head button{border:none;background:none;cursor:pointer;color:var(--text-muted,#5d6b84);font-size:15px;padding:2px 7px;border-radius:5px;line-height:1}
    .doc-preview-head button:hover{background:var(--surface-3,#e6eef8)}
    .doc-preview-float iframe{flex:1;border:none;width:100%;background:#fff}
    /* ---- floating objects: shapes / text boxes / promoted images & tables ---- */
    .doc-float{box-sizing:border-box}
    .doc-float.selected{outline:1.5px solid var(--accent,#2b7fff);outline-offset:0;box-shadow:0 0 0 1px rgba(43,127,255,.22),0 3px 16px rgba(43,127,255,.16)}
    /* Selection never changes an editable object's padding or text wrapping.
       The explicit Move grip separates object positioning from caret placement. */
    .doc-float.selected[data-float-kind="text"],.doc-float.selected[data-float-kind="table"],.doc-float.selected[data-float-kind="textbox"]{padding:0;background:transparent;cursor:move;outline:none;box-shadow:none}
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

    .doc-fs{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif}
    .doc-fs-bar{box-shadow:none;border-bottom:1px solid var(--border,#e2e5e9)}
    .doc-brand{display:flex;align-items:center;gap:12px;min-width:190px;margin-right:auto}
    .doc-brand>svg{width:24px;height:24px;padding:4px;box-sizing:content-box;background:var(--surface-2,#f3f4f6);border:1px solid var(--border,#e2e5e9);border-radius:9px;color:var(--text,#253247)}
    .doc-brand>div{display:flex;flex-direction:column;gap:3px}
    .doc-brand-label{font-size:14px;font-weight:650;letter-spacing:-.02em;color:var(--text,#253247)}
    .doc-fs-title{font-size:11px;color:var(--text-muted,#697586);font-weight:400;max-width:220px}
    .doc-fs-bar .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;border-radius:6px;padding:0 12px}
    .doc-fs-bar .doc-icon-button{width:36px;padding:0}
    .doc-save-status{font-size:11px;white-space:nowrap;color:var(--text-muted,#697586);padding-right:8px}
    .doc-save-status[data-state="dirty"]::before{content:"";display:inline-block;width:5px;height:5px;background:#b7791f;border-radius:50%;margin-right:6px;vertical-align:middle}
    .doc-save-status[data-state="error"]{color:var(--danger,#b42318)}
    .doc-details{display:flex;align-items:end;gap:24px;padding:14px 24px 16px;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e5e9);flex-shrink:0}
    .doc-details label{display:flex;flex-direction:column;gap:6px;margin:0}
    .doc-details label>span{font-size:10px;font-weight:600;letter-spacing:.035em;color:var(--text-muted,#697586)}
    .doc-details .doc-name-field{flex:1;max-width:460px}
    .doc-details input,.doc-details select{height:34px;box-sizing:border-box;border-radius:5px;font-size:13px;width:180px}
    .doc-details .doc-fs-name{width:100%;font-size:16px;font-weight:600;letter-spacing:-.02em}
    .doc-details .doc-fs-type-top{width:150px}
    .doc-tabs{padding:0 24px;box-shadow:none;border-bottom:1px solid var(--border,#e2e5e9)}
    .doc-tab{border-radius:0;font-size:12px;padding:11px 18px}
    .doc-group{padding:2px 14px;gap:3px}
    .doc-group-cap{line-height:14px;margin-top:3px;text-transform:none;letter-spacing:0;font-weight:400;color:var(--text-muted,#697586)}
    .doc-panel .doc-tile{height:48px;min-width:64px;padding:6px 8px;gap:8px}
    .doc-tile-ic{display:flex;align-items:center;justify-content:center}
    .doc-tile-ic svg{width:20px;height:20px}
    .doc-panel .btn-fx,.doc-panel .btn-variable{background:transparent;color:var(--text,#253247);font-weight:500}
    .doc-panel .btn-fx:hover,.doc-panel .btn-variable:hover{background:var(--surface-2,#f3f4f6)}
    .doc-canvas{background-image:none;padding:40px 32px 48px}
    .doc-page{border:0;box-shadow:0 1px 4px rgba(25,35,50,.12),0 8px 24px rgba(25,35,50,.06)}
    .doc-statusbar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:9px 24px;background:var(--surface,#fff);border-top:1px solid var(--border,#e2e5e9);font-size:11px;color:var(--text-muted,#697586);flex-shrink:0}
    .doc-statusbar>span{display:flex;align-items:center;gap:7px}
    .doc-statusbar svg{width:14px;height:14px}
    .doc-preview-head>span{display:flex;align-items:center;gap:8px}
    .doc-preview-float{border-radius:8px}
    .doc-fs svg{flex-shrink:0;vertical-align:middle}
    @media(max-width:1280px){.doc-save-status{display:none}.doc-fs-bar{gap:12px}.doc-brand{min-width:160px}.doc-fs-bar-actions{gap:4px}.doc-statusbar .doc-workspace-hint{display:none}}
    @media(max-width:760px){.doc-fs-bar{padding:10px 12px;flex-wrap:wrap;gap:10px}.doc-brand{min-width:140px}.doc-brand-label{font-size:13px}.doc-brand>svg{display:none}.doc-fs-title{max-width:140px}.doc-fs-bar-actions{margin-left:auto}.doc-fs-bar-actions [data-save] span,.doc-fs-bar-actions [data-preview] span,.doc-fs-bar-actions [data-file] span{display:none}.doc-fs-bar-actions [data-file]{width:36px;padding:0}.doc-details{padding:12px;gap:12px;flex-wrap:wrap}.doc-details .doc-name-field{min-width:100%;max-width:none}.doc-details input,.doc-details select{width:150px}.doc-tabs{padding:0 12px}.doc-panel{padding:8px}.doc-statusbar{padding:9px 12px}.doc-canvas{padding:20px 12px}}
    @media (max-width:900px){.doc-page{padding:28px 22px}.doc-canvas{padding:10px}}
  `;
  const themeCss = `
    .doc-fs{background:var(--bg)}
    .doc-fs-bar{padding:12px 20px;background:var(--surface);box-shadow:var(--shadow-sm);z-index:4}
    .doc-brand>svg{background:var(--accent-weak);color:var(--accent);border-color:var(--border);border-radius:var(--radius-sm)}
    .doc-fs-bar .btn,.doc-details input,.doc-details select{border-radius:var(--radius-sm)}
    .doc-details{padding:12px 20px;gap:20px;background:var(--surface)}
    .doc-details-toggle{display:none}
    .doc-details label>span{font-size:11px;color:var(--text-muted);letter-spacing:0}
    .doc-tabs{gap:4px;padding:6px 20px;background:var(--surface-2)}
    .doc-tab{border-radius:var(--radius-sm);padding:8px 16px;border-bottom:0;color:var(--text-muted)}
    .doc-tab.active{background:var(--surface);color:var(--accent);box-shadow:var(--shadow-sm)}
    .doc-panel{padding:10px 12px;background:var(--surface);scrollbar-width:thin}
    .doc-panel.table-panel{background:var(--surface)}
    .doc-group-cap{font-size:10px;color:var(--text-muted);font-weight:600}
    .doc-canvas{background:var(--bg);padding:28px}
    .doc-page{box-shadow:var(--shadow-md)}
    .doc-modes{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:3px}
    .doc-modes button.active{background:var(--surface);color:var(--accent);box-shadow:var(--shadow-sm)}
    .doc-fs input:focus-visible,.doc-fs select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    @media(max-width:760px){.doc-details-toggle{display:inline-flex;float:right;border:0;background:var(--surface-2);color:var(--accent);border-radius:var(--radius-sm);padding:3px 8px;font:inherit;cursor:pointer}.doc-details:not(.details-expanded) .doc-secondary-details{display:none}.doc-fs-bar{padding:10px 12px}.doc-details{padding:10px 12px}.doc-tabs{padding:6px 8px}.doc-canvas{padding:16px 10px}}
  `;
  const workspaceCss = `
    .doc-fs{--doc-desk:var(--bg);font-family:var(--font,system-ui);isolation:isolate}
    .doc-fs-bar{gap:12px;padding:6px 14px;box-shadow:none;min-height:52px;box-sizing:border-box}
    .doc-brand{min-width:160px;flex:1}.doc-brand>div{min-width:0;flex:1}.doc-brand .doc-fs-name{width:100%;max-width:460px;border:1px solid transparent;background:transparent;padding:2px 4px;font-size:16px;letter-spacing:-.025em;font-weight:650;height:28px}.doc-brand .doc-fs-name:hover{border-color:var(--border)}.doc-brand .doc-fs-name:focus{background:var(--surface);border-color:var(--accent)}.doc-fs-title{padding-left:4px;max-width:100%;font-size:11px}
    .doc-details{display:none;padding:12px 20px;align-items:center;background:var(--surface-2)}.doc-details.details-expanded{display:flex}.doc-settings-caption{font-size:12px;font-weight:650;color:var(--text)}
    .doc-tabs{background:var(--surface);padding:3px 14px;gap:4px}.doc-tab{padding:5px 12px;font-size:12px}.doc-tab.active{background:var(--accent-weak);box-shadow:none}
    .doc-panel{min-height:46px;box-sizing:border-box;padding:5px 14px;gap:4px}.doc-group{padding:0 8px;justify-content:center;gap:3px}.doc-group-cap{display:none}.doc-group-row{gap:4px}.doc-panel button{height:32px;min-width:32px}.doc-panel select{font-size:12px}
    .doc-panel select[data-fontsize]{width:62px}.doc-panel select[data-cmd="fontName"]{width:130px}
    .doc-more-menu{position:relative;font-size:12px;flex-shrink:0}.doc-more-menu summary{list-style:none;display:flex;align-items:center;gap:7px;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;color:var(--text)}.doc-more-menu summary::-webkit-details-marker{display:none}.doc-more-menu[open] summary{background:var(--accent-weak);color:var(--accent)}.doc-more-popover{position:absolute;right:0;top:42px;width:215px;padding:6px;border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-md);background:var(--surface);z-index:20;display:flex;flex-direction:column;gap:4px}.doc-more-popover button{width:100%!important;justify-content:flex-start!important;gap:8px!important;display:flex;align-items:center;height:34px;border:0!important;background:transparent;color:var(--text);padding:6px 10px;font:12px var(--font,system-ui);border-radius:var(--radius-sm)}.doc-more-popover button:hover{background:var(--surface-2)}.doc-more-popover [data-managevars]::after{content:'Manage fields'}.doc-more-popover [data-help]::after{content:'Editor guide'}
    .doc-workspace{position:relative}.doc-tool-rail{width:74px;flex-shrink:0;border-right:1px solid var(--border);background:var(--surface);padding:8px 5px;display:flex;flex-direction:column;gap:4px;overflow:auto;scrollbar-width:thin;box-sizing:border-box}.doc-tool-rail button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:50px;padding:7px 3px;flex-shrink:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);font:11px var(--font,system-ui);cursor:pointer}.doc-tool-rail button:hover{background:var(--surface-2);color:var(--text)}.doc-tool-rail button[aria-pressed=true]{background:var(--accent-weak);color:var(--accent)}.doc-tool-rail svg{width:18px;height:18px}.doc-tool-rail button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .doc-studio-side[hidden]{display:none!important}.doc-studio-side{width:296px!important;display:flex;flex-direction:column;overflow:hidden!important}.doc-inspector-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;flex-shrink:0}.doc-inspector-head button{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;background:transparent}.doc-studio-body{flex:1;min-height:0;overflow:auto;padding:16px!important}.doc-studio-note{border-top:1px solid var(--border);font-size:10px!important;padding:10px 16px!important;flex-shrink:0}.doc-studio-note:empty{display:none}
    .doc-canvas{background:var(--bg);padding:14px 18px}.doc-page{box-shadow:var(--shadow-md),0 0 0 1px var(--border);border-radius:2px}.doc-statusbar{padding:4px 14px;font-size:11px}.doc-workspace-hint{font-size:10px}
    @media(max-width:1200px){.doc-fs-bar{gap:10px}.doc-fs-bar-actions{gap:5px}.doc-fs-bar-actions [data-preview] span,.doc-fs-bar-actions [data-details] span{display:none}.doc-fs-bar-actions [data-preview],.doc-fs-bar-actions [data-details]{width:34px;padding:0}.doc-brand .doc-fs-name{font-size:14px}.doc-tool-rail{width:64px}}
    @media(max-width:760px){.doc-fs-bar{padding:8px 10px;gap:8px;flex-wrap:wrap;min-height:100px}.doc-brand{min-width:0;flex-basis:calc(100% - 140px);order:0}.doc-brand>svg{display:none}.doc-fs-bar-actions{display:contents}.doc-fs-bar-actions [data-save]{order:1;height:32px}.doc-fs-bar-actions [data-close]{order:2;height:32px;width:30px}.doc-modes{order:3;margin-right:auto}.doc-fs-bar-actions [data-file],.doc-fs-bar-actions [data-preview],.doc-fs-bar-actions [data-details],.doc-more-menu{order:4;height:32px}.doc-fs-bar-actions [data-tools]{display:none}.doc-more-menu summary{height:30px;padding:0 7px}.doc-more-menu summary svg{display:none}.doc-fs-bar-actions .doc-save-status{display:none}.doc-details{flex-wrap:wrap;gap:12px}.doc-details.details-expanded .doc-secondary-details{display:flex}.doc-settings-caption{flex-basis:100%}.doc-tabs{padding:4px 8px}.doc-panel{padding:6px 8px;min-height:66px}.doc-tool-rail{width:54px;padding:5px 3px;gap:2px}.doc-tool-rail button{min-height:46px;font-size:9px}.doc-workspace{flex-direction:row!important}.doc-canvas{padding:18px 12px}.doc-studio-side{position:absolute;right:0;top:0;bottom:0;width:min(296px,calc(100% - 56px))!important;max-height:none!important;z-index:6;border-top:0!important;box-shadow:var(--shadow-md)}.doc-studio-body .doc-prop-grid{grid-template-columns:1fr 1fr!important}.doc-statusbar{padding:7px 10px;gap:8px}.doc-statusbar .doc-workspace-hint{display:none}.doc-more-popover{position:fixed;top:100px;right:10px}}
  `;
  const clarityCss = `
    .doc-fs-bar-actions [data-tools]{display:none}.doc-brand{min-width:230px}.doc-fs-bar-actions{gap:6px}.doc-brand .doc-fs-name{max-width:none}.doc-shared-status{max-width:240px;overflow:hidden;text-overflow:ellipsis}.doc-statusbar .doc-shared-status{font-size:10px;padding:0}.doc-statusbar .doc-shared-status[data-state=error]{display:block;color:var(--danger)}
    .doc-format-extra{position:relative;flex-shrink:0}.doc-format-extra summary{cursor:pointer;list-style:none;font:12px var(--font,system-ui);padding:8px;color:var(--text-muted);border-radius:var(--radius-sm)}.doc-format-extra summary::-webkit-details-marker{display:none}.doc-format-extra[open] summary{background:var(--accent-weak);color:var(--accent)}.doc-format-popover{position:fixed;width:170px;z-index:20;background:var(--surface);padding:6px;border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-md)}.doc-format-popover button{display:flex;justify-content:flex-start;width:100%;padding:0 10px;font-size:12px}
    @media(max-width:760px){.doc-brand{min-width:0}.doc-statusbar .doc-shared-status{display:none}.doc-statusbar .doc-shared-status[data-state=error]{flex-basis:100%;max-width:none;white-space:normal}.doc-statusbar:has(.doc-shared-status[data-state=error]){flex-wrap:wrap}}
  `;
  const viewCss=`.doc-fs[data-editor-mode=pages] .doc-tool-rail,.doc-fs[data-editor-mode=pages] .doc-studio-side,.doc-fs:not([data-editor-mode=visual]) .doc-view-tools{display:none!important}.doc-tool-rail>[data-help]{margin-top:auto}.doc-find{flex-shrink:0}@media(max-width:760px){.doc-find{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:6px;padding:8px}.doc-find input{width:100%;min-width:0;box-sizing:border-box}}.doc-view-tools{display:flex;align-items:center;gap:5px}.doc-view-tools button{border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);font:12px var(--font,system-ui);height:25px;min-width:25px;cursor:pointer}.doc-view-tools button[aria-pressed=true]{background:var(--accent-weak);color:var(--accent)}.doc-view-tools button:hover{background:var(--surface-2);color:var(--text)}.doc-view-tools button:focus-visible{outline:2px solid var(--accent)}.doc-zoom-info{min-width:60px;text-align:center}.doc-panel[data-panel=home] .doc-group-row{flex-wrap:nowrap}.doc-panel[data-panel=home] .doc-group:has([data-cmd=fontName]) .doc-group-row{max-width:700px}@media(max-width:760px){.doc-panel[data-panel=home]{overflow:visible;flex-wrap:wrap;gap:4px;min-height:0}.doc-panel[data-panel=home] .doc-group{padding:2px 4px;gap:3px}.doc-panel[data-panel=home] .doc-group:has([data-cmd=fontName]){flex:1;min-width:0}.doc-panel[data-panel=home] .doc-group-row{justify-content:flex-start;gap:3px;flex-wrap:wrap}.doc-panel[data-panel=home] select[data-cmd=formatBlock]{width:85px}.doc-panel[data-panel=home] select[data-cmd=fontName]{width:102px}.doc-panel[data-panel=home] .doc-group-cap{display:none}.doc-panel[data-panel=home] .doc-group:has([data-find]){display:none}.doc-view-tools{gap:1px}.doc-view-tools button{min-width:20px;padding:0 3px}.doc-statusbar>.doc-word-count{display:none}}` ;
  const compactCss = `
    .doc-color-picker{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 8px;background:var(--surface)}.doc-studio-body .doc-color-picker input[type=color]{width:44px;height:32px;min-height:32px;padding:2px;flex-shrink:0;cursor:pointer}.doc-color-picker [data-color-label]{flex:1;font-size:11px;color:var(--text-muted)}.doc-studio-body .doc-color-picker button{font-size:11px;padding:5px 8px}
    .doc-fs:not([data-editor-mode=visual]) .doc-ribbon-controls{display:none}
    .doc-panel .doc-tile{height:32px;min-width:0;flex-direction:row;gap:5px;padding:4px 6px}.doc-panel .doc-tile svg{width:18px;height:18px}
    .doc-ribbon-controls{display:flex;align-items:center;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}.doc-ribbon-controls .doc-tabs{flex:1;min-width:0;border-bottom:0;box-shadow:none}.doc-ribbon-toggle{margin:0 12px 0 4px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);font:11px var(--font,system-ui);cursor:pointer;white-space:nowrap}.doc-ribbon-toggle:focus-visible{outline:2px solid var(--accent)}.doc-fs.ribbon-collapsed>.doc-panel{display:none!important}
    .doc-tool-rail{width:62px;padding:5px 4px;gap:2px}.doc-tool-rail button{min-height:42px;padding:4px 2px;gap:3px;font-size:10px}.doc-tool-rail [data-rail-toggle]{min-height:30px;border-bottom:1px solid var(--border);border-radius:0;margin-bottom:3px}.doc-workspace.rail-collapsed .doc-tool-rail{width:40px}.doc-workspace.rail-collapsed .doc-tool-rail button span{display:none}.doc-workspace.rail-collapsed .doc-tool-rail button{min-height:34px}.doc-studio-side .doc-inspector-head button{width:auto!important;padding:5px 8px;gap:5px;font-size:11px}.doc-inspector-head button svg{width:14px;height:14px}
    @media(max-width:760px){.doc-panel{min-height:0}.doc-ribbon-toggle{font-size:10px;margin-right:8px;padding:6px}.doc-tool-rail{width:48px}.doc-tool-rail button{min-height:40px;font-size:9px}.doc-workspace.rail-collapsed .doc-tool-rail{width:38px}.doc-canvas{padding:12px 8px}}
  `;
  const contentCss = typeof UI !== 'undefined' && UI.documentCss ? UI.documentCss : '';
  const el = document.createElement('style'); el.id = 'doc-editor-styles'; el.textContent = css + themeCss + contentCss + workspaceCss + clarityCss + viewCss + `.doc-grid-note{font:11px var(--font);color:var(--text-muted);margin:6px}.doc-studio-body input[type=color]{height:36px;min-height:36px;padding:3px}.doc-review-card{padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm)}.doc-page [data-doc-design-page]{margin-bottom:24px;box-shadow:0 0 0 1px var(--border);padding:0;display:flow-root}.doc-page ins[data-doc-change]{background:#dcfce7;color:#166534;text-decoration:underline}.doc-page del[data-doc-change]{background:#fee2e2;color:#991b1b;text-decoration:line-through}.doc-page [data-doc-settings]{display:none!important}.doc-page [data-doc-section]{display:flow-root}.doc-page ol[data-doc-numbering="hierarchical"],.doc-page ol[data-doc-numbering="hierarchical"] ol{counter-reset:doc-list;list-style:none}.doc-page ol[data-doc-numbering="hierarchical"] li::before{counter-increment:doc-list;content:counters(doc-list,".") ". "}`;
  el.textContent += compactCss;
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
    <button type="button" class="doc-tab active" data-tab="home">Text</button>
    <button type="button" class="doc-tab" data-tab="insert">Insert</button>
    <button type="button" class="doc-tab" data-tab="layout">Page & print</button>
    <button type="button" class="doc-tab" data-tab="table" style="display:none">Table</button>`;
}

function homePanelHTML() {
  const undo = groupHTML('Undo', `
    <button type="button" data-ex="undo" title="Undo (Ctrl+Z)" disabled>${docIcon('undo')}</button>
    <button type="button" data-ex="redo" title="Redo (Ctrl+Y)" disabled>${docIcon('redo')}</button>`);
  const font = groupHTML('Font', `
    <select data-cmd="formatBlock" title="Paragraph style">
      <option value="p">Normal</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="h4">Heading 4</option><option value="h5">Heading 5</option><option value="h6">Heading 6</option>
    </select>
    <select data-cmd="fontName" title="Font">${FONTS.map((f) => `<option value="${f}">${f}</option>`).join('')}</select>
    <select data-fontsize title="Font size (pt)">${SIZES.map((s) => `<option value="${s}" ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <span class="tb-sep"></span>
    <button type="button" data-ex="bold" title="Bold"><b>B</b></button>
    <button type="button" data-ex="italic" title="Italic"><i>I</i></button>
    <button type="button" data-ex="underline" title="Underline"><u>U</u></button>
    <label class="tb-color" title="Text color"><b>A</b><input type="color" data-color="foreColor" value="#16243d"></label>
    <label class="tb-color" title="Highlight">▣<input type="color" data-color="hiliteColor" value="#fff3b0"></label>
    <details class="doc-format-extra"><summary aria-label="More text formatting" title="More text formatting">More</summary><div class="doc-format-popover">    <button type="button" data-ex="strikeThrough" title="Strikethrough">Strikethrough</button>
    <button type="button" data-ex="superscript" title="Superscript">Superscript</button>
    <button type="button" data-ex="subscript" title="Subscript">Subscript</button>
<button type="button" data-ex="removeFormat" title="Clear formatting">Clear formatting</button></div></details>`);
  const paragraph = groupHTML('Paragraph', `
    <button type="button" data-ex="justifyLeft" title="Align left">${docIcon('justifyLeft')}</button>
    <button type="button" data-ex="justifyCenter" title="Align center">${docIcon('justifyCenter')}</button>
    <button type="button" data-ex="justifyRight" title="Align right">${docIcon('justifyRight')}</button>
    <button type="button" data-ex="justifyFull" title="Justify">${docIcon('justifyFull')}</button>
    <button type="button" data-ex="insertUnorderedList" title="Bullet list">•≣</button>
    <button type="button" data-ex="insertOrderedList" title="Numbered list">1≣</button>
    <button type="button" data-ex="outdent" title="Decrease indent">⇤</button>
    <button type="button" data-ex="indent" title="Increase indent">⇥</button>
    <button type="button" data-paragraph title="Paragraph spacing and indentation">Spacing</button>`);
  const editing = groupHTML('Editing', `
    <button type="button" class="doc-tile" data-find title="Find &amp; replace (Ctrl+F)"><span class="doc-tile-ic">${docIcon('search')}</span><span class="doc-tile-lbl">Find</span></button>`);
  return undo + font + paragraph + editing;
}

function tile(kind, value, icon, label, extraClass) {
  return `<button type="button" data-${kind}="${value}" class="doc-tile ${extraClass || ''}" title="${label}">
    <span class="doc-tile-ic">${docIcon(value)}</span><span class="doc-tile-lbl">${label}</span></button>`;
}

function insertPanelHTML() {
  const illustrations = groupHTML('Illustrations', tile('ins', 'image', '🖼', 'Picture'));
  const shapes = groupHTML('Shapes', tile('ins', 'shape-rect', '▭', 'Rectangle') + tile('ins', 'shape-oval', '⬭', 'Oval') + tile('ins', 'shape-line', '—', 'Line'));
  const tables = groupHTML('Tables', tile('ins', 'table', '▦', 'Table'));
  const links = groupHTML('Links', tile('ins', 'link', '🔗', 'Link'));
  const text = groupHTML('Text', tile('ins', 'checkbox', '☐', 'Checkbox') + tile('ins', 'hr', '―', 'Line')
    + tile('ins', 'pagebreak', '⤓', 'Page Break') + tile('ins', 'textbox', '▭', 'Text Box') + tile('ins', 'signature', '✒', 'Signature Line'));
  const symbols = groupHTML('Symbols', tile('ins', 'symbol', 'Ω', 'Symbol'));
  const template = groupHTML('Template', tile('ins', 'variable', '{ }', 'Field', 'btn-variable') + tile('ins', 'formula', 'ƒx', 'Formula', 'btn-fx'));
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
  const spacing = groupHTML('Grid spacing', `    <div class="doc-tile-select"><span class="doc-tile-lbl">Horizontal gap (mm)</span><input class="doc-fs-type doc-gap-x" type="number" min="0" max="30" step="0.5" title="Space between columns; zero packs cells together"></div>
    <div class="doc-tile-select"><span class="doc-tile-lbl">Vertical gap (mm)</span><input class="doc-fs-type doc-gap-y" type="number" min="0" max="30" step="0.5" title="Space between rows"></div>
`);
  const zoom = groupHTML('Zoom', `
    <button type="button" data-zoom="out" title="Zoom out (Ctrl -)">−</button>
    <select class="doc-fs-type doc-zoomsel" title="Zoom level">
      <option value="fit">Fit width</option>
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
    <button type="button" class="doc-tile" data-preview title="Open a movable preview"><span class="doc-tile-ic">${docIcon('preview')}</span><span class="doc-tile-lbl">Preview</span></button>`);
  return pageSetup + copies + spacing + zoom + previewGroup;
}

function tablePanelHTML() {
  const rowsCols = groupHTML('Rows &amp; Columns', `
    <button type="button" data-tbl="addRow" title="Insert row below">Insert row</button>
    <button type="button" data-tbl="delRow" title="Delete row">Delete row</button>
    <button type="button" data-tbl="addCol" title="Insert column right">Insert column</button>
    <button type="button" data-tbl="delCol" title="Delete column">Delete column</button>`);
  const merge = groupHTML('Merge', `
    <button type="button" data-tbl="mergeRight" title="Merge with cell on the right">Merge →</button>
    <button type="button" data-tbl="mergeDown" title="Merge with cell below">Merge ↓</button>
    <button type="button" data-tbl="split" title="Split merged cell">Split</button>`);
  const design = groupHTML('Design', `
    <label class="tb-color" title="Cell shading">▮<input type="color" data-cellbg value="#ffffff"></label>
    <button type="button" data-tbl="properties" title="Table borders, spacing, alignment and row settings">Properties</button>
    <button type="button" data-tbl="distribute" title="Make all columns equal width">Equal columns</button>
    <button type="button" data-tbl="width" title="Set column width">↔ Width</button>
    <select data-tblstyle title="Table style"><option value="doc-table">Bordered</option><option value="doc-table striped">Striped</option><option value="doc-table shaded">Shaded header</option><option value="doc-table plain">Plain</option></select>`);
  const template = groupHTML('Template', `
    <button type="button" data-tbl="repeat" title="Repeat this row for each line item">↻ Item row</button>
    <button type="button" data-tbl="fxcell" class="btn-fx" title="Make this cell a formula (=)">= ƒx</button>
    <button type="button" data-tbl="delTable" title="Delete table">${docIcon('trash')}</button>`);
  return rowsCols + merge + design + template;
}

/* ---- shared dialogs ---- */
function insertTableDialog(insertHtml, saveSel, modal = UI.modal) {
  saveSel();
  modal({
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

function imageDialog(insertHtml, saveSel, modal = UI.modal) {
  saveSel();
  modal({
    title: 'Insert image',
    bodyHTML: `<label>Image URL</label><input id="img-url" placeholder="https://…">
      <label>…or upload a file</label><input type="file" id="img-file" accept="image/*">
      <p class="muted" style="font-size:12px">Tip: you can also drag an image onto the page, or paste one.</p>`,
    confirmText: 'Insert',
    onConfirm: async (ov, showErr) => {
      const url = ov.querySelector('#img-url').value.trim();
      const file = ov.querySelector('#img-file').files[0];
      if (url && !safeDocumentUrl(url,true)) { showErr('Enter a valid image URL');return false; }
      if (url) { insertHtml(`<img src="${escAttr(url)}" alt="">`); return; }
      if (!file) { showErr('Provide a URL or choose a file'); return false; }
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
      insertHtml(`<img src="${escAttr(dataUrl)}" alt="${escAttr(file.name)}">`);
    },
  });
}

/** Image geometry and effects remain ordinary CSS in saved HTML and printed previews. */
function editPicture(img,onChange) {
  if(!img||img.closest('[data-doc-locked="true"]'))return;
  const s=img.style,fit=s.objectFit||'contain',position=(s.objectPosition||'50% 50%').match(/[\d.]+/g)||['50','50'];
  const mask=s.clipPath?.startsWith('circle')?'circle':s.clipPath?.startsWith('ellipse')?'ellipse':s.clipPath?.startsWith('polygon')?'diamond':'none';
  const effect=name=>Number(new RegExp(name+'\\(([^)]+)\\)').exec(s.filter||'')?.[1]?.replace('%','')??(name==='brightness'||name==='contrast'||name==='saturate'?100:0));
  const box=img.getBoundingClientRect(),computed=getComputedStyle(img);const width=parseFloat(computed.width)||img.naturalWidth||box.width||300,height=parseFloat(computed.height)||img.naturalHeight||box.height||200;
  UI.modal({title:'Picture settings',size:'lg',confirmText:'Apply',bodyHTML:`
    <div class="doc-picture-preview" style="display:flex;justify-content:center;align-items:center;background:var(--surface-2);padding:16px;border:1px solid var(--border);border-radius:var(--radius);min-height:180px"><img data-picture-preview src="${escAttr(img.src)}" alt="Picture preview" style="width:240px;height:160px"></div>
    <div class="field-row"><label>Fit<select id="pic-fit"><option value="contain" ${fit==='contain'?'selected':''}>Fit entire image</option><option value="cover" ${fit==='cover'?'selected':''}>Crop to fill</option><option value="fill" ${fit==='fill'?'selected':''}>Stretch</option></select></label><label>Mask<select id="pic-mask">${['none','circle','ellipse','diamond'].map(v=>`<option ${mask===v?'selected':''}>${v}</option>`).join('')}</select></label><label>Corner radius (px)<input id="pic-radius" type="number" min="0" max="200" value="${parseFloat(s.borderRadius)||parseFloat(getComputedStyle(img).borderRadius)||0}"></label></div>
    <div class="field-row"><label>Focal point X (%)<input id="pic-x" type="range" min="0" max="100" value="${position[0]}"><span data-picture-value="x"></span></label><label>Focal point Y (%)<input id="pic-y" type="range" min="0" max="100" value="${position[1]||position[0]}"><span data-picture-value="y"></span></label></div>
    ${img.closest('.doc-float')?'':`<div class="field-row"><label>Frame width (px)<input id="pic-width" type="number" min="1" max="4000" value="${Math.min(4000,Math.round(width))}"></label><label>Frame height (px)<input id="pic-height" type="number" min="1" max="4000" value="${Math.min(4000,Math.round(height))}"></label></div>`}
    <div class="field-row">${['brightness','contrast','saturate','grayscale'].map(name=>`<label>${name.charAt(0).toUpperCase()+name.slice(1)} (%)<input id="pic-${name}" type="range" min="0" max="${name==='grayscale'?100:200}" value="${effect(name)}"><span data-picture-value="${name}"></span></label>`).join('')}</div>
    <label>Alternative text<input id="pic-alt" value="${escAttr(img.alt||'')}" maxlength="500" placeholder="Describe the image for people using screen readers"></label>
    <label>Replace image URL (optional)<input id="pic-url" placeholder="https://…"></label><label>Or replace with a file<input id="pic-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"></label>
    <p class="muted">Crop to fill uses the frame size and focal point. The original image is retained. Changes apply after you select Apply.</p>`,onOpen:ov=>{
      const preview=ov.querySelector('[data-picture-preview]');
      ov.addEventListener('input',()=>{const val=id=>ov.querySelector('#pic-'+id)?.value;const w=Number(val('width'))||parseFloat(getComputedStyle(img).width)||300,h=Number(val('height'))||parseFloat(getComputedStyle(img).height)||200;if(w>0&&h>0){const scale=Math.min(240/w,240/h);preview.style.width=w*scale+'px';preview.style.height=h*scale+'px';}ov.querySelectorAll('[data-picture-value]').forEach(output=>output.textContent=val(output.dataset.pictureValue)+'%');preview.style.objectFit=val('fit');preview.style.objectPosition=val('x')+'% '+val('y')+'%';preview.style.borderRadius=val('radius')+'px';preview.style.clipPath={none:'none',circle:'circle(closest-side at 50% 50%)',ellipse:'ellipse(50% 40% at 50% 50%)',diamond:'polygon(50% 0%,100% 50%,50% 100%,0% 50%)'}[val('mask')];preview.style.filter=['brightness','contrast','saturate','grayscale'].map(k=>k+'('+val(k)+'%)').join(' ');});ov.querySelector('#pic-x').dispatchEvent(new Event('input',{bubbles:true}));
    },onConfirm:async(ov,showErr)=>{
      const val=id=>ov.querySelector('#pic-'+id)?.value;
      const limits=[['radius',0,200],['x',0,100],['y',0,100],['brightness',0,200],['contrast',0,200],['saturate',0,200],['grayscale',0,100],...(ov.querySelector('#pic-width')?[['width',1,4000],['height',1,4000]]:[])];
      if(!limits.every(([id,min,max])=>Number.isFinite(Number(val(id)))&&Number(val(id))>=min&&Number(val(id))<=max)){showErr('Choose picture settings within the displayed limits');return false;}
      const url=val('url').trim(),file=ov.querySelector('#pic-file').files[0];let replacement=url;
      if(url&&!safeDocumentUrl(url,true)){showErr('Enter a valid image URL');return false;}
      if(file){if(file.size>2*1024*1024||!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)){showErr('Choose a PNG, JPEG, WebP, GIF or BMP image up to 2 MB');return false;}replacement=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
      if(!img.isConnected||img.closest('[data-doc-locked="true"]')){showErr('This picture changed or was removed. Close this dialog and select it again.');return false;}
      s.objectFit=val('fit');s.objectPosition=val('x')+'% '+val('y')+'%';s.borderRadius=val('radius')+'px';s.clipPath={none:'none',circle:'circle(closest-side at 50% 50%)',ellipse:'ellipse(50% 40% at 50% 50%)',diamond:'polygon(50% 0%,100% 50%,50% 100%,0% 50%)'}[val('mask')];s.filter=['brightness','contrast','saturate','grayscale'].map(k=>k+'('+val(k)+'%)').join(' ');
      if(ov.querySelector('#pic-width')){s.width=val('width')+'px';s.height=val('height')+'px';}
      img.alt=val('alt');if(replacement){img.src=replacement;delete img.dataset.varSrc;}onChange();
    }});
}

const SYMBOLS = ['₱', '$', '€', '£', '¥', '©', '®', '™', '°', '§', '¶', '•', '★', '✓', '✗', '½', '¼', '¾', '×', '÷', '±', '№'];

function symbolDialog(insertHtml, saveSel, modal = UI.modal) {
  saveSel();
  const m = modal({
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
      + bullet('Use <b>Edit</b> to work on the document and <b>Print preview</b> to check measured sheets. Advanced source editing is under <b>More → HTML / CSS source</b>.', SHOT_MODES)
      + bullet(`${kbd('Ctrl')}+${kbd('S')} saves. ${kbd('Ctrl')}+${kbd('Z')} / ${kbd('Ctrl')}+${kbd('Y')} undo and redo <i>everything</i> — text, tables, moved objects.`)
      + bullet('<b>Preview data</b> in the top bar opens a movable preview filled with realistic sample data.')
      + bullet('Open <b>Fields</b> on the left for template data. <b>More → Editor guide</b> opens this guide.')
      + note('Nothing on the page is “live” — variables and formulas only turn into real values when the document is printed.'),

    variables: lead('A variable is a blank the system fills in at print time — a name, a number, a date.')
      + step(1, 'Open <b>Insert</b> → <b>Field</b> — or just type <code>{{ }}</code> right on the page.')
      + step(2, "Pick a field: company name, order number, customer, today's date…")
      + step(3, 'It drops in as a blue pill. On the printed page it becomes the real value.', SHOT_VARFLOW)
      + bullet('Want your own? <b>More → Manage fields</b> — a fixed value, a bound field, or a saved formula.')
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
  const m = (opts.modal || UI.modal)({
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
function formulaDialog(insertHtml, saveSel, getVariables, initial, sampleContext, modal = UI.modal) {
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

  const m = modal({
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
          const v = ev(e, (typeof sampleContext === 'function' ? sampleContext() : sampleContext) || {});
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
function wireToolbar(panelsRoot, surface, getVariables, onChange, sampleContext, tabApi, getZoom, onUndo, onRedo, commandContext = {}) {
  const zoomNow = () => (typeof getZoom === 'function' ? Number(getZoom()) : 1) || 1;
  let savedRange = null, savedBackwards = false;
  // Caret marks are ephemeral editor state. Choosing a mark creates no saved markup/history.
  let pendingDecorations = {}, pendingScript = null, pendingClear = false;
  let pendingMarks = {}, pendingCaret = null, insertionStart = null, insertionText = null;
  const clearPending = () => { pendingDecorations={};pendingScript=null;pendingClear=false;pendingMarks = {}; pendingCaret = null; insertionStart = null; insertionText = null; };
  const setPending = (property,value) => {
    window.DocModel.validateInline(property,value);
    pendingMarks[property]=value;pendingCaret=window.getSelection().getRangeAt(0).cloneRange();
    return {pending:true};
  };
  const hasPending = () => pendingClear||pendingScript!==null||Object.keys(pendingMarks).length||Object.keys(pendingDecorations).length;
  const markCaret = () => {pendingCaret=window.getSelection().getRangeAt(0).cloneRange();return {pending:true};};
  function finishInsertion(sel){
    if(!sel.isCollapsed){
      if(pendingClear)window.DocModel.clearSelection(surface,sel);
      for(const [property,value] of Object.entries(pendingMarks))window.DocModel.formatSelection(surface,sel,property,value);
      if(pendingScript!==null)window.DocModel.formatScript(surface,sel,pendingScript);
      for(const [token,on] of Object.entries(pendingDecorations))window.DocModel.formatDecoration(surface,sel,token,on);
      sel.collapseToEnd();window.DocModel.normalizeRuns(surface,sel);
    }
    if(hasPending())pendingCaret=sel.getRangeAt(0).cloneRange();saveSel();
  }
  function editText(text='',direction=null){
    const sel=window.getSelection();if(!sel?.isCollapsed&&pendingCaret)clearPending();const result=window.DocModel.editText(surface,sel,text,direction,{});
    if(result===true){if(text)finishInsertion(sel);else{clearPending();saveSel();}}return result;
  }
  function beforeInput(e) {
    if(!window.DocModel)return;
    if(commandContext.isComposing?.()&&insertionStart)return;
    const structuralInsert=!e.isComposing&&typeof e.data==='string'&&/[\r\n]/.test(e.data);
    const sel=window.getSelection();if(!sel?.rangeCount||!surface.contains(sel.anchorNode)||!surface.contains(sel.focusNode))return;
    if(e.cancelable&&!e.isComposing&&!commandContext.isComposing?.()&&!trackingText()){saveSel();if(!editableSelection(false)){e.preventDefault();e.stopImmediatePropagation();return;}}
    if(structuralInsert){clearPending();return;}
    if(e.cancelable&&!e.isComposing&&!commandContext.isComposing?.()&&!trackingText()){
      const inserting=/^(insertText|insertReplacementText)$/.test(e.inputType)&&typeof e.data==='string',deleting=/^(deleteContentBackward|deleteContentForward|deleteByCut)$/.test(e.inputType);
      if(inserting||deleting){
        const direction=sel.isCollapsed&&deleting?(e.inputType==='deleteContentBackward'?'backward':'forward'):null;
        const result=editText(inserting?e.data:'',direction);
        if(result!==null){e.preventDefault();e.stopImmediatePropagation();if(result){insertionStart=null;onChange();reflect();}return;}
      }
    }
    if(!hasPending())return;
    if(!sel.isCollapsed){clearPending();return;}
    if(/^insert(Text|ReplacementText|CompositionText)$/.test(e.inputType)){
      if(!insertionStart)insertionStart=sel.getRangeAt(0).cloneRange();
      if(!commandContext.isComposing?.()&&typeof e.data==='string')insertionText=e.data;
    }else if(!e.isComposing){clearPending();}
  }

  function applyPending(committedText=null) {
    if(!insertionStart||commandContext.isComposing?.())return;
    const start=insertionStart;insertionStart=null;committedText ??= insertionText;insertionText=null;
    const sel=window.getSelection();if(!sel?.isCollapsed||!surface.contains(start.startContainer)||!surface.contains(sel.anchorNode)){clearPending();return;}
    const range=typeof committedText==='string'&&committedText.length?window.DocModel.rangeBeforeCaret(surface,sel,committedText.length):document.createRange();if(!range)return;
    if(committedText===null){range.setStart(start.startContainer,start.startOffset);range.setEnd(sel.anchorNode,sel.anchorOffset);}
    if(range.collapsed)return;
    sel.removeAllRanges();sel.addRange(range);
    finishInsertion(sel);
  }

  const saveSel = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && surface.contains(sel.anchorNode) && surface.contains(sel.focusNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
      savedBackwards = !sel.isCollapsed && sel.anchorNode === savedRange.endContainer && sel.anchorOffset === savedRange.endOffset;
    }
  };
  const restoreSel = () => {
    saveSel(); surface.focus(); if (!savedRange) saveSel();
    if (!savedRange || !surface.contains(savedRange.startContainer) || !surface.contains(savedRange.endContainer)) return false;
    const sel = window.getSelection();
    if (savedBackwards) sel.setBaseAndExtent(savedRange.endContainer,savedRange.endOffset,savedRange.startContainer,savedRange.startOffset);
    else { sel.removeAllRanges(); sel.addRange(savedRange); }
    return true;
  };
  const editableSelection = history => {
    if(commandContext.isComposing?.() || commandContext.isVisual?.() === false)return false;
    if(history)return true;
    if(!savedRange || !surface.contains(savedRange.commonAncestorContainer))return false;
    const el=n=>n.nodeType===3?n.parentElement:n;
    const blocked=node=>{const element=el(node);return !!element?.closest?.('[data-doc-locked="true"]') || element?.closest?.('[contenteditable]')?.getAttribute('contenteditable')==='false';};
    if(blocked(savedRange.startContainer) || blocked(savedRange.endContainer))return false;
    return savedRange.collapsed || ![...surface.querySelectorAll('[data-doc-locked="true"]')].some(n=>savedRange.intersectsNode(n));
  };
  const commands = createDocCommandRegistry({
    prepare:restoreSel,enabled:editableSelection,
    native:(cmd,val)=>{
      if(window.DocModel){
        const sel=window.getSelection();
        if((cmd==='insertText'||cmd==='delete')&&!trackingText()){const result=editText(cmd==='insertText'?String(val ?? ''):'');if(result!==null)return result;}
        if(cmd==='removeFormat'){if(sel.isCollapsed){pendingClear=true;pendingMarks=window.DocModel.defaultCharacterMarks(surface,sel);pendingDecorations={underline:false,'line-through':false};pendingScript='baseline';return markCaret();}return window.DocModel.clearSelection(surface,sel) ?? document.execCommand(cmd,false,val);}
        const script={superscript:'super',subscript:'sub'}[cmd];if(script){const active=sel.isCollapsed&&pendingScript!==null?pendingScript===script:window.DocModel.scriptActive(surface,sel,script);const value=active?'baseline':script;if(sel.isCollapsed){pendingScript=value;return markCaret();}const result=window.DocModel.formatScript(surface,sel,value);if(result!==null)return result;}
      }
      const align={justifyLeft:'left',justifyCenter:'center',justifyRight:'right',justifyFull:'justify'}[cmd];
      if(align && window.DocModel){const result=window.DocModel.alignSelection(surface,window.getSelection(),align);if(result!==null)return result;}
      const decoration={underline:'underline',strikeThrough:'line-through'}[cmd];if(decoration&&window.DocModel){const sel=window.getSelection();const active=sel.isCollapsed&&pendingDecorations[decoration]!==undefined?pendingDecorations[decoration]:window.DocModel.decorationActive(surface,sel,decoration);if(sel.isCollapsed){pendingDecorations[decoration]=!active;return markCaret();}const result=window.DocModel.formatDecoration(surface,sel,decoration,!active);if(result!==null)return result;}
      const property={bold:'font-weight',italic:'font-style',fontName:'font-family',foreColor:'color',hiliteColor:'background-color'}[cmd];
      if(property&&window.DocModel){const sel=window.getSelection();const value=cmd==='bold'?(window.DocModel.inlineActive(surface,sel,property)?'normal':'bold'):cmd==='italic'?(window.DocModel.inlineActive(surface,sel,property)?'normal':'italic'):val;const pending=sel?.isCollapsed?pendingMarks[property]:undefined;const desired=pending!==undefined&&cmd==='bold'?(pending==='bold'?'normal':'bold'):pending!==undefined&&cmd==='italic'?(pending==='italic'?'normal':'italic'):value;if(sel?.isCollapsed)return setPending(property,desired);const result=window.DocModel.formatSelection(surface,sel,property,desired);if(result!==null)return result;}
      return document.execCommand(cmd,false,val);
    },
    active:cmd=>{const align={justifyLeft:'left',justifyCenter:'center',justifyRight:'right',justifyFull:'justify'}[cmd];if(align&&window.DocModel)return window.DocModel.alignmentActive(surface,window.getSelection(),align);const decoration={underline:'underline',strikeThrough:'line-through'}[cmd];if(decoration&&window.DocModel){if(window.getSelection()?.isCollapsed&&pendingDecorations[decoration]!==undefined)return pendingDecorations[decoration];const active=window.DocModel.decorationActive(surface,window.getSelection(),decoration);if(active!==null)return active;}const script={superscript:'super',subscript:'sub'}[cmd];if(script&&window.DocModel){if(window.getSelection()?.isCollapsed&&pendingScript!==null)return pendingScript===script;const active=window.DocModel.scriptActive(surface,window.getSelection(),script);if(active!==null)return active;}const property={bold:'font-weight',italic:'font-style'}[cmd];if(property&&window.DocModel){if(window.getSelection()?.isCollapsed&&pendingMarks[property]!==undefined)return pendingMarks[property]===(cmd==='bold'?'bold':'italic');const active=window.DocModel.inlineActive(surface,window.getSelection(),property);if(active!==null)return active;}try{return document.queryCommandState(cmd);}catch{return false;}},
    size:value=>{
      const size=Number(value);if(!Number.isFinite(size)||size<1||size>400)return false;
      if(window.DocModel){if(window.getSelection()?.isCollapsed)return setPending('font-size',size+'pt');const result=window.DocModel.formatSelection(surface,window.getSelection(),'font-size',size+'pt');if(result!==null)return result;}
      if(document.execCommand('fontSize',false,'7')===false)return false;
      surface.querySelectorAll('font[size="7"]').forEach(f=>{f.removeAttribute('size');f.style.fontSize=size+'pt';});
    },
    deleteAtomic:target=>{
      if(!surface.contains(target) || !target.matches?.('.doc-chip,.doc-checkbox') || target.closest('[data-doc-locked="true"]'))return false;
      clearPending();const range=document.createRange();range.setStartBefore(target);let parent=target.parentElement;target.remove();
      while(parent?.matches('span[data-doc-run="inline"]')&&!parent.textContent&&!parent.children.length){const outer=parent.parentElement;parent.remove();parent=outer;}range.collapse(true);
      const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
    },
    undo:()=>onUndo?.(),redo:()=>onRedo?.(),canUndo:()=>commandContext.canUndo?.() ?? true,canRedo:()=>commandContext.canRedo?.() ?? true,before:()=>commandContext.before?.(),after:()=>commandContext.after?.(),
    pending:()=>{saveSel();reflect();},changed:()=>{saveSel();onChange();reflect();},error:err=>UI.toast(err.message || 'Formatting could not be applied','error'),
  });
  const exec = (cmd, val) => commands.run(commands.idForNative(cmd),val);
  const insertHtml = html => commands.run('insert.html',html);
  const editorModal = options => {saveSel();return UI.modal({...options,onClose:()=>{options.onClose?.();if(surface.isConnected)restoreSel();}});};
  const rememberSelection = () => {
    const sel=window.getSelection();
    if(pendingCaret&&!insertionStart&&!commandContext.isComposing?.()&&sel?.rangeCount&&surface.contains(sel.anchorNode)&&
      (!sel.isCollapsed||sel.anchorNode!==pendingCaret.startContainer||sel.anchorOffset!==pendingCaret.startOffset))clearPending();
    saveSel();
  };
  document.addEventListener('selectionchange',rememberSelection);
  surface.addEventListener('input',rememberSelection);
  surface.addEventListener('focusout',rememberSelection);
  panelsRoot.addEventListener('pointerdown',rememberSelection,true);
  const onFormatKey = e => {
    if(e.defaultPrevented||e.isComposing||commandContext.isComposing?.()||!(e.ctrlKey||e.metaKey)||e.altKey||e.shiftKey||!surface.contains(e.target))return;
    const id={b:'format.bold',i:'format.italic',u:'format.underline'}[e.key.toLowerCase()];
    if(id){e.preventDefault();commands.run(id);}
  };
  surface.addEventListener('keydown',onFormatKey);
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }

  ['mouseup', 'keyup'].forEach((ev) => surface.addEventListener(ev, () => { saveSel(); updateTableBar(); }));

  panelsRoot.querySelectorAll('[data-ex]').forEach((b) => {
    b.addEventListener('mousedown', (e) => { saveSel(); e.preventDefault(); });
    b.addEventListener('click', () => {
      exec(b.dataset.ex);
    });
  });
  panelsRoot.querySelectorAll('select[data-cmd]').forEach((sel) => sel.addEventListener('change', () => exec(sel.dataset.cmd, sel.value)));
  panelsRoot.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('input', () => exec(inp.dataset.color, inp.value)));

  panelsRoot.querySelector('[data-fontsize]').addEventListener('change', e => commands.run('format.size',e.target.value));

  panelsRoot.querySelector('[data-paragraph]').addEventListener('mousedown',e=>{saveSel();e.preventDefault();});
  panelsRoot.querySelector('[data-paragraph]').addEventListener('click',()=>{
    const r=savedRange;if(!r)return;const anchor=r.startContainer.nodeType===3?r.startContainer.parentElement:r.startContainer;
    const blocks=[...surface.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')].filter(el=>!el.closest('[data-doc-locked="true"]')&&(r.collapsed?el===anchor.closest('p,h1,h2,h3,h4,h5,h6,li'):r.intersectsNode(el)));
    if(!blocks.length){UI.toast('Select a paragraph first');return;}const css=getComputedStyle(blocks[0]);
    editorModal({title:'Paragraph spacing',confirmText:'Apply',bodyHTML:`<p class="muted">Apply to ${blocks.length} selected paragraph${blocks.length===1?'':'s'}.</p><div class="field-row"><label>Line spacing<select id="pg-line">${[1,1.15,1.5,2,2.5,3].map(v=>`<option value="${v}" ${Math.abs(parseFloat(css.lineHeight)/parseFloat(css.fontSize)-v)<.1?'selected':''}>${v}</option>`).join('')}</select></label><label>Before (px)<input id="pg-before" type="number" min="0" max="200" value="${parseFloat(css.marginTop)||0}"></label><label>After (px)<input id="pg-after" type="number" min="0" max="200" value="${parseFloat(css.marginBottom)||0}"></label></div><div class="field-row"><label>Left indent (px)<input id="pg-left" type="number" min="0" max="400" value="${parseFloat(css.marginLeft)||0}"></label><label>First line indent (px)<input id="pg-first" type="number" min="-200" max="200" value="${parseFloat(css.textIndent)||0}"></label></div>`,onConfirm:ov=>{
      const val=id=>Number(ov.querySelector('#pg-'+id).value);if(![['before',0,200],['after',0,200],['left',0,400],['first',-200,200]].every(([id,min,max])=>Number.isFinite(val(id))&&val(id)>=min&&val(id)<=max)){UI.toast('Enter spacing within the displayed limits','error');return false;}
      blocks.forEach(el=>{el.style.lineHeight=String(val('line'));el.style.marginTop=val('before')+'px';el.style.marginBottom=val('after')+'px';el.style.marginLeft=val('left')+'px';el.style.textIndent=val('first')+'px';});restoreSel();onChange();
    }});
  });

  // inserts
  panelsRoot.querySelector('[data-ins="link"]').addEventListener('click', () => { saveSel(); editorModal({ title: 'Insert link', bodyHTML: `<label>URL</label><input id="lnk" placeholder="https://…">`, confirmText: 'Insert', onConfirm: (ov) => { const u = ov.querySelector('#lnk').value.trim(); if (!safeDocumentUrl(u)) { UI.toast('Enter a valid web, email or telephone link', 'error'); return false; } return exec('createLink', u); } }); });
  panelsRoot.querySelector('[data-ins="hr"]').addEventListener('click', () => insertHtml('<hr>'));
  panelsRoot.querySelector('[data-ins="pagebreak"]').addEventListener('click', () => insertHtml('<div class="doc-pagebreak" style="page-break-after:always"></div><p><br></p>'));
  panelsRoot.querySelector('[data-ins="table"]').addEventListener('click', () => insertTableDialog(insertHtml, saveSel, editorModal));
  panelsRoot.querySelector('[data-ins="image"]').addEventListener('click', () => imageDialog(insertHtml, saveSel, editorModal));
  panelsRoot.querySelector('[data-ins="checkbox"]').addEventListener('click', () => insertHtml('<span class="doc-checkbox" data-checked="0">&#9744;</span>&nbsp;'));
  panelsRoot.querySelector('[data-ins="variable"]').addEventListener('click', () => variableDialog(saveSel, getVariables, (tok) => insertHtml(tokenChip(tok.replace(/^\{\{|\}\}$/g, '')) + '&nbsp;'), {modal:editorModal}));
  panelsRoot.querySelector('[data-ins="formula"]').addEventListener('click', () => formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext, editorModal));
  panelsRoot.querySelector('[data-ins="symbol"]').addEventListener('click', () => symbolDialog(insertHtml, saveSel, editorModal));
  panelsRoot.querySelector('[data-ins="textbox"]').addEventListener('click', () => insertFloat('textbox'));
  panelsRoot.querySelector('[data-ins="shape-rect"]').addEventListener('click', () => insertFloat('shape-rect'));
  panelsRoot.querySelector('[data-ins="shape-oval"]').addEventListener('click', () => insertFloat('shape-oval'));
  panelsRoot.querySelector('[data-ins="shape-line"]').addEventListener('click', () => insertFloat('shape-line'));
  panelsRoot.querySelector('[data-ins="signature"]').addEventListener('click', () =>
    insertHtml('<div style="margin-top:24px;width:220px;border-top:1px solid #333;padding-top:4px;text-align:center;font-size:11px">Signature over Printed Name</div><p><br></p>'));

  // ---- table helpers ----
  const cellOf = (node) => { let n = node; while (n && n !== surface) { if (n.nodeName === 'TD' || n.nodeName === 'TH') return n; n = n.parentNode; } return null; };
  const currentCell = () => { const c = cellOf(savedRange ? savedRange.startContainer : window.getSelection().anchorNode); return c && surface.contains(c) && !c.closest('[data-doc-locked="true"]') ? c : null; };
  function updateTableBar() {
    tabApi.setTableTabVisible(!!currentCell());
  }

  const tbl = {
    distribute() { const c=currentCell();if(!c)return;const t=c.closest('table'),m=tableGrid(t);t.style.tableLayout='fixed';t.querySelectorAll('th,td').forEach(cell=>cell.style.width=(100*(cell.colSpan||1)/m.width)+'%'); },
    properties() {
      const c=currentCell();if(!c)return;const t=c.closest('table'),css=getComputedStyle(c),row=c.parentNode;
      UI.modal({title:'Table properties',confirmText:'Apply',bodyHTML:`
        <p class="muted">Appearance applies to the whole table. Row and cell settings apply to the current selection.</p>
        <div class="field-row"><label>Table width (%)<input id="tp-width" type="number" min="10" max="100" value="${parseFloat(t.style.width)||100}"></label><label>Cell padding (px)<input id="tp-padding" type="number" min="0" max="40" value="${parseFloat(css.padding)||8}"></label></div>
        <div class="field-row"><label>Border width (px)<input id="tp-border" type="number" min="0" max="8" step="0.5" value="${parseFloat(css.borderWidth)||0}"></label><label>Border style<select id="tp-style">${['solid','dashed','dotted','none'].map(v=>`<option ${css.borderStyle===v?'selected':''}>${v}</option>`).join('')}</select></label><label>Border color<input id="tp-color" type="color" value="${(()=>{const rgb=css.borderColor.match(/\d+/g);return rgb&&rgb.length>=3?'#'+rgb.slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):'#cbd5e1';})()}"></label></div>
        <div class="field-row"><label>Table alignment<select id="tp-align"><option value="left">Left</option><option value="center" ${t.style.marginLeft==='auto'&&t.style.marginRight==='auto'?'selected':''}>Center</option><option value="right" ${t.style.marginLeft==='auto'&&t.style.marginRight!=='auto'?'selected':''}>Right</option></select></label><label>Cell vertical alignment<select id="tp-valign">${['top','middle','bottom'].map(v=>`<option ${css.verticalAlign===v?'selected':''}>${v}</option>`).join('')}</select></label></div>
        <div class="field-row"><label>Row minimum height (px)<input id="tp-height" type="number" min="0" max="500" value="${parseFloat(row.style.height)||0}"></label><label>Column layout<select id="tp-layout"><option value="auto">Auto fit content</option><option value="fixed" ${t.style.tableLayout==='fixed'?'selected':''}>Fixed widths</option></select></label></div>
        <label><input id="tp-header" type="checkbox" ${t.tHead?'checked':''}> First row is a header (repeats on paginated output)</label>
        <label><input id="tp-keep" type="checkbox" ${row.style.breakInside==='avoid'?'checked':''}> Keep this row together when printing</label>`,onConfirm:ov=>{
          const num=id=>Number(ov.querySelector('#tp-'+id).value),val=id=>ov.querySelector('#tp-'+id).value;
          if(![[num('width'),10,100],[num('padding'),0,40],[num('border'),0,8],[num('height'),0,500]].every(([v,min,max])=>Number.isFinite(v)&&v>=min&&v<=max)){UI.toast('Enter values within the displayed limits','error');return false;}
          t.style.width=num('width')+'%';t.style.tableLayout=val('layout');t.style.borderCollapse='collapse';const a=val('align');t.style.marginLeft=a==='left'?'0':'auto';t.style.marginRight=a==='right'?'0':'auto';
          t.querySelectorAll('td,th').forEach(cell=>{cell.style.padding=num('padding')+'px';cell.style.border=`${num('border')}px ${val('style')} ${val('color')}`;});
          c.style.verticalAlign=val('valign');row.style.height=num('height')?num('height')+'px':'';row.style.breakInside=ov.querySelector('#tp-keep').checked?'avoid':'';
          const header=ov.querySelector('#tp-header').checked;
          if(header&&!t.tHead){const first=t.rows[0];if(first)t.createTHead().append(first);}
          else if(!header&&t.tHead){const body=t.tBodies[0]||t.createTBody();[...t.tHead.rows].reverse().forEach(r=>body.prepend(r));t.tHead.remove();}
          if(header&&t.tHead)t.tHead.querySelectorAll('td').forEach(cell=>{const th=document.createElement('th');for(const a of cell.attributes)th.setAttribute(a.name,a.value);th.innerHTML=cell.innerHTML;cell.replaceWith(th);});
          if(!header)t.querySelectorAll('th').forEach(cell=>{const td=document.createElement('td');for(const a of cell.attributes)td.setAttribute(a.name,a.value);td.innerHTML=cell.innerHTML;cell.replaceWith(td);});
          onChange();
        }});
    },
    addRow() { const c = currentCell(); if (c) editTableRow(c); },
    delRow() { const c = currentCell(); if (c) editTableRow(c, true); },
    addCol() { const c = currentCell(); if (c) editTableColumn(c); },
    delCol() { const c = currentCell(); if (c) editTableColumn(c, true); },
    mergeRight() { const c = currentCell(); if (!c) return; const m = tableGrid(c.closest('table')), p = m.positions.get(c); const next = m.grid[p.r]?.[p.c + p.w]; if (next && !mergeTableCells([c, next])) UI.toast('Select a complete rectangle to merge', 'error'); },
    mergeDown() { const c = currentCell(); if (!c) return; const m = tableGrid(c.closest('table')), p = m.positions.get(c); const next = m.grid[p.r + p.h]?.[p.c]; if (next && !mergeTableCells([c, next])) UI.toast('Select a complete rectangle to merge', 'error'); },
    split() { const c = currentCell(); if (c) splitTableCell(c); },
    width() { const c = currentCell(); if (!c) return; const cur = parseInt(c.style.width) || ''; UI.modal({ title: 'Column width', bodyHTML: `<label>Width in pixels (blank = auto)</label><input id="cw" type="number" min="24" value="${cur}" placeholder="e.g. 120">`, confirmText: 'Apply', onConfirm: (ov) => { const w = ov.querySelector('#cw').value; if (w && (!Number.isFinite(Number(w)) || Number(w) < 24)) { UI.toast('Width must be at least 24 pixels', 'error'); return false; } const m = tableGrid(c.closest('table')), p = m.positions.get(c); new Set(m.grid.map((row) => row[p.c]).filter(Boolean)).forEach((cell) => { cell.style.width = w ? Number(w) + 'px' : ''; }); onChange(); } }); },
    repeat() { const c = currentCell(); if (!c) return; const tr = c.parentNode; if (tr.hasAttribute('data-repeat')) { tr.removeAttribute('data-repeat'); tr.classList.remove('is-repeat'); UI.toast('Row no longer repeats'); } else { tr.setAttribute('data-repeat', 'items'); tr.classList.add('is-repeat'); UI.toast('This row will repeat for every line item when printed'); } },
    fxcell() { const c = currentCell(); if (!c) return; formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext, editorModal); },
    delTable() { const c = currentCell(); if (!c) return; const t = c.closest('table'); UI.confirmDialog('Delete this whole table?', 'Delete').then((ok) => { if (ok) { t.remove(); updateTableBar(); onChange(); } }); },
  };
  panelsRoot.querySelectorAll('[data-tbl]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { const fn = tbl[b.dataset.tbl]; if (fn) { fn(); if (b.dataset.tbl !== 'delTable' && b.dataset.tbl !== 'width' && b.dataset.tbl !== 'properties') onChange(); } });
  });
  panelsRoot.querySelector('[data-cellbg]').addEventListener('input', (e) => { const c = currentCell(); if (c) { c.style.background = e.target.value; onChange(); } });
  panelsRoot.querySelector('[data-tblstyle]').addEventListener('change', (e) => { const c = currentCell(); if (c) { c.closest('table').className = e.target.value; onChange(); } });

  // checkbox toggle
  surface.addEventListener('click', (e) => { const box = e.target.closest('.doc-checkbox'); if (!box || box.closest('[data-doc-locked="true"]')) return; const on = box.getAttribute('data-checked') === '1'; box.setAttribute('data-checked', on ? '0' : '1'); box.innerHTML = on ? '&#9744;' : '&#9745;'; onChange(); });

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
    const m = tableGrid(table), ap = m.positions.get(a), bp = m.positions.get(b);
    let r1 = Math.min(ap.r, bp.r), r2 = Math.max(ap.r + ap.h, bp.r + bp.h);
    let c1 = Math.min(ap.c, bp.c), c2 = Math.max(ap.c + ap.w, bp.c + bp.w);
    // Grow the rectangle to include every span it intersects.
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) {
        const p = m.positions.get(m.grid[r]?.[c]); if (!p) continue;
        const bounds = [Math.min(r1, p.r), Math.max(r2, p.r + p.h), Math.min(c1, p.c), Math.max(c2, p.c + p.w)];
        if (bounds[0] !== r1 || bounds[1] !== r2 || bounds[2] !== c1 || bounds[3] !== c2) changed = true;
        [r1, r2, c1, c2] = bounds;
      }
    }
    for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) m.grid[r]?.[c]?.classList.add('cell-sel');
  }
  function mergeSelection() {
    const cells = selectedCells();
    if (cells.length < 2) { tbl.mergeRight(); return; }
    if (!mergeTableCells(cells)) { UI.toast('Select a complete rectangle within one table section', 'error'); return; }
    clearCellSel(); onChange();
  }
  function splitCells() {
    const cells = selectedCells().length ? selectedCells() : (currentCell() ? [currentCell()] : []);
    cells.forEach(splitTableCell);
    clearCellSel(); onChange();
  }

  let selAnchor = null, selecting = false, resizeIdx = null, resizeCells = null, resizeX0 = 0, resizeW0 = 0;
  surface.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-doc-locked="true"]')) return;
    const cell = e.target.closest('td,th');
    if (!cell || !surface.contains(cell)) { clearCellSel(); return; }
    const rect = cell.getBoundingClientRect();
    if (rect.right - e.clientX <= 6) { // column-resize handle
      e.preventDefault();
      const m = tableGrid(cell.closest('table'));
      resizeIdx = m.positions.get(cell).c; resizeX0 = e.clientX; resizeW0 = rect.width;
      resizeCells = [...new Set(m.grid.map((r) => r[resizeIdx]).filter(Boolean))];
      return;
    }
    clearCellSel(); selAnchor = cell; selecting = true;
  });
  surface.addEventListener('mousemove', (e) => {
    if (resizeIdx !== null && resizeCells) { const w = Math.max(24, resizeW0 + (e.clientX - resizeX0)); resizeCells.forEach((c) => { c.style.width = w + 'px'; }); return; }
    if (!selecting) { const cell = e.target.closest('td,th'); surface.style.cursor = cell && (cell.getBoundingClientRect().right - e.clientX <= 6) ? 'col-resize' : ''; return; }
    if (e.buttons === 1 && selAnchor) { const cell = e.target.closest('td,th'); if (cell && cell !== selAnchor && tableOf(cell) === tableOf(selAnchor)) { e.preventDefault(); const s = window.getSelection(); if (s) s.removeAllRanges(); markRect(selAnchor, cell); } }
  });
  const endTableDrag = () => { if (resizeIdx !== null) { resizeIdx = null; resizeCells = null; onChange(); } selecting = false; };
  document.addEventListener('mouseup', endTableDrag);

  // right-click a cell → design menu (multi-cell when a range is selected)
  surface.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td,th');
    if (!cell || !surface.contains(cell) || cell.closest('[data-doc-locked="true"]')) return;
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
  const updateAC = (event) => {
    if (event?.isComposing) return closeAC();
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
    closeAC();
    acRange = { node, start: range.startOffset - m[0].length, end: range.startOffset };
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
    if (c && c.textContent.trim() === '') { e.preventDefault(); saveSel(); formulaDialog(insertHtml, saveSel, getVariables, '', sampleContext, editorModal); }
  });

  // drag-drop + paste images
  const embed = (file) => { const fr = new FileReader(); fr.onload = () => insertHtml(`<img src="${escAttr(fr.result)}" alt="${escAttr(file.name || '')}">`); fr.readAsDataURL(file); };
  surface.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
  surface.addEventListener('drop', (e) => { const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => /^image\//.test(f.type)); if (files.length) { e.preventDefault(); saveSel(); files.forEach(embed); } });
  const trackingText = () => {try{return !!JSON.parse(surface.querySelector('[data-doc-config]')?.dataset.docConfig || '{}').trackChanges;}catch{return false;}};
  const clipboardSelection = () => {
    const sel=window.getSelection();
    if(!sel?.rangeCount || sel.isCollapsed || !surface.contains(sel.anchorNode) || !surface.contains(sel.focusNode))return null;
    const box=document.createElement('div');box.append(sel.getRangeAt(0).cloneContents());
    const html=serializeEditor(box);box.innerHTML=html;
    box.querySelectorAll('br').forEach(el=>el.replaceWith(document.createTextNode('\n')));
    box.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach(el=>el.append(document.createTextNode('\n')));
    box.querySelectorAll('td,th').forEach(el=>el.append(document.createTextNode('\t')));
    return {html,text:(box.textContent || '').replace(/[\t\n]+$/,'')};
  };
  surface.addEventListener('copy', e => {
    const value=clipboardSelection();if(!value || !e.clipboardData)return;
    e.clipboardData.setData('text/html',value.html);e.clipboardData.setData('text/plain',value.text);e.preventDefault();
  });
  surface.addEventListener('cut', e => {
    saveSel();const value=clipboardSelection();if(!value || !e.clipboardData)return;
    if(!commands.state('edit.deleteSelection').enabled){e.preventDefault();return;}
    if(trackingText())return; // review's beforeinput handler owns tracked deletion
    e.clipboardData.setData('text/html',value.html);e.clipboardData.setData('text/plain',value.text);e.preventDefault();
    commands.run('edit.deleteSelection');
  });
  surface.addEventListener('paste', e => {
    const cd=e.clipboardData;if(!cd || e.defaultPrevented)return;
    const img=[...(cd.items || [])].find(i=>/^image\//.test(i.type));
    if(img){e.preventDefault();saveSel();embed(img.getAsFile());return;}
    const html=cd.getData('text/html'),text=cd.getData('text/plain');
    if(html || text){e.preventDefault();saveSel();
      if(html)insertHtml(bodyToEditorHtml(sanitizeHtml(html,document)));
      else if(/\{\{[^}]+\}\}/.test(text))insertHtml(bodyToEditorHtml(escAttr(text).replace(/\r?\n/g,'<br>')));
      else commands.run('insert.text',text);
    }
  });
  // Tab in lists changes level; Tab in tables traverses physical cells once, including spans.
  surface.addEventListener('keydown', e => {
    if(e.defaultPrevented || e.isComposing || commandContext.isComposing?.() || e.ctrlKey || e.metaKey || e.altKey)return;
    const sel=window.getSelection();if(!sel?.rangeCount || !sel.isCollapsed || !surface.contains(sel.anchorNode))return;
    const node=sel.anchorNode.nodeType===3?sel.anchorNode.parentElement:sel.anchorNode;
    if(e.key==='Tab'){
      saveSel();if(!editableSelection(false)){e.preventDefault();return;}
      const cell=node.closest?.('td,th');
      if(cell){
        const table=cell.closest('table'),cells=[...table.rows].filter(row=>row.closest('table')===table).flatMap(row=>[...row.cells]).filter(c=>!c.closest('[data-doc-locked="true"]'));
        let target=cells[cells.indexOf(cell)+(e.shiftKey?-1:1)],inserted=false;
        if(!target && !e.shiftKey){
          if(trackingText()){e.preventDefault();UI.toast('Turn tracking off to add a table row','error');return;}
          commandContext.before?.();
          if(cell.parentElement.parentElement.tagName==='THEAD'){
            const row=(table.tBodies[0] || table.createTBody()).insertRow();
            for(let i=0;i<tableGrid(table).width;i++)row.append(blankTableCell(row,'td'));
            target=row.cells[0];
          }else {editTableRow(cell);target=cell.parentElement.nextElementSibling?.cells[0];}
          inserted=true;
        }
        if(target){e.preventDefault();const range=document.createRange();range.selectNodeContents(target);range.collapse(true);sel.removeAllRanges();sel.addRange(range);saveSel();updateTableBar();if(inserted){onChange();commandContext.after?.();}}
        return;
      }
      if(node.closest?.('li')){e.preventDefault();if(trackingText()){UI.toast('Turn tracking off to change list structure','error');return;}commands.run(e.shiftKey?'paragraph.outdent':'paragraph.indent');}
      return;
    }
    if(!['ArrowLeft','ArrowRight','Backspace','Delete'].includes(e.key))return;
    const range=sel.getRangeAt(0),back=e.key==='ArrowLeft'||e.key==='Backspace';
    let container=range.startContainer,offset=range.startOffset,adjacent;
    if(container.nodeType===3){if(back?offset!==0:offset!==container.length)return;adjacent=back?container.previousSibling:container.nextSibling;}
    else adjacent=container.childNodes[offset+(back?-1:0)];
    while(adjacent?.nodeType===3 && !adjacent.textContent)adjacent=back?adjacent.previousSibling:adjacent.nextSibling;
    while(adjacent?.matches?.('span[data-doc-run="inline"]')){adjacent=back?adjacent.lastChild:adjacent.firstChild;while(adjacent?.nodeType===3&&!adjacent.textContent)adjacent=back?adjacent.previousSibling:adjacent.nextSibling;}
    if(!adjacent?.matches?.('.doc-chip,.doc-checkbox'))return;
    e.preventDefault();
    if(e.key.startsWith('Arrow')){commandContext.before?.();if(back)range.setStartBefore(adjacent);else range.setStartAfter(adjacent);range.collapse(true);sel.removeAllRanges();sel.addRange(range);saveSel();return;}
    if(trackingText()){UI.toast('Turn tracking off to remove a field token','error');return;}
    saveSel();commands.run('edit.deleteAtomic',adjacent);
  });
  surface.addEventListener('input', onChange);

  // Toolbar and keyboard share command enabled/active state.
  const reflect = () => {
    if (!surface.isConnected) return;
    saveSel();
    const sel=window.getSelection();
    if(sel?.rangeCount&&surface.contains(sel.anchorNode)&&window.DocModel){
      const font=panelsRoot.querySelector('[data-cmd="fontName"]'),size=panelsRoot.querySelector('[data-fontsize]'),style=panelsRoot.querySelector('[data-cmd="formatBlock"]');
      const read=(property)=>sel.isCollapsed&&pendingMarks[property]!==undefined?pendingMarks[property]:window.DocModel.inlineValue(surface,sel,property);
      const set=(control,value,label=value)=>{if(document.activeElement===control)return;control.querySelectorAll('[data-current-value]').forEach(option=>option.remove());if(![...control.options].some(option=>option.value===value)){const option=document.createElement('option');option.dataset.currentValue='';option.value=value;option.textContent=label||'Mixed';control.append(option);}control.value=value;};
      const family=read('font-family');set(font,family===null?'':String(family||'').split(',')[0].trim().replace(/^['"]|['"]$/g,''));
      const pt=read('font-size');set(size,pt===null?'':String(pt||'').replace('pt',''));
      set(style,window.DocModel.inlineValue(surface,sel,'paragraph-style') || '');
    }
    panelsRoot.querySelectorAll('[data-ex]').forEach(b=>{
      const id=commands.idForNative(b.dataset.ex);if(id?.startsWith('edit.'))return;
      const state=commands.state(id);b.disabled=!state.enabled;
      b.classList.toggle('active',state.active);b.setAttribute('aria-pressed',String(state.active));
    });
    panelsRoot.querySelectorAll('[data-cmd],[data-color],[data-fontsize]').forEach(control=>{control.disabled=!commands.state(control.hasAttribute('data-fontsize')?'format.size':commands.idForNative(control.dataset.cmd||control.dataset.color)).enabled;});
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
    designFrame(selectedFloat).appendChild(g);
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
      if (f === exclude || designFrame(f)!==designFrame(exclude)) return;
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
    let html = `<button type="button" data-float-move title="Drag to move object" style="cursor:grab;touch-action:none">Move</button><button type="button" data-float-act="z-up" title="Bring forward">Forward</button>`
      + `<button type="button" data-float-act="z-down" title="Send backward (past the text)">Backward</button>`;
    if (kind === 'image' || kind === 'table' || kind === 'text') html += `<button type="button" data-float-act="inline" title="Put back in the text (stop floating)">↩</button>`;
    if (kind.startsWith('shape-')) html += `<button type="button" data-float-act="fill" title="Fill color">Fill</button><button type="button" data-float-act="border" title="Border color">Stroke</button>`;
    html += `<button type="button" data-float-act="delete" title="Delete">${docIcon('trash')}</button>`;
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

  function designFrame(el) { return el?.closest?.('[data-doc-design-page]') || surface; }
  function insertionFrame() { const n=window.getSelection()?.anchorNode;return designFrame(n?.nodeType===3?n.parentElement:n); }
  function insertFloat(kind) {
    const def = FLOAT_DEFAULTS[kind];
    if (!def) return;
    const n = floatSeq++;
    const left = 8 + (n % 6) * 4, top = 8 + (n % 6) * 4;
    const el = document.createElement('div');
    el.className = 'doc-float';
    el.setAttribute('data-float-kind', kind);
    el.style.touchAction = 'none';
    el.setAttribute('contenteditable', 'false');
    el.style.cssText = `position:absolute;left:${left}%;top:${top}%;width:${def.w}%;height:${def.h}%;z-index:1`;
    el.innerHTML = def.html;
    insertionFrame().appendChild(el);
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
    const pageRect = designFrame(target).getBoundingClientRect();
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
    const pageRect = designFrame(target).getBoundingClientRect();
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
      if (selectedFloat?.closest('[data-doc-locked="true"]')) return;
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

    const floatEl = e.target.closest('[data-float-kind="group"]') || e.target.closest('.doc-float');
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
    if (e.button !== 0 || e.target.closest('[data-doc-locked="true"]')) return;
    const handle = e.target.closest('.doc-float-handle');
    if (handle && selectedFloat) {
      e.preventDefault(); e.stopPropagation();
      const pageRect = designFrame(selectedFloat).getBoundingClientRect();
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
    const floatEl = e.target.closest('[data-float-kind="group"]') || e.target.closest('.doc-float');
    if (!floatEl) return;
    // Shapes/images have no editable interior, so any press starts a drag. Text boxes / promoted
    // tables / promoted blocks have an editable island — a press there must NOT start a drag.
    const editableRoot = islandOf(floatEl);
    const onToolbar = !!e.target.closest('.doc-float-toolbar');
    const onIsland = !!(editableRoot && (e.target === editableRoot || editableRoot.contains(e.target)));
    if (onToolbar && !e.target.closest('[data-float-move]')) return;
    if (onIsland) {
      // One press can place a caret. Moving uses the explicit toolbar grip.
      if (!e.shiftKey && selectedFloat !== floatEl && !(multiSet.size >= 2 && multiSet.has(floatEl))) {
        clearMulti(); selectFloat(floatEl);
      }
      return;
    }
    if (e.shiftKey) return;
    // Pressing the Move grip or the non-editable wrapper starts a move.
    e.preventDefault();

    floatEl.classList.remove('editing');
    const groupMove = multiSet.size >= 2 && multiSet.has(floatEl) && [...multiSet].every(f=>designFrame(f)===designFrame(floatEl));
    if (!groupMove && selectedFloat !== floatEl) { clearMulti(); selectFloat(floatEl); }
    const pageRect = designFrame(floatEl).getBoundingClientRect();
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
    if (e.target.closest?.('input,textarea,select,.modal-overlay,.doc-studio-side')) return;
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
    if (e.target.closest?.('input,textarea,select,.modal-overlay,.doc-studio-side') || e.defaultPrevented) return;
    if (selectedFloat?.closest('[data-doc-locked="true"]')) return;
    if (selectedFloat && !selectedFloat.classList.contains('editing') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
      e.preventDefault(); const step = e.shiftKey ? 1 : 0.1;
      const moving = multiSet.size ? [...multiSet] : [selectedFloat];
      moving.filter(f=>!f.closest('[data-doc-locked="true"]')).forEach(f=>{
        const prop = /Left|Right/.test(e.key) ? 'left' : 'top';
        const value = parseFloat(f.style[prop]) || 0;
        f.style[prop] = (value + (/Left|Up/.test(e.key) ? -step : step)) + '%';
      }); onChange(); return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const active = document.activeElement;
    const typingInside = (f) => active && f.contains(active) && active !== f; // caret is in an editable island
    if (multiSet.size) {
      if ([...multiSet].some(typingInside)) return;
      e.preventDefault();
      multiSet.forEach((f) => { if (!f.closest('[data-doc-locked="true"]')) f.remove(); });
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
      if (kind === 'textbox') { const body = el.querySelector(':scope > .doc-float-body'); if (body) body.setAttribute('contenteditable', el.closest('[data-doc-locked="true"]') ? 'false' : 'true'); }
      else if (kind === 'table' || kind === 'text') { const inner = el.firstElementChild; if (inner) inner.setAttribute('contenteditable', el.closest('[data-doc-locked="true"]') ? 'false' : 'true'); }
    });
  }

  updateTableBar();
  return {
    teardown() {
      document.removeEventListener('mouseup', endTableDrag);
      closeAC();
      document.removeEventListener('selectionchange', reflect);
      document.removeEventListener('selectionchange', rememberSelection);
      document.removeEventListener('selectionchange', updateEditing);
      document.removeEventListener('pointermove', onFloatPointerMove);
      document.removeEventListener('pointerup', endFloatDrag);
      document.removeEventListener('pointercancel', endFloatDrag);
      document.removeEventListener('keydown', onFloatKeydown);
      clearSnapGuides();
    },
    commands, normalizeFloats, selectFloat, insertHtml, beforeInput, applyPending, clearPending,
    blurFloats, // drop any float selection / promote bar (used for click-outside + Escape)
  };
}

/* Studio tools keep application state out of saved document markup. */
/* Structured tools use HTML metadata so saves, drafts, copies and shared history agree. */
const DocAdvanced = (() => {
    const defaults = { normal: { name: 'Normal', tag: 'p', font: 'Arial', size: 13, color: '#111111', line: 1.55, after: 12 }, title: { name: 'Title', tag: 'h1', font: 'Arial', size: 32, color: '#16243d', line: 1.2, after: 20 }, heading1: { name: 'Heading 1', tag: 'h1', font: 'Arial', size: 24, color: '#16243d', line: 1.25, after: 14 }, heading2: { name: 'Heading 2', tag: 'h2', font: 'Arial', size: 20, color: '#16243d', line: 1.3, after: 12 }, heading3: { name: 'Heading 3', tag: 'h3', font: 'Arial', size: 16, color: '#16243d', line: 1.35, after: 10 }, caption: { name: 'Caption', tag: 'p', font: 'Arial', size: 11, color: '#666666', line: 1.4, after: 8 } };
    function settings(root, create = false) { let node = root.querySelector('[data-doc-settings]'); if (!node && create) {
        node = root.ownerDocument.createElement('div');
        node.dataset.docSettings = 'true';
        node.hidden = true;
        node.style.display = 'none';
        node.contentEditable = 'false';
        root.prepend(node);
    } let value = {}; try {
        value = JSON.parse(node?.dataset.docConfig || '{}');
    }
    catch { } return { node, value }; }
    function write(root, value) { const { node } = settings(root, true); node.dataset.docConfig = JSON.stringify(value); }
    function uid(prefix) { return prefix + ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().replaceAll('-', '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); }
    function multipage(root) { return root.querySelectorAll('[data-doc-design-page]').length > 1 || !!root.querySelector('.doc-pagebreak,[data-doc-section][data-doc-section-break="page"]'); }
    function refresh(root) {
        const config = settings(root).value, styles = { ...defaults, ...config.styles };
        root.querySelectorAll('del[data-doc-change]').forEach(el => el.contentEditable = 'false');
        root.querySelectorAll('[data-doc-style]').forEach(el => { const s = styles[el.dataset.docStyle]; if (!s || el.closest('[data-doc-locked="true"]'))
            return; const version = JSON.stringify(s); if (el.dataset.docStyleVersion === version)
            return; el.dataset.docStyleVersion = version; Object.assign(el.style, { fontFamily: s.font, fontSize: s.size + 'px', color: s.color, lineHeight: String(s.line), marginBottom: s.after + 'px' }); });
        const notes = [...root.querySelectorAll('[data-doc-footnote]')], refs = [...root.querySelectorAll('[data-doc-note-ref]')];
        refs.forEach((ref, i) => { const note = notes.find(n => n.dataset.docFootnote === ref.dataset.docNoteRef); if (!note)
            return; ref.textContent = String(i + 1); ref.id = 'doc-note-ref-' + ref.dataset.docNoteRef; ref.href = '#doc-note-' + ref.dataset.docNoteRef; const label = note.querySelector('[data-doc-note-number]'); if (label)
            {label.textContent = String(i + 1) + '. ';label.href='#doc-note-ref-'+ref.dataset.docNoteRef;} note.id = 'doc-note-' + ref.dataset.docNoteRef; });
        root.querySelectorAll('[data-doc-notes]').forEach(list => [...list.children].sort((a, b) => refs.findIndex(r => r.dataset.docNoteRef === a.dataset.docFootnote) - refs.findIndex(r => r.dataset.docNoteRef === b.dataset.docFootnote)).forEach(n => list.append(n)));
        root.querySelectorAll('[data-doc-design-page]').forEach((page, i) => { page.setAttribute('aria-label', page.dataset.docPageName || 'Design page ' + (i + 1)); page.style.position = 'relative'; page.style.isolation = 'isolate'; page.style.breakAfter = i < root.querySelectorAll('[data-doc-design-page]').length - 1 ? 'page' : 'auto'; });
    }
    function finishReview(root, accept, id) { root.querySelectorAll('[data-doc-change]').forEach(el => { if (id && el.dataset.docChange !== id)
        return; const remove = (el.tagName === 'DEL') === accept; if (remove)
        el.remove();
    else
        el.replaceWith(...el.childNodes); }); refresh(root); }
    function mount(fs, root, opts, api, getTarget, restoreRange) {
        let activePage = null;
        const esc = UI.esc;
        const changed = () => { refresh(root); api.normalize(); api.change(); api.layout(); };
        const pages = () => [...root.querySelectorAll('[data-doc-design-page]')];
        function page() { return pages().find(p => p.dataset.docDesignPage === activePage) || getTarget()?.closest('[data-doc-design-page]') || pages()[0]; }
        function activatePage(p) { if (!p)
            return; activePage = p.dataset.docDesignPage; root.focus(); const r = document.createRange(); r.selectNodeContents(p.querySelector('p,h1,h2,h3,h4,h5,h6') || p); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        function onPageClick(e) { const p = e.target.closest('[data-doc-design-page]'); if (p)
            activePage = p.dataset.docDesignPage; }
        root.addEventListener('click', onPageClick);
        function cleanClone(el) { const clone = el.cloneNode(true); clone.querySelectorAll('.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide,.doc-page-guide').forEach(n => n.remove()); clone.querySelectorAll('[data-doc-node]').forEach(n => n.removeAttribute('data-doc-node')); clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id')); const walker = root.ownerDocument.createTreeWalker(clone, 128), remove = []; let n; while ((n = walker.nextNode()))
            if (n.data.startsWith('doc-sync:'))
                remove.push(n); remove.forEach(n => n.remove()); return clone; }
        function newPage() { const p = root.ownerDocument.createElement('div'); p.dataset.docDesignPage = uid('p'); p.dataset.docPageName = 'Page ' + (pages().length + 1); p.style.backgroundColor = '#ffffff'; p.style.height = Math.max(20, parsePageStyle(api.snapshot().body).heightMm - 2 * parsePageStyle(api.snapshot().body).marginMm) + 'mm'; p.innerHTML = '<p><br></p>'; return p; }
        function ensurePages() { if (pages().length)
            return; const p = newPage(); p.replaceChildren(); [...root.childNodes].filter(n => !(n.nodeType === 1 && n.matches('[data-doc-settings],.doc-page-guide'))).forEach(n => p.append(n)); root.append(p); activePage = p.dataset.docDesignPage; }
        function selectedBlock() { const el = getTarget(); return el?.closest('p,h1,h2,h3,h4,h5,h6,li,figcaption') || null; }
        function section() { return getTarget()?.closest('[data-doc-section]') || null; }
        function applyStyle(key) { let block = selectedBlock(); if (!block || block.closest('[data-doc-locked="true"]')) {
            UI.toast('Select a text paragraph first', 'error');
            return;
        } const cfg = settings(root).value; cfg.styles = { ...defaults, ...cfg.styles }; write(root, cfg); const s = cfg.styles[key]; if (block.tagName.toLowerCase() !== s.tag) {
            const next = document.createElement(s.tag);
            [...block.attributes].forEach(a => next.setAttribute(a.name, a.value));
            next.append(...block.childNodes);
            block.replaceWith(next);
            block = next;
        } block.dataset.docStyle = key; changed(); }
        function styleDialog(key) { const config = settings(root).value, s = { ...defaults, ...config.styles }[key]; UI.modal({ title: 'Edit ' + s.name + ' style', bodyHTML: `<label>Font<select id="ds-font">${FONTS.map(f => `<option ${s.font === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label><div class="field-row"><label>Size (px)<input id="ds-size" type="number" min="6" max="200" value="${s.size}"></label><label>Color<input id="ds-color" type="color" value="${s.color}"></label></div><div class="field-row"><label>Line height<input id="ds-line" type="number" min="0.8" max="4" step="0.05" value="${s.line}"></label><label>Space after (px)<input id="ds-after" type="number" min="0" max="200" value="${s.after}"></label></div><p class="muted">Updates every paragraph using this named style in this document.</p>`, confirmText: 'Update style', onConfirm: ov => { const num = id => Number(ov.querySelector('#ds-' + id).value), size = num('size'), line = num('line'), after = num('after'); if (!Number.isFinite(size + line + after) || size < 6 || size > 200 || line < .8 || line > 4 || after < 0 || after > 200)
                return false; config.styles = { ...config.styles, [key]: { ...s, font: ov.querySelector('#ds-font').value, size, line, after, color: ov.querySelector('#ds-color').value } }; write(root, config); changed(); } }); }
        function sectionDialog() { const existing = section(); UI.modal({ title: existing ? 'Section settings' : 'Insert section', bodyHTML: `<label>Section name<input id="sec-name" maxlength="100" value="${esc(existing?.dataset.docSectionName || 'Section')}"></label><div class="field-row"><label>Columns<select id="sec-cols">${[1, 2, 3].map(n => `<option ${Number(existing?.style.columnCount || 1) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>Column gap (mm)<input id="sec-gap" type="number" min="0" max="30" value="${parseFloat(existing?.style.columnGap) || 8}"></label></div><label>Start<select id="sec-break"><option value="continuous">Continue on current page</option><option value="page" ${existing?.dataset.docSectionBreak === 'page' ? 'selected' : ''}>New page</option></select></label><div class="field-row"><label>Page width (mm)<input id="sec-w" type="number" min="50" max="1000" value="${existing?.dataset.docSectionWidth || parsePageStyle(api.snapshot().body).widthMm}"></label><label>Page height (mm)<input id="sec-h" type="number" min="50" max="1000" value="${existing?.dataset.docSectionHeight || parsePageStyle(api.snapshot().body).heightMm}"></label></div><label>Margin (mm)<input id="sec-m" type="number" min="0" max="100" value="${existing?.dataset.docSectionMargin ?? parsePageStyle(api.snapshot().body).marginMm}"></label><label>Background<input id="sec-bg" type="color" value="${existing?.dataset.docSectionBg || '#ffffff'}"></label><p class="muted">Columns flow together. A new-page section disables print grids.</p>`, confirmText: existing ? 'Apply' : 'Insert', onConfirm: ov => { const gap = Number(ov.querySelector('#sec-gap').value), w = Number(ov.querySelector('#sec-w').value), h = Number(ov.querySelector('#sec-h').value), m = Number(ov.querySelector('#sec-m').value); if (!Number.isFinite(gap + w + h + m) || gap < 0 || gap > 30 || w < 50 || w > 1000 || h < 50 || h > 1000 || m < 0 || m > 100 || m * 2 >= Math.min(w, h))
                return false; let el = existing; if (!el) {
                restoreRange();
                const sel = getSelection(), r = sel?.rangeCount ? sel.getRangeAt(0) : null;
                el = document.createElement('div');
                el.dataset.docSection = uid('s');
                const start = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
                const first = start?.closest?.('p,h1,h2,h3,h4,h5,h6,li,table,blockquote');
                if (first && !first.closest('[data-doc-locked="true"]')) {
                    const siblings = [...first.parentNode.children].filter(n => n === first || r && !r.collapsed && r.intersectsNode(n));
                    if (siblings.some(n => n.matches('[data-doc-settings],[data-doc-design-page],[data-doc-section]') || n.closest('[data-doc-locked="true"]'))) {
                        UI.toast('Select unlocked paragraphs within one page', 'error');
                        return false;
                    }
                    first.before(el);
                    siblings.forEach(n => el.append(n));
                }
                else {
                    el.innerHTML = '<p>Section content</p>';
                    const block = selectedBlock();
                    if (block)
                        block.after(el);
                    else
                        (page() || root).append(el);
                }
            } el.dataset.docSectionName = ov.querySelector('#sec-name').value || 'Section'; el.dataset.docSectionBreak = ov.querySelector('#sec-break').value; el.dataset.docSectionWidth = w; el.dataset.docSectionHeight = h; el.dataset.docSectionMargin = m; el.dataset.docSectionBg = ov.querySelector('#sec-bg').value; el.style.columnCount = ov.querySelector('#sec-cols').value; el.style.columnGap = gap + 'mm'; el.style.backgroundColor = el.dataset.docSectionBg; const base = parsePageStyle(api.snapshot().body); if (w !== base.widthMm || h !== base.heightMm || m !== base.marginMm)
                el.dataset.docSectionBreak = 'page'; el.style.breakBefore = el.dataset.docSectionBreak === 'page' ? 'page' : 'auto'; changed(); } }); }
        function footnoteDialog() { UI.modal({ title: 'Insert footnote', bodyHTML: '<label>Note text<textarea id="fn-text" maxlength="4000" placeholder="Source or explanatory note"></textarea></label><p class="muted">Linked notes appear at the end of this document and are renumbered automatically.</p>', confirmText: 'Insert', onConfirm: ov => { const text = ov.querySelector('#fn-text').value.trim(); if (!text)
                return false; restoreRange(); const sel = getSelection(), r = sel?.rangeCount ? sel.getRangeAt(0) : null; if (!r || !root.contains(r.startContainer) || r.startContainer.parentElement?.closest('[data-doc-locked="true"],[data-doc-notes]')) {
                UI.toast('Place the cursor in unlocked document text first', 'error');
                return false;
            } const id = uid('n'), ref = document.createElement('a'); ref.dataset.docNoteRef = id; ref.style.verticalAlign = 'super'; ref.style.fontSize = '.75em'; ref.textContent = '1'; r.collapse(false); r.insertNode(ref); let list = root.querySelector('[data-doc-notes]'); if (!list) {
                list = document.createElement('div');
                list.dataset.docNotes = 'true';
                list.style.borderTop = '1px solid #cbd5e1';
                list.style.marginTop = '24px';
                (page() || root).append(list);
            } const note = document.createElement('p'); note.dataset.docFootnote = id; const number = document.createElement('a'); number.dataset.docNoteNumber = 'true'; number.href = '#doc-note-ref-' + id; const body = document.createElement('span'); body.dataset.docNoteText = 'true'; body.textContent = text; note.append(number, body); list.append(note); changed(); } }); }
        function trackedEdit(range, text) {
            const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement, end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
            if (start.closest('[data-doc-locked="true"],[data-doc-notes],[data-doc-toc],del') || end.closest('[data-doc-locked="true"],del'))
                return false;
            const a = start.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,.doc-float-body'), b = end.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,.doc-float-body');
            if (a !== b || range.cloneContents().querySelector('[data-doc-change],[data-doc-note-ref],.doc-chip,.doc-float,img,table'))
                return false;
            const insertion = start.closest('ins[data-doc-change]');
            if (insertion && insertion.contains(end)) {
                range.deleteContents();
                const node = document.createTextNode(text);
                range.insertNode(node);
                range.setStart(node,node.length);
                range.collapse(true);
                if (!insertion.textContent){range.setStartBefore(insertion);range.collapse(true);insertion.remove();}
            }
            else {
                const id = uid('c'), author = settings(root).value.reviewAuthor || opts.reviewAuthor || 'Editor', date = new Date().toISOString();
                if (!range.collapsed) {
                    const del = document.createElement('del');
                    del.dataset.docChange = id;
                    del.dataset.docAuthor = author;
                    del.dataset.docDate = date;
                    del.contentEditable = 'false';
                    del.append(range.extractContents());
                    range.insertNode(del);
                    range.setStartAfter(del);
                    range.collapse(true);
                }
                if (text) {
                    const ins = document.createElement('ins');
                    ins.dataset.docChange = id;
                    ins.dataset.docAuthor = author;
                    ins.dataset.docDate = date;
                    ins.textContent = text;
                    range.insertNode(ins);
                    range.setStart(ins.firstChild,ins.firstChild.length);
                    range.collapse(true);
                }
            }
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            changed();
            return true;
        }
        function beforeInput(e) {
            if (!settings(root).value.trackChanges || e.defaultPrevented)
                return;
            const sel = getSelection();
            if (!sel?.rangeCount)
                return;
            const r = sel.getRangeAt(0).cloneRange();
            if (!root.contains(r.commonAncestorContainer))
                return;
            if (e.isComposing || e.inputType === 'insertCompositionText') {
                e.preventDefault();
                UI.toast('Turn tracking off to use composition input; existing changes stay available for review', 'error');
                return;
            }
            const type = e.inputType || '';
            if (!/^(insertText|insertReplacementText|deleteContentBackward|deleteContentForward|deleteByCut|insertFromPaste)$/.test(type)) {
                if (type.startsWith('insert') || type.startsWith('delete')) {
                    e.preventDefault();
                    UI.toast('Tracking supports text and paste within a paragraph. Turn it off for structural edits.', 'error');
                }
                return;
            }
            if (type === 'insertFromPaste')
                return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (r.collapsed && type.startsWith('delete')) {
                const n = r.startContainer, offset = r.startOffset;
                if (n.nodeType !== 3) {
                    UI.toast('Select text to track its deletion', 'error');
                    return;
                }
                const backwards = type === 'deleteContentBackward';
                let target = offset + (backwards ? -1 : 1);
                if (target < 0 || target > n.length)
                    return;
                if (backwards && target > 0 && /[\uDC00-\uDFFF]/.test(n.data[target]))
                    target--;
                if (!backwards && target < n.length && /[\uDC00-\uDFFF]/.test(n.data[target]))
                    target++;
                if (backwards)
                    r.setStart(n, target);
                else
                    r.setEnd(n, target);
            }
            if (!trackedEdit(r, type.startsWith('insert') ? e.data || '' : ''))
                UI.toast('Select plain text within one unlocked paragraph for a tracked edit', 'error');
        }
        function paste(e) { if (!settings(root).value.trackChanges)
            return; e.preventDefault(); e.stopImmediatePropagation(); const sel = getSelection(); if (sel?.rangeCount && !trackedEdit(sel.getRangeAt(0).cloneRange(), e.clipboardData?.getData('text/plain') || ''))
            UI.toast('Paste tracked text inside one unlocked paragraph', 'error'); }
        root.addEventListener('beforeinput', beforeInput, true);
        root.addEventListener('paste', paste, true);
        function render(tab, panel) {
            const cfg = settings(root).value;
            if (tab === 'Styles') {
                const styles = { ...defaults, ...cfg.styles };
                panel.innerHTML = '<h3>Document styles</h3><p>Apply a named style, then edit it to update matching paragraphs together.</p>' + Object.entries(styles).map(([key, s]) => `<div class="doc-prop-grid"><button data-adv="style-apply" data-style-key="${key}">${esc(s.name)}</button><button data-adv="style-edit" data-style-key="${key}">Edit</button></div>`).join('') + '<h3>Numbering</h3><p>Use numbered lists and Indent / Outdent for nested levels.</p><button data-adv="multilevel">Hierarchical numbering</button>';
                return true;
            }
            if (tab === 'Review') {
                const groups = new Map();
                root.querySelectorAll('[data-doc-change]').forEach(el => { const id = el.dataset.docChange; if (!groups.has(id))
                    groups.set(id, []); groups.get(id).push(el); });
                panel.innerHTML = `<h3>Track text changes</h3><label>Reviewer name<input data-adv-author maxlength="100" value="${esc(cfg.reviewAuthor || opts.reviewAuthor || 'Editor')}"></label><label><input type="checkbox" data-adv-tracking ${cfg.trackChanges ? 'checked' : ''} style="width:auto"> Track typing, paste and deletion</label><p>Changes within one paragraph are tracked. Turn tracking off for tables, objects, paragraph breaks or composition input. Prints use the proposed final text.</p><div class="doc-prop-grid"><button data-adv="review-all-accept">Accept all</button><button data-adv="review-all-reject">Reject all</button></div><button data-adv="compare">Compare with opened document</button><h3>${groups.size} pending change${groups.size === 1 ? '' : 's'}</h3>` + [...groups].map(([id, els]) => `<div class="doc-review-card"><strong>${esc(els[0].dataset.docAuthor || 'Editor')}</strong><p>${esc(els.map(el => (el.tagName === 'DEL' ? 'Removed: ' : 'Added: ') + el.textContent).join(' → ').slice(0, 400))}</p><div class="doc-prop-grid"><button data-adv="review-accept" data-change-id="${id}">Accept</button><button data-adv="review-reject" data-change-id="${id}">Reject</button></div></div>`).join('');
                return true;
            }
            if (tab === 'Pages') {
                const all = pages(), current = page();
                panel.innerHTML = `<h3>Design pages</h3><p>Each design page has its own objects and background. Two or more pages disable grid printing.</p><button data-adv="page-add">${all.length ? 'Add page' : 'Create design pages'}</button>` + (all.length ? `<div class="doc-prop-grid"><button data-adv="page-copy">Duplicate page</button><button data-adv="page-delete" ${all.length === 1 ? 'disabled' : ''}>Delete page</button><button data-adv="page-up">Move earlier</button><button data-adv="page-down">Move later</button></div><label>Page name<input data-adv-page-name maxlength="100" value="${esc(current?.dataset.docPageName || '')}"></label><label>Background<input data-adv-page-bg type="color" value="${current?.dataset.docPageBg || '#ffffff'}"></label>` : '') + all.map((p, i) => `<button data-adv="page-select" data-page-id="${p.dataset.docDesignPage}" aria-pressed="${p === current}">${i + 1}. ${esc(p.dataset.docPageName || 'Page')}</button>`).join('') + '<h3>Document flow</h3><button data-do="pageview">Open measured page view</button><button data-do="pagebreak">Insert page break</button><button data-do="header">Insert repeating header</button><button data-do="footer">Insert repeating footer</button><button data-do="pagenumber">Insert page number</button><button data-adv="section">Section / columns</button><button data-adv="footnote">Insert footnote</button><button data-do="overflow">Check overflow</button><div data-issues role="status"></div>';
                return true;
            }
            return false;
        }
        async function action(button) {
            const key = button.dataset.adv;
            if (!key)
                return false;
            api.beforeEdit?.();
            if (key === 'style-apply')
                applyStyle(button.dataset.styleKey);
            if (key === 'style-edit')
                styleDialog(button.dataset.styleKey);
            if (key === 'multilevel') {
                const block = selectedBlock(), list = block?.closest('ol');
                if (!list) {
                    UI.toast('Select a numbered list first', 'error');
                    return true;
                }
                list.dataset.docNumbering = 'hierarchical';
                changed();
            }
            if (key === 'section')
                sectionDialog();
            if (key === 'footnote')
                footnoteDialog();
            if (key.startsWith('review-')) {
                finishReview(root, key.endsWith('accept'), button.dataset.changeId);
                changed();
            }
            if (key === 'compare') {
                const original = document.createElement('div'), current = document.createElement('div');
                original.innerHTML = bodyToEditorHtml(parsePageStyle(opts.body || '').rest);
                current.innerHTML = serializeEditor(root);
                original.querySelectorAll('[data-doc-settings],style').forEach(n => n.remove());
                current.querySelectorAll('[data-doc-settings],style').forEach(n => n.remove());
                finishReview(current, true);
                UI.modal({ title: 'Compare document text', bodyHTML: `<p class="muted">Compares text with the document opened at the start of this session. Layout and formatting are not compared.</p><div class="field-row"><label>Opened document<textarea readonly>${esc(original.textContent)}</textarea></label><label>Current proposed text<textarea readonly>${esc(current.textContent)}</textarea></label></div>`, confirmText: 'Done', onConfirm: () => true });
            }
            if (key === 'page-add') {
                if (pages().length >= 100) {
                    UI.toast('A design can contain up to 100 pages', 'error');
                    return true;
                }
                if (!pages().length) {
                    ensurePages();
                }
                else {
                    const p = newPage();
                    (page() || pages().at(-1)).after(p);
                    activatePage(p);
                }
                changed();
            }
            if (key === 'page-copy') {
                if (pages().length >= 100)
                    return true;
                const original = page();
                if (original) {
                    const p = cleanClone(original);
                    p.dataset.docDesignPage = uid('p');
                    p.dataset.docPageName = (original.dataset.docPageName || 'Page') + ' copy';
                    const noteMap=new Map();
                    p.querySelectorAll('[data-doc-note-ref]').forEach(ref=>{const old=ref.dataset.docNoteRef;let note=[...p.querySelectorAll('[data-doc-footnote]')].find(n=>n.dataset.docFootnote===old);if(!note){const originalNote=[...root.querySelectorAll('[data-doc-footnote]')].find(n=>n.dataset.docFootnote===old);if(originalNote){let list=p.querySelector('[data-doc-notes]');if(!list){list=document.createElement('div');list.dataset.docNotes='true';p.append(list);}note=cleanClone(originalNote);list.append(note);}}if(note){const id=noteMap.get(old)||uid('n');noteMap.set(old,id);ref.dataset.docNoteRef=id;note.dataset.docFootnote=id;}});
                    original.after(p);
                    activatePage(p);
                    changed();
                }
            }
            if (key === 'page-delete' && pages().length > 1) {
                const p = page();
                if (p && await UI.confirmDialog('Delete this page and its content? Undo can restore it.', 'Delete page')) {
                    p.remove();
                    activePage = pages()[0].dataset.docDesignPage;
                    changed();
                }
            }
            if (key === 'page-up' || key === 'page-down') {
                const p = page(), all = pages(), i = all.indexOf(p);
                if (key === 'page-up' && i > 0)
                    all[i - 1].before(p);
                if (key === 'page-down' && i < all.length - 1)
                    all[i + 1].after(p);
                changed();
            }
            if (key === 'page-select') {
                activePage = button.dataset.pageId;
                const p = page();
                p?.scrollIntoView?.({ block: 'center' });
                if (p) {
                    const r = document.createRange();
                    r.selectNodeContents(p);
                    r.collapse(true);
                    const s = getSelection();
                    s.removeAllRanges();
                    s.addRange(r);
                    root.focus();
                }
            }
            return true;
        }
        function input(e) { const cfg = settings(root).value; if (e.target.matches('[data-adv-tracking]')) {
            cfg.trackChanges = e.target.checked;
            write(root, cfg);
            changed();
        } if (e.target.matches('[data-adv-author]')) {
            cfg.reviewAuthor = e.target.value.trim().slice(0, 100) || 'Editor';
            write(root, cfg);
            changed();
        } const p = page(); if (p && e.target.matches('[data-adv-page-name]')) {
            p.dataset.docPageName = e.target.value.trim() || 'Page';
            changed();
        } if (p && e.target.matches('[data-adv-page-bg]')) {
            p.dataset.docPageBg = e.target.value;
            p.style.backgroundColor = e.target.value;
            changed();
        } }
        return { render, action, input, close() { root.removeEventListener('click', onPageClick); root.removeEventListener('beforeinput', beforeInput, true); root.removeEventListener('paste', paste, true); } };
    }
    return { mount, refresh, multipage, finishReview };
})();

function mountStudio(fs, surface, opts, api) {
  const me = typeof App !== 'undefined' && App.getMe ? App.getMe() : {};
  const scope = location.host + ':' + (me?.tenant_id || '') + ':' + (me?.id || 'local');
  const prefix = 'doc-studio:' + scope + ':';
  let key = prefix + (opts.getDocumentKey?.() || opts.documentKey || opts.name || 'new');
  const libraryKey = 'doc-library:' + scope;
  let store = { versions: [] }, library = { styles: [], assets: [] }, timer, selected = null, range = null, disposed = false;
  function read(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch { return fallback; } }
  store = read(key, store); library = read(libraryKey, library);
  if (!store || typeof store !== 'object' || Array.isArray(store)) store = {versions:[]};
  if (!library || typeof library !== 'object' || Array.isArray(library)) library = {styles:[],assets:[]};
  if (!Array.isArray(store.versions)) store.versions = [];
  store.versions = store.versions.filter(v=>v && typeof v.body==='string').slice(-20);
  if (!Array.isArray(library.styles)) library.styles = [];
  if (!Array.isArray(library.assets)) library.assets = [];
  function write(k, value) { try { localStorage.setItem(k, JSON.stringify(value)); return true; } catch { note.textContent = 'Browser storage unavailable. Save your template to protect changes.'; return false; } }
  const desk = document.createElement('div'); desk.className = 'doc-workspace';
  const canvas = fs.querySelector('.doc-canvas'); canvas.before(desk); desk.append(canvas);
  const side = document.createElement('aside'); side.className = 'doc-studio-side'; side.setAttribute('aria-label', 'Document tools'); desk.append(side);
  const toolNames={Properties:'Inspect',Layers:'Layers',Outline:'Outline',Data:'Fields',Pages:'Pages',Styles:'Styles',Review:'Review',Library:'Library',History:'History',Shared:'Shared'};
  const toolIcons={Properties:'settings',Layers:'layers',Outline:'justifyLeft',Data:'variable',Pages:'document',Styles:'styles',Review:'signature',Library:'image',History:'undo',Shared:'shared'};
  const rail=document.createElement('nav');rail.className='doc-tool-rail';rail.setAttribute('aria-label','Document tools');desk.prepend(rail);
  rail.innerHTML=['Properties','Pages','Layers','Outline','Styles','Data','Library','Review','History',...(opts.sharedStudio?['Shared']:[])].map(x=>`<button type="button" data-studio-tab="${x}" aria-pressed="false" title="${toolNames[x]}" aria-label="Open ${toolNames[x].toLowerCase()} panel">${docIcon(toolIcons[x])}<span>${toolNames[x]}</span></button>`).join('');
  rail.insertAdjacentHTML('beforeend','<button type="button" data-help title="Editor guide" aria-label="Editor guide">'+docIcon('help')+'<span>Help</span></button>');
  rail.insertAdjacentHTML('afterbegin','<button type="button" data-rail-toggle aria-expanded="true" aria-label="Collapse tool sidebar" title="Collapse tool sidebar">'+docIcon('justifyLeft')+'<span>Collapse</span></button>');
  rail.querySelector('[data-rail-toggle]').addEventListener('click',e=>{const collapsed=desk.classList.toggle('rail-collapsed');const button=e.currentTarget;button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'Expand tool sidebar':'Collapse tool sidebar');button.title=button.getAttribute('aria-label');button.querySelector('span').textContent=collapsed?'Expand':'Collapse';api.layout();});
  side.innerHTML='<header class="doc-inspector-head"><strong data-inspector-title>Inspect</strong><button type="button" data-inspector-close aria-label="Collapse inspector">'+docIcon('close')+'<span>Collapse</span></button></header><div class="doc-studio-body"></div><p class="doc-studio-note" role="status"></p>';
  const toggle = fs.querySelector('[data-tools]');
  side.hidden=true;
  function showInspector(open){side.hidden=!open;toggle.setAttribute('aria-expanded',String(open));rail.querySelectorAll('[data-studio-tab]').forEach(b=>b.setAttribute('aria-pressed',String(open&&b.dataset.studioTab===tab)));api.layout();}
  toggle.addEventListener('click',()=>showInspector(side.hidden));
  side.querySelector('[data-inspector-close]').addEventListener('click',()=>{showInspector(false);rail.querySelector(`[data-studio-tab="${tab}"]`)?.focus();});
  const panel = side.querySelector('.doc-studio-body'), note = side.querySelector('.doc-studio-note'); let tab = 'Properties';
  const style = document.createElement('style'); style.textContent = `.doc-workspace{display:flex;flex:1;min-height:0;overflow:hidden}.doc-workspace>.doc-canvas{min-width:0;flex:1}.doc-studio-side{width:280px;flex-shrink:0;background:var(--surface,#fff);border-left:1px solid var(--border,#ddd);overflow:auto;font-size:12px;color:var(--text,#222)}.doc-studio-side nav{display:grid;grid-template-columns:repeat(3,1fr);padding:8px;gap:4px;position:sticky;top:0;background:var(--surface,#fff);z-index:2}.doc-studio-side button{font:inherit;cursor:pointer;border:1px solid var(--border,#ddd);background:var(--surface,#fff);color:inherit;border-radius:var(--radius-sm,8px);padding:8px}.doc-studio-side button[aria-pressed=true]{background:var(--accent-weak,#edf3fc);color:var(--accent,#2765aa)}.doc-studio-body{padding:14px;display:flex;flex-direction:column;gap:10px}.doc-studio-body h3{font-size:14px;margin:4px 0}.doc-studio-body p{margin:0;line-height:1.6}.doc-studio-body label{display:flex;flex-direction:column;gap:5px;margin:0}.doc-studio-body input,.doc-studio-body textarea{font-weight:400!important}.doc-studio-body input,.doc-studio-body select,.doc-studio-body textarea{box-sizing:border-box;width:100%;padding:7px;border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,8px);color:inherit;background:var(--surface,#fff);font:inherit}.doc-studio-body textarea{min-height:130px}.doc-prop-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.doc-layer{display:flex;gap:4px;align-items:center}.doc-layer>button{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis}.doc-layer input{width:auto}.doc-studio-note{padding:12px;margin:0;font-size:11px;color:var(--text-muted,#666)}.doc-page [data-doc-locked=true]{cursor:default}.doc-page-guide{position:absolute;left:0;right:0;border-top:1px dashed #91a4bb;pointer-events:none;z-index:1002;font:11px system-ui;color:#60718a}.doc-page .doc-pagebreak{border-top:1px dashed #91a4bb;height:20px;margin:12px 0}.doc-page .doc-pagebreak:after{content:'Page break';font:11px system-ui;color:#60718a}.doc-page [data-doc-hidden=true]{display:none!important}@media(max-width:1000px){.doc-studio-side{width:230px}}@media(max-width:760px){.doc-workspace{flex-direction:column}.doc-studio-side{width:100%;max-height:220px;border-left:0;border-top:1px solid var(--border,#ddd)}.doc-studio-side nav{grid-template-columns:repeat(6,1fr)}.doc-studio-body{padding:10px}.doc-studio-body .doc-prop-grid{grid-template-columns:repeat(4,1fr)}}`;
  fs.append(style);
  const esc = (x) => escAttr(String(x ?? ''));
  const floats = () => [...surface.querySelectorAll('.doc-float')];
  const target = () => selected?.isConnected ? selected : null;
  function remember() { const s = window.getSelection(); if (s?.rangeCount && surface.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); }
  function selection() { remember(); const s = window.getSelection(); let node = s?.anchorNode; if (node?.nodeType === 3) node = node.parentElement; if (node && node !== surface && surface.contains(node)) selected = node.closest('.doc-float') || node.closest('img,p,h1,h2,h3,h4,h5,h6,td,th,li,div') || node; }
  function restoreRange() { surface.focus(); if (range && surface.contains(range.startContainer)) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); } }
  function insert(html) { restoreRange(); api.insert(html); }
  function changed() { api.change(); guides(); }
  function colorHex(value,fallback){const probe=document.createElement('span');probe.style.color=value;probe.style.display='none';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();const rgb=color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i);return rgb?'#'+rgb.slice(1,4).map(v=>Math.round(Math.max(0,Math.min(255,Number(v)))).toString(16).padStart(2,'0')).join(''):fallback;}
  const propertyPresets={fontSize:[8,9,10,11,12,14,16,18,20,24,28,32,36,48,60,72],lineHeight:[1,1.15,1.25,1.5,1.55,1.75,2,2.5,3],padding:[0,2,4,8,12,16,24,32,48,64],marginBottom:[0,2,4,8,12,16,24,32,48,64]};
  function field(label, prop, value, type='number') {
    if(prop==='fontSize'){label='Text size (pt)';value=Number(value)*.75;}
    if(type==='number'&&Number.isFinite(Number(value)))value=Math.round(Number(value)*100)/100;
    if(prop==='color'||prop==='backgroundColor'){const clear=prop==='backgroundColor'&&(!value||value==='transparent'||/^rgba\([^)]*,\s*0\s*\)$/.test(value));return `<label>${label}<div class="doc-color-picker"><input data-prop="${prop}" type="color" aria-label="Pick ${label.toLowerCase()}" value="${colorHex(value,prop==='color'?'#111111':'#ffffff')}"><span data-color-label>${clear?'No fill':'Choose color'}</span>${prop==='backgroundColor'?`<button type="button" data-clear-fill aria-pressed="${clear}">No fill</button>`:''}</div></label>`;}
    const presets=propertyPresets[prop];
    if(presets){const values=[...new Set([...presets,Number(value)])].sort((a,b)=>a-b);return `<label>${label}<select data-prop="${prop}" data-numeric="true" data-current="${value}" ${prop==='fontSize'?'data-unit="pt"':''}>${values.map(n=>`<option value="${n}" ${n===Number(value)?'selected':''}>${n}${prop==='lineHeight'?' ×':''}</option>`).join('')}<option value="custom">Custom…</option></select></label>`;}
    return `<label>${label}<input data-prop="${prop}" type="${type}" value="${esc(value)}" ${type==='number'?'step="0.5"':''}></label>`;
  }
  const advanced=DocAdvanced.mount(fs,surface,opts,api,target,restoreRange);
  function render() {
    rail.querySelectorAll('[data-studio-tab]').forEach(b=>b.setAttribute('aria-pressed',String(!side.hidden&&b.dataset.studioTab===tab)));side.querySelector('[data-inspector-title]').textContent=toolNames[tab] || tab;
    if(advanced.render(tab,panel))return;
    const el = target();
    if (tab === 'Properties') {
      panel.innerHTML = `<h3>${el ? ({P:'Paragraph',H1:'Heading',H2:'Heading',H3:'Heading',TD:'Table cell',TH:'Table heading',IMG:'Image',LI:'List item'}[el.tagName] || el.dataset.floatKind || 'Text settings') : 'Select text or an object'}</h3><p>Settings for the selected text or object. Use the top toolbar to format a text selection.</p>`;
      if (!el) return;
      const css = getComputedStyle(el), isFloat = el.classList.contains('doc-float');
      const font = ['Segoe UI','Arial','Georgia','Times New Roman','Courier New'].find(f=>css.fontFamily.includes(f));
      panel.innerHTML += `<div class="doc-prop-grid">${isFloat ? field('X (%)','left',parseFloat(el.style.left)||0)+field('Y (%)','top',parseFloat(el.style.top)||0)+field('Width (%)','width',parseFloat(el.style.width)||20)+field('Height (%)','height',parseFloat(el.style.height)||10)+field('Rotation (°)','rotate',parseFloat(el.style.rotate)||0)+field('Opacity (0–1)','opacity',el.style.opacity===''?1:Number(el.style.opacity))+field('Corner radius (px)','borderRadius',parseFloat(el.style.borderRadius)||0) : ''}${field('Font (px)','fontSize',(parseFloat(css.fontSize)||13)*(css.fontSize.endsWith('pt')?4/3:1))+field('Line height','lineHeight',(parseFloat(css.lineHeight)*(css.lineHeight.endsWith('pt')?4/3:1)/( /(?:px|pt)$/.test(css.lineHeight)?(parseFloat(css.fontSize)||13)*(css.fontSize.endsWith('pt')?4/3:1):1))||1.55)+field('Padding (px)','padding',parseFloat(css.padding)||0)+field('Spacing below (px)','marginBottom',parseFloat(css.marginBottom)||0)}</div>${field('Text color','color',css.color,'text')}${field('Background','backgroundColor',el.style.backgroundColor || 'transparent','text')}<label>Font<select data-prop="fontFamily">${['Segoe UI','Arial','Georgia','Times New Roman','Courier New'].map(f=>`<option ${font===f?'selected':''}>${f}</option>`).join('')}</select></label><label>Alignment<select data-prop="textAlign">${['left','center','right','justify'].map(f=>`<option ${css.textAlign===f?'selected':''}>${f}</option>`).join('')}</select></label>${el.tagName==='IMG'||el.dataset.floatKind==='image'?'<button data-do="picture">Picture settings</button>':''}<button data-do="duplicate">Duplicate object / block</button>${isFloat?'<h3>Align to page</h3><div class="doc-prop-grid"><button data-do="align-left">Left</button><button data-do="align-center">Center</button><button data-do="align-right">Right</button><button data-do="align-top">Top</button><button data-do="align-middle">Middle</button><button data-do="align-bottom">Bottom</button><button data-do="distribute-x">Space horizontally</button><button data-do="distribute-y">Space vertically</button></div>':''}`;
    } else if (tab === 'Outline') {
      panel.innerHTML='<h3>Document outline</h3><p>Use heading styles to organize your document.</p><button data-do="contents">Insert contents list</button><p>Contents links update with headings. Page numbers appear after measured pagination in Print preview.</p>'+[...surface.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h,i)=>`<button data-outline="${i}" style="text-align:left;margin-left:${(Number(h.tagName.slice(1))-1)*8}px">${esc(h.textContent||'Untitled heading')}</button>`).join('');
    } else if (tab === 'Layers') {
      panel.innerHTML = '<h3>Objects</h3><p>Highest layer first. Hidden objects are also hidden when printed.</p>'+floats().sort((a,b)=>(+b.style.zIndex||0)-(+a.style.zIndex||0)).map((f)=>`<div class="doc-layer"><button data-layer="${floats().indexOf(f)}" aria-pressed="${f===el}">${esc(f.dataset.docName || f.dataset.floatKind || 'Object')}</button><label title="Visible"><input type="checkbox" data-visible="${floats().indexOf(f)}" ${f.dataset.docHidden!=='true'?'checked':''}>Show</label><label title="Locked"><input type="checkbox" data-lock="${floats().indexOf(f)}" ${f.dataset.docLocked==='true'?'checked':''}>Lock</label></div>`).join('') + (el?.classList.contains('doc-float') ? `${field('Object name','docName',el.dataset.docName || '', 'text')}<div class="doc-prop-grid"><button data-do="forward">Forward</button><button data-do="back">Backward</button><button data-do="group">Group selected</button><button data-do="ungroup">Ungroup</button></div>`:'');
    } else if (tab === 'Data') {
      const vars = (opts.getVariables?.() || []).filter(v=>!/^\{\{[#/]/.test(v.token||''));
      panel.innerHTML = `<h3>Data blocks</h3><label>Field<select data-data-field>${vars.map(v=>`<option value="${esc(String(v.token||v.key).replace(/^\{\{|\}\}$/g,''))}">${esc(v.label||v.key)}</option>`).join('')}</select></label><div class="doc-prop-grid"><button data-do="variable">Insert field</button><button data-do="conditional">Conditional block</button></div><label>Repeat collection<input data-collection placeholder="items" value="items"></label><button data-do="repeat">Insert repeating table</button><button data-do="validate">Check fields and formulas</button>${opts.loadPreviewRecord ? '<label>Real record ID<input data-record-id type="number" min="1" placeholder="Record ID"></label><button data-do="loadRecord">Load real record</button>' : ''}<label>Preview scenario<select data-scenario><option value="sample">Sample data</option><option value="long">Long text</option><option value="empty">Missing values / empty tables</option><option value="large">Large tables (50 rows)</option><option value="custom">Custom / real record JSON</option></select></label><label>Record context (JSON)<textarea data-context placeholder='{"order":{"customer_name":"..."},"items":[]}'></textarea></label><button data-do="context">Apply preview data</button><p>Paste a real record’s template context here. This data is used only for preview and is not saved in the template.</p><div data-issues role="status"></div>`;
      panel.querySelector('[data-scenario]').value = api.scenario();
    } else if (tab === 'Pages') {
      panel.innerHTML = '<h3>Page layout</h3><p>Dashed guides estimate paper boundaries. Preview checks actual printed flow. Table headers repeat across printed pages.</p><button data-do="pageview">Open measured page view</button><button data-do="pagebreak">Insert page break</button><button data-do="header">Insert repeating header</button><button data-do="footer">Insert repeating footer</button><button data-do="pagenumber">Insert page number</button><button data-do="overflow">Check overflow</button><div data-issues role="status"></div>';
    } else if (tab === 'History') {
      panel.innerHTML = '<h3>History on this browser</h3><p>Drafts and up to 20 saved checkpoints are stored on this device. Restore creates an undo step.</p><button data-do="checkpoint">Create checkpoint</button>' + (store.draft ? `<button data-do="recover">Recover draft · ${esc(new Date(store.draft.at).toLocaleString())}</button><button data-do="discardDraft">Delete draft</button>`:'') + store.versions.slice().reverse().map((v,i)=>`<button data-version="${store.versions.length-1-i}">${esc(v.label || 'Saved checkpoint')} · ${esc(new Date(v.at).toLocaleString())}</button>`).join('');
    } else if (tab === 'Shared') {
      panel.innerHTML = '<h3>Shared document</h3>';
    } else {
      panel.innerHTML = '<h3>Styles & assets on this browser</h3><label>Name<input data-library-name placeholder="Brand heading / logo"></label><button data-do="saveStyle">Save selected style</button><button data-do="saveAsset">Save selected object / block</button><h3>Styles</h3>'+library.styles.map((s,i)=>`<div class="doc-layer"><button data-style="${i}">${esc(s.name)}</button><button data-remove-style="${i}" aria-label="Delete style">×</button></div>`).join('')+'<h3>Assets</h3>'+library.assets.map((s,i)=>`<div class="doc-layer"><button data-asset="${i}">${esc(s.name)}</button><button data-remove-asset="${i}" aria-label="Delete asset">×</button></div>`).join('');
    }
    if (opts.sharedStudio) api.shared?.()?.renderInto(panel,tab);
  }
  function checkpoint(label='Checkpoint', value=api.snapshot()) { store.versions.push({...value,at:Date.now(),label}); store.versions=store.versions.slice(-20); write(key,store); }
  function recover(value) { if (!value?.body || typeof value.body!=='string') return; api.restore(value); selected=null; render(); guides(); }
  function issues(messages) { const out=panel.querySelector('[data-issues]'); if(out) { out.replaceChildren(...messages.map(msg=>{const p=document.createElement('p');p.textContent=msg;return p;})); } }
  function validate() {
    const body=api.body(), known=new Set((opts.getVariables?.()||[]).map(v=>String(v.token||v.key).replace(/^\{\{|\}\}$/g,'').trim())), stack=[], warnings=[];
    for (const match of body.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
      const token=match[1].trim();
      if(token.startsWith('#')) stack.push(token.slice(1).split(/\s/)[0]);
      else if(token.startsWith('/')) { if(stack.pop()!==token.slice(1)) warnings.push('Unmatched block: '+token); }
      else if(token.startsWith('=')) { try { if(typeof evalFormula==='function') evalFormula(token.slice(1),api.context()); } catch(e) {warnings.push('Formula: '+e.message);} }
      else if(known.size && !known.has(token) && !stack.some(x=>x!=='if') && !/^today$/.test(token)) warnings.push('Unknown field: '+token);
      else if(!stack.some(x=>x!=='if') && !token.startsWith('=')) {const value=token.split('.').reduce((v,k)=>v?.[k],api.context());if(value==null||value==='')warnings.push('Missing preview value: '+token);}
    }
    stack.forEach(x=>warnings.push('Unclosed block: '+x)); issues([...new Set(warnings)].slice(0,30).concat(warnings.length?[]:['No field or block issues found. Preview with real data before printing.']));
  }
  function group() {
    const members=[...surface.querySelectorAll('.doc-float.multi')]; if(elLocked(target())) return;
    if(members.length<2) { note.textContent='Shift-click two or more objects before grouping.'; return; }
    const frame=members[0].closest('[data-doc-design-page]')||surface;if(members.some(f=>(f.closest('[data-doc-design-page]')||surface)!==frame)){note.textContent='Group objects on the same page.';return;}const page=frame.getBoundingClientRect(); if(!page.width||!page.height) return;
    const boxes=members.map(f=>f.getBoundingClientRect()); const left=Math.min(...boxes.map(b=>b.left)),top=Math.min(...boxes.map(b=>b.top)),right=Math.max(...boxes.map(b=>b.right)),bottom=Math.max(...boxes.map(b=>b.bottom));
    if(right===left||bottom===top||members.some(elLocked)) return;
    const g=document.createElement('div');g.className='doc-float';g.dataset.floatKind='group';g.style.cssText=`position:absolute;left:${(left-page.left)/page.width*100}%;top:${(top-page.top)/page.height*100}%;width:${(right-left)/page.width*100}%;height:${(bottom-top)/page.height*100}%;z-index:${Math.max(...members.map(f=>+f.style.zIndex||1))}`;
    members.forEach((f,i)=>{const b=boxes[i];f.style.left=(b.left-left)/(right-left)*100+'%';f.style.top=(b.top-top)/(bottom-top)*100+'%';f.style.width=b.width/(right-left)*100+'%';f.style.height=b.height/(bottom-top)*100+'%';f.querySelectorAll('.doc-float-toolbar,.doc-float-handle').forEach(n=>n.remove());f.classList.remove('selected','multi','editing');g.append(f);});frame.append(g);api.normalize();selected=g;api.select(g);changed();render();
  }
  function elLocked(el) { return el?.closest('[data-doc-locked="true"]'); }
  function ungroup(el) { if(el?.dataset.floatKind!=='group'||elLocked(el)) return; const frame=el.closest('[data-doc-design-page]')||surface;const outer=frame.getBoundingClientRect(); const children=[...el.children].filter(f=>f.classList.contains('doc-float'));const boxes=children.map(f=>f.getBoundingClientRect());if(!outer.width||!outer.height)return;children.forEach((f,i)=>{const b=boxes[i];f.style.left=(b.left-outer.left)/outer.width*100+'%';f.style.top=(b.top-outer.top)/outer.height*100+'%';f.style.width=b.width/outer.width*100+'%';f.style.height=b.height/outer.height*100+'%';frame.append(f);});el.remove();selected=null;api.normalize();changed();render(); }
  panel.addEventListener('change',e=>{
    advanced.input(e);
    const el=target(), input=e.target;
    if(input.dataset.visible!==undefined||input.dataset.lock!==undefined) { const f=floats()[+(input.dataset.visible??input.dataset.lock)];if(!f)return;if(input.dataset.visible!==undefined)f.dataset.docHidden=String(!input.checked);else { f.dataset.docLocked=String(input.checked);api.normalize(); }changed();return; }
    if(input.dataset.scenario!==undefined) {api.setScenario(input.value);return;}
    const prop=input.dataset.prop;if(!prop||!el||elLocked(el))return;
    if(input.dataset.numeric&&input.value==='custom'){const unit=input.dataset.unit||(['lineHeight','opacity'].includes(prop)?'':'px');UI.modal({guide:false,title:'Custom '+(prop==='fontSize'?'text size':prop==='lineHeight'?'line height':prop==='padding'?'padding':'spacing below'),bodyHTML:`<label>Value${unit?' ('+unit+')':''}<input data-custom-property type="number" min="${['fontSize','lineHeight'].includes(prop)?'0.01':'0'}" step="0.25" value="${Number(input.dataset.current)||0}"></label>`,confirmText:'Apply',onConfirm:ov=>{const raw=ov.querySelector('[data-custom-property]').value;const n=Number(raw);if(raw===''||!Number.isFinite(n)||n<0||(['fontSize','lineHeight'].includes(prop)&&n===0)){UI.toast('Choose a valid value.','error');return false;}if(!el.isConnected||elLocked(el))return;el.style[prop]=n+unit;changed();},onClose:render});return;}
    if(prop==='docName')el.dataset.docName=input.value.slice(0,100);
    else { let value=input.value;if(input.type==='number'||input.dataset.numeric) {const n=Number(value);if(!Number.isFinite(n)||( ['width','height','fontSize','lineHeight'].includes(prop)&&n<=0))return;if(prop==='opacity'&&(n<0||n>1))return;if(prop==='rotate'&&(n< -360||n>360))return;value=n+(['left','top','width','height'].includes(prop)?'%':prop==='rotate'?'deg':['lineHeight','opacity'].includes(prop)?'':input.dataset.unit || 'px');}if(typeof CSS !== 'undefined' && CSS.supports && !CSS.supports(prop.replace(/[A-Z]/g,x=>'-'+x.toLowerCase()),value)) {note.textContent='Choose a valid value.';return;}el.style[prop]=value;if(input.dataset.numeric)input.dataset.current=input.value;if(input.type==='color'){input.parentElement.querySelector('[data-color-label]').textContent='Choose color';input.parentElement.querySelector('[data-clear-fill]')?.setAttribute('aria-pressed','false');}if(prop==='borderRadius'&&['image','shape-rect','shape-oval','shape-line'].includes(el.dataset.floatKind)&&el.firstElementChild)el.firstElementChild.style.borderRadius='inherit'; }changed();
  });
  panel.addEventListener('click', async e=>{
    const b=e.target.closest('button');if(!b)return;if(b.dataset.adv){await advanced.action(b);render();return;}const el=target();
    if(b.hasAttribute('data-clear-fill')){if(el&&!elLocked(el)){el.style.backgroundColor='transparent';changed();render();}return;}
    if(b.dataset.outline!==undefined){const h=surface.querySelectorAll('h1,h2,h3,h4,h5,h6')[Number(b.dataset.outline)];if(h){h.scrollIntoView?.({block:'center',behavior:'smooth'});surface.focus();const r=document.createRange();r.selectNodeContents(h);r.collapse(true);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);}return;}
    if(b.dataset.layer!==undefined){selected=floats()[+b.dataset.layer];if(selected){api.select(selected);selected.scrollIntoView?.({block:'nearest'});}render();return;}
    if(b.dataset.version!==undefined){recover(store.versions[+b.dataset.version]);return;}
    if(b.dataset.removeStyle!==undefined||b.dataset.removeAsset!==undefined){library[b.dataset.removeStyle!==undefined?'styles':'assets'].splice(+(b.dataset.removeStyle??b.dataset.removeAsset),1);write(libraryKey,library);render();return;}
    if(b.dataset.style!==undefined){if(el&&!elLocked(el)){const s=library.styles[+b.dataset.style];Object.entries(s.values).forEach(([k,v])=>el.style[k]=v);changed();}return;}
    if(b.dataset.asset!==undefined){insert(library.assets[+b.dataset.asset].html);return;}
    const action=b.dataset.do;
    if(action==='recover')return recover(store.draft);
    if(action==='discardDraft'){delete store.draft;write(key,store);render();return;}
    if(action==='checkpoint'){checkpoint();render();return;}
    if(action==='validate'){validate();return;}
    if(action==='loadRecord'){const id=Number(panel.querySelector('[data-record-id]').value);if(!Number.isSafeInteger(id)||id<1){note.textContent='Enter a valid record ID.';return;}b.disabled=true;try{const value=await opts.loadPreviewRecord(id);if(disposed)return;api.setContext(value);panel.querySelector('[data-scenario]').value='custom';note.textContent='Real record loaded for preview.';}catch(err){if(!disposed)note.textContent=err.message || 'Could not load record';}finally{b.disabled=false;}return;}
    if(action==='context'){try{const v=JSON.parse(panel.querySelector('[data-context]').value);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('Use a JSON object');api.setContext(v);panel.querySelector('[data-scenario]').value='custom';note.textContent='Custom record applied to preview.';}catch(e){note.textContent=e.message;}return;}
    if(action==='overflow'){const overflow=floats().filter(f=>{const bounds=(f.closest('[data-doc-design-page]')||surface).getBoundingClientRect();const b=f.getBoundingClientRect();return b.right>bounds.right+1||b.left<bounds.left-1||b.top<bounds.top-1||b.bottom>bounds.bottom+1;});issues([overflow.length?`${overflow.length} object(s) extend beyond the paper.`:'No objects extend beyond the paper.','Long text and repeated rows can add pages; check Preview.']);return;}
    if(action==='group')return group();if(action==='ungroup')return ungroup(el);
    if(action==='repeat'||action==='variable'||action==='conditional') {const field=panel.querySelector('[data-data-field]').value;if(action!=='repeat' && !/^[\w.]+$/.test(field)){note.textContent='Choose a simple field for this block.';return;}if(action==='variable')insert('{{'+field+'}}');else if(action==='conditional')insert(`<div>{{#if ${field}}}<p>Conditional content</p>{{/if}}</div>`);else{const collection=panel.querySelector('[data-collection]').value.trim();if(!/^[\w.]+$/.test(collection)){note.textContent='Enter a collection name such as items.';return;}insert(`<table class="doc-table"><thead><tr><th>Description</th></tr></thead><tbody>{{#${collection}}}<tr><td>{{name}}</td></tr>{{/${collection}}}</tbody></table>`);}return;}
    if(action?.startsWith('align-')){if(!el?.classList.contains('doc-float')||elLocked(el)){note.textContent='Select an unlocked object first.';return;}const multi=[...surface.querySelectorAll('.doc-float.multi')];const targets=multi.length>1?multi:[el];if(targets.some(elLocked)){note.textContent='Unlock selected objects first.';return;}targets.forEach(object=>{const w=parseFloat(object.style.width)||20,h=parseFloat(object.style.height)||10;const positions={left:['left',0],center:['left',(100-w)/2],right:['left',100-w],top:['top',0],middle:['top',(100-h)/2],bottom:['top',100-h]};const [prop,value]=positions[action.slice(6)];object.style[prop]=Math.max(0,value)+'%';});changed();render();return;}
    if(action?.startsWith('distribute-')){const members=[...surface.querySelectorAll('.doc-float.multi')];if(members.length<3||members.some(elLocked)||new Set(members.map(f=>f.parentElement)).size!==1){note.textContent='Shift-click at least three unlocked objects on the same layer.';return;}const horizontal=action==='distribute-x',pos=horizontal?'left':'top',size=horizontal?'width':'height';members.sort((a,b)=>parseFloat(a.style[pos])-parseFloat(b.style[pos]));const start=parseFloat(members[0].style[pos]),end=parseFloat(members.at(-1).style[pos])+parseFloat(members.at(-1).style[size]),total=members.reduce((sum,f)=>sum+parseFloat(f.style[size]),0),gap=(end-start-total)/(members.length-1);let cursor=start;members.forEach(f=>{f.style[pos]=cursor+'%';cursor+=parseFloat(f.style[size])+gap;});changed();render();return;}
    if(action==='contents'){if(surface.querySelector('[data-doc-toc]')){note.textContent='This document already has a contents list.';return;}const toc=document.createElement('div');toc.dataset.docToc='true';surface.prepend(toc);refreshContents(surface);changed();render();return;}
    if(action==='picture'){const img=el?.tagName==='IMG'?el:el?.dataset.floatKind==='image'?el.querySelector('img'):null;editPicture(img,()=>{changed();render();});return;}
    if(action==='pageview'){api.pageView();return;}
    if(action==='pagebreak')insert('<div class="doc-pagebreak" style="break-after:page"></div><p><br></p>');
    if(action==='header')insert('<div class="doc-running-header">Document header</div>');
    if(action==='footer')insert('<div class="doc-running-footer">Document footer</div>');
    if(action==='pagenumber')insert('<span class="doc-page-number"></span>');
    if(['duplicate','forward','back','saveStyle','saveAsset'].includes(action)&&(!el||elLocked(el))){note.textContent='Select an unlocked object or text block first.';return;}
    if(action==='duplicate'){const root=document.createElement('div');root.append(el.cloneNode(true));insert(serializeEditor(root));}
    if(action==='forward'||action==='back'){el.style.zIndex=String((+el.style.zIndex||0)+(action==='forward'?1:-1));changed();render();}
    if(action==='saveStyle'||action==='saveAsset'){const name=panel.querySelector('[data-library-name]').value.trim();if(!name){note.textContent='Enter a name first.';return;}if(action==='saveStyle'){const css=getComputedStyle(el),values={};['fontFamily','fontSize','fontWeight','color','backgroundColor','lineHeight','textAlign','padding','marginBottom'].forEach(k=>values[k]=css[k]);library.styles.push({name,values});library.styles=library.styles.slice(-30);}else{const root=document.createElement('div');root.append(el.cloneNode(true));library.assets.push({name,html:serializeEditor(root)});library.assets=library.assets.slice(-30);}write(libraryKey,library);render();}
  });
  rail.addEventListener('click',e=>{const b=e.target.closest('[data-studio-tab]');if(b){remember();const close=!side.hidden&&tab===b.dataset.studioTab;tab=b.dataset.studioTab;render();showInspector(!close);}});
  // Keep the caret when tool buttons are clicked; inputs remain editable.
  side.addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault();});
  const onSelect=()=>{if(side.contains(document.activeElement))return;if(surface.contains(window.getSelection()?.anchorNode)){selection();if(tab==='Properties')render();}};
  document.addEventListener('selectionchange',onSelect);
  surface.addEventListener('click',e=>{selected=e.target.closest('.doc-float')||e.target.closest('img,p,h1,h2,h3,h4,h5,h6,td,th,li');remember();if(tab==='Properties'||tab==='Layers')render();});
  function guides(){surface.querySelectorAll('.doc-page-guide').forEach(n=>n.remove());if(surface.querySelector('[data-doc-design-page]'))return;const h=parseFloat(surface.style.minHeight);if(!h)return;const count=Math.min(100,Math.ceil(surface.scrollHeight/h));for(let i=1;i<count;i++){const g=document.createElement('div');g.className='doc-page-guide';g.contentEditable='false';g.style.top=i*h+'px';g.textContent='Page '+(i+1)+' · approximate flow';surface.append(g);}}
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(guides):null;observer?.observe(surface);
  if (opts.body && store.versions.at(-1)?.body.replace(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>[\s\S]*?<\/style>/i,'').trim() !== api.body().replace(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>[\s\S]*?<\/style>/i,'').trim()) checkpoint('Opened template');
  render();guides();if(store.draft){note.textContent='An unsaved draft is available in History.';tab='History';render();showInspector(true);}
  return { change(){clearTimeout(timer);timer=setTimeout(()=>{if(disposed)return;store.draft={...api.snapshot(),at:Date.now()};if(write(key,store))note.textContent='Draft saved on this browser · '+new Date().toLocaleTimeString();guides();},700);}, saved(value,unchanged){checkpoint('Saved template',value);if(unchanged){clearTimeout(timer);delete store.draft;}const oldKey=key;key=prefix+(opts.getDocumentKey?.() || opts.documentKey || opts.name || 'new');if(write(key,store)&&oldKey!==key){try{localStorage.removeItem(oldKey);}catch{/* the migrated checkpoint is already stored */}}}, close(){advanced.close();disposed=true;clearTimeout(timer);if(api.dirty()){store.draft={...api.snapshot(),at:Date.now()};write(key,store);}observer?.disconnect();document.removeEventListener('selectionchange',onSelect);}, render, guides };
}

function open(opts = {}) {
  ensureStyles();
  const typeOptions = opts.typeOptions || ['sale', 'job', 'generic'];
  const fs = document.createElement('div');
  fs.className = 'doc-fs';fs.dataset.editorMode='visual';
  fs.innerHTML = `
    <header class="doc-fs-bar">
      <div class="doc-brand">${docIcon('document')}<div><input class="doc-fs-name" aria-label="Template name" placeholder="Untitled template" value="${escAttr(opts.name || '')}"><span class="doc-fs-title">Document editor · ${UI.esc(opts.title || 'Template')}</span></div></div>
      <div class="doc-modes" aria-label="Editing mode"><button type="button" data-mode="visual" class="active">Edit</button><button type="button" data-mode="pages">Print preview</button></div>
      <div class="doc-fs-bar-actions">
        <span class="doc-save-status" role="status" aria-live="polite">No unsaved changes</span>
        <button type="button" class="btn secondary" data-file title="Import and export document" aria-label="Import and export document">${docIcon('document')}<span>File</span></button>
        <button type="button" class="btn secondary" data-preview title="Preview document">${docIcon('preview')}<span>Preview data</span></button>
        <button type="button" class="btn secondary" data-details aria-expanded="false" aria-controls="doc-document-settings">${docIcon('settings')}<span>Settings</span></button>
        <button type="button" class="btn secondary" data-tools aria-expanded="false">Inspector</button>
        <details class="doc-more-menu"><summary title="Advanced editor tools" aria-label="Advanced editor tools">Advanced ${docIcon('settings')}</summary><div class="doc-more-popover"><button type="button" data-find-launch>${docIcon('search')}Find and replace</button><button type="button" data-mode="code">HTML / CSS source</button>
        <button type="button" class="btn secondary doc-icon-button" data-managevars title="Manage variables" aria-label="Manage variables">${docIcon('settings')}</button>
        <button type="button" class="btn secondary doc-icon-button" data-help title="Editor guide" aria-label="Editor guide">${docIcon('help')}</button>
        </div></details><button type="button" class="btn" data-save>${docIcon('save')}<span>Save template</span></button>
        <button type="button" class="btn secondary doc-icon-button" data-close title="Close editor (Esc)" aria-label="Close editor">${docIcon('close')}</button>
      </div>
    </header>
    <div class="doc-details" id="doc-document-settings">
      <span class="doc-settings-caption">Document settings</span>
      <label class="doc-secondary-details"><span>Document type</span><select class="doc-fs-type doc-fs-type-top">${typeOptions.map((t) => `<option value="${escAttr(t)}" ${t === (opts.type || typeOptions[0]) ? 'selected' : ''}>${escAttr(t.charAt(0).toUpperCase() + t.slice(1))}</option>`).join('')}</select></label>
      ${opts.periodLabel ? `<label class="doc-secondary-details"><span>${escAttr(opts.periodLabel)}</span><input class="doc-fs-period" placeholder="e.g. October 2026" value="${escAttr(opts.period || '')}"></label>` : ''}
    </div>
    <div class="doc-ribbon-controls"><div class="doc-tabs" role="tablist">${tabsHTML()}</div><button type="button" class="doc-ribbon-toggle" data-ribbon-toggle aria-expanded="true" aria-label="Collapse ribbon">Hide ribbon</button></div>
    <div class="doc-panel" data-panel="home" role="toolbar" aria-label="Text formatting">${homePanelHTML()}</div>
    <div class="doc-panel" data-panel="insert" role="toolbar" aria-label="Insert" style="display:none">${insertPanelHTML()}</div>
    <div class="doc-panel" data-panel="layout" role="toolbar" aria-label="Layout" style="display:none">${layoutPanelHTML()}</div>
    <div class="doc-panel table-panel" data-panel="table" role="toolbar" aria-label="Table tools" style="display:none">${tablePanelHTML()}</div>
    <div class="doc-canvas"><div class="doc-zoom"><div class="doc-page doc-surface doc-content" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Document body"></div></div></div>
    <div class="doc-code doc-code-cm" style="display:none"></div>
    <footer class="doc-statusbar"><span>${docIcon('document')}<span class="doc-page-info"></span></span><span class="doc-word-count" aria-label="Document word count"></span><span class="doc-workspace-hint">Select an object to move or resize · Ctrl / ⌘ S to save</span><div class="doc-view-tools"><button type="button" data-zoom="out" title="Zoom out">−</button><button type="button" data-zoom="fit" title="Fit page to available width">Fit width</button><span class="doc-zoom-info">100%</span><button type="button" data-zoom="in" title="Zoom in">+</button></div></footer>`;
  fs.querySelectorAll('button[title],select[title],input[title]').forEach((el) => { if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title); });
  document.body.appendChild(fs);

  fs.querySelector('.doc-format-extra').addEventListener('toggle',e=>{if(!e.target.open)return;const rect=e.target.getBoundingClientRect(),popover=e.target.querySelector('.doc-format-popover');popover.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-190))+'px';popover.style.top=rect.bottom+6+'px';});
  fs.addEventListener('pointerdown',e=>{if(!e.target.closest('.doc-more-menu,.doc-format-extra'))fs.querySelectorAll('.doc-more-menu[open],.doc-format-extra[open]').forEach(menu=>menu.open=false);});
  fs.addEventListener('click',e=>{const menu=e.target.closest('.doc-more-menu,.doc-format-extra');if(menu&&e.target.closest('button'))menu.open=false;});
  fs.querySelector('[data-details]').addEventListener('click',e=>{e.preventDefault();const expanded=fs.querySelector('.doc-details').classList.toggle('details-expanded');e.currentTarget.setAttribute('aria-expanded',String(expanded));});
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
  function setRibbonCollapsed(collapsed){fs.classList.toggle('ribbon-collapsed',collapsed);const button=fs.querySelector('[data-ribbon-toggle]');button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'Expand ribbon':'Collapse ribbon');button.textContent=collapsed?'Show ribbon':'Hide ribbon';applyZoom();}
  fs.querySelector('[data-ribbon-toggle]').addEventListener('click',()=>setRibbonCollapsed(!fs.classList.contains('ribbon-collapsed')));
  function switchTab(name) {
    if (!panels[name]) return;
    activeTab = name;
    if(fs.classList.contains('ribbon-collapsed'))setRibbonCollapsed(false);
    tabsEl.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    Object.keys(panels).forEach((k) => { panels[k].style.display = k === name ? '' : 'none'; });
    tabsEl.querySelectorAll('.doc-tab').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.tab===name));b.tabIndex=b.dataset.tab===name?0:-1;});
  }
  tabsEl.querySelectorAll('.doc-tab').forEach((b) => {b.setAttribute('role','tab');b.setAttribute('aria-selected',String(b.dataset.tab==='home'));b.tabIndex=b.dataset.tab==='home'?0:-1;b.addEventListener('click', () => switchTab(b.dataset.tab));});
  tabsEl.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||!e.target.matches('.doc-tab'))return;const buttons=[...tabsEl.querySelectorAll('.doc-tab')].filter(b=>b.style.display!=='none');let i=buttons.indexOf(e.target);i=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;e.preventDefault();switchTab(buttons[i].dataset.tab);buttons[i].focus();});
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
  let history = null, studio = null, shared = null;
  let blockSequence=0, blocksInitialized=false;
  const blockPrefix=(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g,'');
  function markBlocks() {
    if (!opts.sharedStudio || mode !== 'visual') return;
    const selector='p,h1,h2,h3,h4,h5,h6,td,th,.doc-float-body,div';const seen=new Set();let initialIndex=0;
    [...surface.querySelectorAll(selector)].filter(el=>!el.querySelector(selector)&&!el.closest('.doc-float-toolbar,.doc-float-handle,.doc-page-guide,.doc-promote-bar,.doc-snap-guide')).forEach(el=>{
      let id=el.dataset.docNode;const previous=el.previousSibling;
      if(!id && previous?.nodeType===8 && /^doc-sync:[\w-]+$/.test(previous.data))id=previous.data.slice(9);
      if(!id||!/^[\w-]{1,100}$/.test(id)||seen.has(id))id=blocksInitialized?'u'+blockPrefix+'_'+(++blockSequence):'b'+(++initialIndex);
      seen.add(id);el.dataset.docNode=id;
      if(previous?.nodeType===8 && previous.data.startsWith('doc-sync:'))previous.data='doc-sync:'+id;else el.before(document.createComment('doc-sync:'+id));
    });blocksInitialized=true;
  }
  let previewScenario = 'sample', customPreviewContext = null;
  function previewContextNow() {
    const original = (typeof opts.sampleContext === 'function' ? opts.sampleContext() : opts.sampleContext) || {};
    if (previewScenario === 'custom') return customPreviewContext || original;
    if (previewScenario === 'sample') return original;
    const transform = (value) => {
      if (Array.isArray(value)) { if (previewScenario === 'empty') return []; return Array.from({length: previewScenario === 'large' ? 50 : value.length}, (_,i)=>transform(value[i % value.length] || {})); }
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,transform(v)]));
      if (typeof value === 'string') return previewScenario === 'empty' ? '' : previewScenario === 'long' ? value + ' — ' + value.repeat(4) : value;
      return value;
    }; return transform(original);
  }

  // ---- HTML/CSS code mode: a real CodeMirror editor (syntax highlighting + our own
  // {{variable}}/{{=formula}} autocomplete on top of CM's built-in HTML/CSS completions) —
  // mounted lazily on first switch to code mode, since mounting into a display:none
  // container makes CM mismeasure line layout. ----
  let cmEditor = null, settingCode = false;
  function ensureCodeEditor() {
    if (cmEditor) return cmEditor;
    if (typeof window.CMBundle === 'undefined') { UI.toast('Code editor failed to load', 'error'); return null; }
    const theme = document.documentElement.getAttribute('data-theme');
    const dark = theme === 'dark' || (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    try { cmEditor = window.CMBundle.mount(codeContainer, {
      doc: '',
      onChange: () => { if (!settingCode) onChange(); },
      getVariables: opts.getVariables,
      dark,
    }); } catch (err) { cmEditor = null; UI.toast('Code editor failed to initialize. Your document is preserved.', 'error'); }
    return cmEditor;
  }
  const getCode = () => (cmEditor ? cmEditor.getValue() : '');
  const setCode = (text) => { const ed = ensureCodeEditor(); if (!ed) return false; settingCode = true; try { ed.setValue(text || ''); return true; } catch { UI.toast('Could not open code mode. Your document is preserved.', 'error'); return false; } finally { settingCode = false; } };

  function downloadFile(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  fs.querySelector('[data-file]').addEventListener('click',()=>{
    let imported=null,sourceFile=null,importVersion=0;
    const identity=()=>opts.getDocumentKey?.()||opts.documentKey||'new-template:export';
    const endpoint=suffix=>'/templates/studio/documents/'+encodeURIComponent(identity())+'/'+suffix;
    UI.modal({title:'Import and export',size:'lg',cancelText:'Close',confirmText:'Apply import',bodyHTML:`
      <h3>Export current document</h3><p class="muted">Exports include unsaved content. Word exports document content; print-grid settings remain in this template.</p><label>Export content<select data-export-content><option value="template">Editable template fields</option><option value="preview">Current preview data</option></select></label>
      <div class="field-row"><button type="button" class="btn secondary" data-export-word>Word (.docx)</button><button type="button" class="btn secondary" data-export-html>HTML document</button><button type="button" class="btn secondary" data-export-pdf>Print / PDF preview</button></div>
      <div data-export-result role="status"></div><hr><h3>Import a Word document</h3><label>DOCX file (up to 8 MB)<input data-import-file type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>
      <label>Import mode<select data-import-mode><option value="append">Append to this document</option><option value="replace">Replace document content</option></select></label>
      <button type="button" class="btn secondary" data-import-convert>Convert and preview</button>
      <p class="muted">Review the conversion before applying. Your original file is unchanged; this edit can be undone.</p><div data-import-result role="status"></div>`,onOpen:ov=>{
      const exportResult=ov.querySelector('[data-export-result]'),importResult=ov.querySelector('[data-import-result]');
      const exportSnapshot=()=>{const snapshot=studioSnapshot();if(ov.querySelector('[data-export-content]').value==='preview'&&typeof renderTemplate==='function')snapshot.body=renderTemplate(snapshot.body,previewContextNow());if(ov.querySelector('[data-export-content]').value==='preview'){const root=document.createElement('div');root.innerHTML=protectExportBlocks(snapshot.body);DocAdvanced.finishReview(root,true);snapshot.body=restoreExportBlocks(root.innerHTML);}return snapshot;};
      ov.querySelector('[data-export-html]').onclick=()=>{const snapshot=exportSnapshot(),page=parsePageStyle(snapshot.body);const safe=pageStyleTag(page.widthMm,page.heightMm,page.marginMm)+sanitizeExportHtml(page.rest);downloadFile(new Blob([restoreExportBlocks(UI.printableHtml(protectExportBlocks(safe),snapshot.name||'Document'))],{type:'text/html;charset=utf-8'}),(snapshot.name||'Document')+'.html');};
      ov.querySelector('[data-export-pdf]').onclick=()=>{ov.remove();if(!previewEl)togglePreview();else refreshPreview();};
      ov.querySelector('[data-export-word]').onclick=async e=>{
        const button=e.currentTarget;button.disabled=true;exportResult.textContent='Preparing Word document…';
        try{const snapshot=exportSnapshot(),page=parsePageStyle(snapshot.body);const result=await API.post(endpoint('export-docx'),{body:snapshot.body,name:snapshot.name,widthMm:page.widthMm,heightMm:page.heightMm,marginMm:page.marginMm});if(!ov.isConnected)return;
          exportResult.replaceChildren();const report=document.createElement('p');report.textContent=result.warnings.length?'Conversion notes: '+result.warnings.join(' '):'Word document ready.';exportResult.append(report);const download=document.createElement('button');download.type='button';download.className='btn';download.textContent='Download Word document';download.onclick=()=>downloadFile(new Blob([Uint8Array.from(atob(result.data),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),result.filename);exportResult.append(download);
        }catch(err){exportResult.textContent=err.message;}finally{button.disabled=false;}
      };
      ov.querySelector('[data-import-file]').onchange=()=>{imported=null;sourceFile=null;importResult.replaceChildren();};
      ov.querySelector('[data-import-convert]').onclick=async e=>{
        const file=ov.querySelector('[data-import-file]').files[0];if(!file||!file.name.toLowerCase().endsWith('.docx')||file.size>8*1024*1024){importResult.textContent='Choose a DOCX file up to 8 MB.';return;}
        const button=e.currentTarget;button.disabled=true;imported=null;sourceFile=null;importResult.textContent='Converting Word document…';const startingVersion=changeVersion;
        try{const data=new FormData();data.append('file',file);const result=await API.upload(endpoint('import-docx'),data);if(!ov.isConnected||ov.querySelector('[data-import-file]').files[0]!==file)return;imported=result;sourceFile=file;importVersion=startingVersion;
          importResult.replaceChildren();const report=document.createElement('p');report.textContent=result.warnings.join(' ');importResult.append(report);const frame=document.createElement('iframe');frame.title='Converted Word document preview';frame.setAttribute('sandbox','');frame.style.cssText='width:100%;height:300px;border:1px solid var(--border);border-radius:var(--radius-sm);background:white';frame.srcdoc=UI.printableHtml(sanitizeHtml(result.body),'Import preview');importResult.append(frame);const original=document.createElement('button');original.type='button';original.className='btn secondary';original.textContent='Download original file';original.onclick=()=>downloadFile(sourceFile,sourceFile.name);importResult.append(original);
        }catch(err){importResult.textContent=err.message;}finally{button.disabled=false;}
      };
    },onConfirm:(ov,showErr)=>{
      if(!imported){showErr('Choose a DOCX file, then convert and preview it first');return false;}
      const replace=ov.querySelector('[data-import-mode]').value==='replace';if(replace&&changeVersion!==importVersion){showErr('The document changed during conversion. Convert again or append to preserve those edits.');return false;}
      if(mode!=='visual')setMode('visual');history.flush();const html=bodyToEditorHtml(sanitizeHtml(imported.body));if(replace){wired.clearPending();surface.innerHTML=html;}else surface.insertAdjacentHTML('beforeend',html);wired.normalizeFloats();onChange();history.flush();applyZoom();UI.toast('Word content imported. Review it before saving.');
    }});
  });

  // ---- movable / resizable preview (hidden until toggled) ----
  let previewEl = null, pageView = null, previewTimer = 0;
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
    const frames=[previewEl?.querySelector('iframe'),pageView?.querySelector('iframe')].filter(Boolean);
    if (!frames.length) return;
    try {
      const { widthMm, heightMm } = currentPageMm();
      const body = pageStyleTag(widthMm, heightMm, Number(marginInp.value) || 0) + currentBody();
      let inner;
      let isTiled = false;
      if (opts.sampleContext && typeof renderTemplate !== 'undefined') {
        const rows = Math.max(1, Math.min(6, parseInt(copiesInp.value, 10) || 1));
        const cols = Math.max(1, Math.min(6, parseInt(perPageInp.value, 10) || 1));
        const continuous = continuousChk.checked;
        const repeatCount = Math.max(1, Math.min(100, parseInt(repeatInp.value, 10) || 1));
        const renderOneRecord = () => renderTemplate(body, previewContextNow());
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
            continuous, repeatCount, gapXmm:Number(gapXInp.value),gapYmm:Number(gapYInp.value),
          });
          if(!inner){isTiled=false;inner=renderOneRecord();}
        } else {
          inner = renderOneRecord();
        }
      }
      let html;
      if (inner !== undefined && typeof UI !== 'undefined') {
        html = UI.printableHtml(inner, 'Preview');
      } else {
        html = opts.renderPreview ? opts.renderPreview(body) : '<p>No preview</p>';
      }
      // Same shrink-to-fit the real print path applies (print-tiling.js's fitTiledCells) so the
      // design-time preview shows what will actually print, not an optimistic grid that then
      // clips a too-tall cell only once you print for real.
      frames.forEach(frame=>{
        if(UI.loadPrintFrame) UI.loadPrintFrame(frame,html,isTiled&&typeof fitTiledCells==='function'?fitTiledCells:undefined).then(result=>{
          if(!frame.isConnected)return;
          if(pageView?.contains(frame)){
            pageView.querySelector('[data-pages-status]').textContent=result.warnings.length?result.warnings.join(' '):`${result.pages || 1} measured page(s) · click a block to return to Edit`;
            frame.contentDocument.addEventListener('click',event=>{const id=event.target.closest('[data-doc-node]')?.dataset.docNode;if(!id)return;setMode('visual');const target=surface.querySelector('[data-doc-node="'+id+'"]');if(target){target.scrollIntoView({block:'center'});const range=document.createRange();range.selectNodeContents(target);range.collapse(true);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);surface.focus();}});
          }
        }).catch(err=>{if(pageView?.contains(frame))pageView.querySelector('[data-pages-status]').textContent=err.message;});
        else {frame.onload=isTiled?()=>{if(typeof fitTiledCells==='function')fitTiledCells(frame.contentDocument);}:null;frame.srcdoc=html;}
      });
    } catch { frames.forEach(frame=>{frame.srcdoc = '<p style="color:#b00;font-family:sans-serif;padding:16px">Preview error</p>';}); }
  }
  function togglePreview() {
    if (previewEl) { previewEl.remove(); previewEl = null; return; }
    previewEl = document.createElement('div');
    previewEl.className = 'doc-preview-float';
    previewEl.innerHTML = `<div class="doc-preview-head"><span>${docIcon('preview')} Document preview</span><div class="grow"></div>
      <button type="button" data-pv="refresh" title="Refresh">⟳</button>
      <button type="button" data-pv="close" title="Close">✕</button></div><iframe title="Document preview" sandbox="allow-same-origin allow-modals"></iframe>`;
    document.body.appendChild(previewEl);
    previewEl.querySelector('[data-pv="close"]').onclick = () => togglePreview();
    previewEl.querySelector('[data-pv="refresh"]').onclick = refreshPreview;
    // drag by header
    const head = previewEl.querySelector('.doc-preview-head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const draggedPreview = previewEl;
      const r = draggedPreview.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      previewEl.style.right = 'auto'; previewEl.style.left = r.left + 'px'; previewEl.style.top = r.top + 'px';
      const move = (ev) => { if (!draggedPreview.isConnected) return; draggedPreview.style.left = Math.max(0, ev.clientX - ox) + 'px'; draggedPreview.style.top = Math.max(0, ev.clientY - oy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      e.preventDefault();
    });
    refreshPreview();
  }

  let dirty = false, saving = false, closed = false, changeVersion = 0, composing = false;
  const status = fs.querySelector('.doc-save-status');
  const setStatus = (text, state = '') => { if (status) { status.textContent = text; status.dataset.state = state; } };
  function updateWordCount(){const counter=fs.querySelector('.doc-word-count');if(!counter)return;const root=surface.cloneNode(true);root.querySelectorAll('.doc-chip,.doc-float-toolbar,.doc-float-handle,.doc-page-guide,.doc-snap-guide,[data-doc-hidden="true"]').forEach(el=>el.remove());root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,td,th,div').forEach(el=>el.append(root.ownerDocument.createTextNode(' ')));const text=(root.textContent||'').trim();const count=text?text.split(/\s+/u).length:0;counter.textContent=count+' word'+(count===1?'':'s');}
  let syncGrid=()=>{};
  const onChange = () => { if (composing) { changeVersion++; dirty = true; setStatus('Unsaved changes', 'dirty'); return; } wired.applyPending();DocAdvanced.refresh(surface);syncGrid();refreshContents(surface);updateWordCount();markBlocks(); changeVersion++; dirty = true; setStatus('Unsaved changes', 'dirty'); clearTimeout(previewTimer); if(previewEl||pageView) previewTimer=setTimeout(refreshPreview,150); if (history) history.scheduleRecord(); if (studio) studio.change(); if(shared) shared.changed(); };
  [nameInp, typeSel, periodInp].filter(Boolean).forEach((el) => {
    el.addEventListener('input', onChange); el.addEventListener('change', onChange);
  });
  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  const wired = wireToolbar(panelsRoot, surface, opts.getVariables, onChange, opts.sampleContext, tabApi, getZoom,
    () => { if (history) history.undo(); }, () => { if (history) history.redo(); }, {
      isComposing:()=>composing,isVisual:()=>mode==='visual',canUndo:()=>history?.canUndo() ?? false,canRedo:()=>history?.canRedo() ?? false,before:()=>history?.boundary(),after:()=>history?.flush(),
    });

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
  const gapXInp = fs.querySelector('.doc-gap-x'), gapYInp = fs.querySelector('.doc-gap-y');
  gapXInp.value = opts.gapXmm ?? 6; gapYInp.value = opts.gapYmm ?? 6;
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
  const gridNote=document.createElement('p');gridNote.className='doc-grid-note';gridNote.setAttribute('role','status');copiesInp.closest('.doc-group').append(gridNote);
  syncGrid=()=>{const multi=mode==='code'?(typeof isMultiPageDocument==='function'&&isMultiPageDocument(getCode())):DocAdvanced.multipage(surface);[copiesInp,perPageInp,tileFillSel,continuousChk,repeatInp,gapXInp,gapYInp].forEach(input=>input.disabled=!!multi);gridNote.textContent=multi?'Multipage document · grid printing unavailable':'';if(multi){copiesInp.value=1;perPageInp.value=1;continuousChk.checked=false;repeatInp.value=1;syncContinuousUI();}};

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
    surface.style.padding = ((Number(marginInp.value) || 0) * PX_PER_MM) + 'px';
    surface.querySelectorAll('[data-doc-design-page]').forEach(page=>page.style.height=Math.max(10,heightMm-2*(Number(marginInp.value)||0))+'mm');
    const info = fs.querySelector('.doc-page-info');
    if (info) info.textContent = `${sizeSel.value === 'custom' ? 'Custom' : sizeSel.value.toUpperCase()} · ${widthMm} × ${heightMm} mm`;
  };
  [sizeSel, orientSel, customWInp, customHInp, marginInp].forEach((el) =>
    el.addEventListener('change', () => { syncSizeUI(); applyCanvas(); applyZoom(); onChange(); }));
  // Print Grid controls don't touch the editing canvas — just the tiled preview (see
  // refreshPreview above) and what gets saved.
  [copiesInp, perPageInp, tileFillSel, repeatInp, gapXInp, gapYInp].forEach((el) =>
    el.addEventListener('change', () => { onChange(); }));
  continuousChk.addEventListener('change', () => { syncContinuousUI(); onChange(); });
  fs.querySelector('[data-swap-wh]').addEventListener('click', () => {
    const w = customWInp.value; customWInp.value = customHInp.value; customHInp.value = w;
    applyCanvas(); applyZoom(); onChange();
  });
  syncSizeUI();
  applyCanvas();

  surface.innerHTML = bodyToEditorHtml(pg.rest); // initial load is not a "dirty" edit
  wired.normalizeFloats();DocAdvanced.refresh(surface);syncGrid();refreshContents(surface);updateWordCount();

  // ---- canvas zoom: Zoom group in the Layout tab, Ctrl+wheel (zoom-to-cursor), Ctrl +/-/0 ----
  const zoomWrap = fs.querySelector('.doc-zoom');
  const zoomSel = fs.querySelector('.doc-zoomsel');
  const ZOOM_LADDER = [0.25, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  let zoomMode = 'fit'; // 'manual' | 'fit'; start with the entire page visible.

  function naturalPageSize() {
    const w = parseFloat(surface.style.width) || surface.offsetWidth || 816;
    const minH = parseFloat(surface.style.minHeight) || 0;
    const h = Math.max(surface.offsetHeight || 0, minH) || 1056; // offsetHeight is pre-transform
    return { w, h };
  }
  function computeFit() {
    const availW = (canvas.clientWidth || 0) - ((parseFloat(getComputedStyle(canvas).paddingLeft)||0)+(parseFloat(getComputedStyle(canvas).paddingRight)||0)+4); // Respect the current responsive canvas padding.
    const { w } = naturalPageSize();
    if (w <= 0 || availW <= 0) return 1;
    return Math.max(0.2, Math.min(1, availW / w)); // never auto-zoom past 100%
  }
  function applyZoom() {
    const z = zoomMode === 'fit' ? computeFit() : currentZoom;
    currentZoom = z;
    fs.querySelector('.doc-zoom-info').textContent = Math.round(z * 100) + '%';
    surface.style.transform = Math.abs(z - 1) < 0.0005 ? '' : 'scale(' + z + ')';
    const { w, h } = naturalPageSize();
    zoomWrap.style.width = Math.round(w * z) + 'px';
    zoomWrap.style.height = Math.round(h * z) + 'px';
    zoomWrap.style.setProperty('--zoom', String(z));
  }
  function syncZoomSel() {
    if (!zoomSel) return;
    fs.querySelector('[data-zoom=fit]')?.setAttribute('aria-pressed',String(zoomMode==='fit'));
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
    b.addEventListener('click', () => {if(b.dataset.zoom==='fit'){zoomMode='fit';applyZoom();syncZoomSel();}else setZoom(ladderStep(b.dataset.zoom === 'in' ? 1 : -1));}));
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
    let index = -1, timer = 0, restoring = false, inputKind = '', afterSelection = null;
    const snapshot = () => ({
      body: serializeEditor(surface),
      selection: captureEditorSelection(surface),
      metadata: { name: nameInp.value, type: typeSel.value, period: periodInp?.value || '' },
      page: { size: sizeSel.value, orient: orientSel.value, w: customWInp.value, h: customHInp.value, margin: marginInp.value },
      grid: { rows: copiesInp.value, cols: perPageInp.value, fill: tileFillSel.value, continuous: continuousChk.checked, repeat: repeatInp.value, gapX:gapXInp.value,gapY:gapYInp.value },
    });
    const same = (a, b) => !!a && !!b && a.body === b.body
      && a.page.size === b.page.size && a.page.orient === b.page.orient
      && a.page.w === b.page.w && a.page.h === b.page.h && a.page.margin === b.page.margin
      && JSON.stringify(a.grid) === JSON.stringify(b.grid) && JSON.stringify(a.metadata) === JSON.stringify(b.metadata);
    function updateButtons() {
      const u = fs.querySelector('[data-ex="undo"]');
      const r = fs.querySelector('[data-ex="redo"]');
      if (u) u.disabled = index <= 0 && !timer;
      if (r) r.disabled = !!timer || index >= stack.length - 1;
    }
    function record() {
      if (restoring) return;
      const s = snapshot();
      if (afterSelection) s.selection = afterSelection;
      if (same(s, stack[index])) return;
      stack.splice(index + 1);          // drop any redo tail
      stack.push(s);
      index = stack.length - 1;
      if (stack.length > CAP) { stack.shift(); index--; }
      updateButtons();
    }
    function flush() { if (composing) return; if (timer) { clearTimeout(timer); timer = 0; record(); } inputKind = ''; afterSelection = null; updateButtons(); }
    function scheduleRecord() {
      if (restoring || composing) return;
      afterSelection = captureEditorSelection(surface);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SNAP_MS);
      updateButtons();
    }
    function restore(s) {
      restoring = true;
      try {
        nameInp.value = s.metadata.name; typeSel.value = s.metadata.type; if (periodInp) periodInp.value = s.metadata.period;
        wired.clearPending();surface.innerHTML = bodyToEditorHtml(s.body);
        wired.normalizeFloats();
        sizeSel.value = s.page.size; orientSel.value = s.page.orient;
        customWInp.value = s.page.w; customHInp.value = s.page.h; marginInp.value = s.page.margin;
        gapXInp.value=s.grid.gapX ?? 6;gapYInp.value=s.grid.gapY ?? 6;copiesInp.value = s.grid.rows; perPageInp.value = s.grid.cols; tileFillSel.value = s.grid.fill;
        continuousChk.checked = s.grid.continuous; repeatInp.value = s.grid.repeat;
        DocAdvanced.refresh(surface);syncGrid();syncContinuousUI(); syncSizeUI(); applyCanvas(); applyZoom();
        changeVersion++; setStatus('Unsaved changes', 'dirty'); dirty = true;
        refreshPreview(); if (studio) { studio.change(); studio.render(); }
        try { surface.focus(); restoreEditorSelection(surface, s.selection); } catch (e) { /* a removed selection target must not prevent content recovery */ }
        updateWordCount(); if (shared) shared.changed();
      } finally { restoring = false; }
      updateButtons();
    }
    return {
      init() { stack.length = 0; stack.push(snapshot()); index = 0; updateButtons(); },
      beforeInput(kind) {
        if (composing) return;
        const selection = captureEditorSelection(surface);
        const continuous = /^(insertText|deleteContentBackward|deleteContentForward)$/.test(kind);
        if (!continuous || kind !== inputKind || JSON.stringify(selection) !== JSON.stringify(afterSelection)) flush();
        if (!timer && stack[index]) stack[index].selection = selection || stack[index].selection;
        inputKind = kind;
      },
      boundary() { flush(); if (stack[index]) stack[index].selection = captureEditorSelection(surface) || stack[index].selection; },
      canUndo:()=>index>0 || !!timer,
      canRedo:()=>!timer && index<stack.length-1,
      scheduleRecord,
      flush,
      record,
      cancel() { if (timer) { clearTimeout(timer); timer = 0; } },
      undo() { if (mode !== 'visual' || composing) return; flush(); if (index <= 0) return; index--; restore(stack[index]); },
      redo() { if (mode !== 'visual' || composing) return; flush(); if (index >= stack.length - 1) return; index++; restore(stack[index]); },
    };
  })();
  history.init();
  // Capture above the surface so tracking/paste handlers cannot bypass transaction starts.
  fs.addEventListener('beforeinput', e => {
    if (!surface.contains(e.target) || mode !== 'visual') return;
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault(); e.stopImmediatePropagation();
      wired.commands.run(e.inputType === 'historyUndo' ? 'edit.undo' : 'edit.redo'); return;
    }
    history.beforeInput(e.inputType || 'input');wired.beforeInput(e);
  }, true);
  fs.addEventListener('paste', e => { if (surface.contains(e.target)) history.boundary(); }, true);
  surface.addEventListener('compositionstart', () => { history.boundary(); composing = true; });
  surface.addEventListener('compositionend', e => {
    composing = false;wired.applyPending(e.data || null);
    queueMicrotask(() => { if (!closed && !composing) { onChange(); history.flush(); } });
  });
  panelsRoot.addEventListener('pointerdown', () => history.boundary(), true);
  panelsRoot.addEventListener('click', () => history.boundary(), true);
  surface.addEventListener('pointerdown', () => history.flush(), true);
  surface.addEventListener('keydown', e => {
    if (!e.isComposing && /^(Arrow|Home|End|Page)/.test(e.key)) history.flush();
  }, true);

  // find & replace bar
  let findBar = null;
  function toggleFind() {
    if (findBar) { findBar.remove(); findBar = null; return; }
    findBar = document.createElement('div');
    findBar.className = 'doc-find';
    findBar.innerHTML = `<input class="doc-find-q" aria-label="Find text" placeholder="Find"><input class="doc-find-r" aria-label="Replacement text" placeholder="Replace with"><button data-f="next">Find next</button><button data-f="all">Replace all</button><button data-f="x" title="Close">✕</button>`;
    fs.insertBefore(findBar,fs.querySelector('.doc-workspace') || canvas);
    const q = () => findBar.querySelector('.doc-find-q').value;
    findBar.querySelector('[data-f="next"]').onclick = () => { try { if (!(window.find && window.find(q()))) UI.toast('No more matches'); } catch (e) { UI.toast('Find not supported here', 'error'); } };
    findBar.querySelector('[data-f="all"]').onclick = () => { const n = replaceAllInSurface(surface, q(), findBar.querySelector('.doc-find-r').value); UI.toast(n ? `Replaced ${n}` : 'No matches'); if (n) onChange(); };
    findBar.querySelector('[data-f="x"]').onclick = toggleFind;
    findBar.querySelector('.doc-find-q').focus();
  }
  fs.querySelector('[data-find]').addEventListener('click', toggleFind);
  fs.querySelector('[data-find-launch]').addEventListener('click',toggleFind);
  fs.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', togglePreview));
  fs.querySelectorAll('[data-help]').forEach(button=>button.addEventListener('click',docEditorHelpDialog));
  const mvBtn = fs.querySelector('[data-managevars]');
  if (opts.onManageVars) mvBtn.addEventListener('click', () => opts.onManageVars({ refresh: () => { refreshPreview(); } }));
  else mvBtn.style.display = 'none';

  function setMode(next) {
    if(next!==mode)wired.clearPending();
    if (next === mode) return;
    if(next==='pages'){
      if(mode==='code')setMode('visual');
      if(!pageView){pageView=document.createElement('div');pageView.className='doc-pageview';pageView.style.cssText='flex:1;min-width:0;display:flex;flex-direction:column';pageView.innerHTML='<div style="padding:10px;background:var(--surface,#fff);font-size:12px" data-pages-status>Measuring pages…</div><iframe title="Measured document pages" sandbox="allow-same-origin allow-modals" style="flex:1;width:100%;border:0;background:#eef0f3"></iframe>';canvas.after(pageView);}
      pageView.style.display='flex';canvas.parentElement.style.display='';canvas.style.display='none';tabsEl.style.display='none';Object.values(panels).forEach(p=>p.style.display='none');mode='pages';fs.dataset.editorMode='pages';fs.querySelector('[data-find-launch]').disabled=true;fs.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===next));refreshPreview();return;
    }
    if(pageView){pageView.remove();pageView=null;}

    if (history) history.flush(); // commit any pending visual edit before leaving/re-entering
    if (next === 'code') {
      const text = serializeEditor(surface);
      codeContainer.style.display = '';
      if (!setCode(text)) { codeContainer.style.display = 'none'; return; }
      canvas.parentElement.style.display = 'none'; canvas.style.display = 'none'; tabsEl.style.display = 'none';
      Object.values(panels).forEach((p) => { p.style.display = 'none'; });
      if (cmEditor) cmEditor.focus();
    } else {
      if(mode==='code'){surface.innerHTML = bodyToEditorHtml(getCode());wired.normalizeFloats();}
      codeContainer.style.display = 'none'; canvas.parentElement.style.display = ''; canvas.style.display = ''; tabsEl.style.display = '';
      switchTab(activeTab);
      applyZoom(); // content height may have changed → resize the zoom sizer
      if (history) history.record(); // the code-mode result becomes an undo step
    }
    mode = next;fs.dataset.editorMode=next;fs.querySelector('[data-find-launch]').disabled=next!=='visual';
    fs.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    refreshPreview();
  }
  fs.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  async function close(force) {
    if (closed || saving) return;
    if (dirty && !force) { const ok = await UI.confirmDialog('Discard unsaved changes to this template?', 'Discard'); if (!ok) return; }
    closed = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (shared) shared.close();
    if (studio) studio.close();
    if (wired && wired.teardown) wired.teardown();
    if (history) history.cancel();
    if (cmEditor) cmEditor.destroy();
    clearTimeout(previewTimer);
    if (previewEl) previewEl.remove();
    if (zoomRO) zoomRO.disconnect();
    if (roRaf) cancelAnimationFrame(roRaf);
    fs.remove();
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e) => {
    if(e.key==='Escape'&&fs.querySelector('.doc-more-menu[open],.doc-format-extra[open]')){e.preventDefault();const menu=fs.querySelector('.doc-more-menu[open],.doc-format-extra[open]');menu.open=false;menu.querySelector('summary').focus();return;}

    if (e.isComposing || composing || e.keyCode === 229) return;
    // wireToolbar's own keydown handler already swallows Escape (via stopImmediatePropagation)
    // when a float is selected; this guard is a backstop so Escape can't close the editor while
    // an object selection is up.
    if(e.key==='Escape'&&findBar){e.preventDefault();findBar.remove();findBar=null;surface.focus();return;}
    if (e.key === 'Escape' && e.target.closest?.('.doc-studio-side input,.doc-studio-side textarea,.doc-studio-side select')) return;
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) { if (!wired.blurFloats()) close(); }
    if (e.target.closest && e.target.closest('.modal-overlay')) return;
    const k = e.key.toLowerCase();
    const externalTextInput = e.target.closest && !surface.contains(e.target) && e.target.closest('input,textarea,[contenteditable="true"]');
    if (externalTextInput && (k === 'z' || k === 'y')) return;
    // Undo / redo — visual mode only (CodeMirror owns its own history in code mode). preventDefault
    // so the browser's native contenteditable undo doesn't also fire.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'z' && !e.shiftKey) {
      if (mode === 'visual' && !e.defaultPrevented) { e.preventDefault(); wired.commands.run('edit.undo'); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'y' || (k === 'z' && e.shiftKey))) {
      if (mode === 'visual' && !e.defaultPrevented) { e.preventDefault(); wired.commands.run('edit.redo'); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fs.querySelector('[data-save]').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && mode==='visual' && !e.defaultPrevented) { e.preventDefault(); toggleFind(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(ladderStep(1)); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(ladderStep(-1)); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); }
  };
  document.addEventListener('keydown', onKey);
  fs.querySelector('[data-close]').addEventListener('click', () => close());

  fs.querySelector('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (saving) return;
    if (shared) { saving=true;btn.disabled=true;try { await shared.prepareSave(); } catch(err) { shared.failed();UI.toast(err.message,'error');return; } finally { saving=false;btn.disabled=false; } }
    if (history) history.flush();
    let body = mode === 'code' ? getCode() : serializeEditor(surface);
    const meaningful = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '');
    if (!meaningful && !/<(?:img|table|hr)\b|class=["'][^"']*doc-float/i.test(body)) { UI.toast('Add document content before saving', 'error'); return; }
    const { widthMm, heightMm } = currentPageMm();
    const marginMm = Number(marginInp.value);
    if (widthMm < 10 || heightMm < 10 || widthMm > 2000 || heightMm > 2000 || !Number.isFinite(marginMm) || marginMm < 0 || marginMm * 2 >= Math.min(widthMm, heightMm)) { UI.toast('Choose valid page dimensions and margins that leave room for content', 'error'); return; }
    body = pageStyleTag(widthMm, heightMm, Number(marginInp.value) || 0) + body.replace(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>[\s\S]*?<\/style>/i, '');
    const savedVersion = changeVersion;
    const savedSnapshot = studioSnapshot();
    btn.disabled = true; saving = true; setStatus('Saving…', 'saving');
    try {
      const copiesPerRecord = Math.max(1, Math.min(6, parseInt(copiesInp.value, 10) || 1));
      const recordsPerPage = Math.max(1, Math.min(6, parseInt(perPageInp.value, 10) || 1));
      const tileFill = tileFillSel.value === 'repeat' ? 'repeat' : 'blank';
      const continuous = continuousChk.checked;
      const repeatCount = Math.max(1, Math.min(100, parseInt(repeatInp.value, 10) || 1));
      if (copiesPerRecord * recordsPerPage > 12) throw new Error('Print grid cannot exceed 12 cells');
      const gapXmm=Number(gapXInp.value),gapYmm=Number(gapYInp.value);
      if (![gapXmm,gapYmm].every(v=>Number.isFinite(v)&&v>=0&&v<=30)) throw new Error('Grid gaps must be between 0 and 30 mm');
      const res = opts.onSave ? await opts.onSave({ name: nameInp.value, type: typeSel.value, period: periodInp ? periodInp.value : undefined, body, copiesPerRecord, recordsPerPage, tileFill, continuous, repeatCount, gapXmm, gapYmm, studioVersion: shared?.version }) : true;
      saving = false;
      if (res === true || res === undefined) { const completedUnchanged=shared?await shared.saved(changeVersion===savedVersion):changeVersion===savedVersion; studio.saved(savedSnapshot, completedUnchanged); if (completedUnchanged) { dirty = false; setStatus('Saved'); studio.render(); } else { setStatus('Unsaved changes', 'dirty'); } }
      else if (typeof res === 'string') { setStatus('Save failed', 'error'); UI.toast(res, 'error'); }
    } catch (err) { setStatus('Save failed', 'error'); UI.toast(err.message, 'error'); } finally { shared?.failed();saving = false; btn.disabled = false; }
  });

  function studioSnapshot() {
    return { body: pageStyleTag(currentPageMm().widthMm, currentPageMm().heightMm, Number(marginInp.value) || 0) + currentBody().replace(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>[\s\S]*?<\/style>/i,''), name: nameInp.value, type: typeSel.value, period: periodInp?.value || '', copiesPerRecord: Number(copiesInp.value), recordsPerPage: Number(perPageInp.value), tileFill: tileFillSel.value, continuous: continuousChk.checked, repeatCount: Number(repeatInp.value),gapXmm:Number(gapXInp.value),gapYmm:Number(gapYInp.value) };
  }
  function restoreStudio(value, remote = false) {
      wired.clearPending();
      const wasCode=mode==='code';
      const focused=document.activeElement;const selection=window.getSelection();const oldRange=selection?.rangeCount?selection.getRangeAt(0):null;
      const anchor=oldRange?.startContainer?.nodeType===3?oldRange.startContainer.parentElement:oldRange?.startContainer;
      const block=anchor?.closest?.('[data-doc-node]');const path=[];let node=oldRange?.startContainer;
      while(block&&node&&node!==block){path.unshift([...node.parentNode.childNodes].indexOf(node));node=node.parentNode;}
      const bookmark=block?{id:block.dataset.docNode,path,offset:oldRange.startOffset}:null;
      if (wasCode && !remote) setMode('visual'); history.flush();
      if(wasCode&&remote)setCode(parsePageStyle(value.body).rest);else surface.innerHTML=bodyToEditorHtml(parsePageStyle(value.body).rest);
      nameInp.value=value.name || ''; typeSel.value=value.type || typeOptions[0]; if(periodInp) periodInp.value=value.period || '';
      const page=parsePageStyle(value.body);
      if(page) { const preset=matchPagePreset(page.widthMm,page.heightMm); sizeSel.value=preset; customWInp.value=page.widthMm;customHInp.value=page.heightMm; orientSel.value=page.widthMm>page.heightMm?'landscape':'portrait'; marginInp.value=page.marginMm; }
      gapXInp.value=value.gapXmm ?? 6;gapYInp.value=value.gapYmm ?? 6;copiesInp.value=value.copiesPerRecord || 1;perPageInp.value=value.recordsPerPage || 1;tileFillSel.value=value.tileFill || 'blank';continuousChk.checked=!!value.continuous;repeatInp.value=value.repeatCount || 1;
      wired.normalizeFloats();syncContinuousUI();syncSizeUI();applyCanvas();applyZoom();onChange();history.flush();
      if(remote&&bookmark&&surface.contains(focused)){let root=surface.querySelector('[data-doc-node="'+bookmark.id+'"]');if(root){for(const i of bookmark.path)root=root?.childNodes[i];if(root){const range=document.createRange();range.setStart(root,Math.min(bookmark.offset,root.nodeType===3?root.textContent.length:root.childNodes.length));range.collapse(true);selection.removeAllRanges();selection.addRange(range);}}}
    }
  studio = mountStudio(fs, surface, opts, {
    pageView:()=>setMode('pages'),shared: () => shared, body: currentBody, context: previewContextNow, scenario: () => previewScenario,
    setScenario(value) { previewScenario=value; refreshPreview(); },
    setContext(value) { customPreviewContext=value; previewScenario='custom'; refreshPreview(); },
    snapshot: studioSnapshot, dirty: () => dirty, layout: applyZoom,
    beforeEdit:()=>history.flush(),change: onChange, select: wired.selectFloat, normalize: wired.normalizeFloats,
    insert(html) { if (mode==='code') { setCode(getCode()+html); onChange(); } else { wired.insertHtml(bodyToEditorHtml(html)); wired.normalizeFloats(); } },
    restore(value) { restoreStudio(value); }
  });
  if (opts.sharedStudio && window.DocStudio) {
    markBlocks();
    shared=window.DocStudio.mount(fs,opts,{
      surface, snapshot: studioSnapshot, dirty:()=>dirty, isComposing:()=>composing, markBlocks,
      apply:value=>restoreStudio(value,true),change:onChange,render:()=>studio.render(),
      selected:()=>{const node=window.getSelection()?.anchorNode;const el=node?.nodeType===3?node.parentElement:node;return surface.querySelector('.doc-float.selected') || el?.closest?.('[data-doc-node]');},
      serialize:serializeEditor,sanitize:sanitizeHtml,safeUrl:safeDocumentUrl,
      insert:html=>{wired.insertHtml(bodyToEditorHtml(html));wired.normalizeFloats();}
    });studio.render();const sharedStatus=fs.querySelector('.doc-shared-status');if(sharedStatus)fs.querySelector('.doc-statusbar').append(sharedStatus);
  }
  surface.focus();
  return { close, commands: wired.commands, _history: history }; // _history exposed for tests (undo/redo without waiting on the debounce)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDocCommandRegistry, captureEditorSelection, restoreEditorSelection, bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle, pageStyleTag, pageDims, replaceAllInSurface, safeDocumentUrl, tableGrid, editTableColumn, editTableRow, mergeTableCells, splitTableCell };
} else {
  window.DocEditor = { open, bodyToEditorHtml, serializeEditor, sanitizeHtml };
}
