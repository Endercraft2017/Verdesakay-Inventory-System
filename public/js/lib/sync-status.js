/* Sync status pill (docs/OFFLINE-FIRST.md §2.4, phase 3b) — only on an installed PC.

   Shows where this PC's work stands, in the top bar:
     ● Synced                         everything confirmed by the cloud
     ◐ Syncing · 3 waiting            connected, some actions not confirmed yet
     ○ Offline · 3 saved on this PC   the cloud can't be reached; work continues locally
     + "· 2 need attention"           actions the cloud rejected / open stock discrepancies
   Clicking it opens the Sync page (#/sync). Every action an API call reports as saved only on
   this PC (X-Sync-State: local → 'vds:sync-local') also gets a toast saying it isn't final yet.
   On the cloud / a normal install `GET /sync/status` says mode 'cloud' / 'off' and the pill
   never appears. */
const SyncStatus = (() => {
  const POLL_MS = 15000;
  let timer = null;
  let last = null;

  function pillEl() {
    let el = document.getElementById('sync-pill');
    if (el) return el;
    const user = document.querySelector('.topnav-user');
    if (!user) return null;
    el = document.createElement('button');
    el.id = 'sync-pill';
    el.type = 'button';
    el.className = 'sync-pill hidden';
    el.addEventListener('click', () => App.navigate('sync'));
    user.parentNode.insertBefore(el, user);
    return el;
  }

  /** Text + tone for a status (exported for the Sync page and tests). */
  function describe(s) {
    if (!s || s.mode !== 'node') return null;
    const waiting = s.pending_total || 0;
    const attention = (s.attention || 0) + (s.discrepancies_open || 0);
    let text;
    let tone;
    if (s.online === false) {
      text = waiting ? `Offline · ${waiting} saved on this PC` : 'Offline · working on this PC';
      tone = 'offline';
    } else if (waiting) {
      text = `Syncing · ${waiting} waiting`;
      tone = 'syncing';
    } else if (s.online === null) {
      text = 'Connecting…';
      tone = 'syncing';
    } else {
      text = 'Synced';
      tone = 'synced';
    }
    if (attention) {
      text += ` · ${attention} need${attention === 1 ? 's' : ''} attention`;
      tone = 'attention';
    }
    return { text, tone };
  }

  function render(s) {
    const el = pillEl();
    if (!el) return;
    const d = describe(s);
    el.classList.toggle('hidden', !d);
    if (!d) return;
    el.className = 'sync-pill ' + d.tone;
    el.textContent = d.text;
    el.title = s.last_sync_at
      ? 'Last synced ' + UI.fmtDate(s.last_sync_at) + (s.last_error && s.online === false ? '\n' + s.last_error : '')
      : 'Not synced yet since this PC started';
  }

  async function refresh() {
    try {
      last = await API.get('/sync/status');
      render(last);
      if (last.mode !== 'node') stop(); // nothing to watch here
    } catch (e) { /* keep the last state; the next poll retries */ }
    return last;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function start() {
    stop();
    void refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  /** A readable name for a recorded action (a sync command: method, path, parsed body). */
  function label(cmd) {
    const b = cmd.body || {};
    const p = String(cmd.path || '').replace(/^\/api/, '').split('?')[0];
    const q = (s) => '"' + String(s) + '"';
    let m;
    if ((m = /^\/inventory\/\d+\/adjust$/.exec(p))) {
      const n = Number(b.change) || 0;
      return (n < 0 ? 'Stock out ' + -n : 'Stock in ' + n) + (b.reason ? ' — ' + b.reason : '');
    }
    if (/^\/inventory\/\d+\/damage$/.test(p)) return 'Damage report: ' + (b.quantity || '?') + (b.reason ? ' — ' + b.reason : '');
    if (/^\/inventory\/\d+\/transfer$/.test(p)) return 'Transfer ' + (b.amount || '?') + (b.reason ? ' — ' + b.reason : '');
    if (cmd.method === 'POST' && p === '/inventory') return 'New item ' + q(b.name || '');
    if (cmd.method === 'POST' && p === '/locations') return 'New location ' + q(b.name || '');
    if (cmd.method === 'POST' && p === '/suppliers') return 'New supplier ' + q(b.name || '');
    if (cmd.method === 'POST' && p === '/customers') return 'New customer ' + q(b.name || '');
    return cmd.method + ' ' + p;
  }

  window.addEventListener('vds:sync-local', () => {
    UI.toast('Saved on this PC — it is not final until it syncs with the cloud.', 'local');
    void refresh();
  });

  return { start, stop, refresh, describe, label, current: () => last };
})();
