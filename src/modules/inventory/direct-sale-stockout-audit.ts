/** Evidence-only audit for legacy direct sales that may also have been deducted
 * when their release slip was issued. Never changes stock or accounting. */
import { createHash } from 'node:crypto';
import { queryAll, queryOne } from '../../shared/db';
import { locationName } from './inventory-stock';

type Seed = { order_id: number; order_number: string; item_id: number; item_name: string; sku: string | null; on_hand: number };
type SlipItem = { id: number; slip_id: number; quantity: number };
type Movement = { id: number; change: number; reason: string; created_at: string; location_id: number | null; user_name: string | null };
type PendingUnit = { id: number };
type Review = { id: number; evidence_hash: string; note: string; reviewed_at: string; reviewer_name: string | null };

const roundQty = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export function directSaleStockoutCase(seed: Seed) {
  const slips = queryAll<SlipItem>(`SELECT li.id,li.slip_id,li.quantity FROM release_slip_items li
    JOIN release_slips s ON s.id=li.slip_id WHERE s.order_id=? AND li.item_id=? ORDER BY li.id`,seed.order_id,seed.item_id);
  const prefix = `Sold — ${seed.order_number}`;
  const movements = queryAll<Movement>(`SELECT t.id,t.change,t.reason,t.created_at,t.location_id,u.full_name AS user_name
    FROM inventory_transactions t LEFT JOIN users u ON u.id=t.user_id
    WHERE t.item_id=? AND t.change<0 AND substr(t.reason,1,length(?))=?
      AND (length(t.reason)=length(?) OR substr(t.reason,length(?)+1,3) IN (' — ',' · '))
    ORDER BY t.id`,seed.item_id,prefix,prefix,prefix,prefix);
  const pending = queryAll<PendingUnit>(`SELECT u.id FROM job_order_units u WHERE u.order_id=? AND u.product_item_id=?
    AND u.status='sold' AND u.direct_sold_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM release_slip_units su WHERE su.unit_id=u.id) ORDER BY u.id`,seed.order_id,seed.item_id);
  const shipped = roundQty(slips.reduce((n,s)=>n+s.quantity,0));
  const removed = roundQty(movements.reduce((n,m)=>n-m.change,0));
  const extra = roundQty(removed-shipped-pending.length);
  if(extra<=0) return null;
  const evidence_hash = createHash('sha256').update(JSON.stringify({
    slips:slips.map(s=>[s.id,s.slip_id,s.quantity]),
    movements:movements.map(m=>[m.id,m.change,m.reason,m.location_id,m.created_at]),
    pending:pending.map(u=>u.id),
  })).digest('hex');
  const review = queryOne<Review>(`SELECT r.id,r.evidence_hash,r.note,r.reviewed_at,u.full_name AS reviewer_name
    FROM direct_sale_stockout_reviews r LEFT JOIN users u ON u.id=r.reviewed_by
    WHERE r.order_id=? AND r.item_id=? ORDER BY r.id DESC LIMIT 1`,seed.order_id,seed.item_id);
  return {
    order_id:seed.order_id,order_number:seed.order_number,item_id:seed.item_id,item_name:seed.item_name,
    sku:seed.sku,on_hand:seed.on_hand,shipped_quantity:shipped,removed_quantity:removed,
    awaiting_slip_quantity:pending.length,possible_extra_quantity:extra,slip_count:new Set(slips.map(s=>s.slip_id)).size,
    movement_count:movements.length,movements:movements.slice(-50).map(m=>({...m,
      location_name:m.location_id?locationName(m.location_id):null})),evidence_hash,
    status:review?.evidence_hash===evidence_hash?'reviewed':'open',
    review:review?{id:review.id,note:review.note,reviewed_at:review.reviewed_at,reviewer_name:review.reviewer_name,
      stale:review.evidence_hash!==evidence_hash}:null,
  };
}

export function findDirectSaleStockoutCase(orderId:number,itemId:number) {
  const seed = queryOne<Seed>(`SELECT o.id AS order_id,o.number AS order_number,i.id AS item_id,i.name AS item_name,
      i.sku,i.quantity AS on_hand FROM job_order_units u JOIN orders o ON o.id=u.order_id
      JOIN inventory_items i ON i.id=u.product_item_id
    WHERE o.id=? AND i.id=? AND o.type='sale' AND u.status='sold'
      AND EXISTS(SELECT 1 FROM release_slips s WHERE s.order_id=o.id) LIMIT 1`,orderId,itemId);
  return seed?directSaleStockoutCase(seed):null;
}

export function listDirectSaleStockoutCases(status:'open'|'reviewed'|'all'='open') {
  const seeds = queryAll<Seed>(`SELECT o.id AS order_id,o.number AS order_number,i.id AS item_id,i.name AS item_name,
      i.sku,i.quantity AS on_hand FROM job_order_units u JOIN orders o ON o.id=u.order_id
      JOIN inventory_items i ON i.id=u.product_item_id
    WHERE o.type='sale' AND u.status='sold'
      AND EXISTS(SELECT 1 FROM release_slips s WHERE s.order_id=o.id)
    GROUP BY o.id,i.id ORDER BY o.id DESC,i.id DESC`);
  const cases = seeds.map(directSaleStockoutCase).filter((row)=>row!==null);
  return status==='all'?cases:cases.filter((row)=>row.status===status);
}
