# `public/js/views/form-builder.js`

## Purpose
Admin tool for managing custom **form definitions** (the schema behind Form Records — name,
slug, number prefix, icon, and a field-definition list) and **global template variables**
(`{{global.key}}`, usable in any document template). Renders the `form-builder` nav leaf,
under Admin. Requires `forms.manage` (enforced server-side; this view itself does not
gate its own visibility, see Permissions below).

## Registered route(s)
```js
App.register('form-builder', async (view) => { ... })
```
Single route, no `filter` support. Internally it's a two-tab UI (`Form Definitions` /
`Global Variables`) driven by a local `activeTab` variable — not by `filter` or the URL, so
the tab choice doesn't survive a reload/deep-link.

## Structure / key functions

### Tab shell
- **`renderTab()`** — dispatches to `renderFormsTab()` or `renderGlobalsTab()` based on
  `activeTab`. Called once at registration and again on every subtab click.
- The subtab buttons (`#fb-tabs .subtab`) toggle `active` styling and set `activeTab`
  directly (not via `App.navigate` — this is a client-only tab, unlike form-records' distinct
  "index vs detail" states which are `filter`-driven).

### Forms tab
- **`renderFormsTab()`** — draws the toolbar (+ New Form) and an empty `#fb-forms-table`
  panel, then `loadForms()`.
- **`loadForms()`** — `GET /form-definitions`, table with Name/Slug/Prefix-pattern/Field
  count/Record count columns, empty state with a "New Form" CTA. Row actions: "Records"
  button (navigates away — `App.navigate('form-records', { form_id: f.id })`, i.e. jumps to
  the Form Records view for this definition), Edit, Delete; whole row also opens edit.
- **`openForm(id, forms)`** / **`delForm(id, forms)`** — look up the form in the
  already-loaded `forms` array by id and open `formModal` or confirm+`DELETE
  /form-definitions/:id`. The delete confirmation message is record-count-aware (warns
  about cascading record deletion when `record_count > 0`).
- **`formModal(existing)`** — create/edit modal for one form definition.
  - `fields` — a **deep clone** (`JSON.parse(JSON.stringify(...))`) of `existing.fields`
    when editing, so in-modal edits don't mutate the already-loaded `forms` array until
    save.
  - Name/Slug/Number-prefix/Icon top fields. For **new** forms only, typing in Name
    auto-derives the Slug (`toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g,
    '')`) — this listener is not attached when editing, so an existing slug is never
    silently rewritten by a name edit.
  - "Add field" button pushes a blank field def (`{ key, label, type: 'text', required:
    false, options: [], default: '' }`) into `fields` and calls `renderFields()`.
  - `onConfirm` validates: name required, slug required and `^[a-z0-9_]+$`, prefix
    required and `^[A-Z0-9]+$`, every field has a `key` and `label`, and field keys are
    unique (`Set` size check) — all via `showErr` + `return false` (keeps the modal open).
    Then `PUT`/`POST`s `{ name, slug, number_prefix, icon, fields }`.
- **`renderFields(ov, fields)`** — draws the field-definition table (`#fb-field-rows`)
  from the in-memory `fields` array: Key/Label/Type-select/Required-checkbox/a
  Default-or-Options column that swaps input based on `type` (`select` gets a
  comma-separated Options input, everything else gets a Default-value input), plus a
  remove button per row. Field `type` choices: `text, number, date, select, textarea,
  checkbox`. Wires `input`/`change` listeners to `syncField()` and remove buttons to
  splice+re-render.
- **`syncField(inp, fields)`** — writes one changed cell back into the in-memory `fields`
  array by `data-fi` (row index) and `data-k` (property name). `required` reads
  `.checked`; `options` splits/trims/filters the comma-separated string into an array;
  `type` writes the new type **and re-renders the whole field table** (so the
  Default/Options cell swaps shape immediately) — every other property is a plain string
  write with no re-render needed.

### Global Variables tab
- **`renderGlobalsTab()`** / **`loadVars()`** — same list/empty-state pattern as Forms,
  `GET /global-variables`, table of Key/Label/Value with Edit/Delete actions and row-click
  edit.
- **`varModal(existing)`** — Key (mono, **read-only when editing** — a variable's key is
  immutable once created, matching that `PUT /global-variables/:key` addresses by key),
  Label, Value. Validates key format (`^[a-z0-9_]+$`) only for new variables, and Label is
  always required. `PUT /global-variables/:key` for both create and update (there is no
  separate `POST` — the API is upsert-by-key, per `docs/ARCHITECTURE.md` §4).
- **`delVar(key)`** — confirm then `DELETE /global-variables/:key`.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /form-definitions` | `loadForms()` |
| `POST /form-definitions` | `formModal` create |
| `PUT /form-definitions/:id` | `formModal` edit |
| `DELETE /form-definitions/:id` | `delForm()` |
| `GET /global-variables` | `loadVars()` |
| `PUT /global-variables/:key` | `varModal` create+edit (upsert) |
| `DELETE /global-variables/:key` | `delVar()` |

## Permissions honored
No `App.hasPermission` checks appear in this file at all — the view assumes the caller is
already authorized to be here (reachable only via the Admin nav leaf, which is presumably
admin-gated at the nav-tree level) and relies entirely on the server's `forms.manage`
guard on every mutating endpoint (`POST`/`PUT`/`DELETE /form-definitions`,
`PUT`/`DELETE /global-variables/:key`) to reject unauthorized writes. The two `GET`
endpoints require only 🔑 any logged-in user server-side, so in principle any logged-in
user who navigates here directly (e.g. via a bookmark) could view — but not save — form
definitions/variables.

## Dependencies
`API.get/post/put/del`; `UI.icon`, `UI.esc`, `UI.modal`, `UI.confirmDialog`,
`UI.emptyState`, `UI.toast`; `App.navigate()` (Records button jump to `form-records`).

## Notes / gotchas
- **Slug auto-fill only applies to new forms** and only while the modal is open — it's a
  live-typing convenience, not a one-time default; every keystroke in Name recomputes Slug
  until the user manually edits Slug themselves (nothing detects manual slug edits and
  stops the auto-fill — if a user types in Slug then continues typing in Name, the
  auto-fill will overwrite their manual slug edit).
- **Field type changes force a full field-table re-render** (`syncField`'s `type` branch)
  because the Default/Options cell's input type depends on the selected field type — this
  is the one case where `syncField` doesn't just do a targeted in-place write.
- **`fields` is deep-cloned on edit-modal open** specifically so cancelling the modal (or a
  failed validation) never mutates the form shown in the underlying table until a
  successful save reloads it via `loadForms()`.
- Field type catalog here (`text, number, date, select, textarea, checkbox`) is
  independent from — and smaller than — the item-form field types in
  `item-form-config.js`/`inventory.js` (`money`, `percent`, `radio`, `search`, `static`,
  `department`, …); don't assume the two type systems are interchangeable.
