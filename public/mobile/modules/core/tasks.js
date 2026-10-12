/* My tasks — a personal agenda: schedule tasks with a due time and an optional
   reminder (fires a push). Backed by /api/tasks. */
(function () {
  var toStore = function (v) { return v ? v.replace('T', ' ') : null; };   // input → "YYYY-MM-DD HH:MM"
  var toInput = function (v) { if (!v) return ''; if (/Z$|[+-]\d\d:\d\d$/.test(v)) { var d = new Date(v); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); } return String(v).replace(' ', 'T').slice(0, 16); };

  function bucket(t, todayStr) {
    if (t.done) return 'Done';
    if (!t.due_date) return 'No date';
    var d = String(t.due_date).slice(0, 10);
    if (d < todayStr) return 'Overdue';
    if (d === todayStr) return 'Today';
    return 'Upcoming';
  }
  var ORDER = ['Overdue', 'Today', 'Upcoming', 'No date', 'Done'];

  function load(view) {
    MApp.setTitle('My Tasks');
    view.innerHTML = '<div class="m-actions"><button class="m-btn" id="m-task-add">＋ Add task</button></div><div id="m-task-list"><div class="m-hint">Loading…</div></div>';
    view.querySelector('#m-task-add').onclick = function () { editor(view, null); };
    API.get('/tasks')
      .then(function (rows) {
        var host = view.querySelector('#m-task-list');
        if (!rows.length) { host.innerHTML = '<div class="m-empty">No tasks. Add one to get started.</div>'; return; }
        var today = new Date().toISOString().slice(0, 10);
        var groups = {};
        rows.forEach(function (t) { (groups[bucket(t, today)] = groups[bucket(t, today)] || []).push(t); });
        host.innerHTML = '';
        ORDER.forEach(function (name) {
          var g = groups[name];
          if (!g || !g.length) return;
          host.appendChild(mEl('<h3 class="m-sec">' + name + ' · ' + g.length + '</h3>'));
          var ul = mEl('<ul class="m-list"></ul>');
          g.forEach(function (t) {
            var when = t.due_date ? String(t.due_date).slice(0, 16).replace('T', ' ') : '';
            var li = mEl(
              '<li class="m-task-row' + (t.done ? ' done' : '') + '">' +
              '<button class="m-task-check" aria-label="toggle">' + (t.done ? '✓' : '') + '</button>' +
              '<div class="m-task-main"><b>' + mEsc(t.title) + '</b>' +
              (when || t.remind_at ? '<span>' + mEsc(when) + (t.remind_at ? ' · 🔔' : '') + '</span>' : '') + '</div></li>'
            );
            li.querySelector('.m-task-check').onclick = function (e) {
              e.stopPropagation();
              API.put('/tasks/' + t.id, { done: !t.done }).then(function () { load(view); }).catch(function (ex) { mToast(ex.message, 'err'); });
            };
            li.onclick = function () { editor(view, t); };
            ul.appendChild(li);
          });
          host.appendChild(ul);
        });
      })
      .catch(function (ex) { view.querySelector('#m-task-list').innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function editor(view, t) {
    MApp.setTitle(t ? 'Edit task' : 'New task');
    view.innerHTML = '';
    var f = mEl(
      '<form class="m-form">' +
      '<label class="m-field"><span class="m-label">Task</span><input class="m-input" data-title maxlength="300" required value="' + mEsc(t ? t.title : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Due</span><input class="m-input" type="datetime-local" data-due value="' + (t ? toInput(t.due_date) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Remind me</span><input class="m-input" type="datetime-local" data-remind value="' + (t ? toInput(t.remind_at) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Notes</span><textarea class="m-input" data-notes rows="3">' + mEsc(t && t.notes ? t.notes : '') + '</textarea></label>' +
      '<div class="m-actions"><button class="m-btn" type="submit">' + (t ? 'Save' : 'Add') + '</button>' +
      (t ? '<button class="m-btn m-btn-warn" type="button" data-del>Delete</button>' : '') +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></form>'
    );
    f.querySelector('[data-cancel]').onclick = function () { load(view); };
    var del = f.querySelector('[data-del]');
    if (del) del.onclick = function () {
      API.del('/tasks/' + t.id).then(function () { mToast('Deleted'); load(view); }).catch(function (ex) { mToast(ex.message, 'err'); });
    };
    f.onsubmit = function (e) {
      e.preventDefault();
      var title = f.querySelector('[data-title]').value.trim();
      if (!title) { mToast('Task title required', 'err'); return; }
      var body = {
        title: title,
        due_date: toStore(f.querySelector('[data-due]').value),
        remind_at: f.querySelector('[data-remind]').value ? new Date(f.querySelector('[data-remind]').value).toISOString() : null,
        notes: f.querySelector('[data-notes]').value.trim() || null,
      };
      var p = t ? API.put('/tasks/' + t.id, body) : API.post('/tasks', body);
      p.then(function () { mToast('Saved'); load(view); }).catch(function (ex) { mToast(ex.message || 'Failed', 'err'); });
    };
    view.appendChild(f);
  }

  MApp.route('tasks', function (view) { load(view); });
})();
