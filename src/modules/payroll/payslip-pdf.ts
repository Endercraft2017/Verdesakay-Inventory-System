/** Employee payslip as a PDF (GET /api/me/payslips/:id/pdf). Pure rendering: the caller has
 *  already checked ownership and that the payslip is finalized (status 'paid'). Captions come
 *  from the live hr_payroll form definition so the PDF matches what HR sees. */
import { PdfDoc } from '../../shared/pdf-lite';

type Data = Record<string, unknown>;

const ATTENDANCE = ['daily_rate', 'days_worked', 'days_absent', 'days_half', 'days_undertime', 'ot_hours'];
const EARNINGS = [
  'basic_salary', 'overtime_pay', 'holiday_pay', 'special_holiday_30', 'rest_day_ot',
  'night_diff_pay', 'undertime_day_pay', 'undertime_pay',
];
const DEDUCTIONS = ['late_absences', 'sss', 'philhealth', 'pagibig', 'withholding_tax', 'cash_advance'];

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const peso = (v: unknown): string =>
  'PHP ' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export interface PayslipPdfInput {
  number: string;
  data: Data;
  finalizedAt: string;
  company: { name?: string | null; address?: string | null } | null;
  labels: Record<string, string>;
}

export function renderPayslipPdf(p: PayslipPdfInput): Buffer {
  const d = p.data;
  const label = (k: string) => p.labels[k] || titleCase(k);
  const doc = new PdfDoc();

  doc.line(p.company?.name || 'Payslip', { size: 16, bold: true });
  if (p.company?.address) doc.line(p.company.address, { size: 9 });
  doc.space(6);
  doc.line('PAYSLIP', { size: 12, bold: true, right: p.number, rightBold: false });
  doc.rule();
  doc.line('Employee', { right: String(d.employee_name ?? '') , rightBold: true });
  if (d.dept_position) doc.line('Department / position', { right: String(d.dept_position) });
  doc.line('Payroll period', { right: String(d.payroll_period ?? '') });
  if (d.pay_date) doc.line('Pay date', { right: String(d.pay_date) });
  doc.line('Finalized', { right: p.finalizedAt.slice(0, 10) });

  doc.space(6);
  doc.line('Attendance', { bold: true, size: 11 });
  doc.rule(4);
  for (const k of ATTENDANCE) {
    if (d[k] == null || d[k] === '') continue;
    doc.line(label(k), { right: k === 'daily_rate' ? peso(d[k]) : String(num(d[k])) });
  }

  doc.space(6);
  doc.line('Earnings', { bold: true, size: 11 });
  doc.rule(4);
  for (const k of EARNINGS) if (num(d[k]) !== 0) doc.line(label(k), { right: peso(d[k]) });
  doc.rule(4);
  doc.line(label('total_earnings'), { bold: true, right: peso(d.total_earnings) });

  doc.space(6);
  doc.line('Deductions', { bold: true, size: 11 });
  doc.rule(4);
  for (const k of DEDUCTIONS) if (num(d[k]) !== 0) doc.line(label(k), { right: peso(d[k]) });
  const others = Array.isArray(d.other_deductions) ? d.other_deductions as Array<{ label?: string; amount?: number }> : [];
  for (const o of others) if (num(o.amount) !== 0) doc.line(String(o.label || 'Other deduction'), { right: peso(o.amount) });
  doc.rule(4);
  doc.line(label('total_deductions'), { bold: true, right: peso(d.total_deductions) });

  doc.space(10);
  doc.rule(2);
  doc.line('NET PAY', { size: 13, bold: true, right: peso(d.net_pay) });
  doc.rule(2);

  doc.space(18);
  doc.line('This payslip was finalized by HR and cannot change. Keep it for your records.', { size: 8 });
  return doc.toBuffer({ title: `Payslip ${p.number}` });
}
