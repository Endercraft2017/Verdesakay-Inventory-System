/** Job-order parts release slips — the numbered record (PRS-#####) of each parts kit the
 *  warehouse handed to production. Mounted at /api/parts-slips. Read-only: a slip is issued
 *  by POST /api/job-orders/:id/release (job-orders.routes.ts), which is also when the
 *  components leave stock. Photos of the kit are `attachments` kind 'parts_release' on the
 *  slip id. The slip is a record in the app (paperless); /:id/print is the printable copy. */
import { Router } from 'express';
import { queryOne, queryAll } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { partsSlipHtml } from './parts-slip-print';
import type { PartsReleaseSlip, PartsReleaseSlipItem } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const readGate = requireAnyPermission(['inventory.view', 'production.view']); // stock documents: warehouse or production

const SLIP_SELECT = `
  SELECT s.*, j.number AS job_order_number, j.product_name, j.qty_ordered,
         l.name AS source_location_name, u.full_name AS released_by_name,
         (SELECT COUNT(*) FROM attachments a WHERE a.kind = 'parts_release' AND a.ref_id = s.id) AS photo_count
  FROM parts_release_slips s
  JOIN job_orders j ON j.id = s.job_order_id
  LEFT JOIN locations l ON l.id = j.source_location_id
  LEFT JOIN users u ON u.id = s.released_by`;

function loadSlip(id: number): PartsReleaseSlip | null {
  const slip = queryOne<PartsReleaseSlip>(`${SLIP_SELECT} WHERE s.id = ?`, id);
  if (!slip) return null;
  slip.items = queryAll<PartsReleaseSlipItem>('SELECT * FROM parts_release_slip_items WHERE slip_id = ? ORDER BY id', id);
  return slip;
}

// GET /api/parts-slips?q=&job_order_id= — issued slips, newest first
router.get('/', readGate, (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    where.push('(s.number LIKE ? OR j.number LIKE ? OR j.product_name LIKE ? OR s.received_by LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.job_order_id) { where.push('s.job_order_id = ?'); params.push(Number(req.query.job_order_id)); }
  res.json(queryAll<PartsReleaseSlip>(
    `${SLIP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 500`, ...params
  ));
});

// GET /api/parts-slips/:id — slip + its line snapshot
router.get('/:id', readGate, (req, res) => {
  const slip = loadSlip(Number(req.params.id));
  if (!slip) { res.status(404).json({ error: 'Parts release slip not found' }); return; }
  res.json(slip);
});

// GET /api/parts-slips/:id/print — printable HTML copy
router.get('/:id/print', readGate, (req, res) => {
  const slip = loadSlip(Number(req.params.id));
  if (!slip) { res.status(404).json({ error: 'Parts release slip not found' }); return; }
  res.type('html').send(partsSlipHtml(slip));
});

export default router;
