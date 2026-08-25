# `public/js/hr-payroll-print.js`

## Purpose
Builds the printable HTML for HR Payroll slips: A4 pages laid out 2 employees per page ×
2 identical copies each (one to keep, one to sign and return), using the shared
`renderTemplate()` engine for each individual slip's content — this module only owns the
page/pairing/grid layout wrapped around that per-slip HTML, not the slip's own content.

## Exports / Public API

Three globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports)
  module.exports = { buildPayrollSlipsHtml, buildSlipContext, FALLBACK_BODY };
```

- **`buildPayrollSlipsHtml(dataList, templateBody)`** → `string` (HTML). `dataList` is an
  array of HR Payroll `form_records.data` objects (one per employee). `templateBody` is the
  "HR Payroll Slip" `doc_templates` row's body — if omitted, falls back to `FALLBACK_BODY`.
  Returns `''` if `dataList` is empty/not an array. Otherwise:
  - Prepends a `<style>${PAGE_CSS}</style>` block.
  - Walks `dataList` two at a time (`i += 2`); for each pair `[a, b]` (where `b` may be
    `undefined` for an odd-length list — rendered as an empty `<div></div>` placeholder
    slot), renders each into HTML via `renderSlip`, then emits one `.payslip-page` div
    containing a `.payslip-grid` with `${a}${a}${b}${b}` — i.e. **employee A's slip
    appears twice, then employee B's slip appears twice**, not `a, b, a, b`.
- **`buildSlipContext(d)`** → flattens/formats one HR Payroll record's `data` object into
  the flat render context a slip template expects: `employee_name, dept_position,
  payroll_period, pay_date, daily_rate, days_worked, ot_hours, ot_rate_hour, basic_salary,
  overtime_pay, undertime_pay, holiday_pay, special_holiday_30, rest_day_ot,
  total_earnings, sss, philhealth, pagibig, cash_advance, late_absences,
  total_deductions, net_pay`. All money fields go through the internal `_money()`
  formatter (2-decimal). **NET PAY logic**: prefers the record's own stored `net_pay` field
  (set by CSV import or manual edit) when present and non-empty; only falls back to
  computing `total_earnings - total_deductions` for older records that predate the
  `net_pay` field.
- **`FALLBACK_BODY`** — a minimal hardcoded slip layout (boxed div, employee name/dept/
  period/earnings/deductions/NET PAY), used only if the real "HR Payroll Slip" template
  can't be fetched (e.g. it was deleted from Document Templates).

### Internal (not exported)
- **`_renderTemplate()`** — dual browser-global/`require` resolution of `renderTemplate`
  from `doc-template.js` (same pattern as the other `doc-*` files).
- **`_num(v)` / `_money(v)`** — number coercion (parses comma-grouped strings, `NaN`→`0`)
  and 2-decimal currency formatting, local to this file (not shared with `doc-formula.js`'s
  `toNumber`, though functionally similar).
- **`renderSlip(d, templateBody)`** → `_renderTemplate()(templateBody, buildSlipContext(d))`,
  or `'<div></div>'` if `d` is falsy (used for the odd-employee-out placeholder).
- **`PAGE_CSS`** — the print CSS for the page/grid layout: `.payslip-page { page-break-after:
  always }` (last page gets `page-break-after: auto`), `.payslip-grid` is a `2x2` CSS grid
  (`grid-auto-flow: column`, `height: 260mm`, `6mm` gap) — column-major flow is what makes
  each employee's copy-pair sit adjacent (both of A's copies in the left column, both of
  B's in the right) so the printed sheet can be cut down the middle into two employee
  bundles rather than needing to interleave-cut.

## Internal structure
Pipeline: `buildPayrollSlipsHtml` → pairs up `dataList` → `renderSlip` (×2 per record, ×2
records per page) → `buildSlipContext` (per-record flattening) → `renderTemplate` (external,
from `doc-template.js`). No persistent state; everything is a pure function of its inputs.

## Dependencies
`renderTemplate` from `doc-template.js` (dual-resolved). Loaded in `index.html` after
`doc-context.js`/`doc-editor.js`, before `app.js`.

## Used by
- **`public/js/views/form-records.js`** — the sole call site. `printSlips(dataList)`
  (triggered by the "Print Slips" toolbar button, a per-row row-level Print button, or bulk
  "Print Selected") fetches the live "HR Payroll Slip" template body from `/templates`
  (falling back silently to `buildPayrollSlipsHtml`'s own `FALLBACK_BODY` if the template
  was deleted or the fetch fails), then calls `buildPayrollSlipsHtml(list, templateBody)`
  and feeds the result into `UI.printableHtml(html, formDef.name)` for an iframe inside a
  `UI.modal` (preview-first, no auto-`window.print()` — see `ui.js`'s printing notes).
- `tests/hr-payroll-print.test.ts` — exercises `buildPayrollSlipsHtml` directly (NET PAY
  math, 2-copies-per-employee, 2-per-page grouping with blank-slot padding for odd counts,
  string/number coercion, empty-list handling).

## Notes / gotchas
- This module is **standalone**, not built on the shared order-centric `doc-context.js`
  context builder — HR Payroll slips have their own flat field shape (`buildSlipContext`)
  distinct from the `{company, order, items, user, today}` shape orders/templates use.
- The individual slip's HTML content is **not hardcoded here** — it comes from editing the
  "HR Payroll Slip" row in Document Templates like any other template. This file only ever
  controls the page/pairing/grid wrapper; changing what a slip *looks like* (fields shown,
  styling) means editing that template, not this file — unless you're adding a *new field*
  to the payroll form, which does require adding it to `buildSlipContext`'s flattening.
- The 2×2 grid layout assumes exactly 2 employees fit per page at `260mm` grid height on an
  A4 page — this is a fixed layout constant (`PAGE_CSS`), not derived from the actual page
  size configured via `doc-editor.js`'s page-setup controls on the underlying template.
