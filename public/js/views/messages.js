/* Messages: inbox/sent, read a thread, compose, delete. */
App.register('messages', async (view, filter) => {
  let box = (filter && filter.box === 'sent') ? 'sent' : 'inbox';

  view.innerHTML = `
    <div class="topbar">
      <h2>Messages</h2>
      <div class="grow"></div>
      <button class="btn" id="msg-compose">${UI.icon('edit')} Compose</button>
    </div>
    <div class="msg-tabs">
      <button class="btn secondary small" data-box="inbox">Inbox</button>
      <button class="btn secondary small" data-box="sent">Sent</button>
    </div>
    <div class="panel"><div id="msg-list"></div></div>`;

  const listEl = view.querySelector('#msg-list');

  function setTab() {
    view.querySelectorAll('[data-box]').forEach((b) =>
      b.classList.toggle('secondary', b.dataset.box !== box));
  }

  async function load() {
    setTab();
    listEl.innerHTML = '<div class="empty">Loading…</div>';
    const msgs = await API.get('/messages?box=' + box);
    if (!msgs.length) {
      listEl.className = '';
      listEl.innerHTML = UI.emptyState({
        icon: box === 'inbox' ? 'inbox' : 'send',
        title: box === 'inbox' ? 'Your inbox is empty' : 'No sent messages',
        hint: box === 'inbox' ? 'Messages from your colleagues will show up here.' : 'Messages you send will appear here.',
        action: `<button class="btn" id="msg-empty-compose">${UI.icon('edit')} Compose</button>`,
      });
      const ec = listEl.querySelector('#msg-empty-compose');
      if (ec) ec.onclick = () => composeModal();
      return;
    }
    listEl.className = 'msg-list';
    listEl.innerHTML = msgs.map((m) => `
      <div class="msg-row ${box === 'inbox' && !m.read_at ? 'unread' : ''}" data-id="${m.id}">
        <div class="avatar">${UI.esc(UI.initials(m.other_name))}</div>
        <div class="meta">
          <div class="who">${box === 'inbox' ? '' : 'To: '}${UI.esc(m.other_name)}
            ${box === 'inbox' && !m.read_at ? '<span class="badge-pill low" style="font-size:10px">NEW</span>' : ''}</div>
          <div class="subj">${UI.esc(m.subject || '(no subject)')}</div>
          <div class="preview">${UI.esc(m.body)}</div>
        </div>
        <div class="when">${UI.fmtDateShort(m.created_at)}</div>
      </div>`).join('');

    listEl.querySelectorAll('[data-id]').forEach((row) =>
      row.onclick = () => openMessage(msgs.find((x) => x.id == row.dataset.id)));
  }

  async function openMessage(m) {
    if (box === 'inbox' && !m.read_at) {
      try { await API.post(`/messages/${m.id}/read`); App.refreshUnread(); } catch {}
    }
    UI.modal({
      title: m.subject || '(no subject)',
      bodyHTML: `
        <div class="msg-full">
          <div class="muted">${box === 'inbox' ? 'From' : 'To'}: <strong>${UI.esc(m.other_name)}</strong>
            (@${UI.esc(m.other_username)}) · ${UI.fmtDate(m.created_at)}</div>
          <div class="body">${UI.esc(m.body)}</div>
        </div>`,
      confirmText: box === 'inbox' ? 'Reply' : null,
      cancelText: 'Close',
      onConfirm: () => { composeModal(m.other_id, m.other_name, 'Re: ' + (m.subject || '')); return true; },
      onOpen: (overlay) => {
        const foot = overlay.querySelector('.modal-foot');
        const delBtn = document.createElement('button');
        delBtn.className = 'btn danger';
        delBtn.textContent = 'Delete';
        delBtn.style.marginRight = 'auto';
        delBtn.onclick = async () => {
          await API.del('/messages/' + m.id);
          UI.toast('Message deleted');
          overlay.remove();
          load();
        };
        foot.prepend(delBtn);
      },
    });
    if (box === 'inbox') setTimeout(load, 300);
  }

  async function composeModal(toId, toName, subject) {
    const users = await API.get('/users');
    const me = App.getMe();
    const opts = users.filter((u) => u.id !== me.id)
      .map((u) => `<option value="${u.id}" ${u.id === toId ? 'selected' : ''}>${UI.esc(u.full_name)} (@${UI.esc(u.username)})${u.department_name ? ' · ' + UI.esc(u.department_name) : ''}</option>`).join('');
    UI.modal({
      title: 'New message',
      bodyHTML: `
        <div><label>To *</label><select data-f="recipient">${'<option value="">— Select recipient —</option>' + opts}</select></div>
        <div><label>Subject</label><input data-f="subject" value="${UI.esc(subject || '')}" /></div>
        <div><label>Message *</label><textarea data-f="body" style="min-height:120px"></textarea></div>`,
      confirmText: 'Send',
      onConfirm: async (overlay, showErr) => {
        const recipient_id = overlay.querySelector('[data-f="recipient"]').value;
        const body = overlay.querySelector('[data-f="body"]').value.trim();
        if (!recipient_id) { showErr('Please choose a recipient'); return false; }
        if (!body) { showErr('Message body cannot be empty'); return false; }
        await API.post('/messages', {
          recipient_id: Number(recipient_id),
          subject: overlay.querySelector('[data-f="subject"]').value,
          body,
        });
        UI.toast('Message sent');
        if (box === 'sent') load();
      },
    });
  }

  view.querySelectorAll('[data-box]').forEach((b) =>
    b.addEventListener('click', () => { box = b.dataset.box; load(); }));
  view.querySelector('#msg-compose').addEventListener('click', () => composeModal());

  await load();
});
