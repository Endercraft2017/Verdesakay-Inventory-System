/** Payroll slip print HTML builder: renders each slip via the shared renderTemplate()
    against a fetched/fallback template body, then groups into 2-per-page, 2-copies-each
    pages. Loads public/js/hr-payroll-print.js (+ its doc-template.js dependency) into a
    sandbox, same technique as tests/doc-template.test.ts. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '../public/js');

function loadFile(name: string, requireShim: (p: string) => unknown): Record<string, unknown> {
  const src = fs.readFileSync(path.join(DIR, name), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, requireShim);
  return mod.exports;
}

function loadModule() {
  const requireForDocTemplate = (p: string) => loadFile(p, requireForDocTemplate);
  const docTemplateExports = loadFile('doc-template.js', requireForDocTemplate);
  const requireForPrint = (p: string) => (p === './doc-template.js' ? docTemplateExports : loadFile(p, requireForPrint));
  return loadFile('hr-payroll-print.js', requireForPrint) as {
    renderSlip: (data: Record<string, unknown>, templateBody?: string) => string;
    buildPayrollSlipsHtml: (data: unknown[], templateBody?: string) => string;
    buildSlipContext: (d: Record<string, unknown>) => Record<string, string>;
    FALLBACK_BODY: string;
    _fitScale: (contentHeight: number, boxHeight: number) => number | null;
  };
}

const { renderSlip, buildPayrollSlipsHtml, buildSlipContext, FALLBACK_BODY, _fitScale } = loadModule();

const CUSTOM_BODY = '<div class="slip">{{employee_name}} | earn {{total_earnings}} | ded {{total_deductions}} | net {{net_pay}}</div>';

const emp = (overrides: Record<string, unknown> = {}) => ({
  employee_name: 'Dela Cruz, Juan', dept_position: 'Warehouse Staff',
  payroll_period: 'June 01-15 2026', pay_date: '2026-06-20',
  daily_rate: 600, days_worked: 11, ot_hours: 4, ot_rate_hour: 93.75,
  basic_salary: 6600, overtime_pay: 375, undertime_pay: 0, holiday_pay: 600,
  special_holiday_30: 180, rest_day_ot: 0, total_earnings: 7755,
  sss: 0, philhealth: 0, pagibig: 0, cash_advance: 0, late_absences: 128.8,
  total_deductions: 128.8,
  ...overrides,
});

describe('buildSlipContext', () => {
  it('formats money fields and computes net pay', () => {
    const ctx = buildSlipContext(emp());
    expect(ctx.daily_rate).toBe('600.00');
    expect(ctx.total_earnings).toBe('7,755.00');
    expect(ctx.total_deductions).toBe('128.80');
    expect(ctx.net_pay).toBe('7,626.20'); // 7755 - 128.8
  });

  it('coerces string-typed numeric fields (as stored by the manual record form)', () => {
    const ctx = buildSlipContext(emp({ total_earnings: '7755', total_deductions: '128.8' }));
    expect(ctx.net_pay).toBe('7,626.20');
  });

  it('uses the stored net_pay when available (from CSV import or manual edit)', () => {
    const ctx = buildSlipContext(emp({ net_pay: 7626.25 }));
    expect(ctx.net_pay).toBe('7,626.25'); // stored value, not computed 7755 - 128.8 = 7626.20
  });

  it('formats the new Half Days / Undertime Days / Undertime Day Pay / Night Differential fields', () => {
    const ctx = buildSlipContext(emp({ days_half: 1, days_undertime: 2, undertime_day_pay: 350, night_diff_pay: 80 }));
    expect(ctx.days_half).toBe(1);
    expect(ctx.days_undertime).toBe(2);
    expect(ctx.undertime_day_pay).toBe('350.00');
    expect(ctx.night_diff_pay).toBe('80.00');
  });

  it('formats each other_deductions line for the template\'s {{#other_deductions}} loop', () => {
    const ctx = buildSlipContext(emp({ other_deductions: [{ label: 'Cash Advance', amount: 2000 }, { label: 'Uniform', amount: 350.5 }] }));
    expect(ctx.other_deductions).toEqual([
      { label: 'Cash Advance', amount: '2,000.00' },
      { label: 'Uniform', amount: '350.50' },
    ]);
  });

  it('other_deductions defaults to an empty array when absent or not an array', () => {
    expect(buildSlipContext(emp()).other_deductions).toEqual([]);
    expect(buildSlipContext(emp({ other_deductions: null })).other_deductions).toEqual([]);
  });

  it('folds a legacy non-zero top-level cash_advance into other_deductions as the first line (the template no longer has its own Cash Advance row)', () => {
    const ctx = buildSlipContext(emp({ cash_advance: 1500, other_deductions: [{ label: 'Uniform', amount: 350 }] }));
    expect(ctx.other_deductions).toEqual([
      { label: 'Cash Advance', amount: '1,500.00' },
      { label: 'Uniform', amount: '350.00' },
    ]);
  });

  it('a zero cash_advance is not folded in — no empty Cash Advance line', () => {
    expect(buildSlipContext(emp({ cash_advance: 0 })).other_deductions).toEqual([]);
  });
});

describe('buildPayrollSlipsHtml', () => {
  it('renders each slip through the given template body', () => {
    const html = buildPayrollSlipsHtml([emp()], CUSTOM_BODY);
    expect(html).toContain('Dela Cruz, Juan');
    expect(html).toContain('net 7,626.20');
  });

  it('falls back to the built-in layout when no template body is given', () => {
    const html = buildPayrollSlipsHtml([emp()]);
    expect(html).toContain('Dela Cruz, Juan');
    expect(html).toContain('NET PAY');
  });

  it('renders 2 identical copies per employee (cut-together pair)', () => {
    const html = buildPayrollSlipsHtml([emp()], CUSTOM_BODY);
    expect(html.split('Dela Cruz, Juan').length - 1).toBe(2);
  });

  it('pairs 2 employees per page and pads an odd count with an empty slot', () => {
    const html = buildPayrollSlipsHtml(
      [emp({ employee_name: 'A' }), emp({ employee_name: 'B' }), emp({ employee_name: 'C' })],
      CUSTOM_BODY
    );
    const pages = html.split('<div class="payslip-page">').length - 1;
    expect(pages).toBe(2); // ceil(3/2)
  });

  it('handles an empty list without throwing', () => {
    expect(buildPayrollSlipsHtml([])).toBe('');
  });

  it('the fallback body references the fields the fetch could return', () => {
    expect(FALLBACK_BODY).toContain('{{employee_name}}');
    expect(FALLBACK_BODY).toContain('{{net_pay}}');
  });

  it('a template using {{#other_deductions}}...{{/other_deductions}} renders one line per entry', () => {
    const body = '<div>{{#other_deductions}}<span>{{label}}: {{amount}}</span>{{/other_deductions}}</div>';
    const html = buildPayrollSlipsHtml([emp({ other_deductions: [{ label: 'Cash Advance', amount: 2000 }, { label: 'Uniform', amount: 350 }] })], body);
    expect(html).toContain('Cash Advance: 2,000.00');
    expect(html).toContain('Uniform: 350.00');
  });

  // Regression: each of the 4 slip cells on a page must be its own CSS positioning boundary
  // (position:relative), or a floating object (an image "made movable" in the template editor)
  // inside the slip body resolves its %-based position against the shared page instead of its
  // own quarter — every copy's float lands at the same spot, oversized (the payslip-logo bug).
  it('gives each grid cell its own positioning boundary for floating template content', () => {
    const html = buildPayrollSlipsHtml([emp()], CUSTOM_BODY);
    expect(html).toContain('.payslip-grid > div { position: relative; overflow: hidden; }');
  });

  // Regression: fitPayslipCells() must scale a naturally-sized *inner* wrapper, never the
  // fixed-height/overflow:hidden cell itself — an element's own overflow clip is resolved
  // against its own box before its own transform, so scaling that same element only ever
  // shrinks the content that already survived the clip (NET PAY/signature already gone).
  // Each of the 4 cells needs its own such wrapper for fitPayslipCells() to find and scale.
  it('wraps each of the 4 rendered slips in its own .payslip-cell-inner, inside the (unscaled) grid cell', () => {
    const html = buildPayrollSlipsHtml([emp()], CUSTOM_BODY);
    expect(html.split('<div class="payslip-cell-inner">').length - 1).toBe(4);
  });
});

// _fitScale is the pure-math half of fitPayslipCells() (the DOM-measuring half needs a real
// browser layout — scrollHeight/clientHeight — so it isn't exercised here; see
// hr-payroll-print.js and its call site in form-records.js's printSlips()).
describe('_fitScale', () => {
  it('returns null when content already fits its cell', () => {
    expect(_fitScale(100, 150)).toBeNull();
    expect(_fitScale(150, 150)).toBeNull();
  });

  it('returns the shrink factor needed when content overflows its cell (a customized template with a logo, or extra other_deductions lines, taller than the fixed 2x2 grid cell)', () => {
    expect(_fitScale(200, 150)).toBeCloseTo(0.75);
  });

  it('treats a zero/negative box height as unmeasured (not yet laid out) rather than dividing by it', () => {
    expect(_fitScale(200, 0)).toBeNull();
  });
});


describe('single payslip detail preview', () => {
  it('renders the fallback when the configured template is unavailable', () => {
    const html = renderSlip(emp());
    expect(html).toContain('EMPLOYEE PAYROLL SLIP');
    expect(html).toContain('Dela Cruz, Juan');
    expect(html).toContain('NET PAY: 7,626.20');
    expect(html).not.toContain('{{');
  });
});
it('prints multipage payslip layouts as full documents instead of the legacy grid',()=>{const html=buildPayrollSlipsHtml([{employee_name:'Ada'}],'<div data-doc-design-page="a">{{employee_name}}</div><div data-doc-design-page="b">Details</div>');expect(html).toContain('Ada');expect(html).toContain('Details');expect(html).not.toContain('payslip-grid');});
