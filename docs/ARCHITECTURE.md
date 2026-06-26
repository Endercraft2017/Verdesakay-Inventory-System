# Verdesakay Office System — Codebase Reference Map

> **This is the single source of truth for how the code is organized.**
> Before adding code, check here for an existing function/route/type to reuse instead of
> writing a duplicate. **When you change the code, update this file in the same commit.**
> Last verified: 2026-06-25.

---

## 1. Overview

A LAN office system: **inventory**, **forms/files**, **user accounts with roles &
departments**, and **internal messaging**. One PC runs the server; other PCs use it in a
browser.

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
  -> route (src/routes/*.ts): requireAuth -> requireRole? -> parseBody(zod)
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
| `src/auth.ts` | Session + RBAC: `createSession`, `destroySession`, `userFromToken`, `getToken`, **middleware `requireAuth`, `requireRole(role)`**. |
| `src/types.ts` | All shared domain types (`UserRow`, `AuthUser`, `InventoryItem`, `FormRow`, `MessageRow`, …) + Express `Request` augmentation (`req.user`, `req.token`). |
| `src/validation.ts` | All `zod` request schemas + **`parseBody(schema, data)`** + `ValidationError`. |
| `src/routes/auth.routes.ts` | `/api/auth` — login, logout, me, change-password. |
| `src/routes/users.routes.ts` | `/api/users` — list, create, update, reset-password; departments list/create. |
| `src/routes/inventory.routes.ts` | `/api/inventory` — list/search, stats, detail+history, create, update, **adjust (stock in/out, transactional)**, delete, **`attributes` JSON round-trip**, **`form-config` GET/PUT** (item-form customization). |
| `src/routes/forms.routes.ts` | `/api/forms` — list (dept-visibility), upload (multer), download, delete. |
| `src/routes/messages.routes.ts` | `/api/messages` — inbox/sent, unread-count, send, mark-read, delete. |

### Frontend (`public/`)
| File | Responsibility |
|---|---|
| `public/index.html` | App shell: login screen + **ECOUNT-style chrome** (utility bar w/ menu search + site map, top primary menu `#primary-nav`, secondary `#subnav`, workspace = `#tree-nav` \| `#view` \| `#rail`); loads all scripts in order (nav-config before app). |
| `public/js/nav-config.js` | **`NAV`** (declarative 3-tier nav tree: primary → subtabs → leaves) + **`ROUTE_NAMES`**. The single source of truth for navigation; browser global + CommonJS export for tests. |
| `public/js/item-form-config.js` | **`ITEM_FORM_DEFAULTS`** (the ECOUNT-style item field catalog: 7 tabs, per-field type/default/visible/required) + **`ITEM_FORM_TABS`** + **`ITEM_CORE_KEYS`**. Default layout for the New/Edit Item form; admin overrides saved server-side and merged over it. Browser global + CommonJS export for tests. |
| `public/css/styles.css` | All styling (green/blue brand theme via CSS tokens, ECOUNT chrome: util-bar/topnav/subnav/tree/rail, tables, modals, toasts, site map). |
| `public/js/api.js` | **`API`** — fetch wrapper with token handling (`get/post/put/del/upload`), 401 → logout. |
| `public/js/ui.js` | **`UI`** — `esc`, `toast`, `fmtDate/fmtDateShort/fmtBytes`, `initials`, **`modal()`**, `confirmDialog()`, **`icon(name,size)`** (inline SVG set), **`emptyState({icon,title,hint,action})`**. |
| `public/js/app.js` | **`App`** — auth (login/logout/session resume), chrome rendering (`renderPrimaryNav`/`renderSubnav`/`renderTree` from `NAV`), hash router (`register`/**`navigate(name, filter)`**), menu search + site map, unread-badge (on rail), **theme** (`applyTheme`/`toggleTheme`, persisted in `localStorage('vds_theme')`). |
| `public/js/views/dashboard.js` | Dashboard: stats cards, low-stock list, recent messages. |
| `public/js/views/inventory.js` | Inventory table: search/filter, **config-driven 7-tab create/edit modal** (renders from `ITEM_FORM_DEFAULTS` merged with the saved layout; core fields → columns, the rest → `attributes`), **admin "Option" customizer** (show/hide·required·default, saved via `form-config`), stock adjust modal, history modal, delete. Honors `filter.low`. |
| `public/js/views/forms.js` | Forms table: upload modal, authenticated blob download, delete. |
| `public/js/views/messages.js` | Inbox/sent tabs, open/read thread, compose/reply modal, delete. Honors `filter.box` (Inbox/Sent tree leaves). |
| `public/js/views/admin.js` | Accounts (admin): user table, create/edit/reset-password, add department. Honors `filter.tab==='departments'` (opens manager). |
| `public/js/views/account.js` | My Account: profile + change own password. |

### Tests (`tests/`)
| File | Covers |
|---|---|
| `tests/helpers.ts` | `setupApp()` (isolated temp DB + uploads), `login`, `createEmployee`, `cleanup`. |
| `tests/unit.test.ts` | zod schemas + bcrypt (pure, no HTTP). |
| `tests/frontend-nav.test.ts` | nav-config sanity: every tree leaf → registered route, admin-only correct, ids unique (loads `nav-config.js` in a sandbox). |
| `tests/item-form-config.test.ts` | item-form catalog sanity: unique keys, valid tabs, core keys ↔ real columns, choice fields have options (sandbox-loads `item-form-config.js`). |
| `tests/auth.test.ts` | login, me, logout, RBAC, last-admin guard, change-password. |
| `tests/inventory.test.ts` | CRUD, stock in/out + history, negative-stock guard, low-stock filter, search, stats, **`attributes` round-trip, `form-config` GET/PUT + admin-only guard**. |
| `tests/forms.test.ts` | upload/download round-trip, department visibility, delete permissions. |
| `tests/messages.test.ts` | send, inbox/sent, unread count, mark-read, self-message guard, delete. |

---

## 3. Data model (SQLite — defined in `src/db.ts` `init()`)

| Table | Key columns | Notes |
|---|---|---|
| `departments` | id, name (unique) | Seeded: Administration, Operations, Finance, Human Resources, IT. |
| `users` | id, username (unique), full_name, password_hash, role(`admin`\|`employee`), department_id→departments, active | Seeded admin on first run. |
| `sessions` | token (PK), user_id→users, expires_at | Bearer tokens; cleaned hourly + on demand. |
| `inventory_items` | id, name, sku (unique), category, department_id, quantity, unit, min_quantity, location, notes, **attributes (JSON)** | `quantity <= min_quantity` ⇒ low stock. `attributes` holds the extended ECOUNT-style fields (see `item-form-config.js`); added via `migrate()` on older DBs. |
| `inventory_transactions` | id, item_id→items, user_id, change, balance_after, reason | Append-only stock history; written on create + every adjust. |
| `forms` | id, title, …, stored_name, original_name, department_id (null=all staff), uploaded_by | File on disk in `uploads/`, metadata in DB. |
| `messages` | id, sender_id, recipient_id, subject, body, read_at | Inbox = recipient, Sent = sender. |
| `settings` | key (PK), value (JSON), updated_at | Generic app-wide key-value store (via `getSetting`/`setSetting`). Holds `item_form_config` (the saved item-form layout). |

Foreign keys are ON; deleting a user/department cascades or nulls as defined per column.

---

## 4. API catalog (the anti-duplication index)

All routes are under `/api`. **Auth** column: 🔓 none · 🔑 any logged-in user · 👑 admin only.
Bodies are validated by the named schema in `src/validation.ts`.

| Method & path | Auth | Purpose | Handler | Schema |
|---|---|---|---|---|
| POST `/auth/login` | 🔓 | Log in, return token+user | auth.routes | loginSchema |
| POST `/auth/logout` | 🔑 | Invalidate current token | auth.routes | — |
| GET `/auth/me` | 🔑 | Current user | auth.routes | — |
| POST `/auth/change-password` | 🔑 | Change own password | auth.routes | changePasswordSchema |
| PUT `/auth/profile` | 🔑 | Update own display name | auth.routes | updateProfileSchema |
| GET `/users` | 🔑 | Directory (admins get full fields) | users.routes | — |
| POST `/users` | 👑 | Create account | users.routes | createUserSchema |
| PUT `/users/:id` | 👑 | Update name/role/dept/active | users.routes | updateUserSchema |
| POST `/users/:id/reset-password` | 👑 | Reset a user's password | users.routes | resetPasswordSchema |
| GET `/users/departments/list` | 🔑 | List departments (id+name, for selects) | users.routes | — |
| GET `/users/departments` | 👑 | Departments + usage counts (manager) | users.routes | — |
| POST `/users/departments` | 👑 | Add department | users.routes | createDepartmentSchema |
| PUT `/users/departments/:id` | 👑 | Rename department | users.routes | updateDepartmentSchema |
| DELETE `/users/departments/:id` | 👑 | Delete department (FK sets refs null) | users.routes | — |
| GET `/inventory` | 🔑 | List (`?q=`, `?department_id=`, `?category=`, `?low=1`) | inventory.routes | — |
| GET `/inventory/stats` | 🔑 | Dashboard totals | inventory.routes | — |
| GET `/inventory/categories` | 🔑 | Distinct categories (for filters) | inventory.routes | — |
| GET `/inventory/form-config` | 🔑 | Saved item-form layout (or `null`) | inventory.routes | — |
| PUT `/inventory/form-config` | 👑 | Save item-form layout (show/hide·required·default) | inventory.routes | formConfigSchema |
| GET `/inventory/:id` | 🔑 | Item (+ parsed `attributes`) + last 50 movements | inventory.routes | — |
| POST `/inventory` | 🔑 | Create item (core cols + `attributes` JSON) | inventory.routes | createItemSchema |
| PUT `/inventory/:id` | 🔑 | Update details + `attributes` (not qty) | inventory.routes | updateItemSchema |
| POST `/inventory/:id/adjust` | 🔑 | Stock in/out (transactional) | inventory.routes | adjustStockSchema |
| DELETE `/inventory/:id` | 🔑 | Delete item + history | inventory.routes | — |
| GET `/forms` | 🔑 | List visible forms | forms.routes | — |
| POST `/forms` | 🔑 | Upload (multipart `file`) | forms.routes | (multipart fields) |
| GET `/forms/:id/download` | 🔑 | Download (visibility-checked) | forms.routes | — |
| DELETE `/forms/:id` | 🔑 | Delete (uploader/admin) | forms.routes | — |
| GET `/messages?box=` | 🔑 | Inbox or sent | messages.routes | — |
| GET `/messages/unread-count` | 🔑 | Unread badge count | messages.routes | — |
| POST `/messages` | 🔑 | Send message | messages.routes | sendMessageSchema |
| POST `/messages/:id/read` | 🔑 | Mark read | messages.routes | — |
| DELETE `/messages/:id` | 🔑 | Delete (sender/recipient) | messages.routes | — |
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
- **Auth:** routers call `router.use(requireAuth)`; admin-only handlers add
  `requireRole('admin')`. Read the caller via `req.user!`.
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
