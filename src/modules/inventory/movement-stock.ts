/** Untracked stock eligible for a new manual movement. Read by the phone and
 * rechecked under the grouped stock-out transaction; quantities are never pooled. */
import { queryOne } from '../../shared/db';
import { kitPickedAt, repairHeld } from '../manufacturing/stock-holds';
import { saleHeld } from './sale-holds';
import { serializedOnHand, stockBreakdown, type BuildMode } from './inventory-stock';

export function movableStockAt(itemId: number, locationId: number, mode: BuildMode, onHand: number): number {
  const serialized = serializedOnHand(itemId, locationId, mode);
  // Reserved serials are already represented in firm sale demand; count that
  // overlap once. Batch reservations represent the same bulk sale commitments.
  const reservedSerials = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM job_order_units u
    JOIN job_orders j ON j.id=u.job_order_id JOIN order_items oi ON oi.id=u.order_item_id
    JOIN orders o ON o.id=oi.order_id WHERE COALESCE(u.product_item_id,j.product_item_id)=?
      AND j.build_mode=? AND u.status='reserved' AND COALESCE(u.location_id,j.output_location_id,
        (SELECT id FROM locations WHERE is_default=1 LIMIT 1))=?
      AND o.type='sale' AND o.status NOT IN ('open','cancelled') AND o.fulfilled_at IS NULL
      AND oi.fulfillment_mode!='ckd'`, itemId, mode, locationId)?.n ?? 0;
  const reservedBatches = queryOne<{ n: number }>(`SELECT COALESCE(SUM(a.quantity),0) AS n
    FROM production_batch_allocations a JOIN production_batches b ON b.id=a.batch_id
    JOIN job_orders j ON j.id=b.job_order_id WHERE a.item_id=? AND a.location_id=?
      AND j.build_mode=? AND a.state='reserved'`, itemId, locationId, mode)?.n ?? 0;
  const firmBulk = Math.max(0, saleHeld(itemId, locationId, mode) - reservedSerials, reservedBatches);
  const otherHolds = mode === 'assembled' ? kitPickedAt(itemId, locationId) + repairHeld(itemId, locationId) : 0;
  return Math.max(0, onHand - serialized - firmBulk - otherHolds);
}

export function movementStock(itemId: number) {
  return stockBreakdown(itemId).map(row => ({
    ...row,
    assembled_movable: movableStockAt(itemId, row.location_id, 'assembled', row.assembled_quantity),
    semi_built_movable: movableStockAt(itemId, row.location_id, 'semi_built', row.semi_built_quantity),
  }));
}
