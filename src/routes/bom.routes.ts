/** Finished products + their bill of materials (bom_components).
    A finished product is an inventory_items row flagged is_finished_product = 1. */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, saveBomSchema } from '../validation';
import type { BomComponent, InventoryItem } from '../types';

const router = Router();
router.use(requireAuth);

/** How many whole units are buildable from current component stock (0 if no BOM). */
const MAX_BUILDABLE_SQL = `
  SELECT COALESCE(MIN(CAST(ci.quantity / b.quantity AS INTEGER)), 0)
  FROM bom_components b JOIN inventory_items ci ON ci.id = b.component_item_id
  WHERE b.product_item_id = i.id
`;

const bomRows = (productId: number) =>
  queryAll<BomComponent>(
    `SELECT b.*, i.name AS component_name, i.sku AS component_sku, i.unit AS component_unit,
            i.quantity AS component_on_hand
     FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id
     WHERE b.product_item_id = ?
     ORDER BY b.sort, b.id`,
    productId
  );

// GET /api/finished-products — every item flagged as a finished product
router.get('/', requirePermission('inventory.view'), (_req, res) => {
  const rows = queryAll<InventoryItem & { component_count: number; max_buildable: number }>(
    `SELECT i.*,
            (SELECT COUNT(*) FROM bom_components b WHERE b.product_item_id = i.id) AS component_count,
            (${MAX_BUILDABLE_SQL}) AS max_buildable
     FROM inventory_items i
     WHERE i.is_finished_product = 1
     ORDER BY i.name COLLATE NOCASE`
  );
  res.json(rows);
});

// GET /api/finished-products/:id — the product + its BOM + how many are buildable now
router.get('/:id', requirePermission('inventory.view'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const bom = bomRows(id);
  const max_buildable = queryOne<{ n: number }>(
    `SELECT COALESCE(MIN(CAST(ci.quantity / b.quantity AS INTEGER)), 0) AS n
     FROM bom_components b JOIN inventory_items ci ON ci.id = b.component_item_id
     WHERE b.product_item_id = ?`,
    id
  )?.n ?? 0;
  res.json({ ...item, bom, max_buildable });
});

// PUT /api/finished-products/:id — mark as a finished product + replace its BOM
router.put('/:id', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT id FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { components } = parseBody(saveBomSchema, req.body);

  const seen = new Set<number>();
  for (const c of components) {
    if (c.component_item_id === id) {
      res.status(400).json({ error: 'A product cannot be a component of itself' });
      return;
    }
    if (seen.has(c.component_item_id)) {
      res.status(400).json({ error: 'The same component is listed twice' });
      return;
    }
    seen.add(c.component_item_id);
    if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', c.component_item_id)) {
      res.status(400).json({ error: `Component #${c.component_item_id} does not exist` });
      return;
    }
  }

  db.exec('BEGIN');
  try {
    run("UPDATE inventory_items SET is_finished_product = 1, updated_at = datetime('now') WHERE id = ?", id);
    run('DELETE FROM bom_components WHERE product_item_id = ?', id);
    components.forEach((c, i) => {
      run(
        `INSERT INTO bom_components (product_item_id, component_item_id, quantity, notes, sort)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        c.component_item_id,
        c.quantity,
        c.notes ?? null,
        i
      );
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, bom: bomRows(id) });
});

// DELETE /api/finished-products/:id — unflag + drop the BOM (the item itself stays)
router.delete('/:id', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM bom_components WHERE product_item_id = ?', id);
    run("UPDATE inventory_items SET is_finished_product = 0, updated_at = datetime('now') WHERE id = ?", id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

export default router;
