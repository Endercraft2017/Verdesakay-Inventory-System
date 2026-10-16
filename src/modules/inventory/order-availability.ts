/** Location-scoped available-to-promise and supply planning for sales. Draft supply never
 * increases ATP. BOM requirements mirror job-order snapshots (direct components), including
 * existing jobs' unpicked requirements, so the same material isn't promised twice. */
import { queryAll, queryOne } from '../../shared/db';
import type { Order, OrderItem } from '../../shared/types';
import { getDefaultLocationId, variantStockAt, variantStockTotal, locationName, type BuildMode } from './inventory-stock';
import { kitPickedAt, repairHeld } from '../manufacturing/stock-holds';

export interface LineAvailability {
  order_item_id: number; item_id: number; name: string; ordered: number;
  fulfillment_mode: string;
  on_hand: number; elsewhere_on_hand: number; committed_elsewhere: number; committed_orders: number;
  kit_held: number; repair_held: number; covered_here: number; available: number; shortfall: number;
  is_finished_product: boolean; has_bom: boolean; buildable: boolean;
  semi_built_available: number;
  component_shortfalls: { component_item_id: number; name: string; need: number; have: number }[];
  linked_job_orders: { id: number; number: string; status: string; remaining: number; output_location_id: number | null; source_location_id: number | null }[];
}
// Remove floating-point noise without discarding valid small measured quantities.
const qty = (n: number) => Number(n.toPrecision(15));
const firmStates = "'approved', 'released', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'";

export function orderAvailability(orderId: number) {
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', orderId)!;
  let defaultLocation: number | null = null;
  try { defaultLocation = getDefaultLocationId(); } catch { /* Show a blocked review, not a read failure. */ }
  const locationId = order.location_id ?? defaultLocation;
  const lines: LineAvailability[] = [];
  const items = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', orderId);
  const stockCache = new Map<string, { onHand: number; commitments: number; kit: number; repair: number; free: number }>();
  const stock = (itemId: number, at = locationId, mode: BuildMode = 'assembled') => {
    const key = `${itemId}:${at}:${mode}`;
    let result = stockCache.get(key);
    if (result) return result;
    // Reservations are still in on-hand. Other firms' unpicked remainders also claim it.
    const reserved = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM job_order_units u
      LEFT JOIN job_orders j ON j.id = u.job_order_id
      WHERE u.product_item_id = ? AND u.status = 'reserved' AND COALESCE(u.order_id, 0) != ?
        AND COALESCE(j.build_mode, 'assembled') = ?
        AND COALESCE(u.location_id, j.output_location_id, ?) IS ?`, itemId, orderId, mode, defaultLocation, at)?.n ?? 0;
    const demand = queryOne<{ n: number }>(`SELECT COALESCE(SUM(MAX(0, x.quantity - x.cancelled_qty - x.dispatched_qty -
      (SELECT COUNT(*) FROM job_order_units u WHERE u.order_item_id = x.id
        AND u.status = 'reserved'))), 0) AS n
      FROM order_items x JOIN orders o ON o.id = x.order_id
      WHERE x.item_id = ? AND o.id != ? AND o.type = 'sale' AND o.fulfilled_at IS NULL
        AND CASE WHEN x.fulfillment_mode IN ('ckd_component', 'assembled') THEN 'assembled'
                 ELSE COALESCE(x.fulfillment_mode, 'assembled') END = ?
        AND LOWER(o.status) IN (${firmStates}) AND COALESCE(o.location_id, ?) IS ?`, itemId, orderId, mode, defaultLocation, at)?.n ?? 0;
    const onHand = at == null ? 0 : variantStockAt(itemId, at, mode);
    const kit = at == null ? 0 : kitPickedAt(itemId, at);
    const repair = at == null ? 0 : repairHeld(itemId, at);
    const commitments = reserved + demand;
    result = { onHand, commitments, kit, repair, free: Math.max(0, onHand - commitments - kit - repair) };
    stockCache.set(key, result);
    return result;
  };
  const materialPool = new Map<string, number>();
  const componentPool = new Map<number, number>();
  const otherSourcePools = new Map<string, number>();
  const requirements = new Map<number, { name: string; need: number }>();
  const bump = (id: number, name: string, amount: number) => {
    const r = requirements.get(id) ?? { name, need: 0 };
    r.need = qty(r.need + amount); requirements.set(id, r);
  };
  // Sale demand takes priority over using its stock in a production kit. A legacy duplicate
  // sale line consumes the same pool instead of independently seeing the original balance.
  for (const oi of items) {
    if (oi.item_id == null || oi.fulfillment_mode === 'ckd') continue;
    const inv = queryOne<{ quantity: number; is_finished_product: number }>('SELECT quantity, is_finished_product FROM inventory_items WHERE id = ?', oi.item_id);
    if (!inv) continue;
    const mode: BuildMode = oi.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled';
    const s = stock(oi.item_id, locationId, mode);
    const units = queryOne<{ reserved: number; sold: number }>(`SELECT
      COALESCE(SUM(status = 'reserved'), 0) AS reserved, COALESCE(SUM(status = 'sold'), 0) AS sold
      FROM job_order_units WHERE order_item_id = ? AND status IN ('reserved', 'sold')`, oi.id)!;
    const covered = (oi.dispatched_qty||0)+units.reserved+Math.max(0,(oi.released_qty||0)-(oi.dispatched_bulk_qty||0));
    const ownOnHand = Math.max(0,covered-(oi.dispatched_qty||0));
    const poolKey = `${oi.item_id}:${mode}`;
    const balance = materialPool.get(poolKey) ?? s.free;
    const free = Math.max(0, balance - ownOnHand);
    const available = qty(free + covered);
    const shortfall = qty(Math.max(0, oi.quantity - (oi.cancelled_qty||0) - available));
    materialPool.set(poolKey, qty(Math.max(0, free - Math.max(0, oi.quantity - (oi.cancelled_qty||0) - covered))));
    const hasBom = !!inv.is_finished_product && !!queryOne('SELECT id FROM bom_components WHERE product_item_id = ? LIMIT 1', oi.item_id);
    // QC done isn't stock received. Keep completed jobs with unreceived output in planning
    // cover, excluding scrapped output and jobs targeting a different location.
    const jobs = queryAll<{ id: number; number: string; status: string; remaining: number; output_location_id: number | null; source_location_id: number | null }>(`SELECT j.id, j.number, j.status, j.output_location_id, j.source_location_id,
      MAX(0, j.qty_ordered - j.qty_scrapped - COALESCE((SELECT SUM(ri.quantity)
        FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
        WHERE r.job_order_id = j.id), 0)) AS remaining
      FROM job_orders j WHERE j.order_id = ? AND j.product_item_id = ? AND j.status != 'cancelled'
        AND j.build_mode = ? AND COALESCE(j.output_location_id, ?) IS ? ORDER BY j.id`, orderId, oi.item_id, mode, defaultLocation, locationId)
      .filter((j) => j.remaining > 0);
    const madeHere = !!inv.is_finished_product || jobs.length > 0;
    lines.push({ order_item_id: oi.id, item_id: oi.item_id, name: oi.name, ordered: oi.quantity-(oi.cancelled_qty||0), fulfillment_mode: oi.fulfillment_mode,
      on_hand: s.onHand, elsewhere_on_hand: qty(variantStockTotal(oi.item_id, mode) - s.onHand), committed_elsewhere: qty(s.commitments + s.kit + s.repair), committed_orders: s.commitments,
      kit_held: s.kit, repair_held: s.repair, covered_here: covered, available, shortfall,
      is_finished_product: madeHere, has_bom: hasBom, buildable: false,
      semi_built_available: mode === 'assembled' && !!inv.is_finished_product ? stock(oi.item_id, locationId, 'semi_built').free : 0,
      component_shortfalls: [], linked_job_orders: jobs });
    if (shortfall > 0 && !madeHere) bump(oi.item_id, oi.name, shortfall);
  }
  for (const l of lines) {
    if (l.shortfall <= 0 || (!l.has_bom && !l.linked_job_orders.length)) continue;
    const planned = l.linked_job_orders.reduce((n, j) => n + j.remaining, 0);
    const newQty = Math.max(0, Math.ceil(l.shortfall) - planned);
    const materials = new Map<string, { id: number; at: number | null; name: string; need: number }>();
    const add = (id: number, name: string, need: number, at = locationId) => {
      const key = `${id}:${at}`;
      const m = materials.get(key) ?? { id, at, name, need: 0 }; m.need = qty(m.need + need); materials.set(key, m);
    };
    for (const j of l.linked_job_orders) {
      if (j.status !== 'draft') continue; // released kits already left stock
      for (const c of queryAll<{ component_item_id: number; component_name: string; need: number }>(`SELECT component_item_id, component_name,
        MAX(0, qty_planned - qty_consumed - qty_picked) AS need FROM job_order_components
        WHERE job_order_id = ?`, j.id)) add(c.component_item_id, c.component_name, c.need, j.source_location_id ?? defaultLocation);
    }
    for (const c of queryAll<{ component_item_id: number; name: string; quantity: number }>(`SELECT b.component_item_id, i.name, b.quantity
      FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id WHERE b.product_item_id = ? ORDER BY b.sort, b.id`, l.item_id)) {
      add(c.component_item_id, c.name, c.quantity * newQty);
    }
    for (const [key, m] of materials) {
      const id = m.id;
      const have = (m.at === locationId ? (componentPool.get(id) ?? materialPool.get(`${id}:assembled`)) : otherSourcePools.get(key)) ?? stock(id, m.at).free;
      if (m.need > have) l.component_shortfalls.push({ component_item_id: id, name: m.name, need: m.need, have });
      bump(id, m.name, Math.max(0, m.need - have));
      const left = qty(Math.max(0, have - m.need));
      if (m.at === locationId) componentPool.set(id, left);
      else otherSourcePools.set(key, left);
    }
    l.buildable = l.component_shortfalls.length === 0;
  }
  // Earlier releases recorded only this exact system note. Recognize that legacy reference
  // without rewriting old records; new drafts keep the durable link when notes/lines change.
  const linkedPurchases = queryAll<{ id: number; number: string; status: string; item_id: number; outstanding: number }>(`SELECT o.id, o.number, o.status, x.item_id,
    MAX(0, SUM(x.quantity) - COALESCE((SELECT SUM(gi.quantity) FROM goods_receipt_items gi
      JOIN goods_receipts g ON g.id = gi.receipt_id WHERE g.order_id = o.id AND gi.item_id = x.item_id), 0)) AS outstanding
    FROM orders o JOIN order_items x ON x.order_id = o.id WHERE o.type = 'purchase' AND
      (EXISTS (SELECT 1 FROM sale_shortfall_purchases sp WHERE sp.source_order_id = ? AND sp.purchase_order_id = o.id)
       OR (o.notes = ? AND NOT EXISTS (SELECT 1 FROM sale_shortfall_purchases sp WHERE sp.purchase_order_id = o.id)))
      AND LOWER(o.status) NOT IN ('cancelled', 'closed') AND x.item_id IS NOT NULL GROUP BY o.id, x.item_id
    ORDER BY o.id`, orderId, `Shortfall for ${order.number}`).filter((p) => p.outstanding > 0);
  const purchaseRequirements = [...requirements.entries()].filter(([, r]) => r.need > 0).map(([id, r]) => {
    const pending = linkedPurchases.filter((p) => p.item_id === id).reduce((n, p) => n + p.outstanding, 0);
    return { item_id: id, name: r.name, shortage: r.need, pending_purchase: qty(pending), to_purchase: qty(Math.max(0, r.need - pending)) };
  });
  return { ok: lines.every((l) => l.shortfall <= 0), short_lines: lines.filter((l) => l.shortfall > 0).length, lines,
    location_id: locationId, location_name: locationId == null ? null : locationName(locationId), uses_default_location: order.location_id == null,
    non_stock_lines: items.filter((l) => l.item_id == null).length, purchase_requirements: purchaseRequirements, linked_purchase_orders: linkedPurchases };
}
