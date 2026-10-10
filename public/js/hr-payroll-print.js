/* ============================================================================
   Builds printable HTML for HR Payroll slips: A4 pages, 2 employees per page,
   2 identical copies of each employee's slip (one to keep, one to sign and
   return) — a 2x2 grid per page, column-major so each employee's pair of
   copies sits together and can be cut out as one unit.

   Each individual slip's HTML comes from the "HR Payroll Slip" document
   template (rendered via the shared renderTemplate()), NOT hardcoded here —
   that template lives in Document Templates and can be edited there like any
   other template. This module only owns the page/pairing layout around it.
   Browser global + CommonJS export (for tests).
   ============================================================================ */

function _renderTemplate() {
  if (typeof renderTemplate !== 'undefined') return renderTemplate; // browser global
  return require('./doc-template.js').renderTemplate; // node/tests
}

function _num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function _money(v) {
  return _num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fallback used only if the "HR Payroll Slip" template can't be fetched (e.g. deleted). */
const FALLBACK_BODY = `<div style="border:1px solid #222;padding:10px;font-size:12px">
  <h3 style="text-align:center;margin:0 0 8px">EMPLOYEE PAYROLL SLIP</h3>
  <div>Employee: <strong>{{employee_name}}</strong></div>
  <div>Dept./Position: {{dept_position}}</div>
  <div>Payroll Period: {{payroll_period}}</div>
  <div>Total Earnings: {{total_earnings}}</div>
  <div>Total Deductions: {{total_deductions}}</div>
  <div>NET PAY: {{net_pay}}</div>
</div>`;

const PAGE_CSS = `
  .payslip-page { page-break-after: always; }
  .payslip-page:last-child { page-break-after: auto; }
  .payslip-grid {
    display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
    grid-auto-flow: column; gap: 6mm; height: 254mm;
  }
  /* 254mm, not a round 260mm: PRINT_CSS in ui.js puts this page inside @page{margin:14mm}
     (297 - 28 = 269mm) plus body{padding:24px} (~12.7mm top+bottom) = ~256mm actually
     available — 260mm was already slightly taller than the printable area even before
     counting any one slip's own content height. */
  .payslip-grid > div { position: relative; overflow: hidden; }
  /* position:relative (see above) gives each of the 4 copies on this shared page its OWN
     positioning boundary for any floating object (.doc-float, position:absolute — an image/
     textbox/shape "made movable" in the template editor). Without this, a float's %-based
     left/top/width/height resolves against the page's <body> (the only other positioned
     ancestor), which all 4 copies share — so every copy's float lands at the same
     page-relative spot at full-page size instead of scoped to its own quarter. Cost of the
     fix: a float now scales down to the SIZE OF ITS OWN CELL (e.g. 70% width of an A4 page
     becomes 70% of one payslip's width) — the correct, expected behavior for something
     repeating on a tiled page, same as any responsive design.
     overflow:hidden on the same rule is what makes a too-tall slip's overflow (a custom
     template with a logo header, or a record with several {{#other_deductions}} lines) get
     silently clipped instead of bleeding into the next cell — see fitPayslipCells() below,
     which shrinks a cell's content to fit instead of letting that happen. This outer div is
     deliberately left at its fixed cell height/overflow:hidden — the shrinking happens on
     .payslip-cell-inner (a plain, unconstrained child) instead of here. A CSS clip is
     resolved against an element's own box BEFORE its own transform is applied, so scaling
     THIS same fixed-height/overflow:hidden element would only ever shrink the already-clipped
     result — the cut-off content (NET PAY, the signature lines) stays gone. Scaling the
     inner child instead means the clip (still evaluated against the outer's fixed box) only
     ever sees content that's already been shrunk to fit, so nothing gets lost. */
  .payslip-cell-inner { display: block; }
  /* Caveat: transforming an element makes IT the containing block for any position:absolute
     descendant (per spec, regardless of the transformed element's own position) — so once a
     cell actually needs shrinking, a .doc-float inside it resolves its %-based size against
     .payslip-cell-inner's own (natural, un-shrunk) box rather than the outer cell's fixed
     size. Not a regression in practice today (no live template uses floats), just a known
     edge case if one ever does and also happens to overflow its cell.
     Why not the simpler-sounding "just scale the whole cell": .payslip-cell-inner has to be
     laid out at its own FULL natural height first (that's what fitPayslipCells() measures via
     scrollHeight) — it can't share the outer div's fixed height/overflow:hidden, or there'd be
     nothing un-clipped left to measure or scale. */
`;

/** How much a cell's rendered content (`.payslip-cell-inner`'s natural, unconstrained
    `scrollHeight`) needs to shrink to fit inside its cell's fixed height (`clientHeight` of the
    outer .payslip-grid > div). Returns null when it already fits (no scaling needed). Pure
    math, split out from fitPayslipCells() so it's testable without a real DOM/layout. */
function _fitScale(contentHeight, boxHeight) {
  if (!(contentHeight > 0) || !(boxHeight > 0) || contentHeight <= boxHeight) return null;
  return boxHeight / contentHeight;
}

/** Shrinks any .payslip-grid cell whose slip content overflows its fixed-height cell (a
    template customized with a header image/logo, the several payroll fields added since —
    Half/Undertime Days, Night Differential, itemized Other Deductions — or just a record with
    more other_deductions lines than most) so NET PAY and the signature lines at the bottom
    stay visible instead of being silently discarded by the grid cell's `overflow: hidden`.
    Measures/scales the inner .payslip-cell-inner wrapper, not the outer (fixed-height,
    overflow:hidden) cell itself — see the PAGE_CSS comment on .payslip-cell-inner for why:
    an element's own overflow clip is resolved against its own box before its own transform is
    applied, so scaling the same element that's doing the clipping only shrinks the
    already-clipped (i.e. already too late) result.
    Needs real layout (`scrollHeight`/`clientHeight`), so call this against a live DOM after
    the print HTML has actually rendered — e.g. the preview iframe's `load` event in
    form-records.js's printSlips() — not against the HTML string buildPayrollSlipsHtml()
    returns. `root` defaults to `document` (browser global use); pass an iframe's
    `contentDocument` explicitly when printing from inside one. */
function fitPayslipCells(root) {
  const cells = (root || document).querySelectorAll('.payslip-grid > div');
  cells.forEach((cell) => {
    const inner = cell.querySelector('.payslip-cell-inner');
    if (!inner) return;
    const scale = _fitScale(inner.scrollHeight, cell.clientHeight);
    if (scale) {
      inner.style.transformOrigin = 'top left';
      inner.style.transform = `scale(${scale})`;
    }
  });
}

/** HR Payroll record.data -> flat, pre-formatted render context for the slip template. */
function buildSlipContext(d) {
  d = d || {};
  const totalEarnings = _num(d.total_earnings);
  const totalDeductions = _num(d.total_deductions);
  // Use stored net_pay (from CSV import or manual edit) when available;
  // fall back to computing it for older records that don't have it.
  const storedNetPay = d.net_pay != null && d.net_pay !== '' ? _num(d.net_pay) : NaN;
  const netPay = Number.isFinite(storedNetPay) ? storedNetPay : (totalEarnings - totalDeductions);
  return {
    employee_name: d.employee_name || '',
    dept_position: d.dept_position || '',
    payroll_period: d.payroll_period || '',
    pay_date: d.pay_date || '',
    daily_rate: _money(d.daily_rate),
    days_worked: d.days_worked ?? '',
    days_absent: d.days_absent ?? '',
    days_half: d.days_half ?? '',
    days_undertime: d.days_undertime ?? '',
    ot_hours: d.ot_hours ?? '',
    ot_rate_hour: _money(d.ot_rate_hour),
    basic_salary: _money(d.basic_salary),
    overtime_pay: _money(d.overtime_pay),
    undertime_pay: _money(d.undertime_pay),
    undertime_day_pay: _money(d.undertime_day_pay),
    holiday_pay: _money(d.holiday_pay),
    special_holiday_30: _money(d.special_holiday_30),
    rest_day_ot: _money(d.rest_day_ot),
    night_diff_pay: _money(d.night_diff_pay),
    total_earnings: _money(totalEarnings),
    sss: _money(d.sss),
    philhealth: _money(d.philhealth),
    pagibig: _money(d.pagibig),
    cash_advance: _money(d.cash_advance),
    // Ad-hoc per-cutoff deduction lines (Cash Advance, uniform, misc, …) — see
    // src/routes/hr.routes.ts's recomputeDeductionsFor. Rendered via the template's own
    // {{#other_deductions}}...{{/other_deductions}} loop (renderTemplate supports array
    // sections natively), each line's amount pre-formatted the same as every other money field.
    // The template no longer has its own "Cash Advance" row (SCHEMA_VERSION 23) — a legacy
    // non-zero top-level cash_advance (old records / CSV import) is folded in here as the first
    // line so it still shows and still reconciles with the stored total_deductions.
    other_deductions: (_num(d.cash_advance) > 0 ? [{ label: 'Cash Advance', amount: d.cash_advance }] : [])
      .concat(Array.isArray(d.other_deductions) ? d.other_deductions : [])
      .map((line) => ({ label: line && line.label, amount: _money(line && line.amount) })),
    late_absences: _money(d.late_absences),
    total_deductions: _money(totalDeductions),
    net_pay: _money(netPay),
  };
}

function renderSlip(d, templateBody) {
  if (!d) return '<div></div>';
  return _renderTemplate()(templateBody || FALLBACK_BODY, buildSlipContext(d));
}

/** Wraps one rendered slip in the outer (fixed-height, overflow:hidden — the actual grid item)
    / inner (.payslip-cell-inner, naturally sized — what fitPayslipCells() measures/scales)
    pair PAGE_CSS expects. See the PAGE_CSS comment on .payslip-cell-inner for why the split
    is needed rather than just clipping+scaling the same div. */
function _cell(slipHtml) {
  return `<div><div class="payslip-cell-inner">${slipHtml}</div></div>`;
}

/** dataList: array of HR Payroll field objects (record.data).
    templateBody: the "HR Payroll Slip" doc_template body (falls back if omitted). */
function buildPayrollSlipsHtml(dataList, templateBody) {
  const list = Array.isArray(dataList) ? dataList : [];
  if (!list.length) return '';
  const body = templateBody || FALLBACK_BODY;
  const pages = [];
  for (let i = 0; i < list.length; i += 2) {
    const a = renderSlip(list[i], body);
    const b = list[i + 1] === undefined ? '' : renderSlip(list[i + 1], body);
    pages.push(`<div class="payslip-page"><div class="payslip-grid">${_cell(a)}${_cell(a)}${_cell(b)}${_cell(b)}</div></div>`);
  }
  return `<style>${PAGE_CSS}</style>${pages.join('')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPayrollSlipsHtml, buildSlipContext, renderSlip, FALLBACK_BODY, _fitScale, fitPayslipCells };
}
