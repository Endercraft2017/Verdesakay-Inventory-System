# `public/js/views/form-records.js`

Payslip review now separates deliberate adjustments from viewing: open Adjust payslip deductions to set exact per-payslip SSS, PhilHealth, Pag-IBIG or withholding-tax overrides. Blank restores automatic calculation, zero explicitly overrides to zero, and Save Deductions persists changes. Previews do not save; overrides survive regeneration. Paid slips remain locked. Employer contributions stay computed separately. Imported slips without matching attendance context still show their stored review and provide an explicit imported-value adjustment action.

Payroll CSV upload first previews rows, totals and existing employee/period matches. Duplicate imports require explicit confirmation; the API rechecks matches at commit time. It never replaces existing payslips. Form setup uses Details, Fields, Printing and Automation tabs with live form preview and field ordering. HR starters appear only under HR; shared template values are labelled as workspace-wide.


Current workflow: Documents → Data Forms is the canonical hub. Section shortcuts open the same hub with a section filter; Form Builder remains section-owned. Index search/section and record search/status/period filters are kept in the URL. Returning from a record restores the index filter.

Bulk deletion, status changes, and payroll paid/unpaid operations use one review listing affected records, eligible counts and exclusions. Locked paid payslips are excluded from deletion/status changes. Results report individual failures and action warnings; failed records remain selected when still visible. Delete visible and Print visible operate on the currently loaded filter, while selected actions operate on checked rows. Edits preserve existing status; use Change status separately.


## Purpose
Displays submitted records for admin-defined custom forms (`form_definitions` /
`form_records`). Without a specific form selected it's an index card grid to pick a form;
with one selected it's a full records list + a create/edit modal whose fields are
generated dynamically from that form's `fields` JSON. When the selected form is the
auto-seeded **HR Payroll** form (`slug === 'hr_payroll'`), the view additionally exposes a
CSV import flow and a payslip print/preview flow. Renders the `form-records` nav leaf
(`All Forms`) and is also the jump target from Form Builder's "Records" button and from
Time Keeping's "Generate Payslips" action.

## Registered route(s)
```js
App.register('form-records', async (view, filter) => {
  if (filter && filter.form_id) await renderFormView(view, Number(filter.form_id), filter.period || '');
  else await renderIndex(view);
});
```
- `filter.form_id` — if present, skips the index and opens `renderFormView` directly for
  that form definition id (coerced with `Number(...)`).
- `filter.period` — only meaningful together with `form_id`; pre-selects the payroll
  period filter (`state.period`) on load. Used when navigating here from Time Keeping's
  "Generate Payslips" flow (`hr-timekeeping.js`) so the newly-generated period is
  immediately visible. Only rendered as a UI control (`#fr-period`, a type-to-search
  `UI.combo` inside `#fr-period-combo`) when the form is the payroll form (`isPayroll`);
  otherwise the value is accepted but has no control to
  reflect it — filtering by period could still occur server-side via the query string on
  `load()`, but there is no way for a non-payroll form to set it from the UI.

Two top-level module-scope functions back the two states; this file does **not** wrap
everything in the `App.register` callback — `renderIndex` and `renderFormView` are declared
as ordinary top-level functions in the file, called from the registered callback.

## Structure / key functions

### `renderIndex(view)` — form picker
Fetches `GET /form-definitions`; empty state's hint differs by `App.isAdmin()` (shows an
"Open Form Builder" CTA for admins, a plain "ask an admin" hint otherwise). Otherwise
renders a `.form-card-grid` of clickable cards (icon, name, "N fields · M records", number
prefix pattern); each card click calls `App.navigate('form-records', { form_id: f.id })` —
i.e. re-enters this same view's registered callback with a new `filter`, which is how the
index-to-detail transition happens (a full route re-navigation, not an in-place DOM swap).

### `renderFormView(view, formId, initialPeriod)` — records list + modal
State: `formDef` (fetched once), `currentRecords` (last-loaded list, also feeds bulk
print/delete), `selectedIds` (a `Set`, for the checkbox-based bulk-action bar), `state = {
q, status, period }`. `isPayroll = formDef.slug === 'hr_payroll'` gates every
payroll-specific control described below. If the form fetch 404s, the whole view is
replaced with a plain "Form not found." message and nothing else runs.

**Toolbar** (topbar): Back button (`App.navigate('form-records')` — drops `filter.form_id`,
returning to the index), form name, search box (debounced 250ms, matches record `number`
server-side), status `<select>` (`draft/submitted/approved/rejected/completed`), and — only
if `isPayroll` — a period `<select>` (populated from `GET
/form-definitions/:id/periods`, refreshed every `load()`), an "Upload CSV" button, and a
"Print visible" button. A "Delete visible" button and "New Record" button are always present.

**Bulk-action bar** (`#fr-bulk-bar`, hidden unless `selectedIds.size > 0`): selection
count, "Print selected" (payroll only), "Delete selected", "Clear".

- **`updateBulkBar()`** — toggles the bar's visibility/count text from `selectedIds.size`.
- **`syncSelection()`** — re-checks per-row checkboxes and the header "select all"
  checkbox (with `indeterminate` support) from `selectedIds`, then calls `updateBulkBar()`.
  Called after any selection mutation.
- **`delSelected()`** — confirms, then fires one `DELETE /form-records/:id` per selected id
  in parallel (`Promise.all`, each wrapped so a failure increments a local `failed` counter
  instead of rejecting the whole batch), reports partial-failure in the toast, reloads.
- **`printSelected()`** — maps `selectedIds` against `currentRecords` to build a `.data`
  array and calls `printSlips(list)`.
- **`delAll()`** — same per-id parallel delete pattern as `delSelected()` but over **every
  currently-loaded/filtered** record (`currentRecords`, i.e. respects the active
  search/status/period filters — this is effectively "delete this view", not "delete
  everything for this form"). If a period filter was active, it's cleared after (since that
  period's records no longer exist). The confirm message names the scope: `period
  "<label>"`, `current filter`, or `all periods`, in that priority order based on which
  `state` fields are set.
- **`printSlips(dataList)`** — the payroll payslip print flow (see dedicated section
  below).
- **`importCsvModal()`** — the payroll CSV upload flow (see dedicated section below).
- **`load()`** — builds `?q=&status=&period=` from `state`, fetches
  `GET /form-definitions/:id/records`, stores into `currentRecords`, **clears
  `selectedIds`** (selection does not survive a reload/filter change), and — if payroll —
  refreshes the period `<select>`'s options from `GET /form-definitions/:id/periods`
  while preserving the current selection. Then `renderRecords()`.
- **`renderRecords(records)`** — table columns are dynamic: `Number` + the **first 4**
  fields of `formDef.fields` (`formDef.fields.slice(0, 4)`, in definition order) + `Status`
  + `Date`, plus a leading select checkbox column. This is a hard cap — forms with more
  than 4 fields only show 4 columns in the list; the rest are visible only in the
  create/edit modal. Row actions: Print (payroll only), Edit, Delete; row click opens edit
  (guarded against `.actions`/checkbox clicks). Wires the header "select all" checkbox and
  per-row checkboxes into `selectedIds` (+`syncSelection()`), and print/edit/delete
  buttons.
- **`openRecord(id, records)`** / **`delRecord(id, records)`** — straightforward lookup +
  `recordModal()` / confirm+`DELETE /form-records/:id`+reload.

### Dynamic record modal
- **`recordModal(existing)`** — builds the create/edit modal body **entirely from
  `formDef.fields`**, in field-definition order, via `renderFieldInput()` for each, plus a
  Status `<select>` (`draft/submitted/approved/rejected/completed`) always first. Modal
  `size` is `'lg'` if the form has more than 6 fields, otherwise the default (unsized)
  modal — a simple heuristic so wide forms get more room without every form always being
  large. For payroll records specifically, an extra hardcoded **Net Pay** field
  (`data-field="net_pay"`, number input) is appended after the dynamic fields — this key is
  not part of `formDef.fields` at all; it's a fixed addition purely for `isPayroll`, styled
  in its own highlighted box with a hint that it's "Auto-filled from CSV. Edit to correct
  if needed."
  - `onConfirm` walks `formDef.fields`, reading each by `[data-field="<key>"]`
    (`.checked` for `checkbox` type, `.value` otherwise), enforcing `required` per field
    (`showErr` + `return false` on first failure — no error aggregation, one at a time).
    Separately (`if (isPayroll)`), reads `net_pay` and coerces to `Number(...)` or `0` if
    empty. Then `PUT /form-records/:id` (editing, body `{ data, status }`) or
    `POST /form-records` (creating, body `{ form_def_id, data, status }`).
- **`renderFieldInput(field, data)`** — renders one input by `field.type`:
  - `textarea` → `<textarea>` (3 rows).
  - `checkbox` → a full-row `<label>` wrapping the checkbox + the field's own label text
    inline (checkbox fields don't get a separate `<label for>` line above like other
    types — the label is baked into the clickable row itself).
  - `select` → `<select>` with a blank `"— select —"` option plus `field.options`.
  - everything else → `<input type="<field.type>">` directly — i.e. the custom form
    builder's `text`/`number`/`date` types map straight to native HTML input types with no
    special handling (unlike `inventory.js`'s richer field-type system with money/percent/
    radio/search/department types).
  Value resolution: `data[field.key] ?? field.default ?? ''`.

### Payroll CSV import
- **`importCsvModal()`** — modal with a required **Payroll Period** text label (free text,
  e.g. `"1st Half June 2026"` — this becomes the `period` value stamped on every imported
  record and is what the period filter later matches against), a required CSV file input
  (`accept=".csv,text/csv"`), and an optional Pay Date (applied to every record, since the
  sheet itself doesn't carry a pay date). On confirm: builds a `FormData`, posts to
  `POST /form-definitions/:id/import` via `API.upload`, toasts the created-record count,
  and **auto-selects the newly imported period** (`state.period = res.period; load();`) so
  the user immediately sees just-imported rows rather than the full unfiltered list.

### Payroll payslip print flow
- **`printSlips(dataList)`** — `dataList` defaults to `currentRecords.map(r => r.data)`
  (i.e. "everything currently loaded/filtered") when omitted, but callers pass a
  single-element array for a per-row Print click, or the bulk-selected subset for "Print
  selected". No-ops with a toast if the effective list is empty, or if
  `buildPayrollSlipsHtml` (from `hr-payroll-print.js`) isn't loaded.
  1. Attempts to fetch the **"HR Payroll Slip" document template** by name (`GET
     /templates`, find by `t.name === 'HR Payroll Slip'`, then `GET /templates/:id` for
     the full body) — wrapped in try/catch so a missing/failed template silently falls
     back to `buildPayrollSlipsHtml`'s own built-in default layout rather than blocking
     printing.
  2. Builds `html = buildPayrollSlipsHtml(list, templateBody)` and wraps it with
     `UI.printableHtml(html, formDef.name)` into a full standalone document (`full`).
  3. Opens a `UI.modal` sized `'xl'` containing an `<iframe id="payslip-preview-frame">`;
     `onOpen` wires `ifr.onload` to call `fitPayslipCells(ifr.contentDocument)` (from
     `hr-payroll-print.js` — shrinks any grid cell whose rendered content overflowed its
     fixed-height cell, so a customized template or a record with several
     `other_deductions` lines doesn't get its NET PAY/signature rows silently clipped)
     before setting `srcdoc = full` (no `window.open`, avoiding popup blockers entirely).
  4. The modal's confirm button (labeled `'Print…'`) calls `ifr.contentWindow.focus();
     ifr.contentWindow.print();` and **returns `false`**, which per `UI.modal`'s contract
     keeps the modal open — i.e. clicking Print does not close the preview; the user closes
     it manually via `cancelText: 'Close'` after printing (or reprinting).

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /form-definitions` | `renderIndex()` |
| `GET /form-definitions/:id` | `renderFormView()` (loads `formDef`) |
| `GET /form-definitions/:id/records?q=&status=&period=` | `load()` |
| `GET /form-definitions/:id/periods` | `load()`, only when `isPayroll` (populates the period `<select>`) |
| `POST /form-definitions/:id/import` (multipart) | `importCsvModal()` via `API.upload`, only when `isPayroll` |
| `GET /form-records/:id` | *not called directly* — records come pre-loaded from the list endpoint; edit uses the in-memory row |
| `POST /form-records` | `recordModal` create |
| `PUT /form-records/:id` | `recordModal` edit |
| `DELETE /form-records/:id` | `delRecord()`, `delSelected()`, `delAll()` |
| `GET /templates` | `printSlips()` (find the "HR Payroll Slip" template by name) |
| `GET /templates/:id` | `printSlips()` (full template body) |

## Permissions honored
No `App.hasPermission` checks anywhere in this file. All gating is either (a) structural —
the payroll-only controls (`Upload CSV`, `Print All`/`Print selected`/row Print, period
filter, Net Pay field) are gated purely by `formDef.slug === 'hr_payroll'`, not by a
permission — or (b) enforced server-side (`forms.manage` guards the form-definition writes
this view doesn't perform; the CSV import route itself requires only 🔑 any logged-in user
plus the `hr_payroll`-slug check, per `docs/ARCHITECTURE.md` §4).

## Dependencies
- `buildPayrollSlipsHtml` from `public/js/hr-payroll-print.js` — required for
  `printSlips()`; the function guards against it being `undefined` (script load order/
  failure) with a toast rather than throwing.
- `App.isAdmin()`, `App.navigate()`.
- `API.get/post/put/del/upload`.
- `UI.icon`, `UI.esc`, `UI.modal`, `UI.confirmDialog`, `UI.emptyState`, `UI.toast`,
  `UI.fmtDateShort`, `UI.printableHtml`.
- Indirectly, `form_definitions.fields` shape (`FieldDef[]`: `key`, `label`, `type`,
  `required`, `options`, `default`) as authored in `form-builder.js`'s field editor — this
  view is the *consumer* of that schema, it does not define or validate field types beyond
  what `renderFieldInput`'s type switch understands.

## Notes / gotchas
- **`GET /form-definitions/:id/periods` is not listed in `docs/ARCHITECTURE.md`'s §4 API
  catalog** even though it exists in `src/core/form-builder.routes.ts` and is actively
  used here — worth double-checking against the live route file rather than the catalog
  alone if periods behavior seems off.
- **The list only ever shows the form's first 4 fields as columns** (`formDef.fields.slice(0,
  4)`) — reordering `fields` in Form Builder changes which fields are visible in the Form
  Records list table, not just their order.
- **Net Pay is a payroll-only, out-of-band field**: it is *not* part of `formDef.fields`,
  so it is invisible to the generic `renderFieldInput`/validation loop and is read/written
  by dedicated code in `recordModal`. Adding a "net_pay"-like field to another custom form
  would need equivalent dedicated code — the generic field-def system has no concept of it.
- **`printSlips()` prefers the "HR Payroll Slip" document template by exact name match**;
  renaming that template in Templates admin (`templates.js`) would silently break the
  lookup and fall back to `buildPayrollSlipsHtml`'s built-in layout with no visible warning
  beyond the swapped output.
- **Preview-modal + iframe printing, not `window.open`/`UI.printDocument()`.** This is the
  canonical example `docs/ARCHITECTURE.md` §5 points to for any print flow doing async work
  first (fetching a template) — an already-open modal's `<iframe>` can't be popup-blocked,
  unlike `window.open()`. `hr-employees.js`'s "Generate ID" flow follows the same pattern.
- **Bulk and per-row delete both use parallelized per-id requests with soft failure
  counting**, not a single batch-delete endpoint (none exists) — a large bulk delete issues
  one HTTP request per record concurrently.
- **Selection state (`selectedIds`) resets on every `load()`**, including the load
  triggered by search/status/period filter changes — a filtered-then-selected set will not
  survive changing the filter again.
