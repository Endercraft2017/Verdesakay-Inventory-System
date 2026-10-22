/* Staff directory — search colleagues, tap to message. */
MApp.route('directory', function (view) {
  MApp.setTitle('Directory');
  var me = MApp.getMe() || {};
  view.innerHTML = '<label class="m-field"><span class="m-label">Search colleagues</span><input type="search" class="m-input" id="m-dir-q" placeholder="Search name or department" /></label>' +
    '<div id="m-dir-list"></div>';
  var q = view.querySelector('#m-dir-q'), listEl = view.querySelector('#m-dir-list');
  var all = [], loading = false, error = null;
  function render() {
    if (!listEl.isConnected) return;
    if (loading) { listEl.innerHTML = '<div class="m-hint" role="status">Loading directory…</div>'; return; }
    if (error) {
      listEl.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load the directory') + '</div><button class="m-btn m-btn-secondary" type="button">Try again</button>';
      listEl.querySelector('button').onclick = load; return;
    }
    var term = q.value.trim().toLowerCase();
    var rows = all.filter(function (u) {
      return String(u.id) !== String(me.id) && (!term ||
        (u.full_name || '').toLowerCase().indexOf(term) !== -1 ||
        (u.department_name || '').toLowerCase().indexOf(term) !== -1 ||
        (u.role || '').toLowerCase().indexOf(term) !== -1);
    });
    if (!rows.length) { listEl.innerHTML = '<div class="m-empty">' + (term ? 'No one found. Try another search.' : 'No other employees are available.') + '</div>'; return; }
    var groups = Object.create(null);
    rows.forEach(function (u) { (groups[u.department_name || 'No department'] = groups[u.department_name || 'No department'] || []).push(u); });
    listEl.innerHTML = '';
    Object.keys(groups).sort().forEach(function (dep) {
      listEl.appendChild(mEl('<h3 class="m-sec">' + mEsc(dep) + '</h3>'));
      var ul = mEl('<ul class="m-list"></ul>');
      groups[dep].sort(function (a, b) { return (a.full_name || '').localeCompare(b.full_name || ''); }).forEach(function (u) {
        var li = mEl('<li><button type="button" class="m-list-row m-directory-person" aria-label="Message ' + mEsc(u.full_name) + '"><div><b>' + mEsc(u.full_name) + '</b><span>' +
          mEsc(u.role || '') + '</span></div><div class="m-list-qty" aria-hidden="true">✉️</div></button></li>');
        li.querySelector('button').onclick = function () { if (this.disabled) return; this.disabled = true; mCompose(u.id, u.full_name); };
        ul.appendChild(li);
      });
      listEl.appendChild(ul);
    });
  }
  function load() {
    if (loading || !listEl.isConnected) return;
    loading = true; error = null; render();
    API.get('/users').then(function (rows) { all = rows || []; })
      .catch(function (ex) { error = ex; }).finally(function () { loading = false; render(); });
  }
  q.addEventListener('input', render); load();
});
