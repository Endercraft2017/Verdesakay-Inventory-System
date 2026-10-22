/* Owner console — website "Talk to us" inquiries (docs/SAAS-READINESS.md §12). The header
   "Inquiries" button lists them (new ones counted on the button); open one to call / email them,
   set its status and notes, and "Create workspace" from it (prefilled; optionally locked until
   the first payment). "Website contact details" sets the phone / email / Messenger the site
   shows beside the form. Talks to /_platform/api/inquiries + /site/contact via window.Console. */
(function () {
  'use strict';
  var C = window.Console;
  var api = C.api, el = C.el, toast = C.toast, $ = C.$;
  var data = { inquiries: [], statuses: [] };
  var filter = '';
  var open = false;
  var LABELS = { inventory: 'Inventory', manufacturing: 'Manufacturing', purchasing: 'Purchasing', hr: 'HR & Payroll', accounting: 'Accounting', ai: 'AI Assistant', mobile: 'Mobile', email: 'Email', quickbooks: 'QuickBooks' };

  async function refreshCount() {
    try {
      var n = (await api('GET', '/inquiries?status=new')).new_count;
      $('inquiry-count').textContent = String(n);
      $('inquiry-count').classList.toggle('hidden', !n);
    } catch (e) { /* the badge is a convenience */ }
  }

  function toggleView(show) {
    if (show && window.ConsoleBilling) window.ConsoleBilling.close();
    open = show;
    document.querySelector('main.console-shell').classList.toggle('hidden', show);
    $('inquiries-view').classList.toggle('hidden', !show);
    $('inquiries-btn').firstChild.textContent = show ? 'Tenants' : 'Inquiries';
    if (show) load();
  }
  $('inquiries-btn').addEventListener('click', function () { toggleView(!open); });

  async function load() {
    try { data = await api('GET', '/inquiries'); } catch (ex) { toast(ex.message); return; }
    paint();
    refreshCount();
  }

  function badge(s) { return el('span', { class: 'badge inq-' + s, text: s }); }

  function paint() {
    var root = $('inquiries-view');
    var statusSel = el('select', { 'aria-label': 'Inquiry status', style: 'max-width:180px', onchange: function () { filter = this.value; paintRows(); } },
      [['', 'All inquiries']].concat(data.statuses.map(function (s) { return [s, s.charAt(0).toUpperCase() + s.slice(1)]; })).map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === filter ? 'selected' : null });
      }));
    root.replaceChildren(
      el('div', { class: 'tenant-page-heading' }, [el('div', {}, [el('h2', { text: 'Inquiries' }),
        el('p', { class: 'muted', text: 'Messages from the website’s “Talk to us” form. Follow up, then create their workspace from here.' })])]),
      el('div', { class: 'toolbar' }, [
        el('button', { class: 'btn ghost', type: 'button', onclick: openContactSettings }, ['Website contact details']),
        statusSel, el('span', { class: 'muted', id: 'inq-count' }),
      ]),
      el('div', { class: 'billing-table-wrap' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Received', 'Company', 'Name', 'Employees', 'Interested in', 'Status'].map(function (h) { return el('th', { text: h }); }))]),
        el('tbody', { id: 'inq-rows' }),
      ])])
    );
    paintRows();
  }

  function paintRows() {
    var list = data.inquiries.filter(function (i) { return !filter || i.status === filter; });
    $('inq-count').textContent = list.length + ' of ' + data.inquiries.length;
    var tb = $('inq-rows'); tb.replaceChildren();
    list.forEach(function (i) {
      tb.appendChild(el('tr', { onclick: function () { paintDrawer(i); } }, [
        el('td', { text: (i.created_at || '').slice(0, 10) }),
        el('td', {}, [el('strong', { text: i.company })]),
        el('td', { text: i.name }),
        el('td', { text: i.employees || '—' }),
        el('td', { text: i.modules.length ? i.modules.map(function (m) { return LABELS[m] || m; }).join(', ') : '—' }),
        el('td', {}, [badge(i.status), i.tenant_slug ? el('span', { class: 'muted mono', text: ' → ' + i.tenant_slug }) : null]),
      ]));
    });
    if (!list.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'muted', text: data.inquiries.length ? 'No inquiries match.' : 'No inquiries yet. They appear here when someone sends the website form.' })]));
  }

  function closeDrawer() { var s = $('scrim'), d = $('drawer'); if (s) s.remove(); if (d) d.remove(); }

  function paintDrawer(i) {
    closeDrawer();
    document.body.appendChild(el('div', { id: 'scrim', class: 'scrim', onclick: closeDrawer }));
    var statusSel = el('select', { id: 'q-status' }, data.statuses.map(function (s) {
      return el('option', { value: s, text: s, selected: s === i.status ? 'selected' : null });
    }));
    var notes = el('textarea', { id: 'q-notes', placeholder: 'Call notes, quote sent, next step…' });
    notes.value = i.notes || '';
    var contact = el('div', { class: 'sums' }, [
      el('div', {}, [el('span', { text: 'Email' }), el('a', { href: 'mailto:' + i.email, text: i.email })]),
      i.phone ? el('div', {}, [el('span', { text: 'Mobile' }), el('a', { href: 'tel:' + i.phone.replace(/[^+\d]/g, ''), text: i.phone })]) : null,
      el('div', {}, [el('span', { text: 'Employees' }), el('span', { text: i.employees || '—' })]),
      el('div', {}, [el('span', { text: 'Interested in' }), el('span', { text: i.modules.length ? i.modules.map(function (m) { return LABELS[m] || m; }).join(', ') : '—' })]),
    ]);
    var body = el('div', { class: 'body' }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px' }, [badge(i.status), el('span', { class: 'muted', text: 'Received ' + i.created_at })]),
      el('div', { class: 'field' }, [el('div', { style: 'font-weight:650', text: i.name + ' — ' + i.company })]),
      el('div', { class: 'field' }, [contact]),
      i.message ? el('div', { class: 'field' }, [el('label', { text: 'Message' }), el('div', { style: 'white-space:pre-wrap', text: i.message })]) : null,
      el('div', { class: 'field' }, [el('label', { text: 'Status' }), statusSel]),
      el('div', { class: 'field' }, [el('label', { text: 'Notes (only you see these)' }), notes]),
      el('div', { class: 'field' }, i.tenant_slug
        ? [el('label', { text: 'Workspace' }), el('button', { class: 'btn ghost small', type: 'button', onclick: function () {
            closeDrawer(); toggleView(false); C.openTenant(i.tenant_slug).catch(function (e) { toast(e.message); });
          } }, ['Open ' + i.tenant_slug])]
        : [el('label', { text: 'Workspace' }), el('button', { class: 'btn small', type: 'button', onclick: function () {
            closeDrawer(); toggleView(false); C.newTenant({ name: i.company, email: i.email, inquiry_id: i.id });
          } }, ['Create workspace from this inquiry'])]),
    ]);
    document.body.appendChild(el('div', { id: 'drawer', class: 'drawer' }, [
      el('header', {}, [el('h1', { text: i.company }), el('button', { class: 'btn ghost', type: 'button', onclick: closeDrawer }, ['Close'])]),
      body,
      el('div', { class: 'foot' }, [
        el('button', { class: 'btn', type: 'button', onclick: async function () {
          try {
            var r = await api('PATCH', '/inquiries/' + i.id, { status: $('q-status').value, notes: $('q-notes').value });
            toast('Saved'); closeDrawer(); await load(); paintDrawer(r);
          } catch (ex) { toast(ex.message); }
        } }, ['Save']),
        el('button', { class: 'btn ghost', type: 'button', onclick: closeDrawer }, ['Cancel']),
      ]),
    ]));
  }

  async function openContactSettings() {
    var c;
    try { c = await api('GET', '/site/contact'); } catch (ex) { toast(ex.message); return; }
    var card = el('div', { class: 'card', style: 'max-width:460px' }, [
      el('h2', { text: 'Website contact details' }),
      el('p', { class: 'muted', text: 'Shown beside the “Talk to us” form. Leave a field empty to hide it.' }),
      el('div', { class: 'field' }, [el('label', { text: 'Mobile / phone' }), el('input', { id: 'sc-phone', value: c.phone, placeholder: '0917 123 4567' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Email' }), el('input', { id: 'sc-email', value: c.email, placeholder: 'sales@yourcompany.com' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Messenger link' }), el('input', { id: 'sc-messenger', value: c.messenger, placeholder: 'https://m.me/yourpage' })]),
      el('div', { class: 'err', id: 'sc-err' }),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
        el('button', { class: 'btn', id: 'sc-go', type: 'button' }, ['Save']),
        el('button', { class: 'btn ghost', id: 'sc-cancel', type: 'button' }, ['Cancel']),
      ]),
    ]);
    var modal = el('div', { class: 'modal', id: 'modal' }, [card]);
    document.body.appendChild(modal);
    $('sc-cancel').addEventListener('click', function () { modal.remove(); });
    $('sc-go').addEventListener('click', async function () {
      $('sc-err').textContent = '';
      try {
        await api('PUT', '/site/contact', { phone: $('sc-phone').value, email: $('sc-email').value, messenger: $('sc-messenger').value });
        modal.remove(); toast('Website contact details saved');
      } catch (ex) { $('sc-err').textContent = ex.message; }
    });
  }

  window.ConsoleInquiries = { refreshCount: refreshCount, close: function () { if (open) toggleView(false); } };
})();
