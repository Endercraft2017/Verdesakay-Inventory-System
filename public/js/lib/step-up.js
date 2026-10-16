/* Shared accessible security confirmation. Passwords/codes live only in the current form. */
(function () {
  'use strict';
  var pending = null, abort = null;
  function verify(options) {
    if (pending) return pending;
    var work = new Promise(function (resolve, reject) {
      var previous = document.activeElement, finished = false;
      var dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Confirm account change');
      dialog.style.font = 'inherit'; dialog.style.borderRadius = '16px';
      dialog.style.background = 'var(--surface, var(--m-surface, Canvas))';
      dialog.style.color = 'var(--text, var(--m-text, CanvasText))';
      dialog.style.border = '1px solid var(--border-strong, var(--m-border, currentColor))';
      dialog.style.maxWidth = 'min(92vw, 28rem)'; dialog.style.boxSizing = 'border-box';
      dialog.style.maxHeight = '90vh'; dialog.style.overflowY = 'auto';
      var form = document.createElement('form');
      function text(tag, value) { var n = document.createElement(tag); n.textContent = value; return n; }
      form.appendChild(text('h2', 'Confirm account change'));
      form.appendChild(text('p', 'Your change has not been saved. Confirm your identity to continue.'));
      function field(id, label, type, autocomplete) {
        var l = text('label', label); l.htmlFor = id; l.style.display = 'block';
        var input = document.createElement('input'); input.id = id; input.type = type;
        input.autocomplete = autocomplete; input.style.display = 'block'; input.style.marginBottom = '1rem'; input.style.minHeight = '44px'; input.style.boxSizing = 'border-box';
        form.appendChild(l); form.appendChild(input); return input;
      }
      var password = field('vds-stepup-password', 'Current password', 'password', 'current-password');
      password.required = true; password.maxLength = 256;
      var code = field('vds-stepup-code', 'Authenticator or one-use recovery code (if enabled)', 'text', 'one-time-code');
      code.maxLength = 20; code.required = !!options.mfaRequired;
      var error = text('p', ''); error.setAttribute('role', 'alert'); form.appendChild(error);
      var confirm = text('button', 'Verify and continue'); confirm.type = 'submit';
      var cancel = text('button', 'Cancel'); cancel.type = 'button';
      confirm.className = window.MApp ? 'm-btn' : 'btn'; cancel.className = window.MApp ? 'm-btn m-btn-secondary' : 'btn secondary';
      var actions = document.createElement('div'); actions.style.display = 'flex'; actions.style.gap = '8px'; actions.style.flexWrap = 'wrap';
      [confirm, cancel].forEach(function (button) { button.style.minHeight = '44px'; button.style.minWidth = '44px'; button.style.width = 'auto'; });
      actions.appendChild(confirm); actions.appendChild(cancel); form.appendChild(actions); dialog.appendChild(form);
      function finish(failure) {
        if (finished) return; finished = true;
        password.value = ''; code.value = ''; abort = null;
        if (dialog.open) dialog.close(); dialog.remove();
        if (previous && previous.isConnected && previous.focus) previous.focus();
        if (failure) reject(failure); else resolve();
      }
      abort = function () { finish(new Error('Verification cancelled. Your change was not saved.')); };
      cancel.onclick = abort;
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); abort && abort(); });
      dialog.addEventListener('close', function () { if (!finished) finish(new Error('Verification cancelled.')); });
      form.onsubmit = async function (event) {
        event.preventDefault(); confirm.disabled = true; error.textContent = '';
        try {
          if (!options.stillCurrent()) throw new Error('Sign-in or company changed. Start again.');
          var body = { password: password.value }; if (code.value.trim()) body.code = code.value.trim();
          await API.post('/auth/step-up', body, { expectedServer: options.server });
          if (!options.stillCurrent()) throw new Error('Sign-in or company changed. Start again.');
          finish();
        } catch (failure) {
          error.textContent = failure.message;
          if (failure.data && failure.data.mfa_required) code.required = true;
        } finally { password.value = ''; code.value = ''; confirm.disabled = false; }
      };
      document.body.appendChild(dialog);
      if (typeof dialog.showModal !== 'function') { finish(new Error('Update your browser to verify this action.')); return; }
      dialog.showModal(); password.focus();
    });
    pending = work.finally(function () { pending = null; });
    return pending;
  }
  window.AuthStepUp = { verify: verify, cancel: function () { if (abort) abort(); } };
})();
