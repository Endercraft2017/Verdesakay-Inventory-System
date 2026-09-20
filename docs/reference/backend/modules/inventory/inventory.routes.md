# `src/modules/inventory/inventory.routes.ts`

## Purpose
Inventory item CRUD, search/filter, stock adjustment with an append-only audit trail
(`inventory_transactions`), dashboard stats, distinct-category lookup, and the admin-configurable
item-form layout (`attributes` JSON round-trip + `form-config` GET/PUT). Mounted at `/api/inventory`.

## Routes / Exports

`router.use(requireAuth)` (line 15) — every route requires a valid session. Note: unlike
`users.routes.ts`, this router does **not** gate any CRUD route by a specific permission (e.g.
`inventory.create`/`inventory.edit`/`inventory.adjust`/`inventory.delete`) at the route layer —
those permissions exist in `src/shared/permissions.ts` and are enforced by the frontend
(`App.hasPermission`) and by the AI tool layer (`src/modules/ai/ai-tools.ts`'s `TOOL_PERMISSION`), but any
authenticated user can call these HTTP endpoints directly. The one exception is `PUT /form-config`,
which is gated by `inventory.configure`.

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /` | 🔑 any user | — | Dynamic `WHERE` from query params `q` (LIKE on name/sku/category/location), `department_id` (exact), `category` (exact), `low` (`quantity <= min_quantity`); `ITEM_SELECT` joins `departments`, computes `low_stock` | `200 [InventoryItem with parsed attributes, ...]` | — |
| `GET /form-config` | 🔑 any user | — | `getSetting('item_form_config')` | `200 <saved config>` or `200 null` | — |
| `PUT /form-config` | 🔐 `requirePermission('inventory.configure')` | `formConfigSchema` | `setSetting('item_form_config', config)` | `200 {ok: true}` | 403 if lacking permission; 400 via zod |
| `GET /stats` | 🔑 any user | — | Aggregate: `items`, `total_units`, `low_stock`, `out_of_stock` | `200 {...totals}` | — |
| `GET /categories` | 🔑 any user | — | `SELECT DISTINCT category ... WHERE category IS NOT NULL AND TRIM(category) != ''` | `200 [string, ...]` | — |
| `GET /:id` | 🔑 any user | — | `ITEM_SELECT WHERE i.id = ?`; last 50 `inventory_transactions` (joined with `users` for `user_name`) | `200 {...item, attributes: {...}, history: [...]}` | `404 {error:'Item not found'}` |
| `POST /` | 🔑 any user | `createItemSchema` | Optional SKU-duplicate check; `INSERT INTO inventory_items (...)`; if `quantity !== 0`, inserts an `inventory_transactions` row with `reason:'Initial stock'` | `201 {id}` | `409 {error:'An item with that SKU already exists'}`; 400 via zod |
| `PUT /:id` | 🔑 any user | `updateItemSchema` | Existence check; optional SKU-duplicate check (excluding self); `UPDATE inventory_items SET ...` (each field falls back to the existing value if not supplied); does **not** touch `quantity` | `200 {ok: true}` | `404 {error:'Item not found'}`; `409 {error:'Another item already uses that SKU'}` |
| `POST /:id/adjust` | 🔑 any user | `adjustStockSchema` | Existence check; computes `balance = item.quantity + change`; rejects if `balance < 0`; transactional (`BEGIN`/`COMMIT`/`ROLLBACK`): `UPDATE inventory_items SET quantity`, `INSERT INTO inventory_transactions` | `200 {ok: true, quantity: balance}` | `404 {error:'Item not found'}`; `400 {error:'Not enough stock. Only <n> available.'}` |
| `DELETE /:id` | 🔑 any user | — | `DELETE FROM inventory_items WHERE id = ?` (cascades transaction history via FK) | `200 {ok: true}` | `404 {error:'Item not found'}` (`info.changes === 0`) |

### Schemas (from `src/shared/validation.ts`)
- `createItemSchema` — `name` (1-160), `sku`/`category`/`location`/`notes` (optional text, ≤2000),
  `department_id` (optional positive int/null), `quantity` (int, default 0), `unit` (≤40, optional,
  nullable), `min_quantity` (int ≥0, default 0), `attributes` (`attributesSchema`: flat
  string-keyed record of string/number/boolean/null, ≤200 keys, ≤2000-char string values).
- `updateItemSchema` — same fields, all optional (no default on `quantity` — quantity isn't part
  of this schema at all).
- `formConfigSchema` — array (≤500) of `{key, visible: boolish, required: boolish, ...passthrough}`.
- `adjustStockSchema` — `{change: int (non-zero, refined), reason: optional text}`.

## Dependencies
- `express` — `Router`.
- `../db` — `db` (for `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` in `/adjust`), `queryOne`, `queryAll`,
  `run`, `getSetting`, `setSetting`.
- `../auth` — `requireAuth`, `requirePermission`.
- `../validation` — `parseBody`, `createItemSchema`, `updateItemSchema`, `adjustStockSchema`, `formConfigSchema`.
- `../types` — `InventoryItem`, `InventoryTransaction`.

### Local helpers
- `ITEM_SELECT` — shared base `SELECT ... FROM inventory_items i LEFT JOIN departments d` string
  reused by `GET /`, `GET /:id`.
- `FORM_CONFIG_KEY = 'item_form_config'` — the `settings` table key used by `form-config` GET/PUT.
- `withParsedAttributes(item)` — parses the stored `attributes` JSON text column into an object
  (defaults to `{}` on missing/unparseable value); applied to every item in list/detail responses.

## Used by
- `src/app.ts` — mounted as `app.use('/api/inventory', inventoryRoutes)`.
- `tests/inventory.test.ts` — CRUD, stock in/out + history, negative-stock guard, low-stock filter,
  search, stats, `attributes` round-trip, `form-config` GET/PUT + admin-only guard.
- `public/js/views/inventory.js` — the Inventory table/modal view (search/filter, config-driven
  create/edit modal, admin "Option" customizer via `form-config`, stock adjust modal, history modal, delete).
- `public/js/views/dashboard.js` — reads `GET /inventory/stats` and low-stock data for dashboard cards.
- `public/js/views/orders.js` — inventory-backed line-item picker likely queries `GET /inventory` for item search (see `pickInventory()`-style flows referenced in `hr-timekeeping.js`'s doc comment, which mirrors this pattern).

## Notes / gotchas
- `POST /:id/adjust`'s negative-balance guard (`balance < 0` → 400) is **stricter** than the
  equivalent AI tool `adjust_stock` in `src/modules/ai/ai-tools.ts`, which allows a negative resulting quantity
  — a deliberate-looking asymmetry between the HTTP API and the AI assistant's tool.
- `POST /`'s insert of the initial-stock transaction (when `quantity !== 0`) is **not** wrapped in
  an explicit `BEGIN`/`COMMIT`/`ROLLBACK` transaction, unlike `/adjust`'s two writes — mirroring the
  same characteristic in `ai-tools.ts`'s `create_inventory_item`.
- `PUT /:id` treats `undefined` vs explicit `null`/empty differently per field: for optional-text
  fields (`category`, `location`, `notes`) an explicit `null` in the request clears the field,
  while an omitted key leaves the existing value untouched (`input.category !== undefined ? input.category : item.category`).
- SKU uniqueness is enforced at the application layer (a `SELECT` check before insert/update), not
  by a DB-level constraint visible in this file — there is a small TOCTOU race window under
  concurrent requests.
- `attributes` is stored as a JSON **string** column; `withParsedAttributes` re-parses it on every
  read rather than the DB storing structured data — any malformed JSON silently becomes `{}` in
  the response rather than surfacing an error.
- Every route here is reachable by any authenticated user regardless of role/permission (aside from
  `PUT /form-config`) — the "permission" story for inventory mutation is enforced client-side
  (`App.hasPermission`) and in the AI tool layer, not at this HTTP boundary. Treat that as the
  current (documented, not obviously accidental) behavior rather than a bug to silently "fix."
