/**
 * Per-location stock helpers. `inventory_items.quantity` stays the cached grand
 * total; `inventory_stock (item_id, location_id, quantity)` is the breakdown.
 * Every stock change goes through here so the two never drift, and each change is
 * logged to `inventory_transactions` with both a total and a per-location balance.
 *
 * Callers own the surrounding transaction (these functions issue no BEGIN/COMMIT)
 * and must pre-validate the location exists and that the result won't go negative
 * (so the caller can name the location in the error message).
 */
import { queryOne, queryAll, run } from '../../shared/db';

export function getDefaultLocationId(): number {
  const row =
    queryOne<{ id: number }>('SELECT id FROM locations WHERE is_default = 1 LIMIT 1') ??
    queryOne<{ id: number }>('SELECT id FROM locations ORDER BY id LIMIT 1');
  if (!row) {
    throw Object.assign(new Error('No stock location exists yet — create one under Inventory → Locations'), { status: 409 });
  }
  return row.id;
}

export function locationName(id: number): string {
  return queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', id)?.name ?? `#${id}`;
}

/** Current quantity of an item at one location (0 if there's no row). */
export function stockAt(itemId: number, locationId: number): number {
  return (
    queryOne<{ quantity: number }>(
      'SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?',
      itemId,
      locationId
    )?.quantity ?? 0
  );
}

/** Every location with this item's quantity there (0 where there's no row). */
export function stockBreakdown(itemId: number): Array<{
  location_id: number; location_name: string; location_type: string; is_default: number; quantity: number;
}> {
  return queryAll(
    `SELECT l.id AS location_id, l.name AS location_name, l.type AS location_type, l.is_default,
            COALESCE(s.quantity, 0) AS quantity
       FROM locations l
       LEFT JOIN inventory_stock s ON s.item_id = ? AND s.location_id = l.id
      ORDER BY l.name COLLATE NOCASE`,
    itemId
  );
}

interface ChangeOpts {
  itemId: number;
  locationId: number;
  change: number;
  reason: string | null;
  userId: number | null;
  /** false for transfers — the grand total doesn't move, only its distribution. */
  touchTotal?: boolean;
  /** Acquisition cost per unit for a stock-in (goods receipt at the PO price, finished
      units at their built cost). When given on a positive `change`, `inventory_items.unit_cost`
      is rolled to the weighted moving average. Omit for cost-less moves (adjustments,
      transfers, returns) — the average is then left untouched. */
  unitCost?: number | null;
}

/** Apply a stock delta at one location + log it. Returns the new figures. */
export function applyStockChange(opts: ChangeOpts): { locationQty: number; total: number } {
  const { itemId, locationId, change, reason, userId, touchTotal = true, unitCost } = opts;
  const locationQty = stockAt(itemId, locationId) + change;

  // Weighted moving average, computed from the pre-change grand total (a pre-existing
  // negative balance counts as 0 so a backorder doesn't distort the blend).
  if (unitCost != null && change > 0 && touchTotal) {
    const cur = queryOne<{ quantity: number; unit_cost: number }>(
      'SELECT quantity, unit_cost FROM inventory_items WHERE id = ?', itemId
    );
    const prevQty = Math.max(0, cur?.quantity ?? 0);
    const prevCost = cur?.unit_cost ?? 0;
    const newQty = prevQty + change;
    const newCost = newQty > 0
      ? Math.round(((prevQty * prevCost + change * unitCost) / newQty) * 100) / 100
      : unitCost;
    run("UPDATE inventory_items SET unit_cost = ? WHERE id = ?", newCost, itemId);
  }

  run(
    `INSERT INTO inventory_stock (item_id, location_id, quantity) VALUES (?, ?, ?)
     ON CONFLICT(item_id, location_id) DO UPDATE SET quantity = ?`,
    itemId,
    locationId,
    locationQty,
    locationQty
  );
  if (touchTotal) {
    run(
      "UPDATE inventory_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?",
      change,
      itemId
    );
  }
  const total =
    queryOne<{ quantity: number }>('SELECT quantity FROM inventory_items WHERE id = ?', itemId)?.quantity ?? 0;

  run(
    `INSERT INTO inventory_transactions
       (item_id, user_id, change, balance_after, reason, location_id, location_balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    itemId,
    userId,
    change,
    total,
    reason,
    locationId,
    locationQty
  );
  return { locationQty, total };
}

/** Category of the auto-created "damage twin" rows (mirror of DAMAGE_CATEGORY in
    inventory.routes.ts). */
export const DAMAGE_CATEGORY = 'Damage';

/** Find (or create, on first use) the "damage twin" of `itemId` — a category='Damage'
 *  copy row linked back via `attributes.damaged_of`. Does NOT move any stock; the caller
 *  issues its own `applyStockChange` pair and owns the transaction. Mirrors the twin
 *  creation in POST /api/inventory/:id/damage so both stay identical. */
export function findOrCreateDamageTwin(itemId: number): number {
  const existing = queryOne<{ id: number }>(
    `SELECT id FROM inventory_items
     WHERE category = ? AND json_extract(attributes, '$.damaged_of') = ?`,
    DAMAGE_CATEGORY,
    itemId
  );
  if (existing) return existing.id;

  const source = queryOne<{
    name: string; department_id: number | null; supplier_id: number | null;
    unit: string | null; location: string | null; notes: string | null; attributes: string | null;
  }>(
    `SELECT name, department_id, supplier_id, unit, location, notes, attributes
     FROM inventory_items WHERE id = ?`,
    itemId
  );
  if (!source) throw new Error(`Item ${itemId} not found`);

  let srcAttrs: Record<string, unknown> = {};
  if (source.attributes) {
    try { srcAttrs = JSON.parse(source.attributes) as Record<string, unknown>; } catch { /* not JSON */ }
  }
  const twinAttrs = { ...srcAttrs, damaged_of: itemId };
  delete (twinAttrs as { barcode?: unknown }).barcode; // the twin isn't separately scannable

  const info = run(
    `INSERT INTO inventory_items
      (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, location, notes, attributes)
     VALUES (?, NULL, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
    source.name,
    DAMAGE_CATEGORY,
    source.department_id,
    source.supplier_id,
    source.unit ?? 'pcs',
    source.location ?? null,
    source.notes ?? null,
    JSON.stringify(twinAttrs)
  );
  return Number(info.lastInsertRowid);
}

/** Move `amount` (>0) of an item between two locations. Logs a paired out/in. */
export function transferStock(opts: {
  itemId: number; fromId: number; toId: number; amount: number; reason: string | null; userId: number | null;
}): { from: number; to: number } {
  const { itemId, fromId, toId, amount, reason, userId } = opts;
  const tail = reason ? ` — ${reason}` : '';
  const out = applyStockChange({
    itemId, locationId: fromId, change: -amount, userId, touchTotal: false,
    reason: `Transfer to ${locationName(toId)}${tail}`,
  });
  const inn = applyStockChange({
    itemId, locationId: toId, change: amount, userId, touchTotal: false,
    reason: `Transfer from ${locationName(fromId)}${tail}`,
  });
  return { from: out.locationQty, to: inn.locationQty };
}
