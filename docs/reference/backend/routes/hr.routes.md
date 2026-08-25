# `src/routes/hr.routes.ts`

## Purpose
Implements `/api/hr`: the Employees master list ("201 file" — status, statutory numbers, photo, per-employee document uploads) and Time Keeping (pay-period "cutoffs" with a daily time-in/out roster). It also generates payslip records into the existing `hr_payroll` custom form (`form_records`) so printing reuses the generic Form Records / `hr-payroll-print.js` pipeline rather than a bespoke payroll UI.

## Routes / Exports

Mounted at `/api/hr` (`src/app.ts`), `router.use(requireAuth)` applies to all routes. Every route additionally requires either `hr.view` (read) or `hr.manage` (write) via `requirePermission(...)`.

### Employees
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /employees` | `hr.view` | — | Lists employees with `department_name` (LEFT JOIN `departments`). Filters: `?q=` (LIKE on name), `?department_id=`, `?status=`. Ordered by name. | `200` `Employee[]` | — |
| `POST /employees` | `hr.manage` | `employeeSchema` | Allocates `employee_no` via `nextEmployeeNumber()` (`EMP-#####`, counter key `employee_seq` in `settings`), inserts the row. | `201 { id }` | 400 invalid body |
| `PUT /employees/:id` | `hr.manage` | `employeeSchema` | Checks existence (404), then updates all fields (name, department, position, daily_rate, status, start_date, statutory numbers, photo). `employee_no` is never touched by update. | `200 { ok: true }` | `404` if not found |
| `DELETE /employees/:id` | `hr.manage` | — | Attempts `DELETE FROM employees WHERE id = ?`. | `200 { ok: true }` | `404` if `info.changes === 0`; **`409`** if the delete throws (caught in a `try/catch`) — this happens when `attendance_records.employee_id` (declared `RESTRICT`, per `docs/ARCHITECTURE.md` §3) still references the employee; message instructs to set status to resigned/terminated instead |

`employeeSchema` (`src/validation.ts`): `name` (1-160), `department_id` (optional id), `position` (optional, ≤120), `daily_rate` (coerced number ≥0, default 0), `status` enum `probationary|regular|resigned|terminated` (default `probationary`), `start_date`/`sss_no`/`philhealth_no`/`pagibig_no`/`tin_no` (all optional text), `photo` (optional, `''`→`null`, else must match `/^data:image\//`, max 2,000,000 chars — a client-resized data-URI, never a disk file).

### Employee 201 documents
| Method & path | Auth | What it does | Response | Errors |
|---|---|---|---|---|
| `GET /employees/:id/documents` | `hr.view` | Lists `employee_documents` for the employee (LEFT JOIN `users` for `uploaded_by_name`), newest first. | `200` `EmployeeDocument[]` | `404` if employee not found |
| `POST /employees/:id/documents` | `hr.manage`, `uploadDoc.single('file')` (multer `diskStorage` into `UPLOAD_DIR`, 25 MB limit, filename `${Date.now()}-${randomHex}${ext}`) | `title` defaults to `req.file.originalname` if not supplied/blank. Inserts metadata row (`stored_name` = generated filename, `original_name`, `mime_type`, `size_bytes`, `uploaded_by`). | `201 { id }` | `404` employee not found; `400` if no file attached |
| `GET /employees/:id/documents/:docId/download` | `hr.view` | Looks up the doc scoped to both `id` and `employee_id` match; streams via `res.download(filePath, doc.original_name)`. | file stream | `404` doc not found; **`410`** if the DB row exists but the file is missing on disk (`fs.existsSync` check) |
| `DELETE /employees/:id/documents/:docId` | `hr.manage` | Deletes the DB row, then best-effort `fs.promises.unlink(...)` (errors swallowed with `.catch(() => {})` — a missing file on disk never fails the request). | `200 { ok: true }` | `404` doc not found |

Same physical-file pattern as `forms.routes.ts`, but scoped per-employee and gated by `hr.view`/`hr.manage` instead of department visibility.

### Cutoff periods (`attendance_periods`)
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /periods` | `hr.view` | — | Lists cutoffs with a subquery `employee_count` (`COUNT(DISTINCT employee_id)` from `attendance_records`), ordered `start_date DESC, id DESC`. | `200` `AttendancePeriod[]` | — |
| `GET /periods/:id` | `hr.view` | — | Returns the period header plus a computed `roster`: one row per employee with `days_total` (`COUNT(*)` of their `attendance_records` rows in this period) and `days_logged` (count where `time_in` is non-null/non-empty). | `200` `{ ...period, roster }` | `404` if period not found |
| `POST /periods` | `hr.manage` | `attendancePeriodSchema` | Inserts `label, start_date, end_date, created_by`. | `201 { id }` | 400 invalid body (incl. `end_date < start_date`) |
| `PUT /periods/:id` | `hr.manage` | `attendancePeriodSchema` | Checks existence (404). Transaction: updates the header, then for every employee currently on the roster (distinct `employee_id` from `attendance_records`), calls `ensureRosterDays(id, employee_id, new start_date, new end_date)` to backfill any newly-covered dates. | `200 { ok: true }` | `404` not found |
| `DELETE /periods/:id` | `hr.manage` | — | Deletes the period; `attendance_records` cascade via FK. | `200 { ok: true }` | `404` if `info.changes === 0` |

`attendancePeriodSchema`: `label` (1-120), `start_date`/`end_date` (required, ≤40 chars), with a `.refine()` enforcing `end_date >= start_date`.

### Roster + daily attendance
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `POST /periods/:id/employees` | `hr.manage` | `addRosterEmployeeSchema` | Looks up the period (404) and the employee (404). Calls `ensureRosterDays(periodId, employee_id, period.start_date, period.end_date)` — pre-creates one blank `attendance_records` row per date in the period's range. | `201 { ok: true }` | `404` period or employee not found |
| `DELETE /periods/:id/employees/:employeeId` | `hr.manage` | — | Deletes all `attendance_records` rows for that (period, employee) pair — i.e. removes the employee from the roster entirely, including any logged hours. | `200 { ok: true }` | `404` if `info.changes === 0` (employee wasn't on the roster) |
| `GET /periods/:id/attendance?employee_id=` | `hr.view` | — | Returns that employee's daily rows for the period, ordered by `work_date`. | `200` `AttendanceRecord[]` | `400` if `employee_id` query param missing/falsy |
| `PUT /periods/:id/attendance` | `hr.manage` | `saveAttendanceSchema` | Checks period exists (404) and employee exists (404). Transaction: `DELETE`s all existing rows for (period, employee), then bulk-inserts the submitted `days[]` (each `work_date, time_in, time_out, notes`, blanks → `null`). This is a **full replace**, not a per-day upsert. | `200 { ok: true }` | `404` period or employee not found |

`saveAttendanceSchema`: `employee_id` (coerced positive int), `days[]` (max 62 entries — covers up to a ~2-month range) each `{ work_date, time_in?, time_out?, notes? }`. `addRosterEmployeeSchema`: just `employee_id`.

### Generate payslips
**`POST /periods/:id/generate-payslips`** — `requirePermission('hr.manage')`, body validated by `generatePayslipsSchema` (`payroll_period` required 1-120 chars, `pay_date` optional ≤40 chars).

Logic:
1. Look up the period (404 if missing). `payrollPeriod = input.payroll_period || period.label` — in practice `input.payroll_period` is always truthy (the schema requires `min(1)`), so this always resolves to the submitted value; `period.label` is a fallback that the current schema cannot actually trigger.
2. Look up the `hr_payroll` form definition by slug (`SELECT * FROM form_definitions WHERE slug = 'hr_payroll'`) → `400` if it doesn't exist ("check Admin > Form Builder").
3. Build the roster: `SELECT DISTINCT e.id, e.name, e.position, e.daily_rate, d.name AS department_name` joined from `attendance_records` for this `period_id` — i.e. the roster is whoever has *any* `attendance_records` row in this period (added via the roster-add endpoint), not everyone in `employees`. Empty roster → `400 { error: 'This cutoff has no employees yet' }`.
4. Transaction: for each roster employee —
   - `deptPosition` = `[department_name, position].filter(Boolean).join(' / ')`.
   - `zeros` — a full zeroed-out payslip shape (`days_worked, ot_hours, ot_rate_hour, basic_salary, overtime_pay, undertime_pay, holiday_pay, special_holiday_30, rest_day_ot, total_earnings, sss, philhealth, pagibig, cash_advance, late_absences, total_deductions, net_pay`) — this is the full set of numeric fields the `hr_payroll` form's payslip UI expects.
   - **Match existing record**: queries all `form_records` where `form_def_id = hr_payroll.id AND period = payrollPeriod`, then in JS filters to the one whose parsed `data.employee_name` equals `emp.name` (a plain string match, not a DB-level query) — i.e. matching is by **employee name + period label**, not by employee id.
   - **If a match exists** (update path): merges `{ ...zeros, ...prev }` (so any previously-entered earnings/deductions/hours are preserved — `prev` overwrites the zero defaults) then overwrites identity/rate/period fields (`employee_name, dept_position, payroll_period, daily_rate`) and `pay_date` (`input.pay_date || prev.pay_date || ''`). Runs `UPDATE form_records SET data = ?, updated_at = ...`. Increments `updated`.
   - **If no match** (create path): starts from `{ ...zeros, employee_name, dept_position, payroll_period, pay_date: input.pay_date || '', daily_rate }` — hours/earnings/deductions all zero, left for manual entry. Allocates the next record number inline (reads/increments `settings` key `form_seq_<form.id>`, formats `PREFIX-#####` — a second, separate implementation of the same counter pattern used by `nextRecordNumber` in `form-builder.routes.ts`). Inserts with `status = 'draft'`. Increments `created`.
5. On success: `201 { created, updated, period: payrollPeriod, form_id: form.id }`.

`generatePayslipsSchema`: `payroll_period` (required, 1-120), `pay_date` (optional, ≤40).

### Multer error handler
Trailing middleware catches `multer.MulterError` (document upload too large, etc.) → `400 { error: 'Upload failed: ...' }`.

## Dependencies
- `node:path`, `node:fs`, `node:crypto` — building the on-disk stored filename and streaming/deleting uploaded 201 documents.
- `express` — `Router`, plus `Request`/`Response`/`NextFunction` for the error middleware.
- `multer` — `diskStorage` for document uploads (`docStorage`/`uploadDoc`), writing into `UPLOAD_DIR` (imported from `../db`).
- `../db` — `db` (transactions + `db.prepare(...).run(...)` inside `ensureRosterDays`), `queryOne`, `queryAll`, `run`, `getSetting`, `setSetting`, `UPLOAD_DIR`.
- `../auth` — `requireAuth`, `requirePermission`.
- `../validation` — `parseBody`, `employeeSchema`, `attendancePeriodSchema`, `saveAttendanceSchema`, `addRosterEmployeeSchema`, `generatePayslipsSchema`.
- `../types` — `Employee`, `EmployeeDocument`, `AttendancePeriod`, `FormDefinition`, `FormRecord` (type-only).

## Used by
- Mounted in `src/app.ts`: `app.use('/api/hr', hrRoutes)`.
- Frontend: `public/js/views/hr-employees.js` (Employees master list, 201 documents, Generate ID) and `public/js/views/hr-timekeeping.js` (cutoff list, roster, daily attendance grid, "Generate Payslips" button). `public/js/views/hr.js` (the HR module launcher) does not call `/api/hr` itself — it looks up the `hr_payroll` form and jumps into Form Records.
- Tests: `tests/hr.test.ts` (form auto-seeding, employee CRUD incl. auto-numbering/status/statutory fields/photo validation/filters, 201 document upload/list/download/delete, delete-blocked-with-attendance-history 409, cutoff creation, roster-add pre-populates blank days, bulk attendance save replace-in-place, generate-payslips create/update-not-duplicate semantics + empty-roster 400, `hr.view`/`hr.manage` enforcement) and `tests/hr-migration.test.ts` (regression test for the `employees` table rebuild migration, exercised via `src/db` `init()`, not this router directly).

## Notes / gotchas
- **`ensureRosterDays(periodId, employeeId, start, end)`** uses `INSERT OR IGNORE` on `attendance_records(period_id, employee_id, work_date)` (the table's `UNIQUE(period_id, employee_id, work_date)` constraint makes this idempotent) — calling it again for a range that's already (partially) covered only inserts the missing dates, never duplicates or overwrites existing rows. It's called from both `POST /periods/:id/employees` (adding an employee) and `PUT /periods/:id` (widening a cutoff's date range for everyone already on it) — but note `PUT /periods/:id` only extends coverage for employees who already have at least one row in that period; it never removes rows if the range is narrowed.
- **An employee is "on the roster" purely by having ≥1 `attendance_records` row for that period** — there is no separate roster/membership table. `DELETE /periods/:id/employees/:employeeId` removing all such rows is equivalent to "not on the roster" again, and `generate-payslips`'s roster query (`SELECT DISTINCT ... FROM attendance_records ...`) reflects this directly.
- **Generate-payslips matching is name + period, not employee_id**: because the match is `JSON.parse(r.data).employee_name === emp.name` scoped to `period = payrollPeriod`, renaming an employee between generations, or two employees sharing the exact same `name` string, will change or break the update-vs-create outcome (a rename creates a new draft record instead of updating the old one; a name collision would match the first record found by the array `.find()`, which is not deterministic against insertion/update history beyond SQL's default row order).
- **Update-path preserves manual entries**: `{ ...zeros, ...prev }` means any hours/earnings/deductions a user already typed into the payslip via the Form Records UI survive re-running "Generate Payslips" — only the identity/rate/period/pay_date fields are forced to current values. This is what lets HR regenerate payslips after adding a late roster employee without wiping out already-entered figures for everyone else.
- **`generatePayslipsSchema.payroll_period` is required (`min(1)`)**, so the `input.payroll_period || period.label` fallback on line ~338 can never actually select `period.label` under the current schema — it would only matter if the schema were relaxed to make `payroll_period` optional.
- The record-numbering logic here (`form_seq_${form.id}` counter) duplicates `form-builder.routes.ts`'s `nextRecordNumber()` rather than importing it — a shared helper was not factored out.
- Deleting an employee is blocked (`409`) specifically because `attendance_records.employee_id` is a `RESTRICT` foreign key (per `docs/ARCHITECTURE.md` §3); the route relies on the DB throwing rather than pre-checking with a `SELECT COUNT(*)`.
