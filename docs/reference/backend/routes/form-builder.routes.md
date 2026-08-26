# `src/routes/form-builder.routes.ts`

## Purpose
Implements three related API surfaces under one router: `/api/form-definitions` (admin-managed custom form types with JSON field definitions), `/api/form-records` (per-form-definition record CRUD, auto-numbered), and `/api/global-variables` (admin-managed key-value pairs injectable into any document template as `{{global.key}}`). Also owns the HR Payroll CSV bulk-import endpoint, which delegates parsing to `../hr-payroll-import`.

## Routes / Exports

Mounted with `app.use('/api', formBuilderRoutes)` (note: **not** prefixed `/form-builder` — the router's own paths already start with `/form-definitions`, `/form-records`, `/global-variables`). `router.use(requireAuth)` applies to everything.

### Form definitions
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /form-definitions` | 🔑 any user | — | Lists all form definitions with a subquery `record_count` (COUNT of `form_records` per form), ordered by name. `fields` JSON is parsed via `parseFields()` (swallows parse errors → `[]`). | `200` array with `fields` as parsed array | — |
| `GET /form-definitions/:id` | 🔑 any user | — | Single definition, `fields` parsed. | `200` | `404` if not found |
| `POST /form-definitions` | `requirePermission('forms.manage')` | `formDefinitionSchema` | Inserts `name, slug, number_prefix, icon, fields (JSON.stringify'd), created_by`. | `201 { id }` | 400 invalid body; 403 without permission |
| `PUT /form-definitions/:id` | `requirePermission('forms.manage')` | `formDefinitionSchema` | Checks existence first (404), then updates all fields + `updated_at`. | `200 { ok: true }` | `404` if not found |
| `DELETE /form-definitions/:id` | `requirePermission('forms.manage')` | — | Deletes the definition; `form_records` rows cascade via FK `ON DELETE CASCADE`. | `200 { ok: true }` | `404` if `info.changes === 0` |
| `GET /form-definitions/:id/periods` | 🔑 any user | — | Distinct non-empty `period` values from that form's `form_records`, ordered descending. Used to populate a period filter dropdown. | `200 string[]` | `404` if form id not found |

`formDefinitionSchema` (`src/validation.ts`): `name` (1-120), `slug` (lowercase/digits/underscore, 1-60), `number_prefix` (uppercase letters/digits, default `'FM'`), `icon` (default `'file'`), `fields: FieldDef[]` (each with `key` matching `/^[a-z0-9_]+$/`, `label`, `type` enum `text|number|date|select|textarea|checkbox`, `required`, `options[]`, `default`).

### CSV import (HR Payroll only)
**`POST /form-definitions/:id/import`** — `requirePermission('hr.manage')` *(added 2026-08-25 — see Notes)*, then `csvUpload.single('file')` (multer, `memoryStorage`, 5 MB limit).

Logic, in order:
1. Look up the form definition by `:id` → `404` if missing.
2. If `form.slug !== 'hr_payroll'` → `400 { error: 'CSV import is only available for the HR Payroll form' }`. This is the only form slug this endpoint accepts, hard-coded.
3. If no `req.file` → `400 { error: 'A CSV file is required' }`.
4. `period` must be a non-empty trimmed string in `req.body.period` → `400 { error: 'Payroll period label is required' }` otherwise. (Despite the file-level comment saying "body.period labels the payroll period (required)", this is enforced here, not by a zod schema — the route reads `req.body?.period` directly since the body arrives as multipart form fields alongside the file, not JSON.)
5. Optional `req.body.pay_date` (trimmed string, defaults to `''`) is passed through to the parser and stamped onto every parsed row.
6. Calls `parsePayrollSummaryCsv(req.file.buffer.toString('utf8'), { payDate })` (see `hr-payroll-import.md`). If it returns zero slips → `400 { error: 'No employee rows found in that file' }`.
7. Transaction: for each parsed slip, allocates the next record number via `nextRecordNumber(form.number_prefix, form.id)` and inserts a `form_records` row with `status = 'completed'` and `period` = the request's `period` value (not necessarily anything from the CSV itself — the CSV's own title-cell period is captured separately as `slip.payroll_period`, a data field, not the DB `period` column).
8. On success: `201 { created: numbers.length, numbers, period }`. On any DB error: `ROLLBACK` then rethrow (500).

### Form records
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /form-definitions/:id/records` | 🔑 any user | — | Lists records for a form. Filters: `?status=` (exact), `?period=` (exact), `?q=` (LIKE on `number`). `data` JSON parsed per row (`parseData`, swallows errors → `{}`). Joins `users` for `created_by_name`. | `200` array | `404` if form id unknown |
| `GET /form-records/:id` | 🔑 any user | — | Single record, joined to `form_definitions` for `form_name` and `users` for `created_by_name`; `data` parsed. | `200` | `404` if not found |
| `POST /form-records` | 🔑 any user | `createFormRecordSchema` | Looks up the target form (`input.form_def_id`) → `404` if missing. Transaction: allocates next number via `nextRecordNumber`, inserts `form_def_id, number, data (JSON), status, created_by`. | `201 { id, number }` | `404` unknown form; 400 invalid body |
| `PUT /form-records/:id` | 🔑 any user | `updateFormRecordSchema` | Looks up existing record (404 if missing). Updates `data` and `status` (`input.status ?? existing.status` — omitting status in the request preserves the current one) plus `updated_at`. | `200 { ok: true }` | `404` if not found |
| `DELETE /form-records/:id` | 🔑 any user | — | Deletes the record. | `200 { ok: true }` | `404` if `info.changes === 0` |

`createFormRecordSchema`: `form_def_id` (coerced positive int), `data` (record of string keys ≤64 chars to `string(≤10000)\|number\|boolean\|null`, default `{}`), `status` (default `'draft'`). `updateFormRecordSchema` is the same `data` shape with `status` optional.

Neither create/update/delete route for form records checks a permission beyond `requireAuth` — any logged-in user can create/edit/delete any record for any form, including `hr_payroll` records (Time Keeping's own payslip-generation flow in `hr.routes.ts` is `hr.manage`-gated, but a user could also reach these generic endpoints directly).

### Global variables
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /global-variables` | 🔑 any user | — | Lists all rows from `global_variables`, ordered by key. | `200` `GlobalVariable[]` | — |
| `PUT /global-variables/:key` | `requirePermission('forms.manage')` | `globalVariableSchema` | Validates `:key` matches `/^[a-z0-9_]+$/` → `400` otherwise. Upserts via `INSERT ... ON CONFLICT(key) DO UPDATE` (label, value, updated_by, updated_at). | `200 { ok: true }` | 400 bad key format or body |
| `DELETE /global-variables/:key` | `requirePermission('forms.manage')` | — | Deletes by key. | `200 { ok: true }` | `404` if `info.changes === 0` |

`globalVariableSchema`: `label` (1-120), `value` (≤2000, default `''`).

### Multer error handler
A trailing `router.use((err, req, res, next) => ...)` catches `multer.MulterError` (e.g. file-too-large on the CSV upload) and responds `400 { error: 'Upload failed: ...' }`; other errors are passed to `next(err)` for the app-level central handler.

## Dependencies
- `express` — `Router`, plus `Request`/`Response`/`NextFunction` types for the error-handling middleware signature.
- `multer` — in-memory storage (`csvUpload`) for the CSV import endpoint only; unlike `hr.routes.ts`'s document uploads, files here are never written to disk.
- `../db` — `db` (transactions), `queryOne`, `queryAll`, `run`, `getSetting`, `setSetting`.
- `../auth` — `requireAuth`, `requirePermission`.
- `../validation` — `parseBody`, `formDefinitionSchema`, `createFormRecordSchema`, `updateFormRecordSchema`, `globalVariableSchema`.
- `../hr-payroll-import` — `parsePayrollSummaryCsv`, the pure CSV parser used by the import route.
- `../types` — `FormDefinition`, `FormRecord`, `GlobalVariable` (type-only).

## Used by
- Mounted in `src/app.ts`: `app.use('/api', formBuilderRoutes)`.
- Frontend: `public/js/views/form-builder.js` (admin CRUD for form definitions + global variables, `forms.manage`-gated) and `public/js/views/form-records.js` (record list/create/edit per form; adds "Upload CSV" and "Print Slips" buttons specifically when the form's `slug === 'hr_payroll'`, posting to `/form-definitions/:id/import`).
- `hr-payroll-import.ts`'s `parsePayrollSummaryCsv` is imported **only** here — confirmed via grep, the only production import site is this file's CSV import route; the pure function is otherwise reached only by its own unit test.
- Tests: `tests/form-builder.test.ts` — form definition CRUD + `forms.manage` guard, record create/update/delete + auto-numbering per form, cascade-on-form-delete, global variable upsert/delete, and the HR Payroll CSV import route (400 for non-`hr_payroll` forms, 404 unknown form, 400 missing file, pay-date stamping, field extraction, `completed` status).

## Notes / gotchas
- The router is mounted at bare `/api`, not `/api/form-builder` — its route paths (`/form-definitions`, `/form-records`, `/global-variables`) are the full path segments after `/api`. Easy to misread given the filename.
- **(Fixed 2026-08-25)** The CSV import route used to have no `requirePermission` check — any
  authenticated user could bulk-import payroll records, unlike the rest of HR (`hr.routes.ts`)
  which gates writes behind `hr.manage`. Now gated the same way; covered by a new test in
  `tests/form-builder.test.ts` ("requires hr.manage — a caller without it is rejected").
- `nextRecordNumber` and the record-numbering logic duplicated inline in `hr.routes.ts`'s `generate-payslips` handler (`form_seq_<id>` counter pattern) are two separate implementations of the same idea — `hr.routes.ts` does not call this file's `nextRecordNumber`, it reimplements the counter read/increment locally.
- `POST /form-records` and `PUT /form-records/:id` accept a `data` object with arbitrary string keys (≤64 chars) — the route does **not** validate that those keys match the target form definition's `fields[].key` list, so it's possible to submit data for fields that don't exist on the form (or omit required ones) without a schema-level error.
- Record status defaults to `'draft'` on create, but the CSV-imported records are explicitly forced to `status: 'completed'` in the import route, bypassing the normal default.
