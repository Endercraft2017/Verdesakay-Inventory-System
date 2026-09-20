/* Shared UI helpers: escaping, toasts, modals, formatting. */
const UI = (() => {
  // Neutral person-silhouette placeholder — used for employee/company photos before one is
  // set. Was independently hand-copied (byte-identical) in templates.js, hr-employees.js,
  // and doc-editor.js; hoisted here so the three can't drift.
  const PLACEHOLDER_PHOTO = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<rect width="100" height="100" fill="#dce6f2"/><circle cx="50" cy="38" r="18" fill="#9fb3c8"/>' +
    '<path d="M20 88c4-22 18-32 30-32s26 10 30 32" fill="#9fb3c8"/></svg>'
  );

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function toast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  function fmtDate(s) {
    if (!s) return '';
    // SQLite returns UTC "YYYY-MM-DD HH:MM:SS"
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateShort(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function money(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  function initials(name) {
    return (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  /* Modal: opts = { title, bodyHTML, confirmText, onConfirm(modalEl)->bool|Promise,
       size ('lg'|'xl'), headActionHTML (raw HTML placed left of the close button) } */
  function modal(opts) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal${opts.size ? ' ' + opts.size : ''}">
        <div class="modal-head">
          <h3>${esc(opts.title)}</h3>
          <div class="modal-head-actions">
            ${opts.headActionHTML || ''}
            <button class="icon-btn close" data-close>${icon('close')}</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="form-error hidden" data-modal-error></div>
          ${opts.bodyHTML}
        </div>
        <div class="modal-foot">
          <button class="btn secondary" data-close>${esc(opts.cancelText || 'Cancel')}</button>
          ${opts.confirmText ? `<button class="btn" data-confirm>${esc(opts.confirmText)}</button>` : ''}
        </div>
      </div>`;
    root.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const errBox = overlay.querySelector('[data-modal-error]');
    const showErr = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };

    const confirmBtn = overlay.querySelector('[data-confirm]');
    if (confirmBtn && opts.onConfirm) {
      confirmBtn.addEventListener('click', async () => {
        errBox.classList.add('hidden');
        confirmBtn.disabled = true;
        try {
          const ok = await opts.onConfirm(overlay, showErr);
          if (ok !== false) close();
        } catch (e) {
          showErr(e.message);
        } finally {
          confirmBtn.disabled = false;
        }
      });
    }
    // Submit on Enter inside single-line inputs.
    overlay.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && confirmBtn) { e.preventDefault(); confirmBtn.click(); } });
    });
    if (opts.onOpen) opts.onOpen(overlay);
    const firstInput = overlay.querySelector('input,select,textarea');
    if (firstInput) firstInput.focus();
    return { overlay, close, showErr };
  }

  function confirmDialog(message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      const m = modal({
        title: 'Please confirm',
        bodyHTML: `<p>${esc(message)}</p>`,
        confirmText,
        onConfirm: () => { resolve(true); return true; },
      });
      m.overlay.querySelectorAll('[data-close]').forEach((b) =>
        b.addEventListener('click', () => resolve(false)));
    });
  }

  /* ---------- Searchable combobox (replaces a plain <select> once the option list is long
     enough that scrolling through it is worse than typing a few letters — a growing list of
     cutoff periods, employees, items…). Type to filter, click (or Enter on a highlighted row)
     to pick; clicking away without picking snaps the text back to whatever's actually selected,
     so it can never be left in a half-typed, nothing-selected state the way a real <select>
     never can either. */
  function combo(container, options, opts = {}) {
    let list = options.slice();
    let selected = opts.selected != null ? opts.selected : null;
    container.classList.add('combo');
    container.innerHTML = `
      <input type="text" class="combo-input" autocomplete="off" placeholder="${esc(opts.placeholder || '')}" />
      <div class="combo-menu" hidden></div>`;
    const input = container.querySelector('.combo-input');
    const menu = container.querySelector('.combo-menu');
    let filtered = [];
    let activeIdx = -1;

    const labelFor = (value) => {
      const o = list.find((x) => String(x.value) === String(value));
      return o ? o.label : '';
    };
    const setSelected = (value) => { selected = value; input.value = labelFor(value); };
    setSelected(selected);

    // `showAll` skips filtering by the input's current text — used on focus, where the input
    // is pre-filled with the current selection's own full label, so filtering against it would
    // otherwise collapse the list to just that one entry the moment it opens (nothing left to
    // browse). Actually typing still filters normally.
    function render(showAll) {
      const q = showAll ? '' : input.value.trim().toLowerCase();
      filtered = q ? list.filter((o) => o.label.toLowerCase().includes(q)) : list;
      activeIdx = -1;
      menu.innerHTML = filtered.length
        ? filtered.map((o, i) => `<div class="combo-option" data-i="${i}">${esc(o.label)}</div>`).join('')
        : `<div class="combo-empty">${esc(opts.emptyText || 'No matches')}</div>`;
      menu.hidden = false;
    }
    function highlight(idx) {
      activeIdx = idx;
      [...menu.children].forEach((el, i) => el.classList.toggle('active', i === idx));
      const el = menu.children[idx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function pick(o) {
      setSelected(o ? o.value : null);
      menu.hidden = true;
      if (opts.onSelect) opts.onSelect(selected, o || null);
    }

    // Select-all on focus too, so a click that lands with the input already focused (e.g.
    // re-clicking after Tab) still lets an immediate keystroke replace the whole label instead
    // of inserting into the middle of it.
    input.addEventListener('focus', () => { input.select(); render(true); });
    input.addEventListener('input', () => render(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (menu.hidden) render(true); else highlight(Math.min(activeIdx + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!menu.hidden) highlight(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter') { if (activeIdx >= 0 && filtered[activeIdx]) { e.preventDefault(); pick(filtered[activeIdx]); } }
      else if (e.key === 'Escape') { menu.hidden = true; input.blur(); }
    });
    // mousedown (not click) + preventDefault keeps focus on the input throughout the click, so
    // it never blurs (and snap-reverts) before the pick below can run.
    menu.addEventListener('mousedown', (e) => {
      const optEl = e.target.closest('.combo-option');
      if (!optEl) return;
      e.preventDefault();
      pick(filtered[Number(optEl.dataset.i)]);
    });
    input.addEventListener('blur', () => { menu.hidden = true; input.value = labelFor(selected); });

    return {
      setOptions(newOptions) { list = newOptions.slice(); input.value = labelFor(selected); },
      setSelected,
      getValue: () => selected,
    };
  }

  /* ---------- Right-docked drawer (single instance) ---------- */
  let currentDrawer = null;

  /* opts = { title, bodyHTML, icon?, footHTML?, key?, onOpen(el) }
     Reopening with the same `key` toggles it closed. Returns { el, close } or null. */
  function drawer(opts) {
    const root = document.getElementById('drawer-root') || document.body;
    if (currentDrawer && opts.key && currentDrawer.key === opts.key) {
      currentDrawer.close();
      return null;
    }
    if (currentDrawer) currentDrawer.close();

    const catcher = document.createElement('div');
    catcher.className = 'drawer-catch';
    const el = document.createElement('aside');
    el.className = 'drawer';
    el.innerHTML = `
      <div class="drawer-head">
        ${opts.icon ? icon(opts.icon, 18) : ''}
        <h3>${esc(opts.title)}</h3>
        <button class="icon-btn drawer-close" data-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="drawer-body">${opts.bodyHTML || ''}</div>
      ${opts.footHTML ? `<div class="drawer-foot">${opts.footHTML}</div>` : ''}`;
    root.appendChild(catcher);
    root.appendChild(el);

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      el.classList.remove('open');
      catcher.remove();
      document.removeEventListener('keydown', onKey);
      if (currentDrawer && currentDrawer.el === el) currentDrawer = null;
      setTimeout(() => el.remove(), 180); // let the slide-out finish
    }
    catcher.addEventListener('mousedown', close);
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    currentDrawer = { el, key: opts.key, close };
    requestAnimationFrame(() => el.classList.add('open'));
    if (opts.onOpen) opts.onOpen(el);
    return { el, close };
  }

  /* ---------- Context menu ---------- */
  let ctxState = null;
  function closeContextMenu() {
    if (!ctxState) return;
    ctxState.menu.remove();
    document.removeEventListener('mousedown', ctxState.onDoc);
    document.removeEventListener('keydown', ctxState.onKey);
    window.removeEventListener('scroll', closeContextMenu, true);
    ctxState = null;
  }
  /* items = [{ label, icon?, onClick() }] shown at viewport (x, y). */
  function contextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items
      .map((it, i) => `<button class="context-item" data-i="${i}">${it.icon ? icon(it.icon, 15) : ''}<span>${esc(it.label)}</span></button>`)
      .join('');
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
    menu.querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        const it = items[Number(b.dataset.i)];
        closeContextMenu();
        if (it && it.onClick) it.onClick();
      }));
    const onDoc = (e) => { if (!e.target.closest('.context-menu')) closeContextMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', closeContextMenu, true);
    }, 0);
    ctxState = { menu, onDoc, onKey };
  }

  /* ---------- Printing ---------- */
  // Fixed black-on-white print stylesheet (independent of the app theme).
  const PRINT_CSS = `
    * { box-sizing: border-box; }
    body { position: relative; isolation: isolate; font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #111; margin: 0; padding: 24px; font-size: 13px; }
    img { max-width: 100%; }
    .doc { max-width: 800px; margin: 0 auto; }
    .doc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 12px; margin-bottom: 16px; gap: 20px; }
    .doc-company h1 { margin: 0 0 4px; font-size: 20px; }
    .doc-meta { text-align: right; white-space: nowrap; }
    .doc-meta h2 { margin: 0 0 6px; font-size: 16px; letter-spacing: 0.05em; }
    .doc-parties { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
    /* Tables — kept border-collapse for clean page-breaks; palette matches the editor (doc-editor.js). */
    .doc-table { width: 100%; border-collapse: collapse; margin: 12px 0 14px; font-size: 12.5px; }
    .doc-table th, .doc-table td { border: 1px solid #d7dee8; padding: 7px 10px; text-align: left; vertical-align: top; }
    .doc-table th { background: #f4f7fb; font-weight: 600; color: #1a2740; }
    .doc-table thead th { border-bottom: 2px solid #ccd6e2; }
    .doc-table.striped tbody tr:nth-child(even) td { background: #f8fafc; }
    .doc-table.shaded thead th { background: #16243d; color: #fff; border-bottom-color: #16243d; }
    .doc-table.plain th, .doc-table.plain td { border: 0; }
    .doc-table.plain thead th { border-bottom: 1px solid #ccd6e2; }
    .doc-table .r { text-align: right; }
    /* Floating objects placed in the template editor (position/size are % on the element). */
    .doc-float { position: absolute; box-sizing: border-box; }
    .doc-float-shape { width: 100%; height: 100%; box-sizing: border-box; }
    .doc-float-body { width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; padding: 4px; }
    .doc-float[data-float-kind="image"] img { width: 100%; height: 100%; object-fit: contain; }
    .doc-totals { margin-left: auto; width: 280px; text-align: right; }
    .doc-totals .grand { font-size: 15px; font-weight: 700; border-top: 2px solid #222; margin-top: 6px; padding-top: 6px; }
    .doc-notes { margin-top: 14px; }
    .doc-foot { margin-top: 28px; color: #666; font-size: 11px; border-top: 1px solid #ddd; padding-top: 8px; }
    .muted { color: #777; font-size: 11px; }
    @page { margin: 14mm; }
  `;

  /** Full standalone HTML doc (print stylesheet + body); used for print + preview. */
  function printableHtml(html, title) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${esc(title || 'Document')}</title>` +
      `<style>${PRINT_CSS}</style></head><body>${html}</body></html>`;
  }

  /* ---------- Inline SVG icons (Lucide-style, stroke = currentColor) ---------- */
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    inventory: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    forms: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    messages: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    history: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    adjust: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    sheet: '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="3" x2="21" y1="15" y2="15"/><line x1="9" x2="9" y1="3" y2="21"/><line x1="15" x2="15" y1="3" y2="21"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M6 21v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1"/>',
    note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/><path d="M8 13h6"/><path d="M8 17h4"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="m9 16 2 2 4-4"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" x2="12.01" y1="17" y2="17"/>',
    sparkles: '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M5 17l.8 2L8 19.8 6 20.6 5.2 23 4.4 20.6 2 19.8 4.4 19Z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>',
    idcard: '<rect width="20" height="14" x="2" y="5" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M14 9h4"/><path d="M14 12h4"/><path d="M6 15.5c.6-1 1.3-1.5 2-1.5s1.4.5 2 1.5"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    factory: '<path d="M3 21V10.5L9 14v-3.5L15 14V7l6 4.5V21Z"/><path d="M3 21h18"/><path d="M7 21v-3"/><path d="M12 21v-3"/><path d="M17 21v-3"/>',
  };

  /** A "?" help icon with a tooltip shown on hover (desktop) and tap (mobile).
      The tip text lives in data-tip; a single delegated controller (below) shows
      a body-level bubble so it never gets clipped by a scrolling modal. */
  function helpIcon(text) {
    if (!text) return '';
    return `<button type="button" class="help-icon" aria-label="${esc(text)}" data-tip="${esc(text)}">?</button>`;
  }

  /* Tooltip controller: hover (mouse) + tap/click (touch) → floating bubble.
     Delegated off any [data-tip] element, not just .help-icon, so plain hoverable
     controls (e.g. the permission chips in Accounts) get the same bubble without
     each needing their own show/hide wiring. .help-icon relies on click-to-show
     for touch devices, so its click still opens the tip rather than toggling it
     away like a generic target would. */
  (function initHelpTips() {
    let tip = null;
    const hide = () => { if (tip) { tip.remove(); tip = null; } };
    function show(target) {
      hide();
      const text = target.getAttribute('data-tip');
      if (!text) return;
      tip = document.createElement('div');
      tip.className = 'help-tip';
      tip.textContent = text;
      document.body.appendChild(tip);
      const r = target.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let top = r.top - tr.height - 8;
      if (top < 8) top = r.bottom + 8; // flip below if it would clip the top
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      tip.style.top = `${Math.round(top)}px`;
      tip.style.left = `${Math.round(left)}px`;
    }
    document.addEventListener('mouseover', (e) => {
      const h = e.target.closest && e.target.closest('[data-tip]');
      if (h) show(h);
    });
    document.addEventListener('mouseout', (e) => {
      const h = e.target.closest && e.target.closest('[data-tip]');
      if (h && !(e.relatedTarget && h.contains(e.relatedTarget))) hide();
    });
    document.addEventListener('click', (e) => {
      const h = e.target.closest && e.target.closest('.help-icon');
      if (h) { e.preventDefault(); e.stopPropagation(); show(h); }
      else hide();
    });
    window.addEventListener('scroll', hide, true);
  })();

  /** Inline SVG icon by name. Inherits text color; size in px (default 18). */
  function icon(name, size = 18) {
    const body = ICONS[name] || '';
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true">${body}</svg>`;
  }

  /** Friendly empty-state block. `action` is optional raw HTML (e.g. a button). */
  function emptyState({ icon: iconName = 'inbox', title = 'Nothing here yet', hint = '', action = '' }) {
    return `
      <div class="empty-state">
        <div class="empty-ic">${icon(iconName, 30)}</div>
        <div class="empty-title">${esc(title)}</div>
        ${hint ? `<div class="empty-hint">${esc(hint)}</div>` : ''}
        ${action ? `<div class="empty-action">${action}</div>` : ''}
      </div>`;
  }

  /** Pick an icon name from a file name's extension. */
  function fileIconName(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'sheet';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    return 'forms';
  }

  /** Build a CSV string and trigger a download. `rows` is an array of arrays. */
  function downloadCsv(filename, headers, rows) {
    const escapeCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    };
    const lines = [headers, ...rows].map((r) => r.map(escapeCell).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Reusable "import rows from a CSV" dialog for the list screens.
   * opts: { title, importPath, exportPath, columnsHtml, templateHeaders:[],
   *         templateRows:[[...],[...]] (or a single templateRow:[]), onDone }
   * The server endpoint takes { csv, dry_run } and returns
   * { dry_run, total, created, updated, skipped, errors:[{row,key,message}] }.
   */
  function csvImportModal(opts) {
    return modal({
      title: opts.title || 'Import from CSV',
      size: 'lg',
      confirmText: 'Import',
      bodyHTML: `
        <p class="muted" style="margin-top:0">${opts.columnsHtml || ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button type="button" class="btn secondary small" data-tmpl>${icon('download')} Download template</button>
          ${opts.exportPath ? `<button type="button" class="btn secondary small" data-all>${icon('download')} Export current data</button>` : ''}
          <label class="btn secondary small" style="cursor:pointer">
            ${icon('upload')} Choose file…
            <input type="file" accept=".csv,text/csv" hidden data-file>
          </label>
        </div>
        <textarea data-csv rows="10" style="width:100%;font-family:monospace;font-size:12px"
          placeholder="Paste CSV here, or choose a file above"></textarea>
        <label style="display:flex;align-items:center;gap:6px;margin:8px 0 0;font-weight:500">
          <input type="checkbox" data-dry style="width:auto" checked> Check first (validate, don't save)
        </label>
        <div data-result style="margin-top:10px"></div>`,
      onConfirm: async (overlay, showErr) => {
        const csv = overlay.querySelector('[data-csv]').value.trim();
        if (!csv) { showErr('Paste some CSV or choose a file first.'); return false; }
        const dry_run = overlay.querySelector('[data-dry]').checked;
        const res = await API.post(opts.importPath, { csv, dry_run });
        const errs = (res.errors || [])
          .map((e) => `<li>Row ${e.row}${e.key ? ` (${esc(e.key)})` : ''}: ${esc(e.message)}</li>`).join('');
        overlay.querySelector('[data-result]').innerHTML =
          `<div class="panel" style="padding:10px">
             <strong>${dry_run ? 'Dry run — nothing saved' : 'Done'}</strong><br>
             ${res.created} created · ${res.updated} updated · ${res.skipped} skipped (of ${res.total})
             ${errs ? `<ul style="margin:6px 0 0;color:var(--danger)">${errs}</ul>` : ''}
           </div>`;
        if (dry_run) {
          overlay.querySelector('[data-dry]').checked = false;
          toast(res.skipped ? `${res.skipped} row(s) need fixing` : 'Looks good — click Import to save',
            res.skipped ? 'error' : 'success');
          return false;
        }
        toast(`Imported: ${res.created} new, ${res.updated} updated`, 'success');
        if (opts.onDone) opts.onDone(res);
        return true;
      },
      onOpen: (overlay) => {
        overlay.querySelector('[data-tmpl]').onclick = () =>
          downloadCsv((opts.title || 'import').toLowerCase().replace(/\s+/g, '-') + '-template.csv',
            opts.templateHeaders || [],
            opts.templateRows || (opts.templateRow ? [opts.templateRow] : []));
        const allBtn = overlay.querySelector('[data-all]');
        if (allBtn) allBtn.onclick = async () => {
          try {
            const url = await API.blobUrl(opts.exportPath);
            const a = document.createElement('a');
            a.href = url; a.download = opts.exportPath.split('/').pop() + '.csv'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch (e) { toast(e.message, 'error'); }
        };
        overlay.querySelector('[data-file]').onchange = (e) => {
          const f = e.target.files[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => { overlay.querySelector('[data-csv]').value = String(r.result || ''); };
          r.readAsText(f);
        };
      },
    });
  }

  return {
    esc, toast, fmtDate, fmtDateShort, fmtBytes, money, initials, modal, confirmDialog, PLACEHOLDER_PHOTO,
    drawer, contextMenu, closeContextMenu, printableHtml, combo,
    icon, helpIcon, emptyState, fileIconName, downloadCsv, csvImportModal,
  };
})();
