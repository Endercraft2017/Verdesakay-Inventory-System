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
    buildPayrollSlipsHtml: (data: unknown[], templateBody?: string) => string;
    buildSlipContext: (d: Record<string, unknown>) => Record<string, string>;
    FALLBACK_BODY: string;
  };
}

const { buildPayrollSlipsHtml, buildSlipContext, FALLBACK_BODY } = loadModule();

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
});
