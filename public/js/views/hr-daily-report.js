/* Daily Report — a live, whole-company attendance snapshot for one calendar date: who's
   present / late / absent / on leave, with a per-department breakdown. Sits next to the
   Time-in Kiosk in HR > Time Keeping, but unlike everything else under Time Keeping it isn't
   scoped to one cutoff — GET /hr/daily-report covers every active employee regardless of
   which (if any) period's roster they're on, and reads live kiosk/phone punches when nothing's
   been typed or imported into a cutoff's attendance grid yet. See src/hr-daily-report.ts for
   why this deliberately doesn't reuse the payroll engine's day classification. */
App.register('hr-daily-report', async (view, filter) => {
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const STATUS_META = {
    present: { label: 'Present', badge: 'ok' },
    late: { label: 'Late', badge: 'status-confirmed' },
    absent: { label: 'Absent', badge: 'low' },
    leave: { label: 'On Leave', badge: 'status-open' },
    reported: { label: 'Reported', badge: 'status-confirmed' },
    not_scheduled: { label: 'Not Scheduled', badge: 'muted' },
    pending: { label: 'Not Yet In', badge: 'muted' },
  };
  const STATUS_FILTERS = ['present', 'late', 'absent', 'leave', 'reported', 'not_scheduled', 'pending'];

  const TODAY = todayStr();
  // HR Overview's "present today" cards link straight in here pre-filtered to one status
  // (e.g. { status: 'absent' }) so a click there lands on exactly who's absent, not the whole roster.
  const initialStatus = filter && STATUS_FILTERS.includes(filter.status) ? filter.status : '';
  const state = { date: TODAY, status: initialStatus, q: '', data: null };

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Daily Report</h2>
        <div class="sub">Who's in today, at a glance — by department</div>
      </div>
      <div class="grow"></div>
      <input type="date" id="dr-date" value="${TODAY}" max="${TODAY}" aria-label="Date" />
      <button type="button" class="btn secondary small" id="dr-today">Today</button>
      <button type="button" class="btn secondary" id="dr-refresh">${UI.icon('history', 15)} Refresh</button>
    </div>
    <div class="muted dr-asof" id="dr-asof" style="margin:-10px 0 14px;font-size:12px"></div>
    <div id="dr-body"><div class="empty">Loading…</div></div>`;

  const dateInput = view.querySelector('#dr-date');
  const bodyEl = view.querySelector('#dr-body');
  const asOfEl = view.querySelector('#dr-asof');

  const style = document.createElement('style');
  style.textContent = `
    .dr-footnote{margin:-10px 0 18px;font-size:12.5px}
    .dr-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    .dr-toolbar input[type="search"]{flex:1 1 220px}
    .dr-toolbar select{width:auto;min-width:140px}
    tr.dr-group-row td{background:var(--surface-2);font-size:11px;font-weight:700;
      text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);
      padding:12px 16px 7px;border-bottom:1px solid var(--border-strong)}
    tr.dr-group-row span{font-weight:400;opacity:.8;text-transform:none;letter-spacing:0}
    .dr-stat-card{cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease,transform .05s ease}
    .dr-stat-card:hover{border-color:var(--accent);box-shadow:var(--shadow-md)}
    .dr-stat-card:active{transform:translateY(1px)}
    .dr-stat-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;
  view.appendChild(style);

  async function load(silent) {
    // A background auto-refresh redraws in place — don't flash "Loading…" over data that's
    // already on screen, that's jarring for something meant to just quietly stay current.
    if (!silent) bodyEl.innerHTML = '<div class="empty">Loading…</div>';
    let data;
    try {
      data = await API.get('/hr/daily-report?date=' + encodeURIComponent(state.date));
    } catch (e) {
      if (!silent) bodyEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`;
      return;
    }
    state.data = data;
    draw();
  }

  // The 4 headline stat cards double as buttons — click one to see exactly who's in it.
  function statCardsHTML(t, isToday) {
    const card = (status, cls, icon, value, label) => `
      <div class="stat-card dr-stat-card ${cls}" data-status="${status}" role="button" tabindex="0"
        aria-label="${UI.esc(label)}: ${value}. Show the list.">
        <div class="stat-ic">${UI.icon(icon, 20)}</div>
        <div><div class="value">${value}</div><div class="label">${UI.esc(label)}</div></div>
      </div>`;
    return `
      <div class="cards">
        ${card('present', 'good', 'check', t.present, 'Present')}
        ${card('late', 'warn', 'history', t.late, 'Late')}
        ${card('absent', 'alert', 'alert', t.absent, 'Absent')}
        ${card('leave', '', 'calendar', t.leave, 'On Leave')}
        ${card('reported', '', 'messages', t.reported, 'Reported')}
      </div>
      <p class="muted dr-footnote">Also ${t.not_scheduled} not scheduled today (rest day, holiday,
        or a company no-work day)${isToday ? ` and ${t.pending} not yet due in` : ''} —
        neither is counted as absent above. "Reported" means a chat/verbal report was linked to
        the absence — still unpaid, just not a silent no-call/no-show.</p>`;
  }

  /** Employees grouped by department into a <table> (no wrapping .panel — callers add their
      own container, since this is shared by the main page section and the stat-card modal). */
  function groupedTableHTML(list) {
    const groups = new Map();
    list.forEach((e) => {
      if (!groups.has(e.department_name)) groups.set(e.department_name, []);
      groups.get(e.department_name).push(e);
    });
    const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

    const rows = groupNames.map((name) => {
      const empRows = groups.get(name);
      const head = `<tr class="dr-group-row"><td colspan="5">${UI.esc(name)} <span>(${empRows.length})</span></td></tr>`;
      const body = empRows.map((e) => {
        const meta = STATUS_META[e.status] || STATUS_META.absent;
        return `<tr>
          <td>${UI.esc(e.name)}${e.employee_no ? `<div class="muted mono" style="font-size:11px">${UI.esc(e.employee_no)}</div>` : ''}</td>
          <td><span class="badge-pill ${meta.badge}">${UI.esc(meta.label)}</span></td>
          <td class="mono">${UI.esc(e.time_in || '—')}</td>
          <td class="mono">${UI.esc(e.time_out || '—')}</td>
          <td class="muted">${UI.esc(e.note || '')}</td>
        </tr>`;
      }).join('');
      return head + body;
    }).join('');

    return `<table>
      <thead><tr><th>Employee</th><th>Status</th><th>Time In</th><th>Time Out</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function openStatusModal(status) {
    const d = state.data;
    if (!d) return;
    const meta = STATUS_META[status];
    const list = d.employees.filter((e) => e.status === status);
    UI.modal({
      title: `${meta.label} — ${list.length} of ${d.employees.length}`,
      size: 'lg',
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: list.length
        ? groupedTableHTML(list)
        : UI.emptyState({ icon: 'users', title: `Nobody is ${meta.label.toLowerCase()}` }),
    });
  }

  function deptTableHTML(byDept) {
    if (!byDept.length) return '';
    return `
      <div class="panel" style="margin-bottom:20px">
        <div class="panel-head"><h3>By department</h3></div>
        <table>
          <thead><tr>
            <th>Department</th><th class="right">Present</th><th class="right">Late</th>
            <th class="right">Absent</th><th class="right">Reported</th><th class="right">On Leave</th><th class="right">Total</th>
          </tr></thead>
          <tbody>${byDept.map((r) => `<tr>
            <td>${UI.esc(r.department_name)}</td>
            <td class="right">${r.present}</td>
            <td class="right">${r.late}</td>
            <td class="right">${r.absent}</td>
            <td class="right">${r.reported}</td>
            <td class="right">${r.leave}</td>
            <td class="right">${r.total}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function employeeSectionHTML(employees) {
    const q = state.q.trim().toLowerCase();
    const filtered = employees.filter((e) =>
      (!q || e.name.toLowerCase().includes(q)) && (!state.status || e.status === state.status));

    if (!filtered.length) {
      return UI.emptyState({
        icon: 'users', title: 'No employees match',
        hint: q || state.status ? 'Try a different search or status filter.' : 'No active employees yet.',
      });
    }
    return `<div class="panel">${groupedTableHTML(filtered)}</div>`;
  }

  function draw() {
    const d = state.data;
    if (!d) return;
    asOfEl.textContent = d.is_today
      ? `Live — as of ${new Date(d.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}, refreshes automatically`
      : '';
    bodyEl.innerHTML = `
      ${statCardsHTML(d.totals, d.is_today)}
      ${deptTableHTML(d.by_department)}
      <div class="dr-toolbar">
        <input type="search" id="dr-search" placeholder="Search name…" autocomplete="off" value="${UI.esc(state.q)}" />
        <select id="dr-status">
          <option value="">All statuses</option>
          ${STATUS_FILTERS.map((s) => `<option value="${s}" ${state.status === s ? 'selected' : ''}>${STATUS_META[s].label}</option>`).join('')}
        </select>
      </div>
      <div id="dr-emp-section"></div>`;

    view.querySelector('#dr-emp-section').innerHTML = employeeSectionHTML(d.employees);

    bodyEl.querySelectorAll('.dr-stat-card').forEach((card) => {
      card.addEventListener('click', () => openStatusModal(card.dataset.status));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStatusModal(card.dataset.status); }
      });
    });

    view.querySelector('#dr-search').addEventListener('input', (e) => {
      state.q = e.target.value;
      view.querySelector('#dr-emp-section').innerHTML = employeeSectionHTML(d.employees);
    });
    view.querySelector('#dr-status').addEventListener('change', (e) => {
      state.status = e.target.value;
      view.querySelector('#dr-emp-section').innerHTML = employeeSectionHTML(d.employees);
    });
  }

  // Auto-refresh — this board sits next to the live Time-in Kiosk, so it should keep noticing
  // new time-ins through the day on its own, not just on the load a user happened to open it
  // on. Only while looking at "today" (a fixed past date never changes) and never while the
  // search box has focus (a redraw would otherwise yank the cursor mid-keystroke).
  const AUTO_REFRESH_MS = 60_000;
  let autoTimer = null;
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  function startAuto() {
    stopAuto();
    if (state.date !== TODAY) return;
    autoTimer = setInterval(() => {
      const search = view.querySelector('#dr-search');
      if (search && document.activeElement === search) return;
      load(true);
    }, AUTO_REFRESH_MS);
  }

  dateInput.addEventListener('change', () => { state.date = dateInput.value || TODAY; load(); startAuto(); });
  view.querySelector('#dr-today').addEventListener('click', () => { dateInput.value = TODAY; state.date = TODAY; load(); startAuto(); });
  view.querySelector('#dr-refresh').addEventListener('click', () => load());

  // App.navigate() never calls back into a torn-down view, so watch for our own root being
  // detached (view.innerHTML gets reassigned wholesale on the next navigation) to stop polling
  // instead of leaking an interval that keeps hitting the API from a screen nobody's on.
  const mo = new MutationObserver(() => {
    if (!document.body.contains(bodyEl)) { stopAuto(); mo.disconnect(); }
  });
  mo.observe(document.getElementById('view') || document.body, { childList: true, subtree: true });

  load();
  startAuto();
});
