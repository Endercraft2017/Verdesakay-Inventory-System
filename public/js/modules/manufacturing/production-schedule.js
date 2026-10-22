/* Production → Schedule: a month calendar of job orders placed by their
   planned start … due date, coloured by status, filterable by team / work centre, with
   an advisory per-day capacity check. */
App.register('production-schedule', async (view) => {
  const canWrite = App.hasPermission('production.plan');
  const state = { month: new Date(), team: '', wc: '' };
  let jobs = [];
  let teams = [];
  let capacity = 0;

  const ymd = (d) => d.toISOString().slice(0, 10);
  const monthLabel = (d) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const STATUS_COLOR = { draft: '#94a3b8', released: '#2563eb', in_progress: '#0891b2', paused: '#d97706', completed: '#16a34a', cancelled: '#dc2626' };

  view.innerHTML = `
    <div class="topbar">
      <h2>Production Schedule</h2>
      <div class="grow"></div>
      <button class="btn secondary small" id="ps-prev">‹</button>
      <button class="btn secondary small" id="ps-today">Today</button>
      <button class="btn secondary small" id="ps-next">›</button>
      <strong id="ps-mon" style="min-width:150px;text-align:center"></strong>
      <select id="ps-team" style="width:150px"></select>
      <select id="ps-wc" style="width:140px"></select>
    </div>
    <div class="panel">
      <div id="ps-cap" class="muted" style="font-size:12px;margin-bottom:8px"></div>
      <div id="ps-grid" style="overflow-x:auto"></div>
    </div>`;

  const gridEl = view.querySelector('#ps-grid');
  const monEl = view.querySelector('#ps-mon');
  const teamEl = view.querySelector('#ps-team');
  const wcEl = view.querySelector('#ps-wc');
  const capEl = view.querySelector('#ps-cap');

  async function load() {
    [jobs, teams, capacity] = await Promise.all([
      API.get('/job-orders?scheduled=1'),
      API.get('/production/teams').catch(() => []),
      API.get('/production/capacity').then((r) => r.daily_capacity).catch(() => 0),
    ]);
    teamEl.innerHTML = `<option value="">All teams</option>` + teams.map((t) => `<option value="${t.id}" ${String(t.id) === state.team ? 'selected' : ''}>${UI.esc(t.name)}</option>`).join('');
    const wcs = [...new Set(jobs.map((j) => j.work_center).filter(Boolean))].sort();
    wcEl.innerHTML = `<option value="">All work centres</option>` + wcs.map((w) => `<option value="${UI.esc(w)}" ${w === state.wc ? 'selected' : ''}>${UI.esc(w)}</option>`).join('');
    render();
  }

  function activeOn(j, day, todayStr) {
    // A job order with only a due date is drawn as a bar from today up to that date;
    // one with only a planned start sits on that single day.
    const start = j.planned_start || (j.due_date ? todayStr : null);
    const end = j.due_date || j.planned_start;
    if (!start || !end) return false;
    return start <= day && day <= (end < start ? start : end);
  }

  function render() {
    monEl.textContent = monthLabel(state.month);
    const OPEN = new Set(['draft', 'released', 'in_progress', 'paused']);
    const shown = jobs.filter((j) =>
      (!state.team || String(j.team_id) === state.team) &&
      (!state.wc || j.work_center === state.wc));

    capEl.innerHTML = capacity > 0
      ? `Advisory capacity: <strong>${capacity}</strong> units/day. ${canWrite ? '<a href="#" id="ps-editcap">change</a>' : ''}`
      : `No daily capacity set. ${canWrite ? '<a href="#" id="ps-editcap">set one</a>' : ''}`;
    const ec = capEl.querySelector('#ps-editcap');
    if (ec) ec.onclick = (e) => { e.preventDefault(); editCapacity(); };

    const first = new Date(state.month.getFullYear(), state.month.getMonth(), 1);
    const gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());
    const weeks = [];
    const cur = new Date(gridStart);
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let d = 0; d < 7; d++) { row.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      weeks.push(row);
      if (row[6].getMonth() !== state.month.getMonth() && row[0].getMonth() !== state.month.getMonth() && w >= 4) break;
    }
    const todayStr = ymd(new Date());

    gridEl.innerHTML = `
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;min-width:760px">
        <thead><tr>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<th style="padding:4px;font-size:11px;color:var(--text-muted)">${d}</th>`).join('')}</tr></thead>
        <tbody>${weeks.map((row) => `<tr>${row.map((day) => {
          const dStr = ymd(day);
          const inMonth = day.getMonth() === state.month.getMonth();
          const on = shown.filter((j) => activeOn(j, dStr, todayStr));
          const load = on.filter((j) => OPEN.has(j.status)).reduce((s, j) => s + Math.max(0, j.remaining || 0), 0);
          const over = capacity > 0 && load > capacity;
          return `<td style="vertical-align:top;border:1px solid var(--border);height:96px;padding:3px;${inMonth ? '' : 'opacity:.45;'}${dStr === todayStr ? 'outline:2px solid var(--accent,#2563eb);outline-offset:-2px;' : ''}">
            <div style="display:flex;justify-content:space-between;font-size:11px">
              <span>${day.getDate()}</span>
              ${load ? `<span class="badge-pill ${over ? 'low' : ''}" title="planned load">${load}</span>` : ''}
            </div>
            ${on.slice(0, 4).map((j) => `<div class="clickable" data-jo="${j.id}" title="${UI.esc(j.number + ' · ' + j.product_name + (j.team_name ? ' · ' + j.team_name : ''))}"
                style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:3px solid ${STATUS_COLOR[j.status] || '#94a3b8'};padding-left:4px;margin-top:2px${j.overdue ? ';color:var(--danger,#dc2626);font-weight:600' : ''}">
                ${UI.esc(j.number.replace('MO-', '#'))} ${UI.esc(j.product_name)}</div>`).join('')}
            ${on.length > 4 ? `<div class="muted" style="font-size:10px">+${on.length - 4} more</div>` : ''}
          </td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>`;
    gridEl.querySelectorAll('[data-jo]').forEach((el) => el.onclick = () => App.navigate('job-orders', { id: el.dataset.jo }));
  }

  function editCapacity() {
    UI.modal({
      title: 'Daily production capacity',
      bodyHTML: `<div class="form-field"><div class="field-label"><label>Units per day (advisory)</label></div>
        <input data-f="cap" type="number" min="0" value="${capacity || 0}" /></div>
        <p class="muted" style="font-size:12px">Days whose planned load exceeds this are flagged on the board. 0 turns the check off.</p>`,
      confirmText: 'Save',
      onConfirm: async (ov) => {
        capacity = await API.put('/production/capacity', { daily_capacity: parseInt(ov.querySelector('[data-f="cap"]').value, 10) || 0 }).then((r) => r.daily_capacity);
        UI.toast('Saved'); render();
      },
    });
  }

  view.querySelector('#ps-prev').onclick = () => { state.month.setMonth(state.month.getMonth() - 1); render(); };
  view.querySelector('#ps-next').onclick = () => { state.month.setMonth(state.month.getMonth() + 1); render(); };
  view.querySelector('#ps-today').onclick = () => { state.month = new Date(); render(); };
  teamEl.onchange = () => { state.team = teamEl.value; render(); };
  wcEl.onchange = () => { state.wc = wcEl.value; render(); };

  await load();
});
