/* Owner console — Email alerts (src/platform/platform-mail.ts). The platform mailbox that emails
   you when a website inquiry arrives, a customer reports a payment, or someone signs up. Brevo
   (HTTPS API, works on any Railway plan) or SMTP (Gmail etc.; Railway blocks SMTP below Pro).
   The API key / password is write-only: this screen only shows whether one is saved. */
(function () {
  'use strict';
  var C = window.Console;
  var api = C.api, el = C.el, toast = C.toast, $ = C.$;

  var HELP = {
    brevo: 'Free Brevo account (brevo.com) → Senders: verify the email you send from → SMTP & API → API keys → create a key and paste it below. Works on any Railway plan.',
    smtp: 'Gmail: turn on 2-Step Verification, create an App Password (Google Account → Security → App passwords) and use smtp.gmail.com, port 587, your Gmail address as the user. Railway only allows SMTP on its Pro plan.',
    off: 'No emails are sent. Inquiries and payments still show in the console.',
  };

  function logRows(log) {
    if (!log || !log.length) return el('div', { class: 'muted', text: 'Nothing sent yet.' });
    return el('div', { class: 'log' }, log.slice(0, 8).map(function (r) {
      return el('div', { class: 'e' }, [
        el('span', { class: 'when', text: r.created_at + '  ' }),
        el('span', { text: (r.status === 'sent' ? '✓ ' : '✗ ') + r.subject + ' → ' + r.to_addr + (r.error ? ' — ' + r.error : '') }),
      ]);
    }));
  }

  async function open() {
    var d;
    try { d = await api('GET', '/mail'); } catch (ex) { toast(ex.message); return; }
    var s = d.settings;
    var transport = el('select', { id: 'm-transport' }, [['off', 'Off'], ['brevo', 'Brevo (recommended)'], ['smtp', 'SMTP (Gmail or other)']].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: o[0] === s.transport ? 'selected' : null });
    }));
    var help = el('p', { class: 'muted', id: 'm-help' });
    var smtpBox = el('div', { id: 'm-smtp' }, [
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'SMTP server' }), el('input', { id: 'm-host', value: s.smtp_host, placeholder: 'smtp.gmail.com' })]),
        el('div', { class: 'field' }, [el('label', { text: 'Port' }), el('input', { id: 'm-port', type: 'number', value: String(s.smtp_port) })]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'SMTP user' }), el('input', { id: 'm-user', value: s.smtp_user, placeholder: 'you@gmail.com' })]),
      el('div', { class: 'field' }, [el('label', { for: 'm-secure' }, [el('input', { id: 'm-secure', type: 'checkbox', checked: s.smtp_secure ? 'checked' : null }), ' Use SSL (port 465). Leave off for 587.'])]),
    ]);
    var secretLabel = el('label', { id: 'm-secret-label' });
    var logBox = el('div', { id: 'm-log' }, [logRows(d.log)]);
    var check = function (id, label, on) { return el('label', { for: id, style: 'font-weight:400' }, [el('input', { id: id, type: 'checkbox', checked: on ? 'checked' : null }), ' ' + label]); };
    var card = el('div', { class: 'card', style: 'max-width:560px;max-height:90vh;overflow-y:auto' }, [
      el('h2', { text: 'Email alerts' }),
      el('div', { class: 'field' }, [el('label', { text: 'Send with' }), transport, help]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'From name' }), el('input', { id: 'm-fromname', value: s.from_name })]),
        el('div', { class: 'field' }, [el('label', { text: 'From address' }), el('input', { id: 'm-from', value: s.from_email, placeholder: 'alerts@yourdomain.com' })]),
      ]),
      smtpBox,
      el('div', { class: 'field' }, [secretLabel, el('input', { id: 'm-secret', type: 'password', autocomplete: 'off',
        placeholder: s.has_secret ? 'Saved — leave empty to keep it' : '' })]),
      el('label', { for: 'm-clear-secret' }, [el('input', { id: 'm-clear-secret', type: 'checkbox' }), ' Clear saved key / password']),
      el('div', { class: 'field' }, [el('label', { text: 'Send alerts to (comma-separated)' }), el('input', { id: 'm-to', value: s.alert_to, placeholder: 'you@example.com' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Email me when' }),
        check('m-a-inq', 'a website inquiry arrives', s.alert_inquiry),
        check('m-a-pay', 'a customer reports a payment', s.alert_payment),
        check('m-a-sign', 'someone signs up on the website', s.alert_signup)]),
      el('div', { class: 'err', id: 'm-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px;flex-wrap:wrap' }, [
        el('button', { class: 'btn', id: 'm-save', type: 'button' }, ['Save']),
        el('button', { class: 'btn ghost', id: 'm-test', type: 'button' }, ['Send test email']),
        el('button', { class: 'btn ghost', id: 'm-cancel', type: 'button' }, ['Close']),
      ]),
      el('div', { class: 'field', style: 'margin-top:16px' }, [el('label', { text: 'Recent emails' }), logBox]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);

    function sync() {
      var t = transport.value;
      help.textContent = HELP[t];
      smtpBox.classList.toggle('hidden', t !== 'smtp');
      secretLabel.textContent = t === 'brevo' ? 'Brevo API key' : t === 'smtp' ? 'SMTP password (Gmail: the App Password)' : 'Key / password';
      if (t === 'smtp' && !$('m-host').value) { $('m-host').value = 'smtp.gmail.com'; $('m-port').value = '587'; }
    }
    transport.addEventListener('change', sync); sync();

    function body() {
      return {
        transport: transport.value, from_name: $('m-fromname').value, from_email: $('m-from').value,
        smtp_host: $('m-host').value, smtp_port: $('m-port').value, smtp_user: $('m-user').value, smtp_secure: $('m-secure').checked,
        alert_to: $('m-to').value, alert_inquiry: $('m-a-inq').checked, alert_payment: $('m-a-pay').checked, alert_signup: $('m-a-sign').checked,
        secret: $('m-secret').value || undefined, clear_secret: $('m-clear-secret').checked,
      };
    }
    async function save() {
      $('m-err').textContent = '';
      var r = await api('PUT', '/mail', body());
      $('m-secret').value = '';
      $('m-clear-secret').checked = false;
      $('m-secret').placeholder = r.settings.has_secret ? 'Saved — leave empty to keep it' : '';
      logBox.replaceChildren(logRows(r.log));
      return r;
    }
    $('m-cancel').addEventListener('click', function () { modal.remove(); });
    $('m-save').addEventListener('click', async function () {
      try { await save(); toast('Email settings saved'); } catch (ex) { $('m-err').textContent = ex.message; }
    });
    $('m-test').addEventListener('click', async function () {
      $('m-err').textContent = '';
      $('m-test').disabled = true; $('m-test').textContent = 'Sending…';
      try {
        await save();
        var res = await fetch('/_platform/api/mail/test', { method: 'POST', headers: { Authorization: 'Bearer ' + C.token(), 'Content-Type': 'application/json' }, body: '{}' });
        var r = await res.json();
        if (r.log) logBox.replaceChildren(logRows(r.log));
        if (r.ok) toast('Test email sent — check your inbox (and spam)'); else $('m-err').textContent = r.error || 'The test email failed.';
      } catch (ex) { $('m-err').textContent = ex.message; }
      $('m-test').disabled = false; $('m-test').textContent = 'Send test email';
    });
  }

  $('mail-btn').addEventListener('click', open);
  window.ConsoleMail = { open: open };
})();
