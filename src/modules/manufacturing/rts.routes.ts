/** /api/rts — the mobile RTS (ready-to-sell) desk (Figma 74:*). Reads only: the posting itself
 *  stays POST /api/job-orders/:id/products-in, which applies the same rules (rts.ts). */
import { Router } from 'express';
import { z } from 'zod';
import { queryAll, queryOne } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { parseBody } from '../../shared/validation';
import { locationError, unitBlockers, openHolds } from './rts';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);
const receiveGate = requireAnyPermission(['inventory.adjust', 'production.receive']);

/* GET /api/rts/queue — serialized units that passed final inspection (status 'passed') across
   open job orders, with their final-pass record, target location and any mismatch hold;
   non-serialized batches with quantity left to receive; and the caller's own postings today. */
router.get('/queue', receiveGate, (req, res) => {
  const units = queryAll<{
    id: number; identifier: string | null; updated_at: string; job_order_id: number; job_order_number: string;
    product_name: string; product_item_id: number | null; sku: string | null; priority: number;
    output_location_id: number | null; output_location_name: string | null; order_number: string | null;
    batch_identifier: string | null;
  }>(
    `SELECT u.id, u.identifier, u.updated_at, j.id AS job_order_id, j.number AS job_order_number, j.product_name,
            COALESCE(u.product_item_id, j.product_item_id) AS product_item_id, i.sku, j.priority,
            j.output_location_id, ol.name AS output_location_name, o.number AS order_number, b.identifier AS batch_identifier
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     LEFT JOIN inventory_items i ON i.id = COALESCE(u.product_item_id, j.product_item_id)
     LEFT JOIN locations ol ON ol.id = j.output_location_id
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN production_batches b ON b.id = u.batch_id
     WHERE u.status = 'passed' AND j.status != 'cancelled'
     ORDER BY j.priority DESC, u.updated_at ASC, u.id ASC`
  );
  const holds = openHolds(units.map((u) => u.id));
  const out = units.map((u) => {
    const pass = queryOne<{ created_at: string; inspector_name: string | null; stage: number }>(
      `SELECT q.created_at, us.full_name AS inspector_name, q.stage FROM qc_records q LEFT JOIN users us ON us.id = q.inspector_id
       WHERE q.unit_id = ? AND q.result = 'pass' ORDER BY q.id DESC LIMIT 1`,
      u.id
    );
    return { ...u, final_pass: pass ?? null, hold: holds.get(u.id) ?? null };
  });
  const batches = queryAll<{ id: number; number: string; job_order_id: number; job_order_number: string; product_name: string;
    sku: string | null; output_location_id: number | null; remaining_qty: number }>(
    `SELECT pb.id, pb.number, j.id AS job_order_id, j.number AS job_order_number, j.product_name, i.sku, j.output_location_id,
            pb.qty - COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0) AS remaining_qty
     FROM production_batches pb
     JOIN job_orders j ON j.id = pb.job_order_id
     LEFT JOIN inventory_items i ON i.id = j.product_item_id
     WHERE j.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = pb.id)
     ORDER BY pb.id`
  ).filter((b) => b.remaining_qty > 0);
  const recorded = queryAll<{ receipt_number: string; created_at: string; unit_id: number | null; identifier: string | null;
    batch_number: string | null; quantity: number; product_name: string; location_name: string | null }>(
    `SELECT r.number AS receipt_number, r.created_at, ri.unit_id, un.identifier, pb.number AS batch_number, ri.quantity,
            j.product_name, l.name AS location_name
     FROM production_receipt_items ri
     JOIN production_receipts r ON r.id = ri.receipt_id
     JOIN job_orders j ON j.id = r.job_order_id
     LEFT JOIN job_order_units un ON un.id = ri.unit_id
     LEFT JOIN production_batches pb ON pb.id = ri.batch_id
     LEFT JOIN locations l ON l.id = r.location_id
     WHERE r.received_by = ? AND r.created_at >= datetime('now', 'start of day')
     ORDER BY ri.id DESC LIMIT 60`,
    req.user!.id
  );
  res.json({ units: out, batches, recorded });
});

const checkSchema = z.object({
  unit_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  location_id: z.coerce.number().int().positive().optional(),
});

/* POST /api/rts/check — the final duplicate / hold / location check before posting (74:234).
   Writes nothing; products-in re-runs the same checks atomically when the clerk confirms. */
router.post('/check', receiveGate, syncClass('merge'), (req, res) => {
  const input = parseBody(checkSchema, req.body);
  res.json({
    blockers: unitBlockers(input.unit_ids),
    location_error: input.location_id ? locationError(input.location_id, input.unit_ids.length) : null,
  });
});

/* GET /api/rts/lookup?q=&status=ready|allocated|hold — read-only finished-goods lookup (74:483):
   recorded units by serial, SKU, receipt number or location, plus counts per state. */
router.get('/lookup', requireAnyPermission(['inventory.view', 'production.view']), (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const rows = queryAll<{ id: number; identifier: string | null; status: string; sku: string | null; product_name: string;
    location_name: string | null; order_number: string | null; receipt_number: string | null; received_at: string | null;
    job_order_id: number; held: number }>(
    `SELECT u.id, u.identifier, u.status, i.sku, j.product_name, l.name AS location_name, o.number AS order_number,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number,
            (SELECT r.created_at FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS received_at,
            j.id AS job_order_id,
            EXISTS (SELECT 1 FROM production_issues pi WHERE pi.unit_id = u.id AND pi.category = 'Product-data mismatch'
                    AND pi.status = 'open') AS held
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     LEFT JOIN inventory_items i ON i.id = COALESCE(u.product_item_id, j.product_item_id)
     LEFT JOIN locations l ON l.id = u.location_id
     LEFT JOIN orders o ON o.id = u.order_id
     WHERE u.status IN ('in_stock', 'reserved', 'passed')
     ORDER BY u.updated_at DESC, u.id DESC`
  );
  const state = (r: { status: string; held: number }) => (r.held ? 'hold' : r.status === 'reserved' ? 'allocated' : r.status === 'in_stock' ? 'ready' : null);
  const listed = rows.filter((r) => state(r) !== null);
  const counts = { ready: 0, allocated: 0, hold: 0 };
  listed.forEach((r) => { counts[state(r) as keyof typeof counts]++; });
  const matches = listed.filter((r) => (!status || state(r) === status) && (!q ||
    [r.identifier, r.sku, r.receipt_number, r.location_name, r.product_name, r.order_number]
      .some((v) => v != null && String(v).toLowerCase().includes(q))));
  res.json({ counts, units: matches.slice(0, 50).map((r) => ({ ...r, state: state(r), held: !!r.held })) });
});

export default router;
