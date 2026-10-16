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
       size ('lg'|'xl'), helpTopic? (explicit Help topic for this dialog), headActionHTML (raw HTML placed left of the close button) } */
  let dialogSequence = 0;
  function nameControls(container) {
    container.querySelectorAll('input:not([type="hidden"]), select, textarea, button').forEach((control) => {
      if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.labels?.length) return;
      if (control.tagName === 'BUTTON') {
        if (!control.textContent.trim() && control.title) control.setAttribute('aria-label', control.title);
        return;
      }
      const previous = control.previousElementSibling;
      if (previous?.tagName === 'LABEL' && !previous.htmlFor) {
        control.id ||= `ui-control-${++dialogSequence}`;
        previous.htmlFor = control.id;
        return;
      }
      const cell = control.closest('td');
      const heading = cell?.closest('table')?.querySelectorAll('thead th')[cell.cellIndex]?.textContent.trim();
      const label = control.title || heading || control.placeholder;
      if (label) control.setAttribute('aria-label', label);
    });
  }

  function modal(opts) {
    const root = document.getElementById('modal-root');
    const previousFocus = document.activeElement;
    let dirty = false;
    let saving = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    if (opts.guide === false) overlay.dataset.guideOff = 'true';
    // Keep visual styling attached to the section when dialogs render outside #view.
    const view = document.getElementById('view');
    if (view && (view.dataset.section === 'hr' || /^hr(?:-|$)/.test(view.dataset.route || ''))) {
      overlay.dataset.section = 'hr';
    }
    overlay.innerHTML = `
      <div class="modal${opts.size ? ' ' + opts.size : ''}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}" tabindex="-1">
        <div class="modal-head">
          <h3>${esc(opts.title)}</h3>
          <div class="modal-head-actions">
            ${opts.helpTopic && window.Help ? '<button type="button" class="btn secondary small" data-modal-help>Guide</button>' : ''}
            ${opts.headActionHTML || ''}
            <button type="button" class="icon-btn close" data-close aria-label="Close dialog" title="Close dialog">${icon('close')}</button>
          </div>
        </div>
        <div class="modal-body" tabindex="0">
          <div class="form-error hidden" data-modal-error></div>
          ${opts.bodyHTML}
        </div>
        <div class="modal-foot">
          <button class="btn secondary" data-close>${esc(opts.cancelText || 'Cancel')}</button>
          ${opts.confirmText ? `<button class="btn" data-confirm>${esc(opts.confirmText)}</button>` : ''}
        </div>
      </div>`;
    root.appendChild(overlay);

    const helpButton = overlay.querySelector('[data-modal-help]');
    if (helpButton) helpButton.addEventListener('click', () => Help.open(opts.helpTopic));
    const beforeUnload = (e) => { if (dirty || opts.isDirty?.()) { e.preventDefault(); e.returnValue = ''; } };
    const close = (cancelled = false) => {
      window.removeEventListener('beforeunload', beforeUnload);
      overlay.remove(); observer?.disconnect();
      if (cancelled) { opts.onCancel?.(); overlay.dispatchEvent(new CustomEvent('modalcancel')); }
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      if (opts.onClose) opts.onClose();
    };
    const canDismiss = () => !saving && (!(dirty || opts.isDirty?.()) || window.confirm('Discard your unsaved changes?'));
    overlay.__canDismiss = canDismiss;
    // Dialog actions outside the primary confirm button share the dismissal guard.
    overlay.__setSaving = (value) => { saving = !!value; };
    overlay.__markDirty = () => { dirty = true; };
    overlay.__close = close;
    const dismiss = () => { if (canDismiss()) { close(true); return true; } return false; };
    if ((opts.confirmText || opts.protectChanges) && opts.protectChanges !== false) {
      overlay.addEventListener('input', () => { dirty = true; });
      overlay.addEventListener('change', () => { dirty = true; });
      window.addEventListener('beforeunload', beforeUnload);
    }
    overlay.addEventListener('keydown', (e) => {
      if (overlay !== root.lastElementChild) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
      if (e.key !== 'Tab') return;
      const elements = [...overlay.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el => !el.disabled && !el.closest('.hidden,[hidden]'));
      const first = elements[0], last = elements[elements.length - 1];
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); if (last) last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); if (first) first.focus(); }
    });
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', dismiss));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); });

    const errBox = overlay.querySelector('[data-modal-error]');
    errBox.setAttribute('role', 'alert'); errBox.tabIndex = -1;
    const showErr = (msg) => { errBox.hidden = false; errBox.textContent = msg; errBox.classList.remove('hidden'); if (!overlay.contains(document.activeElement) || document.activeElement?.getAttribute('aria-invalid') !== 'true') errBox.focus(); };

    const confirmBtn = overlay.querySelector('[data-confirm]');
    if (confirmBtn && opts.onConfirm) {
      confirmBtn.addEventListener('click', async () => {
        errBox.classList.add('hidden');
        confirmBtn.disabled = true;
        saving = true;
        let finishSave;
        overlay.__whenSaved = new Promise(resolve => { finishSave = resolve; });
        try {
          const ok = await opts.onConfirm(overlay, showErr);
          if (ok !== false) close();
        } catch (e) {
          showErr(e.message);
        } finally {
          confirmBtn.disabled = !!opts.isConfirmDisabled?.();
          saving = false;
          overlay.__whenSaved = null;
          finishSave();
        }
      });
    }
    // Submit on Enter inside single-line inputs.
    overlay.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && confirmBtn && !inp.hasAttribute('data-no-submit')) { e.preventDefault(); confirmBtn.click(); } });
    });
    nameControls(overlay);
    const observer = new MutationObserver(() => nameControls(overlay)); observer.observe(overlay, { childList: true, subtree: true });
    if (opts.onOpen) Promise.resolve(opts.onOpen(overlay)).catch(e => showErr(e.message || 'Could not load dialog details'));
    const firstInput = [...overlay.querySelectorAll('input,select,textarea')].find(el => !el.disabled && !['hidden', 'file'].includes(el.type) && !el.closest('.hidden,[hidden]'));
    if (firstInput) firstInput.focus();
    else overlay.querySelector('.modal').focus();
    return { overlay, close: dismiss, showErr, markSaved: () => { dirty = false; } };
  }

  function confirmDialog(message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      const m = modal({
        title: 'Please confirm',
        bodyHTML: `<p>${esc(message)}</p>`,
        confirmText,
        protectChanges: false,
        onClose: () => resolve(false),
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
      menu.innerHTML = (filtered.length
        ? filtered.map((o, i) => `<div class="combo-option${o.disabled ? ' disabled' : ''}" data-i="${i}">${esc(o.label)}</div>`).join('')
        : `<div class="combo-empty">${esc(opts.emptyText || 'No matches')}</div>`)
        // Optional trailing action row (e.g. "+ Create new account"), always shown, fed the
        // text typed so far so the action can prefill from it.
        + (opts.action ? `<div class="combo-action">${esc(opts.action.label)}</div>` : '');
      menu.hidden = false;
      menu.scrollIntoView({ block: 'nearest' });
    }
    function highlight(idx) {
      activeIdx = idx;
      [...menu.querySelectorAll('.combo-option')].forEach((el, i) => el.classList.toggle('active', i === idx));
      const el = menu.querySelectorAll('.combo-option')[idx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function pick(o) {
      if (o && o.disabled) return;
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
      if (opts.action && e.target.closest('.combo-action')) {
        e.preventDefault();
        const typed = input.value.trim();
        menu.hidden = true;
        input.blur();
        opts.action.onClick(typed === labelFor(selected) ? '' : typed);
        return;
      }
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

    const previousFocus = document.activeElement;
    const descriptions = { notes: 'Private notes, saved to your account.', email: 'Compose a message or manage your mailbox.', scheduler: 'Plan tasks and keep track of due dates.', bookmarks: 'Quick access to your saved pages.', bug: 'Tell us what happened and how to reproduce it.', help: 'Find guidance for this screen and the rest of the app.' };
    const catcher = document.createElement('div');
    catcher.className = 'drawer-catch';
    const el = document.createElement('aside');
    el.className = 'drawer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', opts.title);
    el.setAttribute('tabindex', '-1');
    el.innerHTML = `
      <div class="drawer-head">
        ${opts.icon ? icon(opts.icon, 18) : ''}
        <div class="drawer-heading"><h3>${esc(opts.title)}</h3>${descriptions[opts.key] ? `<p>${esc(descriptions[opts.key])}</p>` : ''}</div>
        <button class="icon-btn drawer-close" data-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="drawer-body">${opts.bodyHTML || ''}</div>
      ${opts.footHTML ? `<div class="drawer-foot">${opts.footHTML}</div>` : ''}`;
    root.appendChild(catcher);
    root.appendChild(el);

    const onKey = (e) => {
      if (document.querySelector('.modal-overlay')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(x => !x.disabled && !x.closest('[hidden], .hidden'));
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    function close() {
      el.classList.remove('open');
      catcher.remove();
      document.removeEventListener('keydown', onKey);
      if (currentDrawer && currentDrawer.el === el) currentDrawer = null;
      el.inert = true;
      el.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
      if (previousFocus?.isConnected) previousFocus.focus();
      setTimeout(() => el.remove(), 180); // let the slide-out finish
    }
    catcher.addEventListener('mousedown', close);
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    currentDrawer = { el, key: opts.key, close };
    requestAnimationFrame(() => { if (currentDrawer?.el === el) { el.classList.add('open'); el.querySelector('[data-close]').focus(); } });
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
  const documentCss = `
    .doc-content, .doc-content * { box-sizing: border-box; }
    .doc-content { position: relative; isolation: isolate; font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #111; font-size: 13px; line-height: 1.55; }
    .doc-content img { max-width: 100%; }
    .doc-content [data-doc-settings]{display:none!important}
    .doc-content ins[data-doc-change]{text-decoration:none}
    .doc-content del[data-doc-change]{display:none!important}
    .doc-content [data-doc-design-page]{position:relative;isolation:isolate;display:flow-root;margin:0;break-inside:avoid}
    .doc-content [data-doc-design-page]:not(:last-of-type){break-after:page}
    .doc-content ol[data-doc-numbering="hierarchical"],.doc-content ol[data-doc-numbering="hierarchical"] ol{counter-reset:doc-list;list-style:none}
    .doc-content ol[data-doc-numbering="hierarchical"] li::before{counter-increment:doc-list;content:counters(doc-list,".") ". ";font-variant-numeric:tabular-nums}

    .doc-content [data-doc-hidden="true"] { display:none !important; }
    .doc-content thead {display:table-header-group}
    .doc-content tfoot {display:table-footer-group}
    .doc-content tr {break-inside:avoid}
    .doc-content p {orphans:3;widows:3}
    .doc-content h1,.doc-content h2,.doc-content h3,.doc-content h4,.doc-content h5,.doc-content h6 {break-after:avoid}
    .doc-content .doc-running-header,.doc-content .doc-running-footer {font-size:11px;color:#666;border-bottom:1px solid #ddd;padding:4px}
    .doc-content .doc-page-number:after {content:'Page number (print)';font-size:11px;color:#666}

    .doc-content .doc { max-width: 800px; margin: 0 auto; }
    .doc-content .doc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 12px; margin-bottom: 16px; gap: 20px; }
    .doc-content .doc-company h1 { margin: 0 0 4px; font-size: 20px; }
    .doc-content .doc-meta { text-align: right; white-space: nowrap; }
    .doc-content .doc-meta h2 { margin: 0 0 6px; font-size: 16px; letter-spacing: 0.05em; }
    .doc-content .doc-parties { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
    .doc-content .doc-table { width: 100%; border-collapse: collapse; margin: 12px 0 14px; font-size: 12.5px; }
    .doc-content .doc-table th, .doc-content .doc-table td { border: 1px solid #d7dee8; padding: 7px 10px; text-align: left; vertical-align: top; }
    .doc-content .doc-table th { background: #f4f7fb; font-weight: 600; color: #1a2740; }
    .doc-content .doc-table thead th { border-bottom: 2px solid #ccd6e2; }
    .doc-content .doc-table.striped tbody tr:nth-child(even) td { background: #f8fafc; }
    .doc-content .doc-table.shaded thead th { background: #16243d; color: #fff; border-bottom-color: #16243d; }
    .doc-content .doc-table.plain th, .doc-content .doc-table.plain td { border: 0; }
    .doc-content .doc-table.plain thead th { border-bottom: 1px solid #ccd6e2; }
    .doc-content .doc-table .r { text-align: right; }
    .doc-content .doc-float { position: absolute; box-sizing: border-box; }
    .doc-content .doc-float-shape { width: 100%; height: 100%; box-sizing: border-box; }
    .doc-content .doc-float-body { width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; padding: 4px; }
    .doc-content .doc-float[data-float-kind="image"] img { width: 100%; height: 100%; object-fit: contain; }
    .doc-content .doc-totals { margin-left: auto; width: 280px; text-align: right; }
    .doc-content .doc-totals .grand { font-size: 15px; font-weight: 700; border-top: 2px solid #222; margin-top: 6px; padding-top: 6px; }
    .doc-content .doc-notes { margin-top: 14px; }
    .doc-content .doc-foot { margin-top: 28px; color: #666; font-size: 11px; border-top: 1px solid #ddd; padding-top: 8px; }
    .doc-content .muted { color: #777; font-size: 11px; }


    .doc-content h1 {font-size:22px;font-weight:700;margin:0 0 4px}
    .doc-content h2 {font-size:17px;font-weight:700;margin:0 0 6px}
    .doc-content h3 {font-size:15px;font-weight:700}
    .doc-content table {width:100%;border-collapse:collapse;margin:12px 0 14px;font-size:12.5px}
    .doc-content td,.doc-content th {border:1px solid #d7dee8;padding:7px 10px;min-width:34px;vertical-align:top;font-size:inherit;letter-spacing:normal;text-transform:none;color:inherit}
    .doc-content p {margin:1em 0}
    .doc-content tbody tr:hover td {background-color:inherit}
    .doc-content th {text-align:left;font-weight:600;background:#f4f7fb;color:#1a2740}
`;
  const PRINT_CSS = documentCss + `
    html, body { margin:0; padding:0; background:#fff; }
    @page { margin:14mm; }
    @media screen { body { padding:24px; background:#eef0f3; } .doc-print-content { background:#fff; margin:0 auto; } }
  `;

  /** Print a pop-up written with document.write() once its images / SVGs have loaded. It is
      triggered from this page (the opener): a <script> inside the written document would be
      blocked by the Content-Security-Policy, which about:blank windows inherit. */
  function printWhenLoaded(w) {
    let done = false;
    const go = () => { if (done) return; done = true; try { w.focus(); w.print(); } catch (e) { /* closed */ } };
    if (w.document.readyState === 'complete') setTimeout(go, 50);
    else { w.addEventListener('load', go, { once: true }); setTimeout(go, 1500); }
  }

  /** Same content typography in the editor and standalone output. Saved float
   * percentages use the full paper as their reference, while print @page margins
   * leave a smaller content box: translate those coordinates into physical units. */
  function printableHtml(html, title) {
    const source = String(html || '');
    const setup = source.match(/<style\b[^>]*\bdata-docpage(?=[\s=>])[^>]*>([\s\S]*?)<\/style>/i);
    const size = setup && setup[1].match(/size:\s*([\d.]+)mm\s+([\d.]+)mm/i);
    const margin = setup && setup[1].match(/margin:\s*([\d.]+)mm/i);
    let content = source, pageCss = '';
    if (size) {
      const w = Number(size[1]), h = Number(size[2]), m = margin ? Number(margin[1]) : 14;
      const container = document.createElement('div'); container.innerHTML = source;
      if (!/class=["'][^"']*tiled-grid/.test(source)) container.querySelectorAll('.doc-float').forEach((el) => {
        if (el.parentElement.closest('.doc-float,[data-doc-design-page]')) return;
        ['left','top','width','height'].forEach((key) => {
          const value = el.style[key];
          if (!/^-?[\d.]+%$/.test(value)) return;
          const length = key === 'left' || key === 'width' ? w : h;
          const offset = key === 'left' || key === 'top' ? m : 0;
          el.style[key] = (parseFloat(value) * length / 100 - offset) + 'mm';
        });
      });
      content = `<div class="doc-print-content">${container.innerHTML}</div>`;
      pageCss = `.doc-print-content{position:relative;isolation:isolate;width:${Math.max(1,w-2*m)}mm;min-height:${Math.max(1,h-2*m)}mm} @media print{.doc-print-content{width:100%;min-height:0}}`;
    }
    // Chromium supports paged-media margin boxes. Keep running text in screen
    // preview; move its text into paper margins when printing, with safe CSS strings.
    const running = document.createElement('div'); running.innerHTML = source;
    const cssText = (value) => '"' + String(value).replace(/[\\"<>\n\r\f]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"';
    running.querySelectorAll('[data-doc-section]').forEach((section,i)=>{const w=Number(section.dataset.docSectionWidth),h=Number(section.dataset.docSectionHeight),m=Number(section.dataset.docSectionMargin);if(w>=50&&w<=1000&&h>=50&&h<=1000&&m>=0&&m<=100&&m*2<Math.min(w,h)){const name='docsection'+i;pageCss+=`@page ${name}{size:${w}mm ${h}mm;margin:${m}mm} [data-doc-section="${section.dataset.docSection.replace(/[^a-zA-Z0-9_-]/g,'')}"]{page:${name};width:${w-m*2}mm}`;}});
    const header = running.querySelector('.doc-running-header')?.textContent || '';
    const footer = running.querySelector('.doc-running-footer')?.textContent || '';
    const numbered = !!running.querySelector('.doc-page-number');
    if (header || footer || numbered) pageCss += `@page { @top-center {content:${cssText(header)};font:10px Arial;color:#666} @bottom-center {content:${cssText(footer)}${numbered ? ' " · Page " counter(page) " of " counter(pages)' : ''};font:10px Arial;color:#666} } @media print { .doc-running-header,.doc-running-footer,.doc-page-number {display:none!important} }`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${esc(title || 'Document')}</title>` +
      `<style>${PRINT_CSS}${pageCss}</style></head><body class="doc-content">${content}</body></html>`;
  }

  /** Parent-driven layout also works in script-disabled preview iframes. */
  function loadPrintFrame(frame, html, fit) {
    frame._printReady = new Promise((resolve, reject) => {
      frame.onload = async () => {
        try {
          const doc = frame.contentDocument;
          if (!doc) throw new Error('Print preview could not load');
          await doc.fonts?.ready;
          if (fit) await fit(doc);
          const result = window.DocPagination ? await window.DocPagination.paginate(doc) : {pages:0,warnings:[]};
          frame.dataset.pageCount = result.pages;
          frame.dataset.paginationWarning = result.warnings.join(' ');
          resolve(result);
        } catch(error) { reject(error); }
      };
      frame.srcdoc = html;
    });
    frame._printReady.catch(error => toast(error.message, 'error'));
    return frame._printReady;
  }
  async function printFrame(frame) {
    if (frame._printReady) await frame._printReady;
    if (!frame.isConnected) return;
    frame.contentWindow.focus(); frame.contentWindow.print();
  }

  /* ---------- Inline SVG icons (Lucide-style, stroke = currentColor) ---------- */
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    inventory: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    forms: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    messages: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
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
    return `<button type="button" class="help-icon" aria-label="Help: ${esc(text)}" aria-expanded="false" data-tip="${esc(text)}">?</button>`;
  }

  /* Tooltip controller: hover (mouse) + tap/click (touch) → floating bubble.
     Delegated off any [data-tip] element, not just .help-icon, so plain hoverable
     controls (e.g. the permission chips in Accounts) get the same bubble without
     each needing their own show/hide wiring. .help-icon relies on click-to-show
     for touch devices, so its click still opens the tip rather than toggling it
     away like a generic target would. */
  (function initHelpTips() {
    let tip = null, target = null, pinned = false, seq = 0, previousDescription = null;
    const hide = () => {
      if (target) { if (previousDescription) target.setAttribute('aria-describedby', previousDescription); else target.removeAttribute('aria-describedby'); if (target.classList.contains('help-icon')) target.setAttribute('aria-expanded', 'false'); }
      if (tip) tip.remove(); tip = null; target = null; pinned = false;
    };
    function show(el, pin = false) {
      hide(); const text = el.getAttribute('data-tip'); if (!text) return;
      target = el; pinned = pin; previousDescription = el.getAttribute('aria-describedby');
      tip = document.createElement('div'); tip.className = 'help-tip'; tip.id = 'help-tip-' + (++seq); tip.setAttribute('role', 'tooltip'); tip.textContent = text;
      document.body.appendChild(tip); el.setAttribute('aria-describedby', [previousDescription, tip.id].filter(Boolean).join(' '));
      if (el.classList.contains('help-icon')) el.setAttribute('aria-expanded', 'true');
      const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      let top = r.top - tr.height - 8; if (top < 8) top = r.bottom + 8;
      tip.style.top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8)) + 'px';
      tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8)) + 'px';
    }
    document.addEventListener('mouseover', e => { const h = e.target.closest?.('[data-tip]'); if (h && !pinned) show(h); });
    document.addEventListener('mouseout', e => { const h = e.target.closest?.('[data-tip]'); if (h && !pinned && document.activeElement !== h && !h.contains(e.relatedTarget)) hide(); });
    document.addEventListener('focusin', e => { const h = e.target.closest?.('[data-tip]'); if (h) show(h); });
    document.addEventListener('focusout', e => { if (e.target === target) hide(); });
    document.addEventListener('click', e => {
      const h = e.target.closest?.('.help-icon');
      if (h) { e.preventDefault(); e.stopPropagation(); if (target === h && pinned) hide(); else show(h, true); }
      else hide();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && tip) { e.preventDefault(); e.stopPropagation(); hide(); } }, true);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);

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
    nameControls, esc, toast, fmtDate, fmtDateShort, fmtBytes, money, initials, modal, confirmDialog, PLACEHOLDER_PHOTO,
    drawer, contextMenu, closeContextMenu, printableHtml, printWhenLoaded, documentCss, loadPrintFrame, printFrame, combo,
    icon, helpIcon, emptyState, fileIconName, downloadCsv, csvImportModal,
  };
})();
