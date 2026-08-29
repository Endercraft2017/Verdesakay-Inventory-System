/* Time-in Kiosk — runs on the office monitor beside the guard.
   Shows a QR that rotates every minute (employees scan it from the mobile app),
   accepts employee-no + name for phone-less staff, and plays a distinct chime +
   speaks the name for every punch (phone or kiosk) so the guard hears each one. */
App.register('hr-kiosk', async (view) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
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
        <h2>Time In / Time Out</h2>
        <div class="kiosk-qr" id="kiosk-qr"></div>
        <div class="kiosk-count"><span id="kiosk-secs">–</span>s · new code each minute</div>
        <div class="kiosk-hint">Scan with the Verdesakay app. No phone? Enter your number below.</div>
        <form id="kiosk-form" class="kiosk-form" autocomplete="off">
          <input id="kiosk-no" placeholder="Employee number" />
          <input id="kiosk-name" placeholder="Full name (as on your record)" />
          <button class="btn" type="submit">Punch</button>
        </form>
        <div id="kiosk-msg" class="kiosk-msg"></div>
      </div>
      <div class="kiosk-side">
        <h3>Recent</h3>
        <label class="kiosk-mute"><input type="checkbox" id="kiosk-speak" checked /> Speak names</label>
        <ul id="kiosk-log" class="kiosk-log"></ul>
      </div>
    </div>`;

  const qrBox = view.querySelector('#kiosk-qr');
  const secsEl = view.querySelector('#kiosk-secs');
  const logEl = view.querySelector('#kiosk-log');
  const msgEl = view.querySelector('#kiosk-msg');
  const speakChk = view.querySelector('#kiosk-speak');
  let curCode = null, secsLeft = 0, lastSeenId = 0, timer = null, poll = null;

  /* ---- audio: a short distinct jingle per segment ---- */
  const SEG = {
    morning_in:   { seq: [523, 659, 784, 1047], word: 'Good morning' },
    afternoon_in: { seq: [523, 784],            word: 'Welcome back' },
    lunch_out:    { seq: [659, 494],            word: 'Lunch break' },
    afternoon_out:{ seq: [784, 659, 523, 392],  word: 'Goodbye' },
    other_in:     { seq: [523, 784],            word: 'Time in' },
    other_out:    { seq: [784, 523],            word: 'Time out' },
  };
  let ac = null;
  function tone(seq) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      seq.forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(ac.destination);
        const t = ac.currentTime + i * 0.14;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t); o.stop(t + 0.25);
      });
    } catch (e) { /* ignore */ }
  }
  function errorBuzz() { tone([196, 165, 196]); }
  function announce(p) {
    const s = SEG[p.segment] || SEG.other_in;
    tone(s.seq);
    if (speakChk.checked && window.speechSynthesis) {
      const first = (p.name || '').split(' ')[0];
      const u = new SpeechSynthesisUtterance(`${s.word}${first ? ', ' + first : ''}`);
      u.rate = 1; u.volume = 1;
      try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* ignore */ }
    }
  }

  function addLog(p, opts) {
    const li = document.createElement('li');
    li.className = p.kind === 'in' ? 'in' : 'out';
    li.innerHTML = `<b>${UI.esc(p.name)}</b><span>${UI.esc((p.ts || '').slice(11, 16))} · ${p.kind === 'in' ? 'IN' : 'OUT'}</span>`;
    logEl.prepend(li);
    while (logEl.children.length > 12) logEl.lastChild.remove();
    if (!opts || !opts.silent) announce(p);
  }

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
    } catch (e) { /* keep showing the old one */ }
  }

  async function pollRecent() {
    try {
      const rows = await API.get('/hr/clock/recent?since_id=' + lastSeenId);
      // rows are newest-first; play oldest→newest
      rows.slice().reverse().forEach((p) => { if (p.id > lastSeenId) { addLog(p); lastSeenId = p.id; } });
    } catch (e) { /* transient */ }
  }

  view.querySelector('#kiosk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const employee_no = view.querySelector('#kiosk-no').value.trim();
    const name = view.querySelector('#kiosk-name').value.trim();
    if (!employee_no || !name) return;
    msgEl.textContent = '…'; msgEl.className = 'kiosk-msg';
    try {
      const r = await API.post('/hr/clock/kiosk-punch', { code: curCode, employee_no, name });
      msgEl.textContent = `${r.employee_name}: ${r.kind === 'in' ? 'IN' : 'OUT'} at ${r.at}`;
      msgEl.className = 'kiosk-msg ok';
      addLog({ name: r.employee_name, ts: '0000-00-00 ' + r.at, kind: r.kind, segment: r.segment, id: 0 });
      lastSeenId = Math.max(lastSeenId, 0); // the poll will also pick it up; announce now
      view.querySelector('#kiosk-form').reset();
      setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } catch (ex) {
      msgEl.textContent = ex.message || 'Punch failed';
      msgEl.className = 'kiosk-msg err';
      errorBuzz();
    }
  });

  await refreshCode();
  await pollRecent();
  // seed lastSeenId so we don't replay history on open
  try {
    const seed = await API.get('/hr/clock/recent?since_id=0');
    if (seed[0]) lastSeenId = seed[0].id;
  } catch (e) { /* ignore */ }
  logEl.innerHTML = '';

  timer = setInterval(() => {
    secsLeft = Math.max(0, secsLeft - 1);
    secsEl.textContent = secsLeft;
    if (secsLeft <= 0) refreshCode();
  }, 1000);
  poll = setInterval(pollRecent, 2500);
  const codeRefresh = setInterval(refreshCode, 20000);

  // Cleanup when the view is torn down (App re-renders #view on navigation).
  const mo = new MutationObserver(() => {
    if (!document.body.contains(view)) {
      clearInterval(timer); clearInterval(poll); clearInterval(codeRefresh); mo.disconnect();
    }
  });
  mo.observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
});
