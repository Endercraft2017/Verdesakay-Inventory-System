# `public/js/item-form-config.js`

## Purpose
The default, data-driven definition of the New/Edit Item modal's ECOUNT-style 7-tab layout:
every field's tab, input type, default value, visibility, and required-ness. Admins
customize show/hide/required/default per field via the modal's "Option" panel in
`views/inventory.js`; that override is saved server-side (`inventory.form-config`) and
merged over these defaults by key.

## Exports / Public API

Three globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports)
  module.exports = { ITEM_FORM_TABS, ITEM_CORE_KEYS, ITEM_FORM_DEFAULTS };
```

- **`ITEM_FORM_TABS`** — ordered array of the 7 tabs: `{ id, label }` for `default`,
  `info` ("Item Information"), `qty`, `price`, `cost`, `additional` ("Additional
  Information"), `management`.
- **`ITEM_CORE_KEYS`** — the 9 field keys that map to real `inventory_items` columns:
  `['name', 'sku', 'category', 'department_id', 'quantity', 'unit', 'min_quantity',
  'location', 'notes']`. Everything else in `ITEM_FORM_DEFAULTS` is persisted into the
  item's `attributes` JSON blob instead of a dedicated column.
- **`ITEM_FORM_DEFAULTS`** — the full field catalog, ~60 entries. Each field def:
  ```
  { key, label, tab, type, options?, default?, visible, required, core?,
    placeholder?, suffix?, help? }
  ```
  - `type` ∈ `text | number | money | percent | textarea | select | radio | checkbox |
    department | search | static`. `search` = free-text input with a search icon, for
    lookups that don't have a backing module yet (e.g. Vendor, Production Process).
    `static` = a read-only visual row placeholder (e.g. Image/File — "not supported yet").
  - `core: true` marks one of the 9 real-column fields (see `ITEM_CORE_KEYS` — the two
    lists must stay in sync; enforced by `tests/item-form-config.test.ts`).
  - `help` is the tooltip text shown by the field's `?` icon (`UI.helpIcon`).
  - Not exported as separate constants but used inline as field `options` arrays:
    `USE_NOUSE = ['Use', 'Do Not Use']`, `DEFAULT_USE_RADIO` (4-way, defaults to
    "Default Settings (Do Not Use)"), `REQ_OPT_RADIO` (4-way, defaults to "Default
    Settings (Optional)") — module-scoped constants reused across several radio fields.

## Internal structure
Pure static data, no functions. `ITEM_FORM_DEFAULTS` is grouped by tab via comment banners
(`// ---------------- Default ----------------`, etc.) in the same order as `ITEM_FORM_TABS`
— when adding a field, insert it under the matching comment block to keep the file readable
even though tab membership is driven by the `tab` property, not array position.

## Dependencies
None — loaded fourth in `index.html` (`api.js`, `ui.js`, `nav-config.js`,
`item-form-config.js`), before `app.js` and any view.

## Used by
- `public/js/views/inventory.js` — reads `ITEM_FORM_DEFAULTS`/`ITEM_FORM_TABS` to render
  the New/Edit Item modal's 7 tabs and every field, merges the server-saved layout override
  on top (`mergeFormConfig`), and uses `ITEM_CORE_KEYS` to split submitted form data between
  real columns and the `attributes` JSON payload.
- `tests/item-form-config.test.ts` — sandbox-loads this file and checks: every field `key`
  is unique, every `tab` is a real `ITEM_FORM_TABS` id, `ITEM_CORE_KEYS` entries all
  correspond to a field with `core: true` (and vice versa), and every `select`/`radio`
  field has a non-empty `options` array.

## Notes / gotchas
- **Adding a new item field is a no-migration change** in the common case: append a field
  def to `ITEM_FORM_DEFAULTS` (pick a `tab`, `type`, `default`; leave `core` unset). It
  persists automatically into the `attributes` JSON — no DB schema, route, or type change
  needed. To surface it in the inventory table/filters, read `item.attributes.<key>` in
  `views/inventory.js`.
- Only promote a field to `core: true` (a real `inventory_items` column) when it needs SQL
  filtering/sorting — that requires a DB migration (`src/db.ts`), schema updates
  (`createItemSchema`/`updateItemSchema` in `src/validation.ts`), a `src/types.ts` update,
  and adding the key to both `ITEM_CORE_KEYS` here and setting `core: true` on the field def
  — see ARCHITECTURE.md §6 "A new *core* item column" recipe.
- Several fields are cosmetic/decorative (mirroring the ECOUNT UI this app's inventory
  screen is modeled on) and aren't wired into any business logic elsewhere — e.g. `image`/
  `file` are `static` placeholders explicitly marked "not supported yet"; don't assume every
  field here has real behavior beyond being stored and displayed.
