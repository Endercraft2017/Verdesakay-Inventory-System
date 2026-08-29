/** DB-backed BomResolvers for src/bom-explode.ts.
 *
 * Unit cost comes from the item's `attributes` JSON (no dedicated column):
 *   standard_cost → purchase_price → 0.
 * See public/js/item-form-config.js ("standard-costing" capability).
 */
import { queryAll, queryOne } from './db';
import type { BomResolvers, BomNodeItem } from './bom-explode';

const ITEM_SQL = `
  SELECT id, name, sku, unit, is_finished_product,
         COALESCE(
           CAST(json_extract(attributes, '$.standard_cost')  AS REAL),
           CAST(json_extract(attributes, '$.purchase_price') AS REAL),
           0
         ) AS unit_cost
  FROM inventory_items WHERE id = ?
`;

export function dbBomResolvers(): BomResolvers {
  const itemCache = new Map<number, BomNodeItem | null>();
  return {
    children(productId) {
      return queryAll<{ component_item_id: number; quantity: number }>(
        'SELECT component_item_id, quantity FROM bom_components WHERE product_item_id = ? ORDER BY sort, id',
        productId
      );
    },
    item(id) {
      if (itemCache.has(id)) return itemCache.get(id) ?? null;
      const row = queryOne<BomNodeItem>(ITEM_SQL, id) ?? null;
      itemCache.set(id, row);
      return row;
    },
    parents(componentId) {
      return queryAll<{ product_item_id: number }>(
        'SELECT DISTINCT product_item_id FROM bom_components WHERE component_item_id = ?',
        componentId
      );
    },
  };
}
