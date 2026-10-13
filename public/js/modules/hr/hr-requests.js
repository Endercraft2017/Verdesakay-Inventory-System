/* Desktop employee self-service: the same ownership-checked APIs as mobile. */
App.register('hr-requests', async (view, filter) => {
  view.dataset.section = 'hr';
  let employee,
    types = [],
    requests = [],
    corrections = [],
    tab = filter && filter.kind === 'correction' ? 'corrections' : 'requests';
  let firstLoad = true;
  async function load() {
    try {
      const me = await API.get('/me');
      employee = me.employee;
      if (!employee) {
        view.innerHTML = `<div class="panel">${UI.emptyState({ icon: 'users', title: 'Link your employee record first', hint: 'Ask HR to link your account under Employees. Department approvers can still use Home → Approvals.' })}</div>`;
        return;
      }
      [types, requests, corrections] = await Promise.all([
        API.get('/me/request-types'),
        API.get('/me/requests'),
        API.get('/me/time-corrections'),
      ]);
      if (!view.isConnected) return;
      render();
      if (firstLoad && filter && filter.id) {
        const fixes = filter.kind === 'correction';
        const record = (fixes ? corrections : requests).find(
          (r) => String(r.id) === String(filter.id),
        );
        if (record) detail(record, fixes);
        else UI.toast('This request is no longer available.', 'info');
      }
      firstLoad = false;
    } catch (e) {
      view.innerHTML = `<div class="panel">${UI.emptyState({ icon: 'alert', title: 'Couldn’t load My HR', hint: e.message, action: '<button class="btn secondary" id="myhr-retry">Try again</button>' })}</div>`;
      view.querySelector('#myhr-retry').onclick = load;
    }
  }
  function render() {
    view.innerHTML = `<div class="topbar"><h2>My HR</h2><div class="grow"></div><button class="btn secondary" id="myhr-refresh">Refresh</button></div>
      <div class="panel"><div class="hr-workflow-toolbar"><strong>${UI.esc(employee.name)}</strong><p>Available leave: <strong>${UI.esc(String(employee.leave_days_remaining))} days</strong>. Your individual entitlement is ${UI.esc(String(employee.leave_days_per_year))} days. HR can adjust this bank.</p>
      <div class="tabs">${[
        ['requests', 'Requests'],
        ['corrections', 'Attendance corrections'],
        ['schedule', 'Schedule'],
        ['payslips', 'Payslips'],
      ]
        .map(
          ([key, label]) =>
            `<button class="subtab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`,
        )
        .join('')}</div></div><div id="myhr-content"></div></div>`;
    view.querySelector('#myhr-refresh').onclick = load;
    view.querySelectorAll('[data-tab]').forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          render();
        }),
    );
    renderContent();
  }
  async function renderContent() {
    const host = view.querySelector('#myhr-content');
    if (tab === 'requests' || tab === 'corrections') {
      const fixes = tab === 'corrections',
        list = fixes ? corrections : requests;
      host.innerHTML = `<div class="topbar"><button class="btn" id="myhr-new">${fixes ? 'Report a missed punch' : 'New request'}</button></div>${!list.length ? UI.emptyState({ icon: 'note', title: fixes ? 'No attendance corrections' : 'No requests yet', hint: 'Submitted items and their decisions will appear here.' }) : `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Date / number</th><th>Status</th><th></th></tr></thead><tbody>${list.map((r, i) => `<tr><td>${UI.esc(fixes ? 'Attendance correction' : r.form_name)}</td><td>${UI.esc(r.work_date || r.number)}</td><td>${UI.esc(r.status)}</td><td><button class="btn secondary small" data-detail="${i}">View</button></td></tr>`).join('')}</tbody></table></div>`}`;
      host.querySelector('#myhr-new').onclick = () => (fixes ? correctionForm() : pickType());
      host
        .querySelectorAll('[data-detail]')
        .forEach((b) => (b.onclick = () => detail(list[Number(b.dataset.detail)], fixes)));
      return;
    }
    host.innerHTML = '<div class="empty">Loading…</div>';
    const currentTab = tab;
    try {
      const result = await API.get(currentTab === 'schedule' ? '/me/schedule' : '/me/payslips');
      if (tab !== currentTab || !host.isConnected) return;
      if (currentTab === 'schedule') {
        host.innerHTML = `<p>Default shift: ${UI.esc(result.default_shift ? `${result.default_shift.name} (${result.default_shift.start_time}–${result.default_shift.end_time})` : 'Not assigned')}</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Cutoff</th><th>Shift</th><th>In</th><th>Out</th></tr></thead><tbody>${result.days.map((d) => `<tr><td>${UI.esc(d.work_date)}</td><td>${UI.esc(d.period_label)}</td><td>${UI.esc(d.shift_name || 'Default shift')}</td><td>${UI.esc(d.time_in || '—')}</td><td>${UI.esc(d.time_out || '—')}</td></tr>`).join('')}</tbody></table></div>`;
      } else {
        host.innerHTML = result.length
          ? `<div class="table-wrap"><table><thead><tr><th>Period</th><th>Status</th><th>Net pay</th><th></th></tr></thead><tbody>${result.map((r) => `<tr><td>${UI.esc(r.period)}</td><td>${r.finalized ? 'Paid' : 'Draft — subject to review'}</td><td>${UI.money(r.data.net_pay || 0)}</td><td>${r.download_url ? `<button class="btn secondary small" data-pdf="${r.id}">Download payslip</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : UI.emptyState({ icon: 'sheet', title: 'No payslips yet' });
        host.querySelectorAll('[data-pdf]').forEach(
          (b) =>
            (b.onclick = async () => {
              try {
                await API.download(
                  `/me/payslips/${b.dataset.pdf}/pdf`,
                  `payslip-${b.dataset.pdf}.pdf`,
                );
              } catch (e) {
                UI.toast(e.message, 'error');
              }
            }),
        );
      }
    } catch (e) {
      if (tab === currentTab && host.isConnected) {
        host.innerHTML = `<p>${UI.esc(e.message)}</p><button class="btn secondary" id="myhr-tab-retry">Try again</button>`;
        host.querySelector('#myhr-tab-retry').onclick = renderContent;
      }
    }
  }
  function detail(r, fixes) {
    const data = fixes
      ? {
          work_date: r.work_date,
          requested_in: r.requested_in,
          requested_out: r.requested_out,
          reason: r.reason,
          decided_by: r.decided_by_name,
          decision_note: r.decision_note,
        }
      : r.display_data || r.data || {};
    UI.modal({
      title: fixes ? 'Attendance correction' : r.form_name,
      cancelText: 'Close',
      bodyHTML: `<p>Status: ${UI.esc(r.status)}</p>${Object.entries(data)
        .filter(([k, v]) => v != null && v !== '' && !['employee_id', 'decided_by'].includes(k))
        .map(
          ([k, v]) =>
            `<div class="tool-row"><strong>${UI.esc(k.replace(/_/g, ' '))}</strong><span>${UI.esc(String(v))}</span></div>`,
        )
        .join('')}`,
      confirmText: r.status === 'pending' ? 'Cancel request' : null,
      protectChanges: false,
      onConfirm: async () => {
        if (!(await UI.confirmDialog('Withdraw this pending request?', 'Withdraw'))) return false;
        await API.post(`/me/${fixes ? 'time-corrections' : 'requests'}/${r.id}/cancel`);
        UI.toast('Request cancelled');
        await load();
      },
    });
  }
  function pickType() {
    if (!types.length) {
      UI.toast('No request types have been configured. Ask HR to set them up.', 'error');
      return;
    }
    const m = UI.modal({
      title: 'Choose request type',
      cancelText: 'Close',
      bodyHTML: types
        .map(
          (t, i) =>
            `<button class="btn secondary" style="margin:6px" data-type="${i}">${UI.esc(t.name)}</button>`,
        )
        .join(''),
      onOpen: (ov) =>
        ov.querySelectorAll('[data-type]').forEach(
          (b) =>
            (b.onclick = () => {
              m.close();
              requestForm(types[Number(b.dataset.type)]);
            }),
        ),
    });
  }
  function requestForm(type) {
    const autofill = {
      employee_name: employee.name,
      name: employee.name,
      employee_no: employee.employee_no,
      position: employee.position,
      department: employee.department_name,
    };
    const fields = type.fields.filter((f) => !autofill[f.key] && !(type.slug === 'leave_request' && ['date_from','date_to','days','leave_dates'].includes(f.key)));
    let leavePicker;
    UI.modal({
      title: `New ${type.name}`,
      bodyHTML: `<p class="muted">Submitted requests go to your department approvers or HR. Leave is deducted only when approved.</p>${type.slug === 'leave_request' ? LeaveDates.markup() : ''}${fields
        .map((f, i) => {
          let input;
          const attrs = `data-field="${i}" id="myhr-f-${i}"`;
          if (f.type === 'textarea')
            input = `<textarea ${attrs} rows="3">${UI.esc(f.default || '')}</textarea>`;
          else if (f.type === 'select' || f.type === 'employee')
            input = `<select ${attrs}><option value="">Choose one</option>${(f.options || [])
              .map((o) => {
                const value = typeof o === 'object' ? o.value || o.id || o.label || o.name : o;
                const label = typeof o === 'object' ? o.label || o.name || value : o;
                return `<option value="${UI.esc(String(value))}">${UI.esc(String(label))}</option>`;
              })
              .join('')}</select>`;
          else if (f.type === 'checkbox')
            input = `<input ${attrs} type="checkbox" style="width:auto" />`;
          else
            input = `<input ${attrs} type="${['number', 'date', 'time'].includes(f.type) ? f.type : 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${UI.esc(f.default || '')}" />`;
          return `<div style="margin:12px 0"><label for="myhr-f-${i}">${UI.esc(f.label)}${f.required ? ' *' : ''}</label>${input}</div>`;
        })
        .join('')}`,
      confirmText: 'Submit request',
      onOpen: ov => { if (type.slug === 'leave_request') leavePicker = LeaveDates.mount(ov, { preview: data => API.post('/me/leave-preview', data) }); },
      onConfirm: async (ov, showErr) => {
        const data = Object.fromEntries(Object.entries(autofill).filter(([, v]) => v));
        if (leavePicker) { Object.assign(data, leavePicker.value()); if (!data.leave_dates) { showErr('Select at least one leave date.'); return false; } }
        for (const [i, f] of fields.entries()) {
          const el = ov.querySelector(`[data-field="${i}"]`),
            value = el.type === 'checkbox' ? (el.checked ? 'Yes' : 'No') : el.value.trim();
          if (f.required && !value) {
            showErr(`${f.label} is required`);
            el.focus();
            return false;
          }
          if (value) data[f.key] = value;
        }
        const result = await API.post('/form-records', { form_def_id: type.id, data, status: 'pending' });
        UI.toast('Request submitted for approval');
        if (result.action_warnings && result.action_warnings.length) UI.modal({ title: 'Request review notes', bodyHTML: `<ul>${result.action_warnings.map(w => `<li>${UI.esc(w)}</li>`).join('')}</ul>`, cancelText: 'Close' });
        await load();
      },
    });
  }
  function correctionForm() {
    UI.modal({
      title: 'Report a missed punch',
      bodyHTML:
        '<label for="myhr-date">Work date *</label><input id="myhr-date" type="date"><label for="myhr-in">Correct time in</label><input id="myhr-in" type="time"><label for="myhr-out">Correct time out</label><input id="myhr-out" type="time"><label for="myhr-reason">Reason *</label><textarea id="myhr-reason" maxlength="1000"></textarea><p class="muted">Enter at least one time. Department approvers or HR will review it.</p>',
      confirmText: 'Submit correction',
      onConfirm: async (ov, showErr) => {
        const val = (id) => ov.querySelector(id).value.trim(),
          body = {
            work_date: val('#myhr-date'),
            requested_in: val('#myhr-in') || null,
            requested_out: val('#myhr-out') || null,
            reason: val('#myhr-reason'),
          };
        if (
          !body.work_date ||
          (!body.requested_in && !body.requested_out) ||
          body.reason.length < 3
        ) {
          showErr('Enter a work date, at least one time, and a short reason.');
          return false;
        }
        await API.post('/me/time-corrections', body);
        UI.toast('Correction submitted for approval');
        await load();
      },
    });
  }
  await load();
});
