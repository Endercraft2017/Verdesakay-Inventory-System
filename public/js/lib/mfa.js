/* Two-step sign-in screens (server: src/shared/mfa.ts, /api/auth/mfa*, /api/auth/login/mfa):
   the code prompt after the password, setting it up (QR + manual key → first code → recovery
   codes), turning it off, and new recovery codes. Used by app.js (sign-in, required set-up) and
   the Account page. */
const Mfa = (() => {
  const base = () => window.VDS_BASE_PATH || '';

  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = base() + '/mobile/vendor/qrcode.js';
      s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  /** A modal that resolves with onConfirm's value, or null when closed any other way. */
  function ask(opts, onConfirm) {
    return new Promise((resolve) => {
      let result = null;
      const m = UI.modal({
        ...opts,
        protectChanges: false,
        onConfirm: async (ov, showErr) => {
          const button = ov.querySelector('[data-confirm]');
          const label = button.textContent;
          if (opts.pendingText) button.textContent = opts.pendingText;
          ov.setAttribute('aria-busy', 'true');
          try {
            const r = await onConfirm(ov, showErr);
            if (r === false) return false;
            result = r === undefined ? true : r;
            return true;
          } finally {
            button.textContent = label;
            ov.removeAttribute('aria-busy');
          }
        },
        onClose: () => resolve(result),
      });
      setTimeout(() => { const first = m.overlay.querySelector('input'); if (first) first.focus(); }, 50);
    });
  }

  /** After a correct password: the code. Resolves with the sign-in answer, or null. */
  function askCode(mfaToken) {
    return ask({
      title: 'Two-step sign-in',
      bodyHTML: `<p class="muted" style="margin-top:0">Use the code from your authenticator app or a saved recovery code.</p>
        <div class="mfa-code-method" role="group" aria-label="Code type">
          <button type="button" class="btn secondary small" data-method="app" aria-pressed="true">Authenticator app</button>
          <button type="button" class="btn secondary small" data-method="recovery" aria-pressed="false">Recovery code</button>
        </div>
        <label for="mfa-signin-code" data-code-label>6-digit code</label>
        <input id="mfa-signin-code" data-f="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-describedby="mfa-code-help" placeholder="123456" />
        <p id="mfa-code-help" class="muted auth-help">Use the newest code. You can paste it.</p>
        <button type="button" class="btn secondary small" data-back-password>Back to password</button>
        <p class="muted auth-help" data-expired hidden>Return to your password to start a new sign-in.</p>`,
      confirmText: 'Sign in', pendingText: 'Verifying…',
      onOpen: ov => {
        const input = ov.querySelector('[data-f="code"]');
        ov.querySelectorAll('[data-method]').forEach(button => button.onclick = () => {
          const recovery = button.dataset.method === 'recovery';
          ov.querySelectorAll('[data-method]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
          input.dataset.method = button.dataset.method;
          input.value = '';
          input.removeAttribute('aria-invalid');
          input.inputMode = recovery ? 'text' : 'numeric';
          input.maxLength = recovery ? 11 : 6;
          input.placeholder = recovery ? 'a1b2c-d3e4f' : '123456';
          ov.querySelector('[data-code-label]').textContent = recovery ? 'Recovery code' : '6-digit code';
          ov.querySelector('#mfa-code-help').textContent = recovery
            ? 'Use one unused recovery code. Letters and numbers are allowed. It works only once.'
            : 'Use the newest code. You can paste it.';
          input.focus();
        });
        ov.querySelector('[data-back-password]').onclick = () => ov.querySelector('.modal-foot [data-close]').click();
        input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
      },
    }, async (ov, showErr) => {
      const input = ov.querySelector('[data-f="code"]');
      const code = input.value.trim();
      const recovery = input.dataset.method === 'recovery';
      const valid = recovery ? /^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(code) : /^[0-9]{6}$/.test(code);
      if (!valid) {
        input.setAttribute('aria-invalid', 'true');
        showErr(recovery ? 'Enter a complete recovery code.' : 'Enter a 6-digit code.');
        input.focus(); return false;
      }
      try { return await API.post('/auth/login/mfa', { mfa_token: mfaToken, code }); }
      catch (error) {
        showErr(AuthControls.errorMessage(error));
        if (/sign-in has expired/i.test(error.message)) ov.querySelector('[data-expired]').hidden = false;
        return false;
      }
    });
  }

  // A real copy attempt, with a selectable fallback when clipboard permissions are unavailable.
  async function copyText(value, button) {
    const label = button.textContent;
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
    } catch {
      let field = button.parentElement.querySelector('[data-copy-fallback]');
      if (!field) {
        field = document.createElement('textarea');
        field.dataset.copyFallback = '';
        field.readOnly = true;
        field.setAttribute('aria-label', 'Text to copy');
        button.parentElement.appendChild(field);
      }
      field.value = value;
      field.focus(); field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Keep the selection for manual copying. */ }
      if (copied) { field.remove(); button.focus(); button.textContent = 'Copied'; }
      else button.textContent = 'Select and copy below';
    } finally {
      button.disabled = false;
      // Restore after the next edit/action, without a timer that outlives the dialog.
      button.onblur = () => { if (button.textContent === 'Copied') button.textContent = label; };
    }
  }

  function recoveryCodesHTML(codes) {
    return `<p>Save these recovery codes somewhere safe (a password manager, or printed). Each one signs
      you in once if you lose your phone. They won't be shown again.</p>
      <pre class="mono" style="padding:10px;border:1px solid var(--border,#ddd);border-radius:8px;columns:2;user-select:all">${codes.map(UI.esc).join('\n')}</pre>`;
  }

  async function saveSetupCodes(codes) {
    await ask({
      title: 'Two-step sign-in is on',
      bodyHTML: `<p class="muted mfa-step">Step 3 of 3 · Save recovery codes</p>${recoveryCodesHTML(codes)}
        <div class="mfa-code-actions">
          <button type="button" class="btn secondary" data-copy-codes>Copy codes</button>
          <button type="button" class="btn secondary" data-download-codes>Download .txt</button>
        </div>
        <label class="mfa-saved-codes"><input type="checkbox" data-saved-codes /><span>I saved these recovery codes somewhere safe.</span></label>
        <p class="muted auth-help">Keep them private. Each code works once. Two-step sign-in is already on; this checkbox is a reminder, not a security requirement.</p>
        <p role="status" data-save-reminder></p>`,
      confirmText: 'Done', cancelText: 'Close',
      onOpen: ov => {
        ov.querySelector('[data-copy-codes]').onclick = event => copyText(codes.join('\n'), event.currentTarget);
        ov.querySelector('[data-download-codes]').onclick = () => {
          const url = URL.createObjectURL(new Blob(['Otom recovery codes — keep private\n' + codes.join('\n')], { type: 'text/plain;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url; link.download = 'otom-recovery-codes.txt';
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
      },
    }, async ov => {
      if (!ov.querySelector('[data-saved-codes]').checked) {
        ov.querySelector('[data-save-reminder]').textContent = 'Save your codes before finishing. You can still close this reminder; two-step sign-in remains on.';
        return false;
      }
      return true;
    });
  }

  /** Turn it on. `forced`: the workspace requires it (the only way out is signing out). */
  async function setup({ forced = false } = {}) {
    const started = await ask({
      title: forced ? 'Set up two-step sign-in' : 'Turn on two-step sign-in',
      bodyHTML: `<p class="muted mfa-step">Step 1 of 3 · Confirm your password</p>${forced ? '<p>Your workspace requires two-step sign-in for your account. It takes about two minutes.</p>' : ''}
        <p class="muted" style="margin-top:0">You need an authenticator app on your phone: Google Authenticator,
        Microsoft Authenticator, Authy, 1Password or similar.</p>
        <label for="mfa-setup-password">Your password</label><input id="mfa-setup-password" data-f="pw" type="password" autocomplete="current-password" />
        <p class="muted auth-help">Next: connect your authenticator, verify its code, then save your recovery codes. Nothing is enabled until verification succeeds.</p>`,
      onOpen: ov => AuthControls.passwords(ov),
      pendingText: 'Checking…', confirmText: 'Continue', cancelText: forced ? 'Sign out' : 'Cancel',
    }, async (ov, showErr) => {
      const input = ov.querySelector('[data-f="pw"]');
      if (!input.value) { showErr('Enter your current password.'); input.focus(); return false; }
      try { return await API.post('/auth/mfa/setup', { password: ov.querySelector('[data-f="pw"]').value }); }
      catch (e) { showErr(AuthControls.errorMessage(e)); return false; }
    });
    if (!started) return false;

    await loadQr();
    let qrSvg = '';
    if (window.qrcode) {
      const qr = window.qrcode(0, 'M');
      qr.addData(started.otpauth_url);
      qr.make();
      qrSvg = qr.createSvgTag({ cellSize: 4, margin: 2 });
    }
    const key = String(started.secret).replace(/(.{4})/g, '$1 ').trim();
    const codes = await ask({
      title: 'Add it to your authenticator app',
      bodyHTML: `<p class="muted mfa-step">Step 2 of 3 · Connect your authenticator</p><ol style="padding-left:18px;margin-top:0">
          <li>In the app, add an account and scan this code.</li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        <div class="mfa-qr">${qrSvg}</div>
        <p class="muted" style="font-size:12.5px">Can't scan? Enter this key instead: <span class="mono" style="user-select:all">${UI.esc(key)}</span>
          · On this phone: <a href="${UI.esc(started.otpauth_url)}">open in authenticator app</a></p>
        <div class="mfa-key-actions"><button type="button" class="btn secondary small" data-copy-key>Copy setup key</button></div>
        <label for="mfa-setup-code">Code from the app</label><input id="mfa-setup-code" data-f="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />`,
      onOpen: ov => { ov.querySelector('[data-copy-key]').onclick = event => copyText(started.secret, event.currentTarget); },
      pendingText: 'Verifying…',
      confirmText: 'Turn on', cancelText: forced ? 'Sign out' : 'Cancel',
    }, async (ov, showErr) => {
      const input = ov.querySelector('[data-f="code"]');
      if (!/^[0-9]{6}$/.test(input.value.trim())) { showErr('Enter a 6-digit code.'); input.focus(); return false; }
      try { return (await API.post('/auth/mfa/enable', { code: ov.querySelector('[data-f="code"]').value.trim() })).recovery_codes; }
      catch (e) { showErr(AuthControls.errorMessage(e)); return false; }
    });
    if (!codes) return false;
    await saveSetupCodes(codes);
    return true;
  }

  /** Turn it off (password + a current code). */
  async function disable() {
    return !!(await ask({
      title: 'Turn off two-step sign-in',
      bodyHTML: `<label>Your password</label><input data-f="pw" type="password" autocomplete="current-password" />
        <label>Code from your app (or a recovery code)</label><input data-f="code" autocomplete="one-time-code" maxlength="11" />`,
      confirmText: 'Turn off',
    }, async (ov, showErr) => {
      try { await API.post('/auth/mfa/disable', { password: ov.querySelector('[data-f="pw"]').value, code: ov.querySelector('[data-f="code"]').value.trim() }); return true; }
      catch (e) { showErr(AuthControls.errorMessage(e)); return false; }
    }));
  }

  /** Replace the recovery codes (password + a current code). */
  async function newRecoveryCodes() {
    const codes = await ask({
      title: 'New recovery codes',
      bodyHTML: `<p class="muted" style="margin-top:0">Your old recovery codes stop working.</p>
        <label>Your password</label><input data-f="pw" type="password" autocomplete="current-password" />
        <label>Code from your app</label><input data-f="code" autocomplete="one-time-code" maxlength="11" />`,
      confirmText: 'Get new codes',
    }, async (ov, showErr) => {
      try { return (await API.post('/auth/mfa/recovery-codes', { password: ov.querySelector('[data-f="pw"]').value, code: ov.querySelector('[data-f="code"]').value.trim() })).recovery_codes; }
      catch (e) { showErr(AuthControls.errorMessage(e)); return false; }
    });
    if (codes) await ask({ title: 'Your new recovery codes', bodyHTML: recoveryCodesHTML(codes), confirmText: 'I saved them', cancelText: 'Close' }, async () => true);
  }

  return { askCode, setup, disable, newRecoveryCodes };
})();
