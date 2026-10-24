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
      UI.modal({
        ...opts,
        protectChanges: false,
        onConfirm: async (ov, showErr) => {
          const r = await onConfirm(ov, showErr);
          if (r === false) return false;
          result = r === undefined ? true : r;
          return true;
        },
        onClose: () => resolve(result),
      });
      // UI.modal sets initial focus; preserve the user's subsequent focus movement.
    });
  }

  /** After a correct password: the code. Resolves with the sign-in answer, or null. */
  function askCode(mfaToken) {
    return ask({
      title: 'Two-step sign-in',
      bodyHTML: `<p class="muted" style="margin-top:0">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
        <input data-f="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="123456" />`,
      confirmText: 'Sign in',
    }, async (ov, showErr) => {
      const code = ov.querySelector('[data-f="code"]').value.trim();
      if (!code) { showErr('Enter the code.'); return false; }
      try { return await API.post('/auth/login/mfa', { mfa_token: mfaToken, code }); }
      catch (e) { showErr(e.message); return false; }
    });
  }

  function recoveryCodesHTML(codes) {
    return `<p>Save these recovery codes somewhere safe (a password manager, or printed). Each one signs
      you in once if you lose your phone. They won't be shown again.</p>
      <pre class="mono" style="padding:10px;border:1px solid var(--border,#ddd);border-radius:8px;columns:2;user-select:all">${codes.map(UI.esc).join('\n')}</pre>`;
  }

  /** Turn it on. `forced`: the workspace requires it (the only way out is signing out). */
  async function setup({ forced = false } = {}) {
    const started = await ask({
      title: forced ? 'Set up two-step sign-in' : 'Turn on two-step sign-in',
      bodyHTML: `${forced ? '<p>Your workspace requires two-step sign-in for your account. It takes about two minutes.</p>' : ''}
        <p class="muted" style="margin-top:0">You need an authenticator app on your phone: Google Authenticator,
        Microsoft Authenticator, Authy, 1Password or similar.</p>
        <label>Your password</label><input data-f="pw" type="password" autocomplete="current-password" />`,
      confirmText: 'Continue', cancelText: forced ? 'Sign out' : 'Cancel',
    }, async (ov, showErr) => {
      try { return await API.post('/auth/mfa/setup', { password: ov.querySelector('[data-f="pw"]').value }); }
      catch (e) { showErr(e.message); return false; }
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
      bodyHTML: `<ol style="padding-left:18px;margin-top:0">
          <li>In the app, add an account and scan this code.</li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        <div style="text-align:center">${qrSvg}</div>
        <p class="muted" style="font-size:12.5px">Can't scan? Enter this key instead: <span class="mono" style="user-select:all">${UI.esc(key)}</span>
          · On this phone: <a href="${UI.esc(started.otpauth_url)}">open in authenticator app</a></p>
        <label>Code from the app</label><input data-f="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />`,
      confirmText: 'Turn on', cancelText: forced ? 'Sign out' : 'Cancel',
    }, async (ov, showErr) => {
      try { return (await API.post('/auth/mfa/enable', { code: ov.querySelector('[data-f="code"]').value.trim() })).recovery_codes; }
      catch (e) { showErr(e.message); return false; }
    });
    if (!codes) return false;
    await ask({ title: 'Two-step sign-in is on', bodyHTML: recoveryCodesHTML(codes), confirmText: 'I saved them', cancelText: 'Close' }, async () => true);
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
      catch (e) { showErr(e.message); return false; }
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
      catch (e) { showErr(e.message); return false; }
    });
    if (codes) await ask({ title: 'Your new recovery codes', bodyHTML: recoveryCodesHTML(codes), confirmText: 'I saved them', cancelText: 'Close' }, async () => true);
  }

  return { askCode, setup, disable, newRecoveryCodes };
})();
