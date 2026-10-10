/* HR: Time Keeping — cutoff periods with a roster of employees and a daily
   time-in/time-out grid per employee. "Generate Payslips" creates/updates one
   record per roster employee in the existing "HR Payroll" form (Documents >
   Data Forms), reusing that module's print-ready payslip flow.
   Route: hr-timekeeping. filter.period_id = <id> opens a specific cutoff;
   filter.employee_id (with period_id) also auto-opens that employee's Daily Time
   modal — e.g. the HR Overview "Needs Attention" panel jumping straight to one flagged
   employee's grid instead of just landing on the roster and making HR find them. */
App.register('hr-timekeeping', async (view, filter) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  if (filter && filter.period_id) {
    await renderPeriod(view, Number(filter.period_id), filter.employee_id ? Number(filter.employee_id) : null);
  } else {
    await renderList(view);
  }
});

/* ── Cutoff list ──────────────────────────────────────────────────────────── */
async function renderList(view) {
  // Cutoff writes are hr.manage server-side (hr.routes.ts) — a read-only HR viewer gets the
  // list and the calendar/log tools, not create/delete buttons that would only 403.
  const canManage = App.hasPermission('hr.manage');
  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Time Keeping</h2>
        <div class="sub">Pay cutoffs — open one to log daily time-in/out and generate payslips.</div>
      </div>
      <div class="grow"></div>
      <button type="button" class="btn secondary" id="tk-tools-toggle" aria-expanded="false" aria-controls="tk-tools">${UI.icon('settings')} Calendar &amp; tools</button>
      ${canManage ? `<button type="button" class="btn" id="tk-new">${UI.icon('plus')} New Cutoff</button>` : ''}
    </div>
    <div class="hr-tools" id="tk-tools" hidden>
      <div class="hr-tools-group" role="group" aria-labelledby="tk-tools-cal">
        <span class="hr-tools-label" id="tk-tools-cal">Calendar</span>
        <button type="button" class="btn secondary small" id="tk-holidays" title="The PH holiday calendar (Regular / Special Non-Working / Special Working) — pays every employee automatically unless overridden on that person's own Daily Time record">${UI.icon('calendar', 14)} Holidays</button>
        <button type="button" class="btn secondary small" id="tk-noWork" title="Company-wide suspensions and other no-work declarations (typhoon, equipment failure, etc.) — not a public holiday, see the Holidays button for those — applies to every employee automatically, no per-employee linking needed">${UI.icon('alert', 14)} No Work / Suspension</button>
      </div>
      <div class="hr-tools-group" role="group" aria-labelledby="tk-tools-rec">
        <span class="hr-tools-label" id="tk-tools-rec">Records</span>
        <button type="button" class="btn secondary small" id="tk-punchlog" title="Every raw time-clock punch — where each phone punch came from (office, distance, map), and remote punches by field staff">${UI.icon('sheet', 14)} Punch Log</button>
        ${App.hasPermission('payroll.view') ? `<button type="button" class="btn secondary small" id="tk-govforms">${UI.icon('sheet', 14)} Payroll Worksheets</button>` : ''}
      </div>
      <div class="hr-tools-group" role="group" aria-labelledby="tk-tools-set">
        <span class="hr-tools-label" id="tk-tools-set">Setup</span>
        <button type="button" class="btn secondary small" id="tk-policy">${UI.icon('settings', 14)} Policy Settings</button>
      </div>
    </div>
    <div class="panel">
      <div class="hr-filters" id="tk-filters" hidden>
        <div class="search-box search">
          <span class="ic">${UI.icon('search', 15)}</span>
          <label class="hr-sr-only" for="tk-search">Search cutoffs</label>
          <input type="search" id="tk-search" placeholder="Search name or date…" autocomplete="off" />
        </div>
        <div class="fld">
          <label for="tk-year">Year</label>
          <select id="tk-year"><option value="">All years</option></select>
        </div>
        <button type="button" class="btn secondary small" id="tk-filter-reset" hidden>Reset</button>
        <div class="grow"></div>
        <span class="hr-filter-count" id="tk-count" aria-live="polite"></span>
      </div>
      <div id="tk-table"></div>
    </div>`;

  wireHrDisclosure(view.querySelector('#tk-tools-toggle'), view.querySelector('#tk-tools'));
  view.querySelector('#tk-punchlog').addEventListener('click', () => punchLogModal());
  view.querySelector('#tk-policy').addEventListener('click', () => policySettingsModal());
  const govBtn = view.querySelector('#tk-govforms'); // payroll.view only
  if (govBtn) govBtn.addEventListener('click', () => govFormsModal());
  view.querySelector('#tk-holidays').addEventListener('click', () => companyHolidaysModal());
  view.querySelector('#tk-noWork').addEventListener('click', () => noWorkMemoModal());

  const tableEl = view.querySelector('#tk-table');
  const filtersEl = view.querySelector('#tk-filters');
  const searchInput = view.querySelector('#tk-search');
  const yearSel = view.querySelector('#tk-year');
  const resetBtn = view.querySelector('#tk-filter-reset');
  const countEl = view.querySelector('#tk-count');
  let all = [];

  async function load() {
    tableEl.setAttribute('aria-busy', 'true');
    tableEl.innerHTML = '<div class="empty" role="status">Loading cutoffs…</div>';
    try {
      all = await API.get('/hr/periods');
    } catch (err) {
      filtersEl.hidden = true;
      tableEl.innerHTML = UI.emptyState({
        icon: 'alert',
        title: 'Couldn’t load cutoffs',
        hint: (err && err.message) || 'Check your connection, then try again.',
        action: '<button type="button" class="btn secondary" id="tk-retry">Try again</button>',
      });
      tableEl.querySelector('#tk-retry').onclick = () => load();
      return;
    } finally {
      tableEl.removeAttribute('aria-busy');
    }
    // Year options come from the cutoffs themselves (newest first, like the list).
    const years = [...new Set(all.map((p) => String(p.start_date || '').slice(0, 4)).filter(Boolean))];
    const keep = years.includes(yearSel.value) ? yearSel.value : '';
    yearSel.innerHTML = '<option value="">All years</option>' +
      years.map((y) => `<option value="${UI.esc(y)}"${y === keep ? ' selected' : ''}>${UI.esc(y)}</option>`).join('');
    render();
  }

  function render() {
    filtersEl.hidden = !all.length;
    if (!all.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'calendar',
        title: 'No cutoffs yet',
        hint: canManage ? 'Create a pay cutoff to start logging daily time-in/out.' : 'HR hasn’t created a pay cutoff yet.',
        action: canManage ? `<button type="button" class="btn" id="tk-empty-new">${UI.icon('plus')} New Cutoff</button>` : '',
      });
      const en = tableEl.querySelector('#tk-empty-new');
      if (en) en.onclick = () => periodModal(null, load);
      return;
    }
    const q = searchInput.value.trim().toLowerCase();
    const year = yearSel.value;
    const list = all.filter((p) =>
      (!year || String(p.start_date || '').startsWith(year)) &&
      (!q || [p.label, p.start_date, p.end_date].some((v) => String(v || '').toLowerCase().includes(q))));
    resetBtn.hidden = !(q || year);
    countEl.textContent = list.length === all.length
      ? `${all.length} cutoff${all.length === 1 ? '' : 's'}`
      : `${list.length} of ${all.length} cutoffs`;
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'search',
        title: 'No cutoffs match these filters',
        hint: 'Try a different name, date or year.',
        action: '<button type="button" class="btn secondary" id="tk-clear-filters">Clear filters</button>',
      });
      tableEl.querySelector('#tk-clear-filters').onclick = () => resetFilters();
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Cutoff</th><th>Date range</th><th class="right">Employees</th>${canManage ? '<th><span class="hr-sr-only">Actions</span></th>' : ''}</tr></thead>
        <tbody>${list.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><button type="button" class="hr-row-open">${UI.esc(p.label)}</button>${p.locked ? ' <span class="badge-pill">Paid · locked</span>' : ''}</td>
            <td>${UI.esc(p.start_date)} &ndash; ${UI.esc(p.end_date)}</td>
            <td class="right">${p.employee_count || 0}</td>
            ${canManage ? `<td class="actions"><button type="button" class="icon-btn danger" title="Delete cutoff" aria-label="Delete cutoff ${UI.esc(p.label)}" data-del="${p.id}" ${p.locked ? 'disabled title="Locked after payment"' : ''}>${UI.icon('trash')}</button></td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); del(b.dataset.del); });
    // The label is a real <button>, so Tab + Enter/Space opens a cutoff; its click bubbles here.
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      App.navigate('hr-timekeeping', { period_id: tr.dataset.open });
    });
  }

  function resetFilters() {
    searchInput.value = '';
    yearSel.value = '';
    render();
    searchInput.focus();
  }

  async function del(id) {
    const p = all.find((x) => String(x.id) === String(id));
    if (!p) return;
    if (!await UI.confirmDialog(`Delete cutoff "${p.label}"? All logged time-in/out for it will be lost.`, 'Delete')) return;
    try {
      await API.del('/hr/periods/' + id);
    } catch (err) {
      UI.toast((err && err.message) || 'Could not delete the cutoff', 'error');
      return;
    }
    UI.toast('Cutoff deleted');
    load();
  }

  // Only #tk-table re-renders, so the search field keeps focus/caret while typing.
  searchInput.addEventListener('input', () => render());
  yearSel.addEventListener('change', () => render());
  resetBtn.addEventListener('click', () => resetFilters());
  const newBtn = view.querySelector('#tk-new'); // hr.manage only
  if (newBtn) newBtn.addEventListener('click', () => periodModal(null, load));
  await load();
}

// Inline progressive disclosure for rarely used tools: a toggle button that shows/hides a
// panel rendered in normal flow (never an absolutely positioned menu, so nothing gets clipped
// by a scrolling ancestor). Shared by the cutoff list and the cutoff detail screen.
function hrWorkflowLoadError(root, error, retry) {
  root.innerHTML=UI.emptyState({icon:'alert',title:'Couldn’t load these records',hint:error.message || 'Check your connection.',action:'<button type="button" class="btn secondary" data-hr-retry>Try again</button>'});
  root.querySelector('[data-hr-retry]').onclick=retry;
}

function wireHrDisclosure(toggle, panel) {
  if (!toggle || !panel) return;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  });
}

/* ── Cutoff create/edit modal ─────────────────────────────────────────────── */
function periodModal(existing, onSaved) {
  const editing = !!existing;
  UI.modal({
    title: editing ? `Edit ${existing.label}` : 'New Cutoff',
    bodyHTML: `
      <div><label>Label *</label><input data-f="label" placeholder="e.g. Aug 1-15, 2026" value="${UI.esc(editing ? existing.label : '')}" autofocus /></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Start date *</label><input data-f="start_date" type="date" value="${UI.esc(editing ? existing.start_date : '')}" /></div>
        <div><label>End date *</label><input data-f="end_date" type="date" value="${UI.esc(editing ? existing.end_date : '')}" /></div>
      </div>`,
    confirmText: editing ? 'Save' : 'Create',
    onConfirm: async (ov, showErr) => {
      const body = {
        label: ov.querySelector('[data-f="label"]').value.trim(),
        start_date: ov.querySelector('[data-f="start_date"]').value,
        end_date: ov.querySelector('[data-f="end_date"]').value,
      };
      if (!body.label) { showErr('Cutoff label is required'); return false; }
      if (!body.start_date || !body.end_date) { showErr('Start and end dates are required'); return false; }
      if (editing) await API.put('/hr/periods/' + existing.id, body);
      else await API.post('/hr/periods', body);
      UI.toast(editing ? 'Cutoff saved' : 'Cutoff created');
      if (onSaved) onSaved();
    },
  });
}

/* ── Phone time-in location lock (GET/PUT /hr/clock/geofence) ───────────────
   One or more office sites (lat/lng + radius). With the lock on, a phone punch must come from
   inside one of them — see src/modules/hr/clock-geofence.ts. */
async function geofenceModal() {
  const policy = await API.get('/hr/clock/geofence');
  let sites = (policy.sites || []).map((s) => ({ ...s }));

  UI.modal({
    title: 'Phone Time-in Location',
    size: 'lg',
    bodyHTML: `
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-g="enabled" style="width:auto" ${policy.enabled ? 'checked' : ''} />
        Only allow phone time-in at an office location
      </label>
      <p class="muted" style="font-size:12px;margin:4px 0 12px">Off: phones only need the office QR (as before).
        On: they also need to be inside one of these locations. Kiosk punches at the office PC are not affected.</p>
      <div id="geo-sites"></div>
      <button type="button" class="btn secondary small" id="geo-add" style="margin-top:6px">${UI.icon('plus', 14)} Add location</button>
      <div class="field-row" style="margin-top:14px">
        <div><label>Reject a location less precise than (± metres)</label>
          <input data-g="max_accuracy_m" type="number" min="10" max="1000" value="${Number(policy.max_accuracy_m) || 100}" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:4px 0 0"><b>Tip:</b> stand in the office and press
        "Use this device's location", or in Google Maps right-click the building, click the coordinates to copy
        them, and paste into Latitude. A radius of 100–200 m covers normal GPS drift indoors.
        This stops someone clocking in from home with a forwarded QR; it can't detect a phone that fakes its
        GPS, so every phone punch also keeps its location for review.</p>`,
    confirmText: 'Save',
    onOpen: (ov) => {
      const listEl = ov.querySelector('#geo-sites');
      const render = () => {
        listEl.innerHTML = sites.length ? sites.map((s, i) => `
          <div class="field-row" data-row="${i}" style="align-items:end;margin-bottom:8px">
            <div><label>Name</label><input data-s="name" value="${UI.esc(s.name || '')}" placeholder="Main office" /></div>
            <div><label>Latitude</label><input data-s="lat" value="${s.lat ?? ''}" placeholder="14.5995" /></div>
            <div><label>Longitude</label><input data-s="lng" value="${s.lng ?? ''}" placeholder="120.9842" /></div>
            <div style="max-width:110px"><label>Radius (m)</label><input data-s="radius_m" type="number" min="30" max="5000" value="${s.radius_m ?? 150}" /></div>
            <div style="display:flex;gap:6px;flex:0 0 auto">
              <button type="button" class="btn secondary small" data-here="${i}">Use this device's location</button>
              ${s.lat != null && s.lng != null ? `<a class="btn secondary small" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(s.lat + ',' + s.lng)}">Map</a>` : ''}
              <button type="button" class="btn secondary small" data-del="${i}">Remove</button>
            </div>
          </div>`).join('') : '<p class="muted" style="font-size:13px">No office locations yet.</p>';
        listEl.querySelectorAll('[data-row]').forEach((row) => {
          const i = Number(row.dataset.row);
          row.querySelectorAll('[data-s]').forEach((inp) => {
            inp.oninput = () => { sites[i][inp.dataset.s] = inp.value; };
          });
          // Pasting "14.5995, 120.9842" (Google Maps' copy format) into Latitude fills both fields.
          row.querySelector('[data-s="lat"]').onpaste = (e) => {
            const txt = (e.clipboardData || window.clipboardData).getData('text');
            const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(txt);
            if (!m) return;
            e.preventDefault();
            sites[i].lat = m[1]; sites[i].lng = m[2]; render();
          };
        });
        listEl.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = () => { sites.splice(Number(b.dataset.del), 1); render(); };
        });
        listEl.querySelectorAll('[data-here]').forEach((b) => {
          b.onclick = () => {
            if (!navigator.geolocation) { UI.toast('This device can’t share its location', 'error'); return; }
            b.disabled = true; b.textContent = 'Locating…';
            navigator.geolocation.getCurrentPosition((pos) => {
              const i = Number(b.dataset.here);
              sites[i].lat = pos.coords.latitude.toFixed(6);
              sites[i].lng = pos.coords.longitude.toFixed(6);
              UI.toast(`Location set (±${Math.round(pos.coords.accuracy)} m)`);
              render();
            }, () => {
              UI.toast('Could not get this device’s location — allow location access, or paste coordinates', 'error');
              render();
            }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
          };
        });
      };
      ov.querySelector('#geo-add').onclick = () => { sites.push({ name: sites.length ? '' : 'Main office', lat: '', lng: '', radius_m: 150 }); render(); };
      render();
    },
    onConfirm: async (ov, showErr) => {
      const clean = [];
      for (const s of sites) {
        const lat = Number(s.lat), lng = Number(s.lng), radius_m = Math.round(Number(s.radius_m));
        if (!String(s.name || '').trim()) { showErr('Give each location a name'); return false; }
        if (s.lat === '' || s.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          showErr(`Set the latitude and longitude for ${s.name}`); return false;
        }
        clean.push({ name: String(s.name).trim(), lat, lng, radius_m });
      }
      const enabled = ov.querySelector('[data-g="enabled"]').checked;
      if (enabled && !clean.length) { showErr('Add at least one office location before turning the lock on'); return false; }
      try {
        await API.put('/hr/clock/geofence', {
          enabled, sites: clean, max_accuracy_m: Math.round(Number(ov.querySelector('[data-g="max_accuracy_m"]').value) || 100),
        });
      } catch (e) { showErr(e.message || 'Could not save'); return false; }
      UI.toast(enabled ? 'Phone time-in locked to the office' : 'Office locations saved (lock is off)');
    },
  });
}

/* ── Punch Log (GET /hr/clock/punches) — raw punches with where each phone punch came from ─── */
function punchLogModal() {
  const today = new Date().toLocaleDateString('en-CA');
  const SOURCE = { phone: 'Phone (QR)', remote: 'Phone — outside office', kiosk: 'Kiosk' };
  UI.modal({
    title: 'Punch Log',
    size: 'lg',
    bodyHTML: `
      <div class="field-row" style="align-items:end">
        <div><label>From</label><input type="date" id="pl-from" value="${today}" /></div>
        <div><label>To</label><input type="date" id="pl-to" value="${today}" /></div>
        <div><label>Source</label><select id="pl-source">
          <option value="">All</option><option value="phone">Phone (QR)</option>
          <option value="remote">Phone — outside office</option><option value="kiosk">Kiosk</option></select></div>
        <div style="flex:0 0 auto"><button type="button" class="btn secondary small" id="pl-go">Show</button></div>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 10px">Phone punches keep the location the phone reported:
        the office it was within, or its distance from the nearest office. <b>Outside office</b> punches come from staff
        allowed to time in anywhere. A phone can fake its GPS, so look into anything that doesn't fit.
        <b>Device</b> flags a punch made on a borrowed phone, or on a phone another employee usually signs in on.</p>
      <div id="pl-list"><p class="muted">Loading…</p></div>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      const load = async () => {
        const q = new URLSearchParams({ from: ov.querySelector('#pl-from').value, to: ov.querySelector('#pl-to').value });
        const src = ov.querySelector('#pl-source').value;
        if (src) q.set('source', src);
        const list = ov.querySelector('#pl-list');
        try {
          const rows = await API.get('/hr/clock/punches?' + q.toString());
          const where = (r) => {
            if (r.lat == null) return r.source === 'kiosk' ? 'Office kiosk' : '<span class="muted">no location</span>';
            const map = `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(r.lat + ',' + r.lng)}">map</a>`;
            const place = r.geo_site ? UI.esc(r.geo_site)
              : r.distance_m != null ? `<b>${r.distance_m >= 1000 ? (r.distance_m / 1000).toFixed(1) + ' km' : Math.round(r.distance_m) + ' m'} from office</b>`
              : 'Location recorded';
            return `${place} · ±${Math.round(r.accuracy_m || 0)} m · ${map}`;
          };
          // src/modules/hr/clock.ts PunchDevice — recorded for review, never blocked.
          const device = (r) => r.device_flag === 'borrowed'
            ? `<span class="badge-pill low">Borrowed phone</span>${r.device_user_name ? ` <span class="muted">usually ${UI.esc(r.device_user_name)}</span>` : ''}`
            : r.device_flag === 'other_user'
              ? `<span class="badge-pill low">Another's phone</span>${r.device_user_name ? ` <span class="muted">usually ${UI.esc(r.device_user_name)}</span>` : ''}`
              : '';
          list.innerHTML = rows.length ? `
            <table class="line-table">
              <thead><tr><th>Time</th><th>Employee</th><th>In/Out</th><th>Source</th><th>Where</th><th>Device</th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td>${UI.esc((r.ts || '').slice(0, 16))}</td>
                <td>${UI.esc(r.name)}${r.employee_no ? ` <span class="muted">${UI.esc(r.employee_no)}</span>` : ''}</td>
                <td>${r.kind === 'in' ? 'IN' : 'OUT'}</td>
                <td>${UI.esc(SOURCE[r.source] || r.source)}</td>
                <td>${where(r)}</td>
                <td>${device(r)}</td>
              </tr>`).join('')}</tbody>
            </table>
            ${rows.length >= 1000 ? '<p class="muted" style="font-size:12px">Showing the latest 1000 — narrow the dates to see more.</p>' : ''}`
            : '<p class="muted">No punches in this range.</p>';
        } catch (e) { list.innerHTML = `<p class="form-error">${UI.esc(e.message || 'Could not load punches')}</p>`; }
      };
      ov.querySelector('#pl-go').onclick = load;
      load();
    },
  });
}

/* ── Approved kiosk devices (GET/POST/DELETE /hr/clock/kiosk-devices, PUT /hr/clock/kiosk-lock) ──
   See src/modules/hr/kiosk-devices.ts. A PC is approved from the kiosk screen itself (or here,
   for this PC); approval stores a token in that browser. */
async function kioskDevicesModal() {
  let info = await API.get('/hr/clock/kiosk-devices');
  const canManage = App.hasPermission('hr.manage');

  UI.modal({
    title: 'Kiosk Devices',
    size: 'lg',
    bodyHTML: `
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="kd-lock" style="width:auto" ${info.lock_active ? 'checked' : ''} ${canManage ? '' : 'disabled'} />
        Only approved PCs can run the Time-in Kiosk
      </label>
      <p class="muted" style="font-size:12px;margin:4px 0 12px" id="kd-lock-note"></p>
      <div id="kd-list"></div>
      ${canManage ? `<div style="display:flex;gap:8px;align-items:end;margin-top:12px">
        <div style="flex:1"><label>Approve this PC as a kiosk</label><input id="kd-name" placeholder="e.g. Front desk PC" maxlength="60" /></div>
        <button type="button" class="btn secondary small" id="kd-approve">Approve this PC</button>
      </div>` : ''}
      <p class="muted" style="font-size:12px;margin:10px 0 0">A PC is usually approved from the kiosk screen itself
        (HR → Time Keeping → Time-in Kiosk). Approval is stored in that browser — clearing its data, or using
        another browser, needs approving again. Revoke a PC that's replaced or lost.</p>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      const render = () => {
        ov.querySelector('#kd-lock-note').textContent = info.lock_setting === null
          ? `Following the default for this server (${info.lock_active ? 'on — it is reachable from the internet' : 'off — office network install'}).`
          : `Set by HR: ${info.lock_active ? 'on' : 'off'}.`;
        const list = ov.querySelector('#kd-list');
        list.innerHTML = info.devices.length ? `
          <table class="line-table">
            <thead><tr><th>Name</th><th>Approved by</th><th>Approved</th><th>Last used</th><th></th></tr></thead>
            <tbody>${info.devices.map((d) => `<tr>
              <td>${UI.esc(d.name)}${info.this_device && info.this_device.id === d.id ? ' <span class="muted">(this PC)</span>' : ''}</td>
              <td>${UI.esc(d.created_by_name || '—')}</td>
              <td>${UI.esc((d.created_at || '').slice(0, 10))}</td>
              <td>${UI.esc(d.last_seen_at ? d.last_seen_at.slice(0, 16) : 'never')}</td>
              <td>${canManage ? `<button type="button" class="btn secondary small" data-revoke="${d.id}">Revoke</button>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table>` : '<p class="muted" style="font-size:13px">No approved kiosk PCs yet.</p>';
        list.querySelectorAll('[data-revoke]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            try {
              await API.del('/hr/clock/kiosk-devices/' + b.dataset.revoke);
              if (info.this_device && String(info.this_device.id) === b.dataset.revoke) localStorage.removeItem('vds_kiosk_token');
              info = await API.get('/hr/clock/kiosk-devices');
              UI.toast('Kiosk PC revoked');
              render();
            } catch (e) { UI.toast(e.message || 'Could not revoke', 'error'); b.disabled = false; }
          };
        });
      };
      const lock = ov.querySelector('#kd-lock');
      lock.onchange = async () => {
        try {
          await API.put('/hr/clock/kiosk-lock', { enabled: lock.checked });
          info = await API.get('/hr/clock/kiosk-devices');
          UI.toast(lock.checked ? 'Kiosk locked to approved PCs' : 'Kiosk lock turned off');
          render();
        } catch (e) { UI.toast(e.message || 'Could not save', 'error'); lock.checked = !lock.checked; }
      };
      const approve = ov.querySelector('#kd-approve');
      if (approve) approve.onclick = async () => {
        approve.disabled = true;
        try {
          const r = await API.post('/hr/clock/kiosk-devices', { name: ov.querySelector('#kd-name').value.trim() });
          localStorage.setItem('vds_kiosk_token', r.token);
          info = await API.get('/hr/clock/kiosk-devices');
          UI.toast('This PC is now an approved kiosk');
          render();
        } catch (e) { UI.toast(e.message || 'Could not approve', 'error'); }
        approve.disabled = false;
      };
      render();
    },
  });
}

/* ── Shift create/edit modal ──────────────────────────────────────────────── */
function shiftModal(existing, onSaved) {
  const editing = !!existing;
  UI.modal({
    title: editing ? `Edit ${existing.name}` : 'New Shift',
    bodyHTML: `
      <div><label>Name *</label><input data-f="name" value="${UI.esc(editing ? existing.name : '')}" placeholder="e.g. Morning" autofocus /></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Start time *</label><input data-f="start_time" type="time" value="${UI.esc(editing ? existing.start_time : '')}" /></div>
        <div><label>End time *</label><input data-f="end_time" type="time" value="${UI.esc(editing ? existing.end_time : '')}" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">An end time earlier than the start time is treated as an overnight shift (e.g. 22:00 &rarr; 06:00).</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-f="is_default" style="width:auto" ${editing && existing.is_default ? 'checked' : ''} /> Default shift
      </label></div>`,
    confirmText: editing ? 'Save' : 'Create',
    onConfirm: async (ov, showErr) => {
      const name = ov.querySelector('[data-f="name"]').value.trim();
      const start_time = ov.querySelector('[data-f="start_time"]').value;
      const end_time = ov.querySelector('[data-f="end_time"]').value;
      const is_default = ov.querySelector('[data-f="is_default"]').checked;
      if (!name) { showErr('Shift name is required'); return false; }
      if (!start_time || !end_time) { showErr('Start and end time are required'); return false; }
      if (editing) await API.put('/hr/shifts/' + existing.id, { name, start_time, end_time, is_default });
      else await API.post('/hr/shifts', { name, start_time, end_time, is_default });
      UI.toast(editing ? 'Shift saved' : 'Shift created');
      if (onSaved) onSaved();
    },
  });
}

/* ── Policy Settings: shifts list (add/edit/delete/default) + company-wide payroll rules ──── */
async function policySettingsModal() {
  const [shiftsInit, policy] = await Promise.all([
    API.get('/hr/shifts').catch(e => { UI.toast('Couldn’t load shifts: '+e.message,'error'); return []; }),
    API.get('/hr/payroll-policy').catch(() => null),
  ]);
  let shifts = shiftsInit;

  UI.modal({
    title: 'Policy Settings',
    size: 'lg',
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <strong>Shifts</strong>
        <button type="button" class="btn secondary small" id="tk-shift-add">${UI.icon('plus', 14)} Add Shift</button>
      </div>
      <div id="tk-shifts-list"></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Each attendance day can be assigned one of these shifts —
        a rotating employee just gets a different shift on different days.</p>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Payroll Rules</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">Applies uniformly across every shift — grace period,
        rounding and OT/night-differential rules aren't set per shift.</p>
      <div class="field-row" style="margin-top:8px">
        <div><label>Grace period (minutes)</label><input data-p="grace_minutes" type="number" min="0" /></div>
        <div><label>Late deduction block</label>
          <select data-p="late_unit"><option value="minute">Per minute</option><option value="hour">Per hour</option></select></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Late within the grace period costs nothing; once past it,
        the whole lateness counts from the shift start — 6 minutes late with a 5-minute grace is 6 minutes late.</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>OT credit block</label>
          <select data-p="ot_unit"><option value="minute">Per minute</option><option value="30min">Per 30 minutes</option><option value="hour">Per hour</option></select></div>
        <div><label>OT rate (% of hourly)</label><input data-p="ot_rate_percent" type="number" min="0" /></div>
        <div><label>Monthly rate divisor</label><input data-p="monthly_rate_divisor" type="number" min="1" max="31" /></div>
        <div><label>Maximum OT (hours/day)</label><input data-p="max_ot_hours" type="number" min="0" max="24" step="0.5" placeholder="blank = no maximum" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">For employees paid a monthly rate, their effective
        daily rate used in payroll is monthly rate ÷ this number (e.g. 26 working days/month). Maximum OT caps how
        many OT hours are credited/paid per day — hours worked past it are simply unpaid presence, not converted
        into anything else. Leave blank for no cap.</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>OT grace (minutes)</label><input data-p="ot_grace_minutes" type="number" min="0" max="59" placeholder="0 = off" /></div>
        <div><label>OT counts after (minutes)</label><input data-p="ot_min_minutes" type="number" min="0" max="480" placeholder="0 = from the first block" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0"><strong>OT grace</strong>: a time-out this many minutes
        or less short of the next OT block counts as reaching it — per-hour blocks with 5 minutes: out at 5:56 pm on
        a 5:00 pm shift end is 1 hour of OT. <strong>OT counts after</strong>: no OT until this much is worked,
        then it counts in OT credit blocks — 60 with per-30-minute blocks: out at 6:30 pm is 1.5 hours, 5:30 pm is
        none. Leave both at 0 for plain blocks.</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-p="require_ot_form" style="width:auto" /> Require a linked Overtime Request form for OT to be paid
      </label></div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">On (default): a clock-out past the shift's end only pays
        OT when that day is linked to an approved Overtime Request. Off: any clock-out past the shift's end
        auto-pays OT — no form needed.</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-p="require_rest_day_form" style="width:auto" /> Require an approved Rest Day Work Request for the rest-day premium
      </label></div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Off (default): working a rest day pays the +30%
        automatically. On: the premium (and the rest-day OT rate) is paid only when that day is linked to an
        approved Rest Day Work Request; without one it pays as an ordinary working day. An approved Change of
        Rest Day moves the rest day itself, either way.</p>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Hours & Minimum Time</strong>
      <div class="field-row" style="margin-top:8px">
        <div><label>How a worked day is paid</label>
          <select data-p="hours_basis">
            <option value="fixed">Fixed — full/half day + late/OT/undertime margins (default)</option>
            <option value="per_hour">Per-hours-basis — prorated by actual hours worked</option>
          </select></div>
        <div><label>Per-hours-basis rounding block</label>
          <select data-p="hours_basis_unit"><option value="minute">Per minute</option><option value="30min">Per 30 minutes</option><option value="hour">Per hour</option></select></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0"><b>Fixed</b>: a day worked at all pays a flat full day
        (or half day, for a linked Half Day request), with late/OT/undertime as peso adjustments around the shift's
        set start/end — undertime (e.g. 8:00-3:00 on an 8-5 shift, 6hrs), offset (10:00-19:00 via an Offset form,
        8hrs) and half day (8-12 or 1-5, 4hrs) all work this way. <b>Per-hours-basis</b>: pay is computed directly
        from actual clock times instead — e.g. clocking 8:00-14:00 on an 8-5 shift pays exactly 5 hours (lunch
        excluded), not a flat full or half day; late arrival/leaving early no longer need a separate deduction,
        since paying only for hours present already accounts for it.</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>Lunch break (minutes)</label><input data-p="lunch_break_minutes" type="number" min="0" max="480" /></div>
        <div style="align-self:end"><label style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <input type="checkbox" data-p="count_lunch_as_worked" style="width:auto" /> Count lunch as paid time
        </label></div>
        <div><label>Minimum time for a day (minutes)</label><input data-p="min_work_minutes" type="number" min="0" max="1440" placeholder="0 = no minimum" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Lunch break is assumed to sit in the middle of each
        shift's span (e.g. an 8-5 shift with a 60-min lunch splits into 8-12 / lunch / 1-5) — used to derive a
        linked Half Day request's own AM/PM window, and (unless "count lunch as paid time" is on) subtracted from
        a per-hours-basis worked span. Minimum time flags any day under it for review in Time Keeping's daily grid
        (an Allow/Deny button appears there) — it never withholds pay by itself; a short day still pays for the
        actual hours worked unless HR explicitly denies it. Leave at 0 to never flag short days at all.</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-p="count_lunch_late_as_late" style="width:auto" /> Count a late lunch return as late
      </label></div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Off (default): lunch out/in times shown on the Daily
        Time grid are just a record — they never affect pay. On: returning from lunch later than the shift's own
        lunch window (or, for one specific day, later than an approved Lunch/Break Offset Request) adds the excess
        to that day's late deduction, same grace period and rounding as an ordinary late arrival. An employee who
        times out for lunch and never punches back in at all is always auto-credited a half day either way,
        regardless of this setting.</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>Whole-day minimum, Fixed mode only (minutes)</label>
          <input data-p="whole_day_min_minutes" type="number" min="0" max="1440" placeholder="0 = off (any presence is a whole day)" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0"><b>Fixed mode only.</b> Below this many net minutes
        present (lunch excluded), a day no longer counts as a full "Days Worked" credit — it becomes its own
        "Undertime Day" instead (shown separately on the payslip), paid proportionally for the actual hours
        present rather than the flat daily rate. Doesn't apply to a linked Half Day request (always its own fixed
        half day) or an Undertime Request filed with pay (always a full paid day). Suggested: 420 (7 hours) for an
        8-hour shift — up to an hour late still reads as a whole day. Leave at 0 to keep the old behavior: any
        presence at all is a flat whole day.</p>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Holiday Pay Rules</strong>
      <div class="field-row" style="margin-top:8px">
        <div><label>Special Non-Working Holiday premium</label>
          <select data-p="special_holiday_premium_mode">
            <option value="flat">Flat 30% regardless of hours worked (default)</option>
            <option value="prorated">Prorated by actual hours present, capped at 8 hours' worth</option>
          </select></div>
        <div><label>Require attendance next to a holiday</label>
          <select data-p="holiday_adjacency_requirement">
            <option value="none">No requirement (default)</option>
            <option value="before">Present the day before</option>
            <option value="after">Present the day after</option>
            <option value="both">Present both the day before and after</option>
          </select></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0"><b>Special Holiday premium</b>: Regular Holiday's pay is
        always the full statutory rate regardless of hours worked either way — this only changes Special
        Non-Working Holiday's 30% (or 50%, on a rest day). Flat: a half-day worked still earns the same premium as
        a full day. Prorated: a half-day earns roughly half. <b>Attendance requirement</b>: some companies withhold
        a Regular or Special Non-Working Holiday's pay/premium entirely if the employee was unexcused-absent on the
        required adjacent day — being present, on approved paid leave, or that day simply not being a scheduled
        workday for them (a rest day, or itself another holiday) all satisfy it; only a genuine unexcused absence
        disqualifies.</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>Pay frequency</label>
          <select data-p="pay_frequency">
            <option value="monthly">Monthly</option>
            <option value="semi_monthly">Semi-monthly (twice a month)</option>
            <option value="weekly">Weekly</option>
            <option value="daily">Daily</option>
          </select></div>
        <div style="align-self:end"><label style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <input type="checkbox" data-p="auto_statutory" style="width:auto" /> Auto-compute SSS / PhilHealth / Pag-IBIG / withholding tax
        </label></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">When on, "Generate Payslips" fills the statutory deduction
        and withholding-tax lines from the current rate tables (the monthly contribution is split across the cutoffs
        per the pay frequency). Turn off to keep entering those by hand.</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-p="night_diff_enabled" style="width:auto" /> Enable night differential
      </label></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Night diff (%)</label><input data-p="night_diff_percent" type="number" min="0" /></div>
        <div><label>Night start</label><input data-p="night_start" type="time" /></div>
        <div><label>Night end</label><input data-p="night_end" type="time" /></div>
      </div>
      <div style="margin-top:14px">
        <label>Company-wide rest days</label>
        <div id="tk-rest-days" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `
            <label style="display:flex;align-items:center;gap:4px;font-weight:normal">
              <input type="checkbox" data-rd="${i}" style="width:auto" />${n}</label>`).join('')}
        </div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">Worked automatically pays +30% (more if it also lands
          on a holiday) — nothing else to fill in on the daily grid. A specific employee can be given their own rest
          days instead, overriding this, on their Employee record.</p>
      </div>
      <div style="margin-top:14px">
        <label>Statutory deduction schedule</label>
        <p class="muted" style="font-size:12px;margin:2px 0 6px">Which cutoff(s) take each deduction. SSS and
          Pag-IBIG follow the law's monthly basis — what the employee actually earned in the cutoffs ending that
          month: an earlier cutoff takes the share of what's been earned so far, and the month's last checked cutoff
          takes the rest. Check them on the <strong>last cutoff of the month</strong> for the exact legal amount; a
          month whose only checked cutoff is an earlier one uses the employee's full-month rate instead, because the
          month's pay isn't known yet. PhilHealth is on the fixed monthly basic rate (absences don't lower it), split
          across its checked cutoffs.</p>
        <div id="tk-ded-schedule"></div>
      </div>
      <button type="button" class="btn" id="tk-policy-save" style="margin-top:14px">${UI.icon('sheet', 14)} Save Rules</button>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Statutory Rate Tables</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">The SSS / PhilHealth / Pag-IBIG / BIR-withholding
        figures the payslip computation uses. The 2026 schedule is built in; add a new dated version each January
        if the government changes the rates.</p>
      <button type="button" class="btn secondary small" id="tk-rate-tables" style="margin-top:8px">${UI.icon('sheet', 14)} Open rate tables</button>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Phone Time-in Location</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">Only accept phone time-in at the office: the phone's GPS
        must be within the radius of an office location, on top of scanning the office QR. Staff marked "Can time in
        outside the office" on their Employee record are exempt.</p>
      <button type="button" class="btn secondary small" id="tk-geofence" style="margin-top:8px">${UI.icon('sheet', 14)} Set office locations</button>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Kiosk Devices</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">Which office PCs may run the Time-in Kiosk (its QR code
        and typing an employee number). On an internet-facing server only approved PCs can.</p>
      <button type="button" class="btn secondary small" id="tk-kiosks" style="margin-top:8px">${UI.icon('sheet', 14)} Kiosk devices</button>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      const p = (k) => ov.querySelector(`[data-p="${k}"]`);
      // Shifts, office locations and kiosks are timekeeping (hr.manage); the payroll rules and
      // statutory rate tables are pay (payroll.manage / payroll.view — payroll/pay-access.ts).
      const rateTablesBtn = ov.querySelector('#tk-rate-tables');
      if (App.hasPermission('payroll.view')) rateTablesBtn.onclick = () => rateTablesModal();
      else rateTablesBtn.hidden = true;
      if (!App.hasPermission('payroll.manage')) {
        const save = ov.querySelector('#tk-policy-save');
        save.disabled = true;
        save.title = 'Saving payroll rules needs the Run payroll permission';
      }
      ov.querySelector('#tk-geofence').onclick = () => geofenceModal();
      ov.querySelector('#tk-kiosks').onclick = () => kioskDevicesModal();
      if (policy) {
        p('grace_minutes').value = policy.grace_minutes;
        p('late_unit').value = policy.late_unit;
        p('ot_unit').value = policy.ot_unit;
        p('ot_grace_minutes').value = policy.ot_grace_minutes ?? 0;
        p('ot_min_minutes').value = policy.ot_min_minutes ?? 0;
        p('ot_rate_percent').value = policy.ot_rate_percent;
        p('require_ot_form').checked = policy.require_ot_form !== false;
        p('require_rest_day_form').checked = !!policy.require_rest_day_form;
        p('monthly_rate_divisor').value = policy.monthly_rate_divisor;
        p('pay_frequency').value = policy.pay_frequency || 'semi_monthly';
        p('auto_statutory').checked = policy.auto_statutory !== false;
        p('night_diff_enabled').checked = policy.night_diff_enabled;
        p('night_diff_percent').value = policy.night_diff_percent;
        p('night_start').value = policy.night_start;
        p('night_end').value = policy.night_end;
        p('hours_basis').value = policy.hours_basis || 'fixed';
        p('hours_basis_unit').value = policy.hours_basis_unit || '30min';
        p('lunch_break_minutes').value = policy.lunch_break_minutes ?? 60;
        p('count_lunch_as_worked').checked = !!policy.count_lunch_as_worked;
        p('count_lunch_late_as_late').checked = !!policy.count_lunch_late_as_late;
        p('min_work_minutes').value = policy.min_work_minutes ?? 0;
        p('whole_day_min_minutes').value = policy.whole_day_min_minutes ?? 0;
        p('max_ot_hours').value = policy.max_ot_hours ?? '';
        p('special_holiday_premium_mode').value = policy.special_holiday_premium_mode || 'flat';
        p('holiday_adjacency_requirement').value = policy.holiday_adjacency_requirement || 'none';
        (policy.default_rest_days || [0, 6]).forEach((d) => {
          const cb = ov.querySelector(`[data-rd="${d}"]`);
          if (cb) cb.checked = true;
        });
      }

      const PERIODS_PER_MONTH_CLIENT = { monthly: 1, semi_monthly: 2, weekly: 4, daily: 22 };
      const SLOT_LABELS = ['1st cutoff', '2nd cutoff', '3rd cutoff', '4th cutoff'];
      const DED_KEYS = [['sss', 'SSS'], ['philhealth', 'PhilHealth'], ['pagibig', 'Pag-IBIG'], ['withholding_tax', 'Withholding tax']];
      function renderDeductionSchedule() {
        const el = ov.querySelector('#tk-ded-schedule');
        const freq = p('pay_frequency').value;
        const n = PERIODS_PER_MONTH_CLIENT[freq] || 2;
        if (freq === 'daily') {
          el.innerHTML = '<p class="muted" style="font-size:12.5px">Not available for daily pay frequency — 22+ cutoffs a month makes a fixed schedule impractical.</p>';
          return;
        }
        const saved = policy && Array.isArray(policy.deduction_schedule) && policy.deduction_schedule.length === n
          ? policy.deduction_schedule : null;
        el.innerHTML = `<table class="line-table"><thead><tr><th></th>${DED_KEYS.map(([, label]) => `<th>${UI.esc(label)}</th>`).join('')}</tr></thead>
          <tbody>${Array.from({ length: n }, (_, slot) => `
            <tr><td>${SLOT_LABELS[slot] || `Cutoff ${slot + 1}`}</td>
              ${DED_KEYS.map(([key]) => `<td><input type="checkbox" data-ded="${slot}:${key}" style="width:auto" ${!saved || saved[slot][key] ? 'checked' : ''} /></td>`).join('')}
            </tr>`).join('')}</tbody></table>`;
      }
      renderDeductionSchedule();
      p('pay_frequency').addEventListener('change', renderDeductionSchedule);

      function renderShifts() {
        const listEl = ov.querySelector('#tk-shifts-list');
        if (!shifts.length) {
          listEl.innerHTML = '<p class="muted" style="font-size:13px">No shifts defined yet.</p>';
          return;
        }
        listEl.innerHTML = `<table class="line-table"><thead><tr>
            <th>Name</th><th>Start</th><th>End</th><th>Default</th><th></th>
          </tr></thead><tbody>${shifts.map((s) => `
            <tr>
              <td>${UI.esc(s.name)}</td><td>${UI.esc(s.start_time)}</td><td>${UI.esc(s.end_time)}</td>
              <td>${s.is_default ? '✓' : ''}</td>
              <td class="actions">
                <button type="button" class="icon-btn" data-shift-edit="${s.id}" title="Edit">${UI.icon('edit')}</button>
                <button type="button" class="icon-btn danger" data-shift-del="${s.id}" title="Delete">${UI.icon('trash')}</button>
              </td>
            </tr>`).join('')}</tbody></table>`;
        listEl.querySelectorAll('[data-shift-edit]').forEach((b) => b.onclick = () => {
          const s = shifts.find((x) => String(x.id) === b.dataset.shiftEdit);
          shiftModal(s, refreshShifts);
        });
        listEl.querySelectorAll('[data-shift-del]').forEach((b) => b.onclick = async () => {
          if (!await UI.confirmDialog('Delete this shift? Any attendance days using it just become unassigned.', 'Delete')) return;
          await API.del('/hr/shifts/' + b.dataset.shiftDel);
          UI.toast('Shift deleted');
          refreshShifts();
        });
      }
      async function refreshShifts() {
        shifts = await API.get('/hr/shifts').catch(e => { UI.toast('Couldn’t load shifts: '+e.message,'error'); return []; });
        renderShifts();
      }
      renderShifts();

      ov.querySelector('#tk-shift-add').onclick = () => shiftModal(null, refreshShifts);
      ov.querySelector('#tk-policy-save').onclick = async () => {
        const body = {
          grace_minutes: Number(p('grace_minutes').value) || 0,
          late_unit: p('late_unit').value,
          ot_unit: p('ot_unit').value,
          ot_grace_minutes: Number(p('ot_grace_minutes').value) || 0,
          ot_min_minutes: Number(p('ot_min_minutes').value) || 0,
          ot_rate_percent: Number(p('ot_rate_percent').value) || 0,
          require_ot_form: p('require_ot_form').checked,
          require_rest_day_form: p('require_rest_day_form').checked,
          monthly_rate_divisor: Number(p('monthly_rate_divisor').value) || 26,
          max_ot_hours: p('max_ot_hours').value === '' ? null : Number(p('max_ot_hours').value),
          pay_frequency: p('pay_frequency').value,
          auto_statutory: p('auto_statutory').checked,
          night_diff_enabled: p('night_diff_enabled').checked,
          night_diff_percent: Number(p('night_diff_percent').value) || 0,
          night_start: p('night_start').value,
          night_end: p('night_end').value,
          hours_basis: p('hours_basis').value,
          hours_basis_unit: p('hours_basis_unit').value,
          lunch_break_minutes: Number(p('lunch_break_minutes').value) || 0,
          count_lunch_as_worked: p('count_lunch_as_worked').checked,
          count_lunch_late_as_late: p('count_lunch_late_as_late').checked,
          min_work_minutes: Number(p('min_work_minutes').value) || 0,
          whole_day_min_minutes: Number(p('whole_day_min_minutes').value) || 0,
          special_holiday_premium_mode: p('special_holiday_premium_mode').value,
          holiday_adjacency_requirement: p('holiday_adjacency_requirement').value,
          default_rest_days: [...ov.querySelectorAll('[data-rd]:checked')].map((cb) => Number(cb.dataset.rd)),
        };
        const dedCells = [...ov.querySelectorAll('[data-ded]')];
        if (dedCells.length) {
          const n = PERIODS_PER_MONTH_CLIENT[body.pay_frequency] || 2;
          const schedule = Array.from({ length: n }, () => ({ sss: false, philhealth: false, pagibig: false, withholding_tax: false }));
          dedCells.forEach((cb) => {
            const [slot, key] = cb.dataset.ded.split(':');
            if (schedule[Number(slot)]) schedule[Number(slot)][key] = cb.checked;
          });
          body.deduction_schedule = schedule;
        }
        await API.put('/hr/payroll-policy', body);
        UI.toast('Payroll rules saved');
      };
    },
  });
}

/* ── 13th-month pay worksheet ────────────────────────────────────────────── */
async function thirteenthMonthModal() {
  const thisYear = new Date().getFullYear();
  const m = UI.modal({
    title: '13th-Month Pay',
    size: 'lg',
    cancelText: 'Close',
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="tm-year">${[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="tm-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Mandatory 13th-month pay = total <b>basic salary</b>
        actually earned in the calendar year ÷ 12. Computed from the payslips generated for that year
        (dated by pay date). Deductions and allowances don't affect it.</p>
      <div id="tm-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#tm-year');
      let last = { rows: [], total: 0, year: '' };
      async function load() {
        ov.querySelector('#tm-body').innerHTML = '<div class="empty">Loading…</div>';
        try { last = await API.get('/hr/thirteenth-month?year=' + yearSel.value); } catch(e) { last={rows:[],total:0,year:yearSel.value}; hrWorkflowLoadError(ov.querySelector('#tm-body'),e,load); return; }
        const b = ov.querySelector('#tm-body');
        if (!last.rows.length) { b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return; }
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>Employee</th><th class="right">Payslips</th><th class="right">Total basic salary</th><th class="right">13th-month</th>
          </tr></thead><tbody>${last.rows.map((r) => `
            <tr><td>${UI.esc(r.employee_name)}</td>
              <td class="right">${r.payslip_count}</td>
              <td class="right">${UI.money ? UI.money(r.basic_total) : r.basic_total.toFixed(2)}</td>
              <td class="right"><strong>${UI.money ? UI.money(r.amount) : r.amount.toFixed(2)}</strong></td></tr>`).join('')}
          </tbody><tfoot><tr><th colspan="3" class="right">Total</th>
            <th class="right">${UI.money ? UI.money(last.total) : last.total.toFixed(2)}</th></tr></tfoot></table>`;
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#tm-csv').onclick = () => {
        if (!last.rows.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`13th-month-${last.year}.csv`,
          ['Employee', 'Payslips', 'Total basic salary', '13th-month pay'],
          last.rows.map((r) => [r.employee_name, r.payslip_count, r.basic_total, r.amount]));
      };
      load();
    },
  });
  return m;
}


/* ── Payroll worksheets menu ────────────────────────────────────────────── */
// BIR returns, Alphalist and the agency contribution schedules moved to
// Accounting → Tax & Compliance (they're the finance team's to file). What
// stays here is payroll processing: 13th-month and the final-pay worksheet.
/* ── Item 2: Holidays / paid & unpaid work cancellations (No Work Memo) ─────────────────
   A company-wide declaration for a date range — a holiday, a typhoon suspension, equipment
   failure, whatever — paid or unpaid, applies to every employee automatically the next time
   payslips are generated (src/hr-payroll-compute.ts), no per-employee linking needed. The
   underlying "No Work Memo" Data Form always existed for this; this is just a direct way to
   manage it from Time Keeping instead of via Form Builder / Data Forms. */
async function noWorkMemoModal() {
  const canWrite = App.hasPermission('forms.manage.hr');
  let formId = null;
  try {
    const forms = await API.get('/form-definitions');
    const f = forms.find((x) => x.slug === 'no_work_memo');
    formId = f ? f.id : null;
  } catch(e) { UI.toast('Couldn’t load HR forms: '+e.message,'error'); return; }
  if (!formId) { UI.toast('No Work Memo form not found — ask an admin to check Form Builder (HR).', 'error'); return; }

  async function load() {
    return API.get('/hr/calendar/no_work_memo');
  }

  const m = UI.modal({
    title: 'No Work / Suspension',
    size: 'lg',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `<p class="muted" style="margin-top:0">Declares a date range where no work happened company-wide — a
        typhoon suspension, equipment failure, whatever the reason (for an actual public holiday, use the
        <strong>Holidays</strong> button instead — it pays the correct DOLE Regular/Special premium rather than a
        flat paid/unpaid day). Applies to every employee automatically the next time payslips are generated for a
        cutoff covering these dates; paid credits a full day, unpaid is the same as an absence but documented. No
        per-employee linking needed.</p>
      <div style="display:flex;margin-bottom:8px"><div class="grow"></div>
        ${canWrite ? `<button type="button" class="btn secondary small" id="nw-new">${UI.icon('plus')} New</button>` : ''}</div>
      <div id="nw-list"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const list = ov.querySelector('#nw-list');
      async function refresh() {
        let records; try { records = await load(); } catch(e) { hrWorkflowLoadError(list,e,refresh); return; }
        if (!records.length) {
          list.innerHTML = UI.emptyState({ icon: 'alert', title: 'No holidays or no-work declarations yet', hint: 'Add one for an upcoming holiday or suspension.' });
          return;
        }
        list.innerHTML = `<table><thead><tr><th>Number</th><th>From</th><th>To</th><th>Reason</th><th>Paid?</th><th></th></tr></thead>
          <tbody>${records.map((r) => `
            <tr>
              <td class="mono muted">${UI.esc(r.number)}</td>
              <td>${UI.esc(r.data.date_from || '')}</td>
              <td>${UI.esc(r.data.date_to || '')}</td>
              <td>${UI.esc(r.data.reason || '')}</td>
              <td><span class="badge-pill ${r.data.paid === 'Yes' ? 'status-completed' : 'status-cancelled'}">${UI.esc(r.data.paid || 'No')}</span></td>
              <td class="actions">${canWrite ? `<button class="icon-btn danger" data-del="${r.id}" title="Delete">${UI.icon('trash')}</button>` : ''}</td>
            </tr>`).join('')}</tbody></table>`;
        list.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
          if (!await UI.confirmDialog('Delete this declaration?', 'Delete')) return;
          try { await API.del('/form-records/' + b.dataset.del); refresh(); }
          catch (e) { UI.toast(e.message, 'error'); }
        });
      }
      const create=ov.querySelector('#nw-new'); if(create) create.onclick = () => newModal(refresh);
      refresh();
    },
  });

  function newModal(after) {
    UI.modal({
      title: 'New holiday / no-work declaration',
      bodyHTML: `
        <div class="field-row">
          <div><label>Date from <span class="req">*</span></label><input data-f="date_from" type="date" /></div>
          <div><label>Date to <span class="req">*</span></label><input data-f="date_to" type="date" /></div>
        </div>
        <label>Reason <span class="req">*</span></label><textarea data-f="reason" placeholder="e.g. Regular Holiday — National Heroes Day"></textarea>
        <label>Paid?</label>
        <select data-f="paid"><option value="Yes">Yes — credit a full paid day for everyone</option><option value="No">No — unpaid, same as an absence but documented</option></select>`,
      confirmText: 'Save',
      onConfirm: async (ov2, showErr) => {
        const g = (k) => ov2.querySelector(`[data-f="${k}"]`).value.trim();
        const data = { date_from: g('date_from'), date_to: g('date_to'), reason: g('reason'), paid: g('paid') };
        if (!data.date_from || !data.date_to) { showErr('Both dates are required'); return false; }
        if (data.date_to < data.date_from) { showErr('"Date to" is before "date from"'); return false; }
        if (!data.reason) { showErr('Reason is required'); return false; }
        await API.post('/form-records', { form_def_id: formId, data, status: 'approved' });
        UI.toast('Saved');
        after();
      },
    });
  }
}

/* ── Company Holidays calendar (PH regular / special non-working / special working) ────────
   Same list/create/delete shape as noWorkMemoModal above, against the 'company_holiday' form
   instead — kept as its own function rather than a shared generic helper since the two forms'
   fields (date range + paid vs a single date + type) don't actually overlap much. Seeded with
   reference dates in src/db.ts; admin edits/adds/deletes freely here. */
async function companyHolidaysModal() {
  const canWrite = App.hasPermission('forms.manage.hr');
  let formId = null;
  try {
    const forms = await API.get('/form-definitions');
    const f = forms.find((x) => x.slug === 'company_holiday');
    formId = f ? f.id : null;
  } catch(e) { UI.toast('Couldn’t load HR forms: '+e.message,'error'); return; }
  if (!formId) { UI.toast('Company Holidays form not found — ask an admin to check Form Builder (HR).', 'error'); return; }

  const TYPE_BADGE = {
    'Regular Holiday': 'status-completed',
    'Special Non-Working Holiday': 'status-confirmed',
    'Special Working Holiday': '',
  };

  async function load() {
    const records = await API.get('/hr/calendar/company_holiday');
    return records.slice().sort((a, b) => String(a.data.date || '').localeCompare(String(b.data.date || '')));
  }

  UI.modal({
    title: 'Company Holidays',
    size: 'lg',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `<p class="muted" style="margin-top:0">Applies to every employee automatically — a Regular Holiday pays
        200% if worked (100% even if not); a Special Non-Working Holiday pays 130% if worked ("no work, no pay" if
        not). A specific employee's Daily Time record can override any date here for that one person (Daily Time —
        Day Type column).</p>
      <div style="display:flex;margin-bottom:8px"><div class="grow"></div>
        ${canWrite ? `<button type="button" class="btn secondary small" id="ch-new">${UI.icon('plus')} New</button>` : ''}</div>
      <div id="ch-list"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const list = ov.querySelector('#ch-list');
      async function refresh() {
        let records; try { records = await load(); } catch(e) { hrWorkflowLoadError(list,e,refresh); return; }
        if (!records.length) {
          list.innerHTML = UI.emptyState({ icon: 'calendar', title: 'No holidays yet', hint: 'Add a date and its DOLE-declared type.' });
          return;
        }
        list.innerHTML = `<table><thead><tr><th>Date</th><th>Name</th><th>Type</th><th></th></tr></thead>
          <tbody>${records.map((r) => `
            <tr>
              <td class="mono">${UI.esc(r.data.date || '')}</td>
              <td>${UI.esc(r.data.name || '')}</td>
              <td><span class="badge-pill ${TYPE_BADGE[r.data.type] || ''}">${UI.esc(r.data.type || '')}</span></td>
              <td class="actions">${canWrite ? `<button class="icon-btn danger" data-del="${r.id}" title="Delete">${UI.icon('trash')}</button>` : ''}</td>
            </tr>`).join('')}</tbody></table>`;
        list.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
          if (!await UI.confirmDialog('Delete this holiday?', 'Delete')) return;
          try { await API.del('/form-records/' + b.dataset.del); refresh(); }
          catch (e) { UI.toast(e.message, 'error'); }
        });
      }
      const create=ov.querySelector('#ch-new'); if(create) create.onclick = () => newModal(refresh);
      refresh();
    },
  });

  function newModal(after) {
    UI.modal({
      title: 'New holiday',
      bodyHTML: `
        <div class="field-row">
          <div><label>Date <span class="req">*</span></label><input data-f="date" type="date" /></div>
          <div><label>Name <span class="req">*</span></label><input data-f="name" placeholder="e.g. National Heroes Day" /></div>
        </div>
        <label>Type <span class="req">*</span></label>
        <select data-f="type">
          <option value="Regular Holiday">Regular Holiday — 200% worked, 100% unworked</option>
          <option value="Special Non-Working Holiday">Special Non-Working Holiday — 130% worked, unpaid if not</option>
          <option value="Special Working Holiday">Special Working Holiday — ordinary day, no premium</option>
        </select>`,
      confirmText: 'Save',
      onConfirm: async (ov2, showErr) => {
        const g = (k) => ov2.querySelector(`[data-f="${k}"]`).value.trim();
        const data = { date: g('date'), name: g('name'), type: g('type') };
        if (!data.date) { showErr('Date is required'); return false; }
        if (!data.name) { showErr('Name is required'); return false; }
        await API.post('/form-records', { form_def_id: formId, data, status: 'approved' });
        UI.toast('Saved');
        after();
      },
    });
  }
}

function govFormsModal() {
  const items = [
    ['13th-month pay', 'Per-employee 13th-month computation', thirteenthMonthModal],
    ['Final pay worksheet', 'Back-pay for a separated employee (unpaid salary, pro-rated 13th, tax true-up)', finalPayModal],
  ];
  const m = UI.modal({
    title: 'Payroll worksheets',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `<div class="gov-menu">${items.map((it, i) => `
      <button type="button" class="gov-menu-item" data-i="${i}">
        <strong>${UI.esc(it[0])}</strong><span>${UI.esc(it[1])}</span>
      </button>`).join('')}</div>
      <style>.gov-menu{display:flex;flex-direction:column;gap:6px}
        .gov-menu-item{text-align:left;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer}
        .gov-menu-item:hover{border-color:var(--accent);background:var(--accent-weak)}
        .gov-menu-item strong{display:block;font-size:13px}
        .gov-menu-item span{display:block;font-size:11px;color:var(--text-muted);margin-top:2px}</style>`,
  });
  m.overlay.querySelectorAll('.gov-menu-item').forEach((b) => b.onclick = () => {
    if (m.close) m.close();
    items[Number(b.dataset.i)][2]();
  });
}


/* ── Final-pay / back-pay worksheet ──────────────────────────────────────── */
async function finalPayModal() {
  const peso = (n) => (UI.money ? UI.money(n) : Number(n || 0).toFixed(2));
  let employees = [];
  try { employees = await API.get('/hr/employees'); } catch { /* leave empty */ }
  const separated = employees.filter((e) => e.status === 'resigned' || e.status === 'terminated');
  const pool = separated.length ? separated : employees;

  UI.modal({
    title: 'Final-pay / back-pay worksheet',
    size: 'lg',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `
      <div class="field-row">
        <div style="flex:1"><label>Employee</label>
          <select id="fp-emp"><option value="">— pick —</option>
            ${pool.map((e) => `<option value="${e.id}">${UI.esc(e.name)}${e.status && e.status !== 'regular' && e.status !== 'probationary' ? ' · ' + UI.esc(e.status) : ''}</option>`).join('')}</select></div>
        <div><label>Separation date</label><input id="fp-sep" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      </div>
      <div class="field-row">
        <div><label>Unpaid days worked</label><input id="fp-days" type="number" min="0" step="0.5" value="0" /></div>
        <div><label>Unused leave (days)</label><input id="fp-leave" type="number" min="0" step="0.5" value="0" />
          <div class="muted" id="fp-leave-hint" style="font-size:11px;margin-top:2px">pick an employee to prefill from their leave balance</div></div>
        <div><label>Other earnings</label><input id="fp-other" type="number" min="0" step="0.01" value="0" /></div>
      </div>
      <div class="field-row">
        <div><label>Outstanding advance / loan</label><input id="fp-adv" type="number" min="0" step="0.01" placeholder="from payslips" /></div>
        <div><label>Other deductions</label><input id="fp-ded" type="number" min="0" step="0.01" value="0" /></div>
        <div><label>13th-month already paid</label><input id="fp-13th" type="number" min="0" step="0.01" value="0" /></div>
      </div>
      <button type="button" class="btn" id="fp-run" style="margin-top:8px">Compute worksheet</button>
      <div id="fp-out" style="margin-top:14px"></div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#fp-out');
      ov.querySelector('#fp-emp').onchange = () => {
        const emp = pool.find((e) => String(e.id) === ov.querySelector('#fp-emp').value);
        const hint = ov.querySelector('#fp-leave-hint');
        if (emp && emp.leave_days_remaining != null) {
          ov.querySelector('#fp-leave').value = emp.leave_days_remaining;
          hint.textContent = `from ${emp.name}'s leave balance — still editable`;
        } else {
          hint.textContent = emp ? 'no leave balance on record for this employee' : 'pick an employee to prefill from their leave balance';
        }
      };
      ov.querySelector('#fp-run').onclick = async () => {
        const id = ov.querySelector('#fp-emp').value;
        if (!id) { UI.toast('Pick an employee', 'error'); return; }
        const q = new URLSearchParams({
          separation_date: ov.querySelector('#fp-sep').value,
          unpaid_days: ov.querySelector('#fp-days').value || 0,
          unused_leave_days: ov.querySelector('#fp-leave').value || 0,
          other_earnings: ov.querySelector('#fp-other').value || 0,
          other_deductions: ov.querySelector('#fp-ded').value || 0,
          thirteenth_month_paid: ov.querySelector('#fp-13th').value || 0,
        });
        const adv = ov.querySelector('#fp-adv').value;
        if (adv !== '') q.set('outstanding_advance', adv);
        out.innerHTML = '<div class="empty">Computing…</div>';
        let r;
        try { r = await API.get('/hr/final-pay/' + id + '?' + q.toString()); }
        catch (e) { out.innerHTML = `<div class="m-error">${UI.esc(e.message)}</div>`; return; }
        const w = r.worksheet;
        const e2 = w.earnings, d2 = w.deductions, t2 = w.tax_annualisation;
        out.innerHTML = `
          <h4 style="margin:0 0 6px">${UI.esc(r.employee.name)} — final pay as of ${UI.esc(w.separation_date)}</h4>
          <table class="line-table"><tbody>
            <tr><td>Unpaid salary</td><td class="right">${peso(e2.unpaid_salary)}</td></tr>
            <tr><td>Pro-rated 13th-month pay</td><td class="right">${peso(e2.prorated_13th_month)}</td></tr>
            <tr><td>Unused leave conversion</td><td class="right">${peso(e2.leave_conversion)}</td></tr>
            <tr><td>Other earnings</td><td class="right">${peso(e2.other_earnings)}</td></tr>
            <tr><th>Gross final pay</th><th class="right">${peso(e2.gross)}</th></tr>
            <tr><td colspan="2" style="padding-top:8px"><b>Year-end tax annualisation</b></td></tr>
            <tr><td>Taxable income (YTD)</td><td class="right">${peso(t2.taxable_income)}</td></tr>
            <tr><td>Annual tax due</td><td class="right">${peso(t2.annual_tax_due)}</td></tr>
            <tr><td>Tax already withheld</td><td class="right">${peso(t2.tax_already_withheld)}</td></tr>
            <tr><td>Adjustment ${t2.adjustment >= 0 ? '(collect)' : '(refund)'}</td><td class="right">${peso(Math.abs(t2.adjustment))}</td></tr>
            <tr><td colspan="2" style="padding-top:8px"><b>Less deductions</b></td></tr>
            <tr><td>Outstanding advance / loan</td><td class="right">${peso(d2.outstanding_advance)}</td></tr>
            <tr><td>Other deductions</td><td class="right">${peso(d2.other_deductions)}</td></tr>
            <tr><td>Tax still due</td><td class="right">${peso(d2.tax_still_due)}</td></tr>
            <tr><td>Add: tax refund</td><td class="right">${peso(w.additions.tax_refund)}</td></tr>
            <tr><th>Net final pay</th><th class="right">${peso(w.net_final_pay)}</th></tr>
          </tbody></table>
          ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:10px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}
          <p class="muted" style="font-size:11px;margin-top:10px">Worksheet only — review against the 201 file and company policy before releasing. Final pay is due within 30 days of separation (DOLE LA 06-20).</p>`;
      };
    },
  });
}



/* ── Statutory rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding) ──── */
const RATE_KIND_LABEL = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', rwt: 'BIR withholding tax' };

async function rateTablesModal() {
  const canWrite=App.hasPermission('payroll.manage');
  async function load() {
    return API.get('/hr/payroll-tables');
  }
  let state; try { state=await load(); } catch(e) { UI.modal({title:'Couldn’t load statutory rate tables',bodyHTML:`<p>${UI.esc(e.message)}</p>`,cancelText:'Close',confirmText:'Retry',protectChanges:false,onConfirm:()=>{rateTablesModal();}});return; }

  const m = UI.modal({
    title: 'Statutory rate tables',
    size: 'lg',
    cancelText: 'Close',
    bodyHTML: `
      <p class="muted" style="margin-top:0">These feed the payslip computation. Each table is stored with an
        <b>effective date</b> — payroll uses the newest one on or before the pay date. To apply a new government
        schedule, paste the updated figures and save with next year's <code>YYYY-01-01</code> date. Never edit a
        past year in place. Cross-check the first run against the agency's own calculator.</p>
      <div id="rt-body"></div>`,
    onOpen: (ov) => render(ov),
  });

  function render(ov) {
    const box = ov.querySelector('#rt-body');
    box.innerHTML = ['sss', 'philhealth', 'pagibig', 'rwt'].map((kind) => {
      const versions = state.rows.filter((r) => r.kind === kind);
      const eff = state.effective[kind];
      return `
        <div class="panel" style="padding:12px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <strong>${RATE_KIND_LABEL[kind]}</strong>
            <span class="muted" style="font-size:12px">in force as of ${UI.esc(state.as_of || 'today')}</span>
          </div>
          <div style="font-size:12px;margin:6px 0">
            ${versions.map((v) => `
              <span class="chip" style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border,#dce6f2);border-radius:12px;padding:1px 8px;margin:2px 4px 2px 0">
                ${UI.esc(v.effective_from)}${v.note ? ` · ${UI.esc(v.note)}` : ''}
                ${canWrite ? `<button type="button" class="icon-btn" data-del-ver="${v.id}" title="Delete this version" style="padding:0">${UI.icon('trash', 12)}</button>` : ''}
              </span>`).join('') || '<span class="muted">no stored versions — using the built-in 2026 seed</span>'}
          </div>
          <label style="font-size:12px">Effective figures (JSON)</label>
          <textarea data-json="${kind}" ${canWrite ? '' : 'readonly'} rows="7" style="width:100%;font-family:monospace;font-size:12px">${UI.esc(JSON.stringify(eff, null, 2))}</textarea>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input type="date" data-date="${kind}" ${canWrite ? '' : 'disabled'} value="${new Date().getFullYear() + 1}-01-01" style="width:150px" />
            <input type="text" data-note="${kind}" ${canWrite ? '' : 'disabled'} placeholder="Note (e.g. 'per SSS Circular 2027-001')" style="flex:1" />
            ${canWrite ? `<button type="button" class="btn secondary small" data-save="${kind}">Save as new version</button>` : ''}
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('[data-save]').forEach((b) => b.onclick = async () => {
      const kind = b.dataset.save;
      let data;
      try { data = JSON.parse(box.querySelector(`[data-json="${kind}"]`).value); }
      catch { UI.toast('That JSON is not valid', 'error'); return; }
      const effective_from = box.querySelector(`[data-date="${kind}"]`).value;
      const note = box.querySelector(`[data-note="${kind}"]`).value.trim();
      try {
        await API.post('/hr/payroll-tables', { kind, effective_from, data, note: note || undefined });
        UI.toast(`${RATE_KIND_LABEL[kind]} version saved`);
        state = await load();
        render(ov);
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    box.querySelectorAll('[data-del-ver]').forEach((b) => b.onclick = async () => {
      if (!await UI.confirmDialog('Delete this rate-table version?', 'Delete')) return;
      try {
        await API.del('/hr/payroll-tables/' + b.dataset.delVer);
        state = await load();
        render(ov);
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  return m;
}

/* ── Cutoff detail: roster + daily grid ──────────────────────────────────── */
async function renderPeriod(view, periodId, initialEmployeeId) {
  let period = null;
  try { period = await API.get('/hr/periods/' + periodId); }
  catch (err) {
    // A deleted/bad id is final; anything else (offline, 5xx) gets a retry instead of a dead end.
    const notFound = err && err.status === 404;
    view.innerHTML = `
      <div class="topbar">
        <button type="button" class="btn secondary small" id="tk-back">${UI.icon('arrow-left', 14)} All Cutoffs</button>
      </div>
      <div class="panel">${UI.emptyState({
        icon: notFound ? 'calendar' : 'alert',
        title: notFound ? 'Cutoff not found' : 'Couldn’t load this cutoff',
        hint: notFound ? 'It may have been deleted. Go back to the cutoff list.' : ((err && err.message) || 'Check your connection, then try again.'),
        action: notFound ? '' : '<button type="button" class="btn secondary" id="tk-retry">Try again</button>',
      })}</div>`;
    view.querySelector('#tk-back').onclick = () => App.navigate('hr-timekeeping');
    const retry = view.querySelector('#tk-retry');
    if (retry) retry.onclick = () => renderPeriod(view, periodId, initialEmployeeId);
    return;
  }
  // The payroll_period label used for the last (or most recent) Generate Payslips run — it's
  // editable there, so "Post to GL" needs to target the same label, not always period.label.
  let lastPayrollPeriod = period.label;
  // Roster/cutoff writes are hr.manage and payslip/GL writes payroll.manage server-side; read-only
  // viewers keep the roster, daily grids and CSV export without buttons that would only 403.
  const canManage = App.hasPermission('hr.manage') && !period.locked;
  const canPayroll = App.hasPermission('payroll.manage');
  const showRate = App.hasPermission('payroll.view');
  const hasTools = canManage || canPayroll;

  view.innerHTML = `
    <div class="topbar">
      <button type="button" class="btn secondary small" id="tk-back">${UI.icon('arrow-left', 14)} All Cutoffs</button>
      <div>
        <h2 id="tk-period-title">${UI.esc(period.label)}</h2>
        <div class="sub" id="tk-period-sub"></div>
      </div>
      <div class="grow"></div>
      <button type="button" class="btn secondary" id="tk-export-csv" title="Download this cutoff's whole timekeeping roster as CSV">${UI.icon('download')} Export CSV</button>
      ${hasTools ? `<button type="button" class="btn secondary" id="tk-more-toggle" aria-expanded="false" aria-controls="tk-more">${UI.icon('settings')} Cutoff tools</button>` : ''}
      ${canPayroll ? `<button type="button" class="btn" id="tk-generate">${UI.icon('sheet')} Generate Payslips</button>` : ''}
    </div>
    ${period.locked ? '<div class="panel hr-workflow-notice"><strong>Locked after payment</strong><p class="muted">Attendance, roster and cutoff dates are read-only. Payroll must explicitly unmark all paid payslips to reopen them. Remaining unpaid payslips can still be reviewed and paid.</p></div>' : ''}
    ${(period.warnings || []).length ? `<div class="panel hr-workflow-notice" id="tk-warnings" role="status"><strong>Payroll review warnings — generation is still allowed</strong><ul>${period.warnings.map(w => `<li>${UI.esc(w)}</li>`).join('')}</ul><button class="btn secondary small" id="tk-review-approvals">Review approvals</button></div>` : ''}
    ${hasTools ? `<div class="hr-tools" id="tk-more" hidden>
      ${canManage ? `<div class="hr-tools-group" role="group" aria-labelledby="tk-more-cutoff">
        <span class="hr-tools-label" id="tk-more-cutoff">Cutoff</span>
        <button type="button" class="btn secondary small" id="tk-edit-period">${UI.icon('edit', 14)} Edit Cutoff</button>
        <button type="button" class="btn secondary small" id="tk-import-punches" title="Punches fill time-in/out live while someone's on this cutoff's roster — use this to backfill anyone who punched before being added">${UI.icon('calendar', 14)} Import Punches</button>
      </div>` : ''}
      ${canPayroll ? `<div class="hr-tools-group" role="group" aria-labelledby="tk-more-acct">
        <span class="hr-tools-label" id="tk-more-acct">Accounting</span>
        <button type="button" class="btn secondary small" id="tk-post-gl" title="Post this cutoff's generated payslips to the General Ledger">${UI.icon('building', 14)} Post to GL</button>
      </div>` : ''}
    </div>` : ''}
    <div class="panel">
      <div class="tk-roster-filters">
        <div class="search-box search">
          <span class="ic">${UI.icon('search', 15)}</span>
          <label class="hr-sr-only" for="tk-roster-search">Search roster by name</label>
          <input type="search" id="tk-roster-search" placeholder="Search name…" autocomplete="off" />
        </div>
        <div class="fld">
          <label for="tk-roster-show">Show</label>
          <select id="tk-roster-show">
            <option value="" selected>Everyone</option>
            <option value="incomplete">Incomplete days</option>
            <option value="unlogged">Nothing logged</option>
          </select>
        </div>
        <div class="fld">
          <label for="tk-roster-group">Group</label>
          <select id="tk-roster-group">
            <option value="department" selected>Department</option>
            <option value="none">None</option>
            <option value="status">Status</option>
          </select>
        </div>
        <div class="fld">
          <label for="tk-roster-sort">Sort</label>
          <select id="tk-roster-sort">
            <option value="name">Name</option>
            <option value="department">Department</option>
            <option value="status">Status</option>
            ${showRate ? '<option value="daily_rate">Daily Rate</option>' : ''}
            <option value="days_logged">Days Logged</option>
          </select>
        </div>
        <button type="button" class="icon-btn" id="tk-roster-sort-dir" title="Reverse sort order" aria-label="Sort descending">${UI.icon('adjust', 15)}</button>
        <button type="button" class="btn secondary small" id="tk-roster-reset" hidden>Reset</button>
        <div class="grow"></div>
        <span class="hr-filter-count" id="tk-roster-count" aria-live="polite"></span>
        ${canManage ? `<button type="button" class="btn danger small" id="tk-remove-selected" hidden>${UI.icon('trash')} Remove selected</button>
        <button type="button" class="btn secondary" id="tk-add-emp">${UI.icon('plus')} Add Employee</button>` : ''}
      </div>
      <div id="tk-roster"></div>
    </div>`;

  function renderHeader() {
    view.querySelector('#tk-period-title').textContent = period.label;
    const n = (period.roster || []).length;
    view.querySelector('#tk-period-sub').textContent =
      `${period.start_date} – ${period.end_date} · ${n} employee${n === 1 ? '' : 's'} on roster`;
  }
  renderHeader();
  const reviewApprovals = view.querySelector('#tk-review-approvals'); if (reviewApprovals) reviewApprovals.onclick = () => App.navigate('hr-approvals');

  view.querySelector('#tk-back').onclick = () => App.navigate('hr-timekeeping');
  wireHrDisclosure(view.querySelector('#tk-more-toggle'), view.querySelector('#tk-more'));
  const editBtn = view.querySelector('#tk-edit-period'); // hr.manage only
  // reload() also re-renders the header, so an edited label/date range shows immediately.
  if (editBtn) editBtn.onclick = () => periodModal(period, reload);
  const genBtn = view.querySelector('#tk-generate'); // payroll.manage only
  if (genBtn) genBtn.onclick = () => generateModal();
  const glBtn = view.querySelector('#tk-post-gl');
  if (glBtn) glBtn.onclick = () => postGlModal();
  const importBtn = view.querySelector('#tk-import-punches'); // hr.manage only
  if (importBtn) importBtn.onclick = async () => {
    const ok = await UI.confirmDialog(
      'Fill each roster day’s time-in / time-out from the employee’s clock punches for that date. Days you’ve already set by hand are left untouched.',
      'Import'
    );
    if (!ok) return;
    importBtn.disabled = true;
    try {
      const r = await API.post(`/hr/clock/import/${periodId}`);
      UI.toast(`Filled ${r.filled} day(s) across ${r.dates} date(s)`, 'success');
      await reload();
    } catch (ex) {
      UI.toast(ex.message || 'Import failed', 'error');
    } finally {
      importBtn.disabled = false;
    }
  };
  const addEmpBtn = view.querySelector('#tk-add-emp'); // hr.manage only
  if (addEmpBtn) addEmpBtn.onclick = () => addEmployeeModal();
  view.querySelector('#tk-export-csv').onclick = () =>
    API.download(`/hr/periods/${periodId}/attendance/export`, `timekeeping-${period.label.replace(/[^a-z0-9]+/gi, '-')}.csv`)
      .catch((e) => UI.toast(e.message, 'error'));

  const rosterEl = view.querySelector('#tk-roster');
  const groupSel = view.querySelector('#tk-roster-group');
  const sortSel = view.querySelector('#tk-roster-sort');
  const sortDirBtn = view.querySelector('#tk-roster-sort-dir');
  const searchInput = view.querySelector('#tk-roster-search');
  const showSel = view.querySelector('#tk-roster-show');
  const resetBtn = view.querySelector('#tk-roster-reset');
  const countEl = view.querySelector('#tk-roster-count');
  const ROSTER_DEFAULTS = { groupBy: 'department', sortBy: 'name', sortDir: 'asc', search: '', show: '' };
  const rosterView = { ...ROSTER_DEFAULTS };
  const SHOW_FILTERS = {
    incomplete: (r) => (r.days_incomplete || 0) > 0,
    unlogged: (r) => !(r.days_logged || 0),
  };

  const STATUS_LABELS = { probationary: 'Probationary', regular: 'Regular', suspended: 'Suspended', resigned: 'Resigned', terminated: 'Terminated' };
  const SORTERS = {
    name: (r) => (r.name || '').toLowerCase(),
    department: (r) => (r.department_name || '').toLowerCase(),
    status: (r) => (r.status || ''),
    daily_rate: (r) => r.daily_rate || 0,
    days_logged: (r) => r.days_logged || 0,
  };

  function sortRoster(list) {
    const key = SORTERS[rosterView.sortBy] || SORTERS.name;
    const dir = rosterView.sortDir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const va = key(a), vb = key(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (a.name || '').localeCompare(b.name || '') * dir;
    });
  }

  function rosterRowHtml(r) {
    return `
      <tr class="clickable" data-open="${r.employee_id}">
        ${canManage ? `<td><input type="checkbox" class="tk-roster-chk" data-emp="${r.employee_id}" data-name="${UI.esc(r.name)}" aria-label="Select ${UI.esc(r.name)}" /></td>` : ''}
        <td><button type="button" class="hr-row-open" title="Open daily time">${UI.esc(r.name)}</button></td>
        <td>${UI.esc(r.department_name || '—')}</td>
        <td>${UI.esc(STATUS_LABELS[r.status] || r.status || '—')}</td>
        ${showRate ? `<td class="right">${UI.money(r.daily_rate)}</td>` : ''}
        <td class="right">${r.days_logged || 0} / ${r.days_total || 0}${r.days_incomplete
          ? ` <span class="tk-roster-incomplete" title="${r.days_incomplete} incomplete day(s) — only one of time in/out set">${UI.icon('alert', 13)} ${r.days_incomplete}</span>`
          : ''}</td>
        <td class="actions">${canManage && r.days_incomplete && r.user_id
          ? `<button type="button" class="icon-btn" title="Send this employee a notice to fix their missing time-out and see HR" aria-label="Send ${UI.esc(r.name)} a missing time-out notice" data-notify="${r.employee_id}">${UI.icon('send', 15)}</button>`
          : ''}${canManage ? `<button type="button" class="icon-btn danger" title="Remove from cutoff" aria-label="Remove ${UI.esc(r.name)} from cutoff" data-rm="${r.employee_id}">${UI.icon('trash')}</button>` : ''}</td>
      </tr>`;
  }

  // One table for the whole roster — group headers are separator rows inside its <tbody>, not
  // separate <table>s, so every group's columns line up on the same fixed grid. `sections` is
  // [{ name, rows }]; name === null renders no header (the ungrouped case). The checkbox and
  // rate columns exist only for roles that see them, so the <col>s and group colspan follow suit.
  function rosterTableHtml(sections) {
    const colCount = 5 + (canManage ? 1 : 0) + (showRate ? 1 : 0);
    const body = sections.map((s) => {
      const head = s.name != null
        ? `<tr class="tk-group-row"><td colspan="${colCount}">${UI.esc(s.name)} <span>(${s.rows.length})</span></td></tr>`
        : '';
      return head + s.rows.map(rosterRowHtml).join('');
    }).join('');
    return `
      <table class="tk-roster-table">
        <colgroup>
          ${canManage ? '<col class="c-chk" />' : ''}<col class="c-emp" /><col class="c-dept" />
          <col class="c-status" />${showRate ? '<col class="c-rate" />' : ''}<col class="c-days" /><col class="c-act" />
        </colgroup>
        <thead><tr>${canManage ? '<th><span class="hr-sr-only">Select</span></th>' : ''}<th>Employee</th><th>Department</th><th>Status</th>${showRate ? '<th class="right">Daily Rate</th>' : ''}<th class="right">Days Logged</th><th><span class="hr-sr-only">Actions</span></th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function rosterFiltersActive() {
    return Object.keys(ROSTER_DEFAULTS).some((k) => k === 'search'
      ? !!rosterView.search.trim()
      : rosterView[k] !== ROSTER_DEFAULTS[k]);
  }

  function resetRosterView() {
    Object.assign(rosterView, ROSTER_DEFAULTS);
    searchInput.value = '';
    showSel.value = ROSTER_DEFAULTS.show;
    groupSel.value = ROSTER_DEFAULTS.groupBy;
    sortSel.value = ROSTER_DEFAULTS.sortBy;
    renderRoster();
    searchInput.focus();
  }

  function renderRoster() {
    renderHeader();
    const fullRoster = period.roster || [];
    resetBtn.hidden = !rosterFiltersActive();
    sortDirBtn.setAttribute('aria-label', rosterView.sortDir === 'asc' ? 'Sort descending' : 'Sort ascending');
    if (!fullRoster.length) {
      countEl.textContent = '';
      rosterEl.innerHTML = UI.emptyState({
        icon: 'users',
        title: 'No employees on this cutoff yet',
        hint: canManage ? 'Add employees to start logging their daily time-in/out.' : 'HR hasn’t added anyone to this cutoff yet.',
        action: canManage ? `<button type="button" class="btn" id="tk-empty-add">${UI.icon('plus')} Add Employee</button>` : '',
      });
      const emptyAdd = rosterEl.querySelector('#tk-empty-add');
      if (emptyAdd) emptyAdd.onclick = () => addEmployeeModal();
      updateRemoveSelectedBtn();
      return;
    }

    const q = rosterView.search.trim().toLowerCase();
    const showFn = SHOW_FILTERS[rosterView.show];
    const roster = fullRoster.filter((r) =>
      (!q || (r.name || '').toLowerCase().includes(q)) && (!showFn || showFn(r)));
    countEl.textContent = roster.length === fullRoster.length
      ? `${fullRoster.length} employee${fullRoster.length === 1 ? '' : 's'}`
      : `${roster.length} of ${fullRoster.length} employees`;
    if (!roster.length) {
      rosterEl.innerHTML = UI.emptyState({
        icon: 'search',
        title: q ? `No one on this cutoff matches “${rosterView.search.trim()}”` : 'No one on this cutoff matches this filter',
        hint: 'Clear the filters to see the whole roster.',
        action: '<button type="button" class="btn secondary" id="tk-roster-clear">Clear filters</button>',
      });
      rosterEl.querySelector('#tk-roster-clear').onclick = () => resetRosterView();
      updateRemoveSelectedBtn();
      return;
    }

    if (rosterView.groupBy === 'none') {
      rosterEl.innerHTML = rosterTableHtml([{ name: null, rows: sortRoster(roster) }]);
    } else {
      const groupLabel = (r) => rosterView.groupBy === 'department'
        ? (r.department_name || 'No Department')
        : (STATUS_LABELS[r.status] || r.status || 'Unknown');
      const groups = new Map();
      roster.forEach((r) => {
        const key = groupLabel(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
      rosterEl.innerHTML = rosterTableHtml(
        groupNames.map((name) => ({ name, rows: sortRoster(groups.get(name)) }))
      );
    }

    rosterEl.querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeEmployee(b.dataset.rm, roster); });
    rosterEl.querySelectorAll('[data-notify]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const r = roster.find((x) => String(x.employee_id) === b.dataset.notify);
      if (r) notifyIncompleteEmployee(r);
    });
    rosterEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions') || e.target.closest('.tk-roster-chk')) return;
      const r = roster.find((x) => String(x.employee_id) === tr.dataset.open);
      if (r) dailyGridModal(r);
    });
    rosterEl.querySelectorAll('.tk-roster-chk').forEach((c) => {
      c.addEventListener('click', (e) => e.stopPropagation());
      c.addEventListener('change', updateRemoveSelectedBtn);
    });
    updateRemoveSelectedBtn();
  }

  const removeSelectedBtn = view.querySelector('#tk-remove-selected'); // hr.manage only
  function selectedEmployees() {
    return Array.from(rosterEl.querySelectorAll('.tk-roster-chk:checked'))
      .map((c) => ({ id: c.dataset.emp, name: c.dataset.name }));
  }
  function updateRemoveSelectedBtn() {
    if (!removeSelectedBtn) return;
    const n = selectedEmployees().length;
    removeSelectedBtn.hidden = n === 0;
    removeSelectedBtn.textContent = '';
    removeSelectedBtn.innerHTML = `${UI.icon('trash')} Remove selected (${n})`;
  }
  // Item 5: bulk-remove, but one "are you sure" per employee rather than a single combined
  // confirm — each removal is its own irreversible action (their logged time for this cutoff
  // goes with it), so a rushed single "yes to all" click shouldn't be able to take out someone
  // the user didn't mean to. Cancelling one skips just that employee and moves to the next.
  if (removeSelectedBtn) removeSelectedBtn.onclick = async () => {
    const targets = selectedEmployees();
    let removed = 0, skipped = 0;
    for (const t of targets) {
      const ok = await UI.confirmDialog(`Remove ${t.name} from this cutoff? Their logged time for it will be lost.`, 'Remove');
      if (!ok) { skipped++; continue; }
      try { await API.del(`/hr/periods/${periodId}/employees/${t.id}`); removed++; }
      catch (e) { UI.toast(`${t.name}: ${e.message}`, 'error'); }
    }
    if (removed) UI.toast(`Removed ${removed} employee(s)${skipped ? `, skipped ${skipped}` : ''}`);
    else if (skipped) UI.toast('Nothing removed');
    await reload();
  };

  // Message an employee (via their linked login account) about the days in this cutoff where
  // only one of time-in/time-out is set, asking them to see HR. Reuses internal messaging —
  // no email, no new endpoint.
  async function notifyIncompleteEmployee(rosterRow) {
    if (!rosterRow.user_id) { UI.toast('This employee has no linked login account', 'error'); return; }
    let dates = [];
    try {
      const days = await API.get(`/hr/periods/${periodId}/attendance?employee_id=${rosterRow.employee_id}`);
      const today = new Date().toISOString().slice(0, 10);
      dates = days.filter((d) => (!!d.time_in !== !!d.time_out) && d.work_date <= today).map((d) => d.work_date);
    } catch { /* fall back to a date-less message */ }
    const dateList = dates.length ? dates.join(', ') : '(see your timekeeping record)';
    const ok = await UI.confirmDialog(
      `Send ${UI.esc(rosterRow.name)} a notice about ${dates.length || 'their'} incomplete day(s) in "${UI.esc(period.label)}"?`,
      'Send notice');
    if (!ok) return;
    try {
      await API.post('/messages', {
        recipient_id: rosterRow.user_id,
        subject: `Timekeeping — missing time-out (${period.label})`,
        body: `Hi ${rosterRow.name},\n\nYour attendance for the cutoff "${period.label}" has day(s) with a time-in but no time-out (or vice versa): ${dateList}.\n\nPlease see HR to correct your timekeeping record so your payroll is computed correctly.\n\nThank you.`,
      });
      UI.toast(`Notice sent to ${rosterRow.name}`, 'success');
    } catch (e) {
      UI.toast(e.message || 'Could not send notice', 'error');
    }
  }

  groupSel.addEventListener('change', () => { rosterView.groupBy = groupSel.value; renderRoster(); });
  sortSel.addEventListener('change', () => { rosterView.sortBy = sortSel.value; renderRoster(); });
  showSel.addEventListener('change', () => { rosterView.show = showSel.value; renderRoster(); });
  sortDirBtn.addEventListener('click', () => {
    rosterView.sortDir = rosterView.sortDir === 'asc' ? 'desc' : 'asc';
    renderRoster();
  });
  resetBtn.addEventListener('click', () => resetRosterView());
  // Only #tk-roster is re-rendered, so the search field keeps focus/caret while typing.
  searchInput.addEventListener('input', () => { rosterView.search = searchInput.value; renderRoster(); });

  // Refetch after any write. A failed refresh keeps the roster already on screen (the write
  // itself went through) and says so, rather than throwing into the caller's success path.
  async function reload() {
    try {
      period = await API.get('/hr/periods/' + periodId);
    } catch (err) {
      UI.toast(`Couldn’t refresh the roster: ${(err && err.message) || 'request failed'}`, 'error');
      return;
    }
    if (period.locked) { App.navigate('hr-timekeeping', { period_id: periodId }); return; }
    const warningPanel = view.querySelector('#tk-warnings');
    if (warningPanel) warningPanel.querySelector('ul').innerHTML = (period.warnings || []).map(w => `<li>${UI.esc(w)}</li>`).join('');
    renderRoster();
  }

  async function removeEmployee(employeeId, roster) {
    const r = roster.find((x) => String(x.employee_id) === String(employeeId));
    if (!r) return;
    if (!await UI.confirmDialog(`Remove ${r.name} from this cutoff? Their logged time for it will be lost.`, 'Remove')) return;
    try {
      await API.del(`/hr/periods/${periodId}/employees/${employeeId}`);
    } catch (err) {
      UI.toast((err && err.message) || 'Could not remove the employee', 'error');
      return;
    }
    UI.toast('Employee removed from cutoff');
    reload();
  }

  /* ---- Add employee (search existing master list, filter by department/status) ---- */
  async function addEmployeeModal() {
    const onRoster = new Set((period.roster || []).map((r) => r.employee_id));
    const depts = await API.get('/users/departments/list').catch(() => []);
    const deptOpts = '<option value="">All departments</option>' +
      depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
    const statusOpts = '<option value="">All statuses</option>' +
      Object.keys(STATUS_LABELS).map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');
    const checked = new Set();

    const m = UI.modal({
      title: 'Add employees to cutoff',
      size: 'lg',
      bodyHTML: `<div class="search-box">${UI.icon('search', 16)}<input id="tk-pick-q" placeholder="Search employees…" autofocus /></div>
        <div class="field-row" style="margin-top:8px">
          <div><select id="tk-pick-dept">${deptOpts}</select></div>
          <div><select id="tk-pick-status">${statusOpts}</select></div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
          <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
            <input type="checkbox" id="tk-pick-all" style="width:auto" /> Select all shown
          </label>
          <div class="grow"></div>
          <button type="button" class="btn secondary small" id="tk-pick-add-selected" disabled>Add Selected (0)</button>
          <button type="button" class="btn small" id="tk-pick-add-all">Add All Matching</button>
        </div>
        <div id="tk-pick-results" style="margin-top:12px"><div class="empty">Loading…</div></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const q = ov.querySelector('#tk-pick-q');
        const deptSel = ov.querySelector('#tk-pick-dept');
        const statusSel = ov.querySelector('#tk-pick-status');
        const out = ov.querySelector('#tk-pick-results');
        const selectAll = ov.querySelector('#tk-pick-all');
        const addSelectedBtn = ov.querySelector('#tk-pick-add-selected');
        const addAllBtn = ov.querySelector('#tk-pick-add-all');
        let timer;
        let shownIds = [];

        function refreshSelectionUi() {
          addSelectedBtn.textContent = `Add Selected (${checked.size})`;
          addSelectedBtn.disabled = checked.size === 0;
          selectAll.checked = shownIds.length > 0 && shownIds.every((id) => checked.has(id));
        }

        async function search() {
          const params = new URLSearchParams();
          if (q.value.trim()) params.set('q', q.value.trim());
          if (deptSel.value) params.set('department_id', deptSel.value);
          if (statusSel.value) params.set('status', statusSel.value);
          const items = (await API.get('/hr/employees?' + params.toString()))
            .filter((it) => !onRoster.has(it.id));
          shownIds = items.map((it) => it.id);
          if (!items.length) {
            out.innerHTML = '<div class="empty">No matching employees</div>';
            addAllBtn.textContent = 'Add All Matching';
            addAllBtn.disabled = true;
            refreshSelectionUi();
            return;
          }
          addAllBtn.disabled = false;
          addAllBtn.textContent = `Add All Matching (${items.length})`;
          out.innerHTML = items.map((it) => `
            <label class="pick-row" data-id="${it.id}" style="display:flex;justify-content:flex-start;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" data-check="${it.id}" style="width:auto" ${checked.has(it.id) ? 'checked' : ''} />
              <div>
                <div><strong>${UI.esc(it.name)}</strong> <span class="muted">${UI.esc(it.department_name || '')}</span></div>
                <div class="muted">${UI.esc(it.position || '')} &middot; ${UI.esc(STATUS_LABELS[it.status] || it.status)}</div>
              </div>
            </label>`).join('');
          out.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', () => {
            const id = Number(cb.dataset.check);
            if (cb.checked) checked.add(id); else checked.delete(id);
            refreshSelectionUi();
          }));
          refreshSelectionUi();
        }

        async function addBulk(body) {
          const res = await API.post(`/hr/periods/${periodId}/employees/bulk`, body);
          const skipped = res.matched - res.added;
          UI.toast(
            `Added ${res.added} employee${res.added === 1 ? '' : 's'} to the cutoff` +
            (skipped > 0 ? ` (${skipped} already on it)` : '')
          );
          m.close();
          reload();
        }

        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        deptSel.addEventListener('change', search);
        statusSel.addEventListener('change', search);
        selectAll.addEventListener('change', () => {
          if (selectAll.checked) shownIds.forEach((id) => checked.add(id));
          else shownIds.forEach((id) => checked.delete(id));
          search();
        });
        addSelectedBtn.onclick = () => addBulk({ employee_ids: Array.from(checked) });
        addAllBtn.onclick = () => addBulk({
          q: q.value.trim() || undefined, department_id: deptSel.value || undefined, status: statusSel.value || undefined,
        });
        search();
      },
    });
  }

  /* ---- Daily time-in/out grid for one roster employee ----
     Each day can also be assigned a Shift (covers rotating shifts — a day just points at
     whichever shift applied) and optionally linked to an OT/Half Day/Leave/Undertime/Offset/
     Reported form record, both purely optional — Generate Payslips picks these up automatically, but
     nothing here is required to just log plain time-in/out like before. */
  const HOLIDAY_LABELS = {
    regular: 'Regular Holiday', special_non_working: 'Special Non-Working', special_working: 'Special Working',
    cancelled_paid: 'Cancelled (Paid)', cancelled_unpaid: 'Cancelled (Unpaid)',
  };
  /** "YYYY-MM-DD" -> weekday index (0=Sun..6=Sat), from local y/m/d components (not
      new Date("YYYY-MM-DD"), which parses as UTC and can read back as the wrong day). */
  function weekdayOf(workDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(workDate || '');
    if (!m) return -1;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  }

  /** Raw minutes between time_in/time_out (crossing midnight if time_out < time_in) — a quick
      client-side approximation of PayrollPolicy.min_work_minutes for the grid's flag/button,
      not itself the real payroll computation (see hr-payroll-compute.ts for that). null if
      either side is blank. */
  // Timed out for lunch and never punched again (no lunch_in, no time_out) — mirrors
  // hr-payroll-compute.ts's own abandonedAfterLunch substitution so this client-side
  // approximation flags the same days the real payroll computation now auto-half-days, instead
  // of the two silently disagreeing.
  function effectiveTimeOut(d) {
    if (d.time_out) return d.time_out;
    return d.lunch_out && !d.lunch_in ? d.lunch_out : null;
  }
  function workedMinutesFor(d) {
    const timeOut = effectiveTimeOut(d);
    if (!d.time_in || !timeOut) return null;
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    let inMin = toMin(d.time_in), outMin = toMin(timeOut);
    if (outMin < inMin) outMin += 24 * 60;
    return outMin - inMin;
  }

  async function dailyGridModal(rosterRow) {
    const employeeId = rosterRow.employee_id;
    const FORM_LINK_SLUGS = ['overtime_request', 'halfday_request', 'leave_request', 'undertime_request', 'offset_form', 'lunch_offset_form', 'reported_absence', 'rest_day_work_request', 'rest_day_change'];
    const [days, shifts, policy, holidayForms] = await Promise.all([
      API.get(`/hr/periods/${periodId}/attendance?employee_id=${employeeId}`),
      API.get('/hr/shifts').catch(e => { UI.toast('Couldn’t load shifts: '+e.message,'error'); return []; }),
      API.get('/hr/payroll-policy').catch(e => { UI.toast('Couldn’t load payroll policy. Daily previews may be incomplete; payroll uses the server policy.','error'); return { default_rest_days: [0, 6] }; }),
      API.get('/form-definitions').catch(e => { UI.toast('Couldn’t load HR forms: '+e.message,'error'); return []; }),
    ]);
    const defaultShift = shifts.find((s) => s.is_default) || null;
    days.forEach((d) => {
      if (d.shift_id == null) d.shift_id = rosterRow.default_shift_id || (defaultShift ? defaultShift.id : null);
      // A day can link multiple forms now (attendance_records.form_record_ids, a JSON array);
      // fall back to the legacy single form_record_id for rows saved before that. _links holds
      // the resolved {id,label,slug,session} for each, filled by the resolution pass below.
      let ids = [];
      try { ids = d.form_record_ids ? JSON.parse(d.form_record_ids) : []; } catch { ids = []; }
      if (!Array.isArray(ids) || !ids.length) ids = d.form_record_id ? [d.form_record_id] : [];
      d._formIds = ids.filter((n) => Number.isInteger(n) && n > 0);
      d._links = [];
    });
    // Every form linked when the grid opened — lets restDaySwapFor tell "HR just unlinked this
    // Change of Rest Day" (ignore the server's swap until Save) from a swap whose form is linked
    // on a day in some other cutoff (keep it).
    const loadedFormIds = new Set(days.flatMap((d) => d._formIds));

    // "Make a new form" — the configured form fields plus payroll-specific fields. Requests
    // remain pending until a department approver or HR decides them.
    const MAKE_FORM_TYPES = [
      { slug: 'halfday_request', label: 'Half Day', dateKey: 'date', fields: [
        { key: 'session', label: 'Session', type: 'select', options: ['Morning (AM)', 'Afternoon (PM)'], required: true },
      ] },
      // OT itself needs no input — the form just AUTHORISES overtime; payroll computes the
      // actual hours from the logged Time Out vs the shift end (rounded to the OT unit, capped
      // by max_ot_hours). The modal shows that detected figure instead of asking for an
      // estimate. approved_hours is the one optional exception: a per-day override of the
      // policy cap for when it's been specifically approved higher than usual (e.g. "policy
      // caps OT at 2h/day but the boss okayed 4h today") — read directly by the compute engine.
      { slug: 'overtime_request', label: 'Overtime', dateKey: 'work_date', fields: [
        { key: 'approved_hours', label: 'Approved OT hours today (optional — overrides the cap above for just this day)', type: 'number' },
      ], detectOt: true },
      { slug: 'undertime_request', label: 'Undertime', dateKey: 'work_date', fields: [
        { key: 'with_pay', label: 'With pay?', type: 'select', options: ['Yes', 'No'], required: true },
      ] },
      { slug: 'offset_form', label: 'Offset', dateKey: 'work_date', fields: [
        { key: 'new_time_out', label: 'New time out', type: 'time', required: true },
        { key: 'new_time_in', label: 'New time in (optional)', type: 'time' },
      ] },
      { slug: 'lunch_offset_form', label: 'Lunch/Break Offset', dateKey: 'work_date', fields: [
        { key: 'new_lunch_out', label: 'Approved lunch/break start', type: 'time', required: true },
        { key: 'new_lunch_in', label: 'Approved return (optional)', type: 'time' },
      ] },
      { slug: 'leave_request', label: 'Leave (this day)', dateKey: 'date_from', fields: [
        { key: 'leave_type', label: 'Leave type', type: 'select', required: true,
          options: ['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Maternity/Paternity Leave', 'Bereavement Leave', 'Unpaid Leave'] },
      ] },
      // Not a formal leave form — for an unplanned absence/lateness reported informally by
      // chat or a call to a supervisor (sick and messaged the group chat, an accident on the
      // way to work, etc.) instead of a real Leave/Undertime request. Purely documentation:
      // the day is still judged as a plain absence/late by payroll unless a real form is also
      // linked (hr-payroll-compute.ts never checks this slug).
      { slug: 'reported_absence', label: 'Reported', dateKey: 'work_date', fields: [
        { key: 'reason', label: 'What was reported', type: 'text', required: true },
      ] },
      // Authorizes working this rest day — pays the rest-day premium when Policy Settings
      // requires the form (require_rest_day_form); otherwise it's the paper trail.
      { slug: 'rest_day_work_request', label: 'Rest Day Work', dateKey: 'work_date', fields: [] },
      // Moves the rest day: this date becomes a working day, new_rest_day the rest day
      // (src/modules/hr/rest-day.ts). Filed on the rest day being worked.
      { slug: 'rest_day_change', label: 'Change of Rest Day', dateKey: 'original_rest_day', fields: [
        { key: 'new_rest_day', label: 'New rest day', type: 'date', required: true },
      ] },
    ];

    // Preserve configured details (including custom fields); only employee identity and the
    // selected attendance date are supplied by this grid. Approval metadata is server-owned.
    MAKE_FORM_TYPES.forEach((type) => {
      const def = holidayForms.find((form) => form.slug === type.slug);
      const supplied = ['employee_id', 'employee_name', 'employee_no', 'name', 'department', 'position', type.dateKey,
        'approved_by', 'decided_by', 'decided_at', 'decision_note'];
      if (type.slug === 'leave_request') supplied.push('date_to', 'days');
      const fields = new Map(type.fields.map((field) => [field.key, field]));
      (def && Array.isArray(def.fields) ? def.fields : []).forEach((field) => {
        if (!supplied.includes(field.key)) fields.set(field.key, { ...fields.get(field.key), ...field });
      });
      if (!fields.has('reason')) fields.set('reason', { key: 'reason', label: 'Reason', type: 'textarea' });
      fields.set('reason', { ...fields.get('reason'), required: true, type: 'textarea' });
      type.fields = [...fields.values()];
    });

    // Same two-layer resolution as the payroll engine (hr-payroll-compute.ts via hr.routes.ts)
    // — a per-record override wins, else the Company Holidays calendar, else not a holiday —
    // computed client-side here purely so the grid can show HR what will happen without
    // actually running payroll first.
    const holidayForm = holidayForms.find((f) => f.slug === 'company_holiday');
    const holidayByDate = {};
    if (holidayForm) {
      const records = await API.get('/hr/calendar/company_holiday').catch(e => { UI.toast('Holiday calendar unavailable: '+e.message,'error');return []; });
      const TYPE_TO_CODE = { 'Regular Holiday': 'regular', 'Special Non-Working Holiday': 'special_non_working', 'Special Working Holiday': 'special_working' };
      records.forEach((r) => { if (r.data.date) holidayByDate[r.data.date] = TYPE_TO_CODE[r.data.type] || null; });
    }
    // No Work Memo (company-wide suspensions — typhoon, equipment failure, etc.) is a *range*
    // (date_from..date_to), not a single date, so it can't be looked up by exact match the way
    // the holiday calendar is — matched per-row below instead. Was previously computed only
    // server-side at payroll-generation time, invisible here even though it silently affects
    // whether a blank day counts as an absence.
    const noWorkForm = holidayForms.find((f) => f.slug === 'no_work_memo');
    let noWorkMemos = [];
    if (noWorkForm) {
      noWorkMemos = (await API.get('/hr/calendar/no_work_memo').catch(e => { UI.toast('No-work calendar unavailable: '+e.message,'error');return []; }))
        .filter((r) => r.data.date_from && r.data.date_to);
    }
    function noWorkFor(workDate) {
      const memo = noWorkMemos.find((m) => workDate >= m.data.date_from && workDate <= m.data.date_to);
      return memo ? (memo.data.paid === 'Yes' ? 'paid' : 'unpaid') : null;
    }
    let empRestDays = policy.default_rest_days || [0, 6];
    try { if (rosterRow.rest_days) empRestDays = JSON.parse(rosterRow.rest_days); } catch { /* keep company default */ }

    const shiftOptions = (selectedId) => '<option value="">— No shift —</option>' +
      shifts.map((s) => `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${UI.esc(s.name)} (${UI.esc(s.start_time)}-${UI.esc(s.end_time)})</option>`).join('');

    const dayTypeOptions = (selected) => `
      <option value="" ${!selected ? 'selected' : ''}>Default</option>
      <option value="regular" ${selected === 'regular' ? 'selected' : ''}>Regular Holiday</option>
      <option value="special_non_working" ${selected === 'special_non_working' ? 'selected' : ''}>Special Non-Working</option>
      <option value="special_working" ${selected === 'special_working' ? 'selected' : ''}>Special Working</option>
      <option value="cancelled_paid" ${selected === 'cancelled_paid' ? 'selected' : ''}>Work Cancellation (Paid)</option>
      <option value="cancelled_unpaid" ${selected === 'cancelled_unpaid' ? 'selected' : ''}>Work Cancellation (Unpaid)</option>
      <option value="none" ${selected === 'none' ? 'selected' : ''}>Not a Holiday</option>`;

    // Per-date rest-day override — for a rotating/varying rest day that isn't the same weekday
    // every week. Default inherits the weekly pattern (this employee's or the company default).
    const restDayOptions = (selected) => `
      <option value="" ${!selected ? 'selected' : ''}>Default</option>
      <option value="yes" ${selected === 'yes' ? 'selected' : ''}>Rest day</option>
      <option value="no" ${selected === 'no' ? 'selected' : ''}>Working day</option>`;

    // Rest-day forms only count once approved (same rule as payroll — src/modules/hr/rest-day.ts).
    const isApprovedLink = (l) => l.status === 'approved';
    // Mirror of restDaySwapsFor: an approved Change of Rest Day linked on ANY day of this grid
    // (saved or not) moves the rest day for both of its dates. A swap the server found through a
    // day outside this grid (rest_day_swap) still applies unless HR unlinked its form here.
    function restDaySwapFor(d) {
      let local = null;
      days.forEach((dd) => (dd._links || []).forEach((l) => {
        if (l.slug !== 'rest_day_change' || !isApprovedLink(l) || !l.data) return;
        if (l.data.original_rest_day === d.work_date) local = 'no';
        if (l.data.new_rest_day === d.work_date) local = 'yes';
      }));
      if (local) return local;
      if (!d.rest_day_swap) return null;
      const linkedNow = days.some((dd) => (dd._formIds || []).includes(d.rest_day_swap_form_id));
      return loadedFormIds.has(d.rest_day_swap_form_id) && !linkedNow ? null : d.rest_day_swap;
    }
    // Per-day override, then an approved Change of Rest Day, then the weekly pattern.
    function isRestDayFor(d) {
      if (d.rest_day === 'yes') return true;
      if (d.rest_day === 'no') return false;
      const swap = restDaySwapFor(d);
      return swap ? swap === 'yes' : empRestDays.includes(weekdayOf(d.work_date));
    }
    // Worked a rest day that Policy Settings says needs an approved Rest Day Work Request to earn
    // its premium, and none is linked — same one-click nudge as Possible Half Day?.
    function restDayFormMissing(d) {
      return !!policy.require_rest_day_form && isRestDayFor(d) && !!(d.time_in || d.time_out)
        && !(d._links || []).some((l) => l.slug === 'rest_day_work_request' && isApprovedLink(l));
    }

    // Manual "credit this as a half day anyway" call (attendance_records.half_day_override) —
    // for a day HR knows was a half day but that neither has a linked Half Day request nor
    // happens to match the automatic possible-half-day heuristic (see possibleHalfDayFlagged
    // below). Ignored server-side whenever a real Half Day request IS linked.
    const halfDayOverrideOptions = (selected) => `
      <option value="" ${!selected ? 'selected' : ''}>None</option>
      <option value="am" ${selected === 'am' ? 'selected' : ''}>Half Day (AM) — unauthorized</option>
      <option value="pm" ${selected === 'pm' ? 'selected' : ''}>Half Day (PM) — unauthorized</option>`;

    // A real, live bug found this way: HR types raw times straight into this grid without also
    // filing+linking a Half Day request, so the day gets judged (and any late/undertime
    // deduction charged) against the WHOLE shift instead of correctly being a half day. Quick
    // client-side approximation of hr-payroll-compute.ts's looksLikeUnlinkedHalfDay — not the
    // real payroll computation (same "approximation, not authoritative" caveat as
    // workedMinutesFor above), just enough to flag it here before Generate Payslips ever runs.
    // What payroll will actually pay as OT for this row — clock-out past the shift end, rounded
    // DOWN to policy.ot_unit, capped at policy.max_ot_hours. Mirrors hr-payroll-compute.ts; a
    // linked Offset form's shifted end isn't reflected here (rare combo, still correct at
    // generate time). Purely a hint shown when "Make a new form → Overtime" is picked, so HR
    // doesn't have to guess an "estimate" the engine ignores anyway.
    // Early OT (time before the shift start) is only offered — and only paid — when the day's
    // time-in is at least this far ahead of the shift start (EARLY_OT_MIN_MINUTES in
    // hr-payroll-compute.ts).
    const EARLY_OT_MIN_MINUTES = 60;
    const toMinHM = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    /** Minutes this day's time-in came before its shift start (0 if not early / unknown). */
    function earlyMinutesFor(d) {
      const shift = shifts.find((s) => String(s.id) === String(d.shift_id));
      if (!shift || !d.time_in) return 0;
      return Math.max(0, toMinHM(shift.start_time) - toMinHM(d.time_in));
    }
    // Early OT and after-shift OT share the day's cap, early first — the payroll engine's rule:
    // the cap is max_ot_hours, raised (never lowered) by the form's approved hours.
    function detectedOtText(d, opts = {}) {
      if (!d.time_in || !d.time_out) return 'Enter the day’s Time Out first — OT is computed from it.';
      const shift = shifts.find((s) => String(s.id) === String(d.shift_id));
      if (!shift) return 'Assign a shift to this day — OT is measured against the shift’s end time.';
      const start = toMinHM(shift.start_time);
      let end = toMinHM(shift.end_time); if (end < start) end += 24 * 60;
      let out = toMinHM(d.time_out); if (out < toMinHM(d.time_in)) out += 24 * 60;
      const raw = out - end;
      const earlyRaw = earlyMinutesFor(d);
      const unitMin = policy.ot_unit === 'hour' ? 60 : policy.ot_unit === '30min' ? 30 : 1;
      // Mirrors otCreditMinutes in hr-payroll-compute.ts: nothing until ot_min_minutes, then
      // whole blocks; within ot_grace_minutes of the next step counts as reaching it.
      const otMin = Number(policy.ot_min_minutes) || 0, otGrace = Number(policy.ot_grace_minutes) || 0;
      const credit = (m) => {
        if (m <= 0) return 0;
        const got = m < otMin ? 0 : otMin + Math.floor((m - otMin) / unitMin) * unitMin;
        if (!otGrace || (unitMin === 1 && m >= otMin)) return got;
        const next = m < otMin ? otMin : got + unitMin;
        return m + otGrace >= next ? next : got;
      };
      const approved = Number(opts.approvedHours) > 0 ? Number(opts.approvedHours) * 60 : 0;
      const cap = policy.max_ot_hours != null ? Math.max(policy.max_ot_hours * 60, approved) : null;
      const earlyRounded = opts.early && earlyRaw >= EARLY_OT_MIN_MINUTES ? credit(earlyRaw) : 0;
      const early = cap != null ? Math.min(earlyRounded, cap) : earlyRounded;
      const lateRounded = credit(raw);
      const late = cap != null ? Math.min(lateRounded, cap - early) : lateRounded;
      const capped = early + late < earlyRounded + lateRounded;
      const hrs = (m) => (m % 60 ? (m / 60).toFixed(2) : String(m / 60));
      if (early + late <= 0) {
        if (raw <= 0) return 'No time logged past the shift end — nothing to pay as OT.';
        return `${raw} min past the shift end — not enough to count as OT under the OT rules (Policy Settings).`;
      }
      const parts = early > 0 ? ` (${hrs(early)} h early + ${hrs(late)} h after the shift)` : '';
      return `≈ ${hrs(early + late)} h will be paid as OT${parts} — computed from the logged times${capped ? `, capped at ${hrs(cap)} h for the day` : ''}.`;
    }

    function possibleHalfDayFlagged(d) {
      if ((d._links || []).some(l => isApprovedLink(l) || l.slug === 'reported_absence')) return false; // a linked form (Half Day, Undertime…) already says what the day was
      if (d.half_day_override) return false; // HR already manually credited this day a half day
      if (rosterRow.always_whole_day) return false; // always paid a whole day — never a half day
      const workedMin = workedMinutesFor(d);
      if (workedMin == null) return false;
      const shift = shifts.find((s) => String(s.id) === String(d.shift_id));
      if (!shift) return false;
      const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const shiftStart = toMin(shift.start_time);
      let shiftEnd = toMin(shift.end_time);
      if (shiftEnd < shiftStart) shiftEnd += 24 * 60;
      const lunchMinutes = policy.lunch_break_minutes ?? 60;
      const workSpan = Math.max(0, shiftEnd - shiftStart - lunchMinutes);
      if (workedMin <= 0 || workedMin >= workSpan * 0.75) return false;
      const half = workSpan / 2;
      const lunchStart = shiftStart + half, lunchEnd = lunchStart + lunchMinutes;
      let inMin = toMin(d.time_in), outMin = toMin(effectiveTimeOut(d));
      if (outMin < inMin) outMin += 24 * 60;
      const tolerance = 60;
      return (inMin >= lunchStart - tolerance && inMin <= lunchEnd + tolerance)
        || (outMin >= lunchStart - tolerance && outMin <= lunchEnd + tolerance);
    }

    UI.modal({
      title: `Daily time — ${rosterRow.name}`,
      size: 'xl',
      headActionHTML: canManage && rosterRow.user_id
        ? `<button type="button" class="btn secondary small" id="tk-notify-emp">${UI.icon('send', 14)} Send notice</button>`
        : '',
      bodyHTML: `${canManage ? '' : '<p class="muted">Read-only attendance. An HR manager can make corrections.</p>'}<div class="line-items"><table class="line-table tk-daily-table"><thead><tr>
          <th>Date</th><th>Shift</th><th>Time In</th><th>Lunch Out</th><th>Lunch In</th><th>Time Out</th><th>Day Type</th><th>Half Day</th><th>Rest Day</th><th>Notes</th><th>Linked Form</th>
        </tr></thead><tbody id="tk-days"></tbody></table></div>`,
      confirmText: canManage ? 'Save' : null,
      cancelText: canManage ? 'Cancel' : 'Close',
      onOpen: (ov) => {
        const body = ov.querySelector('#tk-days');
        const notifyBtn = ov.querySelector('#tk-notify-emp');
        if (notifyBtn) notifyBtn.onclick = () => notifyIncompleteEmployee(rosterRow);

        const today = new Date().toISOString().slice(0, 10);
        // One of time_in/time_out set but not both, for a day that's already happened. Shared
        // by renderRows (initial paint) and renderIncompleteRow (live refresh on commit) so the
        // two never drift out of sync.
        function isIncomplete(d) {
          return !!d.time_in !== !!d.time_out && d.work_date <= today;
        }
        // Same "own function, refreshed on blur/commit not every keystroke" pattern as
        // minFlagHtml/renderMinFlag below — toggles the row's highlight the instant a time field
        // commits, instead of only after the next full save+reload, without re-rendering (and
        // stealing focus out of) the whole table.
        function renderIncompleteRow(i) {
          const tr = body.querySelector(`tr[data-row="${i}"]`);
          if (!tr) return;
          const incomplete = isIncomplete(days[i]);
          tr.classList.toggle('tk-incomplete', incomplete);
          if (incomplete) tr.title = 'Incomplete — only one of time in/out is set';
          else tr.removeAttribute('title');
        }
        // Below PayrollPolicy.min_work_minutes (0 = off) — flags for review, never withholds pay
        // by itself; only an explicit Deny click does (see hr-payroll-compute.ts). Its own
        // function (not inlined in renderRows) so a time-field blur can refresh just this one
        // row's flag without re-rendering (and stealing focus out of) the whole table.
        function minFlagHtml(d, i) {
          const workedMin = workedMinutesFor(d);
          const belowMinimum = policy.min_work_minutes > 0 && workedMin != null && workedMin < policy.min_work_minutes;
          if (!belowMinimum) return '';
          return `<div style="margin-top:3px">
              <span class="badge-pill status-cancelled" title="Worked ${workedMin} min, under the ${policy.min_work_minutes}-min minimum">
                Below Min${d.min_hours_decision ? ` — ${d.min_hours_decision === 'allow' ? 'Allowed' : 'Denied'}` : ''}
              </span>
              <div style="margin-top:3px;display:flex;gap:4px">
                <button type="button" class="btn secondary small" data-min-allow="${i}" style="padding:1px 7px;font-size:11px">Allow</button>
                <button type="button" class="btn secondary small" data-min-deny="${i}" style="padding:1px 7px;font-size:11px">Deny</button>
              </div>
            </div>`;
        }
        function renderMinFlag(i) {
          const el = body.querySelector(`[data-min-flag="${i}"]`);
          if (!el) return;
          el.innerHTML = minFlagHtml(days[i], i);
          el.querySelectorAll('[data-min-allow]').forEach((b) => b.onclick = () => {
            days[Number(b.dataset.minAllow)].min_hours_decision = 'allow';
            renderMinFlag(Number(b.dataset.minAllow));
          });
          el.querySelectorAll('[data-min-deny]').forEach((b) => b.onclick = () => {
            days[Number(b.dataset.minDeny)].min_hours_decision = 'deny';
            renderMinFlag(Number(b.dataset.minDeny));
          });
        }
        // Same "own function, refreshed on blur not every keystroke" pattern as minFlagHtml/
        // renderMinFlag above — flags a day whose times look like a half day (see
        // possibleHalfDayFlagged) with a one-click path straight into the existing Link-a-form
        // picker, since the actual fix is filing/linking a real Half Day request, not anything
        // this flag can do on its own.
        function halfDayFlagHtml(d, i) {
          if (!possibleHalfDayFlagged(d)) return '';
          return `<div style="margin-top:3px">
              <button type="button" class="badge-pill status-confirmed" data-halfday-flag="${i}"
                style="cursor:pointer;border:none;font:inherit"
                title="Times look like a half day with no Half Day request linked — payroll pays it as a half day automatically, but click to file the actual request and keep the record straight.">
                Possible Half Day?
              </button>
            </div>`;
        }
        function renderHalfDayFlag(i) {
          const el = body.querySelector(`[data-halfday-flag-cell="${i}"]`);
          if (!el) return;
          el.innerHTML = halfDayFlagHtml(days[i], i);
          el.querySelectorAll('[data-halfday-flag]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.halfdayFlag)));
        }
        function restDayFlagHtml(d, i) {
          if (!restDayFormMissing(d)) return '';
          return `<div style="margin-top:3px">
              <button type="button" class="badge-pill status-cancelled" data-restday-flag="${i}"
                style="cursor:pointer;border:none;font:inherit"
                title="Policy Settings requires an approved Rest Day Work Request for the rest-day premium — without one this day pays as an ordinary working day. Click to link or file it.">
                Needs Rest Day form
              </button>
            </div>`;
        }
        // Refreshed on time-field commit, like renderHalfDayFlag — whether the day was worked can
        // change without a full renderRows.
        function renderRestDayFlag(i) {
          const el = body.querySelector(`[data-restday-flag-cell="${i}"]`);
          if (!el) return;
          el.innerHTML = restDayFlagHtml(days[i], i);
          el.querySelectorAll('[data-restday-flag]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.restdayFlag)));
        }
        const TIME_KEYS = ['time_in', 'lunch_out', 'lunch_in', 'time_out'];
        // Small camera badge, shown only when the kiosk actually captured a photo for that
        // slot (see the `photos` object GET /periods/:id/attendance now attaches to each day —
        // src/routes/hr.routes.ts). `url` is /api-relative, per API.blobUrl's convention.
        function photoBtnHtml(url) {
          return url ? `<button type="button" class="tk-photo-btn" data-photo-url="${UI.esc(url)}" title="View kiosk photo">${UI.icon('camera', 12)}</button>` : '';
        }
        function openPunchPhoto(url) {
          const m = UI.modal({ title: 'Kiosk Photo', cancelText: 'Close', bodyHTML: '<div id="tk-photo-body" class="muted" style="text-align:center">Loading…</div>' });
          const body = m.overlay.querySelector('#tk-photo-body');
          API.blobUrl(url).then((objUrl) => {
            body.className = '';
            body.innerHTML = `<img src="${objUrl}" style="max-width:100%;border-radius:10px;display:block;margin:0 auto" />`;
          }).catch(() => { body.textContent = 'Could not load the photo.'; });
        }
        const pad2 = (n) => String(n).padStart(2, '0');
        // 24h value ("HH:MM", same format the old native <input type=time> stored) → the
        // "hh:mm AM/PM" text shown in the fast-entry time fields below.
        function fmtTimeDisplay(v) {
          if (!v) return '';
          const [hh, mm] = v.split(':').map(Number);
          const ampm = hh < 12 ? 'AM' : 'PM';
          let h12 = hh % 12; if (h12 === 0) h12 = 12;
          return `${pad2(h12)}:${pad2(mm)} ${ampm}`;
        }
        // Fast-entry time field: type digits and it fills in the same way a spreadsheet does
        // ("2015" → 08:15 PM), instead of the native <input type=time> segmented control, which
        // treats the hour as 12-hour (max 12) and commits after one keystroke whenever no valid
        // two-digit continuation exists in THAT range — so "20" only ever registered as "2".
        // Hours are read as 24-hour (0-23) and AM/PM is derived automatically: 00-11 → AM,
        // 12-23 → PM. Minutes work the same way (0-59, greedy two-digit entry).
        function wireTimeInput(inp) {
          let h = null, m = null, seg = 'h', segBuf = '', dirty = false;
          const reset = () => { h = null; m = null; seg = 'h'; segBuf = ''; };
          const rawDisplay = () => (h === null ? segBuf : `${pad2(h)}:${segBuf}`);
          const commitValue = (v24) => {
            const row = Number(inp.closest('[data-row]').dataset.row);
            days[row][inp.dataset.k] = v24;
            inp.value = fmtTimeDisplay(v24);
            renderMinFlag(row);
            renderHalfDayFlag(row);
            renderRestDayFlag(row);
            renderIncompleteRow(row);
          };
          const finalizeAndCycle = () => {
            commitValue(`${pad2(h)}:${pad2(m)}`);
            reset(); dirty = false;
          };
          const processMinuteDigit = (d) => {
            if (segBuf === '') {
              segBuf = String(d);
              if (d <= 5) { inp.value = rawDisplay(); return; }
              m = d; finalizeAndCycle(); return;
            }
            m = Number(segBuf + d);
            finalizeAndCycle();
          };
          const commitPending = () => {
            if (!dirty) return;
            if (seg === 'h') {
              if (h === null) {
                if (segBuf === '') { dirty = false; return; }
                h = Number(segBuf);
              }
              m = 0;
            } else if (m === null) {
              m = segBuf === '' ? 0 : Number(segBuf);
            }
            finalizeAndCycle();
          };
          inp.addEventListener('focus', () => { dirty = false; });
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              reset(); dirty = false;
              commitValue('');
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              commitPending();
              if (e.shiftKey) {
                // Shift+Enter saves the whole grid instead of hopping to the next field —
                // same as clicking the modal's Save button.
                const confirmBtn = ov.querySelector('[data-confirm]');
                if (confirmBtn) confirmBtn.click();
                return;
              }
              // Finish whatever's pending, then jump straight to the next TIME field (Time In →
              // Lunch Out → Lunch In → Time Out → next row's Time In) — skipping the Shift/Day
              // Type/Rest Day/Notes fields Tab would otherwise stop at.
              const row = Number(inp.closest('[data-row]').dataset.row);
              const idx = TIME_KEYS.indexOf(inp.dataset.k);
              const nextRow = idx < TIME_KEYS.length - 1 ? row : row + 1;
              const nextKey = TIME_KEYS[(idx + 1) % TIME_KEYS.length];
              const nextInp = body.querySelector(`tr[data-row="${nextRow}"] input[data-k="${nextKey}"]`);
              if (nextInp) nextInp.focus();
              return;
            }
            if (!/^[0-9]$/.test(e.key)) {
              if (e.key.length === 1) e.preventDefault(); // block stray letters; let nav keys (Tab, arrows...) through
              return;
            }
            e.preventDefault();
            const d = Number(e.key);
            if (!dirty) { reset(); dirty = true; }
            if (seg === 'h') {
              if (segBuf === '') {
                segBuf = String(d);
                if (d === 0 || d === 1 || d === 2) { inp.value = rawDisplay(); return; } // 0x/1x/2x could still extend
                h = d; seg = 'm'; segBuf = '';
                inp.value = rawDisplay();
                return;
              }
              const combined = Number(segBuf + d);
              if (combined <= 23) {
                h = combined; seg = 'm'; segBuf = '';
                inp.value = rawDisplay();
              } else {
                // e.g. "2" then "5" — 25 isn't a valid hour, so "2" stands alone and the "5"
                // starts the minute segment instead of being dropped.
                h = Number(segBuf);
                seg = 'm'; segBuf = '';
                processMinuteDigit(d);
              }
              return;
            }
            processMinuteDigit(d);
          });
          inp.addEventListener('blur', () => commitPending());
        }
        function renderRows() {
          body.innerHTML = days.map((d, i) => {
            // Flagged so HR can spot & fix it at a glance, distinct from a plain blank
            // (unremarkable — not yet worked, or a known absence) or a fully-filled day.
            const incomplete = isIncomplete(d);
            // Effective holiday: override (if not '' and not 'none') else the calendar's entry.
            const effHoliday = d.holiday_type ? (d.holiday_type === 'none' ? null : d.holiday_type) : holidayByDate[d.work_date];
            // Per-date override wins, else the weekly rest-day pattern for this weekday.
            const isRestDay = isRestDayFor(d);
            // Shown only when an approved Change of Rest Day (not HR's dropdown) decided the day.
            const swap = restDaySwapFor(d);
            const movedRestDay = !d.rest_day && !!swap && (swap === 'yes') !== empRestDays.includes(weekdayOf(d.work_date));
            const isCancellation = effHoliday === 'cancelled_paid' || effHoliday === 'cancelled_unpaid';
            const noWork = effHoliday ? null : noWorkFor(d.work_date); // holiday/override always takes precedence
            // Explicit "Half Day" identifier — the linked-form badge in the last column already
            // names the form, but doesn't stand out as a distinct DAY TYPE the way the holiday/
            // rest-day tags above it do, so a half day was easy to miss at a glance.
            const hdLink = (d._links || []).find((l) => l.slug === 'halfday_request' && isApprovedLink(l));
            const halfDayTag = hdLink
              ? `<span class="badge-pill status-confirmed" title="Judged against just this half's own AM/PM window, not the full shift">Half Day${hdLink.session ? ` (${hdLink.session.startsWith('After') ? 'PM' : 'AM'})` : ''}</span>`
              : d.half_day_override
                ? `<span class="badge-pill status-confirmed" title="HR manually credited this day a half day — no Half Day request filed">Half Day (${d.half_day_override.toUpperCase()}, unauthorized)</span>`
                : '';
            const tag = effHoliday
              ? `<span class="badge-pill ${isCancellation ? 'status-cancelled' : 'status-completed'}" title="${isCancellation ? 'Not worked — credited as a paid/unpaid day per the selection, no premium' : 'Pays the DOLE premium automatically'}">${UI.esc(HOLIDAY_LABELS[effHoliday] || effHoliday)}</span>`
              : noWork
                ? `<span class="badge-pill ${noWork === 'paid' ? 'status-completed' : 'status-cancelled'}" title="Company-wide No Work Memo — ${noWork === 'paid' ? 'credited as a paid day' : 'unpaid, same as an absence but documented'}">No Work (${noWork === 'paid' ? 'Paid' : 'Unpaid'})</span>`
                : isRestDay
                  ? `<span class="badge-pill status-confirmed" title="${movedRestDay ? 'Moved here by an approved Change of Rest Day. ' : ''}${policy.require_rest_day_form ? 'Pays +30% if worked, with an approved Rest Day Work Request linked' : 'Pays +30% automatically if worked'}">Rest Day${movedRestDay ? ' (moved)' : ''}</span>`
                  : movedRestDay
                    ? `<span class="badge-pill muted" title="Usual rest day, moved away by an approved Change of Rest Day — judged as an ordinary working day">Rest Day Moved</span>${halfDayTag ? ` ${halfDayTag}` : ''}`
                    : halfDayTag;
            return `
            <tr data-row="${i}" class="${incomplete ? 'tk-incomplete' : ''}" ${incomplete ? 'title="Incomplete — only one of time in/out is set"' : ''}>
              <td>${UI.esc(d.work_date)}${tag ? `<div style="margin-top:3px">${tag}</div>` : ''}<div data-min-flag="${i}">${minFlagHtml(d, i)}</div><div data-halfday-flag-cell="${i}">${halfDayFlagHtml(d, i)}</div><div data-restday-flag-cell="${i}">${restDayFlagHtml(d, i)}</div></td>
              <td><select data-k="shift_id">${shiftOptions(d.shift_id)}</select></td>
              <td><div class="tk-time-cell"><input data-k="time_in" type="text" inputmode="numeric" autocomplete="off" placeholder="--:-- --" value="${UI.esc(fmtTimeDisplay(d.time_in))}" />${photoBtnHtml(d.photos && d.photos.time_in)}</div></td>
              <td><div class="tk-time-cell"><input data-k="lunch_out" type="text" inputmode="numeric" autocomplete="off" placeholder="--:-- --" value="${UI.esc(fmtTimeDisplay(d.lunch_out))}" title="Start of the unpaid lunch break — for the record only; payroll still deducts the fixed lunch minutes" />${photoBtnHtml(d.photos && d.photos.lunch_out)}</div></td>
              <td><div class="tk-time-cell"><input data-k="lunch_in" type="text" inputmode="numeric" autocomplete="off" placeholder="--:-- --" value="${UI.esc(fmtTimeDisplay(d.lunch_in))}" title="Back from lunch — for the record only; payroll still deducts the fixed lunch minutes" />${photoBtnHtml(d.photos && d.photos.lunch_in)}</div></td>
              <td><div class="tk-time-cell"><input data-k="time_out" type="text" inputmode="numeric" autocomplete="off" placeholder="--:-- --" value="${UI.esc(fmtTimeDisplay(d.time_out))}" />${photoBtnHtml(d.photos && d.photos.time_out)}</div></td>
              <td><select data-k="holiday_type" title="Default inherits the Company Holidays calendar. Work Cancellation is a per-employee paid/unpaid excused day (equipment failure, sent home early, etc.) — the one-employee version of a company-wide No Work Memo.">${dayTypeOptions(d.holiday_type)}</select></td>
              <td><select data-k="half_day_override" title="HR's own call that this day counts as a half day (0.5 day, judged against just that AM/PM window) even though no Half Day request is filed — for a day the automatic Possible Half Day check doesn't happen to catch. Ignored if a real Half Day request is linked below.">${halfDayOverrideOptions(d.half_day_override)}</select></td>
              <td><select data-k="rest_day" title="Override this one day/employee — leave at Default to inherit the weekly rest-day pattern. Use for a rest day that moves week to week.">${restDayOptions(d.rest_day)}</select></td>
              <td><input data-k="notes" value="${UI.esc(d.notes || '')}" placeholder="optional" /></td>
              <td>
                ${(d._links || []).map((l, li) => `<span class="badge-pill" data-unlink="${i}" data-unlink-idx="${li}" title="Click to unlink" style="cursor:pointer;margin:1px 2px 1px 0;display:inline-block">${UI.esc(l.label)}${l.slug !== 'reported_absence' && !isApprovedLink(l) ? ` · ${UI.esc(l.status || 'pending')}` : ''} ✕</span>`).join('')}
                <button type="button" class="icon-btn" data-link="${i}" title="Link or create an OT/Half Day/Leave/Undertime/Offset/Reported/Rest Day form — a day can have more than one">${UI.icon('plus', 14)}</button>
              </td>
            </tr>`;
          }).join('');
          body.querySelectorAll('[data-photo-url]').forEach((b) => b.addEventListener('click', () => openPunchPhoto(b.dataset.photoUrl)));
          if (!canManage) {
            body.querySelectorAll('input, select, textarea').forEach((field) => { field.disabled = true; });
            body.querySelectorAll('button:not([data-photo-url])').forEach((button) => { button.hidden = true; });
            body.querySelectorAll('[data-unlink]').forEach((badge) => {
              badge.removeAttribute('data-unlink');
              badge.removeAttribute('title');
              badge.style.cursor = 'default';
              badge.textContent = badge.textContent.replace(/ ×$/, '');
            });
            return; // Do not attach mutation handlers; photo inspection remains available.
          }
          body.querySelectorAll('input[data-k], select[data-k]').forEach((inp) => {
            if (TIME_KEYS.includes(inp.dataset.k)) { wireTimeInput(inp); return; }
            const evt = inp.tagName === 'SELECT' ? 'change' : 'input';
            inp.addEventListener(evt, () => {
              const row = Number(inp.closest('[data-row]').dataset.row);
              days[row][inp.dataset.k] = inp.value;
              if (inp.dataset.k === 'holiday_type' || inp.dataset.k === 'rest_day' || inp.dataset.k === 'half_day_override') renderRows(); // refresh the tag next to the date, and the Possible Half Day? nudge
            });
          });
          body.querySelectorAll('[data-min-allow]').forEach((b) => b.onclick = () => {
            days[Number(b.dataset.minAllow)].min_hours_decision = 'allow';
            renderMinFlag(Number(b.dataset.minAllow));
          });
          body.querySelectorAll('[data-min-deny]').forEach((b) => b.onclick = () => {
            days[Number(b.dataset.minDeny)].min_hours_decision = 'deny';
            renderMinFlag(Number(b.dataset.minDeny));
          });
          body.querySelectorAll('[data-halfday-flag]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.halfdayFlag)));
          body.querySelectorAll('[data-restday-flag]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.restdayFlag)));
          body.querySelectorAll('[data-link]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.link)));
          body.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = () => {
            const i = Number(b.dataset.unlink);
            const li = Number(b.dataset.unlinkIdx);
            days[i]._links.splice(li, 1);
            days[i]._formIds = days[i]._links.map((l) => l.id);
            renderRows();
          });
        }

        async function linkFormModal(rowIndex) {
          const day = days[rowIndex];
          const defs = await API.get('/form-definitions').catch(e => { UI.toast('Couldn’t load HR forms: '+e.message,'error'); return []; });
          const relevant = defs.filter((f) => FORM_LINK_SLUGS.includes(f.slug));
          const [lists, linkedIds] = await Promise.all([
            Promise.all(relevant.map((f) => API.get(`/form-definitions/${f.id}/records`).catch(() => []))),
            API.get('/hr/linked-form-record-ids').catch(() => []),
          ]);
          // A form record is "already used" if it's linked to any attendance day system-wide
          // (linkedIds, from the server) OR to any day in THIS grid that hasn't been saved yet
          // (days[]._formIds). Either way it shouldn't be offered again.
          const used = new Set(linkedIds);
          days.forEach((dd) => (dd._formIds || []).forEach((id) => used.add(id)));
          const options = [];
          relevant.forEach((f, fi) => {
            (lists[fi] || []).forEach((r) => {
              const name = (r.data && r.data.employee_name) || '';
              if (String(name).trim() === String(rosterRow.name).trim() && !used.has(r.id)) {
                options.push({ form: f, record: r });
              }
            });
          });

          const typeOpts = MAKE_FORM_TYPES.filter(t => defs.some(def => def.slug === t.slug)).map((t) => `<option value="${t.slug}">${UI.esc(t.label)}</option>`).join('');
          const m2 = UI.modal({
            title: `Link a form — ${rosterRow.name} · ${day.work_date}`,
            headActionHTML: `<button type="button" class="btn secondary small" id="tk-link-goto">${UI.icon('forms', 14)} Data Forms</button>`,
            bodyHTML: `
              <div style="font-weight:600;margin-bottom:6px">Link an existing form</div>
              ${options.length
                ? `<div class="var-pick-list">${options.map((o, i) => `
                    <button type="button" class="var-pick" data-pick="${i}">
                      <span>${UI.esc(o.form.name)} — ${UI.esc(o.record.number)}</span>
                      <span class="muted">${UI.esc(o.record.status)}</span>
                    </button>`).join('')}</div>`
                : `<p class="muted" style="font-size:12.5px;margin:2px 0">No unlinked OT/Half Day/Leave/Undertime/Offset/Reported/Rest Day records for ${UI.esc(rosterRow.name)}.</p>`}
              <hr style="margin:14px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
              <div style="font-weight:600;margin-bottom:2px">Make a new form</div>
              <p class="muted" style="font-size:12px;margin:2px 0 8px">Filed for ${UI.esc(rosterRow.name)} on ${day.work_date} and linked to this day. Requests stay pending until approved. Leave here covers this day only (1 day).</p>
              <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
                <div><label style="font-size:12px">Type</label><select id="mf-type"><option value="">Choose…</option>${typeOpts}</select></div>
              </div>
              <div id="mf-fields" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"></div>
              <button type="button" class="btn small" id="mf-create" style="margin-top:12px" disabled>Create &amp; link</button>
              <p id="mf-err" class="muted" style="color:var(--danger,#c0392b);font-size:12px;margin:6px 0 0"></p>`,
            cancelText: 'Close',
            onOpen: (ov2) => {
              ov2.querySelector('#tk-link-goto').onclick = () => App.navigate('form-records');
              ov2.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
                const o = options[Number(b.dataset.pick)];
                day._formIds.push(o.record.id);
                ov.__markDirty?.();
                day._links.push({ id: o.record.id, label: `${o.form.name} ${o.record.number}`, slug: o.form.slug, session: (o.record.data && o.record.data.session) || null, status: o.record.status, data: o.record.data || {} });
                m2.close();
                renderRows();
              });

              const typeSel = ov2.querySelector('#mf-type');
              const fieldsEl = ov2.querySelector('#mf-fields');
              const createBtn = ov2.querySelector('#mf-create');
              const errEl = ov2.querySelector('#mf-err');
              typeSel.onchange = () => {
                const t = MAKE_FORM_TYPES.find((x) => x.slug === typeSel.value);
                errEl.textContent = '';
                if (!t) { fieldsEl.innerHTML = ''; createBtn.disabled = true; return; }
                createBtn.disabled = !App.hasPermission('forms.manage.hr');
                if (createBtn.disabled) errEl.textContent = 'Creating HR forms requires HR form-management access.';
                // Overtime: offer Early OT only when this day's time-in is 1 h+ before the shift
                // start; the hint below re-computes as the tick / approved hours change.
                const earlyMin = t.detectOt ? earlyMinutesFor(day) : 0;
                const earlyHtml = earlyMin >= EARLY_OT_MIN_MINUTES
                  ? `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;flex-basis:100%;font-weight:normal">
                      <input type="checkbox" id="mf-early-ot" style="width:auto" />
                      Early OT — count the ${earlyMin % 60 ? (earlyMin / 60).toFixed(2) : earlyMin / 60} h before the shift start (timed in ${UI.esc(day.time_in)})
                    </label>`
                  : '';
                const hintHtml = t.detectOt
                  ? `<p class="muted" id="mf-ot-hint" style="font-size:12.5px;margin:2px 0;flex-basis:100%">${UI.esc(detectedOtText(day))}</p>${earlyHtml}`
                  : '';
                fieldsEl.innerHTML = hintHtml + t.fields.map((f) => {
                  const lbl = `<label style="font-size:12px">${UI.esc(f.label)}${f.required ? ' *' : ''}</label>`;
                  if (f.type === 'select' || f.type === 'employee') {
                    return `<div>${lbl}<select data-mf="${f.key}"><option value="">—</option>${(f.options || []).map((o) => { const value = typeof o === 'object' ? o.value || o.id || o.label || o.name : o; const label = typeof o === 'object' ? o.label || o.name || value : o; return `<option value="${UI.esc(String(value))}">${UI.esc(String(label))}</option>`; }).join('')}</select></div>`;
                  }
                  if (f.type === 'textarea') return `<div style="flex-basis:100%">${lbl}<textarea data-mf="${f.key}" rows="3"></textarea></div>`;
                  if (f.type === 'checkbox') return `<div>${lbl}<input type="checkbox" data-mf="${f.key}" style="width:auto" /></div>`;
                  const inputType = f.type === 'number' ? 'number' : f.type === 'time' ? 'time' : f.type === 'date' ? 'date' : 'text';
                  return `<div>${lbl}<input type="${inputType}" data-mf="${f.key}" ${f.type === 'number' ? 'min="0" step="0.5"' : ''} /></div>`;
                }).join('');
                t.fields.forEach(f => { const el = fieldsEl.querySelector(`[data-mf="${f.key}"]`); if (el && f.default != null && f.default !== '') { if (el.type === 'checkbox') el.checked = f.default === true || f.default === 'Yes'; else el.value = f.default; } });
                if (t.detectOt) {
                  const earlyBox = fieldsEl.querySelector('#mf-early-ot');
                  const approvedInp = fieldsEl.querySelector('[data-mf="approved_hours"]');
                  const refreshHint = () => {
                    fieldsEl.querySelector('#mf-ot-hint').textContent = detectedOtText(day, {
                      early: !!(earlyBox && earlyBox.checked), approvedHours: approvedInp ? approvedInp.value : '',
                    });
                  };
                  if (earlyBox) earlyBox.onchange = refreshHint;
                  if (approvedInp) approvedInp.oninput = refreshHint;
                }
              };

              createBtn.onclick = async () => {
                const t = MAKE_FORM_TYPES.find((x) => x.slug === typeSel.value);
                if (!t) return;
                const def = defs.find((d) => d.slug === t.slug);
                if (!def) { errEl.textContent = `The "${t.label}" form isn't set up in Data Forms.`; return; }
                const data = {
                  employee_id: employeeId,
                  employee_name: rosterRow.name,
                  employee_no: rosterRow.employee_no || '',
                  position: rosterRow.position || '',
                  department: rosterRow.department_name || rosterRow.department || '',
                };
                data[t.dateKey] = day.work_date;
                if (t.slug === 'leave_request') { data.date_to = day.work_date; data.days = 1; }
                for (const f of t.fields) {
                  const el = ov2.querySelector(`[data-mf="${f.key}"]`);
                  const v = el ? (el.type === 'checkbox' ? (el.checked ? 'Yes' : 'No') : el.value.trim()) : '';
                  if (f.required && !v) { errEl.textContent = `${f.label} is required.`; return; }
                  if (v && f.type === 'number' && !Number.isFinite(Number(v))) { errEl.textContent = `${f.label} must be a valid number.`; return; }
                  if (v) data[f.key] = f.type === 'number' ? Number(v) : v;
                }
                // Early OT tick (only rendered on a day timed in 1 h+ early) — read by payroll.
                const earlyBox = ov2.querySelector('#mf-early-ot');
                if (t.slug === 'overtime_request') data.early_ot = !!(earlyBox && earlyBox.checked);
                // Leave: the payroll engine treats a leave day as paid only when with_pay==='Yes'
                // — infer it from the leave type so a leave made here computes correctly.
                if (t.slug === 'leave_request') data.with_pay = data.leave_type === 'Unpaid Leave' ? 'No' : (data.with_pay || 'Yes');
                if (t.slug === 'rest_day_change' && data.new_rest_day === data.original_rest_day) {
                  errEl.textContent = 'The new rest day must be a different date.'; return;
                }
                createBtn.disabled = true;
                try {
                  const status = def.slug === 'reported_absence' ? 'approved' : 'pending';
                  const res = await API.post('/form-records', { form_def_id: def.id, data, status });
                  day._formIds.push(res.id);
                  ov.__markDirty?.();
                  day._links.push({ id: res.id, label: `${def.name} ${res.number || ''}`.trim(), slug: def.slug, session: data.session || null, status, data });
                  UI.toast(`${def.name} ${res.number || ''} created — save Daily Time to keep the link${['leave_request','overtime_request','undertime_request','halfday_request','offset_form','lunch_offset_form','holiday_work_request','rest_day_work_request','rest_day_change'].includes(def.slug) ? ' — pending approval' : ''}`);
                  m2.close();
                  renderRows();
                } catch (err) {
                  createBtn.disabled = false;
                  errEl.textContent = err.message || 'Could not create the form.';
                }
              };
            },
          });
        }

        // Resolve a readable label + slug/session for every linked form (the GET returns bare
        // ids in _formIds — fetch each once to show "Overtime Request OT-00003" etc., and so
        // renderRows can put an explicit "Half Day (AM/PM)" identifier next to the date).
        Promise.all(days.map(async (d) => {
          d._links = [];
          for (const id of d._formIds) {
            try {
              const r = await API.get('/form-records/' + id);
              d._links.push({ id, label: `${r.form_name || 'Form'} ${r.number || ''}`.trim(), slug: r.form_slug || null, session: (r.data && r.data.session) || null, status: r.status, data: r.data || {} });
            } catch { d._links.push({ id, label: 'Linked', slug: null, session: null, status: null, data: null }); }
          }
        })).then(renderRows);
        renderRows();
      },
      onConfirm: async () => {
        if (!canManage) return;
        await API.put(`/hr/periods/${periodId}/attendance`, {
          employee_id: employeeId,
          days: days.map((d) => ({
            work_date: d.work_date, time_in: d.time_in || '', time_out: d.time_out || '',
            lunch_out: d.lunch_out || '', lunch_in: d.lunch_in || '', notes: d.notes || '',
            shift_id: d.shift_id || null,
            form_record_ids: d._formIds || [],
            form_record_id: (d._formIds && d._formIds[0]) || null, // legacy mirror
            holiday_type: d.holiday_type || null, rest_day: d.rest_day || null,
            min_hours_decision: d.min_hours_decision || null,
            half_day_override: d.half_day_override || null,
          })),
        });
        UI.toast('Attendance saved');
        reload();
      },
    });
  }

  /* ---- Generate payslips ---- */
  function generateModal() {
    UI.modal({
      title: 'Generate payslips',
      bodyHTML: `
        ${(period.warnings || []).length ? `<div role="status"><strong>Warnings — you can still generate</strong><ul>${period.warnings.map(w => `<li>${UI.esc(w)}</li>`).join('')}</ul></div>` : ''}
        <p class="muted" style="margin-top:0">Creates or updates one HR Payroll record per employee on this cutoff — days worked,
          late deductions, and OT/Holiday pay are computed automatically from the daily log and any linked forms (per the
          Policy Settings rules). Statutory deductions (SSS/PhilHealth/Pag-IBIG), cash advances, and net pay still need your review —
          re-running this after editing attendance safely refreshes the computed fields without touching those.</p>
        <div><label>Payroll period label</label><input data-f="payroll_period" value="${UI.esc(period.label)}" /></div>
        <div style="margin-top:10px"><label>Pay date</label><input data-f="pay_date" type="date" /></div>`,
      confirmText: 'Generate',
      onConfirm: async (ov, showErr) => {
        const payroll_period = ov.querySelector('[data-f="payroll_period"]').value.trim();
        if (!payroll_period) { showErr('Payroll period label is required'); return false; }
        const pay_date = ov.querySelector('[data-f="pay_date"]').value;
        const res = await API.post(`/hr/periods/${periodId}/generate-payslips`, { payroll_period, pay_date });
        lastPayrollPeriod = payroll_period;
        UI.toast(`Payslips ready: ${res.created} created, ${res.updated} updated`);
        // Active nudge, not just something HR happens to notice by opening a specific payslip —
        // a day whose raw times look like a half day but has no linked Half Day request is now
        // paid as a half day automatically — this nudge is just so HR files the actual request
        // for the record. Click-through goes straight to the payroll list, where each flagged
        // payslip's own detail view names the exact day(s).
        const halfDayWarning = res.possible_half_day_employees
          ? `<p class="muted" style="color:var(--warn)">⚠ ${res.possible_half_day_employees} employee${res.possible_half_day_employees === 1 ? '' : 's'} ha${res.possible_half_day_employees === 1 ? 's' : 've'} at least one day paid as a half day off its times alone (no Half Day request linked) — open a payslip below to see which day(s), or file the request on the Daily Time grid.</p>`
          : '';
        UI.modal({
          title: 'Payslips ready',
          bodyHTML: `<p>${res.created} created, ${res.updated} updated for "${UI.esc(res.period)}".</p>
            <p class="muted">Fill in hours/earnings/deductions there, then use the existing Print flow.</p>
            ${halfDayWarning}
            ${res.skipped_locked ? `<p>${res.skipped_locked} paid payslip(s) were left unchanged.</p>` : ''}
            ${(res.warnings || []).length ? `<div role="status"><strong>Review warnings</strong><ul>${res.warnings.map(w => `<li>${UI.esc(w)}</li>`).join('')}</ul></div>` : ''}`,
          confirmText: 'Open Payroll',
          onConfirm: () => { App.navigate('form-records', { form_id: res.form_id, slug: 'hr_payroll', period: res.period }); },
        });
      },
    });
  }

  function postGlModal() {
    UI.modal({
      title: 'Post payroll to the General Ledger',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Books this cutoff's generated payslips as one aggregate journal entry
          (Salaries & Wages, statutory payables, Net Pay Payable). Posting again after a regenerate reverses the
          previous entry first and posts fresh with the current numbers — safe to re-run.</p>
        <div><label>Payroll period label</label><input data-f="payroll_period" value="${UI.esc(lastPayrollPeriod)}" /></div>`,
      confirmText: 'Post to GL',
      onConfirm: async (ov, showErr) => {
        const payroll_period = ov.querySelector('[data-f="payroll_period"]').value.trim();
        if (!payroll_period) { showErr('Payroll period label is required'); return false; }
        const res = await API.post(`/hr/periods/${periodId}/post-payroll-gl`, { payroll_period });
        UI.toast(`Posted to GL — journal entry ${res.entry ? res.entry.number : ''}`.trim());
      },
    });
  }

  renderRoster();

  // Deep-link straight into one employee's Daily Time modal (see the module comment's
  // filter.employee_id note) — opened once, right after the roster itself is on screen, not
  // instead of it (so Back/closing the modal still lands somewhere useful).
  if (initialEmployeeId) {
    const row = (period.roster || []).find((r) => r.employee_id === initialEmployeeId);
    if (row) dailyGridModal(row);
  }
}

// Opens one employee's Daily Time modal for a cutoff WITHOUT navigating to the Time Keeping
// tab at all — no App.navigate, no URL/nav-highlight change, whatever page the caller is on
// stays exactly as it is. Reuses renderPeriod's own setup (period/shift/policy fetch, roster
// resolution, dailyGridModal itself — all of it, unmodified) by running it against a plain
// <div> that's never attached to the document; UI.modal() always renders into the global
// #modal-root regardless of where it's invoked from, so the modal still shows up normally
// while renderPeriod's own (invisible) roster markup just sits in a detached, harmless
// scratch element. Used by the HR Overview "Needs Attention" panel — see hr.js.
async function openEmployeeDailyGrid(periodId, employeeId) {
  const scratch = document.createElement('div');
  await renderPeriod(scratch, periodId, employeeId);
}
window.HrTimekeeping = { openEmployeeDailyGrid };
