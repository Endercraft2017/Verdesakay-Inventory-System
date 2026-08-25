# `public/js/nav-config.js`

## Purpose
The single source of truth for the app's 3-tier ECOUNT-style navigation chrome (top primary
menu → secondary sub-tabs → left tree sidebar). `app.js` renders the entire chrome, menu
search index, and site map purely by walking this data structure — nothing is hand-wired in
`index.html`.

## Exports / Public API

Two globals, plus a CommonJS export for tests:
```js
if (typeof module !== 'undefined' && module.exports) module.exports = { NAV, ROUTE_NAMES };
```

- **`ROUTE_NAMES`** — flat array of every valid route name:
  `['dashboard', 'inventory', 'forms', 'orders', 'templates', 'messages', 'admin',
  'account', 'form-builder', 'form-records', 'hr', 'hr-employees', 'hr-timekeeping']`.
  Every `route` referenced anywhere in `NAV` must appear in this list — enforced by
  `tests/frontend-nav.test.ts`, which also checks the route is actually registered via
  `App.register` in some `views/*.js` file (both checks run against a sandboxed load).
- **`NAV`** — array of **primary** section objects:
  ```
  primary { id, label, icon, adminOnly?, requiredPermission?, subtabs[] }
    subtab  { id, label, tree[] }
      leaf    { label, icon, route, filter? }
  ```
  - `primary.adminOnly` (legacy boolean) or `primary.requiredPermission` (a `Permission`
    key string, e.g. `'users.manage'`) gate visibility of the whole top-level section —
    checked by `App`'s `visiblePrimaries()`.
  - `subtab.requiredPermission` (present on some subtabs, though none currently defined in
    this file use it beyond the primary-level gate) would gate an individual sub-tab —
    checked by `visibleSubtabs()`.
  - `leaf.filter`, when present, is passed as the second argument to the view's registered
    render function on navigation (e.g. `{ low: '1' }` for the "Low Stock" leaf, or
    `{ type: 'sale' }` for "Sale Orders") — this is how one route (`inventory`, `orders`)
    backs multiple distinct nav destinations.

Current top-level sections (`NAV` ids): `home` (Dashboard), `inventory` (Items / Stock
Movements), `docs` (Files / Orders / Data Forms / Templates), `hr` (Overview / Employees /
Time Keeping), `messages` (Inbox / Sent), `admin` (Accounts / Form Setup — gated on
`users.manage`), `account` (My Account).

## Internal structure
Pure static data — no functions, no logic beyond the dual export guard. The three-level
nesting (`primary → subtab → leaf`) is fixed; there's no recursion or dynamic depth.

## Dependencies
None — this is one of the first three scripts loaded (`api.js`, `ui.js`, `nav-config.js`),
before `item-form-config.js`, `app.js`, and every view.

## Used by
- `public/js/app.js` — `visiblePrimaries()`/`visibleSubtabs()`/`findLeaf()`/`renderPrimaryNav()`/
  `renderSubnav()`/`renderTree()`/`allLeaves()`/`openSiteMap()` all iterate `NAV` directly;
  `navigate()` looks up `NAV.find(p => p.id === activePrimaryId)` for chrome repainting.
- `public/js/tools.js` — `wireBookmarkContextMenu()` reads `NAV` directly (guarded by
  `typeof NAV !== 'undefined'`) to resolve a right-clicked `.primary-item`'s first leaf.
- `tests/frontend-nav.test.ts` — sandbox-loads this file (via Node `vm`, since it's a plain
  browser script with no bundler) and validates: every leaf `route` is in `ROUTE_NAMES` and
  is registered by some view; `admin`-scoped nodes carry the correct gate; all `primary`/
  `subtab` ids are unique.

## Notes / gotchas
- To add or move a nav destination: edit `NAV` here — do **not** hand-add a button in
  `index.html`. Navigate to it programmatically via `App.navigate(route, filter?)`.
- A single `route` can appear in multiple leaves with different `filter` objects (see
  `inventory` and `orders` above) — `App.findLeaf(route, filter)` disambiguates by matching
  the filter, and `App.navigate(route)` with no filter prefers the filter-less leaf if one
  exists (see `app.js`'s `findLeaf` fallback logic).
- The dual browser-global / CommonJS export pattern (`if (typeof module !== 'undefined' &&
  module.exports) { ... }`) is shared by every "pure data/logic" frontend file
  (`item-form-config.js`, `doc-template.js`, `doc-context.js`, `doc-formula.js`,
  `hr-payroll-print.js`, `doc-editor.js`'s pure helpers) specifically so `tests/*.test.ts`
  can `require()` them under Node without a build step, while the browser still sees a
  plain global via `<script>` tag (since `module` is undefined there).
