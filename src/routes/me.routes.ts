/** Employee self-service — everything scoped to the caller's own linked employee
 *  record. Mounted at /api/me. Any logged-in user; endpoints 403 if the account
 *  isn't linked to an `employees` row. */
import { Router, type Request } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth } from '../auth';
import { parseBody, timeCorrectionSchema, approvalDecisionSchema } from '../validation';
import { notifyUser, notifyPermission } from '../push';
import type { FormDefinition, FormRecord, TimeCorrection } from '../types';

const router = Router();
router.use(requireAuth);

interface Emp { id: number; name: string; department_id: number | null; position: string | null; employee_no: string | null; default_shift_id: number | null; department_name: string | null }

function me(userId: number): Emp | undefined {
  return queryOne<Emp>(
    `SELECT e.id, e.name, e.department_id, e.position, e.employee_no, e.default_shift_id, d.name AS department_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.user_id = ?`,
    userId
  );
}
function needEmp(res: import('express').Response, emp: Emp | undefined): emp is Emp {
  if (!emp) { res.status(403).json({ error: 'Your account is not linked to an employee record. Ask HR to link it.' }); return false; }
  return true;
}

const parse = (d: unknown) => { try { return JSON.parse(String(d)); } catch { return {}; } };

// GET /api/me — the linked employee (or null)
router.get('/', (req, res) => {
  res.json({ employee: me(req.user!.id) ?? null });
});

// GET /api/me/payslips — this employee's HR Payroll records, newest first
router.get('/payslips', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const form = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'");
  if (!form) { res.json([]); return; }
  const rows = queryAll<FormRecord>(
    `SELECT id, number, period, status, data, created_at, updated_at
     FROM form_records
     WHERE form_def_id = ? AND json_extract(data, '$.employee_name') = ?
     ORDER BY id DESC`,
    form.id, emp.name
  );
  res.json(rows.map((r) => ({ ...r, data: parse(r.data) })));
});

// GET /api/me/schedule — current + next cutoff's roster days with shift times
router.get('/schedule', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const defShift = emp.default_shift_id
    ? queryOne<{ name: string; start_time: string; end_time: string }>('SELECT name, start_time, end_time FROM shifts WHERE id = ?', emp.default_shift_id)
    : null;
  // This employee's roster days for any cutoff that hasn't ended yet (current + upcoming).
  const days = queryAll<{ work_date: string; time_in: string | null; time_out: string | null; shift_name: string | null; start_time: string | null; end_time: string | null; period_label: string }>(
    `SELECT ar.work_date, ar.time_in, ar.time_out,
            s.name AS shift_name, s.start_time, s.end_time, p.label AS period_label
     FROM attendance_records ar
     JOIN attendance_periods p ON p.id = ar.period_id
     LEFT JOIN shifts s ON s.id = ar.shift_id
     WHERE ar.employee_id = ? AND p.end_date >= date('now','localtime')
     ORDER BY ar.work_date`,
    emp.id
  );
  res.json({ default_shift: defShift, days });
});

/** Slugs an employee may self-file from mobile. */
export const REQUEST_SLUGS = [
  'leave_request', 'overtime_request', 'undertime_request', 'halfday_request', 'offset_form',
  'holiday_work_request', 'travel_order', 'coe_request', 'reimbursement_request',
  'loan_application', 'training_request', 'incident_report',
];

// GET /api/me/request-types — the HR request forms available to file
router.get('/request-types', (_req, res) => {
  const rows = queryAll<FormDefinition>(
    `SELECT id, name, slug, icon, fields FROM form_definitions
     WHERE slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
     ORDER BY name`,
    ...REQUEST_SLUGS
  );
  res.json(rows.map((r) => ({ ...r, fields: parse(r.fields) })));
});

// GET /api/me/requests — records this user filed for any request form, newest first
router.get('/requests', (req, res) => {
  const rows = queryAll<FormRecord & { form_name: string; slug: string }>(
    `SELECT fr.id, fr.number, fr.status, fr.data, fr.created_at, fr.updated_at,
            fd.name AS form_name, fd.slug
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fr.created_by = ? AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
     ORDER BY fr.id DESC LIMIT 100`,
    req.user!.id, ...REQUEST_SLUGS
  );
  res.json(rows.map((r) => ({ ...r, data: parse(r.data) })));
});

// POST /api/me/requests/:id/cancel — withdraw your own still-pending request
router.post('/requests/:id/cancel', (req, res) => {
  const rec = queryOne<{ id: number; status: string; created_by: number | null; slug: string }>(
    `SELECT fr.id, fr.status, fr.created_by, fd.slug
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fr.id = ?`,
    Number(req.params.id)
  );
  if (!rec || rec.created_by !== req.user!.id || !REQUEST_SLUGS.includes(rec.slug)) {
    res.status(404).json({ error: 'Request not found' }); return;
  }
  if (rec.status !== 'pending' && rec.status !== 'draft') {
    res.status(400).json({ error: 'Only a pending request can be cancelled' }); return;
  }
  run("UPDATE form_records SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", rec.id);
  res.json({ ok: true, status: 'cancelled' });
});

/* ─── Attendance corrections (missed / wrong punch) ─────────────────────────── */

// GET /api/me/time-corrections — this employee's fixes, newest first
router.get('/time-corrections', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  res.json(queryAll<TimeCorrection & { decided_by_name: string | null }>(
    `SELECT tc.*, u.full_name AS decided_by_name
     FROM time_corrections tc LEFT JOIN users u ON u.id = tc.decided_by
     WHERE tc.employee_id = ? ORDER BY tc.id DESC LIMIT 100`,
    emp.id
  ));
});

// POST /api/me/time-corrections — file a fix; pings the approvers
router.post('/time-corrections', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const input = parseBody(timeCorrectionSchema, req.body);
  const info = run(
    `INSERT INTO time_corrections (employee_id, user_id, work_date, requested_in, requested_out, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    emp.id, req.user!.id, input.work_date, input.requested_in, input.requested_out, input.reason
  );
  const payload = {
    title: 'Time fix request',
    body: `${emp.name} · ${input.work_date}`,
    url: '#/approvals',
    tag: 'tc-new-' + info.lastInsertRowid,
  };
  if (emp.department_id) {
    const head = queryOne<{ head_user_id: number | null }>(
      'SELECT head_user_id FROM departments WHERE id = ?', emp.department_id
    );
    if (head?.head_user_id && head.head_user_id !== req.user!.id) void notifyUser(head.head_user_id, payload);
  }
  void notifyPermission('hr.manage', payload);
  res.status(201).json({ id: info.lastInsertRowid });
});

// POST /api/me/time-corrections/:id/cancel — withdraw your own pending fix
router.post('/time-corrections/:id/cancel', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const tc = queryOne<{ id: number; status: string }>(
    'SELECT id, status FROM time_corrections WHERE id = ? AND employee_id = ?',
    Number(req.params.id), emp.id
  );
  if (!tc) { res.status(404).json({ error: 'Correction not found' }); return; }
  if (tc.status !== 'pending') { res.status(400).json({ error: 'Only a pending correction can be cancelled' }); return; }
  run("UPDATE time_corrections SET status = 'cancelled' WHERE id = ?", tc.id);
  res.json({ ok: true, status: 'cancelled' });
});

/* ─── Approvals inbox (department heads + hr.manage) ────────────────────────── */

/** Department ids this user is the registered head of. */
function headedDeptIds(userId: number): number[] {
  return queryAll<{ id: number }>('SELECT id FROM departments WHERE head_user_id = ?', userId).map((r) => r.id);
}
/** May the caller decide an item belonging to the given department? */
function mayDecide(req: Request, deptId: number | null): boolean {
  if (req.user!.permissions.includes('hr.manage')) return true;
  return deptId != null && headedDeptIds(req.user!.id).includes(deptId);
}

// GET /api/me/approvals — pending requests + time corrections the caller may decide
router.get('/approvals', (req, res) => {
  const isHrManager = req.user!.permissions.includes('hr.manage');
  const heads = headedDeptIds(req.user!.id);
  if (!isHrManager && !heads.length) { res.json({ requests: [], time_corrections: [] }); return; }
  const inScope = (deptId: number | null) => isHrManager || (deptId != null && heads.includes(deptId));

  const reqRows = queryAll<FormRecord & { form_name: string; slug: string; filed_by: string | null; employee_name: string | null; department_id: number | null }>(
    `SELECT fr.id, fr.number, fr.status, fr.data, fr.created_at,
            fd.name AS form_name, fd.slug,
            u.full_name AS filed_by, e.name AS employee_name, e.department_id
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN users u ON u.id = fr.created_by
     LEFT JOIN employees e ON e.user_id = fr.created_by
     WHERE fr.status = 'pending' AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
       AND (fr.created_by IS NULL OR fr.created_by != ?)
     ORDER BY fr.id DESC LIMIT 200`,
    ...REQUEST_SLUGS, req.user!.id
  );
  const tcRows = queryAll<TimeCorrection & { employee_name: string; department_id: number | null }>(
    `SELECT tc.*, e.name AS employee_name, e.department_id
     FROM time_corrections tc JOIN employees e ON e.id = tc.employee_id
     WHERE tc.status = 'pending' AND (tc.user_id IS NULL OR tc.user_id != ?)
     ORDER BY tc.id DESC LIMIT 200`,
    req.user!.id
  );
  res.json({
    requests: reqRows.filter((r) => inScope(r.department_id)).map((r) => ({ ...r, data: parse(r.data) })),
    time_corrections: tcRows.filter((r) => inScope(r.department_id)),
  });
});

// POST /api/me/approvals/requests/:id/decide — { decision: 'approved'|'rejected', note? }
router.post('/approvals/requests/:id/decide', (req, res) => {
  const id = Number(req.params.id);
  const rec = queryOne<{ id: number; status: string; created_by: number | null; data: string; slug: string; form_name: string; department_id: number | null }>(
    `SELECT fr.id, fr.status, fr.created_by, fr.data, fd.slug, fd.name AS form_name, e.department_id
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN employees e ON e.user_id = fr.created_by
     WHERE fr.id = ?`,
    id
  );
  if (!rec || !REQUEST_SLUGS.includes(rec.slug)) { res.status(404).json({ error: 'Request not found' }); return; }
  if (rec.created_by === req.user!.id) { res.status(403).json({ error: 'You can’t decide your own request' }); return; }
  if (!mayDecide(req, rec.department_id)) { res.status(403).json({ error: 'Not an approver for this request' }); return; }
  if (rec.status !== 'pending') { res.status(400).json({ error: 'This request is no longer pending' }); return; }

  const { decision, note } = parseBody(approvalDecisionSchema, req.body);
  const data = parse(rec.data);
  data.decided_by = req.user!.full_name;
  data.decided_at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (note) data.decision_note = note;
  run("UPDATE form_records SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?", decision, JSON.stringify(data), id);
  if (rec.created_by) {
    void notifyUser(rec.created_by, {
      title: `Request ${decision}`,
      body: rec.form_name + (note ? ' — ' + note : ''),
      url: '#/requests',
      tag: 'req-' + id,
    });
  }
  res.json({ ok: true, status: decision });
});

// POST /api/me/approvals/time-corrections/:id/decide — { decision, note? }
router.post('/approvals/time-corrections/:id/decide', (req, res) => {
  const id = Number(req.params.id);
  const tc = queryOne<TimeCorrection & { department_id: number | null }>(
    `SELECT tc.*, e.department_id FROM time_corrections tc
     JOIN employees e ON e.id = tc.employee_id WHERE tc.id = ?`,
    id
  );
  if (!tc) { res.status(404).json({ error: 'Correction not found' }); return; }
  if (tc.user_id === req.user!.id) { res.status(403).json({ error: 'You can’t decide your own correction' }); return; }
  if (!mayDecide(req, tc.department_id ?? null)) { res.status(403).json({ error: 'Not an approver for this correction' }); return; }
  if (tc.status !== 'pending') { res.status(400).json({ error: 'This correction is no longer pending' }); return; }

  const { decision, note } = parseBody(approvalDecisionSchema, req.body);
  run(
    "UPDATE time_corrections SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?",
    decision, req.user!.id, note || null, id
  );
  let applied = false;
  if (decision === 'approved') {
    const period = queryOne<{ id: number }>(
      'SELECT id FROM attendance_periods WHERE ? BETWEEN start_date AND end_date ORDER BY id DESC LIMIT 1',
      tc.work_date
    );
    if (period) {
      run(
        `INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(period_id, employee_id, work_date) DO UPDATE SET
           time_in  = COALESCE(excluded.time_in, attendance_records.time_in),
           time_out = COALESCE(excluded.time_out, attendance_records.time_out),
           notes    = excluded.notes,
           updated_at = datetime('now')`,
        period.id, tc.employee_id, tc.work_date, tc.requested_in || null, tc.requested_out || null,
        'Time correction approved' + (note ? ' — ' + note : '')
      );
      applied = true;
    }
  }
  if (tc.user_id) {
    void notifyUser(tc.user_id, {
      title: `Time fix ${decision}`,
      body: tc.work_date + (note ? ' — ' + note : ''),
      url: '#/time-fix',
      tag: 'tc-' + id,
    });
  }
  res.json({ ok: true, status: decision, applied });
});

export default router;
