/** Employee self-service — everything scoped to the caller's own linked employee
 *  record. Mounted at /api/me. Any logged-in user; endpoints 403 if the account
 *  isn't linked to an `employees` row. */
import { Router, type Request } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth } from '../auth';
import { parseBody, timeCorrectionSchema, approvalDecisionSchema } from '../validation';
import { notifyUser, notifyPermission } from '../push';
import { myClockStatus } from '../clock';
import { unrecordedOtMinutes, type AttendanceDay } from '../hr-payroll-compute';
import { currentPolicy } from './hr.routes';
import type { FormDefinition, FormRecord, TimeCorrection } from '../types';

const router = Router();
router.use(requireAuth);

interface Emp {
  id: number; name: string; department_id: number | null; position: string | null; employee_no: string | null;
  default_shift_id: number | null; department_name: string | null;
  leave_days_per_year: number; leave_days_used: number; leave_days_remaining: number;
}

function me(userId: number): Emp | undefined {
  return queryOne<Emp>(
    `SELECT e.id, e.name, e.department_id, e.position, e.employee_no, e.default_shift_id, d.name AS department_name,
            e.leave_days_per_year, e.leave_days_used, (e.leave_days_per_year - e.leave_days_used) AS leave_days_remaining
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

// POST /api/me/approvals/requests/:id/decide — { decision: 'approved'|'rejected', note?, override_balance? }
router.post('/approvals/requests/:id/decide', (req, res) => {
  const id = Number(req.params.id);
  const rec = queryOne<{
    id: number; status: string; created_by: number | null; data: string; slug: string; form_name: string;
    department_id: number | null; employee_id: number | null; leave_days_per_year: number | null; leave_days_used: number | null;
  }>(
    `SELECT fr.id, fr.status, fr.created_by, fr.data, fd.slug, fd.name AS form_name,
            e.department_id, e.id AS employee_id, e.leave_days_per_year, e.leave_days_used
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

  const { decision, note, override_balance } = parseBody(approvalDecisionSchema, req.body);
  const data = parse(rec.data);

  // Approving a paid Leave request consumes the employee's fixed leave-day bank. Blocked if it
  // would go negative, unless the approver explicitly overrides — a rejected decision, or one
  // where with_pay isn't 'Yes', never touches the balance (see docs on the "simple fixed bank"
  // design: no accrual math, no carry-over, one-way consumption with no un-approve path).
  if (decision === 'approved' && rec.slug === 'leave_request' && data.with_pay === 'Yes' && rec.employee_id) {
    const days = Number(data.days) || 0;
    if (days > 0) {
      const remaining = (rec.leave_days_per_year ?? 5) - (rec.leave_days_used ?? 0);
      if (remaining - days < 0 && !override_balance) {
        res.status(400).json({ error: `Requested ${days} day(s), only ${remaining} remaining. Approve anyway to override.` });
        return;
      }
      run('UPDATE employees SET leave_days_used = leave_days_used + ? WHERE id = ?', days, rec.employee_id);
    }
  }

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

/* ─── Unrecorded OT (mobile prompt + Home reminder) ─────────────────────────── */

interface UnrecordedOtDay { work_date: string; period_label: string; time_in: string; time_out: string; ot_minutes: number }

/** Recent attendance_records days for `employeeId` where the logged time-out is block-worthy
 *  past the shift's expected end (src/hr-payroll-compute.ts's unrecordedOtMinutes — the exact
 *  same check generate-payslips' real OT calc is built from) with no linked Overtime Request
 *  form. Scoped to the last 45 days so this stays a "did you forget something recent" nudge,
 *  not a lifetime backlog once an employee has years of history. */
function unrecordedOtDays(employeeId: number): UnrecordedOtDay[] {
  const rows = queryAll<{
    work_date: string; time_in: string; time_out: string; period_label: string;
    shift_start: string | null; shift_end: string | null; fr_data: string | null; fd_slug: string | null;
  }>(
    `SELECT ar.work_date, ar.time_in, ar.time_out, p.label AS period_label,
       s.start_time AS shift_start, s.end_time AS shift_end,
       fr.data AS fr_data, fd.slug AS fd_slug
     FROM attendance_records ar
     JOIN attendance_periods p ON p.id = ar.period_id
     LEFT JOIN shifts s ON s.id = ar.shift_id
     LEFT JOIN form_records fr ON fr.id = ar.form_record_id
     LEFT JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE ar.employee_id = ? AND ar.time_in IS NOT NULL AND ar.time_out IS NOT NULL
       AND ar.work_date >= date('now', 'localtime', '-45 days')
     ORDER BY ar.work_date DESC`,
    employeeId
  );
  const policy = currentPolicy();
  const out: UnrecordedOtDay[] = [];
  for (const r of rows) {
    const day: AttendanceDay = {
      work_date: r.work_date, time_in: r.time_in, time_out: r.time_out,
      shift: r.shift_start && r.shift_end ? { start_time: r.shift_start, end_time: r.shift_end } : null,
      linkedForm: r.fd_slug ? { slug: r.fd_slug, data: JSON.parse(r.fr_data || '{}') } : null,
    };
    const mins = unrecordedOtMinutes(day, policy);
    if (mins > 0) out.push({ work_date: r.work_date, period_label: r.period_label, time_in: r.time_in, time_out: r.time_out, ot_minutes: mins });
  }
  return out;
}

// GET /api/me/unrecorded-ot — days this employee worked block-worthy OT with no linked
// Overtime Request form, for the mobile "you have unrecorded OT" prompt (right after clocking
// out) and the Home screen reminder card.
router.get('/unrecorded-ot', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  res.json(unrecordedOtDays(emp.id));
});

/* ─── Home "Today" feed (mobile) ────────────────────────────────────────────── */

type Urgency = 'high' | 'medium' | 'low';
interface StackItem {
  kind: string;
  title: string;
  subtitle?: string;
  urgency: Urgency;
  route: string;
  /** Optional query params for the route, e.g. jumping "requests" straight into filing a
   *  specific request type instead of the picker. */
  params?: Record<string, string>;
  count?: number;
}
const URGENCY_RANK: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };

/** "today" / "yesterday" / "N days ago" from a YYYY-MM-DD(...) string. */
function relDays(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  const now = new Date();
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// GET /api/me/today — a ranked, actionable "what's on my plate" stack for the
// mobile home. Works for any logged-in user; HR/clock items only when linked.
router.get('/today', (req, res) => {
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const firstName = (req.user!.full_name || req.user!.username || '').trim().split(/\s+/)[0];
  const stack: StackItem[] = [];
  const emp = me(req.user!.id);

  let clock: null | { linked: boolean; clocked_in: boolean; since: string | null; hours_today: number;
    shift: { name: string | null; start_time: string; end_time: string } | null } = null;
  let nextShift: { work_date: string; start_time: string | null; end_time: string | null } | null = null;

  if (emp) {
    const st = myClockStatus(emp.id);
    const todayShift = queryOne<{ start_time: string; end_time: string; name: string | null }>(
      `SELECT s.start_time, s.end_time, s.name
       FROM attendance_records ar
       JOIN attendance_periods p ON p.id = ar.period_id
       LEFT JOIN shifts s ON s.id = ar.shift_id
       WHERE ar.employee_id = ? AND ar.work_date = date('now','localtime')
       ORDER BY ar.id DESC LIMIT 1`,
      emp.id
    );
    const defShift = emp.default_shift_id
      ? queryOne<{ start_time: string; end_time: string; name: string }>('SELECT start_time, end_time, name FROM shifts WHERE id = ?', emp.default_shift_id)
      : null;
    const shift = (todayShift && todayShift.start_time) ? todayShift : defShift;
    clock = {
      linked: true,
      clocked_in: st.clocked_in,
      since: st.since,
      hours_today: st.hours_today,
      shift: shift ? { name: shift.name ?? null, start_time: shift.start_time, end_time: shift.end_time } : null,
    };

    if (!st.clocked_in) {
      stack.push({
        kind: 'punch', route: 'clock', urgency: 'high',
        title: 'Not clocked in',
        subtitle: shift ? `${shift.start_time} – ${shift.end_time} · Today's shift` : 'Scan the office code to clock in',
      });
    } else {
      stack.push({
        kind: 'punch', route: 'clock', urgency: 'low',
        title: `Clocked in since ${st.since}`,
        subtitle: `${st.hours_today} h today`,
      });
    }

    nextShift = queryOne<{ work_date: string; start_time: string | null; end_time: string | null }>(
      `SELECT ar.work_date, s.start_time, s.end_time
       FROM attendance_records ar
       JOIN attendance_periods p ON p.id = ar.period_id
       LEFT JOIN shifts s ON s.id = ar.shift_id
       WHERE ar.employee_id = ? AND ar.work_date > date('now','localtime')
       ORDER BY ar.work_date LIMIT 1`,
      emp.id
    ) ?? null;

    // Pending attendance corrections this user filed
    const tc = queryOne<{ n: number; oldest: string | null }>(
      "SELECT COUNT(*) AS n, MIN(work_date) AS oldest FROM time_corrections WHERE user_id = ? AND status = 'pending'",
      req.user!.id
    );
    if (tc && tc.n > 0) {
      stack.push({
        kind: 'correction', route: 'time-fix', urgency: 'low', count: tc.n,
        title: tc.n === 1 ? 'Punch fix pending review' : `${tc.n} punch fixes pending`,
        subtitle: tc.oldest ? `for ${tc.oldest}` : undefined,
      });
    }

    // Recent days worked past the shift's end with no Overtime Request filed.
    const unrecordedOt = unrecordedOtDays(emp.id);
    if (unrecordedOt.length > 0) {
      stack.push({
        kind: 'ot', route: 'requests', params: { type: 'overtime_request', date: unrecordedOt[0]!.work_date },
        urgency: 'medium', count: unrecordedOt.length,
        title: unrecordedOt.length === 1 ? 'Unrecorded OT on ' + unrecordedOt[0]!.work_date : `Unrecorded OT on ${unrecordedOt.length} days`,
        subtitle: 'No Overtime Request filed — tap to request it',
      });
    }
  } else {
    clock = null;
  }

  // Tasks due today or overdue (any user)
  const tasks = queryOne<{ n: number; overdue: number }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN substr(due_date,1,10) < date('now','localtime') THEN 1 ELSE 0 END) AS overdue
     FROM tasks
     WHERE user_id = ? AND done = 0 AND due_date IS NOT NULL
       AND substr(due_date,1,10) <= date('now','localtime')`,
    req.user!.id
  );
  if (tasks && tasks.n > 0) {
    stack.push({
      kind: 'task', route: 'tasks', count: tasks.n,
      urgency: tasks.overdue > 0 ? 'high' : 'medium',
      title: `${tasks.n} task${tasks.n === 1 ? '' : 's'} due today`,
      subtitle: tasks.overdue > 0 ? `${tasks.overdue} overdue` : 'View your tasks',
    });
  }

  // My requests still awaiting a decision (any user who has filed one)
  const myReq = queryOne<{ n: number; oldest: string | null }>(
    `SELECT COUNT(*) AS n, MIN(fr.created_at) AS oldest
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fr.created_by = ? AND fr.status = 'pending'
       AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})`,
    req.user!.id, ...REQUEST_SLUGS
  );
  if (myReq && myReq.n > 0) {
    stack.push({
      kind: 'request', route: 'requests', count: myReq.n, urgency: 'medium',
      title: myReq.n === 1 ? 'Request awaiting review' : `${myReq.n} requests awaiting review`,
      subtitle: myReq.oldest ? `Submitted ${relDays(myReq.oldest)}` : undefined,
    });
  }

  // Approvals waiting on the caller (department head or hr.manage)
  const isHrManager = req.user!.permissions.includes('hr.manage');
  const heads = headedDeptIds(req.user!.id);
  if (isHrManager || heads.length) {
    const inScope = (deptId: number | null) => isHrManager || (deptId != null && heads.includes(deptId));
    const pendReq = queryAll<{ department_id: number | null }>(
      `SELECT e.department_id
       FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
       LEFT JOIN employees e ON e.user_id = fr.created_by
       WHERE fr.status = 'pending' AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
         AND (fr.created_by IS NULL OR fr.created_by != ?)`,
      ...REQUEST_SLUGS, req.user!.id
    ).filter((r) => inScope(r.department_id)).length;
    const pendTc = queryAll<{ department_id: number | null }>(
      `SELECT e.department_id FROM time_corrections tc JOIN employees e ON e.id = tc.employee_id
       WHERE tc.status = 'pending' AND (tc.user_id IS NULL OR tc.user_id != ?)`,
      req.user!.id
    ).filter((r) => inScope(r.department_id)).length;
    const n = pendReq + pendTc;
    if (n > 0) {
      stack.push({
        kind: 'approval', route: 'approvals', count: n, urgency: 'medium',
        title: n === 1 ? '1 approval waiting on you' : `${n} approvals waiting on you`,
        subtitle: 'Requests & time fixes',
      });
    }
  }

  // Unread messages
  const unread = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL', req.user!.id
  );
  if (unread && unread.n > 0) {
    stack.push({
      kind: 'message', route: 'inbox', count: unread.n, urgency: 'low',
      title: `${unread.n} unread message${unread.n === 1 ? '' : 's'}`, subtitle: 'Open your inbox',
    });
  }

  stack.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);

  const announcement = queryOne<{ id: number; title: string; body: string; pinned: number }>(
    `SELECT id, title, body, pinned FROM announcements
     WHERE expires_at IS NULL OR expires_at >= datetime('now','localtime')
     ORDER BY pinned DESC, id DESC LIMIT 1`
  ) ?? null;

  res.json({
    greeting: { name: firstName, part_of_day: partOfDay },
    clock,
    next_shift: nextShift,
    stack,
    announcement,
  });
});

export default router;
