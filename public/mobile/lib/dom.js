/* Tiny DOM helpers for the mobile views (no framework). Exposed as globals. */
(function () {
  window.mEsc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** Build one element from an HTML string. */
  window.mEl = function (html) {
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  };

  window.mToast = function (msg, kind) {
    var host = document.getElementById('m-toasts');
    var t = mEl('<div class="m-toast ' + (kind || '') + '">' + mEsc(msg) + '</div>');
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 250);
    }, 2600);
  };

  /** A number field with -/+ steppers. Returns { el, value() }. */
  window.mQtyField = function (label, initial) {
    var wrap = mEl(
      '<label class="m-field"><span class="m-label">' + mEsc(label) + '</span>' +
      '<span class="m-qty">' +
      '<button type="button" data-d="-1" aria-label="less">&minus;</button>' +
      '<input type="number" inputmode="numeric" min="1" step="1" value="' + (initial || 1) + '" />' +
      '<button type="button" data-d="1" aria-label="more">+</button>' +
      '</span></label>'
    );
    var input = wrap.querySelector('input');
    wrap.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        var n = parseInt(input.value, 10) || 0;
        n += parseInt(b.dataset.d, 10);
        if (n < 1) n = 1;
        input.value = n;
      };
    });
    return { el: wrap, value: function () { return parseInt(input.value, 10) || 0; } };
  };

  /** Standard result screen. actions: [{ label, onClick, secondary }]. */
  window.mSuccess = function (viewEl, opts) {
    var lines = (opts.lines || []).map(function (l) { return '<div class="m-success-line">' + mEsc(l) + '</div>'; }).join('');
    var box = mEl(
      '<div class="m-success">' +
      '<div class="m-success-check">&#10003;</div>' +
      '<h2>' + mEsc(opts.title || 'Done') + '</h2>' +
      lines +
      '<div class="m-actions" data-actions></div></div>'
    );
    var host = box.querySelector('[data-actions]');
    (opts.actions || []).forEach(function (a) {
      var btn = mEl('<button class="m-btn ' + (a.secondary ? 'm-btn-secondary' : '') + '">' + mEsc(a.label) + '</button>');
      btn.onclick = a.onClick;
      host.appendChild(btn);
    });
    viewEl.appendChild(box);
  };
})();
