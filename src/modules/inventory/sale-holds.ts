import { queryOne } from '../../shared/db';
/** Unshipped firm sale demand stays committed even when its vehicle cannot take it yet. */
export function saleHeld(itemId:number,location:number|null=null,mode?:string):number {
  return queryOne<{n:number}>(`SELECT COALESCE(SUM(MAX(0,oi.quantity-oi.cancelled_qty-oi.dispatched_qty)),0) AS n
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.type='sale' AND o.status NOT IN ('open','cancelled') AND o.fulfilled_at IS NULL
    AND oi.item_id=? AND oi.fulfillment_mode!='ckd'
    AND (? IS NULL OR COALESCE(o.location_id,(SELECT id FROM locations WHERE is_default=1 LIMIT 1))=?)
    AND (? IS NULL OR CASE WHEN oi.fulfillment_mode='semi_built' THEN 'semi_built' ELSE 'assembled' END=?)`,itemId,location,location,mode??null,mode??null)?.n??0;
}
