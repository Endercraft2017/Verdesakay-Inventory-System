# `src/modules/payroll/hr-payroll-import.ts`

## Purpose
Pure, dependency-free parsing of the payroll "Summary" CSV export (an external payroll system's spreadsheet) into `PayrollSlip` objects the app can insert as `hr_payroll` form records. No I/O, no Express, no DB access — everything here is a plain function over a string, which is why it's unit-tested directly (`tests/hr-payroll-import.test.ts`) rather than through HTTP.

## Routes / Exports

This is not a routes file; it exports two functions plus a type.

### `parseCsvRows(text: string): string[][]`
A minimal RFC4180-ish CSV tokenizer, hand-rolled (no library). Rules, implemented as a single character-by-character scan with an `inQuotes` flag:

- **Quoted fields**: a field can be wrapped in `"`. Inside quotes, a doubled quote (`""`) is unescaped to a single literal `"` (the loop peeks `text[i+1]`, and if it's also `"`, appends one `"` to `field` and skips both characters via `i++`); any other `"` while `inQuotes` closes the quoted section.
- **Unquoted text**: any character that isn't a delimiter is appended to the current `field`.
- **Field separator**: an unquoted `,` pushes the accumulated `field` onto the current `row` array and resets `field`.
- **Row separator**: an unquoted `\n` pushes the current `field`, pushes the completed `row` onto `rows`, and resets both `row` and `field`.
- **`\r` is silently dropped** wherever it appears (handles CRLF line endings without producing a trailing `\r` in the last field of a row).
- **Trailing partial row**: after the scan loop ends, if there's a non-empty `field` or a non-empty `row` in progress (i.e. the text didn't end with a newline), that last row/field is still flushed — no data is lost from a missing final newline.
- Embedded commas and newlines inside quoted fields are handled correctly since the scanner only treats `,`/`\n` as delimiters when `inQuotes` is false.

Returns `string[][]` — one array of raw (unquoted, unescaped) string cells per row, with no numeric coercion, trimming, or header interpretation. That's all left to `parsePayrollSummaryCsv`.

### `parsePayrollSummaryCsv(text: string, opts?: { payDate?: string }): PayrollSlip[]`

**Row layout assumed**: row 0 is the sheet's title row (its column 0 holds the payroll period, e.g. `"June 16-30  2026"`); row 1 is the column-header row; data starts at row 2 (`for (let r = 2; r < rows.length; r++)`). If `parseCsvRows` returns zero rows (empty input), the function returns `[]` immediately without touching `rows[0]`.

**`payrollPeriod`** is read once, from `cell(rows[0], 0)`, with internal whitespace collapsed (`replace(/\s+/g, ' ').trim()`) — the same value is stamped onto every returned slip's `payroll_period` field. **`payDate`** comes entirely from the caller-supplied `opts.payDate` (defaulting to `''`) — the sheet itself carries no pay-date column, so this can't be derived from the CSV and must be supplied by whoever calls the parser (in practice, `form-builder.routes.ts`'s import route passes through an optional `pay_date` form field from the upload request).

**Columns are located by header text, not fixed position.** `resolveColumns(headerRow)` (row 1) normalizes every header cell (`normalizeHeader`: uppercase, strip everything but `A-Z0-9`) and matches it against a normalized expected label per field (`HEADER_NAMES`). The first occurrence of each normalized label wins; a label the header doesn't contain resolves to `-1`, which `cell()` reads back as `''` (same graceful-degrade behavior as an out-of-range fixed index always had).

| Key | Header text matched | Key | Header text matched |
|---|---|---|---|
| `no` | `No.` | `lateUndertimePay` | `Late/ Undertime` |
| `name` | `Employee Name` | `rsd30` | `RSD 30%` |
| `totalDaysWork` | `Total Days Work` | `basicPay` | `BASIC PAY` |
| `regHoliday` | `Reg Holiday` | `sss` / `hdmf` / `phic` / `tax` | `SSS` / `HDMF` / `PHIC` / `TAX` |
| `specialHoliday30` | `Special Holiday 30%` | `totalDeductions` | `TOTAL DEDUCTIONS` |
| `dailyRate` / `hourlyRate` | `Daily Rate` / `Hourly Rate` | `totalSalary` | `Total Salary` |
| `otHours` / `otPay` | `REG OT (Hrs)` / `Reg OT 25%` | | |

> **Why (fixed 2026-09-15)**: the sheet has one attendance-day column per calendar day in the cutoff, so a 16-day second-half cutoff (any 31-day month's 16th-31st: Jan/Mar/May/Jul/Aug/Oct/Dec) has one more day-column than a 15-day cutoff, shifting every fixed index after the day-grid by one place — `totalDaysWork`/`regHoliday` would silently read the wrong cell (`days_worked` from "Total Work Hrs", and `holiday_pay = dailyRate * regHolidayDays` from the *days-worked* count instead of the holiday-day count, overstating holiday pay 7-9x for every row). Separately, some exports carry two similarly-named columns — `Special Hol (30%)` (a rate reminder holding text like `"30%"`, not money) ahead of `Daily Rate`, and the real `Special Holiday 30%` pay column much later — and a fixed index could land on the wrong one, misreading `"30%"` as ₱30. Matching by the header row's own text sidesteps both: it's correct regardless of how many day-columns precede it, and an exact-text match (not a substring) picks the real `Special Holiday 30%` pay column over the differently-worded `Special Hol (30%)` reminder. `tests/hr-payroll-import.test.ts` has a regression suite built from rows copied verbatim from a real Aug 16-31 2026 export proving this.
>
> Before this, columns were a fixed `COL` index map that had already been through one off-by-one fix (2026-08-25, every index from `specialHoliday30` onward), which is what motivated moving to header-text resolution instead of re-numbering a fixed map again for a shape that keeps recurring. The dead `absentAmt`/`holidayOtHrs`/`holidayOtPay`/`monthlyRate` fields (defined in the old map but never read by `parsePayrollSummaryCsv`) have no equivalent in `HEADER_NAMES` — they were dropped, not carried forward.

**Department scanning** (`isDeptHeader`): as the scan walks rows top-to-bottom, a row is classified as a department-section header when its `no` cell (column 0) holds non-empty, non-purely-numeric text (`!/^\d+$/.test(no)`) **and** both the `name` cell and `totalDaysWork` cell are blank. When a header row is found, `dept` is set to that `no` cell's text and the loop `continue`s (no slip is emitted for the header itself). Every subsequent employee row is tagged with the *last* seen `dept` value until the next header row changes it — so department attribution is purely positional/sequential, not looked up from any other column.

**Mid-cutoff rate-change row splitting** (`isContinuationRow`): normally a data row has both a `no` and a `name`. Occasionally the sheet emits a second row for the same employee within one cutoff — when their pay rate changed partway through — that row has **no `no` and no `name` of its own**, but does carry a real numeric `totalDaysWork` value. The parser distinguishes this from a footer/blank row via `isContinuationRow`: `!cell(row,no) && !cell(row,name)` and `totalDaysWork` matches `/^\d+(\.\d+)?$/`. When a row matches, `employeeName` is set to `lastEmployeeName` (the most recently seen real employee name) rather than skipped — so the continuation row becomes its own separate `PayrollSlip`, tagged with the same employee name and the same `dept` as whatever section it falls in, but its own daily_rate/days_worked/basic_salary/etc. **The two rows are never merged into one slip** — a rate change produces two `hr_payroll` records for that employee for that cutoff, both with the same `employee_name` and `payroll_period`.

Rows that have neither a name nor a continuation-shaped `totalDaysWork` (blank spacer rows, and footer rows like "Prepared by:" / "Overall Total:" whose *label text* can coincidentally land in the `totalDaysWork` column purely by comma-count) are skipped via `continue` — they never reach `isContinuationRow`'s numeric check because that check specifically requires `totalDaysWork` to look like a plain number (`/^\d+(\.\d+)?$/`), which a label like `"Prepared by:"` does not match.

**Per-row field extraction and the recomputation logic** — for every data/continuation row:
```
dailyRate      = toNum(cell(COL.dailyRate))
hourlyRate     = toNum(cell(COL.hourlyRate))
daysWorked     = toNum(cell(COL.totalDaysWork))
regHolidayDays = toNum(cell(COL.regHoliday))
overtimePay    = toNum(cell(COL.otPay))
holidayPay     = dailyRate * regHolidayDays
specialHoliday30 = toNum(cell(COL.specialHoliday30))
restDayOt      = toNum(cell(COL.rsd30))
basicSalary    = toNum(cell(COL.basicPay))

sss         = toNum(cell(COL.sss))
philhealth  = toNum(cell(COL.phic))
pagibig     = toNum(cell(COL.hdmf))
tax         = toNum(cell(COL.tax))
lateAbsences = toNum(cell(COL.lateUndertimePay))

totalEarnings   = basicSalary + overtimePay + holidayPay + specialHoliday30 + restDayOt
totalDeductions = sss + philhealth + pagibig + tax + lateAbsences

netPay = toNum(cell(COL.totalSalary))   // taken as-is from the sheet, not derived
```
`toNum(v)` strips thousands-separator commas (`v.replace(/,/g, '')`) then `parseFloat`s, falling back to `0` if the result isn't finite (blank cell, stray text, etc.) — so every numeric field degrades gracefully to `0` rather than `NaN` or throwing.

**Why `overtimePay`/`holidayPay`/`specialHoliday30`/`restDayOt` are all summed straight into `totalEarnings`, and `lateAbsences` is not added back**: `BASIC PAY` on the sheet is plain days-worked pay — `daysWorked * dailyRate`, exactly, fractional days included — with nothing else folded in. Reg Holiday pay and OT are their own separate columns, so they get added on top like any other earnings line. `BASIC PAY` is also *not* net of the late/undertime deduction — that deduction appears exactly once, in `totalDeductions`, never added back into `totalEarnings`. `net_pay` is always taken directly from the sheet's own `Total Salary` column rather than derived from `total_earnings`/`total_deductions`, and in practice the two now agree to within a few centavos (see History) — small enough to be rounding noise in the source spreadsheet's own late-minutes-to-pesos conversion, not a formula error.
>
> **History**: this flipped several times over two days, each earlier flip resting on data that turned out to be either fabricated, mismatched between two different records, or itself edited mid-argument. Worth keeping as a record of what actually settled it, since the same shape of disagreement could recur with a different export.
>
> - **Before 2026-09-15**: `totalEarnings` summed `{basic + OT + holiday + special-holiday + rest-day-OT}` — the same formula reached below, arrived at for a different reason (keeping the slip's displayed earnings lines internally consistent, without a real-data reconciliation behind it).
> - **2026-09-15**: switched to excluding OT/holiday from the sum (leaving them as informational-only lines) and adding `lateAbsences` back in, after reconciling `total_earnings - total_deductions` against the sheet's own `TOTAL SALARY` column across a real 59-row Aug 16-31 2026 export. The specific two rows captured in this file's own `tests/hr-payroll-import.test.ts` fixture at the time (`BASIC PAY` 8,240 / 10,730.81 for two named employees) do not match the real export's actual values for those same employees (7,200 / 9,230.80) — so whatever the reconciliation was run against, it wasn't verified against the numbers that ended up committed as "verbatim real" test data.
> - **2026-09-16, first revert**: a second session, working from a live payslip complaint for employee "Arabit, Abegail" (CSV-import record), reverted to including OT/holiday — but the supporting reasoning compared that record's `total_earnings` against a *different*, independently-generated record for the same employee/cutoff produced by the **attendance-based `generate-payslips` engine** (`hr.routes.ts`/`hr-payroll-compute.ts` — a different computation path that derives `basic_salary` from clocked attendance, never from a CSV's `BASIC PAY` cell). Both records showed the same `net_pay` (₱4,872.50) only because they were duplicate payslips for the same real paycheck (flagged separately as a data-integrity issue worth a follow-up), not because they were independent confirmations of the same formula.
> - **2026-09-16, second revert**: reverted back to excluding OT/holiday, backed by a hand-worked figure (`BASIC PAY` = 5,647.50 for Arabit, Abegail's row) that reconciled net pay when late was added back. That figure turned out to be algebraically back-derived from the *other* record's numbers (mixing one record's `basic_salary`/`overtime_pay`/`holiday_pay` with the other's `late_absences`) rather than read from any actual file — no such value appears anywhere in the real export.
> - **2026-09-16, resolved**: the user pasted the actual source file in full (all 59 rows) directly into the conversation, removing any ambiguity about what any session could or couldn't access. For Arabit, Abegail's real row: `BASIC PAY` = 4,800.00 = 8 days worked × ₱600 daily rate, exactly — and this holds across every row checked (Aduan: 9 × 800 = 7,200; Manalo: 8 × 1,153.85 = 9,230.80; Cerda: 3.5 × 650 = 2,275, a fractional half-day included) — conclusive proof `BASIC PAY` never bakes in OT/holiday and is never net of late. Running `total_earnings = basic + OT + holiday + special-holiday-30 + rest-day-OT` (no late add-back) against those four real rows reconciles `net_pay` exactly for 2 of them and within 3-5 centavos for the other 2 — see `tests/hr-payroll-import.test.ts`'s "real Aug 16-31 2026 export" suite, rebuilt from these verbatim rows.
>
> Net takeaway for next time: a hand-computed "real sheet value" that isn't an actual pasted/read file is not evidence — check whether it's algebraically derivable from numbers already sitting in the app's own DB records before trusting it, and prefer asking for the actual source file over continuing to reverse-engineer conflicting inferences from it.

### `PayrollSlip` interface
The full shape emitted per row: `employee_name, dept_position, payroll_period, pay_date, daily_rate, days_worked, ot_hours, ot_rate_hour, basic_salary, overtime_pay, undertime_pay, holiday_pay, special_holiday_30, rest_day_ot, total_earnings, sss, philhealth, pagibig, cash_advance, late_absences, total_deductions, net_pay`. Two fields are always hard-coded rather than read from the sheet: `undertime_pay: 0` and `cash_advance: 0` (the sheet has no equivalent columns the parser maps to these — they're left for manual entry after import, same as `hr.routes.ts`'s `generate-payslips` path leaves earnings/deductions blank). `ot_rate_hour` is computed as `hourlyRate * 1.25` (a flat 25%-premium OT rate), not read from any column.

## Dependencies
None — no imports at all. Pure TypeScript/JavaScript over strings, arrays, and `parseFloat`.

## Used by
- `src/core/form-builder.routes.ts` — `POST /api/form-definitions/:id/import` imports `parsePayrollSummaryCsv` and is its **only production call site** (confirmed via grep across `src/`): reads the uploaded CSV buffer as UTF-8 text, calls `parsePayrollSummaryCsv(text, { payDate })`, then inserts one `form_records` row per returned slip.
- `tests/hr-payroll-import.test.ts` — direct unit tests of both exported functions.
- Not used by `src/modules/hr/hr.routes.ts` — that file's `generate-payslips` endpoint builds its own zeroed/prefilled payslip data independently (see `hr.routes.md`) and has nothing to do with CSV import.

## Notes / gotchas
- **(Fixed 2026-09-15)** Column lookup used to be a fixed index map (itself already patched once, 2026-08-25, for a `specialHoliday30`-onward off-by-one). A real Aug 16-31 2026 export — a 16-day second-half cutoff — exposed that fixed indices can't survive the sheet's column count varying with cutoff length: `days_worked` read from "Total Work Hrs" instead of "Total Days Work", and `holiday_pay` from the days-worked count instead of the holiday-day count (7-9x overstated for every row). Replaced with header-text resolution (`resolveColumns`, see the map above) so the parser no longer cares how many day-columns precede the summary columns, or which order same-looking columns appear in.
- If a header row is missing an expected label entirely, `resolveColumns` resolves that field to `-1`, and `cell()` reads it back as `''` (same as an out-of-range fixed index always did) — a re-templated export that drops or renames a column silently zeroes that one field rather than erroring or misreading a neighboring column.
- `parseCsvRows` has no header-arity validation — it will happily parse a CSV whose rows have fewer or more than 43 columns; short rows just read back as `''` at any missing index (via `cell()`'s `row?.[c] ?? ''`), so a truncated/malformed export fails silently (all-zero fields) rather than erroring.
- Because department is tracked purely by "most recent header row seen," a CSV that starts with employee rows before any department header (malformed input, or a header type the `isDeptHeader` check doesn't recognize) will produce slips with `dept_position: ''` for those rows rather than an error.
- `isContinuationRow` vs. footer-row disambiguation hinges entirely on whether the `totalDaysWork` cell parses as `/^\d+(\.\d+)?$/` — a footer/summary row that happens to place a numeric-looking string in that exact column (not just label text) would be misread as a continuation row inheriting `lastEmployeeName`. The existing footer-rejection test only covers the case where a label string lands there, not a stray number.
- A rate-change split always produces **two separate `PayrollSlip`/`form_records` rows** for one employee in one cutoff (never merged into a single row with e.g. blended totals) — downstream consumers (Form Records list, `hr-payroll-print.js`) will show/print two payslips for that employee for the period.
