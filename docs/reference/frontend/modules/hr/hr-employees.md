# `public/js/views/hr-employees.js`

## Purpose
Employees master list — the "201 file". CRUD for `employees` rows (identity, department/position, daily rate, employment status, start date, statutory numbers, a client-resized photo), per-employee document uploads, and "Generate ID" virtual ID-card printing via the document-template engine. Feeds Time Keeping (employees are picked from here onto cutoff rosters) and generated payslips (name/rate/department). Route: `hr-employees`.

## Registered route(s)
```js
App.register('hr-employees', async (view) => { ... })
```
No `filter` keys are read by this view (unlike `hr-timekeeping`'s `filter.period_id`). All state (`state.q`, `state.department_id`, `state.status`) is purely in-view, driven by the search box and two filter `<select>`s.

## Structure / key functions

### Setup / constants
- **`STATUS_LABELS`** / **`STATUS_CLASS`** — label and badge-CSS-class maps for the four `status` values (`probationary`/`regular`/`resigned`/`terminated`).
- **`PLACEHOLDER_PHOTO`** — inline SVG data URI shown wherever an employee has no `photo` set (table thumbnail, modal preview, ID card fallback).
- **`state`** — `{ q, department_id, status }`, mutated by the search input (debounced) and the two filter selects, each triggering `load()`.

### Department quick-add/remove (inline, next to the Department select)
- **`addDepartmentInline(targetSelect)`** — modal with a single name field; `POST /users/departments`, then pushes the new dept into the local `depts` array (kept sorted), rebuilds both the modal's own department `<select>` (`targetSelect`) and the page-level `#emp-dept-filter` options, selects the new department in `targetSelect`.
- **`removeDepartmentInline(targetSelect)`** — deletes whatever department is currently selected in `targetSelect` after a confirm dialog; `DELETE /users/departments/:id`. Server enforces that the department isn't referenced outside HR (users/items/forms) when the caller only has `hr.manage`; a failure surfaces the server's error message via `UI.toast`. On success, rebuilds the same two selects from the updated local `depts` list.
- These two live inside the employee create/edit modal next to the Department field (`#emp-dept-new` / `#emp-dept-del` icon buttons) — renaming a department is *not* available here (only in Admin ▸ Accounts ▸ Departments, which requires `users.manage`).

### List loading / rendering
- **`ensureDepts()`** *(async, memoized)* — lazily loads `GET /users/departments/list` into module-level `depts` once; reused by both the filter select and the employee modal's department select.
- **`load()`** *(async)* — ensures departments are loaded, populates `#emp-dept-filter` once (only if it still has just the default option), builds a query string from `state` (`q`, `department_id`, `status`), fetches `GET /hr/employees?...`, calls `render()`.
- **`render(list)`** — empty state (different hint/CTA depending on whether filters are active) or a table: photo thumbnail, name, `employee_no`, department, position, daily rate (via local `money()` formatter), status badge, and row actions (Generate ID / Edit / Delete). Row click (outside `.actions`) opens the edit modal.
- **`openEmployee(id, list)`** — looks up the employee in the already-loaded `list` and opens `employeeModal(emp)`.

### Photo capture
- **`resizeImageToDataUrl(file, maxDim, quality)`** — Promise-based pipeline: `FileReader.readAsDataURL` → `Image` load → draw onto an offscreen `<canvas>` scaled so the longer side is at most `maxDim` (aspect-preserving) → `canvas.toDataURL('image/jpeg', quality)`. Called with `(file, 320, 0.82)` from the modal's file-picker `change` handler. The result is a plain JPEG data URI string held in the closure variable `photoData` — nothing is uploaded to a separate endpoint; it travels as a normal field in the employee create/update payload (`photo`). There is no server-side image file storage for employee photos (see `src/shared/db.ts`/`employees.photo` column in `docs/ARCHITECTURE.md` §3).

### Create/edit modal
- **`employeeModal(existing)`** *(async wrapper around `ensureDepts().then(...)`)* — builds and opens a `size: 'lg'` `UI.modal`:
  - Header action (`headActionHTML`, edit mode only): "Generate ID" button, calls `generateId(existing)` directly from the modal head (independent of the list-row Generate ID button).
  - Photo block: live preview `<img>`, hidden `<input type="file" accept="image/*">` triggered by a "Choose photo" button, "Remove" button that clears `photoData` and resets the preview to `PLACEHOLDER_PHOTO`.
  - Identity/employment fields: name (required), department select (+ the inline add/delete buttons described above), position, daily rate (`number`, `step="0.01"`), status select, start date (`date` input).
  - Statutory numbers: SSS/PhilHealth/Pag-IBIG/TIN, all free-text.
  - **201 documents** section — edit mode only (`existing` truthy); see below.
  - `onOpen`: wires the Generate ID header button, department add/delete buttons, the photo file input's `change` handler (calls `resizeImageToDataUrl`), the Remove-photo button, and (edit mode only) the documents list loader/upload wiring.
  - `onConfirm`: validates `name` non-empty; builds the body (`name`, `department_id` or `null`, `position`, `daily_rate` coerced to `Number`/`0`, `status`, `start_date`, four statutory fields trimmed, `photo: photoData`); `PUT /hr/employees/:id` if editing else `POST /hr/employees`; toasts; `load()`.

### 201 documents (inside the edit modal only)
- **`loadDocs()`** (closure inside `onOpen`) — `GET /hr/employees/:id/documents`, renders a `tool-row` per document (title, original filename, short date) with Download/Delete icon buttons.
- Upload: hidden `<input type="file">` triggered by an "Upload document" button; on `change`, builds a `FormData` with `file` and `title` (defaults to the picked file's name — there's no title-editing UI, the filename *is* the title unless changed later some other way), `API.upload('/hr/employees/:id/documents', fd)`, reloads the doc list.
- **`downloadDoc(employeeId, docId, docs)`** — does a raw authenticated `fetch()` (not through `API.get`, since it needs the response as a `Blob`) with a manual `Authorization: Bearer ${API.getToken()}` header, then synthesizes a temporary `<a download>` click to save the blob client-side.
- Delete: confirm dialog, `DELETE /hr/employees/:id/documents/:docId`, reload.

### Virtual ID card
- **`FALLBACK_ID_TEMPLATE`** — inline CR-80-card-sized HTML/`{{var}}` template used only if no "Employee ID Card" `doc_templates` row exists (defensive fallback; the real template is seeded server-side and editable in Documents ▸ Templates).
- **`generateId(emp)`** *(async)* — fetches `GET /templates` (to find the template named exactly `'Employee ID Card'`) and `GET /templates/company` in parallel; if found, fetches that template's full body via `GET /templates/:id`, else uses `FALLBACK_ID_TEMPLATE`. Builds a context `{ company, employee: { name, employee_no, position, department, photo }, today }` (note: `department` here is `emp.department_name`, a flat string, not an id/object) and renders it with the global `renderTemplate()`, wrapped in `UI.printableHtml()`. Shows the result in a `UI.modal()` containing an `<iframe srcdoc="...">`; the modal's Confirm button (labeled "Print…") calls `ifr.contentWindow.print()` and returns `false` so the modal stays open (per the `onConfirm` contract in `ui.js`, returning `false` skips the auto-close) — this is the same preview-modal-plus-iframe pattern used by `printSlips()` in `form-records.js`, deliberately chosen over `UI.printDocument()`'s `window.open()` because an iframe inside an already-open modal can never be popup-blocked.

### Delete
- **`del(id, list)`** — confirm dialog, `DELETE /hr/employees/:id`, toast, `load()`. The server 409s if the employee has attendance history; that error message (from `err.message`) is surfaced via `UI.toast` as-is — the UI gives no extra guidance beyond the server's message (which advises setting status to resigned/terminated instead, per `docs/ARCHITECTURE.md`'s API catalog note on `DELETE /hr/employees/:id`).

## API endpoints used
- `GET /hr/employees?q=&department_id=&status=` — list (search/filtered).
- `POST /hr/employees` / `PUT /hr/employees/:id` — create/update.
- `DELETE /hr/employees/:id` — delete (409 if attendance history exists).
- `GET /hr/employees/:id/documents` — list 201 documents.
- `POST /hr/employees/:id/documents` — upload (multipart, via `API.upload`).
- `GET /hr/employees/:id/documents/:docId/download` — download (raw `fetch`, not `API.get`, to get a `Blob`).
- `DELETE /hr/employees/:id/documents/:docId` — delete a document.
- `GET /users/departments/list` — department options (lightweight id+name list, shared with other views).
- `POST /users/departments` / `DELETE /users/departments/:id` — inline department add/remove.
- `GET /templates`, `GET /templates/:id`, `GET /templates/company` — ID card generation.

## Permissions honored
No `App.hasPermission` calls appear in this file at all — every action (create/edit/delete employee, document upload/delete, department add/delete) is offered unconditionally in the UI and relies entirely on the server (`hr.view` for reads, `hr.manage` for writes, per `src/modules/hr/hr.routes.ts`) to reject unauthorized calls. A user with only `hr.view` would see all the buttons but get server errors attempting writes — the UI does not hide/disable them proactively.

## Dependencies
- `App.register`.
- `API` (`get/post/put/del/upload/getToken`).
- `UI` (`icon`, `esc`, `emptyState`, `modal`, `confirmDialog`, `toast`, `fmtDateShort`, `printableHtml`).
- `renderTemplate` (global, `public/js/doc-template.js`) — for the ID card.
- Raw `fetch` + `URL.createObjectURL` — for authenticated document downloads (bypasses `API.js`'s JSON-oriented helpers).
- Browser `Image`/`FileReader`/`<canvas>` — for photo resizing, no external library.

## Notes / gotchas
- **No permission gating in the UI** (see above) — this is the one HR view among the three that has zero `App.hasPermission` checks; `hr-timekeeping.js` is the same in this respect, but worth flagging explicitly since it means UI affordances (buttons) don't reflect what the current user can actually do.
- Photos are never uploaded as files — they live entirely as base64 JPEG data URIs inside the `employees.photo` TEXT column, capped implicitly by the `320`px/`0.82`-quality resize call. Changing those two literals in `resizeImageToDataUrl(file, 320, 0.82)` is the only lever for photo size/quality; there's no server-side validation of the data URI's byte size (only a max-length string check via `employeeSchema`, if any — see `src/shared/validation.ts`).
- The inline department delete (`removeDepartmentInline`) can fail silently-ish from the user's perspective if the department is used elsewhere — the only feedback is a generic `UI.toast(e.message, 'error')` with whatever message the server returned; there is no pre-check in the frontend to warn before attempting.
- Document `title` is always the original filename on upload — there's no rename-after-upload UI; to give a document a different display title, this file would need a text input added to the upload flow or a dedicated edit action.
- `generateId()`'s employee context's `department` field name (`employee.department`) differs from the raw employee row's own field name (`department_id`/`department_name` from the API) — deliberately reshaped for the `{{employee.department}}` template token to be a plain readable string, not the joined `department_name` field's original key.
- The list's "Generate ID" button and the edit modal's header "Generate ID" button both call the same `generateId(emp)` function but reach it from different DOM contexts (table row action vs. modal head action) — no behavior difference between them.
