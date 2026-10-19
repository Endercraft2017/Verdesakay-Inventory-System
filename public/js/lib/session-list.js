/* Session list — "where this account is / was signed in", shared by My Account (own sessions,
   GET /auth/sessions) and Admin → Users (any account, GET /users/:id/sessions).

   SessionList.render(el, {
     load: () => Promise<rows>,          // rows from src/shared/auth.ts listUserSessions()
     revoke: (id) => Promise,            // end one session
     revokeAll: () => Promise<{ended}>,  // end every other live one
     revokeAllLabel: 'Sign out everywhere else',
   })
   Live sessions come first with a Sign out button (none on the current one); ended ones are
   greyed with how they ended. */
const SessionList = (() => {
  const END_LABELS = {
    logout: 'Signed out', revoked: 'Signed out remotely', password: 'Password changed',
    deactivated: 'Account disabled', expired: 'Expired', idle: 'Timed out (idle)',
  };

  function where(r) {
    const ip = r.last_ip || r.ip;
    return ip ? `IP ${UI.esc(ip)}${r.ip && r.last_ip && r.ip !== r.last_ip ? ` (signed in from ${UI.esc(r.ip)})` : ''}` : 'IP unknown';
  }

  function row(r) {
    const live = !r.ended_at;
    const tags = [
      r.current ? '<span class="badge-pill ok">This browser</span>' : '',
      r.shared ? '<span class="badge-pill low">Borrowed / shared</span>' : '',
    ].join(' ');
    const status = live
      ? `Last active ${UI.esc(UI.fmtDate(r.last_seen_at || r.created_at))}`
      : `${UI.esc(END_LABELS[r.end_reason] || 'Ended')} ${UI.esc(UI.fmtDate(r.ended_at))}`;
    return `
      <tr${live ? '' : ' class="muted"'}>
        <td><strong>${UI.esc(r.device)}</strong> ${tags}
          <div class="muted mono" style="font-size:11px" title="Device ID">${r.device_id ? UI.esc(r.device_id.slice(0, 8)) : '—'}</div></td>
        <td>${UI.esc(UI.fmtDate(r.created_at))}</td>
        <td>${where(r)}</td>
        <td>${status}</td>
        <td class="actions">${live && !r.current ? `<button class="btn secondary small" data-end="${UI.esc(r.id)}">Sign out</button>` : ''}</td>
      </tr>`;
  }

  async function render(el, opts) {
    el.innerHTML = '<div class="muted">Loading…</div>';
    let rows;
    try { rows = await opts.load(); } catch (e) {
      el.innerHTML = `<div role="alert">${UI.esc(e.message)}</div><button class="btn secondary small" data-session-retry>Retry</button>`;
      el.querySelector('[data-session-retry]').onclick = () => render(el, opts);
      return;
    }
    if (!rows.length) { el.innerHTML = '<div class="muted">No sign-ins recorded.</div>'; return; }
    const others = rows.filter((r) => !r.ended_at && !r.current).length;
    el.innerHTML = `
      <table>
        <thead><tr><th>Device</th><th>Signed in</th><th>Where</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(row).join('')}</tbody>
      </table>
      ${others && opts.revokeAll ? `<button class="btn secondary" data-end-all style="margin-top:10px">${UI.esc(opts.revokeAllLabel || 'Sign out everywhere else')}</button>` : ''}`;
    el.querySelectorAll('[data-end]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await opts.revoke(b.dataset.end); UI.toast('Signed out of that device'); render(el, opts); }
      catch (e) { b.disabled = false; UI.toast(e.message, 'error'); }
    });
    const all = el.querySelector('[data-end-all]');
    if (all) all.onclick = async () => {
      if (!window.confirm('Sign out of every other device?')) return;
      all.disabled = true;
      try {
        const r = await opts.revokeAll();
        UI.toast(`Signed out of ${r.ended} session${r.ended === 1 ? '' : 's'}`);
        render(el, opts);
      } catch (e) { all.disabled = false; UI.toast(e.message, 'error'); }
    };
  }

  return { render };
})();
