/** Field-work log. Mounted at /api/hr/field.
 *  - GET  /recent       kiosk screen: recent field out/in events, for the "Field Work" tab (hr.view)
 *  - POST /kiosk-punch  guard types the employee no. to log heading out / coming back (hr.view)
 *  - POST /photo/:punchId,
 *    GET  /photo/:id    kiosk camera capture per punch -- see src/punch-photos.ts (hr.view)
 */
import { Router } from 'express';
import { queryOne, queryAll } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, kioskPunchSchema } from '../../shared/validation';
import { isValidKioskCode } from './clock';
import { recordFieldPunch } from './field';
import { punchPhotoRoutes } from './punch-photos';

const router = Router();
router.use(requireAuth);

interface EmpRow { id: number; name: string; status: string; employee_no: string }

router.get('/recent', requirePermission('hr.view'), (req, res) => {
  const sinceId = Number(req.query.since_id) || 0;
  const rows = queryAll<{
    id: number; ts: string; kind: string; source: string; name: string; employee_no: string | null;
  }>(
    `SELECT p.id, p.ts, p.kind, p.source, e.name, e.employee_no
     FROM field_punches p JOIN employees e ON e.id = p.employee_id
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
  const emp = queryOne<EmpRow>(
    'SELECT id, name, status, employee_no FROM employees WHERE employee_no = ? COLLATE NOCASE',
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
  res.json(recordFieldPunch(emp, 'kiosk'));
});

router.use('/photo', punchPhotoRoutes('field', (punchId) =>
  queryOne<{ employee_id: number }>('SELECT employee_id FROM field_punches WHERE id = ?', punchId)
));

export default router;
