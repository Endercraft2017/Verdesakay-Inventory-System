/* Owner console — Billing (docs/SAAS-READINESS.md §12). The header "Billing" button opens every
   invoice across workspaces with the review queue and the billing settings (bank, GCash + QR,
   price list for website sign-ups); each workspace also has a Billing tab with its own invoices,
   a "New invoice" prefilled from its quote, and — for a website sign-up still awaiting payment —
   a way to open it without waiting. Talks to /_platform/api/billing/* via window.Console. */
(function () {
  'use strict';
  var C = window.Console;
  var api = C.api, el = C.el, toast = C.toast, $ = C.$;
  var invoices = [];
  var settings = null;
  var filter = { q: '', status: '' };

  var peso = function (n) {
    return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var todayStr = function () { return new Date().toISOString().slice(0, 10); };
  var plusDays = function (d) { var t = new Date(); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
  var label = function (s) { return s === 'payment_submitted' ? 'needs review' : s; };
  var methodLabel = function (m) { return m === 'gcash' ? 'GCash' : m === 'bank' ? 'bank transfer' : 'recorded by operator'; };
  function badge(s, text) { return el('span', { class: 'badge ' + s, text: text || label(s) }); }

  async function loadSettings() { settings = await api('GET', '/billing/settings'); return settings; }

  /* ---------- review count in the header ---------- */
  async function refreshCount() {
    try {
      var n = (await api('GET', '/billing/invoices?status=payment_submitted')).length;
      $('review-count').textContent = String(n);
      $('review-count').classList.toggle('hidden', !n);
    } catch (e) { /* the badge is a convenience */ }
  }

  /* ---------- the cross-workspace billing view ---------- */
  var open = false;
  function toggleView(show) {
    if (show && window.ConsoleInquiries) window.ConsoleInquiries.close();
    open = show;
    document.querySelector('main.console-shell').classList.toggle('hidden', show);
    $('billing-view').classList.toggle('hidden', !show);
    $('billing-btn').firstChild.textContent = show ? 'Tenants' : 'Billing';
    if (show) loadAll();
  }
  $('billing-btn').addEventListener('click', function () { toggleView(!open); });

  async function loadAll() {
    try {
      var r = await Promise.all([api('GET', '/billing/invoices'), loadSettings()]);
      invoices = r[0];
    } catch (ex) { toast(ex.message); return; }
    paintAll();
    refreshCount();
  }

  function paintAll() {
    var root = $('billing-view');
    var statusSel = el('select', { 'aria-label': 'Invoice status', style: 'max-width:190px', onchange: function () { filter.status = this.value; paintRows(); } },
      [['', 'All invoices'], ['payment_submitted', 'Needs review'], ['open', 'Open'], ['paid', 'Paid'], ['void', 'Void']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === filter.status ? 'selected' : null });
      }));
    var search = el('input', { placeholder: 'Filter by workspace or reference…', value: filter.q, style: 'max-width:260px',
      oninput: function () { filter.q = this.value.trim().toLowerCase(); paintRows(); } });
    var count = el('span', { class: 'muted', id: 'inv-count' });
    root.replaceChildren(
      el('div', { class: 'tenant-page-heading' }, [el('div', {}, [el('h2', { text: 'Billing' }),
        el('p', { class: 'muted', text: 'Invoices to every workspace. Confirm each reported GCash or bank payment against your own records.' })])]),
      el('div', { class: 'toolbar' }, [
        el('button', { class: 'btn', type: 'button', onclick: function () { newInvoice(null); } }, ['+ New invoice']),
        el('button', { class: 'btn ghost', type: 'button', onclick: openSettings }, ['Payment details & prices']),
        statusSel, search, count,
      ]),
      el('div', { class: 'billing-table-wrap' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Reference', 'Workspace', 'Description', 'Amount', 'Balance', 'Due', 'Status'].map(function (h, i) {
          return el('th', { class: i === 3 || i === 4 ? 'num' : null, text: h });
        }))]),
        el('tbody', { id: 'inv-rows' }),
      ])])
    );
    if (settings && !settings.bank_details && !settings.gcash_number) {
      root.insertBefore(el('div', { class: 'awaiting-note' }, [
        el('span', { text: 'Customers have no payment details yet. Add your GCash and/or bank account first.' }),
        el('button', { class: 'btn small', type: 'button', onclick: openSettings }, ['Add payment details']),
      ]), root.children[1]);
    }
    paintRows();
  }

  function rowsFor(list, tb, showSlug) {
    tb.replaceChildren();
    list.forEach(function (i) {
      tb.appendChild(el('tr', { onclick: function () { openInvoice(i.id); } }, [
        el('td', { class: 'mono', text: i.reference }),
        showSlug ? el('td', { class: 'mono', text: i.tenant_slug }) : null,
        el('td', { text: i.description }),
        el('td', { class: 'num', text: peso(i.amount) }),
        el('td', { class: 'num', text: i.status === 'void' ? '–' : peso(i.balance) }),
        el('td', { text: i.due_on }),
        el('td', {}, [badge(i.status), i.overdue ? ' ' : null, i.overdue ? badge('overdue', 'overdue') : null]),
      ]));
    });
  }

  function paintRows() {
    var list = invoices.filter(function (i) {
      if (filter.status && i.status !== filter.status) return false;
      return !filter.q || i.tenant_slug.indexOf(filter.q) !== -1 || i.reference.toLowerCase().indexOf(filter.q) !== -1;
    });
    $('inv-count').textContent = list.length + ' of ' + invoices.length;
    var tb = $('inv-rows');
    rowsFor(list, tb, true);
    if (!list.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '7', class: 'muted', text: invoices.length ? 'No invoices match.' : 'No invoices yet.' })]));
  }

  /* ---------- a workspace's Billing tab ---------- */
  async function renderTenant(st, box) {
    box.replaceChildren(el('p', { class: 'muted', text: 'Loading invoices…' }));
    var list;
    try { list = await api('GET', '/billing/invoices?slug=' + encodeURIComponent(st.slug)); if (!settings) await loadSettings(); }
    catch (ex) { box.replaceChildren(el('p', { class: 'muted', text: ex.message })); return; }
    var quote = st.subscription && st.subscription.monthly_total != null ? st.subscription.monthly_total : null;
    var parts = [];
    if (st.awaiting_payment) {
      parts.push(el('div', { class: 'awaiting-note' }, [
        el('span', { text: 'Signed up on the website — locked to Billing until you confirm the first payment.' }),
        el('button', { class: 'btn ghost small', type: 'button', onclick: async function () {
          if (!confirm('Open ' + st.slug + ' now, without waiting for payment?')) return;
          try { await api('PATCH', '/tenants/' + encodeURIComponent(st.slug), { awaiting_payment: false }); toast('Workspace opened'); await C.reloadTenant(st.slug); }
          catch (ex) { toast(ex.message); }
        } }, ['Open without payment']),
      ]));
    }
    parts.push(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn', type: 'button', onclick: function () { newInvoice(st.slug, quote); } }, ['+ New invoice']),
      el('span', { class: 'muted', text: 'Monthly quote: ' + (quote == null ? 'not priced' : peso(quote)) }),
    ]));
    var tb = el('tbody');
    rowsFor(list, tb, false);
    if (!list.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'muted', text: 'No invoices for this workspace yet.' })]));
    parts.push(el('div', { class: 'billing-table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Reference', 'Description', 'Amount', 'Balance', 'Due', 'Status'].map(function (h, i) {
        return el('th', { class: i === 2 || i === 3 ? 'num' : null, text: h });
      }))]), tb,
    ])]));
    box.replaceChildren.apply(box, parts);
  }

  /* ---------- invoice drawer ---------- */
  function closeDrawer() { var s = $('scrim'), d = $('drawer'); if (s) s.remove(); if (d) d.remove(); }

  async function openFile(paymentId, kind) {
    try {
      var res = await fetch('/_platform/api/billing/payments/' + paymentId + '/files/' + kind, { headers: { Authorization: 'Bearer ' + C.token() } });
      if (!res.ok) throw new Error('File not available (' + res.status + ')');
      var url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (ex) { toast(ex.message); }
  }

  async function refreshAfter(inv) {
    if (open) await loadAll(); else await C.reloadTenant(inv.tenant_slug);
    refreshCount();
    paint(inv);
  }

  async function act(method, path, body, okMsg) {
    try { var inv = await api(method, path, body); toast(okMsg); await refreshAfter(inv); return inv; }
    catch (ex) { toast(ex.message); return null; }
  }

  async function openInvoice(id) {
    try { paint(await api('GET', '/billing/invoices/' + id)); } catch (ex) { toast(ex.message); }
  }

  function paint(inv) {
    closeDrawer();
    document.body.appendChild(el('div', { id: 'scrim', class: 'scrim', onclick: closeDrawer }));
    var live = inv.status === 'open' || inv.status === 'payment_submitted';
    var sums = el('div', { class: 'sums' }, [
      el('div', {}, [el('span', { text: 'Amount' }), el('span', { text: peso(inv.amount) })]),
      inv.vat_rate ? el('div', { class: 'muted' }, [el('span', { text: 'incl. VAT ' + inv.vat_rate + '%' }), el('span', { text: peso(inv.vat) })]) : null,
      el('div', { class: 'muted' }, [el('span', { text: 'EWT ' + inv.ewt_rate + '% (if they withhold)' }), el('span', { text: '−' + peso(inv.ewt) })]),
      el('div', {}, [el('span', { text: 'Expected if withheld' }), el('span', { text: peso(inv.net_if_withheld) })]),
      el('div', {}, [el('span', { text: 'Confirmed so far' }), el('span', { text: peso(inv.paid_total) })]),
      el('div', { class: 'total' }, [el('span', { text: 'Balance' }), el('span', { text: inv.status === 'void' ? '–' : peso(inv.balance) })]),
    ]);
    var pays = el('div', {}, inv.payments.length ? inv.payments.map(function (p) {
      var acts = el('div', { class: 'acts' });
      if (p.has_proof) acts.appendChild(el('button', { class: 'btn ghost small', type: 'button', onclick: function () { openFile(p.id, 'proof'); } }, ['View proof']));
      if (p.has_2307) acts.appendChild(el('button', { class: 'btn ghost small', type: 'button', onclick: function () { openFile(p.id, 'form_2307'); } }, ['View 2307']));
      if (p.status === 'pending') {
        acts.appendChild(el('button', { class: 'btn small', type: 'button', onclick: function () {
          var no = prompt('Confirm ' + peso(p.amount) + ' by ' + methodLabel(p.method) + ' (ref ' + (p.reference_no || '—') + ') — check it in your '
            + (p.method === 'gcash' ? 'GCash transaction history' : 'bank app or statement') + '.\n\nBIR invoice number issued for this (optional):', inv.bir_invoice_no || '');
          if (no === null) return;
          act('POST', '/billing/payments/' + p.id + '/confirm', { bir_invoice_no: no }, 'Payment confirmed');
        } }, ['Confirm']));
        acts.appendChild(el('button', { class: 'btn ghost small', type: 'button', onclick: function () {
          var why = prompt('Why are you rejecting this? The customer sees this note.');
          if (!why) return;
          act('POST', '/billing/payments/' + p.id + '/reject', { note: why }, 'Payment rejected');
        } }, ['Reject']));
      }
      return el('div', { class: 'pay' }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, [el('strong', { text: peso(p.amount) + ' · ' + methodLabel(p.method) }), badge(p.status)]),
        el('div', { class: 'muted', text: 'Ref ' + (p.reference_no || '—') + ' · paid ' + (p.paid_on || '—') + ' · by ' + p.submitted_by }),
        p.note ? el('div', { text: p.note }) : null,
        p.review_note ? el('div', { class: 'muted', text: 'Review note: ' + p.review_note }) : null,
        acts,
      ]);
    }) : [el('div', { class: 'muted', text: 'No payments reported yet.' })]);

    var recordBox = live ? el('div', { class: 'field' }, [
      el('label', { text: 'Record a payment you received yourself' }),
      el('div', { class: 'row2' }, [
        el('input', { id: 'r-amount', type: 'number', min: '0', step: '0.01', placeholder: 'Amount', value: String(inv.balance || '') }),
        el('input', { id: 'r-date', type: 'date', value: todayStr() }),
      ]),
      el('input', { id: 'r-ref', placeholder: 'Reference / check no. (optional)', style: 'margin-top:8px' }),
      el('button', { class: 'btn small', type: 'button', style: 'margin-top:8px', onclick: function () {
        act('POST', '/billing/invoices/' + inv.id + '/record-payment', {
          amount: $('r-amount').value, paid_on: $('r-date').value, reference_no: $('r-ref').value, bir_invoice_no: $('b-bir').value,
        }, 'Payment recorded');
      } }, ['Record payment']),
    ]) : null;

    var body = el('div', { class: 'body' }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px' }, [badge(inv.status), inv.overdue ? badge('overdue', 'overdue') : null, el('span', { class: 'muted mono', text: inv.tenant_slug })]),
      el('div', { class: 'field' }, [el('div', { text: inv.description }),
        el('div', { class: 'muted', text: inv.kind + (inv.period_start ? ' · ' + inv.period_start + ' – ' + (inv.period_end || '') : '') + ' · issued ' + inv.issued_on + ' · due ' + inv.due_on })]),
      el('div', { class: 'field' }, [sums]),
      el('div', { class: 'field' }, [el('label', { text: 'BIR invoice no. (from your registered invoicing)' }),
        el('div', { style: 'display:flex;gap:8px' }, [el('input', { id: 'b-bir', value: inv.bir_invoice_no || '', placeholder: 'e.g. SI-00042' }),
          el('button', { class: 'btn ghost small', type: 'button', onclick: function () { act('PATCH', '/billing/invoices/' + inv.id, { bir_invoice_no: $('b-bir').value }, 'Saved'); } }, ['Save'])])]),
      el('div', { class: 'field' }, [el('label', { text: 'Payments' }), pays]),
      recordBox,
      inv.void_reason ? el('div', { class: 'muted', text: 'Voided: ' + inv.void_reason }) : null,
      live ? el('div', { class: 'danger-zone' }, [
        el('h3', { text: 'Void' }),
        el('div', { class: 'muted', text: 'Cancels this invoice. It stays on record and the customer sees it as void.' }),
        el('button', { class: 'btn danger small', type: 'button', style: 'margin-top:8px', onclick: function () {
          var why = prompt('Reason for voiding ' + inv.reference + ':');
          if (why) act('POST', '/billing/invoices/' + inv.id + '/void', { reason: why }, 'Invoice voided');
        } }, ['Void invoice']),
      ]) : null,
    ]);
    document.body.appendChild(el('div', { id: 'drawer', class: 'drawer' }, [
      el('header', {}, [el('h1', { class: 'mono', text: inv.reference }), el('button', { class: 'btn ghost', type: 'button', onclick: closeDrawer }, ['Close'])]),
      body,
    ]));
  }

  /* ---------- new invoice ---------- */
  async function newInvoice(slug, quote) {
    var tenants = C.tenants();
    if (!tenants.length) { toast('Create a tenant first.'); return; }
    if (!settings) { try { await loadSettings(); } catch (ex) { toast(ex.message); return; } }
    var card = el('div', { class: 'card', style: 'max-width:480px' }, [
      el('h2', { text: 'New invoice' }),
      el('div', { class: 'field' }, [el('label', { text: 'Workspace' }), el('select', { id: 'ni-slug' }, tenants.map(function (t) {
        return el('option', { value: t.slug, text: (t.name || t.slug) + ' (' + t.slug + ')', selected: t.slug === slug ? 'selected' : null });
      }))]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Kind' }), el('select', { id: 'ni-kind' }, settings.kinds.map(function (k) { return el('option', { value: k, text: k }); }))]),
        el('div', { class: 'field' }, [el('label', { text: 'Amount (₱, VAT included if any)' }), el('input', { id: 'ni-amount', type: 'number', min: '0', step: '0.01', value: quote != null ? String(quote) : '' })]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Description' }), el('input', { id: 'ni-desc', placeholder: 'Subscription — November 2026' })]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Period start (optional)' }), el('input', { id: 'ni-ps', type: 'date' })]),
        el('div', { class: 'field' }, [el('label', { text: 'Period end (optional)' }), el('input', { id: 'ni-pe', type: 'date' })]),
      ]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Due' }), el('input', { id: 'ni-due', type: 'date', value: plusDays(7) })]),
        el('div', { class: 'field' }, [el('label', { text: 'EWT they may withhold (%)' }), el('input', { id: 'ni-ewt', type: 'number', min: '0', max: '15', step: '0.5', value: String(settings.default_ewt_rate) })]),
      ]),
      el('div', { class: 'err', id: 'ni-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'ni-go', type: 'button' }, ['Issue invoice']),
        el('button', { class: 'btn ghost', id: 'ni-cancel', type: 'button' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    $('ni-cancel').addEventListener('click', function () { modal.remove(); });
    $('ni-go').addEventListener('click', async function () {
      $('ni-err').textContent = '';
      $('ni-go').disabled = true;
      try {
        var inv = await api('POST', '/tenants/' + encodeURIComponent($('ni-slug').value) + '/invoices', {
          kind: $('ni-kind').value, amount: $('ni-amount').value, description: $('ni-desc').value.trim(),
          period_start: $('ni-ps').value, period_end: $('ni-pe').value, due_on: $('ni-due').value, ewt_rate: $('ni-ewt').value,
        });
        modal.remove();
        toast('Issued ' + inv.reference);
        await refreshAfter(inv);
      } catch (ex) { $('ni-err').textContent = ex.message; $('ni-go').disabled = false; }
    });
  }

  /* ---------- settings: payment details + price list ---------- */
  async function openSettings() {
    try { await loadSettings(); } catch (ex) { toast(ex.message); return; }
    var s = settings;
    var priceInputs = s.modules.map(function (m) {
      return el('label', {}, [m, el('input', { 'data-price': m, type: 'number', min: '0', step: '0.01', placeholder: '₱ / month',
        value: typeof s.module_prices[m] === 'number' ? String(s.module_prices[m]) : '' })]);
    });
    var qrBox = el('div', { id: 'bs-qr-box', class: 'muted', text: s.gcash_qr ? 'QR code uploaded.' : 'No QR code yet.' });
    var card = el('div', { class: 'card', style: 'max-width:620px;max-height:90vh;overflow-y:auto' }, [
      el('h2', { text: 'Payment details & prices' }),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'GCash account name' }), el('input', { id: 'bs-gname', value: s.gcash_name, placeholder: 'Juan D.' })]),
        el('div', { class: 'field' }, [el('label', { text: 'GCash number' }), el('input', { id: 'bs-gnum', value: s.gcash_number, placeholder: '09XXXXXXXXX' })]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'GCash QR code (from GCash → QR → Receive money)' }), qrBox,
        el('div', { style: 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap' }, [
          el('input', { id: 'bs-qr', type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'max-width:260px' }),
          el('button', { class: 'btn ghost small', type: 'button', onclick: async function () {
            var f = $('bs-qr').files[0]; if (!f) { toast('Choose the QR image first.'); return; }
            var fd = new FormData(); fd.append('qr', f);
            try { settings = Object.assign(settings, await api('POST', '/billing/settings/gcash-qr', fd)); qrBox.textContent = 'QR code uploaded.'; toast('QR code saved'); }
            catch (ex) { toast(ex.message); }
          } }, ['Upload QR']),
          s.gcash_qr ? el('button', { class: 'btn ghost small', type: 'button', onclick: async function () {
            try { settings = Object.assign(settings, await api('DELETE', '/billing/settings/gcash-qr')); qrBox.textContent = 'No QR code yet.'; toast('QR code removed'); }
            catch (ex) { toast(ex.message); }
          } }, ['Remove']) : null,
        ])]),
      el('div', { class: 'field' }, [el('label', { text: 'Bank details customers see' }), el('textarea', { id: 'bs-bank', placeholder: 'Bank · Account name · Account number · Branch' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Price list for website sign-ups (₱ per month)' }),
        el('div', { class: 'muted', style: 'margin-bottom:6px', text: 'A sign-up is invoiced automatically when every module it picks has a price and the seat price is set. Otherwise you issue its invoice here.' }),
        el('div', { class: 'price-grid' }, priceInputs.concat([el('label', {}, ['per login seat', el('input', { id: 'bs-seat', type: 'number', min: '0', step: '0.01', placeholder: '₱ / seat / month', value: s.seat_price == null ? '' : String(s.seat_price) })])]))]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Invoice reference prefix' }), el('input', { id: 'bs-prefix', value: s.reference_prefix })]),
        el('div', { class: 'field' }, [el('label', { text: 'Default EWT (%)' }), el('input', { id: 'bs-ewt', type: 'number', min: '0', max: '15', step: '0.5', value: String(s.default_ewt_rate) })]),
      ]),
      el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' }, [
        el('input', { id: 'bs-vat', type: 'checkbox', style: 'width:auto', checked: s.vat_registered ? 'checked' : null }),
        el('span', { text: 'We are VAT-registered (new invoices include 12% VAT; EWT is taken on the amount net of VAT)' }),
      ]),
      el('div', { class: 'err', id: 'bs-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'bs-go', type: 'button' }, ['Save']),
        el('button', { class: 'btn ghost', id: 'bs-cancel', type: 'button' }, ['Close']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    $('bs-bank').value = s.bank_details || '';
    $('bs-cancel').addEventListener('click', function () { modal.remove(); if (open) paintAll(); });
    $('bs-go').addEventListener('click', async function () {
      $('bs-err').textContent = '';
      var prices = {};
      card.querySelectorAll('[data-price]').forEach(function (i) { if (i.value.trim() !== '') prices[i.dataset.price] = i.value; });
      try {
        settings = Object.assign(settings, await api('PUT', '/billing/settings', {
          gcash_name: $('bs-gname').value, gcash_number: $('bs-gnum').value, bank_details: $('bs-bank').value,
          module_prices: prices, seat_price: $('bs-seat').value.trim() === '' ? null : $('bs-seat').value,
          reference_prefix: $('bs-prefix').value, default_ewt_rate: $('bs-ewt').value, vat_registered: $('bs-vat').checked,
        }));
        modal.remove();
        toast('Billing settings saved');
        if (open) paintAll();
      } catch (ex) { $('bs-err').textContent = ex.message; }
    });
  }

  window.ConsoleBilling = { refreshCount: refreshCount, renderTenant: renderTenant, close: function () { if (open) toggleView(false); } };
})();
