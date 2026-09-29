/* Role kit markup helpers (styles: public/mobile/role-kit.css). Shared by the V2 role screens
   so every role's queue / verify / confirm / blocked / result frames look like one system.
   Every helper returns an HTML string except page(), which mounts the frame and returns the
   body element; interactive bits are wired by the caller. */
(function () {
  var ROLES = {
    warehouse: { label: 'Warehouseman', icon: '/mobile/icons/v2/role-warehouse.svg' },
    lead: { label: 'Production lead', icon: '/mobile/icons/v2/role-production-lead.svg', accent: 'lead' },
    manager: { label: 'Production manager', icon: '/mobile/icons/v2/role-production-manager.svg', accent: 'manager' },
    // QC / QA chips use text glyphs in Figma (69:21 ✓, 72:251 ◆), not icon assets.
    qc: { label: 'QC personnel', glyph: '✓', accent: 'qc' },
    qa: { label: 'QA personnel', glyph: '◆', accent: 'qa' },
  };
  var e = function (s) { return mEsc(s == null ? '' : String(s)); };

  window.RoleUI = {
    /** Mount a role frame: chip + title + subtitle. Returns the body element to fill. */
    page: function (view, opts) {
      var role = ROLES[opts.role] || { label: opts.role, icon: '' };
      if (opts.title) MApp.setTitle(opts.title);
      view.setAttribute('data-figma-node', opts.node || '');
      view.innerHTML = '<section class="rk-page' + (role.accent ? ' rk-accent-' + role.accent : '') + '">' +
        '<header class="rk-head">' +
          (opts.back ? '<button class="rk-back" type="button">‹ ' + e(opts.backLabel || 'Back') + '</button><br>' : '') +
          '<span class="rk-chip">' + (role.icon ? '<img src="' + role.icon + '" alt="">' : role.glyph ? '<span class="glyph" aria-hidden="true">' + role.glyph + '</span>' : '') + e(opts.label || role.label) + '</span>' +
          '<h1>' + e(opts.title) + '</h1>' + (opts.subtitle ? '<p>' + e(opts.subtitle) + '</p>' : '') +
        '</header><div class="rk-body"></div></section>';
      if (opts.back) view.querySelector('.rk-back').onclick = opts.back;
      // Tint the shell (Quick Orbit, active dock tab) for this role; app.js clears it per route.
      if (role.accent) document.documentElement.setAttribute('data-role-accent', role.accent);
      else document.documentElement.removeAttribute('data-role-accent');
      var body = view.querySelector('.rk-body');
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '14px';
      return body;
    },
    hero: function (label, big, note) {
      return '<div class="rk-hero"><small>' + e(label) + '</small><b>' + e(big) + '</b>' + (note ? '<span>' + e(note) + '</span>' : '<span></span>') + '</div>';
    },
    tabs: function (items, active) {
      return '<nav class="rk-tabs" role="tablist">' + items.map(function (t) {
        return '<button type="button" role="tab" data-tab="' + e(t.id) + '"' + (t.id === active ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>' +
          e(t.label) + (t.count != null ? '<b>' + e(t.count) + '</b>' : '') + '</button>';
      }).join('') + '</nav>';
    },
    /** A tappable job card. pill: { text, tone: ''|'warn'|'muted' }; warn: tint the card. */
    jobCard: function (o) {
      return '<button type="button" class="rk-card rk-job' + (o.warn ? ' warn' : '') + '" data-id="' + e(o.id) + '">' +
        '<span class="rk-no">' + e(o.number) + '</span>' +
        (o.pill ? '<span class="rk-pill ' + (o.pill.tone || '') + '">' + e(o.pill.text) + '</span>' : '<span></span>') +
        '<span class="rk-name">' + e(o.name) + '</span>' +
        '<span class="rk-meta">' + e(o.meta) + '</span>' +
        '<img class="rk-go" src="/mobile/icons/v2/open-chevron.svg" alt=""></button>';
    },
    jobHead: function (o) {
      return '<div class="rk-jobhead' + (o.tone ? ' ' + o.tone : '') + '"><span class="rk-no">' + e(o.number) + '</span>' +
        (o.pill ? '<span class="rk-pill ' + (o.pill.tone || 'muted') + '">' + e(o.pill.text) + '</span>' : '<span></span>') +
        '<span class="rk-name">' + e(o.name) + '</span>' + (o.meta ? '<span class="rk-meta">' + e(o.meta) + '</span>' : '') + '</div>';
    },
    field: function (label, value, tint) {
      return '<div class="rk-card rk-field' + (tint ? ' tint' : '') + '"><small>' + e(label) + '</small><b>' + e(value) + '</b></div>';
    },
    section: function (text) { return '<h2 class="rk-section">' + e(text) + '</h2>'; },
    /** rows: [{ name, qty, ok }] — ok false marks a short line. */
    lines: function (rows, foot) {
      return '<div class="rk-card rk-lines">' + rows.map(function (r) {
        return '<div class="rk-line' + (r.ok === false ? ' short' : '') + '"><span>' + e(r.name) + '</span><em>' + e(r.qty) + '</em>' +
          '<img src="/mobile/icons/v2/' + (r.ok === false ? 'short' : 'check-ok') + '.svg" alt="' + (r.ok === false ? 'Short' : 'OK') + '"></div>';
      }).join('') + (foot ? '<div class="rk-foot">' + e(foot) + '</div>' : '') + '</div>';
    },
    note: function (tone, html) { return '<div class="rk-note ' + tone + '">' + html + '</div>'; },
    alert: function (title, text) {
      return '<div class="rk-alert"><img src="/mobile/icons/v2/alert.svg" alt=""><b>' + e(title) + '</b><span>' + e(text) + '</span></div>';
    },
    check: function (id, text) {
      return '<label class="rk-check"><input type="checkbox" id="' + e(id) + '"><span>' + e(text) + '</span></label>';
    },
    success: function (title, lines) {
      return '<div class="rk-success"><i></i><b>' + e(title) + '</b>' + lines.map(function (l) { return '<span>' + e(l) + '</span>'; }).join('') + '</div>';
    },
    /** buttons: [{ id, label, kind: 'primary'|'secondary', icon? }] */
    actions: function (buttons) {
      return '<div class="rk-actions">' + buttons.map(function (b) {
        return '<button type="button" class="rk-btn ' + (b.kind || 'primary') + '" id="' + e(b.id) + '">' + e(b.label) +
          (b.icon ? '<img src="' + b.icon + '" alt="">' : '') + '</button>';
      }).join('') + '</div>';
    },
    skeleton: function (n) { var s = ''; for (var i = 0; i < (n || 3); i++) s += '<div class="rk-skel"></div>'; return s; },
    /** Error with retry — offline gets its own wording. Returns an element. */
    error: function (err, retry) {
      var box = mEl('<div class="rk-error">' + e(err && err.offline ? 'You’re offline — this needs a connection.' : (err && err.message) || 'Something went wrong') +
        (retry ? ' <button type="button" class="m-btn m-btn-sm">Try again</button>' : '') + '</div>');
      if (retry) box.querySelector('button').onclick = retry;
      return box;
    },
  };
})();
