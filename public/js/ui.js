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

  /* Modal: opts = { title, bodyHTML, confirmText, onConfirm(modalEl)->bool|Promise, size } */
  function modal(opts) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h3>${esc(opts.title)}</h3>
          <button class="icon-btn close" data-close>✕</button>
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

  return { esc, toast, fmtDate, fmtDateShort, fmtBytes, initials, modal, confirmDialog };
})();
