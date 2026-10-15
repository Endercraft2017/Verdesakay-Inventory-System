import { Router } from 'express';
import { parseBody } from '../shared/validation';
import { getTenant } from './platform';
import type { PlatformAuthedRequest } from './platform-users';
import { setupInvoiceSchema, setupInvoiceActionSchema, listSetupInvoices, createSetupInvoice, updateSetupInvoice } from './setup-invoices';

// Mounted after host and operator auth checks in platform.routes.ts.
const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  const slug = (req.params as { slug: string }).slug;
  const t = getTenant(slug);
  if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown workspace.' }); return; }
  next();
});
router.get('/', (req, res) => {
  res.json(listSetupInvoices((req.params as { slug: string }).slug));
});
router.post('/', (req, res, next) => {
  try {
    const input = parseBody(setupInvoiceSchema, req.body);
    res.status(201).json(createSetupInvoice((req.params as { slug: string }).slug, input, (req as PlatformAuthedRequest).platformUser!.username));
  } catch (e) { next(e); }
});
router.patch('/:id', (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
      res.status(400).json({ error: 'Invalid invoice ID.' }); return;
    }
    const input = parseBody(setupInvoiceActionSchema, req.body);
    res.json(updateSetupInvoice((req.params as unknown as { slug: string }).slug, Number(req.params.id), input, (req as PlatformAuthedRequest).platformUser!.username));
  } catch (e) { next(e); }
});
export default router;
