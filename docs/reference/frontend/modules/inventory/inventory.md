# `public/js/views/inventory.js`

## Purpose
The Inventory module: a searchable/filterable item table, a config-driven multi-tab
create/edit item modal, a stock in/out (adjust) modal, a movement-history modal, delete,
and CSV export. Also owns the admin-only "Form Options" customizer that lets an admin
change which item fields are visible/required/defaulted app-wide. Renders the `inventory`
nav leaf and `Low Stock` leaf (both point at route `inventory`).

## Registered route(s)
```js
App.register('inventory', async (view, filter) => { ... })
```
- `filter.low` (truthy) — pre-checks the "Low stock" toolbar checkbox and pre-filters the
  list to items at/below `min_quantity` on first load. Set by the nav leaf
  `{ label: 'Low Stock', route: 'inventory', filter: { low: '1' } }` in `nav-config.js`.

## Structure / key functions

This file has two logical parts: module-level helpers that implement the **config-driven
item form** (usable across renders, not tied to one view instance), and the
`App.register('inventory', ...)` closure with the table/toolbar/modals.

### Item-form engine (module scope, config-driven from `ITEM_FORM_DEFAULTS`)
- **`_itemFormConfig`** (module-level `let`) — the merged, cached field-config array
  (defaults + admin overrides). Populated by `loadItemFormConfig()`, mutated in place by
  the Option panel's save/reset flow.
- **`mergeFormConfig(saved)`** — takes the array returned by `GET /inventory/form-config`
  (or `null`) and overlays each saved override (`visible`/`required`/`default`, matched by
  `key`) onto a fresh copy of `ITEM_FORM_DEFAULTS`. Fields not present in `saved` keep
  their default definition untouched.
- **`loadItemFormConfig(force)`** — fetches+merges once and caches in `_itemFormConfig`;
  pass `force` to refetch (not currently called with `force: true` anywhere, invalidation
  happens by direct assignment instead — see Option modal).
- **`itemDeptOptions(selected)`** — `<option>` list from `App.getDepartments()`, used for
  `type: 'department'` fields.
- **`itemFieldValue(def, it)`** — resolves the current value of one field for a given item
  (`it` null ⇒ new-item defaults). Core fields (`def.core`) read straight off the item row
  (`department_id`, `quantity`, `min_quantity` get explicit `?? ` fallbacks, other core keys
  read `it[def.key]`); non-core fields read `it.attributes[def.key]`, falling back to
  `def.default` (or `false`/`''` by type) if the key isn't present in `attributes` yet.
- **`isChecked(v)`** — loose truthy check for checkbox values coming from JSON
  (`true`/`'true'`/`1`/`'1'`).
- **`renderItemField(def, value, opts)`** — renders one `.form-field` for a field def,
  branching on `def.type`: `checkbox`, `static` (read-only label), `radio`, `select` /
  `department`, `textarea`, `search`, and the default numeric/text branch (`text`,
  `number`, `money`, `percent` — money/percent get `step="0.01"`, percent gets a `%`
  suffix, any type can carry a `def.suffix`). `opts.disabled` renders the input disabled
  (used to lock `quantity` while editing — see below).
- **`renderItemFormBody(cfg, it)`** — builds the tab bar + tab panels for the whole modal
  body from `cfg` (only tabs that have at least one visible field are shown, from
  `ITEM_FORM_TABS`), first tab active. Locks the `quantity` field when editing an existing
  item (`editLocked = it && f.key === 'quantity'`) since stock changes must go through the
  adjust modal instead.
- **`wireItemFormTabs(overlay)`** — click-delegates `[data-formtab]` buttons to toggle the
  matching `[data-formpanel]`'s `hidden` class and the active tab's styling. Shared by both
  the item form and the Option panel (same tab-strip markup convention).
- **`readItemField(overlay, def)`** — reads one field's current DOM value by type
  (`radio` reads the checked input by `name`, `checkbox` reads `.checked`, else `.value`).
- **`collectItemForm(overlay, cfg, it)`** — walks every *visible*, non-`static` field def,
  splitting values into `{ core, attributes }` (`attributes` starts as a shallow copy of
  the item's existing `attributes` so hidden/non-rendered custom fields survive a save).

### View closure (`App.register('inventory', ...)`)
- **`state`** — `{ q, department_id, category, low }`, driven by the toolbar controls.
- **`deptOptions(selected)`** — closure-local duplicate of the department `<option>`
  builder used for the toolbar filter select (distinct from `itemDeptOptions` above, which
  is for the item-form field).
- **`loadCategories()`** — populates the Category `<select>` from `GET /inventory/categories`.
- **`load()`** — builds a query string from `state` and fetches `GET /inventory`, storing
  results in `lastItems` (used by export) then calling `render()`.
- **`exportCsv()`** — builds an 8-column CSV (Name/SKU/Category/Department/Quantity/Unit/
  Min/Location) from `lastItems` via `UI.downloadCsv`; no-ops with a toast if the list is
  empty.
- **`render(items)`** — table rendering, incl. `UI.emptyState` for zero results (with a
  different message for "fresh"/no-filter vs "no match"); wires per-row action buttons
  (`data-adjust`, `data-history`, `data-edit`, `data-del`) and makes the whole row clickable
  to open edit (guarded so clicks inside `.actions` don't double-trigger).
- **`itemModal(it)`** — the create/edit modal. Loads/merges the form config, checks
  `inventory.configure` to decide whether to show the "Option" head-action button, renders
  `renderItemFormBody`, wires tabs, and on confirm: validates every visible+required field
  (jumping the modal to the offending field's tab via `.click()` on its tab button if
  invalid), then `collectItemForm`s into `{ core, attributes }`, strips `quantity` from the
  body when editing (stock is adjust-only), and `POST`/`PUT`s accordingly.
- **`refreshItemFormBody(overlay, it)`** — re-renders `#item-form-host` in place after the
  Option panel saves a new layout, so the open item modal reflects the new field set
  without closing it.
- **`openItemOptions(formOverlay, it)`** — the admin "Form Options" modal: one row per
  field (grouped into the same tabs) with Visible/Required checkboxes and a Default-value
  input; a "Reset to defaults" head-action `PUT`s the config back to `ITEM_FORM_DEFAULTS`
  verbatim. On confirm, `PUT /inventory/form-config` with the edited array, updates the
  module-level `_itemFormConfig` cache, and calls `refreshItemFormBody` on the still-open
  item form behind it.
- **`adjustModal(id, items)`** — stock in/out modal: direction select (`in`/`out`), amount,
  reason; computes `change = dir === 'out' ? -amount : amount` and posts to
  `/inventory/:id/adjust`.
- **`historyModal(id)`** — fetches the item detail (`GET /inventory/:id`, which includes
  `history`) and renders a read-only movement table (date/change/balance/reason/user).
- **`del(it)`** — confirm dialog then `DELETE /inventory/:id`.
- Toolbar wiring at the bottom: debounced search (`250ms`), category/department/low-stock
  filter change handlers, export and add-item buttons. Initial `Promise.all([load(),
  loadCategories(), loadItemFormConfig()])` on register.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /inventory?q=&department_id=&category=&low=` | `load()` |
| `GET /inventory/categories` | `loadCategories()` |
| `GET /inventory/form-config` | `loadItemFormConfig()` |
| `PUT /inventory/form-config` | `openItemOptions` save + reset |
| `GET /inventory/:id` | `historyModal()` (item + last 50 movements) |
| `POST /inventory` | `itemModal` create |
| `PUT /inventory/:id` | `itemModal` edit |
| `POST /inventory/:id/adjust` | `adjustModal` |
| `DELETE /inventory/:id` | `del()` |

## Permissions honored
- `inventory.configure` — controls whether the "Option" button appears in the item modal's
  head action (`itemModal`'s `canCustomize`). The Option panel itself has no additional
  in-JS guard beyond that entry point — reaching it without the permission would still hit
  the server-side `PUT /inventory/form-config` guard (`inventory.configure`, per
  `docs/ARCHITECTURE.md` §4) and fail there.
- No other `App.hasPermission` checks in this file — the list, adjust, history, and delete
  actions are not conditionally hidden here (the route itself is reached only if the
  `inventory` route requires a permission at the nav/registration level — this file does
  not check one itself for base viewing).

## Dependencies
- `ITEM_FORM_DEFAULTS`, `ITEM_FORM_TABS` from `public/js/item-form-config.js` — the field
  catalog driving the whole form (see "How to add X: A new item field" in
  `docs/ARCHITECTURE.md` §6 for the no-migration path to add a field).
- `App.getDepartments()`, `App.hasPermission()`.
- `API.get/post/put/del`.
- `UI.icon`, `UI.esc`, `UI.helpIcon`, `UI.modal`, `UI.confirmDialog`, `UI.emptyState`,
  `UI.toast`, `UI.downloadCsv`, `UI.fmtDate`.

## Notes / gotchas
- **`_itemFormConfig` is module-scoped, not view-instance-scoped.** It persists across
  re-registrations of the `inventory` route within the same page session (it's declared
  outside `App.register`), acting as an app-wide cache of the merged form layout. Only
  `openItemOptions`'s save/reset path mutates it; `loadItemFormConfig()` only populates it
  if still `null` (or `force`d, though nothing currently forces).
- **Quantity is edit-locked and stripped on save.** `renderItemField` disables the
  `quantity` input when editing, and `itemModal`'s `onConfirm` explicitly `delete
  body.quantity` before `PUT`. All stock changes must go through `adjustModal` /
  `POST /:id/adjust`, which is transactional server-side and writes history — bypassing it
  would silently drop the quantity change anyway since the server ignores it on `PUT`.
- **Attributes round-trip through `collectItemForm`.** Because `attributes` starts as a
  shallow copy of the existing item's `attributes` object, any custom field currently
  hidden by the admin's layout (visible: false) is preserved rather than dropped on save —
  only fields that are both visible and non-static get overwritten.
- **Tab-jump on validation failure.** `itemModal.onConfirm` finds the first invalid
  required field and programmatically clicks its tab button so the user actually sees the
  error message next to the field, rather than a validation toast on a tab they're not
  viewing.
- **Money/percent fields render as `<input type="number">`** with `step="0.01"`; there's no
  currency formatting/masking — values are stored as raw strings/numbers in `attributes`.
