# Verdesakay Office System — Codebase Reference Map

> **This is the single source of truth for how the code is organized.**
> Before adding code, check here for an existing function/route/type to reuse instead of
> writing a duplicate. **When you change the code, update this file in the same commit.**
> Last verified: 2026-06-30 (Purchase Requests + Form Builder + Global Variables).

---

## 1. Overview

A LAN office system: **inventory**, **forms/files**, **user accounts with roles &
departments**, and **internal messaging**. One PC runs the server; other PCs use it in a
browser.

**Roles & permissions:** 8 roles (`admin`, `admin_staff`, `accounting`, `warehouse`,
`releasing`, `csr`, `hr`, `marketing`) each with granular per-feature permission defaults
defined in `src/permissions.ts`. Admins can override permissions per-individual via the
Accounts UI. Resolved effective permissions are a `Permission[]` on every `AuthUser`.
`forms.manage` (create/edit/delete form definitions + global variables) is admin-only by default.

- **Backend:** Node.js + Express + TypeScript (run with `tsx`, no build step).
- **Database:** SQLite via Node's built-in `node:sqlite` (file: `data.db`).
- **Frontend:** vanilla HTML/CSS/JavaScript SPA in `public/` (no framework, no build).
- **Auth:** bearer session tokens in the `sessions` table (12 h expiry); bcrypt passwords.
- **Validation:** `zod` schemas (`src/validation.ts`). **Security:** `helmet` + login
  rate-limiting. **Tests:** `vitest` + `supertest` (`tests/`).

### Request flow
```
Browser (public/js/*) --fetch--> Express (src/app.ts)
  -> helmet, json/urlencoded, login rate-limit, request log
  -> route (src/routes/*.ts): requireAuth -> requirePermission(key)? -> parseBody(zod)
  -> DB helpers (queryOne/queryAll/run in src/db.ts) -> node:sqlite
  -> JSON response  |  errors -> central handler in app.ts
```

---

## 2. Directory map (every source file, one line each)

### Backend (`/` and `src/`)
| File | Responsibility |
|---|---|
| `server.ts` | Entry point: `init()` DB, schedule session cleanup, `createApp()`, listen on `0.0.0.0:PORT`. |
| `src/app.ts` | **`createApp()`** — builds the Express app: middleware, route mounts, static serving, SPA fallback, central error handler. Imported by both `server.ts` and tests. |
| `src/db.ts` | DB connection + schema (`init()`), `migrate()` (idempotent `ALTER TABLE` for older DBs), seeding, **typed query helpers `queryOne` / `queryAll` / `run`**, **`getSetting`/`setSetting`** (JSON key-value `settings` store), `cleanupSessions()`, `newToken()`, `DB_PATH`/`UPLOAD_DIR` (env-overridable). |
| `src/auth.ts` | Session + RBAC: `createSession`, `destroySession`, `userFromToken` (resolves permissions), `getToken`, **middleware `requireAuth`, `requirePermission(key)`, `requireRole(role)`**. |
| `src/permissions.ts` | `ALL_PERMISSIONS` (19 keys), `ROLE_DEFAULTS` map, **`resolvePermissions(role, overrides)`** — merges sparse `permission_overrides` diff with role defaults. Imported by `auth.ts`. |
| `src/types.ts` | All shared domain types (`Role` 8-variant enum, `Permission` 19-variant union, `UserRow`, `AuthUser` — includes `permissions: Permission[]`, `InventoryItem`, `FormRow`, `MessageRow`, …) + Express `Request` augmentation (`req.user`, `req.token`). |
| `src/validation.ts` | All `zod` request schemas + **`parseBody(schema, data)`** + `ValidationError`. Includes `roleEnum` (all 8 roles) + `permissionOverridesSchema`. |
| `src/routes/auth.routes.ts` | `/api/auth` — login, logout, me, change-password. |
| `src/routes/users.routes.ts` | `/api/users` — list, create, update, reset-password; departments list/create; **`PUT /:id/permissions`** (permission overrides). Guarded by `requirePermission('users.manage')`. |
| `src/routes/inventory.routes.ts` | `/api/inventory` — list/search, stats, detail+history, create, update, **adjust (stock in/out, transactional)**, delete, **`attributes` JSON round-trip**, **`form-config` GET/PUT** (item-form customization). |
| `src/routes/forms.routes.ts` | `/api/forms` — list (dept-visibility), upload (multer), download, delete. |
| `src/routes/messages.routes.ts` | `/api/messages` — inbox/sent, unread-count, send, mark-read, delete. |
| `src/routes/personal.routes.ts` | `/api/notes`, `/api/tasks`, `/api/bookmarks` — per-user CRUD for the right-rail tools (every query scoped to `req.user!.id`). Mounted at `/api`. |
| `src/routes/orders.routes.ts` | `/api/orders` — Job, Sale & Purchase orders CRUD (one router, `?type=sale\|job\|purchase`). Auto numbers (`SO-#####`/`JO-#####`/`PR-#####`) + **server-computed totals**, line items in a transaction. |
| `src/routes/templates.routes.ts` | `/api/templates` — document templates (read 🔑, write 👑) + `/company` profile (read 🔑, write 👑). |
| `src/routes/form-builder.routes.ts` | `/api/form-definitions`, `/api/form-records`, `/api/global-variables` — admin-managed custom form types (with JSON field defs), per-form record CRUD (auto-numbered), and global template variables. |

### Frontend (`public/`)
| File | Responsibility |
|---|---|
| `public/index.html` | App shell: login screen + **ECOUNT-style chrome** (utility bar w/ menu search + site map, top primary menu `#primary-nav`, secondary `#subnav`, workspace = `#tree-nav` \| `#view` \| `#rail`); loads all scripts in order (nav-config before app). |
| `public/js/nav-config.js` | **`NAV`** (declarative 3-tier nav tree: primary → subtabs → leaves) + **`ROUTE_NAMES`**. The single source of truth for navigation; browser global + CommonJS export for tests. |
| `public/js/item-form-config.js` | **`ITEM_FORM_DEFAULTS`** (the ECOUNT-style item field catalog: 7 tabs, per-field type/default/visible/required) + **`ITEM_FORM_TABS`** + **`ITEM_CORE_KEYS`**. Default layout for the New/Edit Item form; admin overrides saved server-side and merged over it. Browser global + CommonJS export for tests. |
| `public/js/doc-template.js` | **`renderTemplate(body, ctx)`** — safe `{{var}}` / `{{#items}}` / `{{#if}}` renderer (HTML-escaped) for printable docs + **`ORDER_VARIABLES`** (editor palette catalog). Browser global + CommonJS for tests. |
| `public/css/styles.css` | All styling (green/blue brand theme via CSS tokens, ECOUNT chrome: util-bar/topnav/subnav/tree/rail, tables, modals, toasts, site map). |
| `public/js/api.js` | **`API`** — fetch wrapper with token handling (`get/post/put/del/upload`), 401 → logout. |
| `public/js/ui.js` | **`UI`** — `esc`, `toast`, `fmtDate/fmtDateShort/fmtBytes`, `initials`, **`modal()`**, `confirmDialog()`, **`drawer()`** (right-docked, single-instance), **`contextMenu(x,y,items)`**, **`helpIcon(text)`** (hover/tap tooltip), **`printDocument(html,title)`/`printableHtml(...)`** (print stylesheet), **`icon(name,size)`** (inline SVG set), **`emptyState(...)`**. |
| `public/js/tools.js` | Right-rail personal tools: **AI assistant** + **Email** (UI-only previews), **Notes** / **Scheduler** (tasks) / **Bookmarks** (per-user, via `/api/notes\|tasks\|bookmarks`), and **right-click-to-bookmark** on nav items. |
| `public/js/app.js` | **`App`** — auth (login/logout/session resume), chrome rendering (`renderPrimaryNav`/`renderSubnav`/`renderTree` from `NAV`), hash router (`register`/**`navigate(name, filter)`**), **`currentLocation()`** (for bookmarks), menu search + site map, unread-badge + tool rail, **theme** (`applyTheme`/`toggleTheme`, persisted in `localStorage('vds_theme')`). **`App.hasPermission(key)`** — checks `me.permissions` array; used by views to conditionally show controls. |
| `public/js/views/dashboard.js` | Dashboard: stats cards, low-stock list, recent messages. |
| `public/js/views/inventory.js` | Inventory table: search/filter, **config-driven 7-tab create/edit modal** (renders from `ITEM_FORM_DEFAULTS` merged with the saved layout; core fields → columns, the rest → `attributes`), **admin "Option" customizer** (show/hide·required·default, saved via `form-config`), stock adjust modal, history modal, delete. Honors `filter.low`. |
| `public/js/views/forms.js` | Forms table: upload modal, authenticated blob download, delete, **Print** (PDF/images in-app; Office = download). |
| `public/js/views/orders.js` | Job, Sale & Purchase orders (route `orders`, `filter.type`): list, create/edit with **inventory-backed line-item editor** (live totals), **Print** (renders the type's template), delete. |
| `public/js/views/form-builder.js` | Form Builder admin view (route `form-builder`): manage form definitions (name, slug, prefix, icon, fields editor) + Global Variables manager. Requires `forms.manage`. |
| `public/js/views/form-records.js` | Form Records view (route `form-records`): without `filter.form_id` shows a form index card grid; with `filter.form_id=X` shows records list + create/edit modal dynamically generated from the form's field definitions. |
| `public/js/views/templates.js` | Document templates (route `templates`): list, editor (variable **palette** + live iframe **preview**), preview/print, admin-only CRUD, **company profile** editor. |
| `public/js/views/messages.js` | Inbox/sent tabs, open/read thread, compose/reply modal, delete. Honors `filter.box` (Inbox/Sent tree leaves). |
| `public/js/views/admin.js` | Accounts (`users.manage` permission): user table with all 8 roles, create/edit/reset-password, add department. Honors `filter.tab==='departments'` (opens manager). Edit user has **"Customize Permissions"** button → `UI.drawer()` with grouped checkboxes per permission key, ★ marks current overrides, Reset/Save via `PUT /users/:id/permissions`. |
| `public/js/views/account.js` | My Account: profile + change own password. |

### Tests (`tests/`)
| File | Covers |
|---|---|
| `tests/helpers.ts` | `setupApp()` (isolated temp DB + uploads), `login`, `createEmployee`, `cleanup`. |
| `tests/unit.test.ts` | zod schemas + bcrypt (pure, no HTTP). |
| `tests/frontend-nav.test.ts` | nav-config sanity: every tree leaf → registered route, admin-only correct, ids unique (loads `nav-config.js` in a sandbox). |
| `tests/item-form-config.test.ts` | item-form catalog sanity: unique keys, valid tabs, core keys ↔ real columns, choice fields have options (sandbox-loads `item-form-config.js`). |
| `tests/auth.test.ts` | login, me, logout, RBAC (`users.manage` guard), last-admin guard, change-password. |
| `tests/inventory.test.ts` | CRUD, stock in/out + history, negative-stock guard, low-stock filter, search, stats, **`attributes` round-trip, `form-config` GET/PUT + admin-only guard**. |
| `tests/forms.test.ts` | upload/download round-trip, department visibility, delete permissions. |
| `tests/messages.test.ts` | send, inbox/sent, unread count, mark-read, self-message guard, delete. |
| `tests/personal.test.ts` | notes/tasks/bookmarks CRUD, **per-user isolation** (no cross-user read/update/delete), auth + validation. |
| `tests/orders.test.ts` | order create (auto number + **server-computed totals**, ignores client totals), list by type, update-replaces-items, delete cascade, validation, auth. Covers `sale`, `job`, `purchase` types. |
| `tests/templates.test.ts` | default seeds, **admin-only** template CRUD, company profile get/put (employee 403). |
| `tests/form-builder.test.ts` | form definition CRUD + auth (`forms.manage` guards), record create/update/delete + auto-numbering per form, cascade on form delete, global variable upsert/delete. |
| `tests/doc-template.test.ts` | renderer: vars, items loop, `{{#if}}` (incl. nested), HTML-escaping, missing-var, palette catalog. |

---

## 3. Data model (SQLite — defined in `src/db.ts` `init()`)

| Table | Key columns | Notes |
|---|---|---|
| `departments` | id, name (unique) | Seeded: Administration, Operations, Finance, Human Resources, IT. |
| `users` | id, username (unique), full_name, password_hash, role (8 variants), department_id→departments, active, **`permission_overrides` (JSON `{}`)** | 8 roles: `admin`, `admin_staff`, `accounting`, `warehouse`, `releasing`, `csr`, `hr`, `marketing`. `permission_overrides` stores only the sparse diff vs role defaults; resolved by `resolvePermissions()` on every request. Seeded admin on first run. |
| `sessions` | token (PK), user_id→users, expires_at | Bearer tokens; cleaned hourly + on demand. |
| `inventory_items` | id, name, sku (unique), category, department_id, quantity, unit, min_quantity, location, notes, **attributes (JSON)** | `quantity <= min_quantity` ⇒ low stock. `attributes` holds the extended ECOUNT-style fields (see `item-form-config.js`); added via `migrate()` on older DBs. |
| `inventory_transactions` | id, item_id→items, user_id, change, balance_after, reason | Append-only stock history; written on create + every adjust. |
| `forms` | id, title, …, stored_name, original_name, department_id (null=all staff), uploaded_by | File on disk in `uploads/`, metadata in DB. |
| `messages` | id, sender_id, recipient_id, subject, body, read_at | Inbox = recipient, Sent = sender. |
| `settings` | key (PK), value (JSON), updated_at | Generic app-wide key-value store (via `getSetting`/`setSetting`). Holds `item_form_config` (the saved item-form layout). |
| `notes` | id, user_id→users (CASCADE), title, body, created_at, updated_at | Per-user notes (right-rail Notes tool). |
| `tasks` | id, user_id→users (CASCADE), title, due_date, done, created_at | Per-user tasks (right-rail Scheduler). |
| `bookmarks` | id, user_id→users (CASCADE), label, route, params (JSON), created_at | Per-user saved nav destinations (right-rail Bookmarks). |
| `orders` | id, type(`sale`\|`job`\|`purchase`), number (unique), customer_*, order_date, status, currency, subtotal, tax_percent, tax_amount, total, created_by | Job/Sale/Purchase order header. Number from `settings` counters (`order_seq_sale\|job\|purchase`); totals computed server-side. |
| `order_items` | id, order_id→orders (CASCADE), item_id→inventory_items (null), name, sku, description, quantity, unit, unit_price, line_total, sort | Order line items; may link an inventory item or be custom. |
| `doc_templates` | id, name, type(`sale`\|`job`\|`purchase`\|`generic`), body (HTML+`{{vars}}`), created_by | Printable templates; default Sale/Job/Purchase seeded on first run. |
| `form_definitions` | id, name, slug (unique), number_prefix, icon, fields (JSON `FieldDef[]`), created_by | Admin-created custom form types. Each field becomes a `{{key}}` template variable. |
| `form_records` | id, form_def_id→form_definitions (CASCADE), number (unique, auto `PREFIX-#####`), data (JSON key→value), status, created_by | Submitted records for any custom form. Auto-numbered per form via `settings` counter `form_seq_<id>`. |
| `global_variables` | key (PK), label, value, updated_by | Admin-managed key-value pairs injectable as `{{global.key}}` in any template. |

Foreign keys are ON; deleting a user/department cascades or nulls as defined per column.

---

## 4. API catalog (the anti-duplication index)

All routes are under `/api`. **Auth** column: 🔓 none · 🔑 any logged-in user · 🔐 specific permission required · 👑 `users.manage` permission (replaces the old "admin only").
Bodies are validated by the named schema in `src/validation.ts`.

| Method & path | Auth | Purpose | Handler | Schema |
|---|---|---|---|---|
| POST `/auth/login` | 🔓 | Log in, return token+user | auth.routes | loginSchema |
| POST `/auth/logout` | 🔑 | Invalidate current token | auth.routes | — |
| GET `/auth/me` | 🔑 | Current user | auth.routes | — |
| POST `/auth/change-password` | 🔑 | Change own password | auth.routes | changePasswordSchema |
| PUT `/auth/profile` | 🔑 | Update own display name | auth.routes | updateProfileSchema |
| GET `/users` | 🔑 | Directory (full fields if `users.manage`) | users.routes | — |
| POST `/users` | 👑 | Create account (any of 8 roles) | users.routes | createUserSchema |
| PUT `/users/:id` | 👑 | Update name/role/dept/active | users.routes | updateUserSchema |
| POST `/users/:id/reset-password` | 👑 | Reset a user's password | users.routes | resetPasswordSchema |
| PUT `/users/:id/permissions` | 👑 | Save sparse permission overrides | users.routes | permissionOverridesSchema |
| GET `/users/departments/list` | 🔑 | List departments (id+name, for selects) | users.routes | — |
| GET `/users/departments` | 👑 | Departments + usage counts (manager) | users.routes | — |
| POST `/users/departments` | 👑 | Add department | users.routes | createDepartmentSchema |
| PUT `/users/departments/:id` | 👑 | Rename department | users.routes | updateDepartmentSchema |
| DELETE `/users/departments/:id` | 👑 | Delete department (FK sets refs null) | users.routes | — |
| GET `/inventory` | 🔑 | List (`?q=`, `?department_id=`, `?category=`, `?low=1`) | inventory.routes | — |
| GET `/inventory/stats` | 🔑 | Dashboard totals | inventory.routes | — |
| GET `/inventory/categories` | 🔑 | Distinct categories (for filters) | inventory.routes | — |
| GET `/inventory/form-config` | 🔑 | Saved item-form layout (or `null`) | inventory.routes | — |
| PUT `/inventory/form-config` | 🔐`inventory.configure` | Save item-form layout (show/hide·required·default) | inventory.routes | formConfigSchema |
| GET `/inventory/:id` | 🔑 | Item (+ parsed `attributes`) + last 50 movements | inventory.routes | — |
| POST `/inventory` | 🔑 | Create item (core cols + `attributes` JSON) | inventory.routes | createItemSchema |
| PUT `/inventory/:id` | 🔑 | Update details + `attributes` (not qty) | inventory.routes | updateItemSchema |
| POST `/inventory/:id/adjust` | 🔑 | Stock in/out (transactional) | inventory.routes | adjustStockSchema |
| DELETE `/inventory/:id` | 🔑 | Delete item + history | inventory.routes | — |
| GET `/forms` | 🔑 | List visible forms | forms.routes | — |
| POST `/forms` | 🔑 | Upload (multipart `file`) | forms.routes | (multipart fields) |
| GET `/forms/:id/download` | 🔑 | Download (visibility-checked) | forms.routes | — |
| DELETE `/forms/:id` | 🔐`forms.delete` | Delete (uploader or `forms.delete` permission) | forms.routes | — |
| GET `/messages?box=` | 🔑 | Inbox or sent | messages.routes | — |
| GET `/messages/unread-count` | 🔑 | Unread badge count | messages.routes | — |
| POST `/messages` | 🔑 | Send message | messages.routes | sendMessageSchema |
| POST `/messages/:id/read` | 🔑 | Mark read | messages.routes | — |
| DELETE `/messages/:id` | 🔑 | Delete (sender/recipient) | messages.routes | — |
| GET/POST `/notes`, PUT/DELETE `/notes/:id` | 🔑 | Per-user notes CRUD (scoped to caller) | personal.routes | noteSchema |
| GET/POST `/tasks`, PUT/DELETE `/tasks/:id` | 🔑 | Per-user tasks CRUD (scoped to caller) | personal.routes | taskSchema / updateTaskSchema |
| GET/POST `/bookmarks`, DELETE `/bookmarks/:id` | 🔑 | Per-user bookmarks (scoped to caller) | personal.routes | bookmarkSchema |
| GET `/orders?type=&q=`, GET `/orders/:id` | 🔑 | List / detail (+items) of Job/Sale orders | orders.routes | — |
| POST `/orders`, PUT `/orders/:id`, DELETE `/orders/:id` | 🔑 | Create (auto number)/update/delete; totals computed server-side; type `sale\|job\|purchase` | orders.routes | create/updateOrderSchema |
| GET `/templates?type=`, GET `/templates/:id` | 🔑 | List / detail document templates | templates.routes | — |
| GET `/form-definitions`, GET `/form-definitions/:id` | 🔑 | List / detail custom form types (fields parsed from JSON) | form-builder.routes | — |
| POST `/form-definitions` | 🔐`forms.manage` | Create form definition | form-builder.routes | formDefinitionSchema |
| PUT `/form-definitions/:id` | 🔐`forms.manage` | Update form definition (name/slug/prefix/icon/fields) | form-builder.routes | formDefinitionSchema |
| DELETE `/form-definitions/:id` | 🔐`forms.manage` | Delete form + cascade records | form-builder.routes | — |
| GET `/form-definitions/:id/records` | 🔑 | List records for a form (`?q=`, `?status=`) | form-builder.routes | — |
| GET `/form-records/:id` | 🔑 | Single record (data parsed, includes form_name) | form-builder.routes | — |
| POST `/form-records` | 🔑 | Create record (auto-numbered per form) | form-builder.routes | createFormRecordSchema |
| PUT `/form-records/:id` | 🔑 | Update record data + status | form-builder.routes | updateFormRecordSchema |
| DELETE `/form-records/:id` | 🔑 | Delete record | form-builder.routes | — |
| GET `/global-variables` | 🔑 | List all global variables | form-builder.routes | — |
| PUT `/global-variables/:key` | 🔐`forms.manage` | Upsert a global variable | form-builder.routes | globalVariableSchema |
| DELETE `/global-variables/:key` | 🔐`forms.manage` | Delete a global variable | form-builder.routes | — |
| POST/PUT/DELETE `/templates(/:id)` | 🔐`templates.edit` | Manage templates | templates.routes | templateSchema |
| GET `/templates/company` · PUT `/templates/company` | 🔑 · 🔐`templates.company` | Company profile for `{{company.*}}` | templates.routes | companyProfileSchema |
| GET `/health` | 🔓 | Liveness check | app.ts | — |

---

## 5. Conventions (follow these to keep the code consistent)

- **DB access:** always go through `queryOne<T>` / `queryAll<T>` / `run` from `src/db.ts`.
  Don't call `db.prepare(...)` directly in routes (the helpers centralize the typed cast).
  Use `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` only for multi-statement transactions
  (see the inventory `adjust` handler).
- **Validation:** every request body is parsed with `parseBody(schema, req.body)`. Add new
  rules as a schema in `src/validation.ts`, never inline in a route.
- **Types:** shared row/response shapes live in `src/types.ts`. Reuse them; don't redefine.
- **Auth:** routers call `router.use(requireAuth)`; feature-gated handlers add
  `requirePermission('permission.key')` from `src/auth.ts` (preferred over the older
  `requireRole('admin')`). Read the caller via `req.user!`. Frontend checks use
  `App.hasPermission('key')`. The permission list lives in `src/permissions.ts`; the sparse
  per-user overrides are stored in `users.permission_overrides` (JSON) and resolved on every
  request in `userFromToken()`.
- **Errors:** return `res.status(n).json({ error: 'message' })`. Thrown `ValidationError`
  (or anything with a numeric `status`) is shaped by the central handler in `app.ts`.
- **Frontend:** views register with `App.register('name', async (view, filter) => {...})` and
  reuse `API`, `UI.modal`, `UI.toast`, `UI.esc`. Always `UI.esc()` user data before inserting
  HTML. The optional `filter` arg comes from the nav tree leaf (deep-link); honor it via the
  view's existing internal state, never duplicate behavior.
- **Navigation:** the chrome (top primary menu, sub-tabs, left tree, site map, menu search) is
  generated entirely from **`NAV` in `public/js/nav-config.js`** — the single source of truth.
  To add/move a destination, edit `NAV` (a leaf = `{label, icon, route, filter?}`); every
  `route` must be a registered view (`ROUTE_NAMES`, enforced by `tests/frontend-nav.test.ts`).
  Do **not** hand-wire nav buttons in `index.html`. Navigate programmatically via
  `App.navigate(route, filter?)`.
- **Icons:** use `UI.icon('name')` (inline SVG, inherits text color) — do not add emoji or
  icon fonts. Add new glyphs to the `ICONS` map in `ui.js`.
- **Theming:** all colors come from CSS variables defined in `public/css/styles.css` under
  `:root`/`[data-theme='light']` (light) and `[data-theme='dark']` (dark). **Never hard-code
  a hex color in a component** — add or reuse a token (`--surface`, `--text`, `--accent`, …)
  so both themes stay correct. The active theme is the `data-theme` attribute on `<html>`,
  set pre-paint by an inline script in `index.html` and toggled via the right icon rail button.
  Empty tab states use `UI.emptyState(...)`.

---

## 6. "How to add X" recipes

**A new API endpoint**
1. Add a zod schema in `src/validation.ts` (if it takes a body).
2. Add the handler to the relevant `src/routes/*.routes.ts`, using `queryOne/queryAll/run`.
3. Add the row/response type to `src/types.ts` if new.
4. Add a test in the matching `tests/*.test.ts`.
5. **Add the row to the API catalog (§4) in this file.**

**A new item field (the common case — no DB change)**
1. Add a field def to `ITEM_FORM_DEFAULTS` in `public/js/item-form-config.js` (pick a `tab`,
   `type`, `default`; leave `core` off). It persists automatically into the `attributes` JSON —
   **no migration, schema, or route change.** Admins can show/hide it via the modal's Option panel.
2. To surface it in the table or filters, read `item.attributes.<key>` in `inventory.js`.

**A new *core* item column (only when it needs its own column — e.g. for SQL filtering)**
1. Add the column to `inventory_items` in `src/db.ts` (and an `ALTER` in `migrate()` for old DBs).
2. Extend `createItemSchema` / `updateItemSchema` and the INSERT/UPDATE in `inventory.routes.ts`.
3. Add the field to `InventoryItem` in `src/types.ts` and add `core: true` + the key to
   `ITEM_CORE_KEYS` in `item-form-config.js`.
4. Update §3 here. (`tests/item-form-config.test.ts` enforces core keys ↔ real columns.)

**A new document/template variable**
1. Add the field to the render context built in `printOrder`/`buildContext`
   ([public/js/views/orders.js](public/js/views/orders.js)) and to the editor `SAMPLE`
   ([public/js/views/templates.js](public/js/views/templates.js)).
2. List it in `ORDER_VARIABLES` ([public/js/doc-template.js](public/js/doc-template.js)) so it
   shows in the palette. Templates reference it as `{{group.key}}` (or `{{key}}` inside `{{#items}}`).

**A new frontend view/page**
1. Create `public/js/views/<name>.js` calling `App.register('<name>', (view, filter) => …)`.
2. Add `<name>` to `ROUTE_NAMES` and add a leaf (and primary/subtab if needed) in
   `public/js/nav-config.js` — do **not** hand-add a button to `index.html`.
3. Add a `<script>` tag for the file in `public/index.html`.
4. Update the frontend map in §2. (`tests/frontend-nav.test.ts` will fail if a leaf points
   to an unregistered route.)

---

## 7. Running, testing, building

| Command | What it does |
|---|---|
| `npm start` | Run the server via `tsx server.ts` (port 3000). |
| `npm run dev` | Same, with file-watch reload. |
| `npm run typecheck` | `tsc --noEmit` strict type check (no errors allowed). |
| `npm test` | Run the whole Vitest suite once, headless. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run check` | typecheck **and** test (use before every commit). |

Tests need no setup: each test file creates its own throwaway SQLite DB + uploads dir via
`setupApp()` and removes them after. See `tests/helpers.ts`.

See also **[DECISIONS.md](DECISIONS.md)** for why these tools were chosen.
