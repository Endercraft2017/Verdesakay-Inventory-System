# `public/js/views/hr-timekeeping.js`

## Purpose
Time Keeping: manage pay "cutoff" periods (`attendance_periods`) and, per cutoff, a roster of employees with a daily time-in/time-out grid (`attendance_records`). Also drives "Generate Payslips", which bulk-creates/updates records in the `hr_payroll` custom form so payroll can be filled in and printed via the existing Form Records flow. Route: `hr-timekeeping`.

## Registered route(s)
```js
App.register('hr-timekeeping', async (view, filter) => { ... })
```
- No `filter.period_id` → `renderList(view)`: the cutoff list screen.
- `filter.period_id = <id>` → `renderPeriod(view, Number(filter.period_id))`: the cutoff detail screen (roster + daily grids). This is how the list screen and `App.navigate('form-records', {...})`'s round trip both re-enter a specific cutoff — clicking a cutoff row calls `App.navigate('hr-timekeeping', { period_id })`, which re-invokes this same registered handler with the new filter.

Unlike most views, this file defines its top-level functions **outside** the `App.register` callback (`renderList`, `periodModal`, `renderPeriod` are module-scope functions declared after the registration), rather than as closures inside it — worth knowing if searching for where state lives (each call to `renderPeriod`/`renderList` creates its own fresh closures internally; nothing here is shared module state across periods).

## Structure / key functions

### Cutoff list (`renderList(view)`)
- **`load()`** — `GET /hr/periods`, `render()`.
- **`render(list)`** — empty state or a table (label, date range, employee count via `p.employee_count`, delete action). Row click navigates to `hr-timekeeping` with `{ period_id: tr.dataset.open }`.
- **`del(id, list)`** — confirm ("All logged time-in/out for it will be lost"), `DELETE /hr/periods/:id`, reload.
- "New Cutoff" button (`#tk-new`, plus the empty-state's own CTA) opens `periodModal(null, load)`.

### Cutoff create/edit modal (`periodModal(existing, onSaved)`)
Module-scope, shared by both the list screen (create) and the detail screen's "Edit Cutoff" button (edit). Fields: label, start date, end date (all required, client-validated before submit — no cross-field date-order validation client-side, that's enforced by the server's `attendancePeriodSchema` `.refine()` requiring `end_date >= start_date`). `PUT /hr/periods/:id` or `POST /hr/periods`; calls the passed-in `onSaved()` callback afterward (either the list's `load()` or the detail screen's inline refresh-and-`renderRoster()` callback).

### Cutoff detail (`renderPeriod(view, periodId)`)
- Fetches `GET /hr/periods/:id` into `period` (includes `.roster`, an array of `{employee_id, name, department_name, daily_rate, days_logged, days_total}`); shows a "Cutoff not found" empty state if the fetch throws (e.g. deleted/bad id).
- Toolbar: Back (`App.navigate('hr-timekeeping')`, dropping the filter to return to the list), Edit Cutoff, Generate Payslips, Add Employee.
- **`renderRoster()`** — table of roster rows (name, department, daily rate, `days_logged / days_total`, remove action). Row click opens `dailyGridModal(r)`.
- **`reload()`** — refetches `GET /hr/periods/:id` into `period` and re-renders the roster; called after add/remove employee, after saving attendance, and after editing the cutoff itself.
- **`removeEmployee(employeeId, roster)`** — confirm ("Their logged time for it will be lost"), `DELETE /hr/periods/:id/employees/:employeeId`, `reload()`.

#### Add Employee (`addEmployeeModal()`)
Mirrors the `pickInventory()` picker pattern used in `orders.js`. Builds an `onRoster` `Set` of employee ids already on the roster to exclude from results. Modal has a debounced search box plus department/status filter selects; each keystroke/change re-runs `search()`, which queries `GET /hr/employees?q=&department_id=&status=` and client-filters out anything already in `onRoster`. Clicking a result row immediately does `POST /hr/periods/:id/employees` with `{ employee_id }`, closes the modal (`m.close()`), and `reload()`s the roster — there's no separate "confirm selection" step, picking a row adds it right away.

#### Daily grid (`dailyGridModal(rosterRow)`)
- `GET /hr/periods/:id/attendance?employee_id=X` — returns one row per date in the cutoff's date range (pre-populated blank server-side when the employee was added, per `ensureRosterDays` in `hr.routes.ts`).
- Renders a `size: 'xl'` modal with a table: one `<tr>` per day, columns Date (read-only text), Shift (`<select>`), Time In (`<input type="time">`), Lunch Out, Lunch In, Time Out (all `<input type="time">`), Day Type, Rest Day, Notes (free text), Linked Form. Each input's `input` event handler writes straight back into the in-memory `days[row]` object (no debounce, no separate "dirty" tracking — every keystroke mutates the array that will be submitted). Lunch Out / Lunch In are for the record only — payroll still deducts the fixed `PayrollPolicy.lunch_break_minutes` (a tooltip on each says so).
- Confirm (Save): `PUT /hr/periods/:id/attendance` with `{ employee_id, days: [...] }` where each day is normalized to `{ work_date, time_in, time_out, lunch_out, lunch_in, notes, shift_id, form_record_ids, ... }` (empty string, not `null`, for unset time fields — matches `saveAttendanceSchema`'s `attendanceDaySchema` shape, one call replaces the *entire* day set for that employee in that period). Toasts, `reload()`s the roster (updates `days_logged`).
- HR can also bulk-fill the grid from the raw time clock via **Import punches** (`POST /hr/clock/import/:periodId`, `src/clock.ts` `importPunchesForPeriod`) — the day's punches are split into `time_in` / `lunch_out` / `lunch_in` / `time_out` by the segment `classify()` already tagged each punch with; only columns still blank are filled (a hand-typed value is never overwritten).

#### Generate Payslips (`generateModal()`)
- Modal explaining the effect (creates/updates one `hr_payroll` record per roster employee, pre-filled with name/department/position/daily rate; hours/earnings/deductions left blank for manual entry). Fields: `payroll_period` (pre-filled with `period.label`, editable, required — this becomes the payroll form's `period` value, and separately gets stamped onto `form_records.period` per the server), `pay_date` (optional date input).
- Confirm: `POST /hr/periods/:id/generate-payslips` with `{ payroll_period, pay_date }`. Response is `{ created, updated, period, form_id }`. Toasts a summary, then opens a **second** modal ("Payslips ready") confirming counts, whose own Confirm button (labeled "Open Payroll") does `App.navigate('form-records', { form_id: res.form_id, period: res.period })` — jumping straight into the `hr_payroll` form's records, pre-filtered to this payroll period via `form-records.js`'s `filter.period` handling.

## API endpoints used
- `GET /hr/periods` — cutoff list.
- `POST /hr/periods`, `PUT /hr/periods/:id`, `DELETE /hr/periods/:id` — cutoff CRUD.
- `GET /hr/periods/:id` — cutoff header + roster (with `days_logged`/`days_total` per employee).
- `POST /hr/periods/:id/employees` — add employee to roster.
- `DELETE /hr/periods/:id/employees/:employeeId` — remove employee from roster.
- `GET /hr/periods/:id/attendance?employee_id=` — one employee's daily rows.
- `PUT /hr/periods/:id/attendance` — replace one employee's daily rows.
- `POST /hr/periods/:id/generate-payslips` — bulk create/update payroll records.
- `GET /hr/employees?q=&department_id=&status=` — employee search for the Add Employee picker (shared endpoint with `hr-employees.js`).
- `GET /users/departments/list` — department options for the Add Employee picker's filter.

## Permissions honored
No `App.hasPermission` calls in this file — like `hr-employees.js`, every action is offered unconditionally in the UI, and enforcement is entirely server-side (`hr.view` read / `hr.manage` write on all `/api/hr/periods*` routes).

## Dependencies
- `App.register`, `App.navigate`.
- `API` (`get/post/put/del`).
- `UI` (`icon`, `esc`, `emptyState`, `modal`, `confirmDialog`, `toast`).
- No `doc-template.js`/`renderTemplate` usage in this file — payslip *printing* happens entirely in `form-records.js` (`printSlips()`) after "Generate Payslips" hands off; this file only creates/updates the underlying `form_records` rows.

## Notes / gotchas
- The date-range roster pre-population (blank rows for every date in the cutoff) happens server-side (`ensureRosterDays` in `hr.routes.ts`) when an employee is added — this file never computes the date range itself, it just renders whatever rows `GET /hr/periods/:id/attendance` returns.
- Editing a cutoff's dates (`periodModal` in edit mode) can widen the range; per the API catalog (`docs/ARCHITECTURE.md` §4), the server extends day-rows to cover a widened range — this file doesn't need to (and doesn't) do anything special for that beyond calling `reload()`/`renderRoster()` after save.
- `dailyGridModal`'s per-keystroke mutation of the `days` array means there's no way to "cancel" partial edits within one field once typed (closing the modal via Cancel simply discards the whole in-memory `days` array, since it's re-fetched fresh next time the modal opens — no state persists across modal opens).
- `addEmployeeModal`'s "click a row to add" (no confirm step) means a mis-click immediately writes to the roster; the only recovery is `removeEmployee` afterward.
- Generate Payslips is safe to run multiple times for the same cutoff — the server matches existing records by employee name + period and **updates** rather than duplicates (per `docs/ARCHITECTURE.md` §2's description of `POST /hr/periods/:id/generate-payslips`), which is why the response distinguishes `created` vs `updated` counts shown in the toast/confirmation modal.
- `renderPeriod`'s inner functions (`renderRoster`, `reload`, `removeEmployee`, `addEmployeeModal`, `dailyGridModal`, `generateModal`) all close over the same `period` variable declared with `let` at the top of `renderPeriod` — `reload()` reassigns it, and every other closure reads the reassigned value on next call, so there's no stale-`period` risk as long as all mutations go through `reload()`.
