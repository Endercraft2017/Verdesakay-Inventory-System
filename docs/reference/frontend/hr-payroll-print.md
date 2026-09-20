# `public/js/hr-payroll-print.js`

## Purpose
Builds the printable HTML for HR Payroll slips: A4 pages laid out 2 employees per page ×
2 identical copies each (one to keep, one to sign and return), using the shared
`renderTemplate()` engine for each individual slip's content — this module only owns the
page/pairing/grid layout wrapped around that per-slip HTML, not the slip's own content.

## Exports / Public API

Browser globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPayrollSlipsHtml, buildSlipContext, renderSlip, FALLBACK_BODY, _fitScale, fitPayslipCells };
}
```

- **`buildPayrollSlipsHtml(dataList, templateBody)`** → `string` (HTML). `dataList` is an
  array of HR Payroll `form_records.data` objects (one per employee). `templateBody` is the
  "HR Payroll Slip" `doc_templates` row's body — if omitted, falls back to `FALLBACK_BODY`.
  Returns `''` if `dataList` is empty/not an array. Otherwise:
  - Prepends a `<style>${PAGE_CSS}</style>` block.
  - Walks `dataList` two at a time (`i += 2`); for each pair `[a, b]` (where `b` may be
    `undefined` for an odd-length list — that slot renders as `''`, an empty cell), renders
    each into HTML via `renderSlip`, wraps each in `_cell()` (the outer fixed-height/
    `overflow:hidden` grid-item div + inner `.payslip-cell-inner` div `fitPayslipCells` can
    measure/scale), then emits one `.payslip-page` div containing a `.payslip-grid` with
    `${_cell(a)}${_cell(a)}${_cell(b)}${_cell(b)}` — i.e. **employee A's slip appears twice,
    then employee B's slip appears twice**, not `a, b, a, b`.
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
- **`fitPayslipCells(root)`** → shrinks any `.payslip-grid` cell whose rendered slip content
  overflows its fixed-height cell — a template customized with a header image/logo, the
  payroll fields added since (Half/Undertime Days, Night Differential), or just a record
  with several `{{#other_deductions}}` lines — so NET PAY and the signature lines at the
  bottom stay visible instead of being silently clipped by the cell's `overflow: hidden`.
  For each `.payslip-grid > div` (the outer, fixed-height cell — untouched), finds its
  `.payslip-cell-inner` child and, if `inner.scrollHeight > cell.clientHeight`, applies
  `transform: scale(...)` **to the inner wrapper, not the cell**. This split matters: a CSS
  clip is resolved against an element's own box *before* its own transform runs, so scaling
  the same fixed-height/`overflow:hidden` element that's doing the clipping only shrinks the
  already-clipped (already too late) result — the first version of this fix did exactly that
  and visibly "scaled down" without ever bringing NET PAY back. Scaling the naturally-sized
  inner wrapper instead means the (still fixed-size) outer clip only ever sees content that's
  already been shrunk to fit.
  Needs a real, already-rendered DOM (`scrollHeight`/`clientHeight`); `root` defaults to
  `document`, pass an iframe's `contentDocument` when printing from inside one. Called from
  the print preview iframe's `load` event in `form-records.js`'s `printSlips()` — **not**
  from `buildPayrollSlipsHtml()` itself, which only ever produces an HTML string.
- **`_fitScale(contentHeight, boxHeight)`** → the pure-math half of `fitPayslipCells`: the
  scale factor needed to shrink `contentHeight` into `boxHeight`, or `null` if it already
  fits. Split out so it's unit-testable without a real browser layout.
- **`_cell(slipHtml)`** (internal) → wraps one rendered slip as
  `<div><div class="payslip-cell-inner">${slipHtml}</div></div>` — the outer div is the
  actual `.payslip-grid` item (fixed height, `overflow: hidden`, `position: relative`, from
  `PAGE_CSS`); the inner `.payslip-cell-inner` is what `fitPayslipCells` measures and scales.

- **`renderSlip(d, templateBody)`** → `_renderTemplate()(templateBody, buildSlipContext(d))`,
  or `'<div></div>'` if `d` is falsy. Exported for tests; `buildPayrollSlipsHtml` is the
  normal entry point (an empty `d` no longer happens there — a missing second employee now
  renders as `''`, not a placeholder, since `_cell()` supplies the wrapping div either way).

### Internal (not exported)
- **`_renderTemplate()`** — dual browser-global/`require` resolution of `renderTemplate`
  from `doc-template.js` (same pattern as the other `doc-*` files).
- **`_num(v)` / `_money(v)`** — number coercion (parses comma-grouped strings, `NaN`→`0`)
  and 2-decimal currency formatting, local to this file (not shared with `doc-formula.js`'s
  `toNumber`, though functionally similar).
- **`PAGE_CSS`** — the print CSS for the page/grid layout: `.payslip-page { page-break-after:
  always }` (last page gets `page-break-after: auto`), `.payslip-grid` is a `2x2` CSS grid
  (`grid-auto-flow: column`, `height: 254mm`, `6mm` gap) — column-major flow is what makes
  each employee's copy-pair sit adjacent (both of A's copies in the left column, both of
  B's in the right) so the printed sheet can be cut down the middle into two employee
  bundles rather than needing to interleave-cut. `254mm` (not the previous, slightly-too-tall
  `260mm`) is derived from `ui.js`'s `PRINT_CSS`: `@page{margin:14mm}` + `body{padding:24px}`
  leaves ~256mm actually usable on an A4 page.

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
- The 2×2 grid layout assumes exactly 2 employees fit per page at `254mm` grid height on an
  A4 page — this is a fixed layout constant (`PAGE_CSS`), not derived from the actual page
  size configured via `doc-editor.js`'s page-setup controls on the underlying template.
- Even at the corrected `254mm`, a single slip's own content can still be taller than half
  that (a cell) once you factor in a customized template's own header image, or a record
  with more `other_deductions` lines than usual — `.payslip-grid > div`'s `overflow: hidden`
  would silently clip that overflow (NET PAY / signature lines are the last thing in the
  default template, so they're the first thing to disappear). `fitPayslipCells()` is the
  safety net for that: it runs after the print preview iframe renders and shrinks (CSS
  `transform: scale()`) any cell that's still too tall, rather than leaving it clipped.
- **Why the scale target is `.payslip-cell-inner`, not the cell itself**: an element's own
  `overflow: hidden` clip is resolved against its own box *before* its own `transform` is
  applied — scaling the very element that's fixed-height + clipping only shrinks the
  already-clipped result (visibly smaller, but NET PAY still missing). `_cell()` therefore
  wraps every rendered slip in an inner div that has no height/overflow constraint of its
  own; `fitPayslipCells()` measures *that* wrapper's natural `scrollHeight` and scales *it*,
  so the outer cell's clip (still evaluated against its own fixed box) only ever sees content
  that's already been shrunk to fit.
- Known edge case from that same split: transforming an element makes it the containing
  block for any `position: absolute` descendant (per the CSS spec, regardless of the
  transformed element's own `position`). So once a cell actually needs shrinking, a
  `.doc-float` inside it resolves its %-based size against `.payslip-cell-inner`'s own
  (natural, un-shrunk) box rather than the outer cell's fixed size — not a real-world issue
  today (no live "HR Payroll Slip" template uses floats), just worth knowing if one ever
  does and also happens to overflow its cell.
