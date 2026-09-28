/* Anonymous Reports — desktop case handling for the identity-free reporting channel
   (src/core/confidential-reports.ts; reports.confidential). No reporter identity exists for
   these cases; replies reach the reporter only when they check with their number + access code,
   and they see them as "Case handler". Same API as the mobile #/confidential-reports queue. */
App.register('confidential-reports', async (view) => {
  const STATUSES = ['new', 'triaged', 'investigating', 'resolved', 'closed'];
  const BADGE = { new: 'low', triaged: 'status-open', investigating: 'status-confirmed', resolved: 'ok', closed: 'muted' };
  const state = { status: 'open' };

  if (!App.hasPermission('reports.confidential')) {
    view.innerHTML = UI.emptyState({ icon: 'alert', title: 'No access', hint: 'Handling anonymous reports needs the “Handle anonymous reports” permission.' });
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Anonymous Reports</h2>
        <div class="sub">Filed through the anonymous channel — no reporter identity is stored</div>
      </div>
      <div class="grow"></div>
      <select id="cr-status" aria-label="Status">
        <option value="open">Open (not resolved/closed)</option>
        ${STATUSES.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <button type="button" class="btn secondary" id="cr-refresh">${UI.icon('history', 15)} Refresh</button>
    </div>
    <div class="panel"><div id="cr-body"><div class="empty">Loading…</div></div></div>`;
  const body = view.querySelector('#cr-body');
  const badge = (s) => `<span class="badge-pill ${BADGE[s] || ''}">${UI.esc(s)}</span>`;

  async function load() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    let rows;
    try { rows = await API.get('/confidential-reports' + (state.status !== 'open' ? `?status=${state.status}` : '')); }
    catch (e) { body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load reports', hint: e.message }); return; }
    if (state.status === 'open') rows = rows.filter((r) => r.status !== 'resolved' && r.status !== 'closed');
    if (!rows.length) { body.innerHTML = UI.emptyState({ icon: 'inbox', title: 'No reports here' }); return; }
    body.innerHTML = `<table>
      <thead><tr><th>Report</th><th>Category</th><th>Title</th><th>Status</th><th>Filed</th><th>Updated</th><th class="right">Messages</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${UI.esc(r.number)}</td><td>${UI.esc(r.category)}</td><td>${UI.esc(r.subject || '—')}</td>
        <td>${badge(r.status)}</td><td>${UI.esc(r.created_on)}</td><td>${UI.esc(r.updated_on)}</td>
        <td class="right">${r.message_count}${r.reporter_replies ? ` <span class="muted">(${r.reporter_replies} from reporter)</span>` : ''}</td>
        <td class="right"><button type="button" class="btn secondary small" data-open="${r.id}">Open</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openCase(Number(b.dataset.open)); });
  }

  async function openCase(id) {
    let r;
    try { r = await API.get(`/confidential-reports/${id}`); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const thread = r.messages.length
      ? r.messages.map((m) => `
          <div style="padding:10px 12px;border:1px solid var(--border-strong);border-radius:10px;margin-bottom:8px;${m.author === 'reporter' ? 'background:var(--surface-2)' : ''}">
            <div class="muted" style="font-size:12px;margin-bottom:4px">${m.author === 'reporter' ? 'Reporter' : UI.esc(m.handler_name || 'Case handler')} · ${UI.esc(m.created_on)}</div>
            <div style="white-space:pre-wrap">${UI.esc(m.body)}</div>
          </div>`).join('')
      : '<p class="muted">No messages yet. The reporter sees replies when they check with their access code.</p>';
    const m = UI.modal({
      title: `${r.number} — ${r.subject || r.category}`,
      size: 'lg',
      cancelText: 'Close',
      bodyHTML: `
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px" class="muted">
          <span>Category: <b>${UI.esc(r.category)}</b></span>
          <span>Incident: <b>${UI.esc([r.incident_date, r.location].filter(Boolean).join(' · ') || 'not given')}</b></span>
          <span>Filed ${UI.esc(r.created_on)} · updated ${UI.esc(r.updated_on)}</span>
        </div>
        <div style="white-space:pre-wrap;padding:12px;border:1px solid var(--border-strong);border-radius:10px;margin-bottom:16px">${UI.esc(r.description)}</div>
        <label>Status</label>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <select id="cr-case-status">${STATUSES.map((s) => `<option value="${s}"${s === r.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
          <button type="button" class="btn secondary small" id="cr-save-status">Update status</button>
        </div>
        <h4 style="margin:0 0 8px">Conversation</h4>${thread}
        ${r.status === 'closed' ? '<p class="muted">Closed — the reporter can no longer add messages.</p>' : ''}
        <label style="margin-top:12px">Reply to reporter</label>
        <textarea id="cr-reply" style="min-height:80px" maxlength="3000" placeholder="The reporter sees this as “Case handler”"></textarea>`,
      headActionHTML: '<button type="button" class="btn small" id="cr-send">Send reply</button>',
      onOpen: (ov) => {
        ov.querySelector('#cr-save-status').onclick = async (e) => {
          e.target.disabled = true;
          try {
            await API.post(`/confidential-reports/${id}/status`, { status: ov.querySelector('#cr-case-status').value });
            UI.toast('Status updated', 'success');
            m.close(); load(); openCase(id);
          } catch (err) { UI.toast(err.message, 'error'); e.target.disabled = false; }
        };
        ov.querySelector('#cr-send').onclick = async (e) => {
          const text = ov.querySelector('#cr-reply').value.trim();
          if (!text) { UI.toast('Write a reply first', 'error'); return; }
          e.target.disabled = true;
          try {
            await API.post(`/confidential-reports/${id}/reply`, { body: text });
            UI.toast('Reply sent', 'success');
            m.close(); load(); openCase(id);
          } catch (err) { UI.toast(err.message, 'error'); e.target.disabled = false; }
        };
      },
    });
  }

  view.querySelector('#cr-status').onchange = (e) => { state.status = e.target.value; load(); };
  view.querySelector('#cr-refresh').onclick = load;
  load();
});
