/** Same-order physical shipments. Caller owns the transaction; allocations stay held until selected. */
import { queryAll, queryOne, run } from '../../shared/db';
import type { OrderItem } from '../../shared/types';
import { applyStockChange, getDefaultLocationId, variantStockAt, overdrawAllowed } from './inventory-stock';
import { batchBalances } from './batch-stock';
import { now } from '../../shared/sync-context';
export type TripChoice = { order_item_id:number; quantity:number; unit_ids?:number[]; batches?:{allocation_id:number;quantity:number}[] };
type Lot = {id:number;batch_id:number;quantity:number;location_id:number};
export type TripLine = {line:OrderItem; quantity:number; units:{id:number;identifier:string|null;direct_sold_at:string|null}[]; lots:(Lot&{take:number})[]};
export const tripError=(message:string,code='trip_changed')=>Object.assign(new Error(message),{status:409,code});
export function lineHeld(l:OrderItem) {
  const reserved=queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM job_order_units u WHERE u.order_item_id=?
    AND (u.status='reserved' OR u.status='sold' AND u.direct_sold_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id))`,l.id)?.n??0;
  return {reserved,bulk:Math.max(0,(l.released_qty||0)-(l.dispatched_bulk_qty||0))};
}
export function orderOutstanding(orderId:number) {
  return queryOne<{n:number}>(`SELECT COALESCE(SUM(MAX(0,quantity-cancelled_qty-dispatched_qty)),0) AS n
    FROM order_items WHERE order_id=? AND item_id IS NOT NULL AND fulfillment_mode!='ckd'`,orderId)?.n??0;
}
export function prepareTrip(orderId:number, choices?:TripChoice[]):TripLine[] {
  const lines=queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id=? ORDER BY sort,id',orderId);
  const physical=lines.filter(l=>l.item_id!=null&&l.fulfillment_mode!=='ckd');
  if(choices&&new Set(choices.map(c=>c.order_item_id)).size!==choices.length)throw tripError('Choose each sale line once.');
  if(choices?.some(c=>!physical.some(l=>l.id===c.order_item_id)))throw tripError('A selected line is not a physical line on this sale.');
  const result:TripLine[]=[];const usedUnits=new Set<number>();
  for(const line of physical){
    const held=lineHeld(line), selection=choices?.find(c=>c.order_item_id===line.id);
    const quantity=choices?(selection?.quantity??0):held.reserved+held.bulk;
    if(!quantity)continue;
    if(quantity>held.reserved+held.bulk+1e-9||quantity>line.quantity-(line.cancelled_qty||0)-(line.dispatched_qty||0)+1e-9)
      throw tripError(`${line.name}: load only the reserved, unshipped quantity. Refresh this trip.`);
    const units=queryAll<{id:number;identifier:string|null;direct_sold_at:string|null}>(`SELECT u.id,u.identifier,u.direct_sold_at
      FROM job_order_units u WHERE u.order_item_id=? AND (u.status='reserved' OR u.status='sold' AND u.direct_sold_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id)) ORDER BY u.id`,line.id);
    const selected=selection?.unit_ids;
    if(selected&&new Set(selected).size!==selected.length)throw tripError('A serial can be loaded only once.');
    if(selected?.some(id=>!units.some(u=>u.id===id)||usedUnits.has(id)))throw tripError('A selected serial is not held for this sale line.');
    const leavingUnits=selected?units.filter(u=>selected.includes(u.id)):quantity===held.reserved+held.bulk?units:[];
    if(units.some(u=>u.direct_sold_at&&!leavingUnits.some(selected=>selected.id===u.id)))
      throw tripError('Include every directly sold unit in the next trip slip; its stock already left the warehouse.','direct_sale_required');
    if(units.length&&!selected&&quantity<held.reserved+held.bulk)throw tripError('Select the exact serials loaded on this trip.','trip_serial_required');
    leavingUnits.forEach(u=>usedUnits.add(u.id));
    const bulk=quantity-leavingUnits.length;
    if(bulk<0||bulk>held.bulk+1e-9)throw tripError('The counted quantity must match the selected serials and bulk goods.');
    const lots=queryAll<Lot>("SELECT id,batch_id,quantity,location_id FROM production_batch_allocations WHERE order_item_id=? AND state='reserved' ORDER BY id",line.id);
    const untracked=Math.max(0,held.bulk-lots.reduce((n,l)=>n+l.quantity,0));
    if(selection?.batches&&new Set(selection.batches.map(b=>b.allocation_id)).size!==selection.batches.length)throw tripError('Select each batch allocation once.');
    if(selection?.batches?.some(b=>!lots.some(l=>l.id===b.allocation_id)))throw tripError('A selected batch is not reserved for this sale line.');
    if(!selection?.batches&&bulk<held.bulk-1e-9&&(lots.length>1||lots.length>0&&untracked>1e-9))
      throw tripError('Count the exact reserved batch quantities leaving on this trip.','trip_batch_required');
    let left=bulk;
    const leavingLots:TripLine['lots']=[];
    for(const lot of lots){
      const take=selection?.batches?selection.batches.find(b=>b.allocation_id===lot.id)?.quantity??0:Math.min(left,lot.quantity);
      if(take>lot.quantity+1e-9||take>left+1e-9)throw tripError('This trip exceeds the selected batch reservation.');
      if(take>0){const balance=batchBalances(lot.batch_id).find(b=>b.location_id===lot.location_id);
        if(!balance||balance.on_hand+1e-9<take)throw tripError('Batch stock changed after counting. Refresh before handoff.');
        leavingLots.push({...lot,take});left-=take;}
    }
    if(left>untracked+1e-9)throw tripError('Select enough reserved batch quantity for this load.','trip_batch_required');
    result.push({line,quantity,units:leavingUnits,lots:leavingLots});
  }
  const outWithoutSlip=queryAll<{id:number}>(`SELECT u.id FROM job_order_units u WHERE u.order_id=? AND u.direct_sold_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id)`,orderId);
  if(outWithoutSlip.some(u=>!usedUnits.has(u.id)))throw tripError('Include every directly sold unit in the next trip slip; its stock already left the warehouse.','direct_sale_required');
  if(!result.length)throw tripError('Nothing is selected for this trip. Reserve and count the goods leaving first.','incomplete');
  for(const parent of lines.filter(l=>l.fulfillment_mode==='ckd')){
    const parts=physical.filter(l=>l.parent_order_item_id===parent.id);
    const selected=parts.map(l=>({line:l,quantity:result.find(r=>r.line.id===l.id)?.quantity??0}));
    if(!selected.some(p=>p.quantity>0))continue;
    if(!parts.length)throw tripError('The CKD kit has no physical component snapshot.','incomplete');
    const kits=Math.min(...selected.map(p=>Math.floor((p.quantity+1e-9)/(p.line.quantity/parent.quantity))));
    if(kits<=0||selected.some(p=>Math.abs(p.quantity-kits*p.line.quantity/parent.quantity)>1e-9))
      throw tripError('Load complete CKD kits only. Keep all remaining components reserved.','incomplete');
    result.push({line:parent,quantity:kits,units:[],lots:[]});
  }
  return result;
}
export function dispatchTrip(orderId:number,slipId:number,trip:TripLine[],actor:number) {
  const order=queryOne<{number:string;location_id:number|null}>('SELECT number,location_id FROM orders WHERE id=?',orderId)!;
  const location=order.location_id??getDefaultLocationId();
  const pools=new Map<string,number>();
  for(const t of trip){if(t.line.fulfillment_mode==='ckd')continue;const key=`${t.line.item_id}:${t.line.fulfillment_mode==='semi_built'?'semi_built':'assembled'}`;pools.set(key,(pools.get(key)??0)+t.quantity);}
  for(const t of trip){if(t.line.fulfillment_mode==='ckd')continue;const key=`${t.line.item_id}:${t.line.fulfillment_mode==='semi_built'?'semi_built':'assembled'}`;
    pools.set(key,(pools.get(key)??0)-t.units.filter(u=>u.direct_sold_at).length);}
  for(const [key,qty]of pools){const[item,mode]=key.split(':');if(!overdrawAllowed()&&variantStockAt(Number(item),location,mode as 'assembled'|'semi_built')+1e-9<qty)throw tripError('Warehouse stock changed after counting.','stock_changed');}
  for(const t of trip){
    const l=t.line;
    const row=Number(run(`INSERT INTO release_slip_items(slip_id,order_item_id,item_id,name,sku,unit,quantity,unit_identifiers,unit_cost)
      VALUES(?,?,?,?,?,?,?,?,?)`,slipId,l.id,l.fulfillment_mode==='ckd'?null:l.item_id,l.fulfillment_mode==='ckd'?`${l.name} (CKD)`:l.name,l.sku,l.unit,t.quantity,
      t.units.map(u=>u.identifier).filter(Boolean).join(', ')||null,l.item_id?queryOne<{unit_cost:number}>('SELECT unit_cost FROM inventory_items WHERE id=?',l.item_id)?.unit_cost??0:null).lastInsertRowid);
    if(l.fulfillment_mode!=='ckd'){
      for(const lot of t.lots){
        run('UPDATE production_batch_stock SET quantity=quantity-? WHERE batch_id=? AND location_id=?',lot.take,lot.batch_id,lot.location_id);
        if(lot.take>=lot.quantity-1e-9)run("UPDATE production_batch_allocations SET state='shipped',release_slip_id=? WHERE id=?",slipId,lot.id);
        else {run('UPDATE production_batch_allocations SET quantity=quantity-? WHERE id=?',lot.take,lot.id);
          run(`INSERT INTO production_batch_allocations(batch_id,order_id,order_item_id,item_id,location_id,quantity,state,release_slip_id)
            VALUES(?,?,?,?,?,?,'shipped',?)`,lot.batch_id,orderId,l.id,l.item_id,lot.location_id,lot.take,slipId);}
      }
      const stockOut=t.quantity-t.units.filter(u=>u.direct_sold_at).length;
      if(stockOut>0)applyStockChange({itemId:l.item_id!,locationId:location,change:-stockOut,buildMode:l.fulfillment_mode==='semi_built'?'semi_built':'assembled',
        reason:`Sold — ${order.number} · release slip #${slipId}`,userId:actor,batchHandled:true});
      for(const u of t.units){if(!u.direct_sold_at)run("UPDATE job_order_units SET status='sold',updated_at=? WHERE id=?",now().toISOString().replace('T',' ').slice(0,19),u.id);run('INSERT INTO release_slip_units(slip_item_id,unit_id) VALUES(?,?)',row,u.id);}
    }
    run('UPDATE order_items SET dispatched_qty=dispatched_qty+?,dispatched_bulk_qty=dispatched_bulk_qty+? WHERE id=?',t.quantity,l.fulfillment_mode==='ckd'?0:t.quantity-t.units.length,l.id);
  }
  const complete=orderOutstanding(orderId)<=1e-9;
  run("UPDATE orders SET fulfilled_at=?,status=?,updated_at=? WHERE id=?",complete?now().toISOString().replace('T',' ').slice(0,19):null,complete?'confirmed':'approved',now().toISOString().replace('T',' ').slice(0,19),orderId);
  return complete;
}
/** Allocate only one shipment record to a physical manifest; never reuse an earlier trip. */
export function bindDelivery(orderId:number,slipId:number,deliveryId?:number|null,siteValidated=false){
  const existing=queryOne<{id:number}>('SELECT id FROM deliveries WHERE release_slip_id=? AND status NOT IN (\'failed\',\'cancelled\')',slipId);
  if(existing){if(deliveryId&&existing.id!==deliveryId)throw tripError('This release slip already belongs to another delivery.');return existing.id;}
  const candidates=deliveryId?[{id:deliveryId}]:queryAll<{id:number}>("SELECT id FROM deliveries WHERE order_id=? AND release_slip_id IS NULL AND status IN ('pending','out_for_delivery') ORDER BY id",orderId);
  if(candidates.length!==1){if(deliveryId)throw tripError('Select an unassigned delivery for this trip.');return null;}
  const d=queryOne<{order_id:number|null;release_slip_id:number|null;status:string}>('SELECT order_id,release_slip_id,status FROM deliveries WHERE id=?',candidates[0]!.id);
  if(!d||d.order_id!==orderId||d.release_slip_id!=null||!['pending','out_for_delivery'].includes(d.status)&&!(siteValidated&&d.status==='cancelled'))throw tripError('The selected delivery cannot take this release slip.');
  run('UPDATE deliveries SET release_slip_id=?,updated_at=? WHERE id=?',slipId,now().toISOString().replace('T',' ').slice(0,19),candidates[0]!.id);return candidates[0]!.id;
}
export function refreshDeliveryCompletion(orderId:number){
  if(orderOutstanding(orderId)>1e-9||!queryOne('SELECT 1 FROM release_slips WHERE order_id=?',orderId))return;
  const incomplete=queryOne(`SELECT 1 FROM release_slips s LEFT JOIN release_slip_details sd ON sd.slip_id=s.id
    WHERE s.order_id=? AND (sd.mode='delivery' OR EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id))
    AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id AND d.status='delivered' AND d.delivery_mode!='courier') LIMIT 1`,orderId);
  if(!incomplete)run("UPDATE orders SET status='completed',updated_at=? WHERE id=?",now().toISOString().replace('T',' ').slice(0,19),orderId);
}

export function tripSummary(orderId:number){
  const totals=queryOne<{ordered:number;dispatched:number;cancelled:number}>(`SELECT COALESCE(SUM(quantity),0) AS ordered,
    COALESCE(SUM(dispatched_qty),0) AS dispatched,COALESCE(SUM(cancelled_qty),0) AS cancelled
    FROM order_items WHERE order_id=? AND item_id IS NOT NULL AND fulfillment_mode!='ckd'`,orderId)!;
  const received=queryOne<{n:number}>(`SELECT COALESCE(SUM(li.quantity),0) AS n FROM release_slip_items li
    JOIN release_slips s ON s.id=li.slip_id LEFT JOIN release_slip_details sd ON sd.slip_id=s.id
    WHERE s.order_id=? AND li.item_id IS NOT NULL AND (EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id AND d.status='delivered' AND d.delivery_mode!='courier')
    OR COALESCE(sd.mode,'pickup')='pickup' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id))`,orderId)!.n;
  const remaining=Math.max(0,totals.ordered-totals.dispatched-totals.cancelled);
  const held=queryAll<OrderItem>("SELECT * FROM order_items WHERE order_id=? AND item_id IS NOT NULL AND fulfillment_mode!='ckd'",orderId).reduce((n,l)=>{const h=lineHeld(l);return n+h.reserved+h.bulk;},0);
  return {...totals,delivered:received,held,remaining,state:!totals.dispatched&&totals.cancelled>=totals.ordered?'cancelled':remaining>1e-9?(totals.dispatched?'partially_fulfilled':'pending'):received+1e-9<totals.dispatched?'awaiting_delivery':'fulfilled'};
}
