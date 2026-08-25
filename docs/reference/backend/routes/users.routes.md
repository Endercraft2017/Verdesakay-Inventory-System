# `src/routes/users.routes.ts`

## Purpose
User-account management (directory listing, create/update/reset-password, per-user permission
overrides) and department CRUD. Listing is open to everyone (with a reduced field set for
non-managers); most mutations require `users.manage`, with two department operations also
reachable by `hr.manage`. Mounted at `/api/users`.

## Routes / Exports

`router.use(requireAuth)` (line 19) — every route below requires a valid session.

### Users

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /` | 🔑 any user | — | `SELECT u.id, username, full_name, role, department_id, active, permission_overrides, d.name AS department_name FROM users u LEFT JOIN departments d ...` | Full row list if caller has `users.manage`; otherwise filtered to `active===1` rows projected to `{id, username, full_name, department_name}` only | — |
| `POST /` | 👑 `requirePermission('users.manage')` | `createUserSchema` | Checks `SELECT id FROM users WHERE username = ?`; `bcrypt.hashSync(password, 10)`; `INSERT INTO users (username, full_name, password_hash, role, department_id)` | `201 {id}` | `409 {error:'Username already taken'}` |
| `PUT /:id` | 👑 | `updateUserSchema` | `SELECT * FROM users WHERE id = ?`; merges supplied fields over existing row; last-admin guard (see below); `UPDATE users SET full_name, role, department_id, active`; if deactivated, `DELETE FROM sessions WHERE user_id = ?` | `200 {ok: true}` | `404 {error:'User not found'}`; `400 {error:'Cannot remove the last active administrator'}` |
| `POST /:id/reset-password` | 👑 | `resetPasswordSchema` | `SELECT id FROM users WHERE id = ?`; `bcrypt.hashSync`; `UPDATE users SET password_hash`; `DELETE FROM sessions WHERE user_id = ?` (force re-login) | `200 {ok: true}` | `404 {error:'User not found'}` |
| `PUT /:id/permissions` | 👑 | `permissionOverridesSchema` | `SELECT id FROM users WHERE id = ?`; strips `overrides` down to keys present in `ALL_PERMISSIONS`; `UPDATE users SET permission_overrides = ?` (JSON) | `200 {ok: true}` | `404 {error:'User not found'}` |

### Departments

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /departments/list` | 🔑 any user | — | `SELECT id, name FROM departments ORDER BY name COLLATE NOCASE` | `200 [{id, name}, ...]` | — |
| `POST /departments` | 🔐 `requireAnyPermission(['users.manage', 'hr.manage'])` | `createDepartmentSchema` | Case-insensitive duplicate check (`WHERE name = ? COLLATE NOCASE`); `INSERT INTO departments (name)` | `201 {id, name}` | `409 {error:'Department already exists'}` |
| `GET /departments` | 👑 `requirePermission('users.manage')` | — | Joins per-department usage counts: `user_count`, `item_count`, `form_count` via correlated subqueries | `200 [{id, name, user_count, item_count, form_count}, ...]` | — |
| `PUT /departments/:id` | 👑 | `updateDepartmentSchema` (alias of `createDepartmentSchema`) | Existence check; case-insensitive name-clash check excluding self; `UPDATE departments SET name = ?` | `200 {ok: true}` | `404 {error:'Department not found'}`; `409 {error:'Another department already uses that name'}` |
| `DELETE /departments/:id` | 🔐 `requireAnyPermission(['users.manage', 'hr.manage'])` | — | `users.manage` callers delete unconditionally. `hr.manage`-only callers (i.e. lacking `users.manage`) first check usage counts across `users`/`inventory_items`/`forms` (NOT `employees`) — blocked if any are non-zero. Then `DELETE FROM departments WHERE id = ?` (FK `ON DELETE SET NULL` on referencing tables) | `200 {ok: true}` | `409 {error:'Department is in use outside HR (accounts, items, or files) — ask an admin to remove it'}` (hr.manage-only, in-use case); `404 {error:'Department not found'}` (`info.changes === 0`) |

### Schemas (from `src/validation.ts`)
- `createUserSchema` — `username` (regex `^[a-z0-9._-]{3,30}$`, lower-cased/trimmed), `full_name`
  (1-120 chars), `password` (min 6), `role` (enum of 8 roles, default `'admin_staff'`),
  `department_id` (optional positive int or null).
- `updateUserSchema` — all fields optional: `full_name`, `role`, `department_id`, `active` (boolish).
- `resetPasswordSchema` — `new_password` (min 6).
- `createDepartmentSchema` / `updateDepartmentSchema` — `name` (1-80 chars, trimmed); the two are
  literally the same schema object (`updateDepartmentSchema = createDepartmentSchema`).
- `permissionOverridesSchema` — `{ overrides: Record<string, boolean> }`, capped at 50 keys via
  `.refine`.

## Dependencies
- `express` — `Router`.
- `bcryptjs` — `bcrypt.hashSync` (create user, reset password).
- `../db` — `queryOne`, `queryAll`, `run`.
- `../auth` — `requireAuth`, `requirePermission`, `requireAnyPermission`.
- `../validation` — `parseBody` + the six schemas listed above.
- `../permissions` — `ALL_PERMISSIONS` (used to sanitize the sparse overrides object before storing).
- `../types` — `UserRow`, `Department`.

## Used by
- `src/app.ts` — mounted as `app.use('/api/users', usersRoutes)`.
- `tests/departments.test.ts` — department usage counts, create/rename/delete, duplicate-name
  rejection, FK-set-null-on-delete, and the `users.manage` vs `hr.manage` RBAC split.
- `tests/auth.test.ts` — the last-admin guard and general RBAC on user mutation endpoints.
- `public/js/views/admin.js` — Accounts view: user table, create/edit/reset-password, "Customize
  Permissions" drawer (`PUT /users/:id/permissions`), add department.
- `public/js/views/hr-employees.js` — inline add/delete-department buttons next to the Department
  select (via the shared `hr.manage`-permitted `POST`/`DELETE /users/departments*` endpoints).
- Any view rendering a department `<select>` (e.g. inventory, orders) calls
  `GET /users/departments/list`.

## Notes / gotchas
- `GET /` is intentionally two-tiered: non-managers get a minimal directory (for populating
  message-recipient pickers etc.) without leaking role/department_id/active/permission data;
  managers get everything including the raw `permission_overrides` JSON string (unparsed — the
  frontend is responsible for `JSON.parse`, see `admin.js`).
- The last-active-administrator guard in `PUT /:id` fires on either a demotion (`role !== 'admin'`
  while currently `admin`) or a disable (`active` flipping from 1→0 while currently `admin`), and
  counts *other* active admins (`id != ?`) — it does not block a no-op update to an already-inactive
  or already-non-admin user.
- Deactivating a user (`active` → 0) immediately kills all of that user's sessions
  (`DELETE FROM sessions WHERE user_id = ?`), forcing a hard logout. Password reset does the same.
- `PUT /:id/permissions` filters the incoming `overrides` object down to only real permission keys
  from `ALL_PERMISSIONS` before storing — an attacker (or buggy client) supplying an unknown key
  is silently dropped, not rejected.
- The department-delete RBAC split is asymmetric by design: `hr.manage`-only callers can delete a
  department that is *only* referenced by `employees` (HR's own domain, via `src/routes/hr.routes.ts`)
  since that table isn't part of the usage check here — but are blocked if `users`/`inventory_items`/`forms`
  still reference it. `users.manage` callers bypass this check entirely.
