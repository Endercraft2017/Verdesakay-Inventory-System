/* My requests — file HR requests (leave, OT, reimbursement, …) and track status. */
(function () {
  var STATUS_CLASS = { draft: '', pending: 'warn', approved: 'ok', rejected: 'bad', completed: 'ok', cancelled: '' };

  function list(view) {
    MApp.setTitle('Requests');
    view.innerHTML = '<div class="m-actions"><button class="m-btn" id="m-req-new">＋ New request</button></div>' +
      '<div id="m-req-list"><div class="m-hint">Loading…</div></div>';
    view.querySelector('#m-req-new').onclick = function () { pickType(view); };
    var host = view.querySelector('#m-req-list');
    API.get('/me/requests')
      .then(function (rows) {
        if (!rows.length) { host.innerHTML = '<div class="m-empty">You haven’t filed any requests.</div>'; return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (r) {
          var sc = STATUS_CLASS[r.status] || '';
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(r.form_name) + '</b>' +
            '<span>' + mEsc(r.number) + ' · ' + mEsc((r.created_at || '').slice(0, 10)) + '</span></div>' +
            '<div class="m-list-qty"><span class="m-jo-status ' + sc + '">' + mEsc(r.status || 'draft') + '</span></div></li>'
          );
          li.onclick = function () { detail(view, r); };
          ul.appendChild(li);
        });
        host.innerHTML = '';
        host.appendChild(ul);
      })
      .catch(function (ex) { host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function detail(view, r) {
    MApp.setTitle(r.form_name);
    view.innerHTML = '';
    view.appendChild(mEl('<div class="m-hint">' + mEsc(r.number) + ' · ' +
      mEsc(r.status || 'draft') + ' · filed ' + mEsc((r.created_at || '').slice(0, 10)) + '</div>'));
    var d = r.data || {};
    var rows = Object.keys(d)
      .filter(function (k) { return d[k] != null && String(d[k]).trim() !== '' && typeof d[k] !== 'object'; })
      .map(function (k) {
        return '<li><span>' + mEsc(k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); })) +
          '</span><b>' + mEsc(String(d[k])) + '</b></li>';
      }).join('');
    view.appendChild(mEl('<ul class="m-kv">' + rows + '</ul>'));
    if (d.decision_note) view.appendChild(mEl('<div class="m-hint">Note: ' + mEsc(String(d.decision_note)) + '</div>'));
    var acts = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary" data-back>Back</button></div>');
    acts.querySelector('[data-back]').onclick = function () { list(view); };
    if (r.status === 'pending' || r.status === 'draft') {
      var cancel = mEl('<button class="m-btn m-btn-warn" data-cancel>Cancel request</button>');
      cancel.onclick = function () {
        cancel.disabled = true;
        API.post('/me/requests/' + r.id + '/cancel')
          .then(function () { mToast('Request cancelled'); list(view); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); cancel.disabled = false; });
      };
      acts.appendChild(cancel);
    }
    view.appendChild(acts);
  }

  function pickType(view) {
    MApp.setTitle('New request');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/request-types')
      .then(function (types) {
        view.innerHTML = '';
        if (!types.length) { view.appendChild(mEl('<div class="m-empty">No request forms are set up. Ask HR.</div>')); return; }
        var ul = mEl('<ul class="m-list"></ul>');
        types.forEach(function (t) {
          var li = mEl('<li class="m-list-row"><div><b>' + mEsc(t.name) + '</b></div><div class="m-list-qty">›</div></li>');
          li.onclick = function () { form(view, t); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
        var back = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary">Cancel</button></div>');
        back.querySelector('button').onclick = function () { list(view); };
        view.appendChild(back);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function field(f) {
    var lbl = '<span class="m-label">' + mEsc(f.label) + (f.required ? ' *' : '') + '</span>';
    var k = mEsc(f.key);
    if (f.type === 'textarea') return '<label class="m-field">' + lbl + '<textarea class="m-input" data-k="' + k + '" rows="3"></textarea></label>';
    if (f.type === 'checkbox') return '<label class="m-field m-check"><input type="checkbox" data-k="' + k + '" /> ' + mEsc(f.label) + '</label>';
    if (f.type === 'select' || f.type === 'employee') {
      var opts = (f.options || []).map(function (o) { return '<option>' + mEsc(o) + '</option>'; }).join('');
      return '<label class="m-field">' + lbl + '<select class="m-select" data-k="' + k + '"><option value=""></option>' + opts + '</select></label>';
    }
    var t = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    return '<label class="m-field">' + lbl + '<input class="m-input" type="' + t + '" data-k="' + k + '" /></label>';
  }

  function form(view, t) {
    MApp.setTitle(t.name);
    view.innerHTML = '';
    var emp = (MApp.getMe() || {}).employee || {};
    var AUTOFILL = { employee_name: emp.name, name: emp.name, department: emp.department_name, position: emp.position, employee_no: emp.employee_no };
    var fields = (t.fields || []).filter(function (f) { return !AUTOFILL[f.key]; });
    var f = mEl('<form class="m-form">' + fields.map(field).join('') +
      '<div class="m-actions"><button class="m-btn" type="submit">Submit request</button>' +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></form>');
    f.querySelector('[data-cancel]').onclick = function () { list(view); };

    // prefill defaults
    (t.fields || []).forEach(function (fd) {
      if (fd.default == null || fd.default === '') return;
      var el = f.querySelector('[data-k="' + fd.key + '"]');
      if (el && el.type !== 'checkbox') el.value = fd.default;
    });

    f.onsubmit = function (e) {
      e.preventDefault();
      var data = {};
      Object.keys(AUTOFILL).forEach(function (k) { if (AUTOFILL[k]) data[k] = AUTOFILL[k]; });
      var missing = null;
      (t.fields || []).forEach(function (fd) {
        if (AUTOFILL[fd.key]) return;
        var el = f.querySelector('[data-k="' + fd.key + '"]');
        if (!el) return;
        var v = el.type === 'checkbox' ? (el.checked ? 'Yes' : 'No') : el.value.trim();
        if (fd.required && (v === '' || v === undefined)) missing = missing || fd.label;
        if (v !== '') data[fd.key] = v;
      });
      if (missing) { mToast(missing + ' is required', 'err'); return; }
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      API.post('/form-records', { form_def_id: t.id, data: data, status: 'pending' })
        .then(function () { mToast('Request submitted'); list(view); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
    view.appendChild(f);
  }

  MApp.route('requests', function (view) { list(view); });
})();
