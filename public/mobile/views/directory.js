/* Staff directory — search colleagues, tap to message. */
MApp.route('directory', function (view) {
  MApp.setTitle('Directory');
  var me = MApp.getMe();
  view.innerHTML = '<input type="search" class="m-input" id="m-dir-q" placeholder="Search name or department" />' +
    '<div id="m-dir-list"><div class="m-hint">Loading…</div></div>';
  var q = view.querySelector('#m-dir-q');
  var listEl = view.querySelector('#m-dir-list');
  var all = [];

  function render() {
    var term = q.value.trim().toLowerCase();
    var rows = all.filter(function (u) {
      return u.id !== me.id && (!term ||
        (u.full_name || '').toLowerCase().indexOf(term) !== -1 ||
        (u.department_name || '').toLowerCase().indexOf(term) !== -1 ||
        (u.role || '').toLowerCase().indexOf(term) !== -1);
    });
    if (!rows.length) { listEl.innerHTML = '<div class="m-empty">No one found.</div>'; return; }
    // group by department
    var groups = {};
    rows.forEach(function (u) { (groups[u.department_name || 'No department'] = groups[u.department_name || 'No department'] || []).push(u); });
    listEl.innerHTML = '';
    Object.keys(groups).sort().forEach(function (dep) {
      listEl.appendChild(mEl('<h3 class="m-sec">' + mEsc(dep) + '</h3>'));
      var ul = mEl('<ul class="m-list"></ul>');
      groups[dep].sort(function (a, b) { return (a.full_name || '').localeCompare(b.full_name || ''); }).forEach(function (u) {
        var li = mEl('<li class="m-list-row"><div><b>' + mEsc(u.full_name) + '</b><span>' +
          mEsc(u.role || '') + '</span></div><div class="m-list-qty">✉️</div></li>');
        li.onclick = function () { mCompose(u.id, u.full_name, ''); };
        ul.appendChild(li);
      });
      listEl.appendChild(ul);
    });
  }

  API.get('/users').then(function (rows) { all = rows || []; render(); })
    .catch(function (ex) { listEl.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  q.addEventListener('input', render);
});
