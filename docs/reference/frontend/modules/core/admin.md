# `public/js/views/admin.js`

## Purpose
Accounts & Departments admin view: lists all user accounts (any of the 8 roles), create/edit accounts, reset passwords, per-user permission overrides, and a department manager (add/rename/delete). Gated entirely on `users.manage`. Reached via the Accounts nav destination.

## Registered route(s)
```js
App.register('admin', async (view, filter) => { ... })
```
- If the caller lacks `users.manage`, the view renders `<div class="empty">You do not have access to this area.</div>` and returns immediately — no further wiring happens.
- `filter.tab === 'departments'` — after the initial user list loads, automatically calls `manageDepartments()` to pop the department manager modal open (used by the "Departments" tree leaf as a deep link).

## Structure / key functions
- **`ROLE_LABELS`** — display labels for the 8 `Role` values, used in the role `<select>` and the user table's role badge.
- **`PERMISSION_GROUPS`** — a frontend-only **presentation/grouping** table (which labeled section each permission key appears under: `Inventory`, `Orders`, `Files`, `Messages`, `Templates`, `HR`, `Admin`) for the Customize Permissions drawer's checkbox layout. This is the only static permission data left in this file — the actual permission *keys* and per-role *defaults* are no longer hand-copied here (see Notes: this used to be a second hand-maintained mirror of `src/shared/permissions.ts` and had drifted, missing `hr.view`/`hr.manage` entirely).
- **`getPermCatalog()`** — lazily fetches `GET /users/permissions/catalog` once per view load (cached in the `permCatalog` closure var) and returns `{ permissions, roleDefaults, groups }`, where `groups` is `PERMISSION_GROUPS` plus an auto-generated `"Other"` group for any backend permission key not covered by a static group (future-proofing: a newly added backend permission is still editable here even before someone updates `PERMISSION_GROUPS`, it just lands in "Other" until grouped).
- **`roleSelect(field, selected)`** / **`deptSelect(field, selected)`** — small `<select>` HTML builders for the 8 roles / `App.getDepartments()` department list.
- **`load()`** — `GET /users` into `allUsers`, then `renderUsers()`.
- **`renderUsers()`** — filters `allUsers` by the current `userQuery` (matches name/username/department/role, case-insensitive substring) and draws the table. Row click (outside the actions cell) opens `editUser`.
- **`addUser()`** — modal: full name, username, role (default `admin_staff`), department, temporary password (min 6, enforced client-side). `POST /users`, reload.
- **`editUser(u)`** — modal: full name, role, department, active/disabled status, plus a "Customize permissions" button that opens `openPermEditor(u)`. `PUT /users/:id` on confirm.
- **`openPermEditor(u)`** — the permission-override drawer (`UI.drawer`), see below.
- **`resetPw(u)`** — modal with a single new-password field (min 6, client-validated); `POST /users/:id/reset-password`. Note text warns this signs the user out of all sessions.
- **`manageDepartments()`** — opens a `UI.modal` with an inner `renderList()` that fetches `GET /users/departments` (usage counts included) and draws Add/Rename/Delete controls.
- **`renameDept(id, current, after)`** / **`deleteDept(id, name, after)`** — department rename/delete modals; both call `App.reloadDepartments()` (refreshes the global department cache used by `App.getDepartments()` elsewhere) and re-run `load()` so the user table's department names stay current.

### Customize Permissions drawer (`openPermEditor`, now `async`)
1. Awaits `getPermCatalog()`, then parses `u.permission_overrides` (JSON string) into a local `overrides` object (`{permKey: true|false}`), and computes `roleDefaults` as a `Set` from `catalog.roleDefaults[u.role]` (backend-sourced, per-role).
2. **`effectivePerms()`** — for every key in `catalog.groups.flatMap(g => g.keys)`: if `overrides[k] === true` it's granted, if `=== false` it's revoked, otherwise it falls back to whether the role default set contains it.
3. **`renderEditor(container)`** — draws one block per `catalog.groups` entry, each key as a checkbox pill showing just the suffix after the dot (e.g. `manage` for `hr.manage`) plus a `★` if `k in overrides` (i.e. explicitly overridden either way). Checkbox `change` handler: if the new checked state matches the role default, it **deletes** the override key (reverts to default); otherwise it sets `overrides[key] = checked`. Then it re-renders the whole editor to refresh the ★ markers.
4. Drawer footer: **Reset to defaults** clears `overrides = {}` and re-renders (not yet persisted); **Save permissions** does `PUT /users/:id/permissions` with `{ overrides }`, then patches the cached `allUsers[idx].permission_overrides` locally so the table/edit-modal stay in sync without a full reload.

## API endpoints used
- `GET /users` — account list.
- `POST /users` — create account.
- `PUT /users/:id` — update name/role/department/active.
- `POST /users/:id/reset-password` — reset password.
- `GET /users/permissions/catalog` — canonical `{ permissions, roleDefaults }` for the permission editor (fetched lazily, once per view load).
- `PUT /users/:id/permissions` — save `{ overrides }`.
- `GET /users/departments` — department list with usage counts (manager view).
- `POST /users/departments` — add department.
- `PUT /users/departments/:id` — rename department.
- `DELETE /users/departments/:id` — delete department (server no-ops the FK to null on referencing rows).

## Permissions honored
- `users.manage` — the entire view is gated on this single permission; there is no finer-grained internal gating (every admin who can open this page can do everything in it, including editing other users' arbitrary permission overrides — even ones for permissions this file doesn't know about, see Notes).

## Dependencies
- `App.register`, `App.hasPermission`, `App.getDepartments`, `App.reloadDepartments`.
- `API` (`get/post/put/del`).
- `UI` (`icon`, `esc`, `modal`, `drawer`, `confirmDialog`, `toast`, `emptyState`).

## Notes / gotchas
- **(Fixed 2026-08-25)** This file used to hand-copy `src/shared/permissions.ts`'s `ROLE_DEFAULTS` and `ALL_PERMISSIONS` as static JS arrays; they'd drifted (missing `hr.view`/`hr.manage` entirely, and `admin_staff` incorrectly listed `forms.manage`), so the Customize Permissions drawer couldn't grant/revoke HR permissions and its ★ indicator could be wrong. Fixed by adding `GET /users/permissions/catalog` (backed directly by `src/shared/permissions.ts`) and having this file fetch it instead of hand-copying — role defaults can no longer drift out of sync with the backend. `PERMISSION_GROUPS` still exists but is now presentation-only (which section a key displays under); any permission key it doesn't know about still shows up, just under an auto-generated "Other" group.
- `openPermEditor`'s Save button does not close the drawer or show any "unsaved changes" warning if the drawer/modal is dismissed without saving.
- `UI.drawer()` is single-instance and keyed — reopening the permission editor for a different user while one is open replaces it (see `ui.js`'s `drawer()` behavior), so no special handling is needed here for that case.
- The department delete confirmation text ("Its members, items and files stay but become unassigned") describes the FK-null-on-delete behavior; the server still enforces `users.manage` (unconditional) vs `hr.manage` (blocked if used outside HR) rules — this view only ever calls it under `users.manage`, so deletes here are always unconditional server-side.
