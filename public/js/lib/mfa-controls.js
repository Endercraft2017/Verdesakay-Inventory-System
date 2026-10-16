/* Shared account-security controls. Secrets/recovery codes remain in memory, never web storage. */
window.MfaControls = {
  render: function (host) {
    var pending = false;
    host.replaceChildren();
    function node(tag, text) { var el = document.createElement(tag); if (text) el.textContent = text; return el; }
    var heading = node('h3', 'Authenticator security');
    var status = node('p', 'Loading security status…');
    var form = node('form');
    var passLabel = node('label', 'Current password');
    var pass = node('input'); pass.type = 'password'; pass.autocomplete = 'current-password'; pass.required = true;
    passLabel.appendChild(pass);
    var codeLabel = node('label', 'Authenticator or recovery code');
    var code = node('input'); code.autocomplete = 'one-time-code'; code.maxLength = 24;
    codeLabel.appendChild(code);
    var output = node('pre'); output.style.whiteSpace = 'pre-wrap'; output.style.overflowWrap = 'anywhere';
    var error = node('p'); error.setAttribute('role', 'status');
    var submit = node('button'); submit.className = 'btn m-btn'; submit.type = 'submit'; submit.disabled = true;
    form.append(passLabel, codeLabel, submit);
    host.append(heading, status, form, output, error);
    var enabled = false;
    API.get('/auth/mfa').then(function (state) {
      enabled = state.enabled; submit.disabled = false;
      status.textContent = enabled ? 'Enabled. Recovery codes left: ' + state.recovery_codes_remaining : 'Add an authenticator app. Keep your recovery codes somewhere safe outside this app.';
      submit.textContent = enabled ? 'Disable authenticator' : 'Set up authenticator';
    }).catch(function (e) { status.textContent = e.message || 'Security status unavailable. Connect and reload this page.'; });
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true; error.textContent = '';
      try {
        if (!enabled && !pending) {
          var setup = await API.post('/auth/mfa/setup', { current_password: pass.value });
          output.textContent = 'In your authenticator app, add a time-based account named Verdesakay. Enter this setup key:\n' + setup.secret + '\n\nThen enter its six-digit code above and enable it. Setup expires in 10 minutes.';
          code.required = true; pending = true; submit.textContent = 'Enable authenticator'; code.focus();
        } else {
          if (enabled && !window.confirm('Disable authenticator protection? All sessions will end.')) return;
          var result = await API.post(enabled ? '/auth/mfa/disable' : '/auth/mfa/enable', { current_password: pass.value, code: code.value.trim() });
          pass.value = ''; code.value = ''; form.remove(); API.clearToken();
          status.textContent = result.enabled ? 'Enabled. All sessions ended. Save these one-use recovery codes before returning to sign in. Wait for a new authenticator code before signing in.' : 'Disabled. All sessions ended. Sign in again.';
          output.textContent = result.recovery_codes ? result.recovery_codes.join('\n') : '';
          var back = node('button', result.enabled ? 'I saved my codes — return to sign in' : 'Return to sign in'); back.className = 'btn m-btn';
          back.onclick = function () { location.reload(); };
          var dialog = node('dialog'); dialog.setAttribute('aria-label', 'Authenticator security result');
          dialog.style.maxWidth = 'min(90vw, 600px)';
          dialog.addEventListener('cancel', function (e) { e.preventDefault(); });
          dialog.append(status, output, back); document.body.appendChild(dialog); dialog.showModal(); back.focus();
        }
      } catch (e) { error.textContent = e.message || 'Security change failed. Try again.'; }
      finally { submit.disabled = false; }
    });
  },
};
