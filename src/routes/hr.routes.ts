/** HR: Employees master list (201 file: status, statutory numbers, photo, documents) +
    Time Keeping (cutoff periods with daily time-in/out), wired to generate records in the
    existing "HR Payroll" form so the existing print pipeline (form-records.js /
    hr-payroll-print.js) handles payslip printing. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, UPLOAD_DIR, getSetting, setSetting } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody,
  employeeSchema,
  csvImportSchema,
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

const EMP_CSV_COLUMNS = [
  'employee_no', 'name', 'department', 'position', 'rate_type', 'daily_rate', 'monthly_rate',
  'status', 'start_date', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin_no',
] as const;

const router = Router();
router.use(requireAuth);

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
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
    `SELECT e.*, d.name AS department_name, u.username AS linked_username, u.full_name AS linked_full_name
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = e.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.name`,
    ...params
  );
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
       sss_no, philhealth_no, pagibig_no, tin_no, photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, effectiveDailyRate(input),
    input.rate_type, input.rate_type === 'monthly' ? input.monthly_rate : null,
    input.status, input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.photo ?? null
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
       monthly_rate = ?, status = ?, start_date = ?, sss_no = ?, philhealth_no = ?, pagibig_no = ?, tin_no = ?, photo = ?
     WHERE id = ?`,
    input.employee_no, input.name, input.department_id, input.position ?? null, input.user_id, effectiveDailyRate(input), input.rate_type,
    input.rate_type === 'monthly' ? input.monthly_rate : null, input.status,
    input.start_date ?? null, input.sss_no ?? null, input.philhealth_no ?? null,
    input.pagibig_no ?? null, input.tin_no ?? null, input.photo ?? null, id
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
  const filePath = path.join(UPLOAD_DIR, doc.stored_name);
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
  fs.promises.unlink(path.join(UPLOAD_DIR, doc.stored_name)).catch(() => {});
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
  monthly_rate_divisor: 26,
};

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
    `SELECT e.id AS employee_id, e.name, e.position, e.daily_rate, e.default_shift_id,
       e.department_id, d.name AS department_name, e.status,
       COUNT(*) AS days_total,
       SUM(CASE WHEN ar.time_in IS NOT NULL AND ar.time_in != '' THEN 1 ELSE 0 END) AS days_logged
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
      `INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, notes, shift_id, form_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of input.days) {
      insert.run(
        periodId, input.employee_id, d.work_date, d.time_in || null, d.time_out || null, d.notes || null,
        d.shift_id || null, d.form_record_id || null
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

  const roster = queryAll<{ employee_id: number; name: string; position: string | null; daily_rate: number; department_name: string | null }>(
    `SELECT DISTINCT e.id AS employee_id, e.name, e.position, e.daily_rate, d.name AS department_name
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.period_id = ?`,
    periodId
  );
  if (!roster.length) { res.status(400).json({ error: 'This cutoff has no employees yet' }); return; }

  const policy = currentPolicy();

  // Company-wide "No Work Memo" records (form slug 'no_work_memo') — resolved once, not per
  // employee, since these apply to everyone automatically with no per-day linking required.
  const noWorkForm = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'no_work_memo'");
  const noWorkMemos = noWorkForm
    ? queryAll<FormRecord>('SELECT data FROM form_records WHERE form_def_id = ?', noWorkForm.id)
        .map((r) => { try { return JSON.parse(r.data as string); } catch { return null; } })
        .filter((d): d is { date_from: string; date_to: string; paid: string } => !!d && !!d.date_from && !!d.date_to)
    : [];
  function noWorkFor(workDate: string): 'paid' | 'unpaid' | null {
    const memo = noWorkMemos.find((m) => workDate >= m.date_from && workDate <= m.date_to);
    if (!memo) return null;
    return memo.paid === 'Yes' ? 'paid' : 'unpaid';
  }

  let created = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const emp of roster) {
      const deptPosition = [emp.department_name, emp.position].filter(Boolean).join(' / ');
      const zeros = {
        days_worked: 0, ot_hours: 0, ot_rate_hour: 0, basic_salary: 0, overtime_pay: 0,
        undertime_pay: 0, holiday_pay: 0, special_holiday_30: 0, rest_day_ot: 0, total_earnings: 0,
        sss: 0, philhealth: 0, pagibig: 0, cash_advance: 0, late_absences: 0, total_deductions: 0, net_pay: 0,
      };

      // Attendance + whatever OT/Half Day/Leave/Undertime/Offset form (and its resolved shift)
      // is linked to each day — the compute engine itself never touches the DB, this is exactly
      // the resolution step src/hr-payroll-compute.ts expects its caller to do.
      const attendanceRows = queryAll<{
        work_date: string; time_in: string | null; time_out: string | null;
        shift_start: string | null; shift_end: string | null;
        fr_data: string | null; fd_slug: string | null;
      }>(
        `SELECT ar.work_date, ar.time_in, ar.time_out,
           s.start_time AS shift_start, s.end_time AS shift_end,
           fr.data AS fr_data, fd.slug AS fd_slug
         FROM attendance_records ar
         LEFT JOIN shifts s ON s.id = ar.shift_id
         LEFT JOIN form_records fr ON fr.id = ar.form_record_id
         LEFT JOIN form_definitions fd ON fd.id = fr.form_def_id
         WHERE ar.period_id = ? AND ar.employee_id = ?
         ORDER BY ar.work_date`,
        periodId, emp.employee_id
      );
      const attendanceDays: AttendanceDay[] = attendanceRows.map((r) => ({
        work_date: r.work_date,
        time_in: r.time_in,
        time_out: r.time_out,
        shift: r.shift_start && r.shift_end ? { start_time: r.shift_start, end_time: r.shift_end } : null,
        linkedForm: r.fd_slug ? { slug: r.fd_slug, data: JSON.parse(r.fr_data || '{}') } : null,
        noWork: noWorkFor(r.work_date),
      }));
      const computed = computeAttendanceForEmployee(attendanceDays, emp.daily_rate, policy);
      const basicSalary = emp.daily_rate * computed.days_worked;

      const existing = queryAll<FormRecord>(
        `SELECT * FROM form_records WHERE form_def_id = ? AND period = ?`,
        form.id, payrollPeriod
      ).find((r) => {
        try { return (JSON.parse(r.data as string).employee_name ?? '') === emp.name; }
        catch { return false; }
      });
      // Regenerating recomputes every attendance-derived field fresh — that's the point of
      // "generate payslips" (pick up the latest attendance/link edits) — but purely-manual
      // fields with no computed source (statutory deductions, cash advance, rest-day OT, the
      // OT peso rate, and the final net pay) are carried over from a previous generation rather
      // than reset to zero, same as the un-computed fields always did before this feature.
      const prevManual = existing ? (() => {
        try {
          const prev = JSON.parse(existing.data as string);
          return {
            sss: prev.sss, philhealth: prev.philhealth, pagibig: prev.pagibig,
            cash_advance: prev.cash_advance, rest_day_ot: prev.rest_day_ot,
            ot_rate_hour: prev.ot_rate_hour, total_deductions: prev.total_deductions,
            net_pay: prev.net_pay, pay_date: prev.pay_date,
          };
        } catch { return {}; }
      })() : {};

      const data = {
        ...zeros,
        ...prevManual,
        employee_name: emp.name, dept_position: deptPosition,
        payroll_period: payrollPeriod, pay_date: input.pay_date || (prevManual as { pay_date?: string }).pay_date || '',
        daily_rate: emp.daily_rate,
        days_worked: computed.days_worked,
        ot_hours: computed.ot_hours,
        overtime_pay: round2(computed.overtime_pay),
        undertime_pay: round2(computed.undertime_pay),
        holiday_pay: round2(computed.holiday_pay),
        special_holiday_30: round2(computed.special_holiday_30),
        late_absences: round2(computed.late_deduction),
        basic_salary: round2(basicSalary),
        total_earnings: round2(
          basicSalary + computed.overtime_pay + computed.undertime_pay
          + computed.holiday_pay + computed.special_holiday_30
          + (Number((prevManual as { rest_day_ot?: number }).rest_day_ot) || 0)
        ),
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
    res.status(201).json({ created, updated, period: payrollPeriod, form_id: form.id });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
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
