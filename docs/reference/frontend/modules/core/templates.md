# `public/js/views/templates.js`

## Purpose
Document Templates view: browse/preview all printable `doc_templates`, and (for `templates.edit` holders) create/edit them in the full-screen `DocEditor`, manage per-template and global template variables, and edit the company profile used by `{{company.*}}` tokens. Reached via the nav leaf that routes to `templates` (Documents area).

## Registered route(s)
```js
App.register('templates', async (view) => { ... })
```
Single registration, no `filter` parameter is read — the view always shows the full template list (with an in-page period dropdown filter, not nav-driven).

## Structure / key functions
- **`SAMPLE_PHOTO`** — inline SVG data URI, a neutral placeholder headshot used only inside the editor's mock preview context.
- **`SAMPLE`** — the mock render context (`company`, `order`, `items`, `employee`, `user`, `today`) fed to `renderTemplate()` for the editor's live preview and the list's Preview action. Includes an `employee` block (name/employee_no/position/department/photo) so HR-oriented templates like "Employee ID Card" preview realistically alongside order-oriented ones.
- **`load()`** — `GET /templates`, populates the period `<select>` from the distinct `t.period` values present (client-side derived, most-recent first, sorted via `localeCompare` descending), then calls `render()` with the currently selected period's subset.
- **`render(list)`** — draws the table, grouped by `period` (sorted keys, no-period group last) with a header row per group. Wires row/button clicks to `openPreview`, `openEdit` (`admin` only), `del` (`admin` only). Non-action row click opens edit for admins, preview for everyone else.
- **`buildVarList(catalog, custom)`** — flattens the server variable catalog (`{group, items:[{label,path}]}`) plus this template's/global custom variables into the flat `{category, label, token}` list the `DocEditor` variable picker expects.
- **`previewContext(custom)`** — deep-clones `SAMPLE` and, if the global `applyVariables` helper (from `doc-template.js`) is loaded, resolves custom variables into it for the live preview.
- **`BLANK_BODY`** — minimal HTML/`{{var}}` scaffold (just the company letterhead + a prompt line) seeded into the editor for a "start fresh" new template.
- **`STARTERS`** — array of ready-made starting points offered by `newTemplateModal()`. Each entry is `{ id, name, type, icon, group, blurb, body }` where `body` is a full, deliberately distinct layout in plain HTML + `{{tokens}}` (not one shared shell with a swapped heading). `group` is `'Sales & purchasing'` (Sales Invoice, Quotation, Delivery Receipt, Purchase Order, Job Order — order-bound, use `order.*`/`{{#items}}`) or `'Generic documents'` (Official Receipt, Statement of Account, Business Letter, Internal Memo, Certificate of Employment — mostly prose / fill-in-the-blank, `[bracketed]` placeholders for data the render context can't supply). Picking one seeds the editor's name/type/body; everything stays editable afterwards.
- **`newTemplateModal()`** — the picker shown when the New template button is pressed (`size: 'lg'` `UI.modal`): a `.tpl-starter-grid` with `.tpl-starter-section` headers — "Start from scratch" (a dashed "Blank document" tile, `data-starter=""`), then one section per distinct `STARTERS` `group`, then a **"Copy an existing template"** section (only if `fullList` is non-empty) listing every current `doc_template` (the seeded HR Payroll Slip / Employee ID Card / BIR 2316, plus anything added) as a `data-copy="<id>"` tile, icon from `TYPE_ICON[type]`. A `data-starter` tile calls `editor(null, starter)` (or `editor(null, null)` for blank); a `data-copy` tile does `GET /templates/:id` then `editor(null, { name: name + ' (copy)', type, body })` — a synthetic starter, so the new template is an editable copy that saves as its own row.
- **`editor(tpl, starter)`** *(async)* — opens `DocEditor.open({...})` in edit (`tpl` truthy) or create mode. When creating, `starter` (a `STARTERS` entry or `null`) supplies the initial `name`/`type`/`body` — `null` falls back to `''`/`'sale'`/`BLANK_BODY`. Loads the variable catalog (`GET /templates/variables/catalog`) and this template's/global variables (`GET /templates/variables?template_id=`) in parallel. Passes `getVariables`, `sampleContext`, `renderPreview` (wraps `renderTemplate` + `UI.printableHtml`), `onManageVars` (opens `variableManager()` then reloads vars and calls `ed.refresh()`), and `onSave` (validates name/body non-empty, `PUT`/`POST /templates(/:id)`, toasts, reloads the list). Bails with a toast if `window.DocEditor` isn't loaded.
- **`variableManager(scope, templateId, catalog)`** — returns a `Promise` resolved when the modal closes. Lists custom variables filtered to `scope` (`'global'` or `'template'` + matching `template_id`), grouped by `category`; each row shows key, label, source-type badge, and a human `detail()` string (constant value / `↳ field_path` / `ƒ formula`). Edit/delete buttons call `varForm()` / `DELETE /templates/variables/:id`.
- **`varForm(scope, templateId, catalog, v, after)`** — create/edit modal for one custom variable: `key` (locked once created, validated `^[a-zA-Z_]\w{0,63}$` on create), `label`, `category`, `source_type` (constant/field/formula — toggles which `[data-when]` block is visible), `data_type` (text/number/currency/date), and the matching value input (`value`, `field_path` select built from `catalog`, or `formula`). Saves via `PUT`/`POST /templates/variables(/:id)`, then calls `after()` to refresh the manager list.
- **`del(id, list)`** — confirm dialog, `DELETE /templates/:id`, reload.
- **`companyModal()`** *(async)* — `GET /templates/company`, shows name/address/phone/email/logo_url; inputs are `disabled` for non-admins (view-only). Admin confirm does `PUT /templates/company`.

## API endpoints used
- `GET /templates` — list.
- `GET /templates/:id` — detail (for preview and edit).
- `POST /templates`, `PUT /templates/:id`, `DELETE /templates/:id` — CRUD (admin-gated by `templates.edit`).
- `GET /templates/variables/catalog` — server field catalog for the variable picker/`field_path` selects.
- `GET /templates/variables` and `GET /templates/variables?template_id=X` — list custom variables (global or template-scoped).
- `POST /templates/variables`, `PUT /templates/variables/:id`, `DELETE /templates/variables/:id` — custom variable CRUD.
- `GET /templates/company`, `PUT /templates/company` — company profile.

## Permissions honored
- `templates.edit` (`admin` local const) — gates: New template button, per-row Edit/Delete buttons, row-click-to-edit vs row-click-to-preview, the Variables toolbar button, and whether the company profile modal's fields/Save are enabled (view-only otherwise). No permission check gates viewing the list or previewing — any logged-in user can reach this route.

## Dependencies
- `App.register`, `App.hasPermission`.
- `API` (`get/post/put/del`).
- `UI` (`icon`, `esc`, `fmtDate`, `emptyState`, `modal`, `printDocument`, `printableHtml`, `toast`, `confirmDialog`).
- `window.DocEditor` (`public/js/doc-editor.js`) — the full-screen template editor; this view only builds its `opts` and hands off.
- `renderTemplate` (global, from `public/js/doc-template.js`) — used both for list-row Preview (via `UI.printDocument`) and inside `editor()`'s `renderPreview`.
- `applyVariables` (optional global, also from `doc-template.js`) — resolves custom variables into the sample context if present.

## Notes / gotchas
- List Preview (`openPreview`) still uses `UI.printDocument()` (`window.open()`-based), unlike the newer preview-modal+iframe pattern used elsewhere (e.g. `form-records.js`'s `printSlips()`, `hr-employees.js`'s `generateId()`) — it can be popup-blocked since it fires synchronously off a click here, but if that pattern is copied into an async flow it should switch to the iframe pattern instead.
- The period filter is entirely client-side derived from whatever `period` values already exist in the loaded list — there's no server-side period query param.
- `varForm`'s `key` input is `disabled` when editing; the payload still reads `v.key` (not the disabled input's value) in that case, so renaming a variable's key isn't supported via this form.
- `SAMPLE.employee.photo` is a self-contained inline SVG (not a network image), keeping the preview offline-safe.
