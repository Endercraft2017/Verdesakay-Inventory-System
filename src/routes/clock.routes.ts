/** Time clock. Mounted at /api/hr/clock.
 *  - GET  /code            kiosk screen: the current rotating code (hr.view)
 *  - GET  /recent          kiosk screen: recent punches, for the chime + live log (hr.view)
 *  - POST /kiosk-punch      phone-less staff type their employee no. at the kiosk (hr.view)
 *  - POST /correct          kiosk's click-to-fix flow: set one of the day's 4 slots to now,
 *                            confirmed by the employee's own number (hr.view). See correctPunch
 *                            in clock.ts -- also the only way to log more time (e.g. OT) once
 *                            the day's final out already happened.
 *  - POST /photo/:punchId,
 *    GET  /photo/:id        kiosk camera capture per punch -- see src/punch-photos.ts (hr.view)
 *  - POST /punch            an employee scans the kiosk QR from the mobile app (any linked user)
 *  - GET  /my-status        that employee's clock state today (any linked user)
 *  - POST /import/:periodId backfill/catch-up: pull any punches recorded before an employee was
 *                            added to this period's roster into attendance_records (hr.manage).
 *                            Ongoing punches during an open period fill in live — see
 *                            applyPunchToAttendance in clock.ts — so this is only needed to
 *                            catch punches that predate the roster row existing at all.
 */
import { Router } from 'express';
import { queryOne, queryAll } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, phonePunchSchema, kioskPunchSchema, kioskCorrectSchema } from '../validation';
import {
  currentKioskCode, isValidKioskCode, recordPunch, correctPunch, myClockStatus,
  importPunchesForPeriod, ROTATE_SECONDS,
} from '../clock';
import { punchPhotoRoutes } from '../punch-photos';

const router = Router();
router.use(requireAuth);

interface EmpRow { id: number; name: string; user_id: number | null; status: string }

function linkedEmployee(userId: number): EmpRow | undefined {
  return queryOne<EmpRow>('SELECT id, name, user_id, status FROM employees WHERE user_id = ?', userId);
}

// --- Kiosk screen (office PC, logged in as HR/admin) ---

router.get('/code', requirePermission('hr.view'), (_req, res) => {
  res.json({ ...currentKioskCode(), rotate_seconds: ROTATE_SECONDS });
});

router.get('/recent', requirePermission('hr.view'), (req, res) => {
  const sinceId = Number(req.query.since_id) || 0;
  const rows = queryAll<{
    id: number; ts: string; kind: string; segment: string; source: string; name: string; employee_no: string | null;
  }>(
    `SELECT p.id, p.ts, p.kind, p.segment, p.source, e.name, e.employee_no
     FROM time_punches p JOIN employees e ON e.id = p.employee_id
     WHERE p.id > ? ORDER BY p.id DESC LIMIT 20`,
    sinceId
  );
  res.json(rows);
});

router.post('/kiosk-punch', requirePermission('hr.view'), (req, res) => {
  const { code, employee_no } = parseBody(kioskPunchSchema, req.body);
  if (!isValidKioskCode(code)) {
    res.status(400).json({ error: 'That code is not current. Use the code on the screen.' });
    return;
  }
  const emp = queryOne<EmpRow & { employee_no: string }>(
    'SELECT id, name, user_id, status, employee_no FROM employees WHERE employee_no = ? COLLATE NOCASE',
    employee_no
  );
  if (!emp) {
    res.status(404).json({ error: `No employee with number "${employee_no}".` });
    return;
  }
  if (emp.status === 'resigned' || emp.status === 'terminated') {
    res.status(403).json({ error: 'That employee record is inactive.' });
    return;
  }
  res.json(recordPunch(emp, 'kiosk', null));
});

router.post('/correct', requirePermission('hr.view'), (req, res) => {
  const { code, employee_no, slot } = parseBody(kioskCorrectSchema, req.body);
  if (!isValidKioskCode(code)) {
    res.status(400).json({ error: 'That code is not current. Use the code on the screen.' });
    return;
  }
  const emp = queryOne<EmpRow & { employee_no: string }>(
    'SELECT id, name, user_id, status, employee_no FROM employees WHERE employee_no = ? COLLATE NOCASE',
    employee_no
  );
  if (!emp) {
    res.status(404).json({ error: `No employee with number "${employee_no}".` });
    return;
  }
  if (emp.status === 'resigned' || emp.status === 'terminated') {
    res.status(403).json({ error: 'That employee record is inactive.' });
    return;
  }
  res.json(correctPunch(emp, slot, 'kiosk'));
});

router.use('/photo', punchPhotoRoutes('attendance', (punchId) =>
  queryOne<{ employee_id: number }>('SELECT employee_id FROM time_punches WHERE id = ?', punchId)
));

// --- Employee, from the mobile app ---

router.post('/punch', (req, res) => {
  const { code } = parseBody(phonePunchSchema, req.body);
  const emp = linkedEmployee(req.user!.id);
  if (!emp) {
    res.status(403).json({ error: 'Your account is not linked to an employee record. Ask HR to link it.' });
    return;
  }
  if (emp.status === 'resigned' || emp.status === 'terminated') {
    res.status(403).json({ error: 'Your employee record is inactive.' });
    return;
  }
  if (!isValidKioskCode(code)) {
    res.status(400).json({ error: 'That code has expired — scan the one on the office screen now.' });
    return;
  }
  res.json(recordPunch(emp, 'phone', req.user!.id));
});

router.get('/my-status', (req, res) => {
  const emp = linkedEmployee(req.user!.id);
  if (!emp) {
    res.status(403).json({ error: 'Your account is not linked to an employee record.' });
    return;
  }
  res.json({ employee_name: emp.name, ...myClockStatus(emp.id) });
});

// --- HR reconciliation ---

router.post('/import/:periodId', requirePermission('hr.manage'), (req, res) => {
  const periodId = Number(req.params.periodId);
  if (!queryOne('SELECT id FROM attendance_periods WHERE id = ?', periodId)) {
    res.status(404).json({ error: 'Cutoff period not found' });
    return;
  }
  res.json({ ok: true, ...importPunchesForPeriod(periodId) });
});

export default router;
