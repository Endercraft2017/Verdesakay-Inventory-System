/* Identified employee cases. The API scopes each case to its reporter, recipient and
   assigned handler; this screen never assumes that an HR navigation tab grants access. */
App.register('identified-reports', async (view, params) => {
  const esc = UI.esc;
  const statuses = ['new', 'triaged', 'investigating', 'resolved', 'closed'];
  view.innerHTML = `<div class="topbar"><div><h2>Identified Reports</h2><div class="sub">Private cases you filed, received or handle</div></div><div class="grow"></div><button class="btn" id="ir-new">New report</button><button class="btn secondary" id="ir-refresh">Refresh</button></div><div class="panel" id="ir-body"><div class="empty">Loading…</div></div>`;
  const body = view.querySelector('#ir-body');
  async function load() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const rows = await API.get('/identified-reports');
      if (!rows.length) { body.innerHTML = UI.emptyState({ icon: 'inbox', title: 'No identified reports' }); return; }
      body.innerHTML = `<table><thead><tr><th>Reference</th><th>Subject</th><th>Reporter</th><th>Recipient / handler</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map(r =>
        `<tr><td>${esc(r.number)}</td><td>${esc(r.subject)}</td><td>${esc(r.reporter_name)}</td><td>${esc(r.assignee_name || r.recipient_name)}</td><td>${esc(r.status)}</td><td>${esc(r.updated_at)}</td><td><button type="button" class="btn secondary small" data-case="${r.id}">Open</button></td></tr>`).join('')}</tbody></table>`;
      body.querySelectorAll('[data-case]').forEach(button => { button.onclick = () => openCase(Number(button.dataset.case)); });
    } catch (error) { body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load reports', hint: error.message }); }
  }
  async function openCase(id) {
    let r;
    try { r = await API.get('/identified-reports/' + id); } catch (error) { UI.toast(error.message, 'error'); return; }
    const canHandle = r.can_handle === true;
    const modal = UI.modal({ title: `${r.number} · ${r.subject}`, size: 'lg', cancelText: 'Close', bodyHTML: `
      <div class="panel" style="padding:14px;margin-bottom:12px"><b>${esc(r.category)}</b> · ${esc(r.status)}<br>
        <span class="muted">${esc([r.incident_date, r.incident_time, r.location].filter(Boolean).join(' · ') || 'Incident date/location not supplied')}</span>
        <p style="white-space:pre-wrap">${esc(r.description)}</p><small>Reporter: ${esc(r.reporter_name)} · Recipient: ${esc(r.recipient_name)} · Handler: ${esc(r.assignee_name || r.recipient_name)}</small></div>
      <h4>Evidence</h4><div id="ir-files">${r.attachments.length ? r.attachments.map(a => `<button type="button" class="btn secondary small" data-file="${a.id}">${esc(a.original_name)}</button>`).join(' ') : '<p class="muted">No files attached.</p>'}</div>
      <h4>History</h4><div style="max-height:260px;overflow:auto">${r.events.map(e => `<div class="panel" style="padding:10px;margin-bottom:6px"><small class="muted">${esc(e.created_at)} · ${esc(e.actor_name || 'Former staff')} · ${esc(e.kind)}</small><div style="white-space:pre-wrap">${esc(e.body || '')}</div></div>`).join('')}</div>
      ${canHandle ? `<label>Status</label><div style="display:flex;gap:8px"><select id="ir-status">${statuses.map(s => `<option value="${s}"${r.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select><button type="button" class="btn secondary" id="ir-save-status">Update</button></div>
      <label>Assign to active staff member</label><div style="display:flex;gap:8px"><select id="ir-assignee"><option value="">Loading…</option></select><button type="button" class="btn secondary" id="ir-assign">Assign</button></div>` : ''}
      ${r.status === 'closed' ? '<p class="muted">This report is closed.</p>' : '<label>Follow-up message</label><textarea id="ir-reply" maxlength="3000" rows="3"></textarea><button type="button" class="btn" id="ir-send">Send reply</button>'}`,
      onOpen: ov => {
        const refresh = () => { modal.close(); load(); openCase(id); };
        ov.querySelectorAll('[data-file]').forEach(button => { button.onclick = async () => { const file = r.attachments.find(a => String(a.id) === button.dataset.file); if (!file) return; try { if (String(file.mime_type).startsWith('image/')) PhotoViewer.open(await API.blobUrl(file.url), file.original_name); else await API.download(file.url, file.original_name); } catch (e) { UI.toast(e.message, 'error'); } }; });
        const save = ov.querySelector('#ir-save-status');
        if (save) save.onclick = async () => { save.disabled = true; try { await API.post(`/identified-reports/${id}/status`, { status: ov.querySelector('#ir-status').value }); refresh(); } catch (e) { UI.toast(e.message, 'error'); save.disabled = false; } };
        const assign = ov.querySelector('#ir-assign');
        if (assign) {
          API.get('/users').then(users => { ov.querySelector('#ir-assignee').innerHTML = users.map(u => `<option value="${u.id}"${u.id === r.assignee_id ? ' selected' : ''}>${esc(u.full_name)}</option>`).join(''); }).catch(() => { ov.querySelector('#ir-assignee').innerHTML = '<option value="">Directory unavailable</option>'; });
          assign.onclick = async () => { assign.disabled = true; try { await API.post(`/identified-reports/${id}/assign`, { user_id: ov.querySelector('#ir-assignee').value }); refresh(); } catch (e) { UI.toast(e.message, 'error'); assign.disabled = false; } };
        }
        const send = ov.querySelector('#ir-send');
        if (send) send.onclick = async () => { const message = ov.querySelector('#ir-reply').value.trim(); if (!message) { UI.toast('Write a reply first', 'error'); return; } send.disabled = true; try { await API.post(`/identified-reports/${id}/reply`, { body: message }); refresh(); } catch (e) { UI.toast(e.message, 'error'); send.disabled = false; } };
      },
    });
  }
  async function newReport() {
    let users;
    try { users = await API.get('/users'); } catch (e) { UI.toast(e.message, 'error'); return; }
    const selfId = App.getMe()?.id;
    users = users.filter(u => u.id !== selfId);
    if (!users.length) { UI.toast('No staff recipient is available', 'error'); return; }
    const modal = UI.modal({ title: 'New identified report', size: 'lg', cancelText: 'Cancel',
      bodyHTML: `<p class="muted">Your name will be visible to the recipient and assigned handler. Anonymous reports use the separate private channel.</p>
        <label>Recipient *</label><select id="ir-new-recipient">${users.map(u => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select>
        <label>Category *</label><select id="ir-new-category">${['Workplace concern', 'Harassment or misconduct', 'Safety risk', 'Payroll or attendance', 'Equipment or facility', 'Stock or operations', 'System support', 'Other'].map(x => `<option>${esc(x)}</option>`).join('')}</select>
        <label>Subject *</label><input id="ir-new-subject" maxlength="140" placeholder="What happened?" />
        <label>Description *</label><textarea id="ir-new-description" rows="5" maxlength="3000" placeholder="Describe the concern and what follow-up you need"></textarea>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><div><label>Incident date</label><input id="ir-new-date" type="date"></div><div><label>Time</label><input id="ir-new-time" type="time"></div></div>
        <label>Location</label><input id="ir-new-location" maxlength="160" placeholder="Optional" />
        <label>Evidence (up to 4 files, 5 MB each)</label><input id="ir-new-files" type="file" multiple accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx" />`,
      headActionHTML: '<button type="button" class="btn small" id="ir-submit">Send report</button>',
      onOpen: ov => {
        ov.querySelector('#ir-submit').onclick = async e => {
          const subject = ov.querySelector('#ir-new-subject').value.trim();
          const description = ov.querySelector('#ir-new-description').value.trim();
          const files = [...ov.querySelector('#ir-new-files').files];
          if (!subject || !description) { UI.toast('Enter a subject and description', 'error'); return; }
          if (files.length > 4) { UI.toast('Use up to 4 evidence files', 'error'); return; }
          e.target.disabled = true;
          try {
            const data = new FormData();
            data.append('recipient_id', ov.querySelector('#ir-new-recipient').value);
            data.append('category', ov.querySelector('#ir-new-category').value);
            data.append('subject', subject); data.append('description', description);
            data.append('incident_date', ov.querySelector('#ir-new-date').value);
            data.append('incident_time', ov.querySelector('#ir-new-time').value);
            data.append('location', ov.querySelector('#ir-new-location').value.trim());
            for (const f of files) { const ready = window.ImageCompress ? await ImageCompress.maybeCompress(f, { thresholdBytes: 0, maxDim: 1600, quality: .8 }) : f; if (ready.size > 5 * 1024 * 1024) throw new Error('Each file must be 5 MB or less after image compression'); data.append('files', ready, ready.name); }
            const created = await API.upload('/identified-reports', data);
            modal.close(); await load(); openCase(created.id);
          } catch (error) { UI.toast(error.message, 'error'); e.target.disabled = false; }
        };
      },
    });
  }
  view.querySelector('#ir-refresh').onclick = load;
  view.querySelector('#ir-new').onclick = newReport;
  await load();
  if (params && params.id) openCase(Number(params.id));
});
