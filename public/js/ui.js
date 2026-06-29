/* Shared UI helpers: escaping, toasts, modals, formatting. */
const UI = (() => {
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
    sheet: '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="3" x2="21" y1="15" y2="15"/><line x1="9" x2="9" y1="3" y2="21"/><line x1="15" x2="15" y1="3" y2="21"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M6 21v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1"/>',
    note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/><path d="M8 13h6"/><path d="M8 17h4"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="m9 16 2 2 4-4"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
    sparkles: '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M5 17l.8 2L8 19.8 6 20.6 5.2 23 4.4 20.6 2 19.8 4.4 19Z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
  };

  /** A "?" help icon with a tooltip shown on hover (desktop) and tap (mobile).
      The tip text lives in data-tip; a single delegated controller (below) shows
      a body-level bubble so it never gets clipped by a scrolling modal. */
  function helpIcon(text) {
    if (!text) return '';
    return `<button type="button" class="help-icon" aria-label="${esc(text)}" data-tip="${esc(text)}">?</button>`;
  }

  /* Tooltip controller: hover (mouse) + tap/click (touch) → floating bubble. */
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
      const h = e.target.closest && e.target.closest('.help-icon');
      if (h) show(h);
    });
    document.addEventListener('mouseout', (e) => {
      const h = e.target.closest && e.target.closest('.help-icon');
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

  return {
    esc, toast, fmtDate, fmtDateShort, fmtBytes, initials, modal, confirmDialog,
    drawer, contextMenu, closeContextMenu,
    icon, helpIcon, emptyState, fileIconName, downloadCsv,
  };
})();
