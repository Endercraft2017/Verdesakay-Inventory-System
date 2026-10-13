import { REQUEST_SLUGS } from '../modules/hr/request-policy';
/** Employee self-service — everything scoped to the caller's own linked employee
 *  record. Mounted at /api/me. Any logged-in user; endpoints 403 if the account
 *  isn't linked to an `employees` row. */
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { db, queryOne, queryAll, run, getSetting } from '../shared/db';
import { logEvent } from '../shared/activity';
import { renderPayslipPdf } from '../modules/payroll/payslip-pdf';
import { requireAuth } from '../shared/auth';
import { parseBody, timeCorrectionSchema, approvalDecisionSchema, selfProfileSchema } from '../shared/validation';
import { getProfile, updateProfile, profileHistory, PROFILE_FIELDS } from '../modules/hr/employee-profile';
import { INFO_CHANGE_SLUG, applyInfoChange, previousNames } from '../modules/hr/info-change';
import { notifyUser, notifyPermission } from '../shared/push';
import { myClockStatus } from '../modules/hr/clock';
import { unrecordedOtMinutes, type AttendanceDay } from '../modules/payroll/hr-payroll-compute';
import { currentPolicy } from '../modules/hr/hr.routes';
import type { FormDefinition, FormRecord, TimeCorrection } from '../shared/types';
import { recordSiteClash, syncClass } from '../sync';
import { approverDepartmentIds, cutoffIsPaid, notifyApprovers } from '../modules/hr/workflow';
import { normalizeRequest, leaveDates, scheduledLeaveDates, overlappingLeave, leaveWarnings, attachLeave, leavePreview, requestEmployeeJoin } from '../modules/hr/request-data';
import { now, reRunOfRecordedCommand, siteDecisionStands } from '../shared/sync-context';

const router = Router();
router.use(requireAuth);

interface Emp {
  id: number; name: string; department_id: number | null; position: string | null; employee_no: string | null;
  default_shift_id: number | null; department_name: string | null;
  /** Self-chosen display name (employee_profiles) — never replaces the legal `name`. */
  preferred_name: string | null;
  leave_days_per_year: number; leave_days_used: number; leave_days_remaining: number;
}

function me(userId: number): Emp | undefined {
  return queryOne<Emp>(
    `SELECT e.id, e.name, e.department_id, e.position, e.employee_no, e.default_shift_id, d.name AS department_name,
            e.leave_days_per_year, e.leave_days_used, (e.leave_days_per_year - e.leave_days_used) AS leave_days_remaining,
            ep.preferred_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employee_profiles ep ON ep.employee_id = e.id
     WHERE e.user_id = ?`,
    userId
  );
}
function needEmp(res: import('express').Response, emp: Emp | undefined): emp is Emp {
  if (!emp) { res.status(403).json({ error: 'Your account is not linked to an employee record. Ask HR to link it.' }); return false; }
  return true;
}

const parse = (d: unknown) => { try { return JSON.parse(String(d)); } catch { return {}; } };
function requestDisplayData(slug: string, data: Record<string, unknown>) {
  if (slug !== 'schedule_change') return null;
  const shift = (id: unknown) => id == null ? undefined : queryOne<{ name: string; start_time: string; end_time: string }>(
    'SELECT name, start_time, end_time FROM shifts WHERE id = ?', Number(id));
  const label = (id: unknown) => {
    const row = shift(id);
    return row ? `${row.name} · ${row.start_time}–${row.end_time}` : id == null ? 'No shift assigned' : 'Shift no longer available';
  };
  return { 'Work date': data.work_date, 'Current shift': label(data.current_shift_id),
    'Requested shift': label(data.requested_shift_id), Reason: data.reason };
}

// GET /api/me — the linked employee (or null)
router.get('/', (req, res) => {
  res.json({ employee: me(req.user!.id) ?? null });
});

/* ─── Profile & contact details (self-service) ────────────────────────────────── */

// GET /api/me/profile — editable personal details + the read-only official record
router.get('/profile', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const official = queryOne<{ status: string; start_date: string | null }>('SELECT status, start_date FROM employees WHERE id = ?', emp.id);
  res.json({
    ...getProfile(emp.id),
    official: {
      name: emp.name, employee_no: emp.employee_no, position: emp.position,
      department: emp.department_name, status: official?.status ?? null, start_date: official?.start_date ?? null,
    },
  });
});

// PUT /api/me/profile — { current_password, preferred_name?, mobile_phone?, … } (partial).
// Re-authenticates with the password; unknown keys (legal name, position, pay…) are a 400.
// Contact changes clear HR verification and ping HR to re-verify.
router.put('/profile', syncClass('merge', { redact: ['current_password'] }), (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  // Offline, the change is recorded without the password (redacted): it is checked where the
  // change is made, and not again when the command is re-run on the host or the cloud.
  const reRun = reRunOfRecordedCommand();
  const { current_password, ...input } = parseBody(selfProfileSchema, reRun ? { ...req.body, current_password: '-' } : req.body);
  const user = queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id);
  // 400, not 401: the mobile API client treats 401 as "session expired" and signs the user out.
  if (!user || (!reRun && !bcrypt.compareSync(current_password, user.password_hash))) {
    res.status(400).json({ error: 'Current password is incorrect' }); return;
  }
  const values = Object.fromEntries(PROFILE_FIELDS.filter((k) => k in input).map((k) => [k, input[k] ?? null]));
  const result = updateProfile(emp.id, req.user!.id, values);
  if (result.changed.some((k) => k !== 'preferred_name')) {
    void notifyPermission('hr.manage', {
      // No phone screen for it: the push opens the notification itself; the desktop opens HR.
      title: 'Contact details updated', body: `${emp.name} — please verify`, link: { route: 'hr-employees', params: { id: emp.id } }, tag: 'profile-' + emp.id,
    });
  }
  res.json({ ...result, profile: getProfile(emp.id) });
});

// GET /api/me/profile/history — your own recent profile changes
router.get('/profile/history', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  res.json(profileHistory(emp.id));
});

/** A payslip is final once HR marks it Paid (POST /hr/payroll/:id/mark-paid, hr.manage): that
 *  lock is the only state regenerate/edit/delete all refuse, so its figures can't change after.
 *  Mere existence (a 'draft' from generate-payslips) never counts. While locked, updated_at is
 *  the moment it was marked paid (nothing else may touch the row). */
const isFinalPayslip = (status: string) => status === 'paid';

/** This employee's hr_payroll records: stamped with their employee_id, or (older payslips) carrying
 *  their current or any former name — so a rename never hides earlier payslips. */
function myPayslips(emp: Emp, id?: number): FormRecord[] {
  const form = queryOne<FormDefinition>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'");
  if (!form) return [];
  const names = [emp.name, ...previousNames(emp.id)];
  return queryAll<FormRecord>(
    `SELECT id, number, period, status, data, created_at, updated_at
     FROM form_records
     WHERE form_def_id = ?
       AND (json_extract(data, '$.employee_id') = ?
            OR (json_extract(data, '$.employee_id') IS NULL
                AND json_extract(data, '$.employee_name') IN (${names.map(() => '?').join(',')})))
       ${id != null ? 'AND id = ?' : ''}
     ORDER BY id DESC`,
    form.id, emp.id, ...names, ...(id != null ? [id] : [])
  );
}

// GET /api/me/payslips — release payroll details to employees only after payment.
router.get('/payslips', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  res.json(myPayslips(emp).filter((r) => isFinalPayslip(r.status)).map((r) => {
    const finalized = isFinalPayslip(r.status);
    return {
      ...r, data: parse(r.data), finalized,
      finalized_at: finalized ? r.updated_at : null,
      download_url: finalized ? `/me/payslips/${r.id}/pdf` : null,
    };
  }));
});

// GET /api/me/payslips/:id/pdf — download one of YOUR finalized payslips. Ownership and
// finalization are re-checked here at download time; every successful download is logged.
router.get('/payslips/:id/pdf', (req, res) => {
  const emp = me(req.user!.id);
  if (!needEmp(res, emp)) return;
  const rec = myPayslips(emp, Number(req.params.id))[0];
  // Someone else's payslip answers exactly like a missing one — no existence leak.
  if (!rec) { res.status(404).json({ error: 'Payslip not found' }); return; }
  if (!isFinalPayslip(rec.status)) {
    res.status(404).json({ error: 'Payslip not found' });
    return;
  }
  const def = queryOne<{ fields: string }>("SELECT fields FROM form_definitions WHERE slug = 'hr_payroll'");
  const labels: Record<string, string> = {};
  const fields = parse(def?.fields) as unknown;
  if (Array.isArray(fields)) for (const f of fields as Array<{ key: string; label?: string }>) if (f.label) labels[f.key] = f.label;
  const pdf = renderPayslipPdf({
    number: rec.number, data: parse(rec.data), finalizedAt: rec.updated_at ?? rec.created_at,
    company: getSetting<{ name?: string; address?: string }>('company_profile') ?? null, labels,
  });
  logEvent(req, { entity: 'payroll', entityId: rec.id, action: 'payslip-download', summary: `Downloaded payslip ${rec.number}` });
  const safe = String(rec.number).replace(/[^A-Za-z0-9-]+/g, '-');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="Payslip-${safe}.pdf"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(pdf);
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
  res.json({ default_shift: defShift, days: days.map(d => ({ ...d, is_working_day: scheduledLeaveDates(emp.id, [d.work_date]).length > 0 })) });
});

/** Slugs an employee may self-file from mobile. */
export { REQUEST_SLUGS } from '../modules/hr/request-policy';

// GET /api/me/request-types — the HR request forms available to file
router.get('/request-types', (_req, res) => {
  const rows = queryAll<FormDefinition>(
    `SELECT id, name, slug, icon, fields FROM form_definitions
     WHERE slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
     ORDER BY name`,
    ...REQUEST_SLUGS
  );
  res.json(rows.map((r) => {
    const fields = parse(r.fields) as Array<{ key: string }>;
    // overtime_request.approved_hours overrides PayrollPolicy.max_ot_hours for the day — it's
    // meant to be set by whoever approves the request (HR, when linking it to an attendance
    // day), not handed to the employee filing it, so it's stripped out of the self-file form
    // even though it's a normal field everywhere else (Data Forms, Daily Time's own quick-add).
    const internalFields = ['employee_id', 'approved_by', 'decided_by', 'decided_at', 'decision_note', 'leave_days_charged', 'charged_dates', 'leave_warnings'];
    if (r.slug === 'overtime_request') internalFields.push('approved_hours');
    const visibleFields = fields.filter((f) => !internalFields.includes(f.key));
    if (r.slug === 'leave_request' && !visibleFields.some(f => f.key === 'leave_dates')) visibleFields.push({ key: 'leave_dates', label: 'Selected dates (optional; replaces the range)', type: 'textarea' } as any);
    if (r.slug === 'schedule_change') {
      const shiftField = visibleFields.find(f => f.key === 'requested_shift_id');
      if (shiftField) (shiftField as any).options = queryAll<{ id: number; name: string; start_time: string; end_time: string }>(
        'SELECT id, name, start_time, end_time FROM shifts ORDER BY name, id').map(s => ({ value: String(s.id), label: `${s.name} · ${s.start_time}–${s.end_time}` }));
    }
    return { ...r, fields: visibleFields };
  }));
});

// GET /api/me/requests — records this user filed for any request form, newest first
router.post('/leave-preview', (req, res) => {
  const employee = me(req.user!.id);
  if (!needEmp(res, employee)) return;
  res.json(leavePreview(employee.id, req.body));
});
router.get('/requests', (req, res) => {
  const rows = queryAll<FormRecord & { form_name: string; slug: string }>(
    `SELECT fr.id, fr.number, fr.status, fr.data, fr.created_at, fr.updated_at,
            fd.name AS form_name, fd.slug
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN employees e ON ${requestEmployeeJoin}
     WHERE (fr.created_by = ? OR e.user_id = ?) AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
     ORDER BY fr.id DESC LIMIT 100`,
    req.user!.id, req.user!.id, ...REQUEST_SLUGS
  );
  res.json(rows.map((r) => { const data = parse(r.data); return { ...r, data, display_data: requestDisplayData(r.slug, data) }; }));
});

// POST /api/me/requests/:id/cancel — withdraw your own still-pending request
router.post('/requests/:id/cancel', syncClass('merge'), (req, res) => {
  const rec = queryOne<{ id: number; status: string; created_by: number | null; slug: string; employee_user_id: number | null }>(
    `SELECT fr.id, fr.status, fr.created_by, fd.slug, e.user_id AS employee_user_id
     FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN employees e ON ${requestEmployeeJoin}
     WHERE fr.id = ?`,
    Number(req.params.id)
  );
  if (!rec || (rec.created_by !== req.user!.id && rec.employee_user_id !== req.user!.id) || !REQUEST_SLUGS.includes(rec.slug)) {
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
router.post('/time-corrections', syncClass('merge'), (req, res) => {
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
  notifyApprovers(emp.department_id, { ...payload, link: { route: 'hr-approvals' } }, req.user!.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// POST /api/me/time-corrections/:id/cancel — withdraw your own pending fix
router.post('/time-corrections/:id/cancel', syncClass('merge'), (req, res) => {
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
  return approverDepartmentIds(userId);
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
  if (!isHrManager && !heads.length) { res.json({ can_approve: false, requests: [], time_corrections: [], history: [] }); return; }
  const inScope = (deptId: number | null) => isHrManager || (deptId != null && heads.includes(deptId));
  const departmentSQL = isHrManager ? '' : ` AND e.department_id IN (${heads.map(() => '?').join(',')})`;
  const departmentParams = isHrManager ? [] : heads;

  const reqRows = queryAll<FormRecord & { form_name: string; slug: string; filed_by: string | null; employee_name: string | null; department_id: number | null }>(
    `SELECT fr.id, fr.number, fr.status, fr.data, fr.created_at,
            fd.name AS form_name, fd.slug,
            u.full_name AS filed_by, e.name AS employee_name, e.department_id
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN users u ON u.id = fr.created_by
     LEFT JOIN employees e ON ${requestEmployeeJoin}
     WHERE fr.status = 'pending' AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
       AND CASE WHEN e.id IS NOT NULL THEN COALESCE(e.user_id, 0) ELSE COALESCE(fr.created_by, 0) END != ?
     ${departmentSQL}
     ORDER BY fr.id DESC LIMIT 200`,
    ...REQUEST_SLUGS, req.user!.id, ...departmentParams
  );
  const tcRows = queryAll<TimeCorrection & { employee_name: string; department_id: number | null }>(
    `SELECT tc.*, e.name AS employee_name, e.department_id
     FROM time_corrections tc JOIN employees e ON e.id = tc.employee_id
     WHERE tc.status = 'pending' AND (tc.user_id IS NULL OR tc.user_id != ?)
     ${departmentSQL}
     ORDER BY tc.id DESC LIMIT 200`,
    req.user!.id, ...departmentParams
  );
  res.json({
    // Information changes touch the official HR record, so only hr.manage sees/decides them.
    can_approve: isHrManager || heads.length > 0,
    history: [
      ...queryAll<FormRecord & { form_name: string; slug: string; employee_name: string | null; department_id: number | null }>(`SELECT fr.*, fd.name AS form_name, fd.slug, e.name AS employee_name, e.department_id FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id LEFT JOIN employees e ON ${requestEmployeeJoin} WHERE fr.status IN ('approved', 'rejected') AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')}) ${departmentSQL} ORDER BY fr.updated_at DESC LIMIT 100`, ...REQUEST_SLUGS, ...departmentParams)
        .filter(r => inScope(r.department_id) && (r.slug !== INFO_CHANGE_SLUG || isHrManager)).map(r => { const data = parse(r.data); return { ...r, kind: 'request', data, display_data: requestDisplayData(r.slug, data) }; }),
      ...queryAll<TimeCorrection & { employee_name: string; department_id: number | null; decided_by_name: string | null }>(`SELECT tc.*, e.name AS employee_name, e.department_id, u.full_name AS decided_by_name FROM time_corrections tc JOIN employees e ON e.id = tc.employee_id LEFT JOIN users u ON u.id = tc.decided_by WHERE tc.status IN ('approved', 'rejected') ${departmentSQL} ORDER BY tc.decided_at DESC LIMIT 100`, ...departmentParams).filter(r => inScope(r.department_id)).map(r => ({ ...r, kind: 'correction', form_name: 'Attendance correction', updated_at: r.decided_at }))
    ].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 100),
    requests: reqRows
      .filter((r) => inScope(r.department_id) && (r.slug !== INFO_CHANGE_SLUG || isHrManager))
      .map((r) => { const data = parse(r.data); return { ...r, data, display_data: requestDisplayData(r.slug, data) }; }),
    time_corrections: tcRows.filter((r) => inScope(r.department_id)),
  });
});

// POST /api/me/approvals/requests/:id/decide — { decision: 'approved'|'rejected', note?, override_balance? }
router.post('/approvals/requests/:id/decide', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const rec = queryOne<{
    id: number; status: string; created_by: number | null; data: string; slug: string; form_name: string;
    department_id: number | null; employee_id: number | null; employee_user_id: number | null; leave_days_per_year: number | null; leave_days_used: number | null;
  }>(
    `SELECT fr.id, fr.status, fr.created_by, fr.data, fd.slug, fd.name AS form_name,
            e.department_id, e.id AS employee_id, e.user_id AS employee_user_id, e.leave_days_per_year, e.leave_days_used
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN employees e ON ${requestEmployeeJoin}
     WHERE fr.id = ?`,
    id
  );
  if (!rec || !REQUEST_SLUGS.includes(rec.slug)) { res.status(404).json({ error: 'Request not found' }); return; }
  if ((rec.employee_id && rec.employee_user_id === req.user!.id) || (!rec.employee_id && rec.created_by === req.user!.id)) { res.status(403).json({ error: 'You can’t decide your own request' }); return; }
  if (!mayDecide(req, rec.department_id)) { res.status(403).json({ error: 'Not an approver for this request' }); return; }
  const infoChange = rec.slug === INFO_CHANGE_SLUG;
  if (infoChange && !req.user!.permissions.includes('hr.manage')) {
    res.status(403).json({ error: 'Only HR can decide information-change requests' }); return;
  }
  if (rec.status !== 'pending') {
    // Clash-check (D6): decided or withdrawn on the cloud meanwhile — the first outcome is kept.
    if (siteDecisionStands()) {
      recordSiteClash(req, `${rec.form_name} #${id} was already ${rec.status} on the cloud when the main site's decision arrived; ${rec.status} was kept.`);
      res.json({ ok: true, clash: true, status: rec.status });
      return;
    }
    res.status(400).json({ error: 'This request is no longer pending' }); return;
  }

  const { decision, note, override_balance } = parseBody(approvalDecisionSchema, req.body);
  let data = parse(rec.data);
  const expectedShift = data.current_shift_id;
  let warnings: string[] = [];
  if (decision === 'approved') {
    const fields = queryOne<{ fields: string }>('SELECT fd.fields FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?', id)?.fields;
    data = normalizeRequest(rec.slug, parse(fields || '[]') as any, data, Number(rec.employee_id));
    if (rec.slug === 'leave_request') warnings = leaveWarnings(Number(rec.employee_id), data, id);
  }

  // Information change: apply to the employee record and record the decision in ONE
  // transaction, re-checking pending inside it so a double-tap can't apply twice.
  if (infoChange) {
    let applied: ReturnType<typeof applyInfoChange> | null = null;
    db.exec('BEGIN');
    try {
      const still = queryOne<{ status: string }>('SELECT status FROM form_records WHERE id = ?', id);
      if (still?.status !== 'pending') { db.exec('ROLLBACK'); res.status(400).json({ error: 'This request is no longer pending' }); return; }
      // (A clash with the cloud was caught above, before the transaction.)
      if (decision === 'approved') {
        applied = applyInfoChange(data, req.user!.id);
        data.applied = applied.applied;
        if (applied.note) data.applied_note = applied.note;
      }
      data.decided_by = req.user!.full_name;
      data.decided_at = now().toISOString().slice(0, 16).replace('T', ' ');
      if (note) data.decision_note = note;
      run("UPDATE form_records SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?", decision, JSON.stringify(data), id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (rec.created_by) {
      void notifyUser(rec.created_by, {
        title: `Information change ${decision}`,
        body: String(data.field ?? rec.form_name) + (note ? ' — ' + note : ''),
        url: '#/requests', link: {route:'hr-requests',params:{id,kind:'request'}}, tag: 'req-' + id,
      });
    }
    res.json({ ok: true, status: decision, applied: applied?.applied ?? false, applied_note: applied?.note ?? null });
    return;
  }

  db.exec('BEGIN');
  try {
    if (decision === 'approved' && rec.slug === 'schedule_change') {
      const date = String(data.work_date);
      const row = queryOne<{ id: number; period_id: number; shift_id: number | null }>(
        'SELECT id, period_id, shift_id FROM attendance_records WHERE employee_id = ? AND work_date = ?', rec.employee_id, date);
      if (!row || date <= new Date().toISOString().slice(0, 10) || row.shift_id !== expectedShift || cutoffIsPaid(row.period_id)
          || !scheduledLeaveDates(Number(rec.employee_id), [date]).length) {
        db.exec('ROLLBACK');
        res.status(409).json({ error: 'The roster changed, the date passed, or payroll was paid. Review the current schedule and file a new request.' }); return;
      }
      run("UPDATE attendance_records SET shift_id = ?, updated_at = datetime('now') WHERE id = ?", Number(data.requested_shift_id), row.id);
      data.current_shift_id = expectedShift;
    }
    // Approving a paid Leave request consumes the employee's fixed leave-day bank. Blocked if it
    // would go negative, unless the approver explicitly overrides — a rejected decision, or one
    // where with_pay isn't 'Yes', never touches the balance (see docs on the "simple fixed bank"
    // design: no accrual math, no carry-over, one-way consumption with no un-approve path).
    if (decision === 'approved' && rec.slug === 'leave_request' && data.with_pay === 'Yes' && rec.employee_id) {
      const dates = scheduledLeaveDates(rec.employee_id, leaveDates(data));
      const alreadyCharged = new Set(overlappingLeave(rec.employee_id, dates, id)
        .filter(r => r.status === 'approved' && r.data.with_pay === 'Yes')
        .flatMap(r => String(r.data.charged_dates || r.dates.join(',')).split(',')));
      const chargedDates = dates.filter(d => !alreadyCharged.has(d));
      const days = chargedDates.length;
      data.charged_dates = chargedDates.join(','); data.leave_days_charged = days;
      if (days < dates.length) warnings.push(`${dates.length - days} date(s) are already covered by approved paid leave; they are not deducted twice.`);
      if (days > 0) {
        const remaining = (rec.leave_days_per_year ?? 5) - (rec.leave_days_used ?? 0);
        if (remaining - days < 0 && !override_balance) {
          // Clash-check (D6): the main site saw enough leave left; the cloud approved other leave
          // meanwhile. The approval stands and the balance goes below zero, flagged.
          if (!siteDecisionStands()) {
            db.exec('ROLLBACK');
            res.status(400).json({ error: `Requested ${days} day(s), only ${remaining} remaining. Approve anyway to override.` });
            return;
          }
          recordSiteClash(req, `Leave request #${id} was approved at the main site, but on the cloud only ${remaining} day(s) remained for ${days} requested; the balance is now below zero.`);
        }
        run('UPDATE employees SET leave_days_used = leave_days_used + ? WHERE id = ?', days, rec.employee_id);
      }
    }

    data.decided_by = req.user!.full_name;
    data.decided_at = now().toISOString().slice(0, 16).replace('T', ' ');
    if (note) data.decision_note = note;
    if (warnings.length) data.leave_warnings = warnings.join('\n');
    run("UPDATE form_records SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?", decision, JSON.stringify(data), id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (decision === 'approved' && rec.slug === 'leave_request') warnings.push(...attachLeave(id).warnings);
  if (rec.created_by) {
    void notifyUser(rec.created_by, {
      title: `Request ${decision}`,
      body: rec.form_name + (note ? ' — ' + note : ''),
      url: '#/requests',
      link: {route:'hr-requests',params:{id,kind:'request'}},
      tag: 'req-' + id,
    });
  }
  if (rec.employee_user_id && rec.employee_user_id !== rec.created_by) {
    void notifyUser(rec.employee_user_id, { title: `Request ${decision}`, body: rec.form_name + (note ? ' — ' + note : ''), url:'#/requests',link:{route:'hr-requests',params:{id,kind:'request'}},tag:'req-'+id });
  }
  if (!req.user!.permissions.includes('hr.manage')) {
    void notifyPermission('hr.manage', { title: `Department request ${decision}`, body: `${req.user!.full_name} — ${rec.form_name}${note ? ' — ' + note : ''}`, url: '#/approvals', link: { route: 'hr-approvals', params:{id,kind:'request',tab:'recent'} }, tag: 'hr-decision-' + id });
  }
  res.json({ ok: true, status: decision, warnings, leave_days_charged: data.leave_days_charged });
});

// POST /api/me/approvals/time-corrections/:id/decide — { decision, note? }
router.post('/approvals/time-corrections/:id/decide', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const tc = queryOne<TimeCorrection & { department_id: number | null }>(
    `SELECT tc.*, e.department_id FROM time_corrections tc
     JOIN employees e ON e.id = tc.employee_id WHERE tc.id = ?`,
    id
  );
  if (!tc) { res.status(404).json({ error: 'Correction not found' }); return; }
  if (tc.user_id === req.user!.id) { res.status(403).json({ error: 'You can’t decide your own correction' }); return; }
  if (!mayDecide(req, tc.department_id ?? null)) { res.status(403).json({ error: 'Not an approver for this correction' }); return; }
  if (tc.status !== 'pending') {
    // Clash-check (D6): decided or withdrawn on the cloud meanwhile — the first outcome is kept.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Time fix #${id} (${tc.work_date}) was already ${tc.status} on the cloud when the main site's decision arrived; ${tc.status} was kept.`);
      res.json({ ok: true, clash: true, status: tc.status, applied: false });
      return;
    }
    res.status(400).json({ error: 'This correction is no longer pending' }); return;
  }

  const { decision, note } = parseBody(approvalDecisionSchema, req.body);
  const correctionPeriod = queryOne<{ id: number }>('SELECT id FROM attendance_periods WHERE ? BETWEEN start_date AND end_date ORDER BY id DESC LIMIT 1', tc.work_date);
  if (decision === 'approved' && correctionPeriod && cutoffIsPaid(correctionPeriod.id)) {
    res.status(423).json({ error: 'This cutoff is locked after payment. Payroll must unmark its paid payslips before an attendance correction can be applied.' }); return;
  }
  let applied = false;
  db.exec('BEGIN');
  try {
    run(
      "UPDATE time_corrections SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?",
      decision, req.user!.id, note || null, id
    );
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
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (tc.user_id) {
    void notifyUser(tc.user_id, {
      title: `Time fix ${decision}`,
      body: tc.work_date + (note ? ' — ' + note : ''),
      url: '#/time-fix',
      link: {route:'hr-requests',params:{id,kind:'correction'}},
      tag: 'tc-' + id,
    });
  }
  if (!req.user!.permissions.includes('hr.manage')) {
    void notifyPermission('hr.manage', { title: `Department time correction ${decision}`, body: `${req.user!.full_name} — ${tc.work_date}${note ? ' — ' + note : ''}`, url: '#/approvals', link: { route: 'hr-approvals', params:{id,kind:'correction',tab:'recent'} }, tag: 'hr-correction-' + id });
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
    shift_start: string | null; shift_end: string | null;
    form_slugs: string | null; form_datas: string | null;
  }>(
    `SELECT ar.work_date, ar.time_in, ar.time_out, p.label AS period_label,
       s.start_time AS shift_start, s.end_time AS shift_end,
       (SELECT group_concat(fd.slug, char(30)) FROM json_each(COALESCE(ar.form_record_ids, json_array(ar.form_record_id))) je
          JOIN form_records fr ON fr.id = je.value JOIN form_definitions fd ON fd.id = fr.form_def_id) AS form_slugs,
       (SELECT group_concat(fr.data, char(30)) FROM json_each(COALESCE(ar.form_record_ids, json_array(ar.form_record_id))) je
          JOIN form_records fr ON fr.id = je.value) AS form_datas
     FROM attendance_records ar
     JOIN attendance_periods p ON p.id = ar.period_id
     LEFT JOIN shifts s ON s.id = ar.shift_id
     WHERE ar.employee_id = ? AND ar.time_in IS NOT NULL AND ar.time_out IS NOT NULL
       AND ar.work_date >= date('now', 'localtime', '-45 days')
     ORDER BY ar.work_date DESC`,
    employeeId
  );
  const policy = currentPolicy();
  // Dates this employee has ALREADY filed an Overtime Request for (any live status) — even if
  // HR hasn't linked it to the attendance day yet. Suppresses the nudge the moment they file,
  // so the payslip callout / Home stack item don't keep pestering about something handled.
  const empName = queryOne<{ name: string }>('SELECT name FROM employees WHERE id = ?', employeeId)?.name ?? '';
  const filedOtDates = new Set(
    queryAll<{ data: string }>(
      `SELECT fr.data FROM form_records fr
       JOIN form_definitions fd ON fd.id = fr.form_def_id
       WHERE fd.slug = 'overtime_request' AND fr.status NOT IN ('rejected', 'cancelled')`
    )
      .map((r) => { try { return JSON.parse(r.data) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => !!x && String(x.employee_name ?? '').trim() === empName.trim())
      .map((x) => String(x.work_date ?? x.date ?? ''))
      .filter(Boolean)
  );
  const out: UnrecordedOtDay[] = [];
  for (const r of rows) {
    if (filedOtDates.has(r.work_date)) continue;
    const slugs = r.form_slugs ? r.form_slugs.split('\x1e') : [];
    const datas = r.form_datas ? r.form_datas.split('\x1e') : [];
    const linkedForms = slugs.map((slug, i) => {
      try { return { slug, data: JSON.parse(datas[i] || '{}') }; } catch { return { slug, data: {} }; }
    });
    const day: AttendanceDay = {
      work_date: r.work_date, time_in: r.time_in, time_out: r.time_out,
      shift: r.shift_start && r.shift_end ? { start_time: r.shift_start, end_time: r.shift_end } : null,
      linkedForms,
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
  const stack: StackItem[] = [];
  const emp = me(req.user!.id);
  // The employee's self-chosen preferred name wins; otherwise the account name's first word.
  const firstName = emp?.preferred_name || (req.user!.full_name || req.user!.username || '').trim().split(/\s+/)[0];

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
       LEFT JOIN employees e ON ${requestEmployeeJoin}
       WHERE fr.status = 'pending' AND fd.slug IN (${REQUEST_SLUGS.map(() => '?').join(',')})
         AND CASE WHEN e.id IS NOT NULL THEN COALESCE(e.user_id, 0) ELSE COALESCE(fr.created_by, 0) END != ?`,
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
