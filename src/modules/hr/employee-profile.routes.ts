/** HR side of employee self-service profiles. Mounted at /api/hr/employee-profiles.
 *    GET  /                     hr.view   — employees whose contact details await verification
 *    GET  /:employeeId          hr.view   — profile + change history
 *    POST /:employeeId/verify   hr.manage — confirm the current contact details */
import { Router } from 'express';
import { queryOne } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { getProfile, verifyProfile, profileHistory, unverifiedProfiles } from './employee-profile';

const router = Router();
router.use(requireAuth);

router.get('/', requirePermission('hr.view'), (_req, res) => {
  res.json(unverifiedProfiles());
});

router.get('/:employeeId', requirePermission('hr.view'), (req, res) => {
  const id = Number(req.params.employeeId);
  const emp = queryOne<{ id: number; name: string }>('SELECT id, name FROM employees WHERE id = ?', id);
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
  res.json({ employee: emp, profile: getProfile(id), history: profileHistory(id) });
});

router.post('/:employeeId/verify', requirePermission('hr.manage'), (req, res) => {
  const id = Number(req.params.employeeId);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', id)) { res.status(404).json({ error: 'Employee not found' }); return; }
  const profile = verifyProfile(id, req.user!.id);
  if (!profile) { res.status(400).json({ error: 'This employee has no contact details to verify yet' }); return; }
  res.json(profile);
});

export default router;
