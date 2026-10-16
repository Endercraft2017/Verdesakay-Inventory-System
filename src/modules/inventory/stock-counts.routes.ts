/** Physical counts are evidence first, then an independent approval and a guarded correction.
 * A quantity adjustment is safe only when all known serials and exact batches agree with
 * the observation. Tracked differences must be fixed through their identity-aware flows. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, queryAll, queryOne, run } from '../../shared/db';
import { requirePermission } from '../../shared/auth';
import { parseBody } from '../../shared/validation';
import { syncClass } from '../../sync';
import { applyStockChange, getDefaultLocationId, locationName, variantStockAt } from './inventory-stock';
import { findDirectSaleStockoutCase } from './direct-sale-stockout-audit';
import { notifyLowStockCrossed } from '../../shared/push';

const router = Router();
type Mode = 'assembled' | 'semi_built';
type Batch = { batch_id:number; number:string; quantity:number; reserved:number };
type Serial = { id:number; code:string; status:string };
type Snapshot = { item_id:number; item_name:string; sku:string|null; location_id:number; location_name:string;
  build_mode:Mode; book_quantity:number; serials:Serial[]; batches:Batch[]; untracked_quantity:number };
type Count = { id:number; item_id:number; location_id:number; build_mode:Mode; book_quantity:number;
  book_serial_ids:string; book_batches:string; counted_untracked:number; counted_serial_ids:string;
  counted_batches:string; note:string; source_kind:string; source_id:number|null; status:string;
  counted_by:number|null; counted_at:string; reviewed_by:number|null; reviewed_at:string|null;
  review_note:string|null; transaction_id:number|null; completed_at:string|null };
const quantity = z.number().int().min(0).max(1_000_000);
const batchEntry = z.object({batch_id:z.number().int().positive(),quantity});
const submitSchema = z.object({
  item_id:z.number().int().positive(), location_id:z.number().int().positive(),
  build_mode:z.enum(['assembled','semi_built']), expected_quantity:quantity,
  expected_serial_ids:z.array(z.number().int().positive()).max(500),
  expected_batches:z.array(batchEntry).max(500),
  counted_untracked:quantity,
  counted_serial_codes:z.array(z.string().trim().min(1).max(120)).max(500),
  counted_batches:z.array(batchEntry).max(500),
  note:z.string().trim().min(10).max(1000),
  source_kind:z.enum(['manual','discrepancy','direct_sale']).default('manual'),
  source_id:z.number().int().positive().nullable().optional(),
});
const noteSchema = z.object({note:z.string().trim().min(10).max(1000)});

function serialCode(row:{id:number;identifier:string|null}) { return row.identifier?.trim() || `#${row.id}`; }
function snapshot(itemId:number,locationId:number,mode:Mode):Snapshot|null {
  const item=queryOne<{id:number;name:string;sku:string|null}>('SELECT id,name,sku FROM inventory_items WHERE id=?',itemId);
  const loc=queryOne<{id:number}>('SELECT id FROM locations WHERE id=?',locationId);
  if(!item||!loc) return null;
  const serials=queryAll<{id:number;identifier:string|null;status:string}>(`SELECT u.id,u.identifier,u.status FROM job_order_units u
    JOIN job_orders j ON j.id=u.job_order_id
    WHERE COALESCE(u.product_item_id,j.product_item_id)=? AND COALESCE(u.location_id,j.output_location_id,?)=? AND j.build_mode=?
      AND u.status IN ('in_stock','reserved') ORDER BY u.id`,itemId,getDefaultLocationId(),locationId,mode)
    .map(u=>({id:u.id,code:serialCode(u),status:u.status}));
  const batches=queryAll<Batch>(`SELECT s.batch_id,pb.number,s.quantity,
    COALESCE((SELECT SUM(a.quantity) FROM production_batch_allocations a
      WHERE a.batch_id=s.batch_id AND a.location_id=s.location_id AND a.state='reserved'),0) AS reserved
    FROM production_batch_stock s JOIN production_batches pb ON pb.id=s.batch_id
    JOIN job_orders j ON j.id=pb.job_order_id
    WHERE COALESCE(pb.product_item_id,j.product_item_id)=? AND s.location_id=? AND j.build_mode=? AND s.quantity>0
    ORDER BY s.batch_id`,itemId,locationId,mode);
  const book=variantStockAt(itemId,locationId,mode);
  return {item_id:itemId,item_name:item.name,sku:item.sku,location_id:locationId,
    location_name:locationName(locationId),build_mode:mode,book_quantity:book,serials,batches,
    untracked_quantity:book-serials.length-batches.reduce((n,b)=>n+b.quantity,0)};
}
function recordedBatches(batches:Batch[]) {return batches.map(b=>({batch_id:b.batch_id,quantity:b.quantity}));}
function sortedCodes(codes:string[]) {return [...codes].sort((a,b)=>a.localeCompare(b));}
function same(a:unknown,b:unknown) {return JSON.stringify(a)===JSON.stringify(b);}
function countedTotal(c:Count) {
  return c.counted_untracked+(JSON.parse(c.counted_serial_ids) as string[]).length+
    (JSON.parse(c.counted_batches) as {quantity:number}[]).reduce((n,b)=>n+b.quantity,0);
}
function snapshotMatchesCount(c:Count,current:Snapshot|null) {
  return !!current && current.book_quantity===c.book_quantity &&
    same(current.serials.map(s=>s.id),JSON.parse(c.book_serial_ids)) &&
    same(recordedBatches(current.batches),JSON.parse(c.book_batches));
}
function detail(c:Count) {
  const item=queryOne<{name:string;sku:string|null}>('SELECT name,sku FROM inventory_items WHERE id=?',c.item_id);
  const current=snapshot(c.item_id,c.location_id,c.build_mode);
  const movements=queryAll<{transaction_id:number;batch_id:number|null;change:number;reason:string|null}>(
    `SELECT m.transaction_id,m.batch_id,t.change,t.reason FROM stock_count_movements m
      JOIN inventory_transactions t ON t.id=m.transaction_id WHERE m.count_id=? ORDER BY t.id`,c.id);
  return {...c,item_name:item?.name??'(removed)',sku:item?.sku??null,
    location_name:current?.location_name??'(removed)',counted_quantity:countedTotal(c),
    variance:countedTotal(c)-c.book_quantity,current_quantity:current?.book_quantity??null,
    book_serial_ids:JSON.parse(c.book_serial_ids),book_batches:JSON.parse(c.book_batches),
    counted_serial_codes:JSON.parse(c.counted_serial_ids),counted_batches:JSON.parse(c.counted_batches),
    current_serials:current?.serials??[],current_batches:current?.batches??[],
    current_untracked:current?.untracked_quantity??null,
    movements,
    tracked_difference:!same(sortedCodes(current?.serials.map(s=>s.code)??[]),sortedCodes(JSON.parse(c.counted_serial_ids)))
      || !same(current?recordedBatches(current.batches):[],
        (JSON.parse(c.counted_batches) as {batch_id:number;quantity:number}[]).filter(b=>b.quantity>0)),
  };
}
function id(req:Request) {const n=Number(req.params.id);return Number.isSafeInteger(n)&&n>0?n:0;}
function count(req:Request) {return queryOne<Count>('SELECT * FROM stock_counts WHERE id=?',id(req));}
const countHome={home:(req:Request)=>({location:Number(req.body?.location_id)||null})};
const existingHome={home:(req:Request)=>({location:queryOne<{location_id:number}>(
  'SELECT location_id FROM stock_counts WHERE id=?',id(req))?.location_id??null})};

router.get('/context',requirePermission('inventory.view'),(req,res)=>{
  const itemId=Number(req.query.item_id),locationId=Number(req.query.location_id);
  const mode=req.query.build_mode==='semi_built'?'semi_built':'assembled';
  if(!Number.isSafeInteger(itemId)||!Number.isSafeInteger(locationId)||itemId<1||locationId<1){
    res.status(400).json({error:'Choose an item and a location'});return;
  }
  const row=snapshot(itemId,locationId,mode);
  if(!row){res.status(404).json({error:'Item or location not found'});return;}
  res.json(row);
});
router.get('/',requirePermission('inventory.view'),(req,res)=>{
  const status=typeof req.query.status==='string'?req.query.status:'open';
  const where=status==='all'?'1=1':status==='open'?"c.status IN ('submitted','approved')":'c.status=?';
  if(!['all','open','submitted','approved','applied','rejected'].includes(status)){
    res.status(400).json({error:'Invalid status'});return;
  }
  const rows=queryAll<Count>(`SELECT c.* FROM stock_counts c WHERE ${where} ORDER BY c.id DESC LIMIT 300`,
    ...(status==='all'||status==='open'?[]:[status]));
  res.json(rows.map(detail));
});
router.get('/:id',requirePermission('inventory.view'),(req,res)=>{
  const row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  res.json(detail(row));
});
router.post('/',requirePermission('inventory.view'),syncClass('physical',countHome),(req,res)=>{
  const input=parseBody(submitSchema,req.body);
  const current=snapshot(input.item_id,input.location_id,input.build_mode);
  if(!current){res.status(404).json({error:'Item or location not found'});return;}
  if(current.untracked_quantity<0){res.status(409).json({error:'Book stock is below tracked stock; investigate before counting',code:'book_integrity'});return;}
  const expectedBatches=recordedBatches(current.batches);
  if(current.book_quantity!==input.expected_quantity||
    !same(current.serials.map(s=>s.id),input.expected_serial_ids)||!same(expectedBatches,input.expected_batches)){
    res.status(409).json({error:'Stock changed since the count screen loaded; refresh and recount',code:'stale_count'});return;
  }
  const codes=input.counted_serial_codes;
  if(new Set(codes).size!==codes.length){res.status(400).json({error:'A serial was counted more than once'});return;}
  const batchIds=current.batches.map(b=>b.batch_id);
  if(!same(batchIds,input.counted_batches.map(b=>b.batch_id))){
    res.status(400).json({error:'Enter one count for every displayed batch, in the shown order'});return;
  }
  if(input.source_kind==='manual' && input.source_id!=null){res.status(400).json({error:'Manual count cannot have a source ID'});return;}
  if(input.source_kind!=='manual'){
    if(!input.source_id){res.status(400).json({error:'Source ID is required'});return;}
    if(input.source_kind==='discrepancy'){
      const source=queryOne<{item_id:number;location_id:number|null}>(
        'SELECT item_id,location_id FROM stock_discrepancies WHERE id=?',input.source_id);
      if(!source||source.item_id!==input.item_id||source.location_id!==input.location_id){
        res.status(400).json({error:'Discrepancy does not match this item and location'});return;}
    }else if(!findDirectSaleStockoutCase(input.source_id,input.item_id)){
      res.status(400).json({error:'Direct-sale audit case does not match this item'});return;
    }
  }
  const info=run(`INSERT INTO stock_counts(item_id,location_id,build_mode,book_quantity,book_serial_ids,book_batches,
    counted_untracked,counted_serial_ids,counted_batches,note,source_kind,source_id,counted_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,input.item_id,input.location_id,input.build_mode,current.book_quantity,
    JSON.stringify(current.serials.map(s=>s.id)),JSON.stringify(expectedBatches),input.counted_untracked,
    JSON.stringify(codes),JSON.stringify(input.counted_batches),input.note,input.source_kind,input.source_id??null,req.user!.id);
  res.status(201).json(detail(queryOne<Count>('SELECT * FROM stock_counts WHERE id=?',Number(info.lastInsertRowid))!));
});
router.post('/:id/approve',requirePermission('inventory.adjust'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status!=='submitted'){res.status(409).json({error:'Only a submitted count can be approved'});return;}
  if(row.counted_by===req.user!.id){res.status(409).json({error:'A different person must approve the count'});return;}
  if(!snapshotMatchesCount(row,snapshot(row.item_id,row.location_id,row.build_mode))){
    res.status(409).json({error:'Stock changed after the physical count; recount before approval',code:'stale_count'});return;
  }
  run(`UPDATE stock_counts SET status='approved',reviewed_by=?,reviewed_at=datetime('now'),review_note=? WHERE id=?`,req.user!.id,note,row.id);
  res.json(detail(count(req)!));
});
router.post('/:id/reject',requirePermission('inventory.adjust'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status!=='submitted'){res.status(409).json({error:'Only a submitted count can be rejected'});return;}
  run(`UPDATE stock_counts SET status='rejected',reviewed_by=?,reviewed_at=datetime('now'),review_note=? WHERE id=?`,req.user!.id,note,row.id);
  res.json(detail(count(req)!));
});
router.post('/:id/apply',requirePermission('inventory.adjust'),syncClass('physical',existingHome),(req,res)=>{
  const row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status==='applied'){res.json(detail(row));return;}
  if(row.status!=='approved'){res.status(409).json({error:'Count needs approval before correction'});return;}
  const current=snapshot(row.item_id,row.location_id,row.build_mode);
  if(!current||!snapshotMatchesCount(row,current)){
    res.status(409).json({error:'Stock changed after the count; recount before correction',code:'stale_count'});return;
  }
  if(!same(sortedCodes(current.serials.map(s=>s.code)),sortedCodes(JSON.parse(row.counted_serial_ids)))){
    res.status(409).json({error:'Serialized unit count differs. Resolve the exact unit records, then verify this count.',
      code:'tracked_resolution_required'});return;
  }
  const countedBatches=JSON.parse(row.counted_batches) as {batch_id:number;quantity:number}[];
  // A named batch may be corrected only within its known receipts/shipments/returns,
  // and never below a sale reservation. Do not invent a new production receipt.
  for(const entry of countedBatches){
    const batch=current.batches.find(b=>b.batch_id===entry.batch_id)!;
    if(entry.quantity+1e-9<batch.reserved){
      res.status(409).json({error:`Batch ${batch.number} has ${batch.reserved} reserved; release that allocation before correction`,code:'batch_reserved'});return;
    }
    if(entry.quantity>batch.quantity){
      const provenance=queryOne<{received:number;shipped:number;returned:number;elsewhere:number}>(`SELECT
        (SELECT COALESCE(SUM(quantity),0) FROM production_receipt_items WHERE batch_id=?) AS received,
        (SELECT COALESCE(SUM(quantity),0) FROM production_batch_allocations WHERE batch_id=? AND state='shipped') AS shipped,
        (SELECT COALESCE(SUM(r.quantity),0) FROM production_batch_return_links l JOIN sales_returns r ON r.id=l.return_id
          WHERE l.batch_id=? AND r.status='restocked') AS returned,
        (SELECT COALESCE(SUM(quantity),0) FROM production_batch_stock WHERE batch_id=? AND location_id!=?) AS elsewhere`,
        entry.batch_id,entry.batch_id,entry.batch_id,entry.batch_id,row.location_id)!;
      if(entry.quantity+provenance.elsewhere>provenance.received-provenance.shipped+provenance.returned+1e-9){
        res.status(409).json({error:`Batch ${batch.number} count exceeds its known receipts less shipments. Investigate provenance first.`,code:'batch_provenance'});return;
      }
    }
  }
  const untrackedChange=row.counted_untracked-current.untracked_quantity;
  const item=queryOne<{id:number;name:string;min_quantity:number;unit:string|null;quantity:number}>(
    'SELECT id,name,min_quantity,unit,quantity FROM inventory_items WHERE id=?',row.item_id)!;
  let totalChange=0, firstTx:number|null=null;
  db.exec('BEGIN');
  try{
    for(const entry of countedBatches){
      const batch=current.batches.find(b=>b.batch_id===entry.batch_id)!;
      const change=entry.quantity-batch.quantity;
      if(!change)continue;
      run('UPDATE production_batch_stock SET quantity=? WHERE batch_id=? AND location_id=?',entry.quantity,entry.batch_id,row.location_id);
      applyStockChange({itemId:row.item_id,locationId:row.location_id,buildMode:row.build_mode,
        change,reason:`Stock count #${row.id}: batch ${batch.number} — ${row.note}`,userId:req.user!.id,batchHandled:true});
      const tx=queryOne<{id:number}>('SELECT MAX(id) AS id FROM inventory_transactions')!.id;
      run('INSERT INTO stock_count_movements(count_id,transaction_id,batch_id) VALUES(?,?,?)',row.id,tx,entry.batch_id);
      firstTx??=tx;totalChange+=change;
    }
    if(untrackedChange){
      applyStockChange({itemId:row.item_id,locationId:row.location_id,buildMode:row.build_mode,
        change:untrackedChange,reason:`Stock count #${row.id}: untracked — ${row.note}`,userId:req.user!.id});
      const tx=queryOne<{id:number}>('SELECT MAX(id) AS id FROM inventory_transactions')!.id;
      run('INSERT INTO stock_count_movements(count_id,transaction_id,batch_id) VALUES(?,?,NULL)',row.id,tx);
      firstTx??=tx;totalChange+=untrackedChange;
    }
    run(`UPDATE stock_counts SET status='applied',transaction_id=?,completed_at=datetime('now') WHERE id=?`,firstTx,row.id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(totalChange<0) notifyLowStockCrossed(item,item.quantity,item.quantity+totalChange);
  res.json(detail(count(req)!));
});
router.post('/:id/verify',requirePermission('inventory.adjust'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status==='applied'){res.json(detail(row));return;}
  if(row.status!=='approved'){res.status(409).json({error:'Count needs approval before verification'});return;}
  const current=snapshot(row.item_id,row.location_id,row.build_mode);
  if(!current||current.book_quantity!==countedTotal(row)||
    !same(sortedCodes(current.serials.map(s=>s.code)),sortedCodes(JSON.parse(row.counted_serial_ids)))||
    !same(recordedBatches(current.batches),(JSON.parse(row.counted_batches) as {batch_id:number;quantity:number}[]).filter(b=>b.quantity>0))){
    res.status(409).json({error:'Current stock or tracked identities do not match the physical count yet',code:'not_reconciled'});return;
  }
  run(`UPDATE stock_counts SET status='applied',completed_at=datetime('now'),review_note=review_note||' / '||? WHERE id=?`,note,row.id);
  res.json(detail(count(req)!));
});

export default router;
