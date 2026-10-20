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
 *  - POST /punch/scan       phone punch step 1: an employee scans the kiosk QR from the mobile app
 *                            (any linked user); with the office location lock on, the phone's GPS
 *                            must be on-site. Staff exempt from the lock (clock_anywhere) may omit
 *                            the QR and punch from anywhere, location recorded. See clock-geofence.ts.
 *                            Parks a hold stamped with the scan time -- see punch-holds.ts.
 *  - POST /punch/selfie     phone punch step 2: the selfie (multipart "photo") records the held scan in
 *                            the slot the employee picked (`slot`: in|lunchOut|lunchIn|out; re-doing
 *                            a slot replaces its time and photo), at the scan time, with the photo
 *                            kept beside it -- see setSlotPunch in clock.ts.
 *  - POST /punch            retired one-step phone punch: 410, tells an outdated app to update.
 *  - GET  /my-status        that employee's clock state today (any linked user)
 *  - GET/PUT /geofence      the office location lock: sites + radius (hr.view / hr.manage)
 *  - GET  /punches          Punch Log: punches in a work-date range with their location (hr.view)
 *  - GET /kiosk-devices, POST /kiosk-devices, DELETE /kiosk-devices/:id, PUT /kiosk-lock
 *                            approved kiosk devices (hr.view to see, hr.manage to change). With
 *                            the kiosk lock on, /code, /kiosk-punch and /correct (and the field
 *                            kiosk punch) only answer an approved browser. See kiosk-devices.ts.
 *  - POST /import/:periodId backfill/catch-up: pull any punches recorded before an employee was
 *                            added to this period's roster into attendance_records (hr.manage).
 *                            Ongoing punches during an open period fill in live — see
 *                            applyPunchToAttendance in clock.ts — so this is only needed to
 *                            catch punches that predate the roster row existing at all.
 */
import fs from 'node:fs';
import { cutoffIsPaid } from './workflow';
import { Router, type Request, type Response } from 'express';
import { queryOne, queryAll } from '../../shared/db';
import { requireAuth, requirePermission, deviceUsualUserId } from '../../shared/auth';
import { deviceIdOf } from '../../shared/device';
import {
  parseBody, phonePunchSchema, phoneSelfieSchema, kioskPunchSchema, kioskCorrectSchema, clockGeofenceSchema, kioskDeviceSchema, kioskLockSchema,
  punchLogQuerySchema,
} from '../../shared/validation';
import { checkPunchLocation, GeofenceError, geofenceActive, getGeofence, setGeofence } from './clock-geofence';
import {
  requireKioskDevice, kioskDeviceFor, kioskLockActive, kioskLockSetting, setKioskLock,
  listKioskDevices, approveKioskDevice, revokeKioskDevice,
} from './kiosk-devices';
import {
  currentKioskCode, isValidKioskCode, recordPunch, correctPunch, myClockStatus, recordedBrackets,
  importPunchesForPeriod, ROTATE_SECONDS, punchBlockedReason, setSlotPunch, phoneSlots,
  type PunchDevice, type CorrectionSlot,
} from './clock';
import { photoIdsForPunches, punchPhotoRoutes, punchPhotoUpload, punchPhotoUploadErrors, savePunchPhoto } from './punch-photos';
import { createPunchHold, takePunchHold, holdGeo } from './punch-holds';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);

interface EmpRow { id: number; name: string; user_id: number | null; status: string; clock_anywhere?: number }

function linkedEmployee(userId: number): EmpRow | undefined {
  return queryOne<EmpRow>('SELECT id, name, user_id, status, clock_anywhere FROM employees WHERE user_id = ?', userId);
}

// --- Kiosk screen (office PC, logged in as HR/admin) ---

// Punch Log (Time Keeping → Punch Log): raw punches in a work-date range, with where each phone
// punch came from — for HR to review remote punches and anything far from the office.
router.get('/punches', requirePermission('hr.view'), (req, res) => {
  const { from, to, source } = parseBody(punchLogQuerySchema, req.query);
  const where = ['p.work_date BETWEEN ? AND ?'];
  const params: unknown[] = [from, to];
  if (source) { where.push('p.source = ?'); params.push(source); }
  res.json(queryAll(
    `SELECT p.id, p.ts, p.work_date, p.kind, p.segment, p.source, p.lat, p.lng, p.accuracy_m, p.distance_m, p.geo_site,
            p.device_flag, du.full_name AS device_user_name, ph.id AS photo_id,
            e.name, e.employee_no
     FROM time_punches p JOIN employees e ON e.id = p.employee_id
     LEFT JOIN users du ON du.id = p.device_user_id
     LEFT JOIN punch_photos ph ON ph.punch_kind = 'attendance' AND ph.punch_id = p.id
     WHERE ${where.join(' AND ')} ORDER BY p.ts DESC, p.id DESC LIMIT 1000`,
    ...params
  ));
});

// --- Approved kiosk devices (see kiosk-devices.ts) ---

// The kiosk screen asks this first: is the lock on, and is THIS browser approved?
router.get('/kiosk-devices', requirePermission('hr.view'), (req, res) => {
  const current = kioskDeviceFor(req.get('x-kiosk-token'));
  res.json({
    lock_active: kioskLockActive(),
    lock_setting: kioskLockSetting(), // null = following the hosting default
    this_device: current ?? null,
    devices: listKioskDevices(),
  });
});

router.post('/kiosk-devices', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const { name } = parseBody(kioskDeviceSchema, req.body);
  res.status(201).json(approveKioskDevice(name, req.user!.id));
});

router.delete('/kiosk-devices/:id', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  if (!revokeKioskDevice(Number(req.params.id))) { res.status(404).json({ error: 'Kiosk device not found' }); return; }
  res.json({ ok: true });
});

router.put('/kiosk-lock', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const { enabled } = parseBody(kioskLockSchema, req.body);
  setKioskLock(enabled);
  res.json({ lock_active: kioskLockActive(), lock_setting: kioskLockSetting() });
});

router.get('/code', requirePermission('hr.view'), requireKioskDevice, (_req, res) => {
  res.json({ ...currentKioskCode(), rotate_seconds: ROTATE_SECONDS });
});

router.get('/recent', requirePermission('hr.view'), (req, res) => {
  const sinceId = Number(req.query.since_id) || 0;
  const rows = queryAll<{
    id: number; ts: string; kind: string; segment: string; source: string; name: string; employee_no: string | null;
    employee_id: number; work_date: string; lat: number | null; lng: number | null; distance_m: number | null; geo_site: string | null;
  }>(
    `SELECT p.id, p.ts, p.kind, p.segment, p.source, e.name, e.employee_no, p.lat, p.lng, p.distance_m, p.geo_site,
            p.employee_id, p.work_date
     FROM time_punches p JOIN employees e ON e.id = p.employee_id
     WHERE p.id > ? ORDER BY p.id DESC LIMIT 20`,
    sinceId
  );
  const photos = photoIdsForPunches('attendance', rows.map((r) => r.id));
  // What the day's grid row already holds (incl. times HR typed in), so the kiosk card can show
  // an HR-entered time-in that has no punch of its own.
  res.json(rows.map(({ employee_id, work_date, ...r }) => ({ ...r, photo_id: photos.get(r.id) ?? null, recorded: recordedBrackets(employee_id, work_date) })));
});

router.post('/kiosk-punch', requirePermission('hr.view'), requireKioskDevice, syncClass('physical'), (req, res) => {
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
  const blockedKiosk = punchBlockedReason(emp.status, 'kiosk');
  if (blockedKiosk) {
    res.status(403).json({ error: blockedKiosk });
    return;
  }
  res.json(recordPunch(emp, 'kiosk', null));
});

router.post('/correct', requirePermission('hr.view'), requireKioskDevice, syncClass('physical'), (req, res) => {
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
  const blockedKiosk = punchBlockedReason(emp.status, 'kiosk');
  if (blockedKiosk) {
    res.status(403).json({ error: blockedKiosk });
    return;
  }
  res.json(correctPunch(emp, slot, 'kiosk'));
});

router.use('/photo', punchPhotoRoutes('attendance', (punchId) =>
  queryOne<{ employee_id: number }>('SELECT employee_id FROM time_punches WHERE id = ?', punchId)
));

// --- Employee, from the mobile app ---

// The employee behind a phone request, or why they can't punch (the response is already sent).
function phoneEmployee(req: Request, res: Response): EmpRow | undefined {
  const emp = linkedEmployee(req.user!.id);
  if (!emp) {
    res.status(403).json({ error: 'Your account is not linked to an employee record. Ask HR to link it.' });
    return undefined;
  }
  const blockedSelf = punchBlockedReason(emp.status, 'self');
  if (blockedSelf) {
    res.status(403).json({ error: blockedSelf });
    return undefined;
  }
  return emp;
}

// A phone punch is two steps (punch-holds.ts): scan, then selfie. The old one-step route answers
// an out-of-date app with what to do instead of recording a punch with no selfie.
router.post('/punch', (_req, res) => {
  res.status(410).json({ error: 'Time-in now needs a selfie. Close and reopen the app to update it, then try again.' });
});

// Step 1. With the kiosk QR (`code`), or — only for employees exempt from the office location
// lock (clock_anywhere) — without it, from wherever they are. Every check a punch needs happens
// here (location rules: clock-geofence.ts's checkPunchLocation); passing them parks a hold
// stamped with the server's time, which the selfie turns into the punch.
router.post('/punch/scan', syncClass('physical'), (req, res) => {
  const { code, location } = parseBody(phonePunchSchema, req.body);
  const emp = phoneEmployee(req, res);
  if (!emp) return;
  if (code === undefined && !emp.clock_anywhere) {
    res.status(400).json({ error: 'Scan the code on the office time-in screen.' });
    return;
  }
  if (code !== undefined && !isValidKioskCode(code)) {
    res.status(400).json({ error: 'That code has expired — scan the one on the office screen now.' });
    return;
  }
  let geo;
  try {
    geo = checkPunchLocation({ exempt: !!emp.clock_anywhere, hasCode: code !== undefined, location: location ?? null });
  } catch (e) {
    if (e instanceof GeofenceError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
  res.json(createPunchHold(emp.id, req.user!.id, code === undefined ? 'remote' : 'phone', geo));
});

// Step 2. The selfie (multipart "photo", JPEG) records the held scan in the slot the employee
// picked, at the time of the scan, and keeps the photo with it -- HR sees it beside the punch
// like a kiosk photo. Re-doing a slot moves that punch and replaces its photo (setSlotPunch).
router.post('/punch/selfie', syncClass('physical'), punchPhotoUpload, (req, res) => {
  const discard = () => { if (req.file) fs.promises.unlink(req.file.path).catch(() => { /* ignore */ }); };
  const emp = phoneEmployee(req, res);
  if (!emp) { discard(); return; }
  let hold_id: number;
  let slot: CorrectionSlot;
  try { ({ hold_id, slot } = parseBody(phoneSelfieSchema, req.body)); } catch (e) { discard(); throw e; }
  if (!req.file) {
    res.status(400).json({ error: 'Take a selfie to finish your time-in.' });
    return;
  }
  const hold = takePunchHold(hold_id, emp.id);
  if (!hold) {
    discard();
    res.status(400).json({ error: 'That scan has expired — scan the office code again.' });
    return;
  }
  let punch;
  try {
    punch = setSlotPunch(emp, slot, hold.source, {
      at: new Date(hold.scanned_ms), userId: req.user!.id, geo: holdGeo(hold), device: punchDevice(req),
    });
  } catch (e) {
    discard();
    throw e;
  }
  const photo = savePunchPhoto('attendance', punch.id, emp.id, req.file.path, req.file.size);
  res.json({ ...punch, photo_id: photo.id });
});
router.use(punchPhotoUploadErrors);

/** Flag a phone punch made on a borrowed phone, or on a device another account usually uses. */
function punchDevice(req: Request): PunchDevice {
  const deviceId = deviceIdOf(req) ?? req.authSession?.device_id ?? null;
  const usual = deviceUsualUserId(deviceId);
  if (req.authSession?.shared) return { device_id: deviceId, flag: 'borrowed', usual_user_id: usual };
  if (usual !== null && usual !== req.user!.id) return { device_id: deviceId, flag: 'other_user', usual_user_id: usual };
  return { device_id: deviceId, flag: null, usual_user_id: null };
}

router.get('/my-status', (req, res) => {
  const emp = linkedEmployee(req.user!.id);
  if (!emp) {
    res.status(403).json({ error: 'Your account is not linked to an employee record.' });
    return;
  }
  res.json({
    employee_name: emp.name,
    ...myClockStatus(emp.id),
    ...phoneSlots(emp.id), // the four slot tiles + the suggested next one
    // The phone asks for GPS before a QR punch when this is on, and offers a no-QR
    // "clock in here" button when the employee may clock in anywhere.
    location_required: geofenceActive() && !emp.clock_anywhere,
    can_clock_anywhere: !!emp.clock_anywhere,
  });
});

// --- Office location lock settings (Time Keeping → Policy Settings) ---

router.get('/geofence', requirePermission('hr.view'), (_req, res) => {
  res.json(getGeofence());
});

router.put('/geofence', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  res.json(setGeofence(parseBody(clockGeofenceSchema, req.body)));
});

// --- HR reconciliation ---

router.post('/import/:periodId', requirePermission('hr.manage'), syncClass('claim'), (req, res) => {
  const periodId = Number(req.params.periodId);
  if (!queryOne('SELECT id FROM attendance_periods WHERE id = ?', periodId)) {
    res.status(404).json({ error: 'Cutoff period not found' });
    return;
  }
  if (cutoffIsPaid(periodId)) { res.status(423).json({ error: 'This cutoff is locked after payment.' }); return; }
  res.json({ ok: true, ...importPunchesForPeriod(periodId) });
});

export default router;
