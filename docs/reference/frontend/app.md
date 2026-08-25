# `public/js/app.js`

## Purpose
The application controller: authentication/session lifecycle, the ECOUNT-style chrome
(top primary menu, secondary sub-tabs, left tree, menu search, site map), the hash-based
router, theme toggling, and the permission-check helper views use to conditionally render
controls. Everything else (`views/*.js`) registers into this via `App.register`.

## Exports / Public API

Attached as the global `const App` (IIFE). `document.addEventListener('DOMContentLoaded',
() => App.boot())` at the bottom is what actually starts the app.

```js
{ register, navigate, getMe, getDepartments, isAdmin, hasPermission, showLogin,
  refreshUnread, logout, boot, reloadDepartments, setMe, currentLocation,
  _routeNames /* test/debug seam */ }
```

- **`register(name, renderFn)`** — adds `renderFn` to the internal `routes` map. Every
  view file calls this once at load time: `App.register('inventory', async (view, filter)
  => {...})`. `renderFn(viewEl, filter)` is called by `navigate()` and may return a Promise.
- **`navigate(name, filter)`** — the router's core entry point. If `name` isn't a
  registered route, falls back to `'dashboard'` with `filter` cleared. Resolves the nav-tree
  location for chrome highlighting via `findLeaf`, updates `location.hash` (guarded by
  `suppressHash` so this doesn't re-trigger the `hashchange` listener), repaints the
  primary/subnav/tree chrome, then renders the view: sets `#view` to a loading placeholder
  and calls `routes[name](view, filter)`, catching failures into an inline error message.
- **`getMe()`** → the current user object (or `null` if logged out).
- **`getDepartments()`** → cached `[{id, name}]` list (refreshed on login and via
  `reloadDepartments()`).
- **`isAdmin()`** → `me && me.role === 'admin'`. Prefer `hasPermission()` for feature
  gating; `isAdmin()` remains for the few legacy `adminOnly` nav checks.
- **`hasPermission(key)`** → `me.permissions.includes(key)`. The primary authorization
  check views use to show/hide controls (mirrors backend `requirePermission`).
- **`showLogin()`** — clears `me`, hides `#app-screen`, shows `#login-screen`, clears the
  password field.
- **`refreshUnread()`** — `GET /messages/unread-count`, updates the `#msg-badge` element's
  text and visibility. Called on `showApp()` and every 20s via `App._unreadTimer`
  (`setInterval`, cleared on logout/re-login).
- **`logout()`** — `POST /auth/logout` (best-effort, errors swallowed), clears the token,
  clears the unread-badge interval, shows the login screen.
- **`boot()`** — one-time startup: wires the login form submit handler, wires the utility
  bar (menu search icon, site-map button, pin glyph), wires the right icon rail (messages,
  account, logout, theme toggle), sets the theme icon to match the persisted/system theme,
  wires `hashchange` for back/forward navigation, then attempts session resume via
  `API.getToken()` + `GET /auth/me` — on success calls `showApp()`; on any failure (or no
  token) clears the token and shows the login screen.
- **`reloadDepartments()`** — re-fetches `/users/departments/list` into the `departments`
  cache; swallows errors (leaves the previous cache in place). Used after department
  create/rename/delete in admin views.
- **`setMe(patch)`** — shallow-merges `patch` into `me` and refreshes the `#me-name`/
  `#me-avatar` chrome elements. Used after the current user edits their own profile
  (`views/account.js`) so the header reflects the change without a full re-login.
- **`currentLocation()`** → `{ route, filter, label }` describing where the user currently
  is (parses `location.hash`, resolves the matching nav leaf for a human-readable
  breadcrumb label like `"Documents › Templates"`). Used by `tools.js`'s "Bookmark current
  page" action.
- **`_routeNames()`** — test/debug seam returning `Object.keys(routes)`; not used by
  production code.

## Internal structure

### Module state
- `me` — the logged-in user object (`null` when logged out), including its resolved
  `permissions: Permission[]` array (see `src/permissions.ts`).
- `departments` — cached department list for selects.
- `routes` — `{ [name]: renderFn }`, populated by every view file's `App.register(...)`
  call at script-load time (before `boot()` runs, since all `<script>` tags load
  synchronously in `index.html` before `DOMContentLoaded` fires).
- `activePrimaryId` / `activeSubtabId` — which chrome sections are currently highlighted;
  set by `navigate()` via `findLeaf()`.
- `suppressHash` — guards against the `hashchange` listener re-navigating when `navigate()`
  itself sets `location.hash` programmatically.

### Theme (`currentTheme`, `applyTheme`, `toggleTheme`)
- Theme state lives entirely as the `data-theme` attribute on `<html>` (read by
  `currentTheme()`, set by `applyTheme(theme)`) — CSS in `styles.css` keys off this
  attribute. `applyTheme` also swaps the `#theme-btn` icon to show the icon for the theme
  you'd switch **to** (sun icon while in dark mode, moon icon while in light mode).
- `toggleTheme()` persists the choice to `localStorage['vds_theme']` before applying it.
  The *initial* theme (before `App` even runs) is set by an inline `<script>` in
  `index.html` itself (pre-paint, to avoid a flash of the wrong theme) — `app.js` only
  handles the *toggle* and keeping the button icon in sync.

### Nav-config helpers (`visiblePrimaries`, `visibleSubtabs`, `findLeaf`, `filtersEqual`)
- `visiblePrimaries()` filters the global `NAV` array by `p.adminOnly` (legacy, checks
  `isAdmin()`) and `p.requiredPermission` (checks `hasPermission()`).
- `visibleSubtabs(primary)` filters a primary's `subtabs` by `s.requiredPermission`.
- `filtersEqual(a, b)` — shallow, string-coerced equality of two filter objects (used to
  decide whether a nav leaf is "active" and to match a leaf when both `route` and `filter`
  are given).
- `findLeaf(route, filter)` — walks the full `NAV` tree (primary → subtab → leaf) looking
  for a leaf matching `route` (and `filter`, if given). If `filter === undefined`, returns
  the first leaf with *no* filter if one exists, else falls back to the very first leaf
  matching the route at all (tracked as `routeFallback`). This lets `navigate('inventory')`
  (no filter) land on "All Items" rather than "Low Stock" even though both point to the
  `inventory` route.

### Hash ⇄ location (`hashFor`, `parseHash`)
- URL shape: `#route` or `#route?key=value&key2=value2` (filter object flattened to a
  query string, values URI-encoded). `parseHash()` is the inverse, defaulting to
  `{ route: 'dashboard', filter: undefined }` when the hash is empty.

### Chrome rendering (`renderPrimaryNav`, `selectPrimary`, `renderSubnav`, `renderTree`,
`setActivePrimaryHighlight`)
- `renderPrimaryNav()` rebuilds `#primary-nav` from `visiblePrimaries()`; called once from
  `showApp()` (after `me`/`departments` load, since visibility depends on permissions).
- `selectPrimary(id)` — clicking a primary button navigates to its first subtab's first
  leaf (`primary.subtabs[0].tree[0]`).
- `renderSubnav(primary)` / `renderTree(primary, subtab, activeRoute, activeFilter)` are
  called on every `navigate()` to repaint the secondary tab row and left tree for the
  now-active primary/subtab, with active-state classes computed via `filtersEqual`.

### Menu search + site map (`allLeaves`, `wireMenuSearch`, `openSiteMap`)
- `allLeaves()` flattens the entire visible nav tree into `{ primary, subtab, leaf, path }`
  entries (`path` = `"Primary › Leaf"` breadcrumb string) — the search index.
- `wireMenuSearch()` wires the `#menu-search` input: filters `allLeaves()` by substring
  match on `path` (case-insensitive), shows up to 8 results in `#menu-search-results`,
  `Enter` activates the first result, `Escape` closes and blurs, and clicking outside
  `.menu-search` closes the dropdown.
- `openSiteMap()` renders every visible primary/subtab/leaf as a full grid in a `UI.modal`
  (triggered by the utility bar's site-map button) — a complete, browsable index of the app.

## Dependencies
Requires `API`, `UI`, and the globals `NAV`/`ROUTE_NAMES` (from `nav-config.js`) to already
be loaded — confirmed by script order in `index.html`: `api.js`, `ui.js`, `nav-config.js`,
`item-form-config.js`, `doc-*.js`, `hr-payroll-print.js`, **then** `app.js`, then every
`views/*.js` file (which call `App.register` at load time), then `tools.js` last.

## Used by
Every `views/*.js` file calls `App.register(...)` and, inside their render functions,
`App.hasPermission`, `App.navigate`, `App.getMe`, `App.getDepartments`, etc. `tools.js`
calls `App.navigate` (bookmark clicks, rail buttons) and `App.currentLocation()`
(bookmarking the current page). `api.js` calls `window.App.showLogin()` on a 401.

## Notes / gotchas
- `App.register` calls happen at **script-load time**, synchronously, before
  `DOMContentLoaded`/`App.boot()` runs — so the `routes` map is always fully populated by
  the time `boot()` needs it, as long as every view's `<script>` tag appears before
  `App.boot()` is invoked (i.e., anywhere in `index.html`, since `boot()` only runs on
  `DOMContentLoaded`).
- `navigate()` treats an unregistered route as a hard fallback to `'dashboard'` with the
  filter cleared — a stale/bad bookmark or hand-edited hash can never leave the app in a
  broken navigation state.
- The tree/subnav "active" highlighting depends on `filtersEqual`, which does a **shallow,
  string-coerced** comparison — nested filter objects would not compare correctly (not
  currently a problem since all `NAV` leaf filters are flat `{key: 'stringValue'}`).
- Programmatic hash updates set `suppressHash = true` around the `location.hash =`
  assignment specifically so the `hashchange` listener (used for browser back/forward and
  manual hash edits) doesn't double-navigate.
