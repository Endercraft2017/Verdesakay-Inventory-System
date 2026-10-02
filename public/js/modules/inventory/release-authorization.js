/* Sales side of warehouse-out (modules/inventory/release-auth.ts): issue / revoke a sale order's
   release authorization — pickup or delivery, approved recipient (only the last 4 of an ID
   reference is kept), a time-limited token for the recipient, handoff area, partial release —
   see the releaser's reports, and set the company policy. Opened from Sales Orders (key icon).
   window.ReleaseAuth.open(orderId, orderNumber, onChange) */
(function () {
  const MODES = { pickup: 'Customer pickup', delivery: 'Delivery' };
  const KINDS = {
    authorization: 'Authorization', identity: 'Recipient identity', unit_mismatch: 'Wrong / unexpected unit',
    package_missing: 'Missing package item', partial_request: 'Partial release request', other: 'Other',
  };

  async function open(orderId, number, onChange) {
    let data, reports, policy;
    try {
      [data, reports, policy] = await Promise.all([
        API.get('/release-slips/orders/' + orderId + '/authorizations'),
        API.get('/release-slips/reports/list?order_id=' + orderId),
        API.get('/release-slips/policy'),
      ]);
    } catch (e) { UI.toast(e.message, 'error'); return; }
    const cur = data.current || { state: 'none' };
    const active = data.history.find((a) => !a.revoked_at && !a.used_slip_id);
    const m = UI.modal({
      title: 'Release authorization — ' + number,
      size: 'lg',
      bodyHTML: `
        <div class="panel" style="padding:12px 14px">
          ${cur.state === 'none' ? '<div class="muted">No authorization issued.' + (data.required ? ' <b>Required by company policy</b> — the warehouse can’t release this order without one.' : ' Optional: without one the releaser records the recipient at handoff.') + '</div>'
            : `<div><span class="badge-pill status-${cur.state === 'valid' ? 'approved' : 'cancelled'}">${UI.esc(cur.state)}</span>
                 <b style="margin-left:6px">${UI.esc(MODES[cur.mode] || '')}</b> · ${UI.esc(cur.recipient_name)}${cur.id_reference ? ' · ID ' + UI.esc(cur.id_reference) : ''}</div>
               ${active ? `<div style="margin-top:8px;font-size:18px;letter-spacing:.06em"><b>${UI.esc(active.token)}</b>
                   <span class="muted" style="font-size:12px;letter-spacing:0"> — give this to the recipient · valid until ${UI.esc(UI.fmtDate ? UI.fmtDate(active.valid_until + 'Z') : active.valid_until)}</span></div>` : ''}
               <div class="muted" style="margin-top:4px">${cur.handoff_area ? 'Handoff: ' + UI.esc(cur.handoff_area) + ' · ' : ''}Partial release ${cur.partial_allowed ? '<b>allowed</b>' : 'not allowed'}${cur.revoke_reason ? ' · revoked: ' + UI.esc(cur.revoke_reason) : ''}</div>
               ${cur.override ? `<div class="muted" style="margin-top:4px">Token override ${UI.esc(cur.override.status)}${cur.override.decided_by_name ? ' by ' + UI.esc(cur.override.decided_by_name) : ''}:
                   ${UI.esc(cur.override.decision_note || cur.override.reason)}</div>` : ''}`}
        </div>
        <h4 style="margin:14px 0 6px">${active ? 'Replace with a new authorization' : 'Issue an authorization'}</h4>
        <div class="field-row">
          <div><label>Mode</label><select data-f="mode"><option value="pickup">Customer pickup</option><option value="delivery">Delivery</option></select></div>
          <div><label>Approved recipient <span class="req">*</span></label><input data-f="recipient_name" placeholder="Name of who will receive the goods" /></div>
        </div>
        <div class="field-row" style="margin-top:8px">
          <div><label>ID reference</label><input data-f="id_reference" placeholder="Only the last 4 characters are kept" /></div>
          <div><label>Valid for (hours)</label><input data-f="valid_hours" type="number" min="1" max="336" value="24" /></div>
          <div><label>Handoff area</label><input data-f="handoff_area" placeholder="e.g. Release Bay 1" /></div>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" data-f="partial_allowed" />
          Allow a partial release (what isn't allocated moves to a new backorder sale order)</label>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" class="btn" id="ra-issue">${UI.icon('key')} ${active ? 'Issue new (revokes the current one)' : 'Issue authorization'}</button>
          ${active ? '<button type="button" class="btn secondary danger" id="ra-revoke">Revoke</button>' : ''}
        </div>
        <h4 style="margin:16px 0 6px">Release reports from the warehouse</h4>
        ${reports.length ? `<table><thead><tr><th>When</th><th>Kind</th><th>Report</th><th></th></tr></thead><tbody>${reports.map((r) => `
          <tr><td>${UI.esc(UI.fmtDateShort(r.created_at))}</td><td>${UI.esc(KINDS[r.kind] || r.kind)}</td>
            <td>${UI.esc(r.description)}${r.unit_identifier ? `<div class="muted">${UI.esc(r.unit_identifier)}</div>` : ''}<div class="muted">${UI.esc(r.reported_by_name || '')}</div></td>
            <td><button type="button" class="btn secondary small" data-resolve="${r.id}">Resolve</button></td></tr>`).join('')}</tbody></table>`
          : '<div class="muted">No open reports.</div>'}
        <label style="display:flex;gap:8px;align-items:center;margin-top:16px;border-top:1px solid var(--border);padding-top:10px">
          <input type="checkbox" id="ra-policy" ${policy.authorization_required ? 'checked' : ''} />
          Company policy: require a release authorization for <b>every</b> sale order (on by default)</label>`,
      confirmText: null,
      cancelText: 'Close',
      onOpen: (ov) => {
        const val = (k) => ov.querySelector(`[data-f="${k}"]`);
        ov.querySelector('#ra-issue').onclick = async (ev) => {
          const body = {
            mode: val('mode').value, recipient_name: val('recipient_name').value.trim(), id_reference: val('id_reference').value.trim() || null,
            valid_hours: Number(val('valid_hours').value) || 24, handoff_area: val('handoff_area').value.trim() || null,
            partial_allowed: val('partial_allowed').checked,
          };
          if (!body.recipient_name) { UI.toast('Enter the approved recipient', 'error'); return; }
          ev.target.disabled = true;
          try {
            const r = await API.post('/release-slips/orders/' + orderId + '/authorizations', body);
            UI.toast('Authorization issued — token ' + r.token, 'success');
            m.close(); if (onChange) onChange(); open(orderId, number, onChange);
          } catch (e) { UI.toast(e.message, 'error'); ev.target.disabled = false; }
        };
        const rv = ov.querySelector('#ra-revoke');
        if (rv) rv.onclick = async () => {
          const reason = prompt('Why revoke this authorization?');
          if (!reason) return;
          try { await API.post('/release-slips/orders/' + orderId + '/authorizations/revoke', { reason }); UI.toast('Authorization revoked'); m.close(); open(orderId, number, onChange); }
          catch (e) { UI.toast(e.message, 'error'); }
        };
        ov.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
          const resolution = prompt('How was it resolved? (optional)') || null;
          try { await API.post('/release-slips/reports/' + b.dataset.resolve + '/resolve', { resolution }); UI.toast('Report resolved'); m.close(); open(orderId, number, onChange); }
          catch (e) { UI.toast(e.message, 'error'); }
        });
        ov.querySelector('#ra-policy').onchange = async (ev) => {
          try { await API.put('/release-slips/policy', { authorization_required: ev.target.checked }); UI.toast('Policy saved'); }
          catch (e) { UI.toast(e.message, 'error'); ev.target.checked = !ev.target.checked; }
        };
      },
    });
  }

  window.ReleaseAuth = { open };
})();
