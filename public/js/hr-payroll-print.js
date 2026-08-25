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
    grid-auto-flow: column; gap: 6mm; height: 260mm;
  }
  .payslip-grid > div { overflow: hidden; }
`;

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
    ot_hours: d.ot_hours ?? '',
    ot_rate_hour: _money(d.ot_rate_hour),
    basic_salary: _money(d.basic_salary),
    overtime_pay: _money(d.overtime_pay),
    undertime_pay: _money(d.undertime_pay),
    holiday_pay: _money(d.holiday_pay),
    special_holiday_30: _money(d.special_holiday_30),
    rest_day_ot: _money(d.rest_day_ot),
    total_earnings: _money(totalEarnings),
    sss: _money(d.sss),
    philhealth: _money(d.philhealth),
    pagibig: _money(d.pagibig),
    cash_advance: _money(d.cash_advance),
    late_absences: _money(d.late_absences),
    total_deductions: _money(totalDeductions),
    net_pay: _money(netPay),
  };
}

function renderSlip(d, templateBody) {
  if (!d) return '<div></div>';
  return _renderTemplate()(templateBody, buildSlipContext(d));
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
    const b = list[i + 1] === undefined ? '<div></div>' : renderSlip(list[i + 1], body);
    pages.push(`<div class="payslip-page"><div class="payslip-grid">${a}${a}${b}${b}</div></div>`);
  }
  return `<style>${PAGE_CSS}</style>${pages.join('')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPayrollSlipsHtml, buildSlipContext, FALLBACK_BODY };
}
