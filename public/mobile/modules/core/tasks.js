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

  function load(view, params) {
    MApp.setTitle('My Tasks');
    view.innerHTML = '<div class="m-actions"><button class="m-btn" id="m-task-add">＋ Add task</button></div><div id="m-task-list"><div class="m-hint">Loading…</div></div>';
    view.querySelector('#m-task-add').onclick = function () { MApp.go('tasks',{new:1}); };
    if(params && params.new){editor(view,null);return;}
    var host = view.querySelector('#m-task-list');
    API.get('/tasks')
      .then(function (rows) {
        if(!host.isConnected)return;
        if(params && params.id) { var selected=rows.find(function(t){return String(t.id)===String(params.id);}); if(selected) {editor(view,selected);return;} view.innerHTML='<div class="m-error">This task is no longer available.</div><button class="m-btn" id="m-task-back">All tasks</button>';view.querySelector('#m-task-back').onclick=function(){MApp.go('tasks');};return; }
        if (!rows.length) { host.innerHTML = '<div class="m-empty">No tasks. Add one to get started.</div>'; return; }
        var today = mPersonalTime.today();
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
              '<button class="m-task-check" aria-label="' + (t.done ? 'Reopen task' : 'Complete task') + '">' + (t.done ? '✓' : '') + '</button>' +
              '<button type="button" class="m-task-main" aria-label="Open task '+mEsc(t.title)+'"><b>' + mEsc(t.title) + '</b>' +
              (when || t.remind_at ? '<span>' + mEsc(when) + (t.remind_at ? ' · 🔔' : '') + '</span>' : '') + '</button></li>'
            );
            li.querySelector('.m-task-check').onclick = function (e) {
              e.stopPropagation();
              e.currentTarget.disabled=true;API.put('/tasks/' + t.id, { done: !t.done }).then(function () { if(li.isConnected)load(view); }).catch(function (ex) { mToast(ex.message, 'err'); }).finally(function(){var button=li.querySelector('.m-task-check');if(button)button.disabled=false;});
            };
            li.querySelector('.m-task-main').onclick = function () { MApp.go('tasks', {id:t.id}); };
            ul.appendChild(li);
          });
          host.appendChild(ul);
        });
      })
      .catch(function (ex) { if(host.isConnected){host.innerHTML='<div class="m-error">'+mEsc(ex.message)+'</div><button class="m-btn" data-retry>Retry</button>';host.querySelector('[data-retry]').onclick=function(){load(view,params);};} });
  }

  function editor(view, t) {
    var linked=!!(t && t.note_id), busy=false;
    MApp.setTitle(t ? 'Edit task' : 'New task');
    view.innerHTML = '';
    var f = mEl(
      '<form class="m-form">' +
      '<label class="m-field"><span class="m-label">Task</span><input class="m-input" data-title maxlength="300" required ' + (linked ? 'readonly ' : '') + 'value="' + mEsc(t ? t.title : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Due</span><input class="m-input" type="datetime-local" data-due value="' + (t ? toInput(t.due_date) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Remind me</span><input class="m-input" type="datetime-local" data-remind value="' + (t ? toInput(t.remind_at) : '') + '" /></label>' +
      '<label class="m-field"><span class="m-label">Notes</span><textarea class="m-input" data-notes rows="3" ' + (linked ? 'readonly' : '') + '>' + mEsc(t && t.notes ? t.notes : '') + '</textarea></label>' +
      (linked ? '<p class="m-hint">This task is linked to a note. Edit its title and checklist in the note.</p><button type="button" class="m-btn m-btn-secondary" data-open-note>Open linked note</button>' : '') +
      '<div class="m-actions"><button class="m-btn" type="submit">' + (t ? 'Save' : 'Add') + '</button>' +
      (t ? '<button class="m-btn m-btn-warn" type="button" data-del>Delete</button>' : '') +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></form>'
    );
    var snapshot=function(){return JSON.stringify([...f.querySelectorAll('input,textarea')].map(function(el){return el.value;}));};var initial=snapshot();mPersonalDraft.arm(function(){return snapshot()!==initial;},function(){return busy;});
    f.querySelector('[data-cancel]').onclick = function () { if(mPersonalDraft.allow()) {MApp.go('tasks');MApp.render();} };
    if(linked) f.querySelector('[data-open-note]').onclick=function(){MApp.go('notes',{id:t.note_id});};
    var del = f.querySelector('[data-del]');
    if (del) del.onclick = function () {
      if(busy)return;
      if(!window.confirm('Delete this task? Its linked note, if any, will remain.')) return;
      busy=true;f.inert=true;API.del('/tasks/' + t.id).then(function () {mPersonalDraft.clear();if(f.isConnected){mToast('Deleted');MApp.go('tasks');MApp.render();}}).catch(function (ex) { mToast(ex.message, 'err'); }).finally(function(){busy=false;f.inert=false;});
    };
    f.onsubmit = function (e) {
      e.preventDefault();if(busy)return;
      var title = f.querySelector('[data-title]').value.trim();
      if (!title) { mToast('Task title required', 'err'); return; }
      var body = {
        title: title,
        due_date: toStore(f.querySelector('[data-due]').value),
        remind_at: f.querySelector('[data-remind]').value ? new Date(f.querySelector('[data-remind]').value).toISOString() : null,
        notes: f.querySelector('[data-notes]').value.trim() || null,
      };
      if(linked){delete body.title;delete body.notes;}busy=true;f.inert=true;f.querySelector('[type=submit]').disabled=true;
      var p = t ? API.put('/tasks/' + t.id, body) : API.post('/tasks', body);
      p.then(function () { mPersonalDraft.clear();if(f.isConnected){mToast('Saved');MApp.go('tasks');MApp.render();} }).catch(function (ex) { mToast(ex.message || 'Failed', 'err'); }).finally(function(){busy=false;f.inert=false;f.querySelector('[type=submit]').disabled=false;});
    };
    view.appendChild(f);
  }

  MApp.route('tasks', function (view,params) { load(view,params); });
})();
