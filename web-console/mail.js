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

  async function read(path, controller) {
    controller = controller || new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    try { return await api('GET', path, undefined, undefined, undefined, controller.signal); }
    catch (error) { if (controller.signal.aborted) throw new Error('Delivery status refresh timed out. Try again.'); throw error; }
    finally { clearTimeout(timer); }
  }
  function healthRows(h) {
    if (!h) return el('p', {text:'No delivery health observation. Refresh to check.'});
    var states = {unobserved:'Not yet observed',disabled:'Disabled on this server',stale:'Heartbeat is stale',failed:'Last pass failed',clock_invalid:'Check server clock',invalid:'Heartbeat data is invalid',running:'Pass running',idle:'Last pass found no due job',processed:'Last pass processed a job'};
    return el('div', {}, [
      el('p', {text:'Recorded alerts: ' + h.total + ' · Due now: ' + h.due + ' · Needs review: ' + h.attention}),
      el('p', {text:['pending','retry','inflight','accepted','blocked','unknown','cancelled'].map(function (state) {return state + ': ' + h.counts[state];}).join(' · ')}),
      el('p', {text:'Worker: ' + (states[h.worker.state] || 'Observation unavailable') + '. A processed job does not confirm inbox delivery.'}),
      el('p', {class:'muted',text:'Checked ' + new Date(h.checked_at).toLocaleString() + (h.oldest_queued_at == null ? '' : ' · Oldest queued: ' + new Date(h.oldest_queued_at).toLocaleString())}),
    ]);
  }

  function logRows(log) {
    if (!log || !log.length) return el('div', { class: 'muted', text: 'Nothing sent yet.' });
    return el('div', { class: 'log' }, log.slice(0, 8).map(function (r) {
      return el('div', { class: 'e' }, [
        el('span', { class: 'when', text: r.created_at + '  ' }),
        el('span', { text: (r.status === 'sent' ? '✓ ' : '✗ ') + r.subject + ' → ' + r.to_addr + (r.error ? ' — ' + r.error : '') }),
      ]);
    }));
  }

  function outboxRows(rows) {
    var labels = { pending: 'Queued', retry: 'Waiting to retry', inflight: 'Sending', accepted: 'Accepted by provider',
      blocked: 'Needs attention', unknown: 'Delivery uncertain — check provider records before resending', cancelled: 'Cancelled' };
    if (!rows || !rows.length) return el('p', { class: 'muted', text: 'No delivery records in this view.' });
    return el('div', {}, rows.map(function (r) {
      return el('p', { text: (r.kind === 'inquiry' ? 'Website inquiry #' + r.source_id : r.kind === 'payment' ? r.tenant_slug + ' payment #' + r.source_id : r.tenant_slug) + ': ' + (labels[r.state] || 'Needs attention') +
        ' · created ' + new Date(r.created_at).toLocaleString() + ' · event ' + r.id + ' · attempts ' + r.attempts + (r.error_code ? ' · ' + r.error_code : '') });
    }));
  }

  async function open() {
    var d;
    try { d = await read('/mail'); } catch (ex) { toast(ex.message); return; }
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
    var queueBox = el('div', { id: 'm-outbox', role: 'status', 'aria-live': 'polite' }, [outboxRows(d.outbox)]);
    var healthBox = el('div', {id:'m-health',role:'status','aria-live':'polite'}, [healthRows(d.delivery_health)]);
    var historyBox = el('div', {id:'m-history',role:'status','aria-live':'polite'}, [el('p',{text:'Loading delivery history…'})]);
    var historyFilter = el('select',{id:'m-history-filter'}, [['attention','Needs review'],['queued','Queued or sending'],['all','All delivery records']].map(function (pair) {return el('option',{value:pair[0],text:pair[1]});}));
    var older = el('button',{id:'m-older',type:'button',class:'btn ghost',disabled:'disabled'},['Load older records']);
    var nextCursor = null, historyRows = [], busy = false, activeController = null, renderedFilter = 'attention';
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
      el('div', { class: 'field', style: 'margin-top:16px' }, [el('h3', { text: 'Owner alert delivery' }),
        el('p', { class: 'muted', text: 'Signup, inquiry and payment alerts are queued durably. Provider acceptance does not confirm inbox delivery.' }),
        healthBox, queueBox, el('button', { class: 'btn ghost', id: 'm-refresh', type: 'button' }, ['Refresh delivery status']),
        el('label',{for:'m-history-filter',text:'Delivery history'}), historyFilter,
        el('p',{class:'muted',text:'Includes older records across signup, inquiry and payment alerts. Review stored failures against provider records before any resend. Manual review does not change their stored state.'}),
        historyBox, older]),
      el('div', { class: 'field', style: 'margin-top:16px' }, [el('label', { text: 'Recent email attempts' }), logBox]),
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
      queueBox.replaceChildren(outboxRows(r.outbox));
      healthBox.replaceChildren(healthRows(r.delivery_health));
      return r;
    }
    function historyPath(cursor) {
      return '/mail/delivery?filter=' + encodeURIComponent(historyFilter.value) + '&limit=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    }
    function validatePage(page) {
      if (!page || page.filter !== historyFilter.value || !Array.isArray(page.rows) || !page.health || !Number.isFinite(page.health.checked_at) || !page.health.worker || !page.health.counts || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) throw new Error('Delivery status was not confirmed. Refresh again.');
      return page;
    }
    function setBusy(on) {
      busy = on; historyFilter.disabled = on; $('m-refresh').disabled = on; older.disabled = on || !nextCursor;
    }
    async function loadHistory(append, refreshRecent) {
      if (busy) return;
      setBusy(true); activeController = new AbortController();
      try {
        var path = historyPath(append ? nextCursor : null);
        var results = await Promise.all([read(path, activeController), refreshRecent ? read('/mail', activeController) : Promise.resolve(null)]);
        var page = validatePage(results[0]);
        if (!modal.isConnected) return;
        if (refreshRecent) {
          if (!results[1] || !Array.isArray(results[1].outbox)) throw new Error('Delivery status was not confirmed. Refresh again.');
          queueBox.replaceChildren(outboxRows(results[1].outbox));
        }
        historyRows = append ? historyRows.concat(page.rows) : page.rows;
        nextCursor = page.next_cursor; renderedFilter = page.filter;
        historyBox.replaceChildren(outboxRows(historyRows)); healthBox.replaceChildren(healthRows(page.health)); $('m-err').textContent = '';
      } catch (ex) { if (modal.isConnected) { historyFilter.value = renderedFilter; $('m-err').textContent = ex.message; } }
      finally { activeController = null; if (modal.isConnected) setBusy(false); }
    }
    $('m-refresh').addEventListener('click', function () { loadHistory(false, true); });
    historyFilter.addEventListener('change', function () { loadHistory(false, false); });
    older.addEventListener('click', function () { if (nextCursor) loadHistory(true, false); });
    $('m-cancel').addEventListener('click', function () { if (activeController) activeController.abort(); modal.remove(); });
    void loadHistory(false, false);
    $('m-save').addEventListener('click', async function () {
      try { await save(); toast('Email settings saved'); } catch (ex) { $('m-err').textContent = ex.message; }
    });
    $('m-test').addEventListener('click', async function () {
      $('m-err').textContent = '';
      $('m-test').disabled = true; $('m-test').textContent = 'Sending…';
      try {
        await save();
        var r = await api('POST', '/mail/test', {});
        if (r.log) logBox.replaceChildren(logRows(r.log));
        if (r.ok) toast('Test email sent — check your inbox (and spam)'); else $('m-err').textContent = r.error || 'The test email failed.';
      } catch (ex) { $('m-err').textContent = ex.message; }
      $('m-test').disabled = false; $('m-test').textContent = 'Send test email';
    });
  }

  $('mail-btn').addEventListener('click', open);
  window.ConsoleMail = { open: open };
})();
