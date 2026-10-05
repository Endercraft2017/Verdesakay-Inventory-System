/** HR: Employees master list (201 file: status, statutory numbers, photo, documents) +
    Time Keeping (cutoff periods with daily time-in/out), wired to generate records in the
    existing "HR Payroll" form so the existing print pipeline (form-records.js /
    hr-payroll-print.js) handles payslip printing. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, uploadDir, getSetting, setSetting } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import {
  parseBody,
  employeeSchema,
  csvImportSchema,
  payrollTableSchema,
  attendancePeriodSchema,
  saveAttendanceSchema,
  addRosterEmployeeSchema,
  addRosterEmployeesBulkSchema,
  generatePayslipsSchema,
  shiftSchema,
  payrollPolicySchema,
  employeeNumberPolicySchema,
  payrollDeductionTogglesSchema,
  createAssetIssuanceSchema,
  returnAssetItemSchema,
} from '../../shared/validation';
import type { Employee, EmployeeDocument, AttendancePeriod, FormDefinition, FormRecord, Shift, PayrollPolicy, EmployeeNumberPolicy, AssetIssuance, AssetIssuanceItem } from '../../shared/types';
import { computeAttendanceMultiRate, computeAttendanceForEmployee, unrecordedOtMinutes, type AttendanceDay } from '../payroll/hr-payroll-compute';
import { classifyDailyStatus } from './hr-daily-report';
import { restDaySwapsFor, resolveRestDay, REST_DAY_FORM_SLUGS } from './rest-day';
import { suggestEmployeeNumber } from './hr-employee-numbering';
import { toCsv } from '../../shared/csv';
import { resolveImport, importLoop } from '../../shared/csv-import';
import { listPayrollTables, effectiveTables, upsertPayrollTable, deletePayrollTable } from '../payroll/payroll-tables';
import { listRateHistory, seedInitialRate, recordRateChange, effectiveDailyRateOn } from '../payroll/employee-rate-history';
import {
  taxableCompensation, withholdingTax, RWT_2026, sssContribution, philHealthContribution, pagIbigContribution,
  sssCompensation, pagIbigCompensation, philHealthMonthlyBasic, contributionBasis, monthRemainder,
  type PayslipEarnings,
} from '../payroll/ph-statutory';
import { earlierPayslipsInMonth, isLastCutoffOfMonth } from '../payroll/statutory-month';
import type { PayslipYearRow } from '../payroll/ph-2316';
import { computeFinalPay, type FinalPayInput } from '../payroll/ph-final-pay';
import { yearPayslipRowsByEmployee, companyProfile } from '../payroll/ph-payroll-report-data';
import { payslipOwnerResolver } from '../payroll/payslip-owner';
import { enforceQuota } from '../../platform/quota';
import { slotPunchIdsForDates, type CorrectionSlot } from './clock';
import { photoIdsForPunches } from './punch-photos';
import { sendMail } from '../../shared/mailer';
import { ledgerEnabled, maybeAutoPostPayroll } from '../accounting/accounting-autopost';
import { noWorkFormIds as noWorkFormIdsWithAction } from '../../core/form-actions';
import { notifyUser } from '../../shared/push';
import { recordSiteClash, syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { now, sideEffectsSuppressed, siteDecisionStands } from '../../shared/sync-context';

// Reuses the browser's own payslip HTML renderer instead of duplicating it server-side —
// hr-payroll-print.js is pure string logic (no DOM/window access) and already resolves its
// own require('./doc-template.js') internally when run under Node, same trick the test suite
// uses to load it. `createRequire` (not `require`, since this file is ESM) needs a base URL
// to resolve the relative path from.
const clientRequire = createRequire(import.meta.url);
const { renderSlip: renderPayrollSlip, FALLBACK_BODY: PAYROLL_SLIP_FALLBACK } =
  clientRequire('../../../public/js/hr-payroll-print.js') as {
    renderSlip: (data: Record<string, unknown>, templateBody: string) => string;
    FALLBACK_BODY: string;
  };

const EMP_CSV_COLUMNS = [
  'employee_no', 'name', 'department', 'position', 'rate_type', 'daily_rate', 'monthly_rate',
  'status', 'start_date', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin_no',
] as const;

const router = Router();
router.use(requireAuth);

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const uploadDoc = multer({ storage: docStorage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

/** 'YYYY-MM-DD' shifted by `delta` calendar days (may be negative). Built the same UTC-anchored
    way as datesInRange below, so it agrees with it about what "the next/previous day" means. */
function addDays(workDate: string, delta: number): string {
  const d = new Date(workDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of 'YYYY-MM-DD' date strings from start to end. */
function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (cur.getTime() <= last.getTime()) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function ensureRosterDays(periodId: number, employeeId: number, start: string, end: string): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO attendance_records (period_id, employee_id, work_date) VALUES (?, ?, ?)`
  );
  for (const d of datesInRange(start, end)) insert.run(periodId, employeeId, d);
}

// ─── Employees ──────────────────────────────────────────────────────────────

const DEFAULT_EMP_NO_POLICY: EmployeeNumberPolicy = {
  prefix: 'EMP', mode: 'sequential', pad: 5, date_format: 'YYYYMMDD',
};

function currentEmpNoPolicy(): EmployeeNumberPolicy {
  return { ...DEFAULT_EMP_NO_POLICY, ...(getSetting<Partial<EmployeeNumberPolicy>>('employee_no_policy') || {}) };
}

// GET /api/hr/employee-number-policy
router.get('/employee-number-policy', requirePermission('hr.view'), (_req, res) => {
  res.json(currentEmpNoPolicy());
});

// PUT /api/hr/employee-number-policy
router.put('/employee-number-policy', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(employeeNumberPolicySchema, req.body);
  setSetting('employee_no_policy', input);
  res.json(input);
});

// GET /api/hr/employees/suggest-number?start_date=YYYY-MM-DD — a RECOMMENDATION only, computed
// fresh from current data each call (no counter reserved/mutated), since employee_no is a plain
// editable field and the caller is free to ignore this and type their own.
router.get('/employees/suggest-number', requirePermission('hr.view'), (req, res) => {
  const startDate = typeof req.query.start_date === 'string' && req.query.start_date.trim()
    ? req.query.start_date.trim()
    : new Date().toISOString().slice(0, 10);
  const existing = queryAll<{ employee_no: string | null }>('SELECT employee_no FROM employees')
    .map((r) => r.employee_no).filter((n): n is string => !!n);
  res.json({ employee_no: suggestEmployeeNumber(existing, currentEmpNoPolicy(), startDate) });
});

// GET /api/hr/employees?q=&department_id=&status=
router.get('/employees', requirePermission('hr.view'), (req, res) => {
  const { q, department_id, status } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof q === 'string' && q.trim()) {
    where.push('e.name LIKE ?'); params.push(`%${q.trim()}%`);
  }
  if (typeof department_id === 'string' && department_id.trim()) {
    where.push('e.department_id = ?'); params.push(Number(department_id));
  }
  if (typeof status === 'string' && status.trim()) {
    where.push('e.status = ?'); params.push(status.trim());
  }
  const rows = queryAll<Employee>(
    `SELECT e.*, d.name AS department_name, u.username AS linked_username, u.full_name AS linked_full_name,
            (e.leave_days_per_year - e.leave_days_used) AS leave_days_remaining
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = e.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.name`,
    ...params
  );
  // rest_days is stored as a JSON-text column (see db.ts migration) — parse it back to an
  // array (or null) for callers, same shape employeeSchema accepts on save.
  for (const r of rows) {
    r.rest_days = r.rest_days ? (() => { try { return JSON.parse(r.rest_days as unknown as string); } catch { return null; } })() : null;
  }
  res.json(rows);
});

// GET /api/hr/employees/export — 201-file master data as CSV (round-trips with import)
router.get('/employees/export', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<Record<string, unknown>>(
    `SELECT e.employee_no, e.name, d.name AS department, e.position, e.rate_type,
            e.daily_rate, e.monthly_rate, e.status, e.start_date,
            e.sss_no, e.philhealth_no, e.pagibig_no, e.tin_no
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     ORDER BY e.name`
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([...EMP_CSV_COLUMNS], rows));
});

// POST /api/hr/employees/import — create/update the 201-file master from CSV.
// Upsert key: employee_no. `department` matched by name. Never touches the linked
// login account or photo. Payroll history is unaffected (this is master data only).
router.post('/employees/import', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const { csv, dry_run } = parseBody(csvImportSchema, req.body);
  let resolved;
  try {
    resolved = resolveImport(csv, [
      { key: 'employee_no', aliases: ['employee no', 'emp no', 'id', 'employee id'], required: true },
      { key: 'name', aliases: ['employee name', 'full name'], required: true },
      { key: 'department', aliases: ['dept'] },
      { key: 'position', aliases: ['title', 'designation'] },
      { key: 'rate_type', aliases: ['rate type'] },
      { key: 'daily_rate', aliases: ['daily rate', 'rate'] },
      { key: 'monthly_rate', aliases: ['monthly rate', 'salary', 'monthly salary'] },
      { key: 'status' },
      { key: 'start_date', aliases: ['start date', 'date hired', 'hire date'] },
      { key: 'sss_no', aliases: ['sss', 'sss no'] },
      { key: 'philhealth_no', aliases: ['philhealth', 'philhealth no'] },
      { key: 'pagibig_no', aliases: ['pagibig', 'pag-ibig', 'pag-ibig no', 'hdmf'] },
      { key: 'tin_no', aliases: ['tin', 'tin no'] },
    ]);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Bad CSV' });
    return;
  }

  const report = importLoop(resolved.rows, !!dry_run, (row) => {
    const empNo = resolved.get(row, 'employee_no');
    const deptName = resolved.get(row, 'department');
    let departmentId: number | null = null;
    if (deptName) {
      const d = queryOne<{ id: number }>('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', deptName);
      if (!d) return { error: `Unknown department "${deptName}"`, key: empNo };
      departmentId = d.id;
    }
    const rateType = (resolved.get(row, 'rate_type') || 'daily').toLowerCase();
    const parsed = employeeSchema.safeParse({
      employee_no: empNo,
      name: resolved.get(row, 'name'),
      department_id: departmentId ?? undefined,
      position: resolved.get(row, 'position') || undefined,
      rate_type: rateType === 'monthly' ? 'monthly' : 'daily',
      daily_rate: resolved.get(row, 'daily_rate') || 0,
      monthly_rate: resolved.get(row, 'monthly_rate') || undefined,
      status: resolved.get(row, 'status') || undefined,
      start_date: resolved.get(row, 'start_date') || undefined,
      sss_no: resolved.get(row, 'sss_no') || undefined,
      philhealth_no: resolved.get(row, 'philhealth_no') || undefined,
      pagibig_no: resolved.get(row, 'pagibig_no') || undefined,
      tin_no: resolved.get(row, 'tin_no') || undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid row', key: empNo };
    const d = parsed.data;
    const existing = queryOne<Employee>('SELECT * FROM employees WHERE employee_no = ?', empNo);
    if (existing) {
      // Payroll pays each day from employee_rate_history, so an imported rate change has to be
      // logged there too (effective today, same default as the Edit Employee form) — otherwise an
      // employee who already has history rows would keep being paid the old rate.
      const importedDaily = effectiveDailyRate(d);
      if (round2(importedDaily) !== round2(existing.daily_rate)) {
        recordRateChange(
          existing.id, now().toISOString().slice(0, 10),
          { rate_type: d.rate_type, daily_rate: importedDaily, monthly_rate: d.rate_type === 'monthly' ? (d.monthly_rate ?? null) : null },
          { rate_type: existing.rate_type, daily_rate: existing.daily_rate, monthly_rate: existing.monthly_rate ?? null, start_date: existing.start_date ?? null },
          'Employee import', req.user!.id
        );
      }
      run(
        `UPDATE employees SET name = ?, department_id = ?, position = ?, daily_rate = ?, rate_type = ?,
           monthly_rate = ?, status = ?, start_date = ?, sss_no = ?, philhealth_no = ?, pagibig_no = ?, tin_no = ?
         WHERE id = ?`,
        d.name, departmentId ?? existing.department_id ?? null, d.position ?? existing.position ?? null,
        effectiveDailyRate(d), d.rate_type, d.rate_type === 'monthly' ? d.monthly_rate : null,
        d.status, d.start_date ?? existing.start_date ?? null,
        d.sss_no ?? existing.sss_no ?? null, d.philhealth_no ?? existing.philhealth_no ?? null,
        d.pagibig_no ?? existing.pagibig_no ?? null, d.tin_no ?? existing.tin_no ?? null,
        existing.id
      );
      return 'updated';
    }
    run(
      `INSERT INTO employees
        (employee_no, name, department_id, position, daily_rate, rate_type, monthly_rate, status, start_date,
         sss_no, philhealth_no, pagibig_no, tin_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.employee_no, d.name, departmentId, d.position ?? null, effectiveDailyRate(d), d.rate_type,
      d.rate_type === 'monthly' ? d.monthly_rate : null, d.status, d.start_date ?? null,
      d.sss_no ?? null, d.philhealth_no ?? null, d.pagibig_no ?? null, d.tin_no ?? null
    );
    return 'created';
  });
  res.json(report);
});

// ---- PH statutory rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding) ----
// Versioned reference data used by the payroll engine (src/ph-statutory.ts). See
// docs/PH-PAYROLL-COMPLIANCE.md.

// GET /api/hr/payroll-tables?date=YYYY-MM-DD — every stored version + the set resolved for `date`
router.get('/payroll-tables', requirePermission('hr.view'), (req, res) => {
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date : undefined;
  res.json({ rows: listPayrollTables(), effective: effectiveTables(date), as_of: date || new Date().toISOString().slice(0, 10) });
});

// POST /api/hr/payroll-tables — add/replace a version { kind, effective_from, data, note? }
router.post('/payroll-tables', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(payrollTableSchema, req.body);
  upsertPayrollTable(input.kind, input.effective_from, input.data, input.note ?? null, req.user!.id);
  res.status(201).json({ ok: true });
});

// DELETE /api/hr/payroll-tables/:id
router.delete('/payroll-tables/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  if (!deletePayrollTable(Number(req.params.id))) {
    res.status(404).json({ error: 'Rate table version not found' });
    return;
  }
  res.json({ ok: true });
});

// GET /api/hr/thirteenth-month?year=YYYY — 13th-month pay per employee = total basic
// salary earned that calendar year / 12. Reads the generated hr_payroll records; each is
// dated by its pay_date (falling back to created_at).
router.get('/thirteenth-month', requirePermission('hr.view'), (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const form = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'");
  if (!form) { res.json({ year, rows: [], total: 0 }); return; }

  const records = queryAll<{ data: string; created_at: string }>(
    'SELECT data, created_at FROM form_records WHERE form_def_id = ?',
    form.id
  );
  const byEmp = new Map<string, { basic_total: number; payslip_count: number }>();
  const owner = payslipOwnerResolver(); // a renamed employee's payslips stay one row
  for (const r of records) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.data); } catch { continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    if (String(payDate).slice(0, 4) !== year) continue;
    const name = owner.nameOf(d);
    if (!name) continue;
    const cur = byEmp.get(name) ?? { basic_total: 0, payslip_count: 0 };
    cur.basic_total += Number(d.basic_salary) || 0;
    cur.payslip_count += 1;
    byEmp.set(name, cur);
  }

  const rows = [...byEmp.entries()]
    .map(([employee_name, v]) => ({
      employee_name,
      basic_total: round2(v.basic_total),
      payslip_count: v.payslip_count,
      amount: round2(v.basic_total / 12),
    }))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  res.json({ year, rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) });
});

// GET /api/hr/final-pay/:employeeId — final-pay / back-pay worksheet for a separated
// employee. Operator inputs come in as query params (leave balances, loans, unpaid days
// aren't derivable from the payslips). Read-only — the accountant reviews before release.
router.get('/final-pay/:employeeId', requirePermission('hr.view'), (req, res) => {
  const emp = queryOne<Employee & { department_name?: string }>(
    `SELECT e.*, d.name AS department_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`,
    Number(req.params.employeeId)
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  const q = req.query as Record<string, unknown>;
  const numq = (v: unknown, dflt = 0): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : dflt;
  };
  const sep = typeof q.separation_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.separation_date)
    ? q.separation_date : new Date().toISOString().slice(0, 10);
  const year = sep.slice(0, 4);

  const slips = yearPayslipRowsByEmployee(year).get(emp.name) ?? [];
  const sum = (pick: (r: PayslipYearRow) => number | undefined) =>
    round2(slips.reduce((s, r) => s + (Number(pick(r)) || 0), 0));

  const dailyRate = effectiveDailyRate({
    rate_type: emp.rate_type, daily_rate: emp.daily_rate, monthly_rate: emp.monthly_rate,
  });
  // Defaults to the employee's tracked leave-day bank, but the operator can still override
  // via ?unused_leave_days= (e.g. company policy doesn't convert 100% of remaining leave).
  const leaveRemaining = round2(Math.max(0, (emp.leave_days_per_year ?? 0) - (emp.leave_days_used ?? 0)));

  const input: FinalPayInput = {
    employee_name: emp.name,
    daily_rate: dailyRate,
    separation_date: sep,
    last_day_paid: typeof q.last_day_paid === 'string' ? q.last_day_paid : null,
    unpaid_days: Math.max(0, numq(q.unpaid_days)),
    unused_leave_days: Math.max(0, numq(q.unused_leave_days, leaveRemaining)),
    other_earnings: Math.max(0, numq(q.other_earnings)),
    outstanding_advance: Math.max(0, numq(q.outstanding_advance, sum((r) => r.cash_advance))),
    other_deductions: Math.max(0, numq(q.other_deductions)),
    ytd: {
      basic_earned: sum((r) => r.basic_salary),
      gross_earned: sum((r) => r.total_earnings),
      employee_statutory: round2(sum((r) => r.sss) + sum((r) => r.philhealth) + sum((r) => r.pagibig)),
      tax_withheld: sum((r) => r.withholding_tax),
      thirteenth_month_paid: Math.max(0, numq(q.thirteenth_month_paid)),
    },
    rwt: effectiveTables(`${year}-12-31`).rwt || RWT_2026,
    thirteenth_month_ceiling: numq(q.thirteenth_month_ceiling, 90_000),
  };

  res.json({
    year,
    company: companyProfile(),
    employee: emp,
    leave_days_remaining: leaveRemaining,
    inputs: input,
    worksheet: computeFinalPay(input),
  });
});

// Resolves the effective daily_rate to store: the entered value for rate_type 'daily', or
// monthly_rate / policy.monthly_rate_divisor for 'monthly' — computed once here so every other
// consumer (payroll compute, payslip generation) can keep reading daily_rate unchanged.
function effectiveDailyRate(input: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate?: number | null }): number {
  if (input.rate_type !== 'monthly') return input.daily_rate;
  const divisor = currentPolicy().monthly_rate_divisor;
  return round2((input.monthly_rate || 0) / divisor);
}

// Validates a to-be-linked user_id: must exist, and must not already be linked to a DIFFERENT
// employee (the partial unique index would also catch this, but a named 409 beats a raw
// constraint-violation error). excludeEmployeeId lets an employee keep its own existing link
// when re-saving unrelated fields (PUT), and is omitted entirely on create.
function checkLinkedUser(userId: number | null, excludeEmployeeId?: number): string | null {
  if (userId == null) return null;
  if (!queryOne('SELECT id FROM users WHERE id = ?', userId)) return 'Linked account not found';
  const clash = excludeEmployeeId != null
    ? queryOne<{ name: string }>('SELECT name FROM employees WHERE user_id = ? AND id != ?', userId, excludeEmployeeId)
    : queryOne<{ name: string }>('SELECT name FROM employees WHERE user_id = ?', userId);
  return clash ? `That account is already linked to ${clash.name}` : null;
}

// POST /api/hr/employees
router.post('/employees', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(employeeSchema, req.body);
  if (queryOne('SELECT id FROM employees WHERE employee_no = ?', input.employee_no)) {
    res.status(409).json({ error: `Employee number "${input.employee_no}" is already in use` }); return;
  }
  const linkErr = checkLinkedUser(input.user_id);
  if (linkErr) { res.status(409).json({ error: linkErr }); return; }
  const dailyRate = effectiveDailyRate(input);
  const info = run(
    `INSERT INTO employees
      (employee_no, name, department_id, position, user_id, daily_rate, rate_type, monthly_rate, status, start_date,
       sss_no, philhealth_no, pagibig_no, tin_no, leave_days_per_year, leave_days_used, rest_days, default_shift_id, late_exempt,
       ot_exempt, deduct_sss, deduct_philhealth, deduct_pagibig, deduct_withholding_tax, withholding_tax_override,
       sss_override, philhealth_override, pagibig_override, photo, clock_anywhere, birth_date, civil_status, always_whole_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, dailyRate,
    input.rate_type, input.rate_type === 'monthly' ? input.monthly_rate : null,
    input.status, input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.leave_days_per_year, input.leave_days_used,
    input.rest_days ? JSON.stringify(input.rest_days) : null, input.default_shift_id, input.late_exempt ? 1 : 0,
    input.ot_exempt ? 1 : 0, input.deduct_sss === false ? 0 : 1, input.deduct_philhealth === false ? 0 : 1,
    input.deduct_pagibig === false ? 0 : 1, input.deduct_withholding_tax === false ? 0 : 1,
    input.withholding_tax_override ?? null,
    input.sss_override ?? null, input.philhealth_override ?? null, input.pagibig_override ?? null, input.photo ?? null,
    input.clock_anywhere ? 1 : 0, input.birth_date ?? null, input.civil_status ?? null, input.always_whole_day ? 1 : 0
  );
  seedInitialRate(
    Number(info.lastInsertRowid), input.start_date ?? null,
    { rate_type: input.rate_type, daily_rate: dailyRate, monthly_rate: input.rate_type === 'monthly' ? (input.monthly_rate ?? null) : null },
    req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/employees/:id
router.put('/employees/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<{
    name: string; daily_rate: number; rate_type: 'daily' | 'monthly'; monthly_rate: number | null; start_date: string | null;
    birth_date: string | null; civil_status: string | null;
  }>(
    'SELECT name, daily_rate, rate_type, monthly_rate, start_date, birth_date, civil_status FROM employees WHERE id = ?', id
  );
  if (!existing) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  const input = parseBody(employeeSchema, req.body);
  const dup = queryOne<{ id: number }>('SELECT id FROM employees WHERE employee_no = ? AND id != ?', input.employee_no, id);
  if (dup) {
    res.status(409).json({ error: `Employee number "${input.employee_no}" is already in use` }); return;
  }
  const linkErr = checkLinkedUser(input.user_id, id);
  if (linkErr) { res.status(409).json({ error: linkErr }); return; }

  const dailyRate = effectiveDailyRate(input);
  if (round2(dailyRate) !== round2(existing.daily_rate)) {
    const today = now().toISOString().slice(0, 10);
    const effectiveFrom = input.rate_effective_date || today;
    if (effectiveFrom > today) {
      res.status(400).json({ error: 'Rate changes can be backdated or effective today — scheduling one for a future date isn\'t supported yet' });
      return;
    }
    recordRateChange(
      id, effectiveFrom,
      { rate_type: input.rate_type, daily_rate: dailyRate, monthly_rate: input.rate_type === 'monthly' ? (input.monthly_rate ?? null) : null },
      { rate_type: existing.rate_type, daily_rate: existing.daily_rate, monthly_rate: existing.monthly_rate, start_date: existing.start_date },
      input.rate_change_note || null,
      req.user!.id
    );
  }
  run(
    `UPDATE employees SET employee_no = ?, name = ?, department_id = ?, position = ?, user_id = ?, daily_rate = ?, rate_type = ?,
       monthly_rate = ?, status = ?, start_date = ?, sss_no = ?, philhealth_no = ?, pagibig_no = ?, tin_no = ?,
       leave_days_per_year = ?, leave_days_used = ?, rest_days = ?, default_shift_id = ?, late_exempt = ?,
       ot_exempt = ?, deduct_sss = ?, deduct_philhealth = ?, deduct_pagibig = ?, deduct_withholding_tax = ?, withholding_tax_override = ?,
       sss_override = ?, philhealth_override = ?, pagibig_override = ?, photo = ?,
       clock_anywhere = COALESCE(?, clock_anywhere),
       always_whole_day = COALESCE(?, always_whole_day),
       birth_date = CASE WHEN ? THEN ? ELSE birth_date END,
       civil_status = CASE WHEN ? THEN ? ELSE civil_status END
     WHERE id = ?`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, dailyRate, input.rate_type,
    input.rate_type === 'monthly' ? input.monthly_rate : null, input.status,
    input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.leave_days_per_year, input.leave_days_used,
    input.rest_days ? JSON.stringify(input.rest_days) : null, input.default_shift_id, input.late_exempt ? 1 : 0,
    input.ot_exempt ? 1 : 0, input.deduct_sss === false ? 0 : 1, input.deduct_philhealth === false ? 0 : 1,
    input.deduct_pagibig === false ? 0 : 1, input.deduct_withholding_tax === false ? 0 : 1,
    input.withholding_tax_override ?? null,
    input.sss_override ?? null, input.philhealth_override ?? null, input.pagibig_override ?? null, input.photo ?? null,
    input.clock_anywhere === undefined ? null : (input.clock_anywhere ? 1 : 0),
    input.always_whole_day === undefined ? null : (input.always_whole_day ? 1 : 0),
    input.birth_date === undefined ? 0 : 1, input.birth_date ?? null,
    input.civil_status === undefined ? 0 : 1, input.civil_status ?? null, id
  );
  // Payslips carry the name as generated; logging the former name lets payroll reports and the
  // employee's own payslip list keep treating them as one person (payroll/payslip-owner.ts).
  // Birth date / civil status are logged the same way, next to approved information changes.
  type Logged = ['name' | 'birth_date' | 'civil_status', string | null, string | null];
  const logged: Logged[] = [['name', existing.name, input.name]];
  if (input.birth_date !== undefined) logged.push(['birth_date', existing.birth_date, input.birth_date]);
  if (input.civil_status !== undefined) logged.push(['civil_status', existing.civil_status, input.civil_status]);
  for (const [field, before, after] of logged) {
    if ((before ?? null) === (after ?? null)) continue;
    run(
      `INSERT INTO employee_profile_changes (employee_id, field, old_value, new_value, changed_by, source)
       VALUES (?, ?, ?, ?, ?, 'hr_edit')`,
      id, field, before, after, req.user!.id
    );
  }
  res.json({ ok: true });
});

// GET /api/hr/employees/:id/rate-history — read-only log for the Edit Employee form.
router.get('/employees/:id/rate-history', requirePermission('hr.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', id)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  res.json(listRateHistory(id));
});

// DELETE /api/hr/employees/:id
router.delete('/employees/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', id)) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }
  const hasAttendance = queryOne('SELECT id FROM attendance_records WHERE employee_id = ? LIMIT 1', id);
  if (hasAttendance) {
    res.status(409).json({ error: 'Employee has attendance history — set status to resigned/terminated instead of deleting.' });
    return;
  }
  run('DELETE FROM employees WHERE id = ?', id);
  res.json({ ok: true });
});

// ─── Employee 201 documents ─────────────────────────────────────────────────

// GET /api/hr/employees/:id/documents
router.get('/employees/:id/documents', requirePermission('hr.view'), (req, res) => {
  const employeeId = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', employeeId)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  const rows = queryAll<EmployeeDocument>(
    `SELECT ed.*, u.full_name AS uploaded_by_name
     FROM employee_documents ed LEFT JOIN users u ON u.id = ed.uploaded_by
     WHERE ed.employee_id = ? ORDER BY ed.created_at DESC`,
    employeeId
  );
  res.json(rows);
});

// POST /api/hr/employees/:id/documents — upload a 201 file document
router.post('/employees/:id/documents', requirePermission('hr.manage'), syncClass('merge'), syncUpload(uploadDoc.single('file')), (req, res) => {
  const employeeId = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', employeeId)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  if (!req.file) { res.status(400).json({ error: 'A file is required' }); return; }
  try { enforceQuota('storage_mb', req.file.size); }
  catch (e) { fs.promises.unlink(path.join(uploadDir(), req.file.filename)).catch(() => {}); throw e; }
  const title = (req.body?.title || '').trim() || req.file.originalname;
  const info = run(
    `INSERT INTO employee_documents
      (employee_id, title, stored_name, original_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    employeeId, title, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/hr/employees/:id/documents/:docId/download
router.get('/employees/:id/documents/:docId/download', requirePermission('hr.view'), (req, res) => {
  const doc = queryOne<EmployeeDocument>(
    'SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?',
    Number(req.params.docId), Number(req.params.id)
  );
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
  const filePath = path.join(uploadDir(), doc.stored_name);
  if (!fs.existsSync(filePath)) { res.status(410).json({ error: 'File is missing on disk' }); return; }
  res.download(filePath, doc.original_name);
});

// DELETE /api/hr/employees/:id/documents/:docId
router.delete('/employees/:id/documents/:docId', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const doc = queryOne<EmployeeDocument>(
    'SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?',
    Number(req.params.docId), Number(req.params.id)
  );
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
  run('DELETE FROM employee_documents WHERE id = ?', doc.id);
  // An installed PC keeps the file until the cloud confirms: a refused delete brings the row back.
  if (!sideEffectsSuppressed('unlink')) fs.promises.unlink(path.join(uploadDir(), doc.stored_name)).catch(() => {});
  res.json({ ok: true });
});

// ─── Employee assets (company property issued/returned — standalone register, not linked
// to Inventory stock; see SCHEMA_VERSION 43 in db.ts) ───────────────────────

const ASSET_STATUSES = ['issued', 'returned', 'lost', 'damaged'] as const;
const SEPARATED_STATUSES = ['resigned', 'terminated'];

/** "Laptop (SN-1) ×2" — one asset line as it reads in the activity log. */
function assetLineLabel(it: { asset_name: string; asset_tag?: string | null; quantity?: number }): string {
  const qty = it.quantity ?? 1;
  return `${it.asset_name}${it.asset_tag ? ` (${it.asset_tag})` : ''}${qty > 1 ? ` ×${qty}` : ''}`;
}

// GET /api/hr/assets — company-wide register: one row per asset line across every employee.
// Default view is what's still out (status=issued); ?status=all|returned|lost|damaged, ?q= (asset,
// tag, category, employee, form number), ?separated=1 (only people who have left — the
// clearance worklist), ?format=csv.
router.get('/assets', requirePermission('hr.view'), (req, res) => {
  const statusParam = String(req.query.status ?? 'issued');
  const where: string[] = [];
  const params: unknown[] = [];
  if (statusParam !== 'all') {
    if (!(ASSET_STATUSES as readonly string[]).includes(statusParam)) {
      res.status(400).json({ error: 'Unknown status' }); return;
    }
    where.push('it.status = ?'); params.push(statusParam);
  }
  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push(`(it.asset_name LIKE ? OR it.asset_tag LIKE ? OR it.category LIKE ? OR e.name LIKE ?
                 OR e.employee_no LIKE ? OR ai.number LIKE ?)`);
    params.push(...Array(6).fill(`%${q}%`));
  }
  const separatedIn = `(${SEPARATED_STATUSES.map(() => '?').join(',')})`;
  if (req.query.separated === '1') {
    where.push(`e.status IN ${separatedIn}`);
    params.push(...SEPARATED_STATUSES);
  }
  const rows = queryAll<AssetIssuanceItem & {
    issuance_number: string; issued_date: string; issued_by_name: string | null;
    employee_id: number; employee_name: string; employee_no: string | null;
    employee_status: string; department_name: string | null;
  }>(
    `SELECT it.*, ai.number AS issuance_number, ai.issued_date, u.full_name AS issued_by_name,
            e.id AS employee_id, e.name AS employee_name, e.employee_no, e.status AS employee_status,
            d.name AS department_name
     FROM asset_issuance_items it
     JOIN asset_issuances ai ON ai.id = it.issuance_id
     JOIN employees e ON e.id = ai.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = ai.issued_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ai.issued_date DESC, ai.id DESC, it.sort, it.id`,
    ...params
  );

  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets-${statusParam}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(
      ['Form No.', 'Issued Date', 'Employee No.', 'Employee Name', 'Employee Status', 'Department', 'Asset',
        'Category', 'Tag / Serial', 'Qty', 'Condition on Issue', 'Status', 'Returned Date', 'Condition on Return', 'Return Notes'],
      rows.map((r) => ({
        'Form No.': r.issuance_number, 'Issued Date': r.issued_date, 'Employee No.': r.employee_no || '',
        'Employee Name': r.employee_name, 'Employee Status': r.employee_status, Department: r.department_name || '',
        Asset: r.asset_name, Category: r.category || '', 'Tag / Serial': r.asset_tag || '', Qty: r.quantity,
        'Condition on Issue': r.condition_on_issue || '', Status: r.status, 'Returned Date': r.returned_date || '',
        'Condition on Return': r.condition_on_return || '', 'Return Notes': r.return_notes || '',
      }))
    ));
    return;
  }

  // Headline counts are company-wide (filters ignored) so the tiles stay stable while searching.
  const counts: Record<string, number> = Object.fromEntries(ASSET_STATUSES.map((s) => [s, 0]));
  for (const c of queryAll<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM asset_issuance_items GROUP BY status'
  )) counts[c.status] = c.n;
  const heldBySeparated = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM asset_issuance_items it
     JOIN asset_issuances ai ON ai.id = it.issuance_id JOIN employees e ON e.id = ai.employee_id
     WHERE it.status = 'issued' AND e.status IN ${separatedIn}`,
    ...SEPARATED_STATUSES
  )?.n ?? 0;
  res.json({ rows, counts, held_by_separated: heldBySeparated });
});

// GET /api/hr/employees/:id/assets — this employee's issuance history, items included.
router.get('/employees/:id/assets', requirePermission('hr.view'), (req, res) => {
  const employeeId = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', employeeId)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  const issuances = queryAll<AssetIssuance>(
    `SELECT ai.*, u.full_name AS issued_by_name
     FROM asset_issuances ai LEFT JOIN users u ON u.id = ai.issued_by
     WHERE ai.employee_id = ? ORDER BY ai.issued_date DESC, ai.id DESC`,
    employeeId
  );
  if (issuances.length) {
    const items = queryAll<AssetIssuanceItem>(
      `SELECT * FROM asset_issuance_items WHERE issuance_id IN (${issuances.map(() => '?').join(',')}) ORDER BY sort, id`,
      ...issuances.map((i) => i.id)
    );
    const byIssuance = new Map<number, AssetIssuanceItem[]>();
    for (const it of items) {
      if (!byIssuance.has(it.issuance_id)) byIssuance.set(it.issuance_id, []);
      byIssuance.get(it.issuance_id)!.push(it);
    }
    issuances.forEach((i) => { i.items = byIssuance.get(i.id) || []; });
  }
  res.json(issuances);
});

// POST /api/hr/employees/:id/assets — issue one or more assets on a new Asset Issuance Form.
router.post('/employees/:id/assets', requirePermission('hr.manage'), syncClass('physical'), (req, res) => {
  const employeeId = Number(req.params.id);
  const employee = queryOne<{ name: string }>('SELECT name FROM employees WHERE id = ?', employeeId);
  if (!employee) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  const input = parseBody(createAssetIssuanceSchema, req.body);
  db.exec('BEGIN');
  try {
    const number = nextSequence('asset_issuance_seq', 'AI');
    const info = run(
      `INSERT INTO asset_issuances (number, employee_id, issued_date, issued_by, notes) VALUES (?, ?, ?, ?, ?)`,
      number, employeeId, input.issued_date, req.user!.id, input.notes ?? null
    );
    const issuanceId = Number(info.lastInsertRowid);
    input.items.forEach((it, i) => {
      run(
        `INSERT INTO asset_issuance_items (issuance_id, asset_name, category, asset_tag, quantity, condition_on_issue, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        issuanceId, it.asset_name, it.category ?? null, it.asset_tag ?? null, it.quantity ?? 1, it.condition_on_issue ?? null, i
      );
    });
    db.exec('COMMIT');
    res.locals.activity = {
      action: 'asset-issue',
      summary: `Issued ${number} to ${employee.name}: ${input.items.map(assetLineLabel).join(', ')}`,
    };
    res.status(201).json({ id: issuanceId, number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// GET /api/hr/assets/:id — one issuance + its lines + employee identity (print/detail view).
router.get('/assets/:id', requirePermission('hr.view'), (req, res) => {
  const issuance = queryOne<AssetIssuance & {
    employee_name: string; employee_no: string | null; department_name: string | null; position: string | null;
  }>(
    `SELECT ai.*, u.full_name AS issued_by_name,
            e.name AS employee_name, e.employee_no, e.position, d.name AS department_name
     FROM asset_issuances ai
     LEFT JOIN users u ON u.id = ai.issued_by
     JOIN employees e ON e.id = ai.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ai.id = ?`,
    Number(req.params.id)
  );
  if (!issuance) { res.status(404).json({ error: 'Asset issuance not found' }); return; }
  issuance.items = queryAll<AssetIssuanceItem>('SELECT * FROM asset_issuance_items WHERE issuance_id = ? ORDER BY sort, id', issuance.id);
  res.json(issuance);
});

// POST /api/hr/assets/:id/items/:itemId/return — check in one line (returned / lost / damaged).
router.post('/assets/:id/items/:itemId/return', requirePermission('hr.manage'), syncClass('physical'), (req, res) => {
  const item = queryOne<AssetIssuanceItem>(
    'SELECT * FROM asset_issuance_items WHERE id = ? AND issuance_id = ?',
    Number(req.params.itemId), Number(req.params.id)
  );
  if (!item) { res.status(404).json({ error: 'Asset line not found' }); return; }
  const input = parseBody(returnAssetItemSchema, req.body);
  run(
    `UPDATE asset_issuance_items SET status = ?, returned_date = ?, condition_on_return = ?, return_notes = ? WHERE id = ?`,
    input.status, input.returned_date, input.condition_on_return ?? null, input.return_notes ?? null, item.id
  );
  const owner = queryOne<{ number: string; employee_name: string }>(
    'SELECT ai.number, e.name AS employee_name FROM asset_issuances ai JOIN employees e ON e.id = ai.employee_id WHERE ai.id = ?',
    item.issuance_id
  );
  const verb = { returned: 'Returned', lost: 'Marked lost', damaged: 'Marked damaged' }[input.status];
  res.locals.activity = {
    action: `asset-${input.status}`,
    summary: `${verb}: ${assetLineLabel(item)} on ${owner?.number ?? 'form'} (${owner?.employee_name ?? 'employee'})` +
      (item.status !== 'issued' ? ` — was ${item.status}` : ''),
    // A re-save overwrites the earlier return details — keep them here.
    snapshot: item.status !== 'issued'
      ? { previous: { status: item.status, returned_date: item.returned_date, condition_on_return: item.condition_on_return, return_notes: item.return_notes } }
      : undefined,
  };
  res.json({ ok: true });
});

// DELETE /api/hr/assets/:id — remove an issuance record entirely (e.g. entered in error).
router.delete('/assets/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const issuance = queryOne<AssetIssuance & { employee_name: string }>(
    'SELECT ai.*, e.name AS employee_name FROM asset_issuances ai JOIN employees e ON e.id = ai.employee_id WHERE ai.id = ?',
    Number(req.params.id)
  );
  if (!issuance) { res.status(404).json({ error: 'Asset issuance not found' }); return; }
  const items = queryAll<AssetIssuanceItem>('SELECT * FROM asset_issuance_items WHERE issuance_id = ? ORDER BY sort, id', issuance.id);
  run('DELETE FROM asset_issuances WHERE id = ?', issuance.id);
  // The rows are gone after this — the activity log keeps the only copy of what the form held.
  res.locals.activity = {
    action: 'asset-issuance-delete',
    summary: `Deleted ${issuance.number} (${issuance.employee_name}): ` +
      (items.map((it) => `${assetLineLabel(it)} [${it.status}]`).join(', ') || 'no items'),
    snapshot: { issuance: { ...issuance, items } },
  };
  res.json({ ok: true });
});

// ─── Shifts (named, assignable per attendance day — this is how rotating shifts are handled:
// a day just points at whichever shift applied that day, not a fixed per-employee schedule) ────

// GET /api/hr/shifts
router.get('/shifts', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<Omit<Shift, 'is_default'> & { is_default: number }>('SELECT * FROM shifts ORDER BY start_time');
  res.json(rows.map((r) => ({ ...r, is_default: !!r.is_default })));
});

// GET /api/hr/linked-form-record-ids — every form_records id currently linked to some
// attendance_records day (form_record_ids JSON array, or the legacy single form_record_id).
// The Daily Time grid's "Link a form" picker uses it to hide records already consumed by
// another day, so one OT/Half Day/Leave/… request can't be attached to two days by mistake.
router.get('/linked-form-record-ids', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<{ id: number }>(
    `SELECT DISTINCT je.value AS id
       FROM attendance_records ar,
            json_each(COALESCE(ar.form_record_ids, json_array(ar.form_record_id))) je
      WHERE je.value IS NOT NULL`
  );
  res.json(rows.map((r) => r.id));
});

// POST /api/hr/shifts
router.post('/shifts', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(shiftSchema, req.body);
  if (input.is_default) run('UPDATE shifts SET is_default = 0');
  const info = run(
    'INSERT INTO shifts (name, start_time, end_time, is_default) VALUES (?, ?, ?, ?)',
    input.name, input.start_time, input.end_time, input.is_default ? 1 : 0
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/shifts/:id
router.put('/shifts/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM shifts WHERE id = ?', id)) { res.status(404).json({ error: 'Shift not found' }); return; }
  const input = parseBody(shiftSchema, req.body);
  if (input.is_default) run('UPDATE shifts SET is_default = 0');
  run(
    'UPDATE shifts SET name = ?, start_time = ?, end_time = ?, is_default = ? WHERE id = ?',
    input.name, input.start_time, input.end_time, input.is_default ? 1 : 0, id
  );
  res.json({ ok: true });
});

// DELETE /api/hr/shifts/:id — attendance rows / employees.default_shift_id referencing it are
// gracefully un-linked (ON DELETE SET NULL), not blocked.
router.delete('/shifts/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM shifts WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Shift not found' }); return; }
  res.json({ ok: true });
});

// ─── Payroll policy (company-wide rules — grace period, late/OT rounding, OT %, night diff;
// *when* a shift runs lives in the shifts table above, this is the *rules* for judging it) ──────

const DEFAULT_POLICY: PayrollPolicy = {
  grace_minutes: 10, late_unit: 'hour', ot_unit: 'hour', ot_rate_percent: 125, require_ot_form: true,
  ot_grace_minutes: 0, ot_min_minutes: 0,
  // Night differential is on unless a company turns it off (Labor Code Art. 86 requires it).
  night_diff_enabled: true, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true,
  default_rest_days: [0, 6], // Sun, Sat
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false,
  count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min',
  whole_day_min_minutes: 0, max_ot_hours: null,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
  require_rest_day_form: false,
};

/** "YYYY-MM-DD" -> weekday index (0=Sun..6=Sat). Builds the Date from the parsed y/m/d as
    LOCAL components (not `new Date("YYYY-MM-DD")`, which parses as UTC midnight and can read
    back as the wrong calendar day in a non-UTC zone) so .getDay() answers for the calendar
    date the string actually names, regardless of server timezone. */
function weekdayOf(workDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(workDate);
  if (!m) return -1;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

// Server-local "today"/"now" for the Daily Report — same local-time convention time_punches
// already uses (src/clock.ts's localParts(): the office runs the server on-site, so wall-clock
// local time is what "today" and lateness should be judged against, not UTC).
function localDateStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localTimeStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** How many pay periods per month, for splitting the monthly statutory contribution. */
const PERIODS_PER_MONTH: Record<PayrollPolicy['pay_frequency'], number> = {
  monthly: 1, semi_monthly: 2, weekly: 4, daily: 22,
};

type DeductionSlot = { sss: boolean; philhealth: boolean; pagibig: boolean; withholding_tax: boolean };
const ALL_ON: DeductionSlot = { sss: true, philhealth: true, pagibig: true, withholding_tax: true };

/** Which cutoff "slot" (0-indexed) a period falls into within its month, for
    PayrollPolicy.deduction_schedule — only meaningful for pay frequencies where
    "which cutoff of the month" is a sensible question (not `daily`, see below).
    `weekly`'s day/7 bucketing is an approximation — real-world weekly cutoffs don't
    always align to calendar-day chunks; leaving every slot at the default (all-on)
    sidesteps that entirely. */
function slotIndexFor(period: { start_date: string }, payFrequency: PayrollPolicy['pay_frequency']): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(period.start_date);
  const day = m ? Number(m[3]) : 1;
  switch (payFrequency) {
    case 'monthly': return 0;
    case 'semi_monthly': return day <= 15 ? 0 : 1;
    case 'weekly': return Math.min(3, Math.floor((day - 1) / 7));
    case 'daily': return 0; // scheduling 22 slots/month isn't practical — see PERIODS_PER_MONTH
  }
}

/** The effective per-slot deduction schedule for `periodsPerMonth` cutoffs: the policy's
    own schedule if it's set and its length actually matches (a stale schedule left over
    from a different pay_frequency is ignored, not misapplied), else every slot has
    everything on — exactly the pre-existing always-divide-evenly behavior. */
function effectiveSchedule(policy: PayrollPolicy, periodsPerMonth: number): DeductionSlot[] {
  if (policy.deduction_schedule && policy.deduction_schedule.length === periodsPerMonth) {
    return policy.deduction_schedule;
  }
  return Array.from({ length: periodsPerMonth }, () => ALL_ON);
}

// Exported for src/routes/me.routes.ts's unrecorded-OT detection, which needs the same
// grace/OT-unit/require_ot_form rules generate-payslips itself uses — never a second, possibly
// drifting copy of the defaults.
export function currentPolicy(): PayrollPolicy {
  return { ...DEFAULT_POLICY, ...(getSetting<Partial<PayrollPolicy>>('payroll_policy') || {}) };
}

// GET /api/hr/payroll-policy
router.get('/payroll-policy', requirePermission('hr.view'), (_req, res) => {
  res.json(currentPolicy());
});

// PUT /api/hr/payroll-policy
router.put('/payroll-policy', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(payrollPolicySchema, req.body);
  setSetting('payroll_policy', input);
  res.json(input);
});

// ─── Cutoff periods ─────────────────────────────────────────────────────────

// GET /api/hr/periods
router.get('/periods', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<AttendancePeriod>(
    `SELECT p.*,
       (SELECT COUNT(DISTINCT employee_id) FROM attendance_records WHERE period_id = p.id) AS employee_count
     FROM attendance_periods p
     ORDER BY p.start_date DESC, p.id DESC`
  );
  res.json(rows);
});

// GET /api/hr/periods/:id — header + roster (employee + days_logged reference count)
router.get('/periods/:id', requirePermission('hr.view'), (req, res) => {
  const id = Number(req.params.id);
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', id);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  const roster = queryAll(
    `SELECT e.id AS employee_id, e.name, e.position, e.daily_rate, e.default_shift_id, e.rest_days,
       e.department_id, d.name AS department_name, e.status, e.user_id, COALESCE(e.always_whole_day, 0) AS always_whole_day,
       COUNT(*) AS days_total,
       SUM(CASE WHEN ar.time_in IS NOT NULL AND ar.time_in != '' THEN 1 ELSE 0 END) AS days_logged,
       SUM(CASE WHEN
             ((ar.time_in IS NOT NULL AND ar.time_in != '') <> (ar.time_out IS NOT NULL AND ar.time_out != ''))
             AND ar.work_date <= date('now', 'localtime')
           THEN 1 ELSE 0 END) AS days_incomplete
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.period_id = ?
     GROUP BY e.id
     ORDER BY e.name`,
    id
  );
  res.json({ ...period, roster });
});

// GET /api/hr/timekeeping/incomplete — employees with an incomplete day (exactly one of
// time_in/time_out set) in any cutoff ending within the last ~120 days. One row per
// (employee, cutoff); `user_id` present means they have a login account we can message.
// Powers the Home "Incomplete timekeeping" drill-down and Time Keeping's "Notify" action.
router.get('/timekeeping/incomplete', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<{
    employee_id: number; name: string; user_id: number | null;
    period_id: number; period_label: string; work_date: string;
  }>(`
    SELECT e.id AS employee_id, e.name, e.user_id,
           p.id AS period_id, p.label AS period_label, ar.work_date
    FROM attendance_records ar
    JOIN attendance_periods p ON p.id = ar.period_id
    JOIN employees e ON e.id = ar.employee_id
    WHERE p.end_date >= date('now', 'localtime', '-120 day')
      AND ar.work_date <= date('now', 'localtime')
      AND ((ar.time_in IS NOT NULL AND ar.time_in != '') <> (ar.time_out IS NOT NULL AND ar.time_out != ''))
    ORDER BY e.name, p.start_date, ar.work_date`);

  const byKey = new Map<string, {
    employee_id: number; name: string; user_id: number | null;
    period_id: number; period_label: string; dates: string[];
  }>();
  for (const r of rows) {
    const key = `${r.employee_id}:${r.period_id}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        employee_id: r.employee_id, name: r.name, user_id: r.user_id,
        period_id: r.period_id, period_label: r.period_label, dates: [],
      };
      byKey.set(key, entry);
    }
    entry.dates.push(r.work_date);
  }
  res.json([...byKey.values()]);
});

// POST /api/hr/periods
router.post('/periods', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(attendancePeriodSchema, req.body);
  const info = run(
    `INSERT INTO attendance_periods (label, start_date, end_date, created_by) VALUES (?, ?, ?, ?)`,
    input.label, input.start_date, input.end_date, req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/periods/:id — update header; extend roster day-rows to cover a widened range
router.put('/periods/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM attendance_periods WHERE id = ?', id)) {
    res.status(404).json({ error: 'Cutoff not found' }); return;
  }
  const input = parseBody(attendancePeriodSchema, req.body);
  db.exec('BEGIN');
  try {
    run(
      `UPDATE attendance_periods SET label = ?, start_date = ?, end_date = ? WHERE id = ?`,
      input.label, input.start_date, input.end_date, id
    );
    const employeeIds = queryAll<{ employee_id: number }>(
      'SELECT DISTINCT employee_id FROM attendance_records WHERE period_id = ?', id
    );
    for (const { employee_id } of employeeIds) {
      ensureRosterDays(id, employee_id, input.start_date, input.end_date);
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// DELETE /api/hr/periods/:id (cascades attendance_records)
router.delete('/periods/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM attendance_periods WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  res.json({ ok: true });
});

// ─── Roster + daily attendance ──────────────────────────────────────────────

// POST /api/hr/periods/:id/employees — add an employee to the cutoff roster
router.post('/periods/:id/employees', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const periodId = Number(req.params.id);
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', periodId);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  const input = parseBody(addRosterEmployeeSchema, req.body);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', input.employee_id)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  ensureRosterDays(periodId, input.employee_id, period.start_date, period.end_date);
  res.status(201).json({ ok: true });
});

// POST /api/hr/periods/:id/employees/bulk — add many employees at once: either an explicit
// employee_ids list (checkbox multi-select) or a department/status/name filter ("Add All"),
// resolved server-side so it always reflects the true matching set. Idempotent per employee
// (ensureRosterDays uses INSERT OR IGNORE), so re-adding someone already on the roster is a no-op.
router.post('/periods/:id/employees/bulk', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const periodId = Number(req.params.id);
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', periodId);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  const input = parseBody(addRosterEmployeesBulkSchema, req.body);

  let ids: number[];
  if (input.employee_ids && input.employee_ids.length) {
    ids = input.employee_ids;
  } else {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.department_id != null) { where.push('department_id = ?'); params.push(input.department_id); }
    if (input.status) { where.push('status = ?'); params.push(input.status); }
    if (input.q) { where.push('name LIKE ?'); params.push(`%${input.q}%`); }
    ids = queryAll<{ id: number }>(
      `SELECT id FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      ...params
    ).map((r) => r.id);
  }
  const already = new Set(
    queryAll<{ employee_id: number }>('SELECT DISTINCT employee_id FROM attendance_records WHERE period_id = ?', periodId)
      .map((r) => r.employee_id)
  );
  const newlyAdded = ids.filter((id) => !already.has(id)).length;
  for (const id of ids) ensureRosterDays(periodId, id, period.start_date, period.end_date);
  res.status(201).json({ added: newlyAdded, matched: ids.length });
});

// DELETE /api/hr/periods/:id/employees/:employeeId — remove an employee from the roster
router.delete('/periods/:id/employees/:employeeId', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const info = run(
    'DELETE FROM attendance_records WHERE period_id = ? AND employee_id = ?',
    Number(req.params.id), Number(req.params.employeeId)
  );
  if (info.changes === 0) { res.status(404).json({ error: 'Employee is not on this cutoff' }); return; }
  res.json({ ok: true });
});

// GET /api/hr/periods/:id/attendance?employee_id= — daily rows for one employee in one cutoff.
// Each row also gets a `photos` object ({time_in, lunch_out, lunch_in, time_out}, each a photo
// url or null) so the grid can show a camera icon only where the kiosk actually captured one —
// computed in bulk for the whole period (2 queries total), not per row. See slotPunchIdsForDates
// in src/clock.ts and photoIdsForPunches in src/punch-photos.ts.
router.get('/periods/:id/attendance', requirePermission('hr.view'), (req, res) => {
  const periodId = Number(req.params.id);
  const employeeId = Number(req.query.employee_id);
  if (!employeeId) { res.status(400).json({ error: 'employee_id is required' }); return; }
  const rows = queryAll<{ work_date: string }>(
    `SELECT * FROM attendance_records WHERE period_id = ? AND employee_id = ? ORDER BY work_date`,
    periodId, employeeId
  );
  const slotMap = slotPunchIdsForDates(employeeId, rows.map((r) => r.work_date));
  const allPunchIds = [...slotMap.values()].flatMap((v) => Object.values(v)).filter((id): id is number => id != null);
  const photoIds = photoIdsForPunches('attendance', allPunchIds);
  const SLOT_KEY: Record<CorrectionSlot, string> = { in: 'time_in', lunchOut: 'lunch_out', lunchIn: 'lunch_in', out: 'time_out' };
  // rest_day_swap: what an approved, linked Change of Rest Day form makes of this date ('yes' |
  // 'no' | null, with the form's id in rest_day_swap_form_id), so the grid's Rest Day tag
  // matches payroll (see rest-day.ts).
  const swaps = restDaySwapsFor(employeeId);
  res.json(rows.map((r) => {
    const slots = slotMap.get(r.work_date);
    const photos: Record<string, string | null> = { time_in: null, lunch_out: null, lunch_in: null, time_out: null };
    if (slots) {
      for (const [slot, punchId] of Object.entries(slots) as [CorrectionSlot, number | null][]) {
        const photoId = punchId != null ? photoIds.get(punchId) : undefined;
        if (photoId != null) photos[SLOT_KEY[slot]] = `/hr/clock/photo/${photoId}`;
      }
    }
    const swap = swaps.get(r.work_date);
    return { ...r, photos, rest_day_swap: swap?.rest_day ?? null, rest_day_swap_form_id: swap?.form_id ?? null };
  }));
});

// GET /api/hr/periods/:id/attendance/export — the whole cutoff's daily roster as CSV, every
// employee, one row per work_date (item 1: "download a CSV of the whole timekeeping for that
// certain payroll period" — the per-employee GET above only ever covers one employee at a time).
router.get('/periods/:id/attendance/export', requirePermission('hr.view'), (req, res) => {
  const periodId = Number(req.params.id);
  const period = queryOne<{ label: string }>('SELECT label FROM attendance_periods WHERE id = ?', periodId);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  const rows = queryAll<{
    employee_no: string | null; name: string; department: string | null; work_date: string;
    shift_name: string | null; time_in: string | null; lunch_out: string | null;
    lunch_in: string | null; time_out: string | null;
    form_name: string | null; notes: string | null;
  }>(
    `SELECT e.employee_no, e.name, d.name AS department, ar.work_date,
            s.name AS shift_name, ar.time_in, ar.lunch_out, ar.lunch_in, ar.time_out, ar.notes,
            (SELECT group_concat(fd2.name, ' + ')
               FROM json_each(COALESCE(ar.form_record_ids, json_array(ar.form_record_id))) je
               JOIN form_records fr2 ON fr2.id = je.value
               JOIN form_definitions fd2 ON fd2.id = fr2.form_def_id) AS form_name
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN shifts s ON s.id = ar.shift_id
     WHERE ar.period_id = ?
     ORDER BY e.name, ar.work_date`,
    periodId
  );
  const csvRows = rows.map((r) => ({
    'Employee No.': r.employee_no || '',
    'Employee Name': r.name,
    Department: r.department || '',
    Date: r.work_date,
    Shift: r.shift_name || '',
    'Time In': r.time_in || '',
    'Lunch Out': r.lunch_out || '',
    'Lunch In': r.lunch_in || '',
    'Time Out': r.time_out || '',
    Status: r.time_in && r.time_out ? 'Complete' : (r.time_in || r.time_out) ? 'Incomplete' : 'Blank',
    'Linked Form': r.form_name || '',
    Notes: r.notes || '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="timekeeping-${period.label.replace(/[^a-z0-9]+/gi, '-')}.csv"`);
  res.send(toCsv(
    ['Employee No.', 'Employee Name', 'Department', 'Date', 'Shift', 'Time In', 'Lunch Out', 'Lunch In', 'Time Out', 'Status', 'Linked Form', 'Notes'],
    csvRows
  ));
});

// GET /api/hr/daily-report?date=YYYY-MM-DD — a live, whole-company snapshot for one calendar
// date (default today): who's present / late / absent / on leave, with a per-department
// breakdown. Scoped to the roster of the cutoff period(s) covering that date — an active
// employee who isn't on that cutoff isn't expected to work it, so they're left off the board
// rather than read as absent. If no cutoff covers the date the board is empty (HR is expected
// to always have a cutoff made). Today's
// time_in falls back to a raw, not-yet-reconciled time_punches row when nothing's been typed or
// imported into attendance_records yet (see src/hr-daily-report.ts for why this can't just
// reuse computeAttendanceForEmployee).
router.get('/daily-report', requirePermission('hr.view'), (req, res) => {
  const requested = typeof req.query.date === 'string' ? req.query.date : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateStr();
  const isToday = date === localDateStr();
  const nowStr = isToday ? localTimeStr() : null;

  const policy = currentPolicy();
  const noWorkFor = buildNoWorkResolver();
  const holidayFor = buildHolidayResolver();

  const periods = queryAll<{ id: number; label: string; start_date: string; end_date: string }>(
    `SELECT id, label, start_date, end_date FROM attendance_periods
     WHERE start_date <= ? AND end_date >= ? ORDER BY start_date DESC, id DESC`,
    date, date
  );
  const periodIds = periods.map((p) => p.id);
  // No cutoff covering the date -> nobody is expected to work it; HR always makes one.
  const rosterFilter = periodIds.length
    ? `AND e.id IN (SELECT employee_id FROM attendance_records WHERE period_id IN (${periodIds.map(() => '?').join(',')}))`
    : 'AND 0';

  const employees = queryAll<{
    id: number; name: string; employee_no: string | null; department_id: number | null;
    department_name: string | null; rest_days: string | null;
    shift_start: string | null; shift_end: string | null;
  }>(
    `SELECT e.id, e.name, e.employee_no, e.department_id, d.name AS department_name, e.rest_days,
            s.start_time AS shift_start, s.end_time AS shift_end
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN shifts s ON s.id = e.default_shift_id
     WHERE e.status IN ('probationary', 'regular') ${rosterFilter}
     ORDER BY d.name IS NULL, d.name, e.name`,
    ...periodIds
  );

  const employeeRows = employees.map((emp) => {
    const ar = queryOne<{
      time_in: string | null; time_out: string | null; form_record_id: number | null;
      form_record_ids: string | null; holiday_type: string | null; rest_day: string | null;
      shift_start: string | null; shift_end: string | null;
    }>(
      `SELECT ar.time_in, ar.time_out, ar.form_record_id, ar.form_record_ids, ar.holiday_type, ar.rest_day,
              s.start_time AS shift_start, s.end_time AS shift_end
       FROM attendance_records ar
       LEFT JOIN shifts s ON s.id = ar.shift_id
       WHERE ar.employee_id = ? AND ar.work_date = ?
       ORDER BY ar.id DESC LIMIT 1`,
      emp.id, date
    );

    // Prefer whatever's already recorded/imported; fall back to a raw kiosk/phone punch for a
    // day nobody has reconciled yet — read-only here, never written back (that's still what
    // "Import Punches" on the cutoff detail screen is for).
    let timeIn = ar?.time_in || null;
    let timeOut = ar?.time_out || null;
    if (!timeIn) {
      const punches = queryAll<{ ts: string; kind: string }>(
        'SELECT ts, kind FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
        emp.id, date
      );
      if (punches.length) {
        const firstIn = punches.find((p) => p.kind === 'in');
        if (firstIn) timeIn = firstIn.ts.slice(11, 16);
        const lastOut = [...punches].reverse().find((p) => p.kind === 'out');
        if (!timeOut && lastOut) timeOut = lastOut.ts.slice(11, 16);
      }
    }

    const shift = ar?.shift_start ? { start_time: ar.shift_start, end_time: ar.shift_end || ar.shift_start }
      : emp.shift_start ? { start_time: emp.shift_start, end_time: emp.shift_end || emp.shift_start }
      : null;

    const linkedIds = ar
      ? (safeParseIdArray(ar.form_record_ids).length ? safeParseIdArray(ar.form_record_ids)
        : ar.form_record_id ? [ar.form_record_id] : [])
      : [];
    const linkedSlugs = linkedIds.length
      ? queryAll<{ slug: string }>(
          `SELECT fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
           WHERE fr.id IN (${linkedIds.map(() => '?').join(',')})`,
          ...linkedIds
        ).map((f) => f.slug)
      : [];
    const onLeave = linkedSlugs.includes('leave_request');
    const reported = linkedSlugs.includes('reported_absence');

    const restDays: number[] = emp.rest_days ? JSON.parse(emp.rest_days) : policy.default_rest_days;
    const isRestDay = resolveRestDay(ar?.rest_day, restDaySwapsFor(emp.id).get(date), restDays.includes(weekdayOf(date)));
    const holiday = (ar?.holiday_type && ar.holiday_type !== 'none' ? ar.holiday_type : holidayFor(date)) as AttendanceDay['holiday'];
    const noWork = noWorkFor(date);

    const result = classifyDailyStatus({
      time_in: timeIn, time_out: timeOut, shift, on_leave: onLeave, reported, holiday, no_work: noWork,
      is_rest_day: isRestDay, grace_minutes: policy.grace_minutes, now: nowStr,
    });

    return {
      id: emp.id, name: emp.name, employee_no: emp.employee_no,
      department_id: emp.department_id, department_name: emp.department_name || 'Unassigned',
      time_in: timeIn, time_out: timeOut,
      status: result.status, late_minutes: result.late_minutes, note: result.note,
    };
  });

  const blankTallies = () => ({ present: 0, late: 0, absent: 0, leave: 0, reported: 0, not_scheduled: 0, pending: 0, total: 0 });
  const totals = blankTallies();
  const byDept = new Map<string, ReturnType<typeof blankTallies> & { department_id: number | null; department_name: string }>();
  for (const r of employeeRows) {
    totals[r.status]++; totals.total++;
    let d = byDept.get(r.department_name);
    if (!d) { d = { ...blankTallies(), department_id: r.department_id, department_name: r.department_name }; byDept.set(r.department_name, d); }
    d[r.status]++; d.total++;
  }

  res.json({
    date, is_today: isToday, generated_at: new Date().toISOString(),
    periods, // cutoff(s) whose roster scoped this board; [] = none covers the date, board is empty
    totals, by_department: [...byDept.values()], employees: employeeRows,
  });
});

// Employee self-filed request forms — must track src/routes/me.routes.ts's own REQUEST_SLUGS
// (not imported directly: that file already imports currentPolicy from this one, so importing
// its REQUEST_SLUGS back here would make the two modules load each other).
const PENDING_REQUEST_SLUGS = [
  'leave_request', 'overtime_request', 'undertime_request', 'halfday_request', 'offset_form',
  'lunch_offset_form', 'holiday_work_request', 'travel_order', 'coe_request',
  'reimbursement_request', 'loan_application', 'training_request', 'incident_report',
  'information_change', 'rest_day_work_request', 'rest_day_change',
];

// GET /api/hr/pending-requests — org-wide count of pending HR requests (leave, OT, undertime,
// and everything else self-filed from mobile) plus pending attendance/time-correction fixes,
// for the HR Overview page's "needs attention" summary. Deliberately NOT scoped to what the
// caller may personally decide (unlike GET /me/approvals, which only shows a department head
// their own department's queue) — this is a bird's-eye count for anyone with hr.view.
router.get('/pending-requests', requirePermission('hr.view'), (req, res) => {
  const byType = queryAll<{ slug: string; name: string; icon: string; count: number }>(
    `SELECT fd.slug, fd.name, fd.icon, COUNT(fr.id) AS count
     FROM form_definitions fd
     LEFT JOIN form_records fr ON fr.form_def_id = fd.id AND fr.status = 'pending'
     WHERE fd.slug IN (${PENDING_REQUEST_SLUGS.map(() => '?').join(',')})
     GROUP BY fd.id
     HAVING count > 0
     ORDER BY count DESC, fd.name`,
    ...PENDING_REQUEST_SLUGS
  );
  const timeCorrections = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM time_corrections WHERE status = 'pending'"
  )!.n;

  const recentRequests = queryAll<{
    id: number; number: string; created_at: string; slug: string; form_name: string; employee_name: string | null;
  }>(
    `SELECT fr.id, fr.number, fr.created_at, fd.slug, fd.name AS form_name,
            json_extract(fr.data, '$.employee_name') AS employee_name
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fr.status = 'pending' AND fd.slug IN (${PENDING_REQUEST_SLUGS.map(() => '?').join(',')})
     ORDER BY fr.id DESC LIMIT 8`,
    ...PENDING_REQUEST_SLUGS
  );
  const recentCorrections = queryAll<{ id: number; created_at: string; employee_name: string; work_date: string }>(
    `SELECT tc.id, tc.created_at, e.name AS employee_name, tc.work_date
     FROM time_corrections tc JOIN employees e ON e.id = tc.employee_id
     WHERE tc.status = 'pending' ORDER BY tc.id DESC LIMIT 8`
  );

  const recent = [
    ...recentRequests.map((r) => ({
      kind: 'request' as const, id: r.id, slug: r.slug, form_name: r.form_name,
      employee_name: r.employee_name, number: r.number, created_at: r.created_at,
    })),
    ...recentCorrections.map((c) => ({
      kind: 'correction' as const, id: c.id, slug: 'time_correction', form_name: 'Time Correction',
      employee_name: c.employee_name, number: c.work_date, created_at: c.created_at,
    })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 8);

  const total = byType.reduce((sum, t) => sum + t.count, 0) + timeCorrections;
  res.json({ total, by_type: byType, time_corrections: timeCorrections, recent });
});

// GET /api/hr/cutoff-flags?period_id= — which roster employees on the given cutoff (default:
// the CURRENT one — the attendance_periods row covering today, else the most recently created
// one) have a day HR should probably follow up on: an unlinked "possible half day"
// (computeAttendanceForEmployee's own possible_half_day — same heuristic Payroll and the Daily
// Time grid already surface, just rolled up here across the whole cutoff instead of one
// payslip/one employee at a time), an unrecorded OT (worked past shift end with no linked
// overtime_request — same check as the mobile "you have unrecorded OT" nudge, src/routes/
// me.routes.ts's unrecordedOtDays), or an incomplete punch (time-in with no time-out, or vice
// versa, on any day — the same XOR check GET /timekeeping/incomplete already uses, just scoped
// to this one cutoff). Powers the HR Overview page's "Needs Attention" panel, including its
// cutoff switcher (?period_id lets HR check any past/future cutoff, not just the current one);
// nothing here mutates anything.
router.get('/cutoff-flags', requirePermission('hr.view'), (req, res) => {
  const requestedId = Number(req.query.period_id);
  const period = requestedId
    ? queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', requestedId)
    : queryOne<AttendancePeriod>(
        `SELECT * FROM attendance_periods
         WHERE start_date <= date('now', 'localtime') AND end_date >= date('now', 'localtime')
         ORDER BY start_date DESC LIMIT 1`
      ) ?? queryOne<AttendancePeriod>(
        `SELECT * FROM attendance_periods ORDER BY created_at DESC, id DESC LIMIT 1`
      );
  if (!period) {
    res.json({ period: null, employees: [], totals: { half_day: 0, unrecorded_ot: 0, incomplete_punch: 0, employees_flagged: 0 } });
    return;
  }

  // Same "distinct employees on this cutoff's roster" query generate-payslips uses — no status
  // filter, since anyone HR actually logged time for this cutoff is fair game to flag.
  const roster = queryAll<{
    employee_id: number; name: string; employee_no: string | null; department_name: string | null;
    user_id: number | null; daily_rate: number; rest_days: string | null; always_whole_day: number;
  }>(
    `SELECT DISTINCT e.id AS employee_id, e.name, e.employee_no, d.name AS department_name,
            e.user_id, e.daily_rate, e.rest_days, COALESCE(e.always_whole_day, 0) AS always_whole_day
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.period_id = ?
     ORDER BY e.name`,
    period.id
  );

  const policy = currentPolicy();
  const noWorkFor = buildNoWorkResolver();
  const holidayFor = buildHolidayResolver();

  // One batched query for the incomplete-punch flag (XOR of time_in/time_out) across the whole
  // roster, rather than a per-employee lookup — same predicate as GET /timekeeping/incomplete.
  const incompleteRows = queryAll<{ employee_id: number; work_date: string }>(
    `SELECT employee_id, work_date FROM attendance_records
     WHERE period_id = ? AND work_date <= date('now', 'localtime')
       AND ((time_in IS NOT NULL AND time_in != '') <> (time_out IS NOT NULL AND time_out != ''))
     ORDER BY work_date`,
    period.id
  );
  const incompleteByEmployee = new Map<number, string[]>();
  for (const r of incompleteRows) {
    const list = incompleteByEmployee.get(r.employee_id);
    if (list) list.push(r.work_date); else incompleteByEmployee.set(r.employee_id, [r.work_date]);
  }

  const employees = roster
    .map((emp) => {
      const attendanceDays = attendanceDaysForEmployee(period.id, emp.employee_id, emp.rest_days, policy, noWorkFor, holidayFor);
      // The daily rate is irrelevant to possible_half_day (it only affects pay amounts), so a
      // flat placeholder is fine here — this route only ever reads day.possible_half_day.
      const computed = computeAttendanceForEmployee(attendanceDays, emp.daily_rate || 0, policy, false, false, !!emp.always_whole_day);
      const possibleHalfDayDates = computed.days.filter((d) => d.possible_half_day).map((d) => d.work_date);
      const unrecordedOtDates = attendanceDays
        .filter((d) => unrecordedOtMinutes(d, policy) > 0)
        .map((d) => d.work_date);
      const incompletePunchDates = incompleteByEmployee.get(emp.employee_id) ?? [];
      return {
        employee_id: emp.employee_id, name: emp.name, employee_no: emp.employee_no,
        department_name: emp.department_name || 'Unassigned', user_id: emp.user_id,
        possible_half_day_dates: possibleHalfDayDates,
        unrecorded_ot_dates: unrecordedOtDates,
        incomplete_punch_dates: incompletePunchDates,
      };
    })
    .filter((e) => e.possible_half_day_dates.length || e.unrecorded_ot_dates.length || e.incomplete_punch_dates.length);

  res.json({
    period: { id: period.id, label: period.label, start_date: period.start_date, end_date: period.end_date },
    employees,
    totals: {
      half_day: employees.filter((e) => e.possible_half_day_dates.length).length,
      unrecorded_ot: employees.filter((e) => e.unrecorded_ot_dates.length).length,
      incomplete_punch: employees.filter((e) => e.incomplete_punch_dates.length).length,
      employees_flagged: employees.length,
    },
  });
});

// PUT /api/hr/periods/:id/attendance — replace one employee's daily rows for this cutoff
router.put('/periods/:id/attendance', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const periodId = Number(req.params.id);
  if (!queryOne('SELECT id FROM attendance_periods WHERE id = ?', periodId)) {
    res.status(404).json({ error: 'Cutoff not found' }); return;
  }
  const input = parseBody(saveAttendanceSchema, req.body);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', input.employee_id)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM attendance_records WHERE period_id = ? AND employee_id = ?', periodId, input.employee_id);
    const insert = db.prepare(
      `INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, lunch_out, lunch_in, time_out, notes, shift_id, form_record_id, form_record_ids, holiday_type, rest_day, min_hours_decision, half_day_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of input.days) {
      // form_record_ids (the new multi-link) wins when present; otherwise fall back to the
      // legacy single form_record_id so an older client still works. form_record_id is always
      // mirrored to the first id so anything still reading that column stays correct.
      const ids = (d.form_record_ids && d.form_record_ids.length ? d.form_record_ids
        : d.form_record_id ? [d.form_record_id] : []);
      insert.run(
        periodId, input.employee_id, d.work_date, d.time_in || null,
        d.lunch_out || null, d.lunch_in || null, d.time_out || null, d.notes || null,
        d.shift_id || null, ids[0] ?? null, ids.length ? JSON.stringify(ids) : null,
        d.holiday_type || null, d.rest_day || null, d.min_hours_decision || null,
        d.half_day_override || null
      );
    }
    db.exec('COMMIT');
    res.json({ ok: true });
    notifyUnrecordedOt(input.employee_id, input.days);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// Fires a one-time push notification to the linked employee when a just-saved day shows
// unrecorded OT (src/hr-payroll-compute.ts's unrecordedOtMinutes — same check the mobile "you
// have unrecorded OT" prompt/Home reminder use, GET /api/me/unrecorded-ot) — so the employee
// hears about it as soon as HR types the times in, not only if/when they happen to open the
// app. Best-effort: never blocks or fails the attendance save itself.
function notifyUnrecordedOt(
  employeeId: number,
  days: Array<{ work_date: string; time_in?: string | null; time_out?: string | null; shift_id?: number | null; form_record_id?: number | null; form_record_ids?: number[] | null }>
): void {
  try {
    const emp = queryOne<{ user_id: number | null }>('SELECT user_id FROM employees WHERE id = ?', employeeId);
    if (!emp?.user_id) return;
    const policy = currentPolicy();
    const flagged: string[] = [];
    for (const d of days) {
      if (!d.time_in || !d.time_out) continue;
      const shift = d.shift_id
        ? queryOne<{ start_time: string; end_time: string }>('SELECT start_time, end_time FROM shifts WHERE id = ?', d.shift_id)
        : null;
      const ids = d.form_record_ids && d.form_record_ids.length ? d.form_record_ids : d.form_record_id ? [d.form_record_id] : [];
      const linkedForms: NonNullable<AttendanceDay['linkedForms']> = [];
      for (const id of ids) {
        const fr = queryOne<{ data: string; slug: string }>(
          `SELECT fr.data, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
          id
        );
        if (fr) { try { linkedForms.push({ slug: fr.slug, data: JSON.parse(fr.data) }); } catch { /* skip */ } }
      }
      const mins = unrecordedOtMinutes(
        {
          work_date: d.work_date, time_in: d.time_in, time_out: d.time_out,
          shift: shift ? { start_time: shift.start_time, end_time: shift.end_time } : null,
          linkedForms,
        },
        policy
      );
      if (mins > 0) flagged.push(d.work_date);
    }
    if (!flagged.length) return;
    void notifyUser(emp.user_id, {
      title: 'Unrecorded overtime',
      body: flagged.length === 1
        ? `You worked past your shift on ${flagged[0]} with no OT form filed.`
        : `You worked past your shift on ${flagged.length} days with no OT form filed.`,
      url: '#/requests',
      tag: `unrecorded-ot-${employeeId}-${flagged[flagged.length - 1]}`,
    });
  } catch { /* best-effort — never let this break the attendance save */ }
}

// ─── Generate payslips ──────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Company-wide no-work ranges — the seeded "No Work Memo" form plus any other form whose
// definition carries an `apply_no_work` action (Form Builder). Resolved once per request (not
// per employee), since these apply to everyone automatically with no per-day linking required.
// Shared by generate-payslips and the read-only payroll detail route below — both need to agree
// on exactly the same day resolution the real payslip was built from.
function buildNoWorkResolver(): (workDate: string) => 'paid' | 'unpaid' | null {
  const noWorkFormIds = noWorkFormIdsWithAction();
  const noWorkMemos = noWorkFormIds.length
    ? queryAll<FormRecord>(
        `SELECT data FROM form_records WHERE form_def_id IN (${noWorkFormIds.map(() => '?').join(',')})`,
        ...noWorkFormIds)
        .map((r) => { try { return JSON.parse(r.data as string); } catch { return null; } })
        .filter((d): d is { date_from: string; date_to: string; paid: string } => !!d && !!d.date_from && !!d.date_to)
    : [];
  return (workDate: string) => {
    const memo = noWorkMemos.find((m) => workDate >= m.date_from && workDate <= m.date_to);
    if (!memo) return null;
    return memo.paid === 'Yes' ? 'paid' : 'unpaid';
  };
}

// Company Holidays calendar (form slug 'company_holiday') — same "resolved once, applies to
// everyone automatically" shape as No Work Memo above. A per-record attendance_records.
// holiday_type override (checked in attendanceDaysForEmployee below) takes precedence over this.
const HOLIDAY_LABEL_TO_CODE: Record<string, 'regular' | 'special_non_working' | 'special_working'> = {
  'Regular Holiday': 'regular',
  'Special Non-Working Holiday': 'special_non_working',
  'Special Working Holiday': 'special_working',
};
function buildHolidayResolver(): (workDate: string) => 'regular' | 'special_non_working' | 'special_working' | null {
  const holidayForm = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'company_holiday'");
  const holidays = holidayForm
    ? queryAll<FormRecord>('SELECT data FROM form_records WHERE form_def_id = ?', holidayForm.id)
        .map((r) => { try { return JSON.parse(r.data as string); } catch { return null; } })
        .filter((d): d is { date: string; type: string } => !!d && !!d.date && !!d.type)
    : [];
  return (workDate: string) => {
    const h = holidays.find((x) => x.date === workDate);
    return h ? HOLIDAY_LABEL_TO_CODE[h.type] ?? null : null;
  };
}

// PayrollPolicy.holiday_adjacency_requirement support — whether one specific employee
// "satisfies" a single adjacent date (the day immediately before/after a holiday), per the field's
// own doc comment (src/types.ts): present, on paid leave, or not a scheduled workday for them all
// count; only a genuine unexcused absence fails it. Deliberately a fresh, period-independent
// attendance_records lookup (by employee_id + exact work_date, no period_id) rather than an
// in-array days[i-1]/days[i+1] check inside computeAttendanceForEmployee — a holiday landing on
// the first/last day of a cutoff needs the adjacent day from a DIFFERENT period_id (or a
// different employee_rate_history run within the same cutoff), which computeAttendanceForEmployee
// never sees at once. No record at all for the date (e.g. outside any period on file, or the
// employee wasn't yet hired) is treated as satisfied — benefit of the doubt for missing data,
// never guessed as a failure.
function isPresentOrExcused(
  employeeId: number,
  workDate: string,
  empRestDays: number[],
  holidayFor: (workDate: string) => 'regular' | 'special_non_working' | 'special_working' | null
): boolean {
  if (empRestDays.includes(weekdayOf(workDate))) return true; // not a scheduled workday for them
  if (holidayFor(workDate)) return true; // itself a holiday per the company calendar

  const row = queryOne<{
    time_in: string | null; time_out: string | null; holiday_type: string | null;
    form_record_id: number | null; form_record_ids: string | null;
  }>(
    `SELECT time_in, time_out, holiday_type, form_record_id, form_record_ids
     FROM attendance_records WHERE employee_id = ? AND work_date = ?`,
    employeeId, workDate
  );
  if (!row) return true; // no record on file for this date — nothing to fail the check against
  if (row.holiday_type && row.holiday_type !== 'none') return true; // per-record holiday override
  if (row.time_in && row.time_out) return true; // actually clocked in and out

  const ids = safeParseIdArray(row.form_record_ids);
  const linkIds = ids.length ? ids : row.form_record_id ? [row.form_record_id] : [];
  if (linkIds.length) {
    const forms = queryAll<{ data: string; slug: string }>(
      `SELECT fr.data, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
       WHERE fr.id IN (${linkIds.map(() => '?').join(',')})`,
      ...linkIds
    );
    for (const f of forms) {
      if (f.slug !== 'leave_request') continue;
      try {
        if (JSON.parse(f.data || '{}').with_pay === 'Yes') return true;
      } catch { /* unparseable form data — treat as not satisfying via this form */ }
    }
  }
  return false; // a record exists for this date, but nothing on it excuses the absence
}

/** Whether one holiday date satisfies policy.holiday_adjacency_requirement for one employee —
    'none' always passes; 'before'/'after' check that one specific adjacent date; 'both' requires
    both. Only meaningful for a day already resolved as Regular/Special Non-Working Holiday. */
function holidayAdjacencyOk(
  requirement: PayrollPolicy['holiday_adjacency_requirement'],
  employeeId: number,
  workDate: string,
  empRestDays: number[],
  holidayFor: (workDate: string) => 'regular' | 'special_non_working' | 'special_working' | null
): boolean {
  if (requirement === 'none') return true;
  const check = (d: string) => isPresentOrExcused(employeeId, d, empRestDays, holidayFor);
  if (requirement === 'before') return check(addDays(workDate, -1));
  if (requirement === 'after') return check(addDays(workDate, 1));
  return check(addDays(workDate, -1)) && check(addDays(workDate, 1));
}

// Per-employee attendance rows for one cutoff, resolved into the compute engine's own
// AttendanceDay shape — shift_id -> {start_time, end_time}, form_record_id -> {slug, data}, and
// each work_date -> No Work Memo / Company Holiday / rest-day, exactly as
// src/hr-payroll-compute.ts expects its caller to do. Shared by generate-payslips (which builds
// the real payslip) and the read-only payroll detail route (which must show identical days, not
// a second implementation that could disagree with the real payslip).
function attendanceDaysForEmployee(
  periodId: number,
  employeeId: number,
  employeeRestDaysJson: string | null,
  policy: PayrollPolicy,
  noWorkFor: (workDate: string) => 'paid' | 'unpaid' | null,
  holidayFor: (workDate: string) => 'regular' | 'special_non_working' | 'special_working' | null
): AttendanceDay[] {
  const attendanceRows = queryAll<{
    work_date: string; time_in: string | null; time_out: string | null;
    lunch_out: string | null; lunch_in: string | null;
    shift_start: string | null; shift_end: string | null;
    form_record_id: number | null; form_record_ids: string | null; holiday_type: string | null;
    rest_day: string | null; min_hours_decision: string | null; half_day_override: string | null;
  }>(
    `SELECT ar.work_date, ar.time_in, ar.time_out, ar.lunch_out, ar.lunch_in,
       s.start_time AS shift_start, s.end_time AS shift_end,
       ar.form_record_id, ar.form_record_ids, ar.holiday_type, ar.rest_day, ar.min_hours_decision,
       ar.half_day_override
     FROM attendance_records ar
     LEFT JOIN shifts s ON s.id = ar.shift_id
     WHERE ar.period_id = ? AND ar.employee_id = ?
     ORDER BY ar.work_date`,
    periodId, employeeId
  );
  // Resolve every linked form (form_record_ids, or the legacy single form_record_id for rows
  // that predate the multi-link) to {slug, data} in one batched lookup, keyed by id.
  const allFormIds = [
    ...new Set(
      attendanceRows.flatMap((r) => {
        const ids = safeParseIdArray(r.form_record_ids);
        return ids.length ? ids : r.form_record_id ? [r.form_record_id] : [];
      })
    ),
  ];
  const formById = new Map<number, { slug: string; data: Record<string, unknown> }>();
  if (allFormIds.length) {
    queryAll<{ id: number; data: string; slug: string; status: string }>(
      `SELECT fr.id, fr.data, fd.slug, fr.status FROM form_records fr
       JOIN form_definitions fd ON fd.id = fr.form_def_id
       WHERE fr.id IN (${allFormIds.map(() => '?').join(',')})`,
      ...allFormIds
    ).forEach((f) => {
      // Rest-day forms count only once approved; a pending one linked early changes nothing.
      if (REST_DAY_FORM_SLUGS.includes(f.slug) && f.status !== 'approved') return;
      try { formById.set(f.id, { slug: f.slug, data: JSON.parse(f.data || '{}') }); } catch { /* skip unparseable */ }
    });
  }
  const restDaySwaps = restDaySwapsFor(employeeId);
  // Per-record override (attendance_records.holiday_type / .rest_day) beats the calendar /
  // weekly pattern; holiday 'none' means "not a holiday for this person" even if the calendar
  // says so, and rest_day 'yes'/'no' force a single date on/off regardless of its weekday
  // (a rotating rest day that varies month to month).
  const empRestDays: number[] = employeeRestDaysJson ? JSON.parse(employeeRestDaysJson) : policy.default_rest_days;
  return attendanceRows.map((r) => {
    const ids = safeParseIdArray(r.form_record_ids);
    const linkIds = ids.length ? ids : r.form_record_id ? [r.form_record_id] : [];
    const linkedForms = linkIds.map((id) => formById.get(id)).filter((f): f is { slug: string; data: Record<string, unknown> } => !!f);
    const holiday = r.holiday_type === 'none' ? null : (r.holiday_type as AttendanceDay['holiday']) || holidayFor(r.work_date);
    return {
    work_date: r.work_date,
    time_in: r.time_in,
    time_out: r.time_out,
    lunch_out: r.lunch_out,
    lunch_in: r.lunch_in,
    shift: r.shift_start && r.shift_end ? { start_time: r.shift_start, end_time: r.shift_end } : null,
    linkedForms,
    noWork: noWorkFor(r.work_date),
    holiday,
    isRestDay: resolveRestDay(r.rest_day, restDaySwaps.get(r.work_date), empRestDays.includes(weekdayOf(r.work_date))),
    minHoursDecision: r.min_hours_decision as AttendanceDay['minHoursDecision'],
    // Only Regular/Special Non-Working Holiday pay is ever subject to this — a plain rest day
    // isn't a holiday at all, so it's not gated by holiday_adjacency_requirement.
    holidayEligible: (holiday === 'regular' || holiday === 'special_non_working')
      ? holidayAdjacencyOk(policy.holiday_adjacency_requirement, employeeId, r.work_date, empRestDays, holidayFor)
      : true,
    halfDayOverride: r.half_day_override as AttendanceDay['halfDayOverride'],
    };
  });
}

/** Parse a JSON string that should hold an array of positive integer ids (attendance_records.
    form_record_ids). Anything malformed -> []. */
function safeParseIdArray(json: string | null): number[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch { return []; }
}

// Which of the four statutory deductions actually apply to ONE payslip record — the per-record
// override HR can set from the payroll detail view (in addition to the always-existing
// per-employee deduct_* flags and the cutoff-wide deduction_schedule; all three gate together,
// same AND as before, just with one more layer). Defaults to true for every key so an existing
// payslip's stored data (which predates this feature) or a brand-new generation behaves exactly
// as it always did — nobody's deductions silently turn off just because this shipped.
interface StatutoryApplied { sss: boolean; philhealth: boolean; pagibig: boolean; withholding_tax: boolean }
function appliedFromRecordData(data: Record<string, unknown>): StatutoryApplied {
  return {
    sss: data.sss_applied !== false,
    philhealth: data.philhealth_applied !== false,
    pagibig: data.pagibig_applied !== false,
    withholding_tax: data.withholding_tax_applied !== false,
  };
}

/** Where this cutoff sits in its contribution month (payroll/statutory-month.ts). */
interface StatutoryMonthContext {
  /** This employee's payslips for the month's earlier cutoffs. */
  earlier: Record<string, unknown>[];
  /** This cutoff is the month's last — the month's actual pay is fully known. */
  monthComplete: boolean;
  /** The deduction-schedule slots after this cutoff's, this month. */
  laterSlots: DeductionSlot[];
}

/** The figures each fund's contribution was computed on — persisted on the payslip (nested,
    like employer_contributions, so the employee views never show it) for audit and for the
    PhilHealth basis on the agency schedule. */
export interface StatutoryBasis {
  /** 'actual' (the law's default) or 'fixed' (employee's written agreement — employees.contribution_basis). */
  basis: 'actual' | 'fixed';
  sss_compensation: number; sss_msc: number; pagibig_compensation: number;
  philhealth_monthly_basic: number; month_complete: boolean;
}

/** SSS/PhilHealth/Pag-IBIG/withholding-tax for one employee, one cutoff — shared by
 *  generate-payslips (auto_statutory branch) and the two payroll-detail deduction routes below,
 *  so a manual per-record toggle recomputes with the exact same rate-table math the real payslip
 *  was generated from, never a second implementation that could disagree. `applied` is the AND
 *  of the per-employee deduct_* flags (Accounting -> Statutory Deductions), this cutoff's slot in
 *  the deduction schedule, AND this one payslip's own override — any of the three being off
 *  zeroes that deduction.
 *
 *  Bases follow each fund's own law (ph-statutory.ts "Contribution bases"): SSS on the month's
 *  actual remuneration, Pag-IBIG on the month's actual basic pay — both summed over the month's
 *  cutoffs, each cutoff deducting what the month-to-date total owes less what earlier cutoffs
 *  already took, so the month's last deducting cutoff trues it up — and PhilHealth on the fixed
 *  monthly basic salary (DOLE equivalent monthly rate for daily-paid), split across slots.
 *
 *  An employee on the FIXED contribution basis (employees.contribution_basis = 'fixed', set in
 *  Accounting → Statutory Deductions once they've agreed in writing) has SSS / Pag-IBIG computed
 *  on their fixed monthly rate instead — monthly_rate, or daily_rate × the policy's monthly rate
 *  divisor — split evenly across the fund's scheduled cutoffs, whatever the month's attendance. */
function computeEmployeeStatutory(
  emp: {
    daily_rate: number; rate_type: 'daily' | 'monthly'; monthly_rate: number | null; rest_days: string | null;
    contribution_basis: string | null;
    deduct_sss: number; deduct_philhealth: number; deduct_pagibig: number; deduct_withholding_tax: number;
    withholding_tax_override: number | null;
    sss_override: number | null; philhealth_override: number | null; pagibig_override: number | null;
  },
  thisSlip: PayslipEarnings,
  month: StatutoryMonthContext,
  applied: StatutoryApplied,
  policy: PayrollPolicy,
  statTables: ReturnType<typeof effectiveTables>,
  thisSlot: DeductionSlot,
  slotDivisor: (key: keyof DeductionSlot) => number
): { sss: number; philhealth: number; pagibig: number; withholding_tax: number; statutory_basis: StatutoryBasis;
     employer_contributions: { sss_er: number; sss_ec: number; philhealth_er: number; pagibig_er: number } } {
  const restDays = (() => {
    try { return emp.rest_days ? JSON.parse(emp.rest_days) as unknown : policy.default_rest_days; }
    catch { return policy.default_rest_days; }
  })();
  const monthlyBasic = philHealthMonthlyBasic(emp, Array.isArray(restDays) ? restDays.length : 0);
  const sumEarlier = (f: (s: Record<string, unknown>) => number): number =>
    round2(month.earlier.reduce((t, s) => t + f(s), 0));
  const earlierEr = (key: string): number => sumEarlier(
    (s) => Number((s.employer_contributions as Record<string, unknown> | undefined)?.[key]) || 0
  );
  const fixedBasis = emp.contribution_basis === 'fixed';
  const fixedMonthly = emp.rate_type === 'monthly' && emp.monthly_rate
    ? round2(emp.monthly_rate)
    : round2(emp.daily_rate * policy.monthly_rate_divisor);
  const basis = (key: 'sss' | 'pagibig', perCutoff: (s: PayslipEarnings) => number): number => fixedBasis
    ? fixedMonthly
    : contributionBasis(
      round2(sumEarlier(perCutoff) + perCutoff(thisSlip)),
      { monthComplete: month.monthComplete, laterCutoffDeducts: month.laterSlots.some((s) => s[key]), fullMonthEstimate: monthlyBasic }
    );
  // This cutoff's part of a monthly SSS / Pag-IBIG amount: fixed basis splits it evenly across
  // the fund's scheduled cutoffs; actual basis takes what the month-to-date total still owes.
  const portion = (key: 'sss' | 'pagibig', monthly: number, earlierTook: number): number => fixedBasis
    ? round2(monthly / slotDivisor(key))
    : monthRemainder(monthly, earlierTook);
  const sssComp = basis('sss', sssCompensation);
  const pagibigComp = basis('pagibig', pagIbigCompensation);
  const sssDue = sssContribution(sssComp, statTables.sss);
  const pagibigDue = pagIbigContribution(pagibigComp, statTables.pagibig);
  const philhealthDue = philHealthContribution(monthlyBasic, statTables.philhealth);
  const sssOn = !!emp.deduct_sss && thisSlot.sss && applied.sss;
  const philhealthOn = !!emp.deduct_philhealth && thisSlot.philhealth && applied.philhealth;
  const pagibigOn = !!emp.deduct_pagibig && thisSlot.pagibig && applied.pagibig;
  // A per-employee override stands in for the computed MONTHLY contribution, split evenly
  // across this month's deduction slots — e.g. a semi-monthly schedule still halves an
  // overridden SSS amount across both cutoffs. Never affects the employer-side share below,
  // which stays whatever the table says regardless of any employee-side arrangement.
  const sss = !sssOn ? 0 : emp.sss_override != null
    ? round2(emp.sss_override / slotDivisor('sss'))
    : portion('sss', sssDue.employee, sumEarlier((s) => Number(s.sss) || 0));
  const philhealth = philhealthOn ? round2((emp.philhealth_override ?? philhealthDue.employee) / slotDivisor('philhealth')) : 0;
  const pagibig = !pagibigOn ? 0 : emp.pagibig_override != null
    ? round2(emp.pagibig_override / slotDivisor('pagibig'))
    : portion('pagibig', pagibigDue.employee, sumEarlier((s) => Number(s.pagibig) || 0));
  const totalEarnings = Number(thisSlip.total_earnings) || 0;
  // Withholding tax's own taxable base depends on whichever of SSS/PhilHealth/Pag-IBIG actually
  // deducted this run — turning one of those off (or on) for this payslip changes the tax too,
  // not just that one line, which is exactly why this can't be a client-side-only toggle.
  const taxable = taxableCompensation(totalEarnings, 0, round2(sss + philhealth + pagibig));
  // A per-employee override replaces the computed BIR amount outright (not divided across
  // slots the way SSS/PhilHealth/Pag-IBIG's monthly totals are — withholdingTax() itself
  // already accounts for pay_frequency, and the override is meant to stand in for exactly
  // that per-cutoff figure). Still fully gated by the same exempt/schedule/applied checks —
  // an exempt employee is never charged this regardless of any override amount on file.
  const withholding_tax = !!emp.deduct_withholding_tax && thisSlot.withholding_tax && applied.withholding_tax
    ? (emp.withholding_tax_override != null ? emp.withholding_tax_override : withholdingTax(taxable, policy.pay_frequency, statTables.rwt))
    : 0;
  return {
    sss, philhealth, pagibig, withholding_tax,
    statutory_basis: {
      basis: fixedBasis ? 'fixed' : 'actual',
      sss_compensation: sssComp, sss_msc: sssDue.msc, pagibig_compensation: pagibigComp,
      philhealth_monthly_basic: monthlyBasic, month_complete: month.monthComplete,
    },
    employer_contributions: {
      sss_er: sssOn ? portion('sss', sssDue.employer, earlierEr('sss_er')) : 0,
      sss_ec: sssOn ? portion('sss', sssDue.ec, earlierEr('sss_ec')) : 0,
      philhealth_er: philhealthOn ? round2(philhealthDue.employer / slotDivisor('philhealth')) : 0,
      pagibig_er: pagibigOn ? portion('pagibig', pagibigDue.employer, earlierEr('pagibig_er')) : 0,
    },
  };
}

// POST /api/hr/periods/:id/generate-payslips
router.post('/periods/:id/generate-payslips', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const periodId = Number(req.params.id);
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', periodId);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  const input = parseBody(generatePayslipsSchema, req.body);
  const payrollPeriod = input.payroll_period || period.label;

  const form = queryOne<FormDefinition>("SELECT * FROM form_definitions WHERE slug = 'hr_payroll'");
  if (!form) { res.status(400).json({ error: 'HR Payroll form is missing — check Admin > Form Builder' }); return; }

  const roster = queryAll<{
    employee_id: number; name: string; position: string | null; daily_rate: number;
    rate_type: 'daily' | 'monthly'; monthly_rate: number | null; department_name: string | null;
    deduct_sss: number; deduct_philhealth: number; deduct_pagibig: number; deduct_withholding_tax: number;
    withholding_tax_override: number | null; sss_override: number | null; philhealth_override: number | null;
    pagibig_override: number | null; rest_days: string | null; late_exempt: number; ot_exempt: number;
    always_whole_day: number; contribution_basis: string | null;
  }>(
    `SELECT DISTINCT e.id AS employee_id, e.name, e.position, e.daily_rate,
            e.rate_type, e.monthly_rate, d.name AS department_name,
            COALESCE(e.deduct_sss, 1) AS deduct_sss,
            COALESCE(e.deduct_philhealth, 1) AS deduct_philhealth,
            COALESCE(e.deduct_pagibig, 1) AS deduct_pagibig,
            COALESCE(e.deduct_withholding_tax, 1) AS deduct_withholding_tax,
            e.withholding_tax_override, e.sss_override, e.philhealth_override, e.pagibig_override,
            e.rest_days, COALESCE(e.late_exempt, 0) AS late_exempt, COALESCE(e.ot_exempt, 0) AS ot_exempt,
            COALESCE(e.always_whole_day, 0) AS always_whole_day, e.contribution_basis
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.period_id = ?`,
    periodId
  );
  if (!roster.length) { res.status(400).json({ error: 'This cutoff has no employees yet' }); return; }

  const policy = currentPolicy();
  const noWorkFor = buildNoWorkResolver();
  const holidayFor = buildHolidayResolver();

  // Statutory rate tables in force for this run (by pay date, else the cutoff end).
  const statTables = effectiveTables(input.pay_date || period.end_date);
  const periodsPerMonth = PERIODS_PER_MONTH[policy.pay_frequency];

  // Per-cutoff statutory deduction schedule: which of SSS/PhilHealth/Pag-IBIG/withholding
  // tax this specific cutoff (period) deducts, and — for the three that are normally a
  // monthly total split across cutoffs — how many of this month's slots share that split.
  // Same schedule and slot count for every employee in this run (it's period-wide, not
  // per-employee), so resolved once here rather than inside the per-employee loop below.
  const schedule = effectiveSchedule(policy, periodsPerMonth);
  const thisSlot = schedule[slotIndexFor(period, policy.pay_frequency)] ?? ALL_ON;
  const slotDivisor = (key: keyof DeductionSlot): number => Math.max(1, schedule.filter((s) => s[key]).length);

  let created = 0;
  let updated = 0;
  let skippedLocked = 0;
  // Employees with at least one day this run that LOOKS like an unlinked half day (see
  // computeAttendanceForEmployee's possible_half_day) — an active nudge in the generate-payslips
  // response, not just something HR happens to notice if they open a specific payslip's detail
  // view or the Daily Time grid for that one employee.
  let possibleHalfDayEmployees = 0;
  // Matches an employee's existing payslip for this cutoff by stamped employee_id or by any
  // current/former name, so regenerating after a rename updates it instead of duplicating it.
  const owner = payslipOwnerResolver();
  const periodSlips = queryAll<FormRecord>(
    `SELECT * FROM form_records WHERE form_def_id = ? AND period = ?`,
    form.id, payrollPeriod
  );
  // SSS / Pag-IBIG accrue over the contribution month (payroll/statutory-month.ts): each
  // employee's earlier payslips this month, whether this cutoff closes the month, and which
  // later cutoffs of the month still deduct each fund.
  const earlierInMonth = earlierPayslipsInMonth(period, owner);
  const monthComplete = isLastCutoffOfMonth(period, policy.pay_frequency);
  const laterSlots = schedule.slice(slotIndexFor(period, policy.pay_frequency) + 1);
  db.exec('BEGIN');
  try {
    for (const emp of roster) {
      const existing = periodSlips.find((r) => {
        try { return owner.idOf(JSON.parse(r.data as string)) === emp.employee_id; }
        catch { return false; }
      });
      // A payslip marked Paid is locked — skip it entirely (don't even read its attendance)
      // rather than silently overwriting numbers on something already paid out. Unmark it
      // first (POST /hr/payroll/:recordId/unmark-paid) to let it be regenerated again.
      if (existing && existing.status === 'paid') { skippedLocked++; continue; }

      const deptPosition = [emp.department_name, emp.position].filter(Boolean).join(' / ');
      const zeros = {
        days_worked: 0, days_absent: 0, days_half: 0, days_undertime: 0,
        ot_hours: 0, ot_rate_hour: 0, basic_salary: 0, overtime_pay: 0,
        undertime_pay: 0, undertime_day_pay: 0, night_diff_pay: 0,
        holiday_pay: 0, special_holiday_30: 0, rest_day_ot: 0, total_earnings: 0,
        sss: 0, philhealth: 0, pagibig: 0, cash_advance: 0, other_deductions: [] as Array<{ label: string; amount: number }>,
        other_deductions_total: 0, late_absences: 0, total_deductions: 0, net_pay: 0,
      };

      // Attendance + whatever OT/Half Day/Leave/Undertime/Offset form (and its resolved shift)
      // is linked to each day — the compute engine itself never touches the DB, this is exactly
      // the resolution step src/hr-payroll-compute.ts expects its caller to do.
      const attendanceDays = attendanceDaysForEmployee(
        periodId, emp.employee_id, emp.rest_days, policy, noWorkFor, holidayFor
      );
      // Resolves each day's own rate from employee_rate_history — a flat emp.daily_rate for
      // every employee who's never had a logged rate change, exactly as before this existed.
      const { computed, basicSalary } = computeAttendanceMultiRate(
        attendanceDays, (workDate) => effectiveDailyRateOn(emp.employee_id, workDate, emp.daily_rate),
        policy, !!emp.late_exempt, !!emp.ot_exempt, !!emp.always_whole_day
      );
      if (computed.days.some((d) => d.possible_half_day)) possibleHalfDayEmployees++;
      // The rate as of the cutoff's last day — what the "Daily Rate" line and the informational
      // OT-rate-per-hour figure below show, even though pay above was computed per-day.
      const currentDailyRate = effectiveDailyRateOn(emp.employee_id, period.end_date, emp.daily_rate);

      // Regenerating recomputes every attendance-derived field fresh — that's the point of
      // "generate payslips" (pick up the latest attendance/link edits) — but purely-manual
      // fields with no computed source (statutory deductions, cash advance, and the final net
      // pay) are carried over from a previous generation rather than reset to zero, same as the
      // un-computed fields always did before this feature. Rest Day OT and OT Rate/Hour USED to
      // be in this bucket (hand-typed every time) — both are now auto-computed (Rest Day OT from
      // attendance holiday/rest-day marking, OT Rate/Hour as hourly rate x the policy's OT% —
      // see below), so a value someone typed in before this feature will be overwritten on next
      // regenerate.
      const prev = existing ? (() => { try { return JSON.parse(existing.data as string) as Record<string, unknown>; } catch { return {}; } })() : {};
      const num = (v: unknown): number => Number(v) || 0;
      // Purely-manual fields with no computed source are carried over rather than reset.
      const prevManual = {
        cash_advance: prev.cash_advance,
        // Ad-hoc per-cutoff deduction lines (Cash Advance, uniform, misc, …) — see
        // payrollDeductionTogglesSchema/other_deductions. No computed source, same "manual edit
        // survives a regenerate" treatment as cash_advance itself.
        other_deductions: Array.isArray(prev.other_deductions) ? prev.other_deductions : [],
        pay_date: prev.pay_date,
      };
      const otherDeductionsTotal = round2(
        ((prevManual.other_deductions as Array<{ amount: unknown }>) || []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0)
      );
      // The base (ordinary-day) OT rate per hour — informational, same "one flat number" the
      // Daily Rate line already is; the actual overtime_pay above still scales per-day by
      // holiday/rest-day (see dayRateMultiplier in hr-payroll-compute.ts), this is just what
      // an ordinary day's OT hour is worth at a glance.
      const otRateHour = round2((currentDailyRate / 8) * (policy.ot_rate_percent / 100));

      const cashAdvance = num(prevManual.cash_advance);
      const totalEarnings = round2(
        basicSalary + computed.overtime_pay + computed.undertime_pay + computed.undertime_day_pay
        + computed.night_diff_pay + computed.holiday_pay + computed.special_holiday_30 + computed.rest_day_ot
      );

      // SSS / PhilHealth / Pag-IBIG + BIR withholding. When policy.auto_statutory is off,
      // keep whatever a previous generation / manual edit left (old behaviour). Each
      // contribution is also gated by a per-employee flag set from Accounting → Statutory
      // Deductions (default on), this cutoff's slot in the deduction schedule, AND this one
      // payslip's own per-record override (the payroll detail view's deduction toggles below) —
      // the override is carried over from the previous generation (prevApplied), same "manual
      // edit survives a regenerate" treatment as cash_advance/pay_date, so re-running Generate
      // Payslips for the whole cutoff never silently undoes what HR chose for one payslip.
      let sss = num(prev.sss), philhealth = num(prev.philhealth), pagibig = num(prev.pagibig);
      let withholding_tax = num(prev.withholding_tax);
      const prevApplied = appliedFromRecordData(prev);
      // Employer-side shares (for the GL payroll posting — src/accounting-autopost.ts's
      // maybeAutoPostPayroll) are persisted here at generate time, not recomputed later, so a
      // later rate-table/flag change can't silently drift the two apart. Nested under one key
      // (not flat) so it stays invisible to the employee's own mobile payslip view, the CSV
      // export, and the print slip — all of which only read a fixed set of top-level fields.
      let employerContributions = (prev.employer_contributions ?? { sss_er: 0, sss_ec: 0, philhealth_er: 0, pagibig_er: 0 }) as
        { sss_er: number; sss_ec: number; philhealth_er: number; pagibig_er: number };
      let statutoryBasis = prev.statutory_basis as StatutoryBasis | undefined;
      if (policy.auto_statutory) {
        const statutory = computeEmployeeStatutory(emp, {
          total_earnings: totalEarnings, late_absences: round2(computed.late_deduction),
          overtime_pay: round2(computed.overtime_pay), night_diff_pay: round2(computed.night_diff_pay),
          special_holiday_30: round2(computed.special_holiday_30), rest_day_ot: round2(computed.rest_day_ot),
        }, { earlier: earlierInMonth.get(emp.employee_id) ?? [], monthComplete, laterSlots },
        prevApplied, policy, statTables, thisSlot, slotDivisor);
        sss = statutory.sss; philhealth = statutory.philhealth; pagibig = statutory.pagibig;
        withholding_tax = statutory.withholding_tax;
        employerContributions = statutory.employer_contributions;
        statutoryBasis = statutory.statutory_basis;
      }

      const totalDeductions = policy.auto_statutory
        ? round2(sss + philhealth + pagibig + withholding_tax + computed.late_deduction + cashAdvance + otherDeductionsTotal)
        : num(prev.total_deductions);
      const netPay = policy.auto_statutory ? round2(totalEarnings - totalDeductions) : num(prev.net_pay);

      const data = {
        ...zeros,
        ...prevManual,
        employee_name: emp.name, employee_id: emp.employee_id, dept_position: deptPosition,
        payroll_period: payrollPeriod, pay_date: input.pay_date || (prevManual.pay_date as string) || '',
        daily_rate: currentDailyRate,
        days_worked: computed.days_worked,
        // Informational only, doesn't itself subtract anything — an absent day already isn't
        // in days_worked, so it's already excluded from basic_salary below. This just makes
        // that reduction visible on the payslip (see the "Late / Absences" line's own comment
        // in src/hr-payroll-compute.ts — despite the name, it never held an absence figure).
        days_absent: computed.days_absent,
        // Half Days/Undertime Days: already folded into days_worked (0.5 each) / excluded from
        // it (0 credit) respectively — these just surface the counts themselves, same
        // informational purpose as days_absent. See PayrollPolicy.whole_day_min_minutes.
        days_half: computed.days_half,
        days_undertime: computed.days_undertime,
        ot_hours: computed.ot_hours,
        ot_rate_hour: otRateHour,
        overtime_pay: round2(computed.overtime_pay),
        undertime_pay: round2(computed.undertime_pay),
        // Undertime Days' own proportional pay (positive, its own earnings line) — separate
        // from undertime_pay above (a deduction FROM an otherwise-flat whole day).
        undertime_day_pay: round2(computed.undertime_day_pay),
        night_diff_pay: round2(computed.night_diff_pay),
        holiday_pay: round2(computed.holiday_pay),
        special_holiday_30: round2(computed.special_holiday_30),
        rest_day_ot: round2(computed.rest_day_ot),
        late_absences: round2(computed.late_deduction),
        basic_salary: round2(basicSalary),
        total_earnings: totalEarnings,
        sss, philhealth, pagibig, withholding_tax,
        other_deductions: prevManual.other_deductions,
        other_deductions_total: otherDeductionsTotal,
        // Persisted so the payroll detail view's deduction toggles (and this same regenerate
        // path next time) know which of the four were actually selected for this one payslip —
        // see computeEmployeeStatutory/appliedFromRecordData above.
        sss_applied: prevApplied.sss, philhealth_applied: prevApplied.philhealth,
        pagibig_applied: prevApplied.pagibig, withholding_tax_applied: prevApplied.withholding_tax,
        total_deductions: totalDeductions,
        net_pay: netPay,
        employer_contributions: employerContributions,
        statutory_basis: statutoryBasis,
      };

      if (existing) {
        run(`UPDATE form_records SET data = ?, updated_at = datetime('now') WHERE id = ?`,
          JSON.stringify(data), existing.id);
        updated++;
      } else {
        const number = nextSequence(`form_seq_${form.id}`, form.number_prefix);
        run(
          `INSERT INTO form_records (form_def_id, number, data, status, period, created_by)
           VALUES (?, ?, ?, 'draft', ?, ?)`,
          form.id, number, JSON.stringify(data), payrollPeriod, req.user!.id
        );
        created++;
      }
    }
    db.exec('COMMIT');
    res.status(201).json({
      created, updated, skipped_locked: skippedLocked, period: payrollPeriod, form_id: form.id,
      possible_half_day_employees: possibleHalfDayEmployees,
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// POST /api/hr/periods/:id/post-payroll-gl — books this cutoff's generated payslips as one
// aggregate journal entry (Payroll Journal). A deliberate, separate action from
// generate-payslips itself (see src/accounting-autopost.ts's maybeAutoPostPayroll for why) —
// safe to click again after a regenerate, which reverses the prior entry and posts fresh.
router.post('/periods/:id/post-payroll-gl', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  if (!ledgerEnabled()) { res.status(400).json({ error: 'The General Ledger isn’t enabled — turn it on under Accounting → Books first.' }); return; }
  const periodId = Number(req.params.id);
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE id = ?', periodId);
  if (!period) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  // Same payroll_period label generate-payslips used for this cutoff — not re-validated as
  // strictly as generatePayslipsSchema (that one requires it non-empty for a *new* generate);
  // here it's optional and just needs to match whatever records are already sitting there.
  const payrollPeriod = (typeof req.body?.payroll_period === 'string' && req.body.payroll_period.trim()) || period.label;
  const outcome = maybeAutoPostPayroll(periodId, payrollPeriod, req.user!.id);
  if (outcome.error) { res.status(400).json(outcome); return; }
  if (!outcome.posted) { res.status(400).json({ ...outcome, error: outcome.skipped === 'nothing_to_post' ? 'No payslips to post for this period yet — generate payslips first.' : `Not posted (${outcome.skipped}).` }); return; }
  res.status(201).json(outcome);
});

// POST /api/hr/payroll/:recordId/mark-paid — locks a generated payslip: generate-payslips
// will skip it on future regenerates, and the generic /api/form-records PUT/DELETE routes
// refuse to touch it (see form-builder.routes.ts) until it's unmarked.
router.post('/payroll/:recordId/mark-paid', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const rec = queryOne<{ id: number; status: string; slug: string }>(
    `SELECT fr.id, fr.status, fd.slug FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    Number(req.params.recordId)
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
  if (rec.status === 'paid') {
    // Clash-check (D6): marked paid on the cloud too — the same outcome; kept, flagged.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Payslip #${rec.id} was marked paid on the cloud and at the main site.`);
      res.json({ ok: true, clash: true });
      return;
    }
    res.status(400).json({ error: 'Already marked paid' }); return;
  }
  run("UPDATE form_records SET status = 'paid', updated_at = datetime('now') WHERE id = ?", rec.id);
  res.json({ ok: true });
});

// POST /api/hr/payroll/:recordId/unmark-paid — unlocks it again for editing/regeneration.
router.post('/payroll/:recordId/unmark-paid', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const rec = queryOne<{ id: number; status: string; slug: string }>(
    `SELECT fr.id, fr.status, fd.slug FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    Number(req.params.recordId)
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
  if (rec.status !== 'paid') {
    // Clash-check (D6): unmarked on the cloud too — the same outcome; kept, flagged.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Payslip #${rec.id} was unmarked on the cloud and at the main site.`);
      res.json({ ok: true, clash: true });
      return;
    }
    res.status(400).json({ error: 'This payslip is not marked paid' }); return;
  }
  run("UPDATE form_records SET status = 'draft', updated_at = datetime('now') WHERE id = ?", rec.id);
  res.json({ ok: true });
});

// GET /api/hr/payroll/:recordId/detail — read-only per-day breakdown behind one generated
// payslip (late/OT/holiday/rest-day figures, day by day), for the "why does my payslip say X"
// detail view (form-records.js's payslipDetailModal) — NOT the edit form. Resolves the payslip's
// free-text employee_name/period back to a real employees row + attendance_periods row (the only
// link a payroll record has — see attendanceDaysForEmployee above), then reruns the exact same
// resolution + compute engine generate-payslips used, so the per-day numbers can never disagree
// with what's actually on the payslip. 404s with a clear reason if either match fails, rather
// than returning an empty/wrong table.
router.get('/payroll/:recordId/detail', requirePermission('hr.manage'), (req, res) => {
  const rec = queryOne<FormRecord & { slug: string }>(
    `SELECT fr.*, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    Number(req.params.recordId)
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
  const data = JSON.parse(rec.data as string) as Record<string, unknown>;
  const employeeName = String(data.employee_name || '');
  // By stamped employee_id or current/former name — survives renames (payroll/payslip-owner.ts).
  const ownerId = payslipOwnerResolver().idOf(data);
  const emp = ownerId != null ? queryOne<Employee>('SELECT * FROM employees WHERE id = ?', ownerId) : undefined;
  if (!emp) {
    res.status(404).json({ error: `No employee record named "${employeeName}" — it may have been renamed since this payslip was generated.` });
    return;
  }
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE label = ?', rec.period);
  if (!period) {
    res.status(404).json({ error: `No cutoff found for period "${rec.period}" — it may have been renamed or removed since this payslip was generated.` });
    return;
  }
  const policy = currentPolicy();
  const noWorkFor = buildNoWorkResolver();
  const holidayFor = buildHolidayResolver();
  // emp.rest_days is stored as a JSON-text column (see db.ts migration + the parsing convention
  // above in the employee list route) — this raw SELECT * doesn't run that normalization, so at
  // runtime it's still the raw string despite Employee's declared (already-parsed) type.
  const restDaysJson = emp.rest_days as unknown as string | null;
  const attendanceDays = attendanceDaysForEmployee(period.id, emp.id, restDaysJson, policy, noWorkFor, holidayFor);
  const { computed } = computeAttendanceMultiRate(
    attendanceDays, (workDate) => effectiveDailyRateOn(emp.id, workDate, emp.daily_rate),
    policy, !!emp.late_exempt, !!emp.ot_exempt, !!emp.always_whole_day
  );
  res.json({
    employee_name: emp.name,
    period_label: period.label,
    daily_rate: effectiveDailyRateOn(emp.id, period.end_date, emp.daily_rate),
    late_exempt: !!emp.late_exempt,
    always_whole_day: !!emp.always_whole_day,
    days: computed.days,
    totals: {
      days_worked: computed.days_worked,
      days_absent: computed.days_absent,
      days_half: computed.days_half,
      days_undertime: computed.days_undertime,
      late_deduction: computed.late_deduction,
      ot_hours: computed.ot_hours,
      overtime_pay: computed.overtime_pay,
      undertime_pay: computed.undertime_pay,
      undertime_day_pay: computed.undertime_day_pay,
      night_diff_pay: computed.night_diff_pay,
      holiday_pay: computed.holiday_pay,
      special_holiday_30: computed.special_holiday_30,
      rest_day_ot: computed.rest_day_ot,
    },
  });
});

// Shared by preview-deductions and deductions below: resolve a payroll record + its employee
// (with the deduct_* flags, unlike the plain Employee-typed lookup the detail route above uses)
// + its cutoff, or respond with a 404 and return null. Mirrors the detail route's own resolution
// (employee_name / period-label match) so a toggle preview/save can never disagree with what the
// read-only detail view (or the real payslip) would show for the same record.
function resolvePayrollDeductionContext(
  recordId: number, res: Response
): {
  rec: FormRecord & { slug: string }; data: Record<string, unknown>;
  emp: { id: number; daily_rate: number; rate_type: 'daily' | 'monthly'; monthly_rate: number | null;
    deduct_sss: number; deduct_philhealth: number; deduct_pagibig: number; deduct_withholding_tax: number;
    withholding_tax_override: number | null; sss_override: number | null; philhealth_override: number | null;
    pagibig_override: number | null; rest_days: string | null; contribution_basis: string | null };
  period: AttendancePeriod;
} | null {
  const rec = queryOne<FormRecord & { slug: string }>(
    `SELECT fr.*, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    recordId
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return null; }
  const data = JSON.parse(rec.data as string) as Record<string, unknown>;
  const employeeName = String(data.employee_name || '');
  const emp = queryOne<{
    id: number; daily_rate: number; rate_type: 'daily' | 'monthly'; monthly_rate: number | null;
    deduct_sss: number; deduct_philhealth: number; deduct_pagibig: number; deduct_withholding_tax: number;
    withholding_tax_override: number | null; sss_override: number | null; philhealth_override: number | null;
    pagibig_override: number | null; rest_days: string | null; contribution_basis: string | null;
  }>(
    `SELECT id, daily_rate, rate_type, monthly_rate, rest_days, contribution_basis,
            COALESCE(deduct_sss, 1) AS deduct_sss, COALESCE(deduct_philhealth, 1) AS deduct_philhealth,
            COALESCE(deduct_pagibig, 1) AS deduct_pagibig, COALESCE(deduct_withholding_tax, 1) AS deduct_withholding_tax,
            withholding_tax_override, sss_override, philhealth_override, pagibig_override
     FROM employees WHERE id = ?`,
    payslipOwnerResolver().idOf(data) ?? -1
  );
  if (!emp) {
    res.status(404).json({ error: `No employee record named "${employeeName}" — it may have been renamed since this payslip was generated.` });
    return null;
  }
  const period = queryOne<AttendancePeriod>('SELECT * FROM attendance_periods WHERE label = ?', rec.period);
  if (!period) {
    res.status(404).json({ error: `No cutoff found for period "${rec.period}" — it may have been renamed or removed since this payslip was generated.` });
    return null;
  }
  return { rec, data, emp, period };
}

type OtherDeductionLine = { label: string; amount: number };

/** Recompute SSS/PhilHealth/Pag-IBIG/withholding tax + totals for one payslip record under a
 *  given set of applied-deduction toggles and ad-hoc "other deductions" lines (Cash Advance,
 *  uniform, misc, …) — the shared math behind both preview and save. `otherDeductions` omitted
 *  keeps whatever is already stored on the record (not reset to none). */
function recomputeDeductionsFor(
  data: Record<string, unknown>,
  emp: Parameters<typeof computeEmployeeStatutory>[0] & { id: number },
  applied: StatutoryApplied,
  period: AttendancePeriod,
  otherDeductions?: OtherDeductionLine[]
) {
  const policy = currentPolicy();
  const periodsPerMonth = PERIODS_PER_MONTH[policy.pay_frequency];
  const schedule = effectiveSchedule(policy, periodsPerMonth);
  const thisSlot = schedule[slotIndexFor(period, policy.pay_frequency)] ?? ALL_ON;
  const slotDivisor = (key: keyof DeductionSlot): number => Math.max(1, schedule.filter((s) => s[key]).length);
  const statTables = effectiveTables((data.pay_date as string) || period.end_date);
  const totalEarnings = Number(data.total_earnings) || 0;
  const month = {
    earlier: earlierPayslipsInMonth(period).get(emp.id) ?? [],
    monthComplete: isLastCutoffOfMonth(period, policy.pay_frequency),
    laterSlots: schedule.slice(slotIndexFor(period, policy.pay_frequency) + 1),
  };
  const statutory = computeEmployeeStatutory(emp, data, month, applied, policy, statTables, thisSlot, slotDivisor);
  const cashAdvance = Number(data.cash_advance) || 0;
  const lateDeduction = Number(data.late_absences) || 0;
  const lines = otherDeductions ?? ((Array.isArray(data.other_deductions) ? data.other_deductions : []) as OtherDeductionLine[]);
  const otherDeductionsTotal = round2(lines.reduce((sum, d) => sum + (Number(d.amount) || 0), 0));
  const totalDeductions = round2(
    statutory.sss + statutory.philhealth + statutory.pagibig + statutory.withholding_tax
    + lateDeduction + cashAdvance + otherDeductionsTotal
  );
  const netPay = round2(totalEarnings - totalDeductions);
  return { ...statutory, other_deductions: lines, other_deductions_total: otherDeductionsTotal, total_deductions: totalDeductions, net_pay: netPay };
}

// POST /api/hr/payroll/:recordId/preview-deductions — recompute (without saving) what SSS/
// PhilHealth/Pag-IBIG/withholding tax, other-deduction lines, and the resulting totals WOULD be
// for this one payslip under a given set of applied-deduction toggles / other-deduction lines —
// same math generate-payslips and the "save" route below both use, so the live preview in the
// payroll detail view can never disagree with what Save would actually produce. Any key omitted
// from the body keeps that deduction's current applied state (from the stored record), not
// reset to on/empty.
router.post('/payroll/:recordId/preview-deductions', requirePermission('hr.manage'), (req, res) => {
  const ctx = resolvePayrollDeductionContext(Number(req.params.recordId), res);
  if (!ctx) return;
  const input = parseBody(payrollDeductionTogglesSchema, req.body);
  const current = appliedFromRecordData(ctx.data);
  const applied: StatutoryApplied = {
    sss: input.sss_applied ?? current.sss,
    philhealth: input.philhealth_applied ?? current.philhealth,
    pagibig: input.pagibig_applied ?? current.pagibig,
    withholding_tax: input.withholding_tax_applied ?? current.withholding_tax,
  };
  res.json(recomputeDeductionsFor(ctx.data, ctx.emp, applied, ctx.period, input.other_deductions));
});

// PUT /api/hr/payroll/:recordId/deductions — same recompute, persisted into the record. Locked
// the same way the generic form-records PUT is (see form-builder.routes.ts) — a marked-Paid
// payslip can't be touched until unmarked.
router.put('/payroll/:recordId/deductions', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const ctx = resolvePayrollDeductionContext(Number(req.params.recordId), res);
  if (!ctx) return;
  if (ctx.rec.status === 'paid') {
    res.status(400).json({ error: 'This payslip is marked Paid — unmark it first to change its deductions.' });
    return;
  }
  const input = parseBody(payrollDeductionTogglesSchema, req.body);
  const current = appliedFromRecordData(ctx.data);
  const applied: StatutoryApplied = {
    sss: input.sss_applied ?? current.sss,
    philhealth: input.philhealth_applied ?? current.philhealth,
    pagibig: input.pagibig_applied ?? current.pagibig,
    withholding_tax: input.withholding_tax_applied ?? current.withholding_tax,
  };
  const result = recomputeDeductionsFor(ctx.data, ctx.emp, applied, ctx.period, input.other_deductions);
  const newData = {
    ...ctx.data,
    sss: result.sss, philhealth: result.philhealth, pagibig: result.pagibig, withholding_tax: result.withholding_tax,
    sss_applied: applied.sss, philhealth_applied: applied.philhealth,
    pagibig_applied: applied.pagibig, withholding_tax_applied: applied.withholding_tax,
    other_deductions: result.other_deductions, other_deductions_total: result.other_deductions_total,
    total_deductions: result.total_deductions, net_pay: result.net_pay,
    employer_contributions: result.employer_contributions,
    statutory_basis: result.statutory_basis,
  };
  run(`UPDATE form_records SET data = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(newData), ctx.rec.id);
  res.json({ ok: true, ...result });
});

// POST /api/hr/payroll/:recordId/email — emails this payslip to the employee's linked account.
// Employees have no email of their own (that's exactly what the account-linking feature is
// for) — this only works once HR has linked one under Employees, and only if that account has
// an email address set.
router.post('/payroll/:recordId/email', requirePermission('hr.manage'), syncClass('online'), async (req, res, next) => {
  try {
    const rec = queryOne<FormRecord & { slug: string }>(
      `SELECT fr.*, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
      Number(req.params.recordId)
    );
    if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
    const data = JSON.parse(rec.data as string) as Record<string, unknown>;
    const employeeName = String(data.employee_name || '');
    const target = queryOne<{ email: string | null }>(
      `SELECT u.email FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
      payslipOwnerResolver().idOf(data) ?? -1
    );
    if (!target || !target.email) {
      res.status(400).json({
        error: `${employeeName || 'This employee'} has no linked user account with an email address. Link an account under HR → Employees first.`,
      });
      return;
    }
    const tpl = queryOne<{ body: string }>("SELECT body FROM doc_templates WHERE name = 'HR Payroll Slip'");
    const html = renderPayrollSlip(data, tpl?.body || PAYROLL_SLIP_FALLBACK);
    const r = await sendMail(
      { to: target.email, subject: `Payslip — ${data.payroll_period || rec.number}`, html },
      req.user!.id
    );
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    next(e);
  }
});

// Multer-specific error handling (file too large, etc.) for the document upload route.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
