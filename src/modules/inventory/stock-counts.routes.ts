/** Physical counts are evidence first, then an independent approval and a guarded correction.
 * A quantity adjustment is safe only when all known serials and exact batches agree with
 * the observation. Tracked differences must be fixed through their identity-aware flows. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, queryAll, queryOne, run } from '../../shared/db';
import { authUserById, requirePermission } from '../../shared/auth';
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
  counted_batches:string; note:string; source_kind:string; source_id:number|null;
  source_evidence_hash:string|null; source_closed_by:number|null; source_closed_at:string|null;
  source_close_note:string|null; status:string;
  task_id:number|null;
  counted_by:number|null; counted_at:string; reviewed_by:number|null; reviewed_at:string|null;
  review_note:string|null; transaction_id:number|null; completed_at:string|null };
const quantity = z.number().int().min(0).max(1_000_000);
const batchEntry = z.object({batch_id:z.number().int().positive(),quantity});
const submitSchema = z.object({
  item_id:z.number().int().positive(), location_id:z.number().int().positive(),
  build_mode:z.enum(['assembled','semi_built']), expected_quantity:z.number().int().min(-1_000_000).max(1_000_000),
  expected_serial_ids:z.array(z.number().int().positive()).max(500),
  expected_batches:z.array(batchEntry).max(500),
  counted_untracked:quantity,
  counted_serial_codes:z.array(z.string().trim().min(1).max(120)).max(500),
  counted_batches:z.array(batchEntry).max(500),
  note:z.string().trim().min(10).max(1000),
  source_kind:z.enum(['manual','discrepancy','direct_sale']).default('manual'),
  source_id:z.number().int().positive().nullable().optional(),
  task_id:z.number().int().positive().nullable().optional(),
});
const noteSchema = z.object({note:z.string().trim().min(10).max(1000)});
const dateString=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{
  const parsed=new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===v;
},'Enter a real calendar date');
const taskSchema=z.object({
  item_id:z.number().int().positive(),location_id:z.number().int().positive(),
  build_mode:z.enum(['assembled','semi_built']),assigned_to:z.number().int().positive(),
  due_date:dateString,repeat_days:z.number().int().min(1).max(365).nullable().optional(),
  note:z.string().trim().max(1000).default(''),
});
const taskEditSchema=taskSchema.pick({assigned_to:true,due_date:true,repeat_days:true,note:true});
type Task={id:number;item_id:number;location_id:number;build_mode:Mode;assigned_to:number;
  due_date:string;repeat_days:number|null;note:string;status:'open'|'completed'|'cancelled';
  planned_by:number|null;planned_at:string;previous_task_id:number|null;completed_by:number|null;
  completed_at:string|null;cancel_note:string|null;cancelled_by:number|null;cancelled_at:string|null;
  latest_count_id:number|null;latest_count_status:string|null};

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
type UnitReference={id:number;code:string;status:string;job_order_id:number;location_id:number|null};
function unitReference(u:{id:number;identifier:string|null;status:string;job_order_id:number;location_id:number|null}):UnitReference {
  return {id:u.id,code:serialCode(u),status:u.status,job_order_id:u.job_order_id,location_id:u.location_id};
}
function serialEvidence(c:Count) {
  const observed=JSON.parse(c.counted_serial_ids) as string[];
  const bookIds=JSON.parse(c.book_serial_ids) as number[];
  const book=bookIds.map(unitId=>queryOne<{id:number;identifier:string|null;status:string;job_order_id:number;location_id:number|null}>(
    'SELECT id,identifier,status,job_order_id,location_id FROM job_order_units WHERE id=?',unitId))
    .filter((u):u is NonNullable<typeof u>=>!!u).map(unitReference);
  const observedCodes=new Set(observed);
  const bookCodes=new Set(book.map(u=>u.code));
  const unexpected=observed.filter(code=>!bookCodes.has(code)).map(code=>{
    const matches=queryAll<{id:number;identifier:string|null;status:string;job_order_id:number;location_id:number|null}>(
      `SELECT id,identifier,status,job_order_id,location_id FROM job_order_units
       WHERE LOWER(TRIM(identifier))=LOWER(?) OR ('#'||id)=? ORDER BY id LIMIT 10`,code,code).map(unitReference);
    return {code,matches};
  });
  return {book_serials:book,missing_serials:book.filter(u=>!observedCodes.has(u.code)),unexpected_serials:unexpected};
}
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
function currentMatchesObservation(c:Count,current:Snapshot|null) {
  return !!current && current.book_quantity===countedTotal(c) &&
    same(sortedCodes(current.serials.map(s=>s.code)),sortedCodes(JSON.parse(c.counted_serial_ids))) &&
    same(recordedBatches(current.batches),(JSON.parse(c.counted_batches) as {batch_id:number;quantity:number}[]).filter(b=>b.quantity>0));
}
function sourceState(c:Count) {
  if(c.source_kind==='manual'||!c.source_id)return null;
  if(c.source_kind==='discrepancy') return queryOne<{status:string}>(
    'SELECT status FROM stock_discrepancies WHERE id=?',c.source_id)?.status??'missing';
  const candidate=findDirectSaleStockoutCase(c.source_id,c.item_id);
  return !candidate?'missing':candidate.evidence_hash!==c.source_evidence_hash?'changed':candidate.status;
}
function detail(c:Count,includeSerialEvidence=true) {
  const item=queryOne<{name:string;sku:string|null}>('SELECT name,sku FROM inventory_items WHERE id=?',c.item_id);
  const current=snapshot(c.item_id,c.location_id,c.build_mode);
  const movements=queryAll<{transaction_id:number;batch_id:number|null;change:number;reason:string|null}>(
    `SELECT m.transaction_id,m.batch_id,t.change,t.reason FROM stock_count_movements m
      JOIN inventory_transactions t ON t.id=m.transaction_id WHERE m.count_id=? ORDER BY t.id`,c.id);
  const task=c.task_id?taskById(c.task_id):null;
  return {...c,...(includeSerialEvidence?serialEvidence(c):{}),item_name:item?.name??'(removed)',sku:item?.sku??null,
    location_name:current?.location_name??'(removed)',counted_quantity:countedTotal(c),
    variance:countedTotal(c)-c.book_quantity,current_quantity:current?.book_quantity??null,
    book_serial_ids:JSON.parse(c.book_serial_ids),book_batches:JSON.parse(c.book_batches),
    counted_serial_codes:JSON.parse(c.counted_serial_ids),counted_batches:JSON.parse(c.counted_batches),
    current_serials:current?.serials??[],current_batches:current?.batches??[],
    current_untracked:current?.untracked_quantity??null,
    movements,source_status:sourceState(c),task_due_date:task?.due_date??null,
    task_status:task?.status??null,
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
function taskId(req:Request){const n=Number(req.params.taskId);return Number.isSafeInteger(n)&&n>0?n:0;}
function taskById(taskId:number):Task|undefined{return queryOne<Task>(`SELECT t.*,
  (SELECT c.id FROM stock_counts c WHERE c.task_id=t.id ORDER BY c.id DESC LIMIT 1) AS latest_count_id,
  (SELECT c.status FROM stock_counts c WHERE c.task_id=t.id ORDER BY c.id DESC LIMIT 1) AS latest_count_status
  FROM stock_count_tasks t WHERE t.id=?`,taskId);}
function taskOutput(t:Task){
  const item=queryOne<{name:string;sku:string|null}>('SELECT name,sku FROM inventory_items WHERE id=?',t.item_id);
  const assigned=queryOne<{full_name:string}>('SELECT full_name FROM users WHERE id=?',t.assigned_to);
  return {...t,item_name:item?.name??'(removed)',sku:item?.sku??null,
    location_name:locationName(t.location_id),assigned_to_name:assigned?.full_name??'(removed)',
    overdue:t.status==='open'&&t.due_date<new Date().toISOString().slice(0,10)};
}
function validAssignee(userId:number){const p=authUserById(userId)?.permissions;return p?.includes('inventory.view')===true && p.includes('inventory.count');}
const taskHome={home:(req:Request)=>({location:Number(req.body?.location_id)||null})};
const existingTaskHome={home:(req:Request)=>({location:queryOne<{location_id:number}>(
  'SELECT location_id FROM stock_count_tasks WHERE id=?',taskId(req))?.location_id??null})};
function completeTask(row:Count,actorId:number){
  if(!row.task_id)return;
  const task=taskById(row.task_id);
  if(!task||task.status!=='open')throw new Error('Count assignment is no longer open');
  run(`UPDATE stock_count_tasks SET status='completed',completed_by=?,completed_at=datetime('now') WHERE id=?`,actorId,task.id);
  if(task.repeat_days){
    run(`INSERT INTO stock_count_tasks(item_id,location_id,build_mode,assigned_to,due_date,repeat_days,note,planned_by,previous_task_id)
      VALUES(?,?,?,?,date(CASE WHEN ?>date('now') THEN ? ELSE date('now') END,?),?,?,?,?)`,
      task.item_id,task.location_id,task.build_mode,task.assigned_to,task.due_date,task.due_date,
      `+${task.repeat_days} day`,task.repeat_days,task.note,task.planned_by,task.id);
  }
}

router.get('/tasks',requirePermission('inventory.view'),(req,res)=>{
  const status=typeof req.query.status==='string'?req.query.status:'open';
  if(!['open','all','completed','cancelled'].includes(status)){res.status(400).json({error:'Invalid task status'});return;}
  const mine=req.query.mine==='1';
  const rows=queryAll<Task>(`SELECT t.*,
    (SELECT c.id FROM stock_counts c WHERE c.task_id=t.id ORDER BY c.id DESC LIMIT 1) AS latest_count_id,
    (SELECT c.status FROM stock_counts c WHERE c.task_id=t.id ORDER BY c.id DESC LIMIT 1) AS latest_count_status
    FROM stock_count_tasks t WHERE (?='all' OR t.status=?) AND (?=0 OR t.assigned_to=?)
    ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.due_date,t.id`,
    status,status,mine?1:0,req.user!.id);
  res.json(rows.map(taskOutput));
});
router.get('/tasks/assignees',requirePermission('inventory.review_counts'),(_req,res)=>{
  const users=queryAll<{id:number;full_name:string}>('SELECT id,full_name FROM users WHERE active=1 ORDER BY full_name COLLATE NOCASE');
  res.json(users.filter(u=>validAssignee(u.id)));
});
router.get('/tasks/coverage',requirePermission('inventory.view'),(_req,res)=>{
  const rows=queryAll<{item_id:number;location_id:number;build_mode:Mode;quantity:number;item_name:string;sku:string|null;
    last_count_at:string|null;open_task_id:number|null;due_date:string|null}>(`WITH positions AS (
      SELECT item_id,location_id,build_mode FROM inventory_variant_stock WHERE quantity!=0
      UNION SELECT s.item_id,s.location_id,'assembled' FROM inventory_stock s WHERE s.quantity!=0
        AND NOT EXISTS(SELECT 1 FROM inventory_variant_stock v WHERE v.item_id=s.item_id AND v.location_id=s.location_id)
      UNION SELECT item_id,location_id,build_mode FROM stock_count_tasks
      UNION SELECT item_id,location_id,build_mode FROM stock_counts WHERE status='applied'
    ) SELECT p.*,i.name AS item_name,i.sku,
      COALESCE(v.quantity,CASE WHEN p.build_mode='assembled' THEN s.quantity ELSE 0 END,0) AS quantity,
      (SELECT MAX(c.completed_at) FROM stock_counts c WHERE c.item_id=p.item_id AND c.location_id=p.location_id
        AND c.build_mode=p.build_mode AND c.status='applied') AS last_count_at,
      (SELECT t.id FROM stock_count_tasks t WHERE t.item_id=p.item_id AND t.location_id=p.location_id
        AND t.build_mode=p.build_mode AND t.status='open') AS open_task_id,
      (SELECT t.due_date FROM stock_count_tasks t WHERE t.item_id=p.item_id AND t.location_id=p.location_id
        AND t.build_mode=p.build_mode AND t.status='open') AS due_date
    FROM positions p JOIN inventory_items i ON i.id=p.item_id
    LEFT JOIN inventory_variant_stock v ON v.item_id=p.item_id AND v.location_id=p.location_id AND v.build_mode=p.build_mode
    LEFT JOIN inventory_stock s ON s.item_id=p.item_id AND s.location_id=p.location_id
    ORDER BY i.name,p.location_id,p.build_mode`);
  res.json(rows.map(r=>({...r,location_name:locationName(r.location_id),
    overdue:!!r.due_date&&r.due_date<new Date().toISOString().slice(0,10)})));
});
router.post('/tasks',requirePermission('inventory.review_counts'),syncClass('claim',taskHome),(req,res)=>{
  const input=parseBody(taskSchema,req.body);
  if(!snapshot(input.item_id,input.location_id,input.build_mode)){
    res.status(404).json({error:'Item or location not found'});return;}
  if(!validAssignee(input.assigned_to)){
    res.status(400).json({error:'Assign an active user with inventory.view access'});return;}
  const existing=queryOne<{id:number}>(`SELECT id FROM stock_count_tasks
    WHERE item_id=? AND location_id=? AND build_mode=? AND status='open'`,
    input.item_id,input.location_id,input.build_mode);
  if(existing){res.status(409).json({error:`An open count assignment already exists (#${existing.id})`,code:'task_exists'});return;}
  const info=run(`INSERT INTO stock_count_tasks(item_id,location_id,build_mode,assigned_to,due_date,repeat_days,note,planned_by)
    VALUES(?,?,?,?,?,?,?,?)`,input.item_id,input.location_id,input.build_mode,input.assigned_to,
    input.due_date,input.repeat_days??null,input.note,req.user!.id);
  res.status(201).json(taskOutput(taskById(Number(info.lastInsertRowid))!));
});
router.put('/tasks/:taskId',requirePermission('inventory.review_counts'),syncClass('claim',existingTaskHome),(req,res)=>{
  const input=parseBody(taskEditSchema,req.body),task=taskById(taskId(req));
  if(!task){res.status(404).json({error:'Count assignment not found'});return;}
  if(task.status!=='open'||['submitted','approved'].includes(task.latest_count_status??'')){
    res.status(409).json({error:'An in-progress or finished count assignment cannot be edited'});return;}
  if(!validAssignee(input.assigned_to)){
    res.status(400).json({error:'Assign an active user with inventory.view access'});return;}
  run(`UPDATE stock_count_tasks SET assigned_to=?,due_date=?,repeat_days=?,note=? WHERE id=?`,
    input.assigned_to,input.due_date,input.repeat_days??null,input.note,task.id);
  res.json(taskOutput(taskById(task.id)!));
});
router.post('/tasks/:taskId/cancel',requirePermission('inventory.review_counts'),syncClass('claim',existingTaskHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),task=taskById(taskId(req));
  if(!task){res.status(404).json({error:'Count assignment not found'});return;}
  if(task.status!=='open'||['submitted','approved'].includes(task.latest_count_status??'')){
    res.status(409).json({error:'An in-progress or finished count assignment cannot be cancelled'});return;}
  run(`UPDATE stock_count_tasks SET status='cancelled',cancel_note=?,cancelled_by=?,cancelled_at=datetime('now') WHERE id=?`,
    note,req.user!.id,task.id);
  res.json(taskOutput(taskById(task.id)!));
});

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
  res.json(rows.map(row=>detail(row,false)));
});
router.get('/:id',requirePermission('inventory.view'),(req,res)=>{
  const row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  res.json(detail(row));
});
router.post('/',requirePermission('inventory.count'),syncClass('physical',countHome),(req,res)=>{
  const input=parseBody(submitSchema,req.body);
  const current=snapshot(input.item_id,input.location_id,input.build_mode);
  if(!current){res.status(404).json({error:'Item or location not found'});return;}
  const expectedBatches=recordedBatches(current.batches);
  if(current.book_quantity!==input.expected_quantity||
    !same(current.serials.map(s=>s.id),input.expected_serial_ids)||!same(expectedBatches,input.expected_batches)){
    res.status(409).json({error:'Stock changed since the count screen loaded; refresh and recount',code:'stale_count'});return;
  }
  const codes=input.counted_serial_codes;
  if(new Set(codes.map(code=>code.toLocaleLowerCase())).size!==codes.length){
    res.status(400).json({error:'A serial was counted more than once'});return;
  }
  const batchIds=current.batches.map(b=>b.batch_id);
  if(!same(batchIds,input.counted_batches.map(b=>b.batch_id))){
    res.status(400).json({error:'Enter one count for every displayed batch, in the shown order'});return;
  }
  if(input.source_kind==='manual' && input.source_id!=null){res.status(400).json({error:'Manual count cannot have a source ID'});return;}
  if(input.task_id){
    const task=taskById(input.task_id);
    if(!task||task.status!=='open'||task.item_id!==input.item_id||task.location_id!==input.location_id||
      task.build_mode!==input.build_mode||task.assigned_to!==req.user!.id||input.source_kind!=='manual'){
      res.status(409).json({error:'Count assignment is closed, belongs to another worker, or does not match this stock position',code:'task_mismatch'});return;
    }
    if(['submitted','approved','applied'].includes(task.latest_count_status??'')){
      res.status(409).json({error:'This assignment already has a count awaiting review or reconciliation',code:'task_in_progress'});return;
    }
  }else if(input.source_kind==='manual'){
    const planned=queryOne<{id:number}>(`SELECT id FROM stock_count_tasks WHERE item_id=? AND location_id=?
      AND build_mode=? AND status='open'`,input.item_id,input.location_id,input.build_mode);
    if(planned){res.status(409).json({error:`Use open count assignment #${planned.id} for this stock position`,code:'planned_task_required'});return;}
  }
  let sourceEvidenceHash:string|null=null;
  if(input.source_kind!=='manual'){
    if(!input.source_id){res.status(400).json({error:'Source ID is required'});return;}
    if(input.source_kind==='discrepancy'){
      const source=queryOne<{item_id:number;location_id:number|null;status:string}>(
        'SELECT item_id,location_id,status FROM stock_discrepancies WHERE id=?',input.source_id);
      if(!source||source.item_id!==input.item_id||source.location_id!==input.location_id){
        res.status(400).json({error:'Discrepancy does not match this item and location'});return;}
      if(source.status!=='open'){res.status(409).json({error:'Discrepancy is already resolved'});return;}
    }else{
      const candidate=findDirectSaleStockoutCase(input.source_id,input.item_id);
      if(!candidate){res.status(400).json({error:'Direct-sale audit case does not match this item'});return;}
      if(candidate.status!=='open'){res.status(409).json({error:'Direct-sale audit case is already reviewed'});return;}
      sourceEvidenceHash=candidate.evidence_hash;
    }
  }
  const info=run(`INSERT INTO stock_counts(item_id,location_id,build_mode,book_quantity,book_serial_ids,book_batches,
    counted_untracked,counted_serial_ids,counted_batches,note,source_kind,source_id,source_evidence_hash,task_id,counted_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,input.item_id,input.location_id,input.build_mode,current.book_quantity,
    JSON.stringify(current.serials.map(s=>s.id)),JSON.stringify(expectedBatches),input.counted_untracked,
    JSON.stringify(codes),JSON.stringify(input.counted_batches),input.note,input.source_kind,input.source_id??null,
    sourceEvidenceHash,input.task_id??null,req.user!.id);
  res.status(201).json(detail(queryOne<Count>('SELECT * FROM stock_counts WHERE id=?',Number(info.lastInsertRowid))!));
});
router.post('/:id/approve',requirePermission('inventory.review_counts'),syncClass('claim',existingHome),(req,res)=>{
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
router.post('/:id/reject',requirePermission('inventory.review_counts'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status!=='submitted'){res.status(409).json({error:'Only a submitted count can be rejected'});return;}
  run(`UPDATE stock_counts SET status='rejected',reviewed_by=?,reviewed_at=datetime('now'),review_note=? WHERE id=?`,req.user!.id,note,row.id);
  res.json(detail(count(req)!));
});
router.post('/:id/apply',requirePermission('inventory.review_counts'),syncClass('physical',existingHome),(req,res)=>{
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
    completeTask(row,req.user!.id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(totalChange<0) notifyLowStockCrossed(item,item.quantity,item.quantity+totalChange);
  res.json(detail(count(req)!));
});
router.post('/:id/verify',requirePermission('inventory.review_counts'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.status==='applied'){res.json(detail(row));return;}
  if(row.status!=='approved'){res.status(409).json({error:'Count needs approval before verification'});return;}
  const current=snapshot(row.item_id,row.location_id,row.build_mode);
  if(!currentMatchesObservation(row,current)){
    res.status(409).json({error:'Current stock or tracked identities do not match the physical count yet',code:'not_reconciled'});return;
  }
  db.exec('BEGIN');
  try{
    run(`UPDATE stock_counts SET status='applied',completed_at=datetime('now'),review_note=review_note||' / '||? WHERE id=?`,note,row.id);
    completeTask(row,req.user!.id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  res.json(detail(count(req)!));
});

// A completed count supplies evidence for closing its original issue. Closure is a separate
// supervisor decision: it never moves stock and cannot review changed sale-ledger evidence.
router.post('/:id/close-source',requirePermission('inventory.review_counts'),syncClass('claim',existingHome),(req,res)=>{
  const {note}=parseBody(noteSchema,req.body),row=count(req);
  if(!row){res.status(404).json({error:'Count not found'});return;}
  if(row.source_kind==='manual'||!row.source_id){res.status(409).json({error:'This count has no linked issue'});return;}
  if(row.source_closed_at){
    if(row.source_close_note===note){res.json(detail(row));return;}
    res.status(409).json({error:'This count already closed its linked issue with a different note'});return;
  }
  if(row.status!=='applied'){res.status(409).json({error:'Reconcile the approved count before closing its linked issue'});return;}
  if(!currentMatchesObservation(row,snapshot(row.item_id,row.location_id,row.build_mode))){
    res.status(409).json({error:'Stock changed since the count was reconciled; recount before closing the issue',code:'stale_count'});return;
  }
  db.exec('BEGIN');
  try{
    if(row.source_kind==='discrepancy'){
      const source=queryOne<{item_id:number;location_id:number|null;status:string}>(
        'SELECT item_id,location_id,status FROM stock_discrepancies WHERE id=?',row.source_id);
      if(!source||source.item_id!==row.item_id||source.location_id!==row.location_id||source.status!=='open'){
        db.exec('ROLLBACK');res.status(409).json({error:'Linked discrepancy is missing, changed, or already resolved'});return;
      }
      run(`UPDATE stock_discrepancies SET status='resolved',resolution_note=?,resolved_by=?,resolved_at=datetime('now') WHERE id=?`,
        `Physical count #${row.id}: ${note}`,req.user!.id,row.source_id);
    }else{
      const candidate=findDirectSaleStockoutCase(row.source_id,row.item_id);
      if(!row.source_evidence_hash||!candidate||candidate.evidence_hash!==row.source_evidence_hash){
        db.exec('ROLLBACK');res.status(409).json({error:'Audit evidence changed since the count; refresh and recount',code:'stale_source'});return;
      }
      if(candidate.status!=='open'){
        db.exec('ROLLBACK');res.status(409).json({error:'Linked direct-sale audit is already reviewed'});return;
      }
      run(`INSERT INTO direct_sale_stockout_reviews(order_id,item_id,evidence_hash,note,reviewed_by)
        VALUES(?,?,?,?,?)`,row.source_id,row.item_id,row.source_evidence_hash,`Physical count #${row.id}: ${note}`,req.user!.id);
    }
    run(`UPDATE stock_counts SET source_closed_by=?,source_closed_at=datetime('now'),source_close_note=? WHERE id=?`,
      req.user!.id,note,row.id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  res.json(detail(count(req)!));
});

export default router;
