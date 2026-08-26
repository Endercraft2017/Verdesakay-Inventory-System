/** HR: Employees master list (201 file: status, statutory numbers, photo, documents) +
    Time Keeping (cutoff periods with daily time-in/out), wired to generate records in the
    existing "HR Payroll" form so the existing print pipeline (form-records.js /
    hr-payroll-print.js) handles payslip printing. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, UPLOAD_DIR } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody,
  employeeSchema,
  attendancePeriodSchema,
  saveAttendanceSchema,
  addRosterEmployeeSchema,
  generatePayslipsSchema,
} from '../validation';
import type { Employee, EmployeeDocument, AttendancePeriod, FormDefinition, FormRecord } from '../types';

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

/** Next employee number, e.g. EMP-00001 (counter in settings). */
function nextEmployeeNumber(): string {
  return nextSequence('employee_seq', 'EMP');
}

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
    `SELECT e.*, d.name AS department_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.name`,
    ...params
  );
  res.json(rows);
});

// POST /api/hr/employees
router.post('/employees', requirePermission('hr.manage'), (req, res) => {
  const input = parseBody(employeeSchema, req.body);
  const info = run(
    `INSERT INTO employees
      (employee_no, name, department_id, position, daily_rate, status, start_date,
       sss_no, philhealth_no, pagibig_no, tin_no, photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nextEmployeeNumber(), input.name, input.department_id, input.position ?? null, input.daily_rate,
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
  run(
    `UPDATE employees SET name = ?, department_id = ?, position = ?, daily_rate = ?, status = ?,
       start_date = ?, sss_no = ?, philhealth_no = ?, pagibig_no = ?, tin_no = ?, photo = ?
     WHERE id = ?`,
    input.name, input.department_id, input.position ?? null, input.daily_rate, input.status,
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
    `SELECT e.id AS employee_id, e.name, e.position, e.daily_rate, d.name AS department_name,
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
      `INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const d of input.days) {
      insert.run(periodId, input.employee_id, d.work_date, d.time_in || null, d.time_out || null, d.notes || null);
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ─── Generate payslips ──────────────────────────────────────────────────────

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
      const existing = queryAll<FormRecord>(
        `SELECT * FROM form_records WHERE form_def_id = ? AND period = ?`,
        form.id, payrollPeriod
      ).find((r) => {
        try { return (JSON.parse(r.data as string).employee_name ?? '') === emp.name; }
        catch { return false; }
      });

      if (existing) {
        const prev = JSON.parse(existing.data as string);
        const data = {
          ...zeros, ...prev,
          employee_name: emp.name, dept_position: deptPosition,
          payroll_period: payrollPeriod, pay_date: input.pay_date || prev.pay_date || '',
          daily_rate: emp.daily_rate,
        };
        run(`UPDATE form_records SET data = ?, updated_at = datetime('now') WHERE id = ?`,
          JSON.stringify(data), existing.id);
        updated++;
      } else {
        const number = nextSequence(`form_seq_${form.id}`, form.number_prefix);
        const data = {
          ...zeros,
          employee_name: emp.name, dept_position: deptPosition,
          payroll_period: payrollPeriod, pay_date: input.pay_date || '',
          daily_rate: emp.daily_rate,
        };
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
