/* HR: module launcher, now fronted by a live "what needs attention today" summary — who's in
   today (GET /hr/daily-report) and what's pending (GET /hr/pending-requests: leave/OT/other
   self-filed requests + attendance-correction fixes). Employees and Time Keeping are real
   modules; Payroll and Leave Management both jump into their existing Data Form record lists
   (same pattern). */
App.register('hr', async (view) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  const MODULES = [
    { icon: 'sheet', title: 'Payroll', hint: 'Payslips, earnings & deductions per cutoff.', action: () => openDataForm('hr_payroll') },
    { icon: 'users', title: 'Employees', hint: 'Master list: department, position, daily rate, leave-day bank.', action: () => App.navigate('hr-employees') },
    { icon: 'calendar', title: 'Time Keeping', hint: 'Per-cutoff roster with daily time-in/out.', action: () => App.navigate('hr-timekeeping') },
    { icon: 'note', title: 'Leave Management', hint: 'Leave requests, status & balance impact — edit an employee’s leave-day bank under Employees.', action: () => openDataForm('leave_request') },
  ].filter((m) => m.title !== 'Payroll' || App.hasPermission('payroll.view')); // pay is its own permission

  const [daily, initialPending, initialFlags, periodsList] = await Promise.all([
    API.get('/hr/daily-report').catch(() => null),
    API.get('/hr/pending-requests').catch(() => null),
    API.get('/hr/cutoff-flags').catch(() => null),
    API.get('/hr/periods').catch(() => []),
  ]);
  // Mutable — reassigned whenever the "Needs Attention" panel's own cutoff switcher picks a
  // different period, so the notify/open-Time-Keeping handlers below always read whichever
  // cutoff is currently showing instead of the one loaded at page-open time.
  let flags = initialFlags;
  // Mutable too — reassigned by refreshPending() after a request is approved/rejected from its
  // own detail modal, so the Requests panel's counts/lists reflect the decision immediately.
  let pending = initialPending;
  // GET /form-definitions is fetched once and reused by both the pending-type list modal and
  // the single-record detail modal (both need a slug -> {id, name, fields} lookup).
  let formDefsCache = null;
  async function getFormDefs() {
    if (!formDefsCache) formDefsCache = await API.get('/form-definitions').catch(() => []);
    return formDefsCache;
  }

  const statCard = (cls, ic, label, value, go) => `
    <div class="stat-card ${cls}${go ? ' clickable' : ''}" ${go ? `data-go="${go}"` : ''}>
      <div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${label}</div></div>
    </div>`;

  const t = daily && daily.totals;
  const todayHTML = t ? `
    <div class="cards">
      ${statCard('good', 'check', 'Present', t.present, 'hr-daily-report:present')}
      ${statCard(t.late > 0 ? 'warn' : '', 'history', 'Late', t.late, 'hr-daily-report:late')}
      ${statCard(t.absent > 0 ? 'alert' : '', 'alert', 'Absent', t.absent, 'hr-daily-report:absent')}
      ${statCard('', 'calendar', 'On Leave', t.leave, 'hr-daily-report:leave')}
      ${statCard('', 'messages', 'Reported', t.reported, 'hr-daily-report:reported')}
    </div>
    <p class="muted" style="margin:-10px 0 20px;font-size:12.5px">
      Out of ${t.total} active employees today. Also ${t.not_scheduled} not scheduled (rest day,
      holiday, or a company no-work day)${t.pending ? ` and ${t.pending} not yet due in` : ''}.
    </p>` : '<p class="muted" style="margin:0 0 20px">Today’s attendance snapshot isn’t available right now.</p>';

  // Each pending request type (fd.icon/fd.name straight from GET /hr/pending-requests) plus
  // pending attendance-correction fixes, which live in their own table (not a form record) and
  // so have no desktop review screen yet — shown for visibility, decided from mobile Approvals.
  // All computed as functions (not fixed at page-open) since `pending` gets reassigned by
  // refreshPending() after a decision, and these need to reflect that live.
  const pendingRows = () => (pending ? pending.by_type.slice() : []);
  const pendingTotal = () => (pending ? pending.total : 0);
  // Icon per slug, borrowed from by_type (the form's own configured icon) — a Time Correction
  // isn't a form record so it has no fd.icon to borrow, hence the 'adjust' fallback below.
  const iconBySlugMap = () => new Map(pendingRows().map((r) => [r.slug, r.icon]));

  // A pending TYPE row (e.g. "Leave Request — 100") opens a list of every individual pending
  // record of that type; clicking one of those opens its own detail modal — no navigation to
  // Form Records at any point. Attendance Corrections has no per-record form (its own table,
  // see time_corrections), so it stays a plain count, same as before.
  const pendingTypeRowHTML = (r) => `
    <div class="clickable" data-pending-slug="${UI.esc(r.slug)}" data-pending-name="${UI.esc(r.name)}"
      style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-strong)">
      <div style="color:var(--text-faint)">${UI.icon(r.icon || 'note', 18)}</div>
      <div style="flex:1;font-weight:600">${UI.esc(r.name)}</div>
      <span class="badge-pill low">${r.count}</span>
    </div>`;
  const correctionsRowHTML = (count) => `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-strong)">
      <div style="color:var(--text-faint)">${UI.icon('adjust', 18)}</div>
      <div style="flex:1;font-weight:600">Attendance Corrections</div>
      <span class="badge-pill low">${count}</span>
    </div>`;

  const pendingListHTML = () => {
    const rows = pendingRows();
    return !pending
      ? '<div class="empty">Pending requests aren’t available right now.</div>'
      : rows.length || pending.time_corrections
        ? `<div style="margin-bottom:-1px">
            ${rows.map(pendingTypeRowHTML).join('')}
            ${pending.time_corrections ? correctionsRowHTML(pending.time_corrections) : ''}
          </div>`
        : UI.emptyState({ icon: 'check', title: 'No pending requests', hint: 'Leave, overtime and other employee requests will show up here as they’re filed.' });
  };

  // A Recent row is already one specific record (not an aggregate) — 'request' kind opens
  // straight into that record's own detail modal (fetching it fresh by id); 'correction' kind
  // (a time_corrections row, not a form record) has no per-record view here, unchanged from
  // before.
  const recentRowHTML = (r, iconBySlug) => {
    const clickable = r.kind === 'request';
    return `<div class="${clickable ? 'clickable' : ''}" ${clickable ? `data-recent-id="${r.id}" data-recent-slug="${UI.esc(r.slug)}"` : ''}
        style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-strong)">
        <div style="color:var(--text-faint)">${UI.icon(iconBySlug.get(r.slug) || 'adjust', 18)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${UI.esc(r.form_name)}</div>
          <div class="muted" style="font-size:12px">${UI.esc(r.employee_name || 'Unknown employee')}</div>
        </div>
        <div class="muted" style="font-size:11.5px;white-space:nowrap">${UI.fmtDateShort(r.created_at)}</div>
      </div>`;
  };
  const recentHTML = () => {
    const iconBySlug = iconBySlugMap();
    return !pending
      ? '<div class="empty">Recent requests aren’t available right now.</div>'
      : pending.recent.length
        ? `<div style="margin-bottom:-1px">${pending.recent.map((r) => recentRowHTML(r, iconBySlug)).join('')}</div>`
        : UI.emptyState({ icon: 'history', title: 'Nothing filed recently' });
  };

  // Pending/Recent share one panel now (was two side-by-side panels, one of which was almost
  // always near-empty and stretched to match the other's height) — a small toggle switches
  // between them within a fixed-height scrollable body instead.
  let reqTab = 'pending';
  const reqBodyHTML = () => (reqTab === 'pending' ? pendingListHTML() : recentHTML());
  const reqToggleHTML = () => `
    <button type="button" class="subtab ${reqTab === 'pending' ? 'active' : ''}" data-req-tab="pending">
      Pending${pending && pendingTotal() > 0 ? ` <span class="badge-pill low" style="margin-left:2px">${pendingTotal()}</span>` : ''}
    </button>
    <button type="button" class="subtab ${reqTab === 'recent' ? 'active' : ''}" data-req-tab="recent">Recent</button>`;

  // Read-only field rows (label: value) for one record's `data`, driven by the form's own
  // field definitions (form_definitions.fields) — same generic, data-driven rendering
  // form-records.js uses, just laid out for a compact read-only modal instead of an edit form.
  // decid*-prefixed keys are skipped — for a pending record they're not set yet anyway.
  function fieldRowsHTML(formDef, data) {
    return (formDef.fields || [])
      .filter((f) => data[f.key] != null && String(data[f.key]).trim() !== '' && !/^decid/.test(f.key))
      .map((f) => `
        <div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border-strong)">
          <span class="muted" style="font-size:12.5px">${UI.esc(f.label || f.key)}</span>
          <span style="font-weight:600;text-align:right">${UI.esc(String(data[f.key]))}</span>
        </div>`).join('');
  }

  // One record's detail — fields read-only, Approve/Reject in the header when it's still
  // pending. Decides via the same endpoint mobile Approvals uses (POST /me/approvals/requests/
  // :id/decide), so balance consumption (leave_request with_pay=Yes), decision stamps, and the
  // requester notification all happen exactly as they do there. A leave request that would
  // overdraw the employee's bank comes back as a 400 inviting an override — offered here as a
  // confirm-again step, same wording the server already uses.
  function openRequestDetailModal(formDef, record, opts) {
    opts = opts || {};
    const data = record.data || {};
    const canDecide = record.status === 'pending';
    const infoChange = formDef.slug === 'information_change';
    const m = UI.modal({
      title: `${formDef.name} — ${record.number}`,
      bodyHTML: `
        <div>${fieldRowsHTML(formDef, data) || '<p class="muted">No details recorded.</p>'}</div>
        ${infoChange ? `<div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border-strong)">
            <span class="muted" style="font-size:12.5px">On record now</span>
            <span style="font-weight:600;text-align:right">${UI.esc(data.current_value || '—')}</span></div>
          <p class="muted" style="margin-top:12px">${canDecide
            ? 'Approving writes the correct value to the employee record (HR managers only).'
            : data.applied === true ? 'Applied to the employee record.' : UI.esc(data.applied_note || '')}</p>` : ''}
        ${canDecide ? '' : `<p class="muted" style="margin-top:12px">Status: ${UI.esc(record.status)}</p>`}`,
      headActionHTML: canDecide
        ? `<button type="button" class="btn danger small" id="hr-req-reject">Reject</button>
           <button type="button" class="btn small" id="hr-req-approve" style="margin-left:8px">Approve</button>`
        : '',
      cancelText: 'Close',
      onOpen: (ov) => {
        const decide = async (decision, overrideBalance) => {
          try {
            const res = await API.post(`/me/approvals/requests/${record.id}/decide`, {
              decision, override_balance: overrideBalance || undefined,
            });
            UI.toast(res && res.applied_note ? `Request ${decision} — ${res.applied_note}`
              : res && res.applied ? 'Approved — employee record updated' : `Request ${decision}`, 'success');
            m.close();
            if (opts.onDecided) opts.onDecided();
          } catch (e) {
            if (!overrideBalance && /approve anyway to override/i.test(e.message || '')) {
              if (await UI.confirmDialog(e.message, 'Approve anyway')) return decide(decision, true);
              return;
            }
            UI.toast(e.message || 'Could not save decision', 'error');
          }
        };
        const approveBtn = ov.querySelector('#hr-req-approve');
        const rejectBtn = ov.querySelector('#hr-req-reject');
        if (approveBtn) approveBtn.onclick = async () => {
          if (await UI.confirmDialog(`Approve this ${formDef.name.toLowerCase()}?`, 'Approve')) decide('approved');
        };
        if (rejectBtn) rejectBtn.onclick = async () => {
          if (await UI.confirmDialog(`Reject this ${formDef.name.toLowerCase()}?`, 'Reject')) decide('rejected');
        };
      },
    });
  }

  // A pending-type row's list of individual records — picking one opens its detail modal on
  // top (modals stack fine; #modal-root just holds however many are open). Deciding refreshes
  // both this list (re-fetch + rebuild in place) and the Requests panel's own counts.
  async function openPendingListModal(slug, typeName) {
    const defs = await getFormDefs();
    const formDef = defs.find((f) => f.slug === slug);
    if (!formDef) { UI.toast('Form not found', 'error'); return; }
    let records;
    try {
      records = await API.get(`/form-definitions/${formDef.id}/records?status=pending`);
    } catch (e) {
      UI.toast(e.message || 'Could not load requests', 'error');
      return;
    }
    const m = UI.modal({
      title: `Pending — ${typeName}`,
      size: 'lg',
      bodyHTML: records.length
        ? `<div style="margin:-4px -4px 0">${records.map((r, i) => `
            <button type="button" class="clickable" data-pick="${i}"
              style="display:flex;width:100%;align-items:center;gap:12px;padding:11px 8px;border:none;background:none;text-align:left;font:inherit;cursor:pointer;border-bottom:1px solid var(--border-strong)">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600">${UI.esc(r.data.employee_name || r.number)}</div>
                <div class="muted" style="font-size:12px">${UI.esc(r.number)}${r.data.date_from ? ` · ${UI.esc(r.data.date_from)}${r.data.date_to && r.data.date_to !== r.data.date_from ? ` – ${UI.esc(r.data.date_to)}` : ''}` : ''}</div>
              </div>
              <span class="muted" style="font-size:12px;white-space:nowrap">${UI.fmtDateShort(r.created_at)}</span>
            </button>`).join('')}</div>`
        : UI.emptyState({ icon: 'check', title: 'Nothing pending', hint: `Every ${typeName} has already been decided.` }),
      cancelText: 'Close',
      onOpen: (ov) => {
        ov.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
          const r = records[Number(b.dataset.pick)];
          openRequestDetailModal(formDef, r, {
            onDecided: () => { m.close(); refreshPending(); openPendingListModal(slug, typeName); },
          });
        });
      },
    });
  }

  // Refreshes the Requests panel after a decision — re-fetches the aggregate counts/recent list
  // and repaints whichever tab is currently showing, so Overview never shows a stale "100
  // pending" after HR just cleared one from a modal.
  async function refreshPending() {
    pending = await API.get('/hr/pending-requests').catch(() => null);
    const toggleEl = view.querySelector('#hr-req-toggle');
    if (toggleEl) { toggleEl.innerHTML = reqToggleHTML(); wireReqToggle(); }
    const bodyEl = view.querySelector('#hr-req-body');
    if (bodyEl) { bodyEl.innerHTML = reqBodyHTML(); wireReqBody(bodyEl); }
  }

  // Employees with a possible half day / unrecorded OT / incomplete punch on some cutoff, so HR
  // can go talk to them before payroll runs. See GET /hr/cutoff-flags. Re-rendered whenever the
  // panel's own cutoff dropdown picks a different period, not just at page-open time.
  const flagBadge = (n, label) => n
    ? `<span class="badge-pill low" style="margin-right:6px">${n} ${label}${n === 1 ? '' : 's'}</span>` : '';
  const flagRowHTML = (e) => `
    <div class="clickable" data-flag-emp="${e.employee_id}"
      style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-strong)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${UI.esc(e.name)}</div>
        <div class="muted" style="font-size:12px">${UI.esc(e.department_name)}</div>
      </div>
      <div style="text-align:right;white-space:nowrap">
        ${flagBadge(e.possible_half_day_dates.length, 'Half Day')}
        ${flagBadge(e.unrecorded_ot_dates.length, 'OT')}
        ${flagBadge(e.incomplete_punch_dates.length, 'Incomplete')}
      </div>
      ${e.user_id
        ? `<button class="icon-btn" title="Message ${UI.esc(e.name)} about these" data-flag-notify="${e.employee_id}">${UI.icon('send', 15)}</button>`
        : '<span style="width:32px"></span>'}
    </div>`;
  // Every cutoff on file, most recent first (same order GET /hr/periods already returns) — the
  // switcher so HR isn't stuck only ever seeing whichever one is "current" today. A searchable
  // combobox (UI.combo) rather than a plain <select>: once cutoffs pile up (a couple years of
  // semi-monthly periods is 40+), scrolling a native dropdown to find one gets old fast — type
  // a few letters of the label/date instead.
  const periodComboOptions = () => periodsList.map((p) => ({
    value: p.id, label: `${p.label} (${p.start_date} – ${p.end_date})`,
  }));
  const flagsBodyHTML = () => !flags
    ? '<div class="empty">Cutoff follow-ups aren’t available right now.</div>'
    : !flags.period
      ? UI.emptyState({ icon: 'calendar', title: 'No cutoff to check', hint: 'Create a pay cutoff under Time Keeping to start tracking this.' })
      : flags.employees.length
        ? `<div style="margin-bottom:-1px">${flags.employees.map(flagRowHTML).join('')}</div>`
        : UI.emptyState({ icon: 'check', title: 'All caught up', hint: `No possible half days, unrecorded OT, or incomplete punches found for "${UI.esc(flags.period.label)}".` });
  const flagsHeadHTML = () => periodsList.length
    ? `<div id="hr-flags-period" style="width:280px;margin-right:8px"></div>
       <button class="btn secondary small" id="hr-flags-open-tk" ${flags && flags.period ? '' : 'disabled'}>${UI.icon('calendar', 14)} Open Time Keeping</button>`
    : '';

  view.innerHTML = `
    <div class="topbar">
      <div><h2>Human Resources</h2>
      <div class="sub">A live look at who's in today and what's waiting on you.</div></div>
    </div>

    ${todayHTML}

    <div class="grid-2" style="margin-bottom:20px;align-items:start">
      <div class="panel">
        <div class="panel-head" style="flex-wrap:wrap;row-gap:8px">
          <h3>Requests</h3>
          <div class="grow"></div>
          <div id="hr-req-toggle" style="display:flex;gap:4px">${reqToggleHTML()}</div>
        </div>
        <div id="hr-req-body" style="height:420px;overflow-y:auto">${reqBodyHTML()}</div>
      </div>
      <div class="panel">
        <div class="panel-head" id="hr-flags-head" style="flex-wrap:wrap;row-gap:8px">
          <h3>Needs Attention</h3>
          <div class="grow"></div>
          ${flagsHeadHTML()}
        </div>
        <p class="muted" style="margin:0;padding:12px 16px 0;font-size:12.5px">
          Possible half day with no request linked, OT worked with no request filed, or a day
          with only one of time-in/time-out — flagged for the cutoff selected above.
        </p>
        <div id="hr-flags-body" style="height:420px;overflow-y:auto;margin-top:8px">${flagsBodyHTML()}</div>
      </div>
    </div>

    <div class="panel" style="padding:24px">
      <h3 style="margin:0 0 14px">Modules</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:14px">
        ${MODULES.map((m, i) => `
          <div class="${m.action ? 'clickable' : ''}" data-mod="${i}" style="border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:18px;background:var(--surface-2)">
            <div style="color:var(--text-faint);margin-bottom:10px">${UI.icon(m.icon, 26)}</div>
            <div style="font-weight:600;margin-bottom:4px">${UI.esc(m.title)}</div>
            <div class="muted" style="font-size:12.5px">${UI.esc(m.hint)}</div>
            ${!m.action ? '<span class="badge-pill muted" style="margin-top:8px;display:inline-block">Coming soon</span>' : ''}
          </div>`).join('')}
      </div>
    </div>`;

  // Jumps straight into a specific Data Form's record list (Payroll -> hr_payroll, Leave
  // Management -> leave_request) instead of the generic "pick a form" index — falls back to
  // that index if the form can't be found (not yet created, or this user's forms.manage.<scope>
  // doesn't cover it, in which case form-records.js's own access gate explains why).
  async function openDataForm(slug) {
    try {
      const forms = await API.get('/form-definitions');
      const form = forms.find((f) => f.slug === slug);
      if (form) App.navigate('form-records', { form_id: form.id });
      else App.navigate('form-records');
    } catch {
      App.navigate('form-records');
    }
  }

  view.querySelectorAll('[data-mod]').forEach((card) => {
    const m = MODULES[Number(card.dataset.mod)];
    if (m.action) card.onclick = m.action;
  });

  // data-go carries either a bare route ("hr-employees") or "route:status" (Daily Report's
  // stat cards, pre-filtered to that one status) — the "today" cards above the Requests panel;
  // nothing in the Requests panel itself uses data-go any more (see data-pending-slug/
  // data-recent-id below), so this only ever needs wiring once, against the static parts of view.
  function wireGoLinks(root) {
    root.querySelectorAll('[data-go]').forEach((el) => {
      const [route, arg] = el.dataset.go.split(':');
      el.addEventListener('click', () => {
        if (arg) App.navigate(route, { status: arg });
        else App.navigate(route);
      });
    });
  }
  wireGoLinks(view);

  // Requests panel: Pending/Recent toggle (buttons themselves are replaced on refreshPending,
  // hence its own re-wireable function) + the actual row clicks inside #hr-req-body.
  function wireReqToggle() {
    view.querySelectorAll('[data-req-tab]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.reqTab === reqTab) return;
      reqTab = btn.dataset.reqTab;
      view.querySelectorAll('[data-req-tab]').forEach((b) => b.classList.toggle('active', b.dataset.reqTab === reqTab));
      const bodyEl = view.querySelector('#hr-req-body');
      bodyEl.innerHTML = reqBodyHTML();
      wireReqBody(bodyEl);
    }));
  }
  function wireReqBody(root) {
    root.querySelectorAll('[data-pending-slug]').forEach((el) => el.addEventListener('click', () => {
      openPendingListModal(el.dataset.pendingSlug, el.dataset.pendingName);
    }));
    root.querySelectorAll('[data-recent-id]').forEach((el) => el.addEventListener('click', async () => {
      const defs = await getFormDefs();
      const formDef = defs.find((f) => f.slug === el.dataset.recentSlug);
      if (!formDef) { UI.toast('Form not found', 'error'); return; }
      let record;
      try { record = await API.get(`/form-records/${el.dataset.recentId}`); }
      catch (e) { UI.toast(e.message || 'Could not load request', 'error'); return; }
      openRequestDetailModal(formDef, record, { onDecided: refreshPending });
    }));
  }
  wireReqToggle();
  wireReqBody(view.querySelector('#hr-req-body'));

  // "Needs Attention" panel — a cutoff switcher (only the panel's own body reloads on change,
  // not the whole page), a header button + row clicks that both open that cutoff at Time
  // Keeping, and a per-employee notify that messages a consolidated notice of what needs
  // following up. wireFlagsPanel is re-run after every body re-render (period switch), since
  // the elements it binds to are replaced each time.
  function wireFlagsPanel() {
    const openTkBtn = view.querySelector('#hr-flags-open-tk');
    if (openTkBtn) openTkBtn.onclick = () => {
      if (flags && flags.period) App.navigate('hr-timekeeping', { period_id: flags.period.id });
    };
    // A row opens straight into THAT employee's Daily Time modal, right here on Overview —
    // no navigation to the Time Keeping tab at all (HrTimekeeping.openEmployeeDailyGrid runs
    // entirely off-screen and only surfaces the modal itself, see hr-timekeeping.js).
    view.querySelectorAll('[data-flag-emp]').forEach((row) => row.addEventListener('click', () => {
      if (flags && flags.period) HrTimekeeping.openEmployeeDailyGrid(flags.period.id, Number(row.dataset.flagEmp));
    }));
    view.querySelectorAll('[data-flag-notify]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const emp = flags.employees.find((x) => String(x.employee_id) === btn.dataset.flagNotify);
      if (!emp) return;
      const lines = [];
      if (emp.possible_half_day_dates.length)
        lines.push(`- Possible half day with no Half Day request filed: ${emp.possible_half_day_dates.join(', ')}`);
      if (emp.unrecorded_ot_dates.length)
        lines.push(`- Worked past your shift with no Overtime Request filed: ${emp.unrecorded_ot_dates.join(', ')}`);
      if (emp.incomplete_punch_dates.length)
        lines.push(`- Time-in but no time-out (or vice versa): ${emp.incomplete_punch_dates.join(', ')}`);
      const ok = await UI.confirmDialog(
        `Send ${UI.esc(emp.name)} a notice about ${lines.length} item(s) in "${UI.esc(flags.period.label)}"?`,
        'Send notice');
      if (!ok) return;
      try {
        await API.post('/messages', {
          recipient_id: emp.user_id,
          subject: `Timekeeping — please see HR (${flags.period.label})`,
          body: `Hi ${emp.name},\n\nYour attendance for the cutoff "${flags.period.label}" has the following that need your attention:\n\n${lines.join('\n')}\n\nPlease file the appropriate request form, or see HR, so your payroll is computed correctly.\n\nThank you.`,
        });
        UI.toast(`Notice sent to ${emp.name}`, 'success');
      } catch (ex) {
        UI.toast(ex.message || 'Could not send notice', 'error');
      }
    }));
    // Rebuilt fresh on every wireFlagsPanel() call (initial render + after each period switch)
    // so it always reflects the currently-selected cutoff — cheap for a list this size, and
    // keeps this function's "just re-render this section" pattern consistent with the rest.
    const periodHost = view.querySelector('#hr-flags-period');
    if (periodHost) {
      UI.combo(periodHost, periodComboOptions(), {
        selected: flags && flags.period ? flags.period.id : null,
        placeholder: 'Search cutoffs…',
        emptyText: 'No matching cutoff',
        onSelect: (value) => { if (value != null) loadFlagsFor(Number(value)); },
      });
    }
  }

  async function loadFlagsFor(periodId) {
    const bodyEl = view.querySelector('#hr-flags-body');
    bodyEl.innerHTML = '<div class="empty">Loading…</div>';
    flags = await API.get(`/hr/cutoff-flags?period_id=${periodId}`).catch(() => null);
    bodyEl.innerHTML = flagsBodyHTML();
    wireFlagsPanel();
  }

  wireFlagsPanel();
});
