/** Admin-to-owner support. Cloud-only control-plane records, never employee reports. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requirePermission } from '../shared/auth';
import { currentSlug } from './quota';
import { getTenant } from './platform';
import { addSupport, listSupport, replySupport } from './owner-analytics';
import { DEPLOY_MODE, isInstalledCopy, syncClass } from '../sync';
const router = Router();
router.use(requireAuth, requirePermission('workspace.manage'));
router.use((_req, res, next) => {
  if (DEPLOY_MODE === 'node' || isInstalledCopy()) {
    res.status(503).json({ error: 'Open your online tenant workspace to contact OTOM support.' }); return;
  }
  if (!getTenant(currentSlug())) {
    res.status(409).json({ error: 'Support requires a registered tenant workspace.' }); return;
  }
  next();
});
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `${currentSlug()}:${req.user!.id}`, skip: () => process.env.NODE_ENV === 'test' });
router.get('/', (_req, res) => { res.json(listSupport(currentSlug(), true)); });
router.post('/', limiter, syncClass('online'), (req, res) => {
  try {
    const id = addSupport(currentSlug(), req.body, req.user!.username, 'tenant');
    res.status(201).json({ id });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/:id/replies', limiter, syncClass('online'), (req, res) => {
  try {
    if (!replySupport(currentSlug(), Number(req.params.id), req.body, req.user!.username, 'tenant')) {
      res.status(404).json({ error: 'Unknown ticket.' }); return;
    }
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
export default router;
