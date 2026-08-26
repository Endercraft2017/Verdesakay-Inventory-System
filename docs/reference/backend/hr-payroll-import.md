# `src/hr-payroll-import.ts`

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

**The fixed `COL` column-index map** (0-based positions in each CSV row):

| Key | Index | Key | Index | Key | Index |
|---|---|---|---|---|---|
| `no` | 0 | `specialHoliday30` | 22 | `basicPay` | 36 |
| `name` | 1 | `dailyRate` | 24 | `sss` | 38 |
| `totalDaysWork` | 19 | `hourlyRate` | 25 | `hdmf` | 39 |
| `regHoliday` | 20 | `otHours` | 27 | `phic` | 40 |
| | | `otPay` | 28 | `tax` | 41 |
| | | `lateUndertimePay` | 30 | `totalDeductions` | 42 |
| | | `rsd30` | 35 | `totalSalary` | 43 |

Every value the parser reads comes from one of these fixed offsets via the `cell(row, index)` helper (`(row?.[index] ?? '').trim()` — out-of-range or missing cells become `''`, never `undefined`/throw).

> **Fixed 2026-08-25**: every index from `specialHoliday30` onward used to be off by one (e.g. `dailyRate` was `23` instead of `24`), which meant real CSV imports silently read the wrong column for daily rate, hourly rate, OT, holiday pay, basic pay, and every deduction field — `daily_rate`/`basic_salary` etc. would come back as `0` or from the neighboring column. This was caught because `tests/hr-payroll-import.test.ts` and the CSV-import fixture in `tests/form-builder.test.ts` — two independently-written fixtures that both encode the real sheet's header labels — agreed with each other and disagreed with the source, and 3 of those tests were failing on `main`. The map above is the corrected version; the dead `absentAmt`/`holidayOtHrs`/`holidayOtPay`/`monthlyRate` entries (defined but never read by `parsePayrollSummaryCsv`) were removed rather than re-numbered.

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
holidayPay     = dailyRate * regHolidayDays        // computed, not read from a column
specialHoliday30 = toNum(cell(COL.specialHoliday30))
restDayOt      = toNum(cell(COL.rsd30))
basicSalary    = toNum(cell(COL.basicPay))
totalEarnings  = basicSalary + overtimePay + holidayPay + specialHoliday30 + restDayOt

sss         = toNum(cell(COL.sss))
philhealth  = toNum(cell(COL.phic))
pagibig     = toNum(cell(COL.hdmf))
tax         = toNum(cell(COL.tax))
lateAbsences = toNum(cell(COL.lateUndertimePay))
totalDeductions = sss + philhealth + pagibig + tax + lateAbsences

netPay = toNum(cell(COL.totalSalary))   // this one IS trusted from the sheet
```
`toNum(v)` strips thousands-separator commas (`v.replace(/,/g, '')`) then `parseFloat`s, falling back to `0` if the result isn't finite (blank cell, stray text, etc.) — so every numeric field degrades gracefully to `0` rather than `NaN` or throwing.

**Why `basic_salary`/`total_earnings`/`total_deductions` are recomputed instead of trusted from the sheet** (the double-counting bug this avoids): the sheet's own "BASIC PAY" column (`COL.basicPay`) is *already net of* the late/undertime deduction — the external payroll system nets that deduction directly into BASIC PAY before it ever reaches the "TOTAL DEDUCTIONS" column. But this app's `hr_payroll` form (and the printed payslip built from it) treats late/undertime as its own, separate, explicit deduction line (`late_absences`) subtracted from earnings to reach net pay — the same UI convention as SSS/PhilHealth/Pag-IBIG/tax. If the parser simply copied the sheet's BASIC PAY into `basic_salary` *and* also copied the sheet's late/undertime figure into `late_absences`, the printed slip would subtract that deduction from an already-deducted basic pay — double-counting it and understating NET PAY. The parser sidesteps this specific issue for `basic_salary` (it takes the sheet's BASIC PAY as-is — `basicSalary = toNum(cell(COL.basicPay))` — since that is the one number that already reflects the correct net-of-late value the slip should show as basic pay) while independently re-deriving `total_earnings` as an explicit sum of `{basic + OT + holiday + special-holiday + rest-day-OT}` and `total_deductions` as an explicit sum of `{SSS + PhilHealth + Pag-IBIG + tax + late/undertime}`, rather than reading the sheet's own "TOTAL DEDUCTIONS" or a "TOTAL EARNINGS" column for those aggregates — because the sheet's own aggregate columns are computed under the netted convention and would not line up 1:1 against the app's un-netted per-line breakdown. Recomputing both totals purely from the same parts the slip UI displays keeps `total_earnings - total_deductions` internally consistent with the individually-displayed earnings/deduction lines, at the cost of `net_pay` (still taken directly from the sheet's own TOTAL SALARY / `COL.totalSalary` column) not being guaranteed to exactly equal `total_earnings - total_deductions` computed this way for every row — the sheet's authoritative net figure is preserved as-is rather than re-derived, since it's the number that was actually paid out.

### `PayrollSlip` interface
The full shape emitted per row: `employee_name, dept_position, payroll_period, pay_date, daily_rate, days_worked, ot_hours, ot_rate_hour, basic_salary, overtime_pay, undertime_pay, holiday_pay, special_holiday_30, rest_day_ot, total_earnings, sss, philhealth, pagibig, cash_advance, late_absences, total_deductions, net_pay`. Two fields are always hard-coded rather than read from the sheet: `undertime_pay: 0` and `cash_advance: 0` (the sheet has no equivalent columns the parser maps to these — they're left for manual entry after import, same as `hr.routes.ts`'s `generate-payslips` path leaves earnings/deductions blank). `ot_rate_hour` is computed as `hourlyRate * 1.25` (a flat 25%-premium OT rate), not read from any column.

## Dependencies
None — no imports at all. Pure TypeScript/JavaScript over strings, arrays, and `parseFloat`.

## Used by
- `src/routes/form-builder.routes.ts` — `POST /api/form-definitions/:id/import` imports `parsePayrollSummaryCsv` and is its **only production call site** (confirmed via grep across `src/`): reads the uploaded CSV buffer as UTF-8 text, calls `parsePayrollSummaryCsv(text, { payDate })`, then inserts one `form_records` row per returned slip.
- `tests/hr-payroll-import.test.ts` — direct unit tests of both exported functions.
- Not used by `src/routes/hr.routes.ts` — that file's `generate-payslips` endpoint builds its own zeroed/prefilled payslip data independently (see `hr.routes.md`) and has nothing to do with CSV import.

## Notes / gotchas
- **(Fixed 2026-08-25)** The `COL` map used to be off by one from `specialHoliday30` onward, disagreeing with both `tests/hr-payroll-import.test.ts`'s fixture and the CSV-import fixture in `tests/form-builder.test.ts` — 3 tests in the former and 1 in the latter were failing against real CSV data (`daily_rate`/`basic_salary` reading back as `0`, etc.). Corrected; all 8 + import tests now pass. See the map above for the current (correct) indices.
- `parseCsvRows` has no header-arity validation — it will happily parse a CSV whose rows have fewer or more than 43 columns; short rows just read back as `''` at any missing index (via `cell()`'s `row?.[c] ?? ''`), so a truncated/malformed export fails silently (all-zero fields) rather than erroring.
- Because department is tracked purely by "most recent header row seen," a CSV that starts with employee rows before any department header (malformed input, or a header type the `isDeptHeader` check doesn't recognize) will produce slips with `dept_position: ''` for those rows rather than an error.
- `isContinuationRow` vs. footer-row disambiguation hinges entirely on whether the `totalDaysWork` cell parses as `/^\d+(\.\d+)?$/` — a footer/summary row that happens to place a numeric-looking string in that exact column (not just label text) would be misread as a continuation row inheriting `lastEmployeeName`. The existing footer-rejection test only covers the case where a label string lands there, not a stray number.
- A rate-change split always produces **two separate `PayrollSlip`/`form_records` rows** for one employee in one cutoff (never merged into a single row with e.g. blended totals) — downstream consumers (Form Records list, `hr-payroll-print.js`) will show/print two payslips for that employee for the period.
