# `public/js/views/orders.js`

## Purpose
One view serving three order types — Sale Orders, Job Orders, and Purchase Requests — with
a searchable list, a create/edit modal featuring an inventory-backed line-item editor with
live totals, an inventory item picker, and print-to-template. Renders the `orders` nav leaf
for each of the three subtabs (Sale/Job/Purchase Orders).

## Registered route(s)
```js
App.register('orders', async (view, filter) => { ... })
```
- `filter.type` — selects which order type this instance of the view manages:
  `'job'` → Job Order, `'purchase'` → Purchase Request, anything else (including absent)
  → `'sale'` (Sale Order, the default). Set per nav leaf, e.g.
  `{ label: 'Job Orders', route: 'orders', filter: { type: 'job' } }`. The resolved `type`
  and its display `noun` (`Sale Order` / `Job Order` / `Purchase Request`) are computed
  once at the top and used throughout — the same file/logic backs all three tabs, they
  differ only in `type`/`noun` and the server-side `?type=` filter.

## Structure / key functions
- **`state.q`** — search box text, debounced 250ms before reload.
- **`money(n)`** — `toLocaleString` with 2 decimal places; used for all currency display.
- **`load()`** — `GET /orders?type=<type>&q=<state.q>`, then `render()`.
- **`render(list)`** — table (Number/Customer/Date/Total/Status/actions); empty state
  differs for "no orders yet" vs "no matching orders" (search-active). Row actions: Print,
  Edit, Delete; whole row click opens edit (guarded against `.actions` clicks).
- **`openOrder(id)`** — `GET /orders/:id` (full detail incl. `items`) then `orderModal(order)`.
- **`orderModal(order)`** — the create/edit modal (`order` null ⇒ create). Key internals,
  all defined inside `onOpen` so they close over the modal's `overlay`:
  - `lines` — a local mutable array of line-item objects, seeded from `order.items` when
    editing, `[]` when creating. This is the modal's line-item state; it is **not** synced
    back to `order` until save.
  - `recompute()` — recalculates each line's `line_total = quantity * unit_price`, sums to
    `subtotal`, applies `tax_percent` to get `tax`, and writes `subtotal`/`tax`/`total`
    text into the totals footer. Purely client-side preview — the server independently
    computes authoritative totals on save (per `docs/ARCHITECTURE.md`: "server-computed
    totals", client totals are ignored).
  - `renderLines()` — redraws the `#ord-lines` `<tbody>` from `lines`, wiring per-cell
    `input` listeners that write back into `lines[row][key]` and call `recompute()`, plus a
    remove button per row that splices `lines` and re-renders.
  - "Add inventory item" button → `pickInventory(cb)`, which appends a line pre-filled from
    the picked item (`item_id`, `name`, `sku`, `unit`, and `unit_price` seeded from
    `it.attributes.sale_price` if present, else `0`).
  - "Add blank line" button → pushes an empty editable line.
  - `onConfirm` — builds `cleaned` by mapping+filtering `lines` to only those with a
    non-empty trimmed `name`, coercing `quantity`/`unit_price` to numbers; rejects with
    `showErr` if no valid line remains. Then `PUT /orders/:id` (editing) or
    `POST /orders` with `{ type, ...body }` (creating, `type` from the outer closure, not
    editable in the form — an order's type is fixed by which nav tab created it).
- **`pickInventory(onPick)`** — a lightweight search modal (`UI.modal` with `cancelText:
  'Close'`, no confirm button) that queries `GET /inventory?q=` on input (250ms debounce),
  shows up to 20 results, and calls `onPick(item)` then closes the picker (`m.close()`) on
  row click. Reused by both the "Add inventory item" flow above and structurally mirrored
  (not shared code) by `pickInventory()` in `hr-timekeeping.js` for employee picking.
- **`printOrder(id)`** — fetches the order, the matching template list for `order.type`
  (`GET /templates?type=`), and the company profile in parallel; takes the **first**
  matching template's full body (`GET /templates/:id` — the list endpoint returns metadata
  only) or falls back to `FALLBACK_TEMPLATE` if none exists; builds the render context via
  `buildContext()` and calls `UI.printDocument(renderTemplate(tplBody, ctx), order.number)`.
- **`buildContext(order, company, me)`** — assembles the `{{var}}` template context:
  `company` (passed through as-is), `order.*` (number, type label, date, status, customer
  fields, notes, currency, formatted subtotal/tax/total), `items[]` (one row per line item
  with formatted price/total), `user.name`, `today`. This is the canonical example
  referenced by `docs/ARCHITECTURE.md` §6 ("A new document/template variable" recipe) for
  where to add new order-related template variables.
- **`FALLBACK_TEMPLATE`** — a minimal inline HTML template (module-level constant) used
  when no `doc_templates` row exists for the order's type, so printing never hard-fails on
  a fresh install before templates are seeded/customized.
- **`del(id, list)`** — confirm dialog then `DELETE /orders/:id`.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /orders?type=&q=` | `load()` |
| `GET /orders/:id` | `openOrder()`, `printOrder()` |
| `POST /orders` | `orderModal` create |
| `PUT /orders/:id` | `orderModal` edit |
| `DELETE /orders/:id` | `del()` |
| `GET /inventory?q=` | `pickInventory()` |
| `GET /templates?type=` | `printOrder()` (list, to find a matching template) |
| `GET /templates/:id` | `printOrder()` (full body of the first matching template) |
| `GET /templates/company` | `printOrder()` (company profile for the template context) |

## Permissions honored
None — this file contains no `App.hasPermission` checks. All order CRUD/print actions are
available to any user who can reach the view; access control is enforced entirely
server-side (all `/orders` routes require only 🔑 any logged-in user, per
`docs/ARCHITECTURE.md` §4).

## Dependencies
- `renderTemplate` from `public/js/doc-template.js` (template rendering engine).
- `API.get/post/put/del`.
- `UI.icon`, `UI.esc`, `UI.modal`, `UI.confirmDialog`, `UI.emptyState`, `UI.toast`,
  `UI.printDocument`.
- No `App.*` calls beyond what's implicit in the shared chrome — notably does **not** use
  `App.hasPermission` or `App.getDepartments()`.

## Notes / gotchas
- **Totals are recomputed purely for UI feedback.** The `recompute()` math in the modal
  never gets sent to the server as-is for trust — `POST`/`PUT /orders` payload sends only
  `tax_percent` and the raw `items` array; the server recalculates `subtotal`/`tax_amount`/
  `total` itself. Don't rely on client-side totals as authoritative when debugging totals
  mismatches — check the server calculation in `orders.routes.ts` instead.
- **`printOrder` always uses the *first* template matching the order's type** — if an org
  creates multiple templates for the same type (e.g. two Sale Order layouts), only
  `templateList[0]` (server list order) is ever used for printing; there's no per-order or
  per-user template selection UI here.
- **The inventory picker is a copy-pasted pattern, not shared code**, with a similarly
  named/shaped `pickInventory` in `hr-timekeeping.js` — changes to one do not affect the
  other.
- **Order `type` is immutable in the UI** — the create path always posts the outer
  closure's `type` (determined by `filter.type` at registration), so there's no way to
  change an order's type after creation from this modal.
