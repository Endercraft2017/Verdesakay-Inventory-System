# `src/modules/inventory/orders.routes.ts`

## Purpose
Implements `/api/orders`: CRUD for Job, Sale, and Purchase orders, each with a header row (`orders`) and line items (`order_items`). One router serves all three types, selected via `?type=` on list and via `type` in the create body. Auto-generates order numbers and always recomputes totals server-side rather than trusting client-submitted numbers.

## Routes / Exports

All routes are mounted at `/api/orders` (`src/app.ts`) and require authentication. CRUD uses `orders.view`, `orders.create`, `orders.edit`, and `orders.delete` respectively. Warehouse release accepts `inventory.adjust` or `orders.release`.

| Method & path | Schema | What it does | Success response | Error cases |
|---|---|---|---|---|
| `GET /` | — | Lists orders, newest first. Optional `?type=sale\|job\|purchase` filters by type. Optional `?q=` matches `o.number LIKE %q%` or `o.customer_name LIKE %q%`. Joins `users` for `created_by_name`. | `200` array of `Order` (no `items`) | — |
| `GET /:id` | — | Fetches one order header (with `created_by_name`) plus its `order_items` (`ORDER BY sort, id`). | `200` `Order` with `.items: OrderItem[]` | `404` if order id not found |
| `POST /` | `createOrderSchema` | Validates body (`type` + `orderFields`: customer_name/contact, order_date, status, notes, currency, tax_percent, `items[]` min 1 max 300). Calls `computeTotals()` to derive `line_total` per item and `subtotal`/`tax_amount`/`total` from the raw quantities/prices/tax_percent (ignores any client-sent totals). Wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`: gets the next order number via `nextOrderNumber(type)`, inserts the `orders` row, then `insertItems()` inserts each line into `order_items` with `sort` = array index. | `201 { id, number }` | Zod `ValidationError` (400, via central handler) on invalid body; DB error triggers `ROLLBACK` then rethrow (500) |
| `PUT /:id` | `updateOrderSchema` | Looks up the order by id (404 if missing) **before** validating the body. Merges omitted headers with the stored order; `items` is optional. Validates the effective headers (no editable `type`/`number`). Optional `expected_revision` must match the current content revision; stale saves return 409 before writing. Approved lines are ignored from the request and retained from storage. Recomputes totals via `computeTotals()`. Transaction: `UPDATE orders` (all header fields except type/number, plus `updated_at`), `DELETE FROM order_items WHERE order_id = ?`, then re-`insertItems()` — open/cancelled sales and non-sale lines are replaced. Approved and later sales retain their existing lines and tax percentage. | `200 { ok: true }` | `404` if order not found; validation errors 400; DB error → `ROLLBACK` + rethrow |
| `DELETE /:id` | — | Deletes the order row; `order_items` rows are removed via the table's `ON DELETE CASCADE` FK (not an explicit `DELETE`). | `200 { ok: true }` | `404` if `info.changes === 0` (nothing deleted) |

### Internal helpers (not routes)
- `round2(n)` — rounds to 2 decimals using an epsilon nudge (`Math.round((n + Number.EPSILON) * 100) / 100`) to avoid float artifacts like `0.1 + 0.2`.
- `computeTotals(items, taxPercent)` — maps each `LineInput` to `{ ...it, line_total: round2(qty * unit_price) }`, sums to `subtotal`, computes `tax_amount = round2(subtotal * taxPercent / 100)`, `total = round2(subtotal + tax_amount)`. This is the single place totals are ever computed — client-sent `line_total`/`subtotal`/`total` fields are never read.
- `nextOrderNumber(type)` — reads/increments a per-type counter in the `settings` table (key `order_seq_sale`/`order_seq_job`/`order_seq_purchase` via `getSetting`/`setSetting`), formats as `SO-#####` / `JO-#####` / `PR-#####` (zero-padded to 5 digits).
- `insertItems(orderId, lines)` — bulk-inserts computed lines into `order_items`, one `run()` call per line, `sort` = position in the array.

## Dependencies
- `express` — `Router`.
- `../db` — `db` (raw handle for `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')`), `queryOne`, `queryAll`, `run`, `getSetting`, `setSetting`.
- `../auth` — `requireAuth`.
- `../validation` — `parseBody`, `createOrderSchema`, `updateOrderSchema`.
- `../types` — `Order`, `OrderItem`, `OrderType` (type-only imports).

## Used by
- Mounted in `src/app.ts`: `app.use('/api/orders', ordersRoutes)`.
- Frontend: `public/js/views/orders.js` — the Job/Sale/Purchase Orders view (list/create/edit/print/delete, inventory-backed line-item editor).
- Tests: `tests/orders.test.ts` — covers auto-numbering, server-computed totals (asserts client totals are ignored), list-by-type, update-replaces-items, delete cascade, validation, auth, and all three types (`sale`, `job`, `purchase`).

## Notes / gotchas
- **(Fixed 2026-08-25)** `GET /`'s type filter used to only recognize `sale`/`job` — a request
  for `?type=purchase` silently fell through with no type filter applied, returning orders of
  *all* types instead of just purchase orders (this is what the `orders` view's Purchase Orders
  tab, `filter.type: 'purchase'`, relied on). Now matches all three types.
- Totals are **always** server-derived from `items[].quantity * items[].unit_price` plus `tax_percent` — this is deliberate ("never trust the client", per the file's own top comment) and is explicitly exercised by `tests/orders.test.ts`.
- `PUT /:id` does a full delete-and-reinsert of `order_items` rather than an upsert/diff, so item `id`s and any `inventory_transactions`-style history tied to a specific `order_items.id` do not survive an edit (a fresh set of rows/ids is created every time).
- `orderRevision(id)` hashes stored headers, lines, and allocated/reserved unit statuses; GET detail exposes it as `revision`. Browser PUT sends it as `expected_revision`. It detects changes even within one-second database timestamps; legacy callers may omit it.
- Missing PUT fields retain their current value; explicit null can reset an unpicked ship-from location. When `items` is absent their row IDs are retained. Approved financial fields and picked/fulfilled ship-from locations remain locked.
- Order-save idempotency is mounted after auth/current mutation permission. Keys are scoped to authenticated user/method/endpoint; no unauthenticated cached order responses are served.
- Intake validates positive quantities, valid optional dates, and linked inventory/customer/location/supplier/tax records before writes. Repeated linked stock items on a sale return 400 with instructions to combine quantities; locked legacy lines are retained on header saves. Amounts beyond safe cent precision and invalid currency codes are rejected. Supported sale statuses are normalized; new manual transitions to `released` are blocked in create, PUT, and status-only handlers. Free-text non-stock lines are never linked by name. `resolveCustomer` treats blank name/contact as a request for customer defaults.
- `type` and `number` cannot be changed via `PUT` — `updateOrderSchema` has no `type` field, and the `UPDATE orders` statement never touches `number`.
- UI coverage for the corresponding intake editor lives in `tests/orders-ui.test.ts`; route validation and permission coverage lives in `tests/orders.test.ts`.
