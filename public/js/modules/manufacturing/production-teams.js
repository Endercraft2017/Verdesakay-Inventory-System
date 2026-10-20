/* Production → Teams: production teams and their member rosters. A job
   order is assigned to a team on its New/Edit form and on the schedule board. */
App.register('production-teams', async (view) => {
  const canWrite = App.hasPermission('production.configure');
  let teams = [];
  let employees = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Production Teams</h2>
      <div class="grow"></div>
      ${canWrite ? `<button class="btn" id="pt-new">${UI.icon('plus')} New team</button>` : ''}
    </div>
    <div class="panel"><div id="pt-table"></div></div>`;

  const tableEl = view.querySelector('#pt-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    [teams, employees] = await Promise.all([
      API.get('/production/teams'),
      API.get('/production/employees').catch(() => []),
    ]);
    render();
  }

  function render() {
    if (!teams.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'users',
        title: 'No production teams yet',
        hint: 'Create a team, add its members, then assign job orders to it.',
        action: canWrite ? `<button class="btn" id="pt-empty-new">${UI.icon('plus')} New team</button>` : '',
      });
      const en = tableEl.querySelector('#pt-empty-new');
      if (en) en.onclick = () => editModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Team</th><th>Members</th><th class="right">Open job orders</th><th></th></tr></thead>
        <tbody>${teams.map((t) => `
          <tr class="clickable" data-open="${t.id}">
            <td><strong>${UI.esc(t.name)}</strong>${t.is_active ? '' : ' <span class="badge-pill cancelled">inactive</span>'}${t.notes ? `<div class="muted" style="font-size:11px">${UI.esc(t.notes)}</div>` : ''}</td>
            <td>${(t.members || []).map((m) => UI.esc(m.name || ('#' + m.employee_id)) + (m.role ? ` <span class="muted">(${UI.esc(m.role)})</span>` : '')).join(', ') || '<span class="muted">—</span>'}</td>
            <td class="right">${t.open_job_orders || 0}</td>
            <td class="actions">${canWrite ? `<button class="icon-btn" title="Edit" data-edit="${t.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${t.id}">${UI.icon('trash')}</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editModal(teams.find((t) => String(t.id) === b.dataset.edit)));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirmDialog('Delete this team?', 'Delete'))) return;
      try { await API.del('/production/teams/' + b.dataset.del); UI.toast('Deleted'); load(); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      memberModal(teams.find((t) => String(t.id) === tr.dataset.open));
    });
  }

  function editModal(existing) {
    UI.modal({
      title: existing ? `Edit — ${existing.name}` : 'New production team',
      bodyHTML: `
        <div class="form-field"><div class="field-label"><label>Name <span class="req">*</span></label></div>
          <input data-f="name" value="${UI.esc(existing ? existing.name : '')}" /></div>
        <div class="form-field"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes">${UI.esc(existing && existing.notes || '')}</textarea></div>
        ${existing ? `<label class="check"><input type="checkbox" data-f="active" ${existing.is_active ? 'checked' : ''}/> Active</label>` : ''}`,
      confirmText: existing ? 'Save' : 'Create',
      onConfirm: async (ov, showErr) => {
        const name = ov.querySelector('[data-f="name"]').value.trim();
        if (!name) { showErr('Name is required'); return false; }
        const body = { name, notes: ov.querySelector('[data-f="notes"]').value.trim() || null };
        const act = ov.querySelector('[data-f="active"]');
        if (act) body.is_active = act.checked;
        if (existing) await API.put('/production/teams/' + existing.id, body);
        else await API.post('/production/teams', body);
        UI.toast('Saved'); load();
      },
    });
  }

  function memberModal(team) {
    let t = team;
    const m = UI.modal({ title: `${team.name} — members`, cancelText: 'Close', bodyHTML: '<div id="pt-mbody"></div>' });
    const host = () => m.overlay.querySelector('#pt-mbody');

    function draw() {
      const el = host();
      const members = t.members || [];
      el.innerHTML = `
        ${members.length ? `<table><thead><tr><th>Member</th><th>Role</th>${canWrite ? '<th></th>' : ''}</tr></thead>
          <tbody>${members.map((x) => `<tr>
            <td>${UI.esc(x.name || ('#' + x.employee_id))}</td>
            <td class="muted">${UI.esc(x.role || '—')}</td>
            ${canWrite ? `<td><button class="icon-btn danger" data-rm="${x.employee_id}" title="Remove">${UI.icon('trash')}</button></td>` : ''}
          </tr>`).join('')}</tbody></table>` : '<p class="muted">No members yet.</p>'}
        ${canWrite ? `
          <div style="margin-top:10px"><button type="button" class="btn secondary small" id="pt-add">${UI.icon('plus')} Add members</button></div>` : ''}`;
      const add = el.querySelector('#pt-add');
      if (add) add.onclick = pickerModal;
      el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
        try {
          const r = await API.del('/production/teams/' + t.id + '/members/' + b.dataset.rm);
          t = { ...t, members: r.members }; draw(); load();
        } catch (e) { UI.toast(e.message, 'error'); }
      });
    }

    // Nested modal: pick any number of employees (account or none) to add at once, with an
    // optional role applied to the whole batch.
    function pickerModal() {
      const taken = new Set((t.members || []).map((x) => x.employee_id));
      const available = employees.filter((e) => !taken.has(e.id));
      const picked = new Set();

      const pm = UI.modal({
        title: `Add members — ${t.name}`,
        bodyHTML: `
          <div class="form-field"><input data-f="q" placeholder="Search employees…" /></div>
          <div id="pt-pick-list" style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 10px;margin-top:6px"></div>
          <div class="form-field" style="margin-top:10px"><div class="field-label"><label>Role (optional, applied to all selected)</label></div>
            <input data-f="role" placeholder="e.g. lead" /></div>`,
        confirmText: 'Add selected',
        onConfirm: async (ov, showErr) => {
          if (!picked.size) { showErr('Pick at least one employee'); return false; }
          const role = ov.querySelector('[data-f="role"]').value.trim() || null;
          let members = t.members;
          for (const employeeId of picked) {
            try {
              const r = await API.post('/production/teams/' + t.id + '/members', { employee_id: employeeId, role });
              members = r.members;
            } catch (e) { UI.toast(e.message, 'error'); }
          }
          t = { ...t, members }; draw(); load();
        },
      });

      const listEl = pm.overlay.querySelector('#pt-pick-list');
      function renderList(filter) {
        const f = (filter || '').trim().toLowerCase();
        const rows = available.filter((e) => !f
          || (e.name || '').toLowerCase().includes(f)
          || (e.employee_no || '').toLowerCase().includes(f)
          || (e.department_name || '').toLowerCase().includes(f));
        if (!rows.length) { listEl.innerHTML = '<p class="muted" style="padding:8px 0">No matching employees.</p>'; return; }

        // Grouped by department so a whole department can be picked in one click.
        const groups = new Map();
        rows.forEach((e) => {
          const key = e.department_name || 'Unassigned';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        });
        const deptNames = [...groups.keys()].sort((a, b) => (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b));

        listEl.innerHTML = deptNames.map((dept) => {
          const list = groups.get(dept);
          const allPicked = list.every((e) => picked.has(e.id));
          return `
            <div class="pt-pick-group">
              <label class="check-opt" style="display:flex;width:100%;padding:8px 0 4px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">
                <input type="checkbox" data-group="${UI.esc(dept)}" ${allPicked ? 'checked' : ''} />
                <span>${UI.esc(dept)} (${list.length})</span>
              </label>
              ${list.map((e) => `
                <label class="check-opt" style="display:flex;width:100%;padding:6px 0 6px 22px;border-bottom:1px solid var(--border)">
                  <input type="checkbox" value="${e.id}" ${picked.has(e.id) ? 'checked' : ''} />
                  <span>${UI.esc(e.name)}${e.position ? ` <span class="muted">— ${UI.esc(e.position)}</span>` : ''}</span>
                </label>`).join('')}
            </div>`;
        }).join('');

        listEl.querySelectorAll('input[type=checkbox][value]').forEach((cb) => cb.onchange = () => {
          const id = Number(cb.value);
          if (cb.checked) picked.add(id); else picked.delete(id);
        });
        listEl.querySelectorAll('input[data-group]').forEach((cb) => cb.onchange = () => {
          const list = groups.get(cb.dataset.group);
          list.forEach((e) => { if (cb.checked) picked.add(e.id); else picked.delete(e.id); });
          renderList(pm.overlay.querySelector('[data-f="q"]').value);
        });
      }
      renderList('');
      pm.overlay.querySelector('[data-f="q"]').addEventListener('input', (e) => renderList(e.target.value));
    }

    draw();
  }

  const nb = view.querySelector('#pt-new');
  if (nb) nb.onclick = () => editModal(null);
  await load();
});
