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
import { db, queryOne, queryAll, run, nextSequence, uploadDir, getSetting, setSetting } from '../db';
import { requireAuth, requirePermission } from '../auth';
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
} from '../validation';
import type { Employee, EmployeeDocument, AttendancePeriod, FormDefinition, FormRecord, Shift, PayrollPolicy, EmployeeNumberPolicy } from '../types';
import { computeAttendanceForEmployee, type AttendanceDay } from '../hr-payroll-compute';
import { suggestEmployeeNumber } from '../hr-employee-numbering';
import { toCsv } from '../csv';
import { resolveImport, importLoop } from '../csv-import';
import { listPayrollTables, effectiveTables, upsertPayrollTable, deletePayrollTable } from '../payroll-tables';
import { statutoryDeductions, taxableCompensation, withholdingTax, RWT_2026 } from '../ph-statutory';
import type { PayslipYearRow } from '../ph-2316';
import { computeFinalPay, type FinalPayInput } from '../ph-final-pay';
import { yearPayslipRowsByEmployee, companyProfile } from '../ph-payroll-report-data';
import { enforceQuota } from '../quota';
import { sendMail } from '../mailer';
import { ledgerEnabled, maybeAutoPostPayroll } from '../accounting-autopost';
import { noWorkFormIds as noWorkFormIdsWithAction } from '../form-actions';

// Reuses the browser's own payslip HTML renderer instead of duplicating it server-side —
// hr-payroll-print.js is pure string logic (no DOM/window access) and already resolves its
// own require('./doc-template.js') internally when run under Node, same trick the test suite
// uses to load it. `createRequire` (not `require`, since this file is ESM) needs a base URL
// to resolve the relative path from.
const clientRequire = createRequire(import.meta.url);
const { renderSlip: renderPayrollSlip, FALLBACK_BODY: PAYROLL_SLIP_FALLBACK } =
  clientRequire('../../public/js/hr-payroll-print.js') as {
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
router.put('/employee-number-policy', requirePermission('hr.manage'), (req, res) => {
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
router.post('/employees/import', requirePermission('hr.manage'), (req, res) => {
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
router.post('/payroll-tables', requirePermission('hr.manage'), (req, res) => {
  const input = parseBody(payrollTableSchema, req.body);
  upsertPayrollTable(input.kind, input.effective_from, input.data, input.note ?? null, req.user!.id);
  res.status(201).json({ ok: true });
});

// DELETE /api/hr/payroll-tables/:id
router.delete('/payroll-tables/:id', requirePermission('hr.manage'), (req, res) => {
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
  for (const r of records) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.data); } catch { continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    if (String(payDate).slice(0, 4) !== year) continue;
    const name = String(d.employee_name ?? '').trim();
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
router.post('/employees', requirePermission('hr.manage'), (req, res) => {
  const input = parseBody(employeeSchema, req.body);
  if (queryOne('SELECT id FROM employees WHERE employee_no = ?', input.employee_no)) {
    res.status(409).json({ error: `Employee number "${input.employee_no}" is already in use` }); return;
  }
  const linkErr = checkLinkedUser(input.user_id);
  if (linkErr) { res.status(409).json({ error: linkErr }); return; }
  const info = run(
    `INSERT INTO employees
      (employee_no, name, department_id, position, user_id, daily_rate, rate_type, monthly_rate, status, start_date,
       sss_no, philhealth_no, pagibig_no, tin_no, leave_days_per_year, leave_days_used, rest_days, photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, effectiveDailyRate(input),
    input.rate_type, input.rate_type === 'monthly' ? input.monthly_rate : null,
    input.status, input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.leave_days_per_year, input.leave_days_used,
    input.rest_days ? JSON.stringify(input.rest_days) : null, input.photo ?? null
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/employees/:id
router.put('/employees/:id', requirePermission('hr.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', id)) {
    res.status(404).json({ error: 'Employee not found' }); return;
  }
  const input = parseBody(employeeSchema, req.body);
  const dup = queryOne<{ id: number }>('SELECT id FROM employees WHERE employee_no = ? AND id != ?', input.employee_no, id);
  if (dup) {
    res.status(409).json({ error: `Employee number "${input.employee_no}" is already in use` }); return;
  }
  const linkErr = checkLinkedUser(input.user_id, id);
  if (linkErr) { res.status(409).json({ error: linkErr }); return; }
  run(
    `UPDATE employees SET employee_no = ?, name = ?, department_id = ?, position = ?, user_id = ?, daily_rate = ?, rate_type = ?,
       monthly_rate = ?, status = ?, start_date = ?, sss_no = ?, philhealth_no = ?, pagibig_no = ?, tin_no = ?,
       leave_days_per_year = ?, leave_days_used = ?, rest_days = ?, photo = ?
     WHERE id = ?`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, effectiveDailyRate(input), input.rate_type,
    input.rate_type === 'monthly' ? input.monthly_rate : null, input.status,
    input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.leave_days_per_year, input.leave_days_used,
    input.rest_days ? JSON.stringify(input.rest_days) : null, input.photo ?? null, id
  );
  res.json({ ok: true });
});

// DELETE /api/hr/employees/:id
router.delete('/employees/:id', requirePermission('hr.manage'), (req, res) => {
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
router.post('/employees/:id/documents', requirePermission('hr.manage'), uploadDoc.single('file'), (req, res) => {
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
router.delete('/employees/:id/documents/:docId', requirePermission('hr.manage'), (req, res) => {
  const doc = queryOne<EmployeeDocument>(
    'SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?',
    Number(req.params.docId), Number(req.params.id)
  );
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
  run('DELETE FROM employee_documents WHERE id = ?', doc.id);
  fs.promises.unlink(path.join(uploadDir(), doc.stored_name)).catch(() => {});
  res.json({ ok: true });
});

// ─── Shifts (named, assignable per attendance day — this is how rotating shifts are handled:
// a day just points at whichever shift applied that day, not a fixed per-employee schedule) ────

// GET /api/hr/shifts
router.get('/shifts', requirePermission('hr.view'), (_req, res) => {
  const rows = queryAll<Omit<Shift, 'is_default'> & { is_default: number }>('SELECT * FROM shifts ORDER BY start_time');
  res.json(rows.map((r) => ({ ...r, is_default: !!r.is_default })));
});

// POST /api/hr/shifts
router.post('/shifts', requirePermission('hr.manage'), (req, res) => {
  const input = parseBody(shiftSchema, req.body);
  if (input.is_default) run('UPDATE shifts SET is_default = 0');
  const info = run(
    'INSERT INTO shifts (name, start_time, end_time, is_default) VALUES (?, ?, ?, ?)',
    input.name, input.start_time, input.end_time, input.is_default ? 1 : 0
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/shifts/:id
router.put('/shifts/:id', requirePermission('hr.manage'), (req, res) => {
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
router.delete('/shifts/:id', requirePermission('hr.manage'), (req, res) => {
  const info = run('DELETE FROM shifts WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Shift not found' }); return; }
  res.json({ ok: true });
});

// ─── Payroll policy (company-wide rules — grace period, late/OT rounding, OT %, night diff;
// *when* a shift runs lives in the shifts table above, this is the *rules* for judging it) ──────

const DEFAULT_POLICY: PayrollPolicy = {
  grace_minutes: 10, late_unit: 'hour', ot_unit: 'hour', ot_rate_percent: 125,
  night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true,
  default_rest_days: [0, 6], // Sun, Sat
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

function currentPolicy(): PayrollPolicy {
  return { ...DEFAULT_POLICY, ...(getSetting<Partial<PayrollPolicy>>('payroll_policy') || {}) };
}

// GET /api/hr/payroll-policy
router.get('/payroll-policy', requirePermission('hr.view'), (_req, res) => {
  res.json(currentPolicy());
});

// PUT /api/hr/payroll-policy
router.put('/payroll-policy', requirePermission('hr.manage'), (req, res) => {
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
       e.department_id, d.name AS department_name, e.status, e.user_id,
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
router.post('/periods', requirePermission('hr.manage'), (req, res) => {
  const input = parseBody(attendancePeriodSchema, req.body);
  const info = run(
    `INSERT INTO attendance_periods (label, start_date, end_date, created_by) VALUES (?, ?, ?, ?)`,
    input.label, input.start_date, input.end_date, req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/hr/periods/:id — update header; extend roster day-rows to cover a widened range
router.put('/periods/:id', requirePermission('hr.manage'), (req, res) => {
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
router.delete('/periods/:id', requirePermission('hr.manage'), (req, res) => {
  const info = run('DELETE FROM attendance_periods WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Cutoff not found' }); return; }
  res.json({ ok: true });
});

// ─── Roster + daily attendance ──────────────────────────────────────────────

// POST /api/hr/periods/:id/employees — add an employee to the cutoff roster
router.post('/periods/:id/employees', requirePermission('hr.manage'), (req, res) => {
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
router.post('/periods/:id/employees/bulk', requirePermission('hr.manage'), (req, res) => {
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
router.delete('/periods/:id/employees/:employeeId', requirePermission('hr.manage'), (req, res) => {
  const info = run(
    'DELETE FROM attendance_records WHERE period_id = ? AND employee_id = ?',
    Number(req.params.id), Number(req.params.employeeId)
  );
  if (info.changes === 0) { res.status(404).json({ error: 'Employee is not on this cutoff' }); return; }
  res.json({ ok: true });
});

// GET /api/hr/periods/:id/attendance?employee_id= — daily rows for one employee in one cutoff
router.get('/periods/:id/attendance', requirePermission('hr.view'), (req, res) => {
  const periodId = Number(req.params.id);
  const employeeId = Number(req.query.employee_id);
  if (!employeeId) { res.status(400).json({ error: 'employee_id is required' }); return; }
  const rows = queryAll(
    `SELECT * FROM attendance_records WHERE period_id = ? AND employee_id = ? ORDER BY work_date`,
    periodId, employeeId
  );
  res.json(rows);
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
    shift_name: string | null; time_in: string | null; time_out: string | null;
    form_name: string | null; notes: string | null;
  }>(
    `SELECT e.employee_no, e.name, d.name AS department, ar.work_date,
            s.name AS shift_name, ar.time_in, ar.time_out, fd.name AS form_name, ar.notes
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN shifts s ON s.id = ar.shift_id
     LEFT JOIN form_records fr ON fr.id = ar.form_record_id
     LEFT JOIN form_definitions fd ON fd.id = fr.form_def_id
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
    'Time Out': r.time_out || '',
    Status: r.time_in && r.time_out ? 'Complete' : (r.time_in || r.time_out) ? 'Incomplete' : 'Blank',
    'Linked Form': r.form_name || '',
    Notes: r.notes || '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="timekeeping-${period.label.replace(/[^a-z0-9]+/gi, '-')}.csv"`);
  res.send(toCsv(
    ['Employee No.', 'Employee Name', 'Department', 'Date', 'Shift', 'Time In', 'Time Out', 'Status', 'Linked Form', 'Notes'],
    csvRows
  ));
});

// PUT /api/hr/periods/:id/attendance — replace one employee's daily rows for this cutoff
router.put('/periods/:id/attendance', requirePermission('hr.manage'), (req, res) => {
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
      `INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, notes, shift_id, form_record_id, holiday_type, rest_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of input.days) {
      insert.run(
        periodId, input.employee_id, d.work_date, d.time_in || null, d.time_out || null, d.notes || null,
        d.shift_id || null, d.form_record_id || null, d.holiday_type || null, d.rest_day || null
      );
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ─── Generate payslips ──────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// POST /api/hr/periods/:id/generate-payslips
router.post('/periods/:id/generate-payslips', requirePermission('hr.manage'), (req, res) => {
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
    rest_days: string | null;
  }>(
    `SELECT DISTINCT e.id AS employee_id, e.name, e.position, e.daily_rate,
            e.rate_type, e.monthly_rate, d.name AS department_name,
            COALESCE(e.deduct_sss, 1) AS deduct_sss,
            COALESCE(e.deduct_philhealth, 1) AS deduct_philhealth,
            COALESCE(e.deduct_pagibig, 1) AS deduct_pagibig,
            COALESCE(e.deduct_withholding_tax, 1) AS deduct_withholding_tax,
            e.rest_days
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.period_id = ?`,
    periodId
  );
  if (!roster.length) { res.status(400).json({ error: 'This cutoff has no employees yet' }); return; }

  const policy = currentPolicy();

  // Company-wide no-work ranges — the seeded "No Work Memo" form plus any other form whose
  // definition carries an `apply_no_work` action (Form Builder). Resolved once, not per
  // employee, since these apply to everyone automatically with no per-day linking required.
  const noWorkFormIds = noWorkFormIdsWithAction();
  const noWorkMemos = noWorkFormIds.length
    ? queryAll<FormRecord>(
        `SELECT data FROM form_records WHERE form_def_id IN (${noWorkFormIds.map(() => '?').join(',')})`,
        ...noWorkFormIds)
        .map((r) => { try { return JSON.parse(r.data as string); } catch { return null; } })
        .filter((d): d is { date_from: string; date_to: string; paid: string } => !!d && !!d.date_from && !!d.date_to)
    : [];
  function noWorkFor(workDate: string): 'paid' | 'unpaid' | null {
    const memo = noWorkMemos.find((m) => workDate >= m.date_from && workDate <= m.date_to);
    if (!memo) return null;
    return memo.paid === 'Yes' ? 'paid' : 'unpaid';
  }

  // Company Holidays calendar (form slug 'company_holiday') — same "resolved once, applies to
  // everyone automatically" shape as No Work Memo above. A per-record attendance_records.
  // holiday_type override (checked in the attendanceRows.map below) takes precedence over this.
  const HOLIDAY_LABEL_TO_CODE: Record<string, 'regular' | 'special_non_working' | 'special_working'> = {
    'Regular Holiday': 'regular',
    'Special Non-Working Holiday': 'special_non_working',
    'Special Working Holiday': 'special_working',
  };
  const holidayForm = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'company_holiday'");
  const holidays = holidayForm
    ? queryAll<FormRecord>('SELECT data FROM form_records WHERE form_def_id = ?', holidayForm.id)
        .map((r) => { try { return JSON.parse(r.data as string); } catch { return null; } })
        .filter((d): d is { date: string; type: string } => !!d && !!d.date && !!d.type)
    : [];
  function holidayFor(workDate: string): 'regular' | 'special_non_working' | 'special_working' | null {
    const h = holidays.find((x) => x.date === workDate);
    return h ? HOLIDAY_LABEL_TO_CODE[h.type] ?? null : null;
  }

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
  db.exec('BEGIN');
  try {
    for (const emp of roster) {
      const existing = queryAll<FormRecord>(
        `SELECT * FROM form_records WHERE form_def_id = ? AND period = ?`,
        form.id, payrollPeriod
      ).find((r) => {
        try { return (JSON.parse(r.data as string).employee_name ?? '') === emp.name; }
        catch { return false; }
      });
      // A payslip marked Paid is locked — skip it entirely (don't even read its attendance)
      // rather than silently overwriting numbers on something already paid out. Unmark it
      // first (POST /hr/payroll/:recordId/unmark-paid) to let it be regenerated again.
      if (existing && existing.status === 'paid') { skippedLocked++; continue; }

      const deptPosition = [emp.department_name, emp.position].filter(Boolean).join(' / ');
      const zeros = {
        days_worked: 0, days_absent: 0, ot_hours: 0, ot_rate_hour: 0, basic_salary: 0, overtime_pay: 0,
        undertime_pay: 0, holiday_pay: 0, special_holiday_30: 0, rest_day_ot: 0, total_earnings: 0,
        sss: 0, philhealth: 0, pagibig: 0, cash_advance: 0, late_absences: 0, total_deductions: 0, net_pay: 0,
      };

      // Attendance + whatever OT/Half Day/Leave/Undertime/Offset form (and its resolved shift)
      // is linked to each day — the compute engine itself never touches the DB, this is exactly
      // the resolution step src/hr-payroll-compute.ts expects its caller to do.
      const attendanceRows = queryAll<{
        work_date: string; time_in: string | null; time_out: string | null;
        shift_start: string | null; shift_end: string | null;
        fr_data: string | null; fd_slug: string | null; holiday_type: string | null;
        rest_day: string | null;
      }>(
        `SELECT ar.work_date, ar.time_in, ar.time_out,
           s.start_time AS shift_start, s.end_time AS shift_end,
           fr.data AS fr_data, fd.slug AS fd_slug, ar.holiday_type, ar.rest_day
         FROM attendance_records ar
         LEFT JOIN shifts s ON s.id = ar.shift_id
         LEFT JOIN form_records fr ON fr.id = ar.form_record_id
         LEFT JOIN form_definitions fd ON fd.id = fr.form_def_id
         WHERE ar.period_id = ? AND ar.employee_id = ?
         ORDER BY ar.work_date`,
        periodId, emp.employee_id
      );
      // Per-record override (attendance_records.holiday_type / .rest_day) beats the calendar /
      // weekly pattern; holiday 'none' means "not a holiday for this person" even if the calendar
      // says so, and rest_day 'yes'/'no' force a single date on/off regardless of its weekday
      // (a rotating rest day that varies month to month).
      const empRestDays: number[] = emp.rest_days ? JSON.parse(emp.rest_days) : policy.default_rest_days;
      const attendanceDays: AttendanceDay[] = attendanceRows.map((r) => ({
        work_date: r.work_date,
        time_in: r.time_in,
        time_out: r.time_out,
        shift: r.shift_start && r.shift_end ? { start_time: r.shift_start, end_time: r.shift_end } : null,
        linkedForm: r.fd_slug ? { slug: r.fd_slug, data: JSON.parse(r.fr_data || '{}') } : null,
        noWork: noWorkFor(r.work_date),
        holiday: r.holiday_type === 'none' ? null : (r.holiday_type as AttendanceDay['holiday']) || holidayFor(r.work_date),
        isRestDay: r.rest_day === 'yes' ? true
          : r.rest_day === 'no' ? false
          : empRestDays.includes(weekdayOf(r.work_date)),
      }));
      const computed = computeAttendanceForEmployee(attendanceDays, emp.daily_rate, policy);
      const basicSalary = emp.daily_rate * computed.days_worked;

      // Regenerating recomputes every attendance-derived field fresh — that's the point of
      // "generate payslips" (pick up the latest attendance/link edits) — but purely-manual
      // fields with no computed source (statutory deductions, cash advance, the OT peso rate,
      // and the final net pay) are carried over from a previous generation rather than reset to
      // zero, same as the un-computed fields always did before this feature. Rest Day OT USED to
      // be in this bucket (hand-typed every time) — it's now auto-computed from attendance
      // (holiday/rest-day marking, see hr-payroll-compute.ts), same as overtime_pay already was,
      // so a value someone typed in before this feature will be overwritten on next regenerate.
      const prev = existing ? (() => { try { return JSON.parse(existing.data as string) as Record<string, unknown>; } catch { return {}; } })() : {};
      const num = (v: unknown): number => Number(v) || 0;
      // Purely-manual fields with no computed source are carried over rather than reset.
      const prevManual = {
        cash_advance: prev.cash_advance,
        ot_rate_hour: prev.ot_rate_hour, pay_date: prev.pay_date,
      };

      const cashAdvance = num(prevManual.cash_advance);
      const totalEarnings = round2(
        basicSalary + computed.overtime_pay + computed.undertime_pay
        + computed.holiday_pay + computed.special_holiday_30 + computed.rest_day_ot
      );

      // SSS / PhilHealth / Pag-IBIG + BIR withholding. When policy.auto_statutory is off,
      // keep whatever a previous generation / manual edit left (old behaviour). Each
      // contribution is also gated by a per-employee flag set from Accounting → Statutory
      // Deductions (default on); an off flag zeroes that one deduction.
      let sss = num(prev.sss), philhealth = num(prev.philhealth), pagibig = num(prev.pagibig);
      let withholding_tax = num(prev.withholding_tax);
      // Employer-side shares (for the GL payroll posting — src/accounting-autopost.ts's
      // maybeAutoPostPayroll) are persisted here at generate time, not recomputed later, so a
      // later rate-table/flag change can't silently drift the two apart. Nested under one key
      // (not flat) so it stays invisible to the employee's own mobile payslip view, the CSV
      // export, and the print slip — all of which only read a fixed set of top-level fields.
      let employerContributions = (prev.employer_contributions ?? { sss_er: 0, sss_ec: 0, philhealth_er: 0, pagibig_er: 0 }) as
        { sss_er: number; sss_ec: number; philhealth_er: number; pagibig_er: number };
      if (policy.auto_statutory) {
        const monthlyComp = emp.rate_type === 'monthly' && emp.monthly_rate
          ? emp.monthly_rate
          : round2(emp.daily_rate * policy.monthly_rate_divisor);
        const ded = statutoryDeductions(monthlyComp, monthlyComp, statTables);
        // Gated by BOTH the per-employee "deduct this at all" flag (Accounting -> Statutory
        // Deductions) AND this cutoff's slot in the deduction schedule — a monthly total is
        // split only across however many slots have that key on (1 slot = the full monthly
        // amount lands in that one cutoff), not always periodsPerMonth like before.
        sss = emp.deduct_sss && thisSlot.sss ? round2(ded.sss.employee / slotDivisor('sss')) : 0;
        philhealth = emp.deduct_philhealth && thisSlot.philhealth ? round2(ded.philhealth.employee / slotDivisor('philhealth')) : 0;
        pagibig = emp.deduct_pagibig && thisSlot.pagibig ? round2(ded.pagibig.employee / slotDivisor('pagibig')) : 0;
        const taxable = taxableCompensation(totalEarnings, 0, round2(sss + philhealth + pagibig));
        // Withholding tax was never a monthly total split across cutoffs (withholdingTax()
        // looks up the correct per-period BIR table row directly) — its schedule membership
        // is just on/off for this cutoff, no divisor.
        withholding_tax = emp.deduct_withholding_tax && thisSlot.withholding_tax
          ? withholdingTax(taxable, policy.pay_frequency, statTables.rwt) : 0;
        employerContributions = {
          sss_er: emp.deduct_sss && thisSlot.sss ? round2(ded.sss.employer / slotDivisor('sss')) : 0,
          sss_ec: emp.deduct_sss && thisSlot.sss ? round2(ded.sss.ec / slotDivisor('sss')) : 0,
          philhealth_er: emp.deduct_philhealth && thisSlot.philhealth ? round2(ded.philhealth.employer / slotDivisor('philhealth')) : 0,
          pagibig_er: emp.deduct_pagibig && thisSlot.pagibig ? round2(ded.pagibig.employer / slotDivisor('pagibig')) : 0,
        };
      }

      const totalDeductions = policy.auto_statutory
        ? round2(sss + philhealth + pagibig + withholding_tax + computed.late_deduction + cashAdvance)
        : num(prev.total_deductions);
      const netPay = policy.auto_statutory ? round2(totalEarnings - totalDeductions) : num(prev.net_pay);

      const data = {
        ...zeros,
        ...prevManual,
        employee_name: emp.name, dept_position: deptPosition,
        payroll_period: payrollPeriod, pay_date: input.pay_date || (prevManual.pay_date as string) || '',
        daily_rate: emp.daily_rate,
        days_worked: computed.days_worked,
        // Informational only, doesn't itself subtract anything — an absent day already isn't
        // in days_worked, so it's already excluded from basic_salary below. This just makes
        // that reduction visible on the payslip (see the "Late / Absences" line's own comment
        // in src/hr-payroll-compute.ts — despite the name, it never held an absence figure).
        days_absent: computed.days_absent,
        ot_hours: computed.ot_hours,
        overtime_pay: round2(computed.overtime_pay),
        undertime_pay: round2(computed.undertime_pay),
        holiday_pay: round2(computed.holiday_pay),
        special_holiday_30: round2(computed.special_holiday_30),
        rest_day_ot: round2(computed.rest_day_ot),
        late_absences: round2(computed.late_deduction),
        basic_salary: round2(basicSalary),
        total_earnings: totalEarnings,
        sss, philhealth, pagibig, withholding_tax,
        total_deductions: totalDeductions,
        net_pay: netPay,
        employer_contributions: employerContributions,
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
    res.status(201).json({ created, updated, skipped_locked: skippedLocked, period: payrollPeriod, form_id: form.id });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// POST /api/hr/periods/:id/post-payroll-gl — books this cutoff's generated payslips as one
// aggregate journal entry (Payroll Journal). A deliberate, separate action from
// generate-payslips itself (see src/accounting-autopost.ts's maybeAutoPostPayroll for why) —
// safe to click again after a regenerate, which reverses the prior entry and posts fresh.
router.post('/periods/:id/post-payroll-gl', requirePermission('hr.manage'), (req, res) => {
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
router.post('/payroll/:recordId/mark-paid', requirePermission('hr.manage'), (req, res) => {
  const rec = queryOne<{ id: number; status: string; slug: string }>(
    `SELECT fr.id, fr.status, fd.slug FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    Number(req.params.recordId)
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
  if (rec.status === 'paid') { res.status(400).json({ error: 'Already marked paid' }); return; }
  run("UPDATE form_records SET status = 'paid', updated_at = datetime('now') WHERE id = ?", rec.id);
  res.json({ ok: true });
});

// POST /api/hr/payroll/:recordId/unmark-paid — unlocks it again for editing/regeneration.
router.post('/payroll/:recordId/unmark-paid', requirePermission('hr.manage'), (req, res) => {
  const rec = queryOne<{ id: number; status: string; slug: string }>(
    `SELECT fr.id, fr.status, fd.slug FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    Number(req.params.recordId)
  );
  if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
  if (rec.status !== 'paid') { res.status(400).json({ error: 'This payslip is not marked paid' }); return; }
  run("UPDATE form_records SET status = 'draft', updated_at = datetime('now') WHERE id = ?", rec.id);
  res.json({ ok: true });
});

// POST /api/hr/payroll/:recordId/email — emails this payslip to the employee's linked account.
// Employees have no email of their own (that's exactly what the account-linking feature is
// for) — this only works once HR has linked one under Employees, and only if that account has
// an email address set.
router.post('/payroll/:recordId/email', requirePermission('hr.manage'), async (req, res, next) => {
  try {
    const rec = queryOne<FormRecord & { slug: string }>(
      `SELECT fr.*, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
      Number(req.params.recordId)
    );
    if (!rec || rec.slug !== 'hr_payroll') { res.status(404).json({ error: 'Payslip not found' }); return; }
    const data = JSON.parse(rec.data as string) as Record<string, unknown>;
    const employeeName = String(data.employee_name || '');
    const target = queryOne<{ email: string | null }>(
      `SELECT u.email FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.name = ?`,
      employeeName
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
