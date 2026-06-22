# Verdesakay Office System — Codebase Reference Map

> **This is the single source of truth for how the code is organized.**
> Before adding code, check here for an existing function/route/type to reuse instead of
> writing a duplicate. **When you change the code, update this file in the same commit.**
> Last verified: 2026-06-20.

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
| `src/db.ts` | DB connection + schema (`init()`), seeding, **typed query helpers `queryOne` / `queryAll` / `run`**, `cleanupSessions()`, `newToken()`, `DB_PATH`/`UPLOAD_DIR` (env-overridable). |
| `src/auth.ts` | Session + RBAC: `createSession`, `destroySession`, `userFromToken`, `getToken`, **middleware `requireAuth`, `requireRole(role)`**. |
| `src/types.ts` | All shared domain types (`UserRow`, `AuthUser`, `InventoryItem`, `FormRow`, `MessageRow`, …) + Express `Request` augmentation (`req.user`, `req.token`). |
| `src/validation.ts` | All `zod` request schemas + **`parseBody(schema, data)`** + `ValidationError`. |
| `src/routes/auth.routes.ts` | `/api/auth` — login, logout, me, change-password. |
| `src/routes/users.routes.ts` | `/api/users` — list, create, update, reset-password; departments list/create. |
| `src/routes/inventory.routes.ts` | `/api/inventory` — list/search, stats, detail+history, create, update, **adjust (stock in/out, transactional)**, delete. |
| `src/routes/forms.routes.ts` | `/api/forms` — list (dept-visibility), upload (multer), download, delete. |
| `src/routes/messages.routes.ts` | `/api/messages` — inbox/sent, unread-count, send, mark-read, delete. |

### Frontend (`public/`)
| File | Responsibility |
|---|---|
| `public/index.html` | App shell: login screen + sidebar nav + `#view` container; loads all scripts in order. |
| `public/css/styles.css` | All styling (green brand theme, layout, tables, modals, toasts, messages). |
| `public/js/api.js` | **`API`** — fetch wrapper with token handling (`get/post/put/del/upload`), 401 → logout. |
| `public/js/ui.js` | **`UI`** — `esc`, `toast`, `fmtDate/fmtDateShort/fmtBytes`, `initials`, **`modal()`**, `confirmDialog()`, **`icon(name,size)`** (inline SVG set), **`emptyState({icon,title,hint,action})`**. |
| `public/js/app.js` | **`App`** — auth (login/logout/session resume), hash router (`register`/`navigate`), shell wiring, unread-badge polling, **theme** (`applyTheme`/`toggleTheme`, persisted in `localStorage('vds_theme')`). |
| `public/js/views/dashboard.js` | Dashboard: stats cards, low-stock list, recent messages. |
| `public/js/views/inventory.js` | Inventory table: search/filter, create/edit modal, stock adjust modal, history modal, delete. |
| `public/js/views/forms.js` | Forms table: upload modal, authenticated blob download, delete. |
| `public/js/views/messages.js` | Inbox/sent tabs, open/read thread, compose/reply modal, delete. |
| `public/js/views/admin.js` | Accounts (admin): user table, create/edit/reset-password, add department. |
| `public/js/views/account.js` | My Account: profile + change own password. |

### Tests (`tests/`)
| File | Covers |
|---|---|
| `tests/helpers.ts` | `setupApp()` (isolated temp DB + uploads), `login`, `createEmployee`, `cleanup`. |
| `tests/unit.test.ts` | zod schemas + bcrypt (pure, no HTTP). |
| `tests/auth.test.ts` | login, me, logout, RBAC, last-admin guard, change-password. |
| `tests/inventory.test.ts` | CRUD, stock in/out + history, negative-stock guard, low-stock filter, search, stats. |
| `tests/forms.test.ts` | upload/download round-trip, department visibility, delete permissions. |
| `tests/messages.test.ts` | send, inbox/sent, unread count, mark-read, self-message guard, delete. |

---

## 3. Data model (SQLite — defined in `src/db.ts` `init()`)

| Table | Key columns | Notes |
|---|---|---|
| `departments` | id, name (unique) | Seeded: Administration, Operations, Finance, Human Resources, IT. |
| `users` | id, username (unique), full_name, password_hash, role(`admin`\|`employee`), department_id→departments, active | Seeded admin on first run. |
| `sessions` | token (PK), user_id→users, expires_at | Bearer tokens; cleaned hourly + on demand. |
| `inventory_items` | id, name, sku (unique), category, department_id, quantity, unit, min_quantity, location, notes | `quantity <= min_quantity` ⇒ low stock. |
| `inventory_transactions` | id, item_id→items, user_id, change, balance_after, reason | Append-only stock history; written on create + every adjust. |
| `forms` | id, title, …, stored_name, original_name, department_id (null=all staff), uploaded_by | File on disk in `uploads/`, metadata in DB. |
| `messages` | id, sender_id, recipient_id, subject, body, read_at | Inbox = recipient, Sent = sender. |

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
| GET `/users` | 🔑 | Directory (admins get full fields) | users.routes | — |
| POST `/users` | 👑 | Create account | users.routes | createUserSchema |
| PUT `/users/:id` | 👑 | Update name/role/dept/active | users.routes | updateUserSchema |
| POST `/users/:id/reset-password` | 👑 | Reset a user's password | users.routes | resetPasswordSchema |
| GET `/users/departments/list` | 🔑 | List departments | users.routes | — |
| POST `/users/departments` | 👑 | Add department | users.routes | createDepartmentSchema |
| GET `/inventory` | 🔑 | List (`?q=`, `?department_id=`, `?low=1`) | inventory.routes | — |
| GET `/inventory/stats` | 🔑 | Dashboard totals | inventory.routes | — |
| GET `/inventory/:id` | 🔑 | Item + last 50 movements | inventory.routes | — |
| POST `/inventory` | 🔑 | Create item | inventory.routes | createItemSchema |
| PUT `/inventory/:id` | 🔑 | Update details (not qty) | inventory.routes | updateItemSchema |
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
- **Frontend:** views register with `App.register('name', async (view) => {...})` and reuse
  `API`, `UI.modal`, `UI.toast`, `UI.esc`. Always `UI.esc()` user data before inserting HTML.
- **Icons:** use `UI.icon('name')` (inline SVG, inherits text color) — do not add emoji or
  icon fonts. Add new glyphs to the `ICONS` map in `ui.js`.
- **Theming:** all colors come from CSS variables defined in `public/css/styles.css` under
  `:root`/`[data-theme='light']` (light) and `[data-theme='dark']` (dark). **Never hard-code
  a hex color in a component** — add or reuse a token (`--surface`, `--text`, `--accent`, …)
  so both themes stay correct. The active theme is the `data-theme` attribute on `<html>`,
  set pre-paint by an inline script in `index.html` and toggled via the sidebar button.
  Empty tab states use `UI.emptyState(...)`.

---

## 6. "How to add X" recipes

**A new API endpoint**
1. Add a zod schema in `src/validation.ts` (if it takes a body).
2. Add the handler to the relevant `src/routes/*.routes.ts`, using `queryOne/queryAll/run`.
3. Add the row/response type to `src/types.ts` if new.
4. Add a test in the matching `tests/*.test.ts`.
5. **Add the row to the API catalog (§4) in this file.**

**A new inventory field**
1. Add the column to the `inventory_items` schema in `src/db.ts`.
2. Extend `createItemSchema` / `updateItemSchema` and the INSERT/UPDATE in `inventory.routes.ts`.
3. Add the field to `InventoryItem` in `src/types.ts`.
4. Surface it in `public/js/views/inventory.js` (form + table).
5. Update §3 here.

**A new frontend view/page**
1. Create `public/js/views/<name>.js` calling `App.register('<name>', render)`.
2. Add a `<button class="nav-item" data-route="<name>">` to `public/index.html` and a
   `<script>` tag for the file.
3. Update the frontend map in §2.

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
