/* One desktop inbox uses the same authorized decision endpoints as mobile. */
App.register('hr-approvals', async (view, filter) => {
  view.dataset.section = 'hr';
  let inbox,
    tab = filter && filter.tab === 'recent' ? 'recent' : 'pending',
    query = '';
  let firstLoad = true;
  async function load() {
    try {
      inbox = await API.get('/me/approvals');
      if (!view.isConnected) return;
      render();
      if (firstLoad && filter && filter.id) {
        const matches = (r) =>
          String(r.id) === String(filter.id) && (!filter.kind || r.kind === filter.kind);
        let record = rows().find(matches);
        if (!record) {
          record = (inbox.history || []).find(matches);
          if (record) {
            tab = 'recent';
            render();
          }
        }
        if (record) detail(record);
        else
          UI.toast(
            'This item is unavailable or outside your approval authority. Refresh or check Recent decisions.',
            'info',
          );
      }
      firstLoad = false;
    } catch (e) {
      view.innerHTML = `<div class="panel">${UI.emptyState({ icon: 'alert', title: 'Couldn’t load approvals', hint: e.message, action: '<button class="btn secondary" id="ap-retry">Try again</button>' })}</div>`;
      view.querySelector('#ap-retry').onclick = load;
    }
  }
  function rows() {
    const all =
      tab === 'recent'
        ? inbox.history || []
        : [
            ...inbox.requests.map((r) => ({ ...r, kind: 'request' })),
            ...inbox.time_corrections.map((r) => ({
              ...r,
              kind: 'correction',
              form_name: 'Attendance correction',
            })),
          ];
    return all.filter(
      (r) =>
        (!filter ||
          !filter.slug ||
          r.slug === filter.slug ||
          (filter.slug === 'time_correction' && r.kind === 'correction')) &&
        (!query ||
          [r.employee_name, r.filed_by, r.form_name, r.number, r.work_date].some((v) =>
            String(v || '')
              .toLowerCase()
              .includes(query),
          )),
    );
  }
  function render() {
    view.innerHTML = `<div class="topbar"><h2>Approvals</h2><div class="grow"></div>
      ${App.hasPermission('hr.manage') ? '<button class="btn secondary" id="ap-authorities">Department approvers</button>' : ''}
      <button class="btn secondary" id="ap-refresh">Refresh</button></div>
      <p class="muted">Department heads and appointed delegates normally approve. HR can step in when needed. Department decisions are recorded and HR is notified; no second approval is required.</p>
      <div class="panel"><div class="hr-workflow-toolbar"><div class="tabs"><button class="subtab ${tab === 'pending' ? 'active' : ''}" data-tab="pending">Pending</button><button class="subtab ${tab === 'recent' ? 'active' : ''}" data-tab="recent">Recent decisions</button></div>
      <label for="ap-search" class="hr-sr-only">Search approvals</label><input id="ap-search" type="search" placeholder="Search employee or request…" value="${UI.esc(query)}" />
      ${filter && filter.slug ? '<button class="btn secondary small" id="ap-clear">Show all types</button>' : ''}
      </div><div id="ap-list"></div></div>`;
    view.querySelector('#ap-refresh').onclick = load;
    const settings = view.querySelector('#ap-authorities');
    if (settings) settings.onclick = authorities;
    view.querySelectorAll('[data-tab]').forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          render();
        }),
    );
    view.querySelector('#ap-search').oninput = (e) => {
      query = e.target.value.toLowerCase();
      renderList();
    };
    const clear = view.querySelector('#ap-clear');
    if (clear) clear.onclick = () => App.navigate('hr-approvals');
    renderList();
  }
  function renderList() {
    const list = rows(),
      host = view.querySelector('#ap-list');
    if (!list.length) {
      host.innerHTML = UI.emptyState({
        icon: 'check',
        title:
          inbox.can_approve === false
            ? 'No approval authority assigned'
            : tab === 'recent'
              ? 'No recent decisions'
              : 'No pending items',
        hint:
          inbox.can_approve === false
            ? 'Your department head or HR can assign approval authority.'
            : 'Try another filter or refresh to check for updates.',
      });
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Request</th><th>Date / number</th><th>Status</th><th></th></tr></thead><tbody>${list.map((r, i) => `<tr><td>${UI.esc(r.employee_name || r.filed_by || '—')}</td><td>${UI.esc(r.form_name)}</td><td>${UI.esc(r.work_date || r.number)}</td><td>${UI.esc(r.status)}</td><td><button class="btn secondary small" data-open="${i}">${tab === 'pending' ? 'Review' : 'View decision'}</button></td></tr>`).join('')}</tbody></table></div>`;
    host
      .querySelectorAll('[data-open]')
      .forEach((b) => (b.onclick = () => detail(list[Number(b.dataset.open)])));
  }
  function detail(r) {
    const correction = r.kind === 'correction';
    const data = correction
      ? {
          work_date: r.work_date,
          requested_in: r.requested_in,
          requested_out: r.requested_out,
          reason: r.reason,
        }
      : r.data || {};
    const pending = r.status === 'pending';
    const entries = Object.entries(data).filter(
      ([k, v]) =>
        v != null && v !== '' && !['decided_by', 'decided_at', 'decision_note'].includes(k),
    );
    UI.modal({
      title: `${r.form_name} — ${r.employee_name || r.filed_by || r.number || ''}`,
      cancelText: 'Close',
      bodyHTML: `${entries.map(([k, v]) => `<div class="tool-row"><strong>${UI.esc(k.replace(/_/g, ' '))}</strong><span>${UI.esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span></div>`).join('')}
        ${pending ? '<label for="ap-note">Decision note (include the reason if rejecting)</label><textarea id="ap-note" maxlength="1000" rows="3"></textarea><label for="ap-decision">Decision</label><select id="ap-decision"><option value="approved">Approve</option><option value="rejected">Reject</option></select>' : `<p>Status: ${UI.esc(r.status)}</p><p>Decided by: ${UI.esc(data.decided_by || r.decided_by_name || '—')}</p><p>${UI.esc(data.decided_at || r.decided_at || '')}</p><p>Note: ${UI.esc(data.decision_note || r.decision_note || 'No note recorded')}</p>`}`,
      confirmText: pending ? 'Save decision' : null,
      onConfirm: async (ov, showErr) => {
        const decision = ov.querySelector('#ap-decision').value,
          note = ov.querySelector('#ap-note').value.trim();
        const path = `/me/approvals/${correction ? 'time-corrections' : 'requests'}/${r.id}/decide`;
        let res;
        try {
          res = await API.post(path, { decision, note: note || null });
        } catch (e) {
          if (
            decision === 'approved' &&
            /approve anyway to override/i.test(e.message || '') &&
            (await UI.confirmDialog(e.message, 'Approve anyway'))
          )
            res = await API.post(path, { decision, note: note || null, override_balance: true });
          else {
            showErr(e.message);
            return false;
          }
        }
        UI.toast(
          res.clash
            ? `Already ${res.status}; the existing decision was kept.`
            : correction && decision === 'approved' && !res.applied
              ? 'Approved, but no matching cutoff exists. Add the cutoff and record the correction before payroll.'
              : res.applied_note || `Request ${res.status || decision}`,
          res.clash || (correction && decision === 'approved' && !res.applied) ? 'info' : 'success',
        );
        await load();
      },
    });
  }
  async function authorities() {
    try {
      const settings = await API.get('/hr/approval-authorities');
      if (!view.isConnected) return;
      UI.modal({
        title: 'Department approvers',
        size: 'lg',
        cancelText: 'Close',
        bodyHTML:
          '<p class="muted">Department heads keep approval authority. Choose additional active accounts from the same department. HR always retains access.</p><label for="ap-dept">Department</label><select id="ap-dept">' +
          settings.departments
            .map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`)
            .join('') +
          '</select><div id="ap-delegates"></div>',
        confirmText: 'Save delegates',
        onOpen: (ov) => {
          const draw = () => {
            const d = settings.departments.find(
              (d) => String(d.id) === ov.querySelector('#ap-dept').value,
            );
            if (!d) return;
            ov.querySelector('#ap-delegates').innerHTML =
              `<p>Department head: ${UI.esc(d.head_name || 'Not assigned — configure under Accounts → Departments')}</p>` +
              settings.users
                .filter((u) => u.department_id === d.id && u.id !== d.head_user_id)
                .map(
                  (u) =>
                    `<label style="display:block;margin:10px 0"><input type="checkbox" style="width:auto" data-user="${u.id}" ${(settings.delegates[String(d.id)] || []).includes(u.id) ? 'checked' : ''}> ${UI.esc(u.full_name)}</label>`,
                )
                .join('');
          };
          ov.querySelector('#ap-dept').onchange = draw;
          draw();
        },
        onConfirm: async (ov) => {
          const id = ov.querySelector('#ap-dept').value;
          if (!id) return false;
          await API.put('/hr/approval-authorities/' + id, {
            user_ids: [...ov.querySelectorAll('[data-user]:checked')].map((b) =>
              Number(b.dataset.user),
            ),
          });
          UI.toast('Department delegates saved');
          await load();
        },
      });
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }
  await load();
});
