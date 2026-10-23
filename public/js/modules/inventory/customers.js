/* Orders → Customers: the AR-side party registry. Sale orders link to a customer. */
App.register('customers', async (view, filter) => {
  const routeAtRender = location.hash;
  const canCreate = App.hasPermission('orders.create');
  const canWrite = App.hasPermission('orders.edit');
  const canDelete = App.hasPermission('orders.delete');
  let all = [];
  let q = '';
  let showArchived = false;

  view.innerHTML = `
    <div class="topbar">
      <h2>Customers</h2>
      <div class="grow"></div>
      <label class="check" style="margin-right:8px"><input type="checkbox" id="cus-arch" /> Show archived</label>
      <div class="search-box search">${UI.icon('search', 16)}<input id="cus-search" placeholder="Search name, contact, TIN…" /></div>
      ${canCreate ? `<button class="btn" id="cus-add">${UI.icon('plus')} New customer</button>` : ''}
    </div>
    <div class="panel"><div id="cus-table"></div></div>`;

  const tableEl = view.querySelector('#cus-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (showArchived) params.push('archived=1');
    all = await API.get('/customers' + (params.length ? '?' + params.join('&') : ''));
    render();
  }

  function render() {
    if (!all.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'building',
        title: q ? 'No matching customers' : 'No customers yet',
        hint: q ? 'Try a different search.' : 'Add the customers you sell to, then raise sale orders against them.',
        action: (!q && canCreate) ? `<button class="btn" id="cus-empty-add">${UI.icon('plus')} New customer</button>` : '',
      });
      const ea = tableEl.querySelector('#cus-empty-add');
      if (ea) ea.onclick = () => customerModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Customer</th><th>Contact</th><th>Phone</th><th>TIN</th>
          <th class="right">Terms</th><th class="right">Orders</th><th></th>
        </tr></thead>
        <tbody>${all.map((c) => `
          <tr class="clickable" data-open="${c.id}">
            <td><strong>${UI.esc(c.name)}</strong>${c.archived ? ' <span class="badge-pill muted">archived</span>' : ''}
              ${c.address ? `<div class="muted" style="font-size:11px">${UI.esc(c.address)}</div>` : ''}</td>
            <td>${UI.esc(c.contact_person || '—')}</td>
            <td>${UI.esc(c.phone || '—')}</td>
            <td class="mono">${UI.esc(c.tin || '—')}</td>
            <td class="right">${c.payment_terms_days ? c.payment_terms_days + ' days' : 'COD'}</td>
            <td class="right">${c.order_count || 0}</td>
            <td class="actions">
              ${canWrite ? `<button class="icon-btn" title="Edit" data-edit="${c.id}">${UI.icon('edit')}</button>` : ''}
              ${canDelete ? `<button class="icon-btn danger" title="Delete" data-del="${c.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => customerModal(all.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = () => del(all.find((x) => x.id == b.dataset.del)));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      detailModal(all.find((x) => x.id == tr.dataset.open));
    });
  }

  const field = (label, key, val, type = 'text') =>
    `<div class="form-field"><div class="field-label"><label>${label}</label></div>
      <input data-f="${key}" type="${type}" value="${UI.esc(val || '')}" /></div>`;

  function customerModal(c) {
    UI.modal({
      title: c ? 'Edit customer' : 'New customer',
      size: 'lg',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Name <span class="req">*</span></label></div>
          <input data-f="name" value="${UI.esc(c ? c.name : '')}" /></div>
        ${field('Contact person', 'contact_person', c && c.contact_person)}
        ${field('Phone', 'phone', c && c.phone)}
        ${field('Facebook display name', 'facebook_name', c && c.facebook_name)}
        ${field('Facebook profile / reference URL', 'facebook_url', c && c.facebook_url)}
        <div class="span2" data-matches aria-live="polite"></div>
        ${!c ? '<label class="span2 check"><input type="checkbox" data-separate /> This is a separate customer from any suggested matches.</label>' : ''}
        ${field('Email', 'email', c && c.email, 'email')}
        ${field('TIN', 'tin', c && c.tin)}
        <div class="form-field"><div class="field-label"><label>Payment terms (days)</label></div>
          <input data-f="payment_terms_days" type="number" min="0" max="365" value="${c ? (c.payment_terms_days || 0) : 0}" /></div>
        ${c ? `<div class="form-field"><label class="check" style="margin-top:22px"><input type="checkbox" data-f="archived" ${c.archived ? 'checked' : ''} /> Archived</label></div>` : ''}
        <div class="form-field span2"><div class="field-label"><label>Address</label></div>
          <input data-f="address" value="${UI.esc(c && c.address || '')}" /></div>
        <div class="form-field span2"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes">${UI.esc(c && c.notes || '')}</textarea></div>
      </div>`,
      confirmText: c ? 'Save changes' : 'Create customer',
      onOpen: overlay => {
        let timer, sequence=0;
        const find=async()=>{
          const current=++sequence;
          const values={exclude:c?c.id:0};
          ['name','phone','email','facebook_name'].forEach(k=>values[k]=overlay.querySelector(`[data-f="${k}"]`).value);
          try {
            const matches=await API.get('/customers/matches?'+new URLSearchParams(values));
            if(current!==sequence || !overlay.isConnected)return;
            const target=overlay.querySelector('[data-matches]');
            target.innerHTML=matches.length ? '<p>Possible existing customers — check before creating another profile:</p>'+matches.map(m=>`<button type="button" class="btn secondary small" data-match="${m.id}">${UI.esc(m.name)} · ${UI.esc(m.phone||m.email||m.facebook_name||'')}${m.archived?' (archived)':''}</button>`).join('') : '';
            target.querySelectorAll('[data-match]').forEach(b=>b.onclick=()=>{overlay.remove();detailModal({id:Number(b.dataset.match)}).catch(e=>UI.toast(e.message,'error'));});
          } catch(e){overlay.querySelector('[data-matches]').textContent='Matching unavailable: '+e.message;}
        };
        ['name','phone','email','facebook_name'].forEach(k=>overlay.querySelector(`[data-f="${k}"]`).addEventListener('input',()=>{clearTimeout(timer);sequence++;timer=setTimeout(find,250);}));
      },
      onConfirm: async (overlay, showErr) => {
        const g = (k) => overlay.querySelector(`[data-f="${k}"]`);
        const body = {
          name: g('name').value.trim(),
          facebook_name: g('facebook_name').value.trim(),
          facebook_url: g('facebook_url').value.trim(),
          contact_person: g('contact_person').value.trim(),
          phone: g('phone').value.trim(),
          email: g('email').value.trim(),
          tin: g('tin').value.trim(),
          address: g('address').value.trim(),
          notes: g('notes').value.trim(),
          payment_terms_days: Number(g('payment_terms_days').value) || 0,
        };
        if (c) body.version = c.version;
        if (c) body.archived = !!(g('archived') && g('archived').checked);
        if (!body.name) { showErr('Name is required'); return false; }
        if (!c && !overlay.querySelector('[data-separate]').checked) {
          const matches = await API.get('/customers/matches?' + new URLSearchParams({name:body.name,phone:body.phone,email:body.email,facebook_name:body.facebook_name}));
          if (matches.length) { showErr('Possible existing customer found. Open a match below or confirm this is a separate customer.'); return false; }
        }
        if (c) await API.put('/customers/' + c.id, body);
        else await API.post('/customers', body);
        UI.toast(c ? 'Customer updated' : 'Customer created');
        load();
      },
    });
  }

  async function detailModal(row) {
    if (location.hash !== routeAtRender) return;
    const c = await API.get('/customers/' + row.id);
    if (location.hash !== routeAtRender) return;
    const orders = Array.isArray(c.orders) ? c.orders : [];
    const modal = UI.modal({
      title: 'Customer details',
      size: 'lg',
      cancelText: 'Close',
      confirmText: canWrite ? 'Edit customer' : null,
      onConfirm: canWrite ? () => customerModal(c) : undefined,
      bodyHTML: `
        <h3 style="margin:0 0 4px">${UI.esc(c.name)}${c.archived ? ' (archived)' : ''}</h3>
        ${App.hasPermission('cases.view') ? `<div><button class="btn secondary" data-new-case="inquiry">New inquiry</button> <button class="btn secondary" data-new-case="complaint">New complaint</button></div><h4>Customer cases</h4><div data-customer-cases></div><button class="btn secondary small" data-more-cases>More cases</button>` : ''}
        <div class="kv" style="margin-top:12px">
          <div><span class="muted">Contact</span><div>${UI.esc(c.contact_person || '—')}</div></div>
          <div><span class="muted">Facebook</span><div>${UI.esc(c.facebook_name || '—')} ${c.facebook_url ? `<a href="${UI.esc(c.facebook_url)}" target="_blank" rel="noopener noreferrer">Open reference</a>` : ''}</div></div>
          <div><span class="muted">Phone</span><div>${UI.esc(c.phone || '—')}</div></div>
          <div><span class="muted">Email</span><div>${UI.esc(c.email || '—')}</div></div>
          <div><span class="muted">TIN</span><div>${UI.esc(c.tin || '—')}</div></div>
          <div><span class="muted">Terms</span><div>${c.payment_terms_days ? c.payment_terms_days + ' days' : 'COD'}</div></div>
          <div><span class="muted">Address</span><div>${UI.esc(c.address || '—')}</div></div>
        </div>
        ${c.notes ? `<h4 style="margin:14px 0 4px">Notes</h4><p style="white-space:pre-wrap;margin:0">${UI.esc(c.notes)}</p>` : ''}
        <h4 style="margin:16px 0 4px">Recent sale orders (${orders.length})</h4>
        ${orders.length ? `<table><thead><tr><th>No.</th><th>Date</th><th>Status</th><th class="right">Total</th></tr></thead>
          <tbody>${orders.map((o) => `<tr><td><button class="btn secondary small" data-sale="${o.id}">${UI.esc(o.number)}</button></td><td>${UI.esc(o.order_date || '—')}</td>
          <td class="muted">${UI.esc(o.status)}</td><td class="right">${UI.money(o.total)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No sale orders yet.</div>'}
        <h4>Customer history</h4><div data-customer-history></div><button class="btn secondary small" data-more-history>More history</button>`,
      onOpen: ov => {
        const refresh=async()=>{modal.close();await detailModal(c);await load();};
        ov.querySelectorAll('[data-sale]').forEach(b=>b.onclick=()=>{modal.close();App.navigate('orders',{type:'sale',id:Number(b.dataset.sale)});});
        ov.querySelectorAll('[data-new-case]').forEach(b=>{
          b.hidden=!App.hasPermission('cases.edit');
          b.onclick=()=>CustomerCases.create(c.id,b.dataset.newCase,refresh).catch(e=>UI.toast(e.message,'error'));
        });
        if(App.hasPermission('cases.view')) {
          let offset=0;
          const more=ov.querySelector('[data-more-cases]');
          const cases=async()=>{
            const rows=await API.get(`/customers/${c.id}/cases?offset=${offset}`);
            const root=ov.querySelector('[data-customer-cases]');root.insertAdjacentHTML('beforeend',CustomerCases.rows(rows.slice(0,50)));CustomerCases.bind(root,refresh);
            offset+=50;more.hidden=rows.length<=50;
          };
          more.onclick=()=>cases().catch(e=>UI.toast(e.message,'error'));
          cases().catch(e=>{ov.querySelector('[data-customer-cases]').textContent=e.message;});
        }
        let offset=0;
        const more=ov.querySelector('[data-more-history]');
        const history=async()=>{
          const rows=await API.get(`/customers/${c.id}/history?offset=${offset}`);
          const root=ov.querySelector('[data-customer-history]');
          root.insertAdjacentHTML('beforeend',rows.slice(0,50).map(e=>`<p><button class="btn secondary small" data-history-kind="${e.kind}" data-ref="${e.ref_id}">${UI.esc(e.title)}</button> · ${UI.esc(e.event_type)} · ${UI.esc(e.actor_name||'')} · ${UI.esc(new Date(e.occurred_at).toLocaleString())}<br>${UI.esc(e.note||'')}</p>`).join('') || '<p class="muted">No history yet.</p>');
          root.querySelectorAll('[data-ref]').forEach(b=>b.onclick=()=>{
            if(b.dataset.historyKind==='sale'){modal.close();App.navigate('orders',{type:'sale',id:Number(b.dataset.ref)});}
            else CustomerCases.open(Number(b.dataset.ref),refresh).catch(e=>UI.toast(e.message,'error'));
          });
          offset+=50;more.hidden=rows.length<=50;
        };
        more.onclick=()=>history().catch(e=>UI.toast(e.message,'error'));
        history().catch(e=>{ov.querySelector('[data-customer-history]').textContent=e.message;});
      },
    });
  }

  async function del(c) {
    const ok = await UI.confirmDialog(
      `Delete "${c.name}"?${c.order_count ? ` ${c.order_count} sale order(s) are linked. Customers with history must be archived.` : ''} Consider archiving instead.`,
      'Delete'
    );
    if (!ok) return;
    try { await API.del('/customers/' + c.id); UI.toast('Customer deleted'); load(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  let t;
  view.querySelector('#cus-search').addEventListener('input', (e) => {
    clearTimeout(t); q = e.target.value.trim(); t = setTimeout(load, 250);
  });
  view.querySelector('#cus-arch').addEventListener('change', (e) => { showArchived = e.target.checked; load(); });
  const addBtn = view.querySelector('#cus-add');
  if (addBtn) addBtn.onclick = () => customerModal(null);

  await load();
  if(filter && filter.id) await detailModal({id:Number(filter.id)});
});
