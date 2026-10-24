/** One explicit warehouse split, one stock transaction and one durable receipt. */
import { Router } from 'express';
import { db, queryOne } from '../../shared/db';
import { requirePermission } from '../../shared/auth';
import { persistIdempotentResult, replayIdempotentResult } from '../../shared/idempotency';
import { multiLocationStockOutSchema, parseBody } from '../../shared/validation';
import { syncContext } from '../../shared/sync-context';
import { syncClass } from '../../sync';
import { notifyLowStockCrossed } from '../../shared/push';
import type { InventoryItem } from '../../shared/types';
import { applyStockChange, locationName, serializedOnHand, variantStockAt } from './inventory-stock';
import { movableStockAt } from './movement-stock';

const router = Router();
router.post('/:id/stock-out', requirePermission('inventory.adjust'), syncClass('physical'), (req, res) => {
  if (!req.is('application/json')) { res.status(415).json({ error: 'Send this stock action as application/json.' }); return; }
  const input = parseBody(multiLocationStockOutSchema, req.body), id = Number(req.params.id);
  const replaying = ['replay', 'rebase'].includes(syncContext()?.mode ?? '');
  if (!replaying && !req.get('Idempotency-Key')) {
    res.status(400).json({ error: 'A stable Idempotency-Key is required for this stock action.' }); return;
  }
  if (!replaying && /^Picked for order\s+/i.test(input.reason)) {
    res.status(409).json({ error: 'Use the order release or production kit workflow.', code: 'use_release_workflow' }); return;
  }
  db.exec('BEGIN IMMEDIATE');
  let result, item: InventoryItem;
  try {
    if (!replaying && replayIdempotentResult(res)) { db.exec('COMMIT'); return; }
    const found = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id=?', id);
    if (!found) throw Object.assign(new Error('Item not found'), { status: 404 });
    item = found;
    if (input.build_mode === 'semi_built' && !item.is_finished_product) {
      throw Object.assign(new Error('Semi-built stock is only for finished products. Parts use standard stock.'), { status: 400 });
    }
    // Validate every source before applying any deduction. BEGIN IMMEDIATE holds
    // the SQLite write lock through validation, movements and receipt storage.
    for (const source of input.sources) {
      if (!queryOne('SELECT id FROM locations WHERE id=?', source.location_id)) {
        throw Object.assign(new Error('Source location not found'), { status: 400 });
      }
      const onHand = variantStockAt(id, source.location_id, input.build_mode);
      const available = movableStockAt(id, source.location_id, input.build_mode, onHand);
      const serials = serializedOnHand(id, source.location_id, input.build_mode);
      if (serials > 0 && source.quantity > onHand - serials) {
        throw Object.assign(new Error('This source includes serialized units. Use their exact unit workflow.'), { status: 409 });
      }
      // New actions cannot overdraw, including at an installed PC. A replay of
      // goods already recorded as physically moved retains existing D1 handling.
      if (!replaying && source.quantity > available) {
        throw Object.assign(new Error(`Only ${available} movable units are available at ${locationName(source.location_id)}. Refresh stock and review the split.`), { status: 409 });
      }
    }
    const sources = input.sources.map(source => {
      const changed = applyStockChange({ itemId: id, locationId: source.location_id,
        change: -source.quantity, reason: input.reason, userId: req.user!.id, buildMode: input.build_mode });
      return { ...source, location_name: locationName(source.location_id), location_quantity: changed.locationQty,
        ...(changed.discrepancyId ? { discrepancy_id: changed.discrepancyId } : {}) };
    });
    result = { ok: true, quantity: queryOne<{quantity:number}>('SELECT quantity FROM inventory_items WHERE id=?', id)!.quantity,
      moved_quantity: input.quantity, build_mode: input.build_mode, sources };
    if (!replaying) persistIdempotentResult(res, result);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  notifyLowStockCrossed(item, item.quantity, result.quantity);
  res.json(result);
});
export default router;
