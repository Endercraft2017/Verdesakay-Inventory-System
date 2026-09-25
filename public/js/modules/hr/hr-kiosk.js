/* Time-in Kiosk — runs on the office monitor beside the guard.
   A live camera preview fills the center of the screen (a snapshot is captured and uploaded
   on every punch — see src/punch-photos.ts), with the rotating QR (employees scan it from the
   mobile app) as a small badge in its bottom-left corner. Phone-less staff can also just type
   their employee number, and every punch plays a distinct chime + speaks the name.

   Two tabs share this screen: "Time In / Time Out" (the payroll clock, unchanged) and
   "Field Work" — a separate out/in log for staff on deliveries/site visits/errands, kept
   in its own table (field_punches) so it never touches payroll hours. The QR only ever
   proves attendance (a phone scan always hits the regular clock endpoint), so its badge is
   hidden while on the Field Work tab; Field Work is guard-typed, same as the "no phone"
   fallback — the camera keeps running and capturing on both tabs.

   On an internet-facing server the kiosk only runs on a PC an HR manager approved
   (src/modules/hr/kiosk-devices.ts); an unapproved browser gets the approval screen instead. */
App.register('hr-kiosk', async (view) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }

  // Kiosk lock (src/modules/hr/kiosk-devices.ts): on an internet-facing server the kiosk — its
  // QR and typed employee numbers — only runs on office PCs an HR manager approved once.
  let kioskInfo = null;
  try { kioskInfo = await API.get('/hr/clock/kiosk-devices'); } catch (e) { /* show the kiosk; the server still guards it */ }
  if (kioskInfo && kioskInfo.lock_active && !kioskInfo.this_device) {
    const canApprove = App.hasPermission('hr.manage');
    view.innerHTML = `
      <div class="panel" style="max-width:600px;margin:40px auto;padding:24px">
        <h2 style="margin-top:0">This screen isn't an approved time-in kiosk</h2>
        <p class="muted">The system can be reached from the internet, so the kiosk (its QR code and typing an
          employee number) only runs on office PCs an HR manager has approved. That stops anyone clocking
          people in from home.</p>
        ${canApprove ? `
          <label>Name this kiosk</label>
          <input id="kg-name" value="Front desk PC" maxlength="60" />
          <button type="button" class="btn" id="kg-approve" style="margin-top:12px">Approve this PC as a kiosk</button>
          <p class="muted" style="font-size:12px;margin-top:8px">Only do this on the office PC that will run the
            kiosk. You can revoke it any time in Time Keeping → Policy Settings → Kiosk devices.</p>
          <div class="form-error hidden" id="kg-err"></div>`
        : '<p>Ask an HR manager to sign in on this PC once and approve it as a kiosk.</p>'}
      </div>`;
    const btn = view.querySelector('#kg-approve');
    if (btn) btn.onclick = async () => {
      const errEl = view.querySelector('#kg-err');
      btn.disabled = true;
      try {
        const r = await API.post('/hr/clock/kiosk-devices', { name: view.querySelector('#kg-name').value.trim() });
        localStorage.setItem('vds_kiosk_token', r.token);
        UI.toast('This PC is now an approved kiosk');
        location.reload();
      } catch (e) {
        errEl.textContent = e.message || 'Could not approve this PC';
        errEl.classList.remove('hidden');
        btn.disabled = false;
      }
    };
    return;
  }

  // Load the QR encoder (shared with the mobile app) once.
  if (!window.qrcode) {
    await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/mobile/vendor/qrcode.js';
      s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  view.innerHTML = `
    <div class="kiosk">
      <div class="kiosk-main">
        <div class="subnav kiosk-tabs">
          <button type="button" class="subtab active" data-mode="attendance">Time In / Time Out</button>
          <button type="button" class="subtab" data-mode="field">Field Work</button>
        </div>

        <div class="kiosk-visual">
          <video id="kiosk-cam" class="kiosk-cam" autoplay muted playsinline></video>
          <div id="kiosk-cam-placeholder" class="kiosk-cam-placeholder hidden">Camera unavailable</div>
          <div id="kiosk-qr-mini" class="kiosk-qr-mini">
            <div class="kiosk-qr" id="kiosk-qr"></div>
          </div>
        </div>
        <canvas id="kiosk-cam-canvas" class="hidden"></canvas>

        <div id="kiosk-panel-attendance" class="kiosk-panel">
          <h2>Time In / Time Out</h2>
          <div class="kiosk-count"><span id="kiosk-secs">–</span>s · new code each minute</div>
          <div class="kiosk-hint">Scan with the Verdesakay app. No phone? Enter your number below.</div>
          <div id="kiosk-correction" class="kiosk-correction hidden"></div>
          <form id="kiosk-form-attendance" class="kiosk-form" autocomplete="off">
            <input id="kiosk-no" placeholder="Employee number" />
            <button class="btn" type="submit">Punch</button>
          </form>
          <div id="kiosk-msg-attendance" class="kiosk-msg"></div>
        </div>

        <div id="kiosk-panel-field" class="kiosk-panel hidden">
          <h2>Field Work</h2>
          <div class="kiosk-hint">For staff heading out on field work — deliveries, site visits, errands. Enter the employee's number both when they head out and when they're back.</div>
          <form id="kiosk-form-field" class="kiosk-form" autocomplete="off">
            <input id="kiosk-field-no" placeholder="Employee number" />
            <button class="btn" type="submit">Log Out / In</button>
          </form>
          <div id="kiosk-msg-field" class="kiosk-msg"></div>
        </div>
      </div>
      <div class="kiosk-side">
        <div id="kiosk-last" class="kiosk-last empty">
          <div class="kiosk-last-label">Last punch</div>
          <div class="kiosk-last-name">–</div>
        </div>
        <div class="kiosk-side-head">
          <h3>Recent</h3>
          <button type="button" class="icon-btn" id="kiosk-settings-btn" title="Kiosk settings">${UI.icon('settings')}</button>
        </div>
        <div id="kiosk-log" class="kiosk-rows"></div>
      </div>
    </div>`;

  const kioskRoot = view.querySelector('.kiosk');
  const qrBox = view.querySelector('#kiosk-qr');
  const qrMini = view.querySelector('#kiosk-qr-mini');
  const secsEl = view.querySelector('#kiosk-secs');
  const logEl = view.querySelector('#kiosk-log');
  const lastEl = view.querySelector('#kiosk-last');
  const tabs = view.querySelectorAll('.kiosk-tabs .subtab');
  const panels = { attendance: view.querySelector('#kiosk-panel-attendance'), field: view.querySelector('#kiosk-panel-field') };

  // Camera: captures a snapshot of whoever's punching, uploaded (best-effort, never blocks
  // the punch itself) right after a successful punch/correction. The QR only proves
  // attendance, so its mini badge is hidden while on the Field Work tab (see switchMode).
  const camVideo = view.querySelector('#kiosk-cam');
  const camPlaceholder = view.querySelector('#kiosk-cam-placeholder');
  const camCanvas = view.querySelector('#kiosk-cam-canvas');
  let camStream = null, cameraReady = false;

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camPlaceholder.textContent = 'Camera not supported on this device.';
      camPlaceholder.classList.remove('hidden');
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      camVideo.srcObject = camStream;
      camVideo.addEventListener('loadedmetadata', () => { cameraReady = true; }, { once: true });
    } catch (e) {
      camPlaceholder.textContent = 'Camera unavailable — check permissions.';
      camPlaceholder.classList.remove('hidden');
    }
  }
  startCamera();

  function capturePhotoBlob() {
    return new Promise((resolve) => {
      if (!cameraReady || !camVideo.videoWidth) { resolve(null); return; }
      const targetW = 480;
      const scale = Math.min(1, targetW / camVideo.videoWidth);
      const w = Math.round(camVideo.videoWidth * scale);
      const h = Math.round(camVideo.videoHeight * scale);
      camCanvas.width = w; camCanvas.height = h;
      const ctx = camCanvas.getContext('2d');
      ctx.drawImage(camVideo, 0, 0, w, h);
      camCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.6);
    });
  }

  // Fire-and-forget: a failed/slow photo upload must never affect the punch it's attached to.
  async function capturePunchPhoto(punchKind, punchId) {
    try {
      const blob = await capturePhotoBlob();
      if (!blob) return;
      const fd = new FormData();
      fd.append('photo', blob, 'punch.jpg');
      await API.upload(`/hr/${punchKind === 'field' ? 'field' : 'clock'}/photo/${punchId}`, fd);
    } catch (e) { /* best-effort only */ }
  }

  let speakNames = true;
  let chimeEnabled = true;
  let voiceURI = null;
  try { speakNames = localStorage.getItem('kiosk.speakNames') !== '0'; } catch (e) { /* ignore */ }
  try { chimeEnabled = localStorage.getItem('kiosk.chime') !== '0'; } catch (e) { /* ignore */ }
  try { voiceURI = localStorage.getItem('kiosk.voiceURI') || null; } catch (e) { /* ignore */ }

  function currentVoice() {
    if (!voiceURI || !window.speechSynthesis) return null;
    return speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI) || null;
  }

  // Chrome/Edge load voices asynchronously — getVoices() can come back empty the first time,
  // so (re)populate whenever the list is actually ready, not just once on modal open.
  function populateVoiceSelect(selectEl) {
    const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    selectEl.innerHTML = '<option value="">Default</option>' +
      voices.map((v) => `<option value="${UI.esc(v.voiceURI)}">${UI.esc(v.name)} (${UI.esc(v.lang)})</option>`).join('');
    selectEl.value = voices.some((v) => v.voiceURI === voiceURI) ? voiceURI : '';
  }

  view.querySelector('#kiosk-settings-btn').addEventListener('click', () => {
    const m = UI.modal({
      title: 'Kiosk Settings',
      cancelText: 'Close',
      bodyHTML: `
        <div class="kiosk-settings">
          <label class="kiosk-settings-row">
            <div>
              <div class="kiosk-settings-label">Chime on punch</div>
              <div class="kiosk-settings-hint">Play a short tone after each punch — time in, lunch, and time out each get their own tone.</div>
            </div>
            <input type="checkbox" id="kiosk-chime-modal" ${chimeEnabled ? 'checked' : ''} />
          </label>
          <label class="kiosk-settings-row">
            <div>
              <div class="kiosk-settings-label">Speak names</div>
              <div class="kiosk-settings-hint">Announce the employee's name out loud after a punch.</div>
            </div>
            <input type="checkbox" id="kiosk-speak-modal" ${speakNames ? 'checked' : ''} />
          </label>
          <div class="kiosk-settings-row">
            <div>
              <div class="kiosk-settings-label">Voice</div>
              <div class="kiosk-settings-hint">Which voice reads the employee's name aloud.</div>
            </div>
            <select id="kiosk-voice-modal"></select>
          </div>
        </div>`,
    });
    m.overlay.querySelector('#kiosk-chime-modal').addEventListener('change', (e) => {
      chimeEnabled = e.target.checked;
      try { localStorage.setItem('kiosk.chime', chimeEnabled ? '1' : '0'); } catch (err) { /* ignore */ }
    });
    m.overlay.querySelector('#kiosk-speak-modal').addEventListener('change', (e) => {
      speakNames = e.target.checked;
      try { localStorage.setItem('kiosk.speakNames', speakNames ? '1' : '0'); } catch (err) { /* ignore */ }
    });
    const voiceSel = m.overlay.querySelector('#kiosk-voice-modal');
    populateVoiceSelect(voiceSel);
    if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', () => populateVoiceSelect(voiceSel), { once: true });
    voiceSel.addEventListener('change', (e) => {
      voiceURI = e.target.value || null;
      try {
        if (voiceURI) localStorage.setItem('kiosk.voiceURI', voiceURI);
        else localStorage.removeItem('kiosk.voiceURI');
      } catch (err) { /* ignore */ }
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance('This is how names will sound.');
        const v = currentVoice();
        if (v) u.voice = v;
        try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (err) { /* ignore */ }
      }
    });
  });

  let mode = 'attendance';
  let curCode = null, secsLeft = 0, timer = null, poll = null;
  const lastSeenId = { attendance: 0, field: 0 };
  // Click-to-fix: tapping a slot on someone's attendance row arms a correction (the actual
  // employee then has to type their own number to confirm it's them before it's applied) —
  // for a mistake (wrong slot filled), a slot that never got punched, or logging more time
  // (e.g. OT) once the day's final Out has already happened.
  let pendingCorrection = null; // { employee_no, name, slot }
  const correctionEl = view.querySelector('#kiosk-correction');
  // Per-tab state: rows keyed by employee name, in last-touched order (oldest..newest), plus
  // the most recent event of that type (shown quietly on load / on switching tabs).
  const state = {
    attendance: { rows: new Map(), last: null },
    field: { rows: new Map(), last: null },
  };

  /* ---- audio: a short distinct jingle per kind of event ---- */
  const SEG = {
    morning_in:   { seq: [523, 659, 784, 1047], word: 'Good morning' },
    first_in:     { seq: [523, 659, 784, 1047], word: 'Welcome' },
    afternoon_in: { seq: [523, 784],            word: 'Welcome back' },
    lunch_out:    { seq: [659, 494],            word: 'Lunch break' },
    afternoon_out:{ seq: [784, 659, 523, 392],  word: 'Goodbye' },
    other_in:     { seq: [523, 784],            word: 'Time in' },
    other_out:    { seq: [784, 523],            word: 'Time out' },
  };
  const FIELD_SEG = {
    out: { seq: [392, 330, 262], word: 'Heading out to the field' },
    in:  { seq: [523, 659, 784], word: 'Back from the field' },
  };
  let ac = null;
  function tone(seq, opts) {
    const gain = (opts && opts.gain) || 0.3;
    const type = (opts && opts.type) || 'sine';
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      seq.forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type; o.frequency.value = f;
        o.connect(g); g.connect(ac.destination);
        const t = ac.currentTime + i * 0.14;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t); o.stop(t + 0.25);
      });
    } catch (e) { /* ignore */ }
  }
  // Louder and harsher than the punch chimes (square wave carries more than sine at the same
  // gain) so a rejected/failed punch is unmistakable even across the room.
  function errorBuzz() { tone([196, 165, 196], { gain: 0.65, type: 'square' }); }
  // `wasFirstIn` disambiguates 'afternoon_in': it means either the day's very first time-in
  // (if it happens after noon) or a return from lunch — only the latter should say "Welcome back".
  function announce(kind, p, wasFirstIn) {
    let key = kind === 'field' ? p.kind : p.segment;
    if (kind === 'attendance' && key === 'afternoon_in' && wasFirstIn) key = 'first_in';
    const s = kind === 'field' ? (FIELD_SEG[key] || FIELD_SEG.out) : (SEG[key] || SEG.other_in);
    if (chimeEnabled) tone(s.seq);
    if (speakNames && window.speechSynthesis) {
      const first = (p.name || '').split(' ')[0];
      const u = new SpeechSynthesisUtterance(`${s.word}${first ? ', ' + first : ''}`);
      u.rate = 1; u.volume = 1;
      const v = currentVoice();
      if (v) u.voice = v;
      try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* ignore */ }
    }
  }

  function setLast(kind, p, opts) {
    const isIn = p.kind === 'in';
    lastEl.className = 'kiosk-last ' + (isIn ? 'in' : 'out');
    const label = kind === 'field' ? (isIn ? 'Back from field' : 'Out on field') : (isIn ? 'Time IN' : 'Time OUT');
    lastEl.innerHTML = `<div class="kiosk-last-label">Last punch</div>
      <div class="kiosk-last-name">${UI.esc(p.name)}</div>
      <div class="kiosk-last-meta">${label} · ${UI.esc((p.ts || '').slice(11, 16))}</div>`;
    if (!opts || !opts.silent) {
      // retrigger the flash animation even if the same element is updated again
      lastEl.classList.remove('flash');
      void lastEl.offsetWidth;
      lastEl.classList.add('flash');
    }
  }

  const SLOT_DEFS = {
    attendance: [
      { key: 'in', label: 'In', cls: 'in' },
      { key: 'lunchOut', label: 'Afternoon Out', cls: 'lunchout' },
      { key: 'lunchIn', label: 'Afternoon In', cls: 'lunchin' },
      { key: 'out', label: 'Out', cls: 'out' },
    ],
    field: [
      { key: 'out', label: 'Out', cls: 'out' },
      { key: 'in', label: 'In', cls: 'in' },
    ],
  };

  function emptyRow(name) { return { name, employee_no: null, in: null, lunchOut: null, lunchIn: null, out: null, el: null }; }

  // Local calendar date ("YYYY-MM-DD"), matching how the server's own localParts() (src/clock.ts)
  // stamps work_date — the kiosk runs on-site, so local time is what matters here.
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function isToday(p) { return (p.ts || '').slice(0, 10) === todayStr(); }
  // Rows are keyed by name+date, not just name, so a stale row left over from a previous day
  // (the /recent feed has no date filter — it's just "the last 20 punches company-wide", which
  // can easily still be yesterday's if nobody's punched yet today) can never get reused for
  // today's first punch and skew its slot classification (e.g. mistaking a real first time-in
  // for a "return from lunch" because yesterday's row still had `in` set).
  function rowKey(p) { return p.name + '|' + (p.ts || '').slice(0, 10); }

  // Which slot a punch fills. `p.slot` is set explicitly for a kiosk correction (see the
  // attendance submit handler) — we already know exactly which slot that targets, so skip the
  // inference entirely (it'd otherwise be ambiguous exactly the same way 'afternoon_in' is).
  // Field is a plain kind toggle (out/in IS the slot). Attendance's 'afternoon_in' segment
  // covers both the very first time-in of the day (if after noon) and a return from lunch —
  // tell them apart by whether this row already has an "in" time.
  function slotFor(kind, p, row) {
    if (p.slot) return p.slot;
    if (kind === 'field') return p.kind;
    if (p.segment === 'morning_in') return 'in';
    if (p.segment === 'lunch_out') return 'lunchOut';
    if (p.segment === 'afternoon_out') return 'out';
    if (p.segment === 'afternoon_in') return row.in ? 'lunchIn' : 'in';
    return p.kind === 'in' ? (row.in ? 'lunchIn' : 'in') : (row.lunchOut ? 'out' : 'lunchOut');
  }

  function slotVal(v) { return v ? UI.esc(v) : '–'; }

  function rowEl(row, kind) {
    if (!row.el) { row.el = document.createElement('div'); row.el.className = 'kiosk-row'; }
    row.el.dataset.name = row.name;
    if (row.employee_no) row.el.dataset.employeeNo = row.employee_no;
    const clickable = kind === 'attendance'; // the field-work 2-state toggle has no real ambiguity to fix
    const cells = SLOT_DEFS[kind].map((s) => {
      const selected = clickable && pendingCorrection && pendingCorrection.name === row.name && pendingCorrection.slot === s.key;
      return `<div class="kr-slot${row[s.key] ? ' filled ' + s.cls : ''}${clickable ? ' clickable' : ''}${selected ? ' selected' : ''}"${clickable ? ` data-slot="${s.key}"` : ''}><span class="kr-label">${s.label}</span><span class="kr-val">${slotVal(row[s.key])}</span></div>`;
    }).join('');
    row.el.innerHTML = `<div class="kr-name">${UI.esc(row.name)}</div><div class="kr-times">${cells}</div>`;
    return row.el;
  }

  // Paint one row live (an active tab just got a new event for it) — bumps it to the top and
  // evicts the oldest row past the display cap, from both the DOM and this tab's row map.
  function paintRow(row, kind) {
    logEl.prepend(rowEl(row, kind));
    const bucket = state[kind].rows;
    while (logEl.children.length > 10) {
      const last = logEl.lastChild;
      for (const [key, r] of bucket) { if (r.el === last) { bucket.delete(key); break; } }
      last.remove();
    }
  }

  // Repaint the whole side panel from a tab's stored state — used on load and on switching
  // tabs, so background updates while a tab was hidden still show correctly once selected.
  function rebuildSide(kind) {
    const bucket = state[kind].rows;
    while (bucket.size > 10) bucket.delete(bucket.keys().next().value);
    logEl.innerHTML = '';
    for (const row of bucket.values()) logEl.prepend(rowEl(row, kind));
    if (state[kind].last) setLast(kind, state[kind].last, { silent: true });
    else { lastEl.className = 'kiosk-last empty'; lastEl.innerHTML = '<div class="kiosk-last-label">Last punch</div><div class="kiosk-last-name">–</div>'; }
  }

  function recordEvent(kind, p, opts) {
    // Never surface a punch that isn't from today — the /recent feed (and the initial replay
    // built on it) isn't date-scoped, so a quiet kiosk can otherwise still be showing
    // yesterday's last row when nobody's punched in yet this morning.
    if (!isToday(p)) return;
    const bucket = state[kind];
    const key = rowKey(p);
    let row = bucket.rows.get(key);
    if (row) bucket.rows.delete(key); // re-set below to move it to the most-recently-touched end
    else row = emptyRow(p.name);
    if (p.employee_no) row.employee_no = p.employee_no;
    const wasFirstIn = !row.in; // read before slotFor/assignment mutate this row
    // Times already on the day's timekeeping row with no punch of their own (e.g. a time-in HR
    // typed in) -- fill empty slots so the card shows them instead of "–".
    if (p.recorded) for (const k of ['in', 'lunchOut', 'lunchIn']) { if (!row[k] && p.recorded[k]) row[k] = p.recorded[k]; }
    row[slotFor(kind, p, row)] = (p.ts || '').slice(11, 16);
    bucket.rows.set(key, row);
    bucket.last = p;
    if (mode === kind) { paintRow(row, kind); setLast(kind, p, opts); }
    if (!opts || !opts.silent) announce(kind, p, wasFirstIn);
  }

  function updateCorrectionBanner() {
    if (!pendingCorrection) { correctionEl.className = 'kiosk-correction hidden'; correctionEl.innerHTML = ''; return; }
    const slotLabel = (SLOT_DEFS.attendance.find((s) => s.key === pendingCorrection.slot) || {}).label || pendingCorrection.slot;
    correctionEl.className = 'kiosk-correction';
    correctionEl.innerHTML = `<span>Correcting <b>${UI.esc(pendingCorrection.name)}</b>'s <b>${UI.esc(slotLabel)}</b> — enter their employee number and press Punch to confirm.</span>
      <button type="button" class="kiosk-correction-cancel" id="kiosk-correction-cancel">Cancel</button>`;
    correctionEl.querySelector('#kiosk-correction-cancel').addEventListener('click', () => {
      pendingCorrection = null;
      updateCorrectionBanner();
      rebuildSide('attendance');
    });
  }

  // Clicking a slot arms/disarms a correction for that employee+slot. Delegated on the log
  // container since rowEl() rebuilds each row's innerHTML on every update (which would
  // otherwise silently drop any listener bound directly to a slot element).
  logEl.addEventListener('click', (e) => {
    if (mode !== 'attendance') return;
    const slotEl = e.target.closest('.kr-slot[data-slot]');
    if (!slotEl) return;
    const rowElm = slotEl.closest('.kiosk-row');
    const name = rowElm && rowElm.dataset.name;
    const employeeNo = rowElm && rowElm.dataset.employeeNo;
    const slot = slotEl.dataset.slot;
    if (!name || !employeeNo) return; // no employee number on record for this row yet — can't safely arm
    pendingCorrection = (pendingCorrection && pendingCorrection.name === name && pendingCorrection.slot === slot)
      ? null // clicking the same slot again cancels
      : { employee_no: employeeNo, name, slot };
    rebuildSide('attendance');
    updateCorrectionBanner();
  });

  function switchMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;
    if (pendingCorrection) { pendingCorrection = null; updateCorrectionBanner(); }
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    panels.attendance.classList.toggle('hidden', mode !== 'attendance');
    panels.field.classList.toggle('hidden', mode !== 'field');
    qrMini.classList.toggle('hidden', mode !== 'attendance'); // the QR only ever proves attendance
    rebuildSide(mode);
    view.querySelector(mode === 'attendance' ? '#kiosk-no' : '#kiosk-field-no')?.focus();
  }
  tabs.forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));

  function renderQR(code) {
    const qr = qrcode(0, 'M');
    qr.addData(code); qr.make();
    qrBox.innerHTML = `<img alt="code" src="${qr.createDataURL(9, 12)}" />`;
  }

  async function refreshCode() {
    try {
      const r = await API.get('/hr/clock/code');
      if (r.code !== curCode) { curCode = r.code; renderQR(curCode); }
      secsLeft = r.seconds_left;
    } catch (e) {
      // Revoked while running: drop back to the approval screen instead of a stale QR.
      if (e && e.data && e.data.code === 'KIOSK_NOT_APPROVED') { location.reload(); return; }
      /* otherwise keep showing the old one */
    }
  }

  async function pollRecent(kind, path, opts) {
    try {
      const punches = await API.get(path + '?since_id=' + lastSeenId[kind]);
      // punches are newest-first; replay oldest→newest so slot assignment (which looks at
      // what's already in the row) and last-touched ordering come out right.
      punches.slice().reverse().forEach((p) => { if (p.id > lastSeenId[kind]) { recordEvent(kind, p, opts); lastSeenId[kind] = p.id; } });
    } catch (e) { /* transient */ }
  }

  view.querySelector('#kiosk-form-attendance').addEventListener('submit', async (e) => {
    e.preventDefault();
    const employee_no = view.querySelector('#kiosk-no').value.trim();
    const msgEl = view.querySelector('#kiosk-msg-attendance');
    if (!employee_no) {
      msgEl.textContent = 'Enter your employee number.';
      msgEl.className = 'kiosk-msg err';
      return;
    }
    const correcting = pendingCorrection;
    if (correcting && employee_no.toLowerCase() !== correcting.employee_no.toLowerCase()) {
      msgEl.textContent = `That number doesn't match ${correcting.name}, whose slot is selected. Tap Cancel to punch someone else.`;
      msgEl.className = 'kiosk-msg err';
      return;
    }
    msgEl.textContent = '…'; msgEl.className = 'kiosk-msg';
    try {
      const r = correcting
        ? await API.post('/hr/clock/correct', { code: curCode, employee_no, slot: correcting.slot })
        : await API.post('/hr/clock/kiosk-punch', { code: curCode, employee_no });
      msgEl.textContent = `${r.employee_name}: ${r.kind === 'in' ? 'IN' : 'OUT'} at ${r.at}`;
      msgEl.className = 'kiosk-msg ok';
      recordEvent('attendance', {
        name: r.employee_name, employee_no, ts: r.work_date + ' ' + r.at, kind: r.kind, segment: r.segment, id: r.id,
        slot: correcting ? correcting.slot : undefined, recorded: r.recorded,
      });
      lastSeenId.attendance = Math.max(lastSeenId.attendance, r.id); // so the next poll doesn't re-announce this same punch
      capturePunchPhoto('attendance', r.id); // fire-and-forget
      if (correcting) { pendingCorrection = null; updateCorrectionBanner(); }
      view.querySelector('#kiosk-form-attendance').reset();
      view.querySelector('#kiosk-no').focus();
      setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } catch (ex) {
      msgEl.textContent = ex.message || 'Punch failed';
      msgEl.className = 'kiosk-msg err';
      errorBuzz();
    }
  });

  view.querySelector('#kiosk-form-field').addEventListener('submit', async (e) => {
    e.preventDefault();
    const employee_no = view.querySelector('#kiosk-field-no').value.trim();
    const msgEl = view.querySelector('#kiosk-msg-field');
    if (!employee_no) {
      msgEl.textContent = 'Enter the employee number.';
      msgEl.className = 'kiosk-msg err';
      return;
    }
    msgEl.textContent = '…'; msgEl.className = 'kiosk-msg';
    try {
      const r = await API.post('/hr/field/kiosk-punch', { code: curCode, employee_no });
      msgEl.textContent = `${r.employee_name}: ${r.kind === 'in' ? 'Back from field' : 'Out on field'} at ${r.at}`;
      msgEl.className = 'kiosk-msg ok';
      recordEvent('field', { name: r.employee_name, ts: r.work_date + ' ' + r.at, kind: r.kind, id: r.id });
      lastSeenId.field = Math.max(lastSeenId.field, r.id);
      capturePunchPhoto('field', r.id); // fire-and-forget
      view.querySelector('#kiosk-form-field').reset();
      view.querySelector('#kiosk-field-no').focus();
      setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } catch (ex) {
      msgEl.textContent = ex.message || 'Punch failed';
      msgEl.className = 'kiosk-msg err';
      errorBuzz();
    }
  });

  // Enter submits (not just clicking the button) — matters at a kiosk where staff type their
  // number and expect Enter to work like it does everywhere else.
  view.querySelectorAll('#kiosk-no, #kiosk-field-no').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.closest('form').requestSubmit(); }
    });
  });

  await refreshCode();
  // Replay recent history once, quietly (no chime/flash): this both primes lastSeenId so the
  // live poll below doesn't re-announce old events, and reconstructs each employee's row (who's
  // already timed in, who's still out at lunch, etc.) instead of starting every row blank —
  // otherwise a return-from-lunch punch right after load would look like a fresh first time-in.
  await Promise.all([
    pollRecent('attendance', '/hr/clock/recent', { silent: true }),
    pollRecent('field', '/hr/field/recent', { silent: true }),
  ]);
  rebuildSide(mode);

  timer = setInterval(() => {
    secsLeft = Math.max(0, secsLeft - 1);
    secsEl.textContent = secsLeft;
    if (secsLeft <= 0) refreshCode();
  }, 1000);
  poll = setInterval(() => {
    pollRecent('attendance', '/hr/clock/recent');
    pollRecent('field', '/hr/field/recent');
  }, 2500);
  const codeRefresh = setInterval(refreshCode, 20000);

  // App.navigate() reuses the same #view element and just reassigns its innerHTML wholesale on
  // every navigation, so `view` itself is never removed from the document — watch our own root
  // (kioskRoot) being detached instead, or a revisit to this screen leaves the old instance's
  // intervals (and its own separate in-memory state) running forever alongside the new one,
  // doubling up chimes/announcements and confusing the new instance's slot tracking.
  const mo = new MutationObserver(() => {
    if (!document.body.contains(kioskRoot)) {
      clearInterval(timer); clearInterval(poll); clearInterval(codeRefresh); mo.disconnect();
      // Leaving the camera stream running would keep the light on (and the device locked)
      // even after navigating away from the kiosk screen.
      if (camStream) camStream.getTracks().forEach((t) => t.stop());
    }
  });
  mo.observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
});
