/* My tasks — a personal agenda: schedule tasks with a due time and an optional
   reminder (fires a push). Backed by /api/tasks. */
(function () {
  var toStore = function (v) { return v ? v.replace('T', ' ') : null; };   // input → "YYYY-MM-DD HH:MM"
  var toInput = function(v){return PersonalUX.input(v);};

  function bucket(t, todayStr) {
    if (t.done) return 'Done';
    if (!t.due_date) return 'No date';
    var d = String(t.due_date).slice(0, 10);
    if (d < todayStr) return 'Overdue';
    if (d === todayStr) return 'Today';
    return 'Upcoming';
  }
  var ORDER = ['Overdue', 'Today', 'Upcoming', 'No date', 'Done'];

  // Keep pending/error state per account and task even when another row refreshes the list.
  var operations = Object.create(null), completed = Object.create(null), revision = 0, activeList = null;
  function taskKey(id) { return (MApp.getMe() || {}).id + ':' + id; }
  function load(view, params) {
    MApp.setTitle('Tasks & reminders');
    view.innerHTML = '<div class="m-actions"><button class="m-btn" id="m-task-add">＋ Add task</button></div><div id="m-task-list"><div class="m-hint" role="status">Loading…</div></div>';
    view.querySelector('#m-task-add').onclick = function () { MApp.go('tasks', { new: 1 }); };
    if (params && params.new) { editor(view, null); return; }
    var host = view.querySelector('#m-task-list'), requestedAt = revision;
    var list = { host: host, rows: [], loaded: false, paint: paint };
    activeList = list;
    API.get('/tasks').then(function (rows) {
      if (!host.isConnected) return;
      rows.forEach(function (task) {
        var key = taskKey(task.id), update = completed[key];
        if (update && update.version > requestedAt) task.done = update.done;
        else if (update) delete completed[key];
      });
      if (params && params.id) {
        var selected = rows.find(function (task) { return String(task.id) === String(params.id); });
        if (selected) { editor(view, selected); return; }
        host.innerHTML = '<div class="m-error" role="alert">This task is no longer available.</div><button class="m-btn" type="button" data-back>All tasks</button>';
        host.querySelector('[data-back]').onclick = function () { MApp.go('tasks'); }; return;
      }
      list.rows = rows; list.loaded = true; paint();
    }).catch(function (error) {
      if (!host.isConnected) return;
      host.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load tasks') + '</div><button class="m-btn" type="button" data-retry>Retry</button>';
      host.querySelector('[data-retry]').onclick = function () { load(view, params); };
    });
    function paint() {
      if (!list.loaded) return;
      if (!host.isConnected) return;
      if (!list.rows.length) { host.innerHTML = '<div class="m-empty">No tasks. Add one to get started.</div>'; return; }
      var today = mPersonalTime.today(), groups = {};
      list.rows.forEach(function (task) { (groups[bucket(task, today)] = groups[bucket(task, today)] || []).push(task); });
      host.innerHTML = '';
      ORDER.forEach(function (name) {
        var rows = groups[name]; if (!rows || !rows.length) return;
        host.appendChild(mEl('<h3 class="m-sec">' + name + ' · ' + rows.length + '</h3>'));
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (task) {
          var key = taskKey(task.id), op = operations[key] || {}, when = PersonalUX.format(task.due_date);
          var li = mEl('<li class="m-task-row' + (task.done ? ' done' : '') + '" data-task-id="' + mEsc(task.id) + '">' +
            '<button type="button" class="m-task-check" aria-pressed="' + !!task.done + '" aria-label="' + (task.done ? 'Reopen task' : 'Complete task') + ' ' + mEsc(task.title) + '"' + (op.pending ? ' disabled' : '') + '>' + (task.done ? '✓' : '') + '</button>' +
            '<button type="button" class="m-task-main" aria-label="Open task ' + mEsc(task.title) + '"><b>' + mEsc(task.title) + '</b>' +
            (when || task.remind_at ? '<span>' + mEsc(when) + (task.remind_at ? ' · Reminder ' + mEsc(PersonalUX.format(task.remind_at)) : '') + '</span>' : '') + '</button>' +
            (op.pending ? '<p class="m-task-feedback" role="status">Updating task…</p>' : op.error ? '<div class="m-task-feedback m-error" role="alert">' + mEsc(op.error) + '<button type="button" class="m-btn m-btn-sm" data-retry-update>Try again</button></div>' : '') + '</li>');
          li.setAttribute('aria-busy', String(!!op.pending));
          li.querySelector('.m-task-check').onclick = function () { updateTask(task, op.error ? op.desired : !task.done); };
          var retry = li.querySelector('[data-retry-update]'); if (retry) retry.onclick = function () { updateTask(task, op.desired); };
          li.querySelector('.m-task-main').onclick = function () { MApp.go('tasks', { id: task.id }); };
          ul.appendChild(li);
        });
        host.appendChild(ul);
      });
    }
    function updateTask(task, desired) {
      var key = taskKey(task.id); if (operations[key] && operations[key].pending) return;
      var op = { pending: true, desired: desired, error: null }; operations[key] = op; paint();
      API.put('/tasks/' + task.id, { done: desired }).then(function () {
        completed[key] = { version: ++revision, done: desired }; task.done = desired;
        if (activeList && activeList.host.isConnected) activeList.rows.forEach(function (row) { if (taskKey(row.id) === key) row.done = desired; });
        delete operations[key];
      }).catch(function (error) { op.error = (error.message || 'Could not update this task.') + ' Check its current state before retrying.'; })
        .finally(function () { op.pending = false; if (activeList && activeList.host.isConnected) activeList.paint(); });
    }
  }

  function editor(view, task) {
    var linked = !!(task && task.note_id), busy = false, busyAction = 'saving', confirmation = null, proceedLeave = null;
    MApp.setTitle(task ? 'Edit task' : 'New task'); view.innerHTML = '';
    var form = mEl('<form class="m-form" novalidate>' +
      (linked ? '<div class="m-task-linked"><b>Linked to a note</b><p>Title and checklist are edited in the note.</p><button type="button" class="m-btn m-btn-secondary" data-open-note>Open linked note</button></div>' : '') +
      '<label class="m-field"><span class="m-label">Task' + (linked ? ' · from linked note' : '') + '</span><input class="m-input" data-title maxlength="300" required ' + (linked ? 'readonly ' : '') + 'value="' + mEsc(task ? task.title : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Due</span><input class="m-input" type="datetime-local" data-due value="' + (task ? toInput(task.due_date) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Remind me</span><input class="m-input" type="datetime-local" data-remind value="' + (task ? toInput(task.remind_at) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Notes' + (linked ? ' · from linked note' : '') + '</span><textarea class="m-input" data-notes rows="3" ' + (linked ? 'readonly' : '') + '>' + mEsc(task && task.notes ? task.notes : '') + '</textarea></label>' +
      '<p class="m-error m-task-save-error" data-task-error role="alert" tabindex="-1"></p>' +
      '<div class="personal-editor-actions"><span class="personal-save-status" data-save-status aria-live="polite"></span><div class="m-actions"><button class="m-btn" type="submit">' + (task ? 'Save' : 'Add') + '</button><button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></div>' +
      (task ? '<details class="personal-secondary-actions"><summary>More actions</summary><button class="m-btn m-btn-warn" type="button" data-del>Delete task</button></details>' : '') + '</form>');
    view.appendChild(form); PersonalUX.footer(form); PersonalUX.schedule(form, '[data-due]', '[data-remind]', task?.due_date);
    var title = form.querySelector('[data-title]'), due = form.querySelector('[data-due]'), remind = form.querySelector('[data-remind]');
    var feedback = form.querySelector('[data-task-error]'), submit = form.querySelector('[type=submit]');
    function snapshot() { return JSON.stringify(Array.prototype.map.call(form.querySelectorAll('input,textarea,select'), function (el) { return { value: el.value, edited: el.dataset.edited || '' }; })); }
    var initial = snapshot();
    var saveStatus = PersonalUX.status(form, form.querySelector('[data-save-status]'), function () { return snapshot() !== initial; }, !!task);
    function fail(message, field) {
      feedback.textContent = message; saveStatus.failed('Not saved');
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } else feedback.focus();
    }
    form.addEventListener('input', function (event) { event.target.removeAttribute('aria-invalid'); });
    mPersonalDraft.arm(function () { return snapshot() !== initial; }, function () { return busy; }, {
      busyText: function () { return busyAction === 'deleting' ? 'Please wait for deletion to finish.' : 'Please wait for saving to finish.'; },
      confirmLeave: function (proceed) { proceedLeave = proceed; showConfirmation('leave'); }
    });
    form.querySelector('[data-cancel]').onclick = function () { MApp.go('tasks'); };
    if (linked) form.querySelector('[data-open-note]').onclick = function () { MApp.go('notes', { id: task.note_id }); };
    var del = form.querySelector('[data-del]'); if (del) del.onclick = function () { showConfirmation('delete'); };
    function showConfirmation(kind) {
      if (busy || confirmation) return;
      var removing = kind === 'delete', returnFocus = document.activeElement;
      var root = mEl('<div class="m-task-confirm-backdrop" aria-label="' + (removing ? 'Delete this task?' : 'Discard task changes?') + '"><section class="m-task-confirm">' +
        '<h2>' + (removing ? 'Delete this task?' : 'Discard task changes?') + '</h2><blockquote>' + mEsc(removing ? task.title : title.value.trim() || 'New task') + '</blockquote>' +
        '<p>' + (removing ? 'The task and its reminder will be removed.' : 'Your edits to this task haven’t been saved.') + '</p>' +
        (removing && linked ? '<p class="m-task-linked">Its linked note and checklist will remain.</p>' : '') +
        (!removing ? '<p>Keep editing to review and save them, or discard these edits and leave.</p>' : '') +
        '<p class="m-error" data-confirm-error role="alert" tabindex="-1"></p><div class="m-actions"><button class="m-btn m-btn-secondary" type="button" data-keep>' + (removing ? 'Cancel' : 'Keep editing') + '</button><button class="m-btn m-btn-danger" type="button" data-confirm>' + (removing ? 'Delete task' : 'Discard changes') + '</button></div></section></div>');
      form.inert = true; document.body.appendChild(root);
      var control = MessageOverlay.mount(root, { initialFocus: '[data-keep]', canClose: function () { return !busy; }, onClose: function () { confirmation = null; form.inert = false; if (returnFocus && returnFocus.isConnected) returnFocus.focus(); } });
      confirmation = control;
      var keep = root.querySelector('[data-keep]'), confirm = root.querySelector('[data-confirm]'), error = root.querySelector('[data-confirm-error]');
      keep.onclick = control.close;
      confirm.onclick = async function () {
        if (busy) return;
        if (!removing) { control.close(); if (proceedLeave) proceedLeave(); return; }
        busy = true; busyAction = 'deleting'; keep.disabled = true; confirm.disabled = true; confirm.textContent = 'Deleting…'; error.textContent = '';
        root.setAttribute('aria-busy', 'true');
        try {
          await API.del('/tasks/' + task.id);
          busy = false; mPersonalDraft.clear(); control.close();
          if (form.isConnected) { mToast('Deleted'); MApp.go('tasks'); }
        } catch (failure) { if (root.isConnected) { error.textContent = failure.message || 'Could not delete this task. Try again.'; error.focus(); } }
        finally { busy = false; keep.disabled = false; confirm.disabled = false; confirm.textContent = 'Delete task'; root.removeAttribute('aria-busy'); }
      };
    }
    form.onsubmit = function (event) {
      event.preventDefault(); if (busy || confirmation) return;
      feedback.textContent = '';
      var taskTitle = title.value.trim(), preset = form.querySelector('[aria-label="Reminder timing"]').value;
      if (!taskTitle) { fail('Enter a task title.', title); return; }
      if (!title.checkValidity()) { fail(title.validationMessage, title); return; }
      if (!due.checkValidity()) { fail(due.validationMessage, due); return; }
      if (!remind.checkValidity()) { fail(remind.validationMessage, remind); return; }
      if (preset !== 'none' && preset !== 'custom' && !due.value) { fail('Choose a due date and time to use this reminder. Your task has not been saved.', due); return; }
      if (preset === 'custom' && !remind.value) { fail('Choose a reminder date and time, or select No reminder.', remind); return; }
      var body = { title: taskTitle, due_date: toStore(PersonalUX.dueValue(due, task?.due_date)), remind_at: PersonalUX.reminderValue(remind, task?.remind_at), notes: form.querySelector('[data-notes]').value.trim() || null };
      if (linked) { delete body.title; delete body.notes; }
      busy = true; busyAction = 'saving'; saveStatus.saving(); form.inert = true; submit.disabled = true; submit.textContent = 'Saving…';
      var request = task ? API.put('/tasks/' + task.id, body) : API.post('/tasks', body);
      request.then(function () {
        saveStatus.saved(); mPersonalDraft.clear();
        if (form.isConnected) { mToast('Saved'); MApp.go('tasks'); }
      }).catch(function (error) { if (form.isConnected) { form.inert = false; fail((error.message || 'Could not save your task.') + ' Your changes are still here. Try saving again.'); } })
        .finally(function () { busy = false; form.inert = false; submit.disabled = false; submit.textContent = task ? 'Save' : 'Add'; });
    };
  }

  MApp.route('tasks', function (view,params) { load(view,params); });
})();
