import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageUpload, saveAttachment, unlink } from '../../core/attachments.routes';
import { syncUpload } from '../../sync/files';
import { enforceQuota } from '../../platform/quota';
import { checklistForProduct } from './qc.routes';
import { batchBalances } from '../inventory/batch-stock';
import { variantStockAt } from '../inventory/inventory-stock';
/** /api/rts — mobile RTS desk: scoped reads and legacy inspection intake. Stock receipt itself
 *  stays POST /api/job-orders/:id/products-in, which applies the same rules (rts.ts). */
import { Router } from 'express';
import { z } from 'zod';
import { db, run, queryAll, queryOne, nextSequence, uploadDir } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { parseBody } from '../../shared/validation';
import { locationError, unitBlockers, openHolds } from './rts';
import { syncClass } from '../../sync';
import { notifyAnyPermission } from '../../shared/push';

const router = Router();
router.use(requireAuth);
const receiveGate = requirePermission('production.receive');

// Dedicated receiving scope: no broad catalogue or production-write grant is added.
router.get('/legacy/context', receiveGate, (_req, res) => {
  res.json({products:queryAll('SELECT id,name,sku,unit_cost FROM inventory_items WHERE is_finished_product=1 ORDER BY name'),
    locations:queryAll("SELECT * FROM locations WHERE type != 'truck' ORDER BY name")});
});
router.post('/legacy', receiveGate, syncClass('physical'), syncUpload(imageUpload.single('image')), (req,res) => {
  const file=req.file;
  try {
    const input=parseBody(z.object({product_item_id:z.coerce.number().int().positive(),location_id:z.coerce.number().int().positive(),
      identifier:z.string().trim().min(1).max(120),notes:z.string().trim().min(5).max(1000),
      intake_key:z.string().min(8).max(200),unit_cost:z.coerce.number().finite().nonnegative().max(1e9)}),req.body);
    if(!file){res.status(400).json({error:'Photograph the existing physical unit before submitting intake.'});return;}
    const hash=createHash('sha256').update(JSON.stringify(input)).update(fs.readFileSync(path.join(uploadDir(),file.filename))).digest('hex');
    const previous=queryOne<{id:number;created_by:number;legacy_intake_hash:string}>('SELECT id,created_by,legacy_intake_hash FROM job_orders WHERE legacy_intake_key=?',input.intake_key);
    if(previous){unlink(file.filename);if(previous.created_by!==req.user!.id||previous.legacy_intake_hash!==hash){res.status(409).json({error:'This intake key belongs to a different request. Recover the original intake.'});return;}
      const unit=queryOne<{id:number}>('SELECT id FROM job_order_units WHERE job_order_id=?',previous.id)!;res.status(201).json({id:previous.id,unit_id:unit.id});return;}
    const product=queryOne<{id:number;name:string}>('SELECT id,name FROM inventory_items WHERE id=? AND is_finished_product=1',input.product_item_id);
    if(!product){unlink(file.filename);res.status(400).json({error:'Choose an existing finished product.'});return;}
    const loc=locationError(input.location_id,0);if(loc){unlink(file.filename);res.status(400).json({error:loc});return;}
    if(queryOne("SELECT id FROM job_order_units WHERE lower(trim(identifier))=lower(?)",input.identifier)){
      unlink(file.filename);res.status(409).json({error:'This identifier already has a unit record. Locate that record instead of entering it twice.'});return;}
    enforceQuota('storage_mb');
    const qc=checklistForProduct(product.id,1),qa=checklistForProduct(product.id,2);
    db.exec('BEGIN');
    try {
      const number=nextSequence('legacy_intake_seq','LI');
      const id=Number(run(`INSERT INTO job_orders(number,product_item_id,product_name,qty_ordered,status,source_location_id,output_location_id,qc_stages,
        qc_checklist_qc_snapshot,qc_checklist_qa_snapshot,notes,created_by,intake_origin,legacy_intake_key,legacy_intake_hash,legacy_unit_cost)
        VALUES(?,?,?,1,'in_progress',?,?,2,?,?,?,?, 'legacy',?,?,?)`,number,product.id,product.name,input.location_id,input.location_id,
        JSON.stringify(qc),JSON.stringify(qa),'Pre-system legacy unit — no manufacture or kit consumption. '+input.notes,req.user!.id,input.intake_key,hash,input.unit_cost).lastInsertRowid);
      const unitId=Number(run("INSERT INTO job_order_units(job_order_id,product_item_id,identifier,status,stage,location_id,remarks) VALUES(?,?,?,'pending',0,?,?)",
        id,product.id,input.identifier,input.location_id,'Pre-system unit — awaiting QC and QA').lastInsertRowid);
      saveAttachment('qc_unit',unitId,file.filename,'Pre-system legacy intake',req.user!.id);
      db.exec('COMMIT');res.status(201).json({id,number,unit_id:unitId});
      void notifyAnyPermission(['production.inspect_qc'], { title: `QC inspection ready — ${number}`,
        body: `${input.identifier} was entered as a pre-system unit and needs QC then QA.`,
        url: `#/qc?role=qc&jo=${id}`, link: { route: 'production-qc' }, tag: `qc-jo-${id}` }, req.user!.id);
    }catch(e){db.exec('ROLLBACK');throw e;}
  }catch(e){unlink(file?.filename);throw e;}
});

/* GET /api/rts/queue — serialized units that passed final inspection (status 'passed') across
   open job orders, with their final-pass record, target location and any mismatch hold;
   non-serialized batches with quantity left to receive; and the caller's own postings today. */
router.get('/queue', receiveGate, (req, res) => {
  const units = queryAll<{
    id: number; identifier: string | null; updated_at: string; job_order_id: number; job_order_number: string;
    product_name: string; build_mode: string; product_item_id: number | null; sku: string | null; priority: number;
    output_location_id: number | null; output_location_name: string | null; order_number: string | null;
    batch_identifier: string | null;
  }>(
    `SELECT u.id, u.identifier, u.updated_at, j.id AS job_order_id, j.number AS job_order_number, j.product_name, j.build_mode, j.intake_origin,
            COALESCE(u.product_item_id, j.product_item_id) AS product_item_id, i.sku, j.priority,
            j.output_location_id, ol.name AS output_location_name, o.number AS order_number, b.identifier AS batch_identifier
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     LEFT JOIN inventory_items i ON i.id = COALESCE(u.product_item_id, j.product_item_id)
     LEFT JOIN locations ol ON ol.id = j.output_location_id
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN production_batches b ON b.id = u.batch_id
     WHERE u.status = 'passed' AND j.status != 'cancelled'
     ORDER BY j.priority DESC, u.updated_at ASC, u.id ASC`
  );
  const holds = openHolds(units.map((u) => u.id));
  const out = units.map((u) => {
    const pass = queryOne<{ created_at: string; inspector_name: string | null; stage: number }>(
      `SELECT q.created_at, us.full_name AS inspector_name, q.stage FROM qc_records q LEFT JOIN users us ON us.id = q.inspector_id
       WHERE q.unit_id = ? AND q.result = 'pass' ORDER BY q.id DESC LIMIT 1`,
      u.id
    );
    return { ...u, final_pass: pass ?? null, hold: holds.get(u.id) ?? null };
  });
  const batches = queryAll<{ id: number; number: string; job_order_id: number; job_order_number: string; product_name: string; build_mode: string;
    sku: string | null; output_location_id: number | null; remaining_qty: number }>(
    `SELECT pb.id, pb.number, j.id AS job_order_id, j.number AS job_order_number, j.product_name, j.build_mode, j.intake_origin, i.sku, j.output_location_id,
            pb.qty - COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0) AS remaining_qty
     FROM production_batches pb
     JOIN job_orders j ON j.id = pb.job_order_id
     LEFT JOIN inventory_items i ON i.id = j.product_item_id
     WHERE j.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = pb.id)
     ORDER BY pb.id`
  ).filter((b) => b.remaining_qty > 0);
  const recorded = queryAll<{ receipt_number: string; created_at: string; unit_id: number | null; identifier: string | null;
    batch_number: string | null; quantity: number; product_name: string; build_mode: string; location_name: string | null }>(
    `SELECT r.number AS receipt_number, r.created_at, ri.unit_id, un.identifier, pb.number AS batch_number, ri.quantity,
            j.id AS job_order_id, j.product_name, j.build_mode, j.intake_origin, l.name AS location_name
     FROM production_receipt_items ri
     JOIN production_receipts r ON r.id = ri.receipt_id
     JOIN job_orders j ON j.id = r.job_order_id
     LEFT JOIN job_order_units un ON un.id = ri.unit_id
     LEFT JOIN production_batches pb ON pb.id = ri.batch_id
     LEFT JOIN locations l ON l.id = r.location_id
     WHERE r.received_by = ? AND r.created_at >= datetime('now', 'start of day')
     ORDER BY ri.id DESC LIMIT 60`,
    req.user!.id
  );
  res.json({ units: out, batches, recorded, intakes:queryAll(`SELECT j.id,j.number,j.product_name,j.status AS intake_status,u.id AS unit_id,u.identifier,u.stage,u.status
    FROM job_orders j JOIN job_order_units u ON u.job_order_id=j.id WHERE j.intake_origin='legacy' AND u.status NOT IN ('in_stock','reserved','sold') ORDER BY j.id DESC`) });
});

/** Establish a counted lot balance for older stock whose lot provenance was never tracked.
 * This partitions existing stock; it never adds warehouse stock or guesses old sales. */
router.post('/batches/:id/count', requirePermission('inventory.adjust'), syncClass('claim', {home:(req)=>({location:Number(req.body?.location_id)||null})}), (req,res)=>{
 const input=parseBody(z.object({location_id:z.coerce.number().int().positive(),quantity:z.coerce.number().nonnegative(),expected_quantity:z.coerce.number().nonnegative(),reason:z.string().trim().min(5).max(500)}),req.body);
 const id=Number(req.params.id),batch=queryOne<{item_id:number;build_mode:'assembled'|'semi_built'}>(`SELECT COALESCE(pb.product_item_id,j.product_item_id) AS item_id,j.build_mode FROM production_batches pb JOIN job_orders j ON j.id=pb.job_order_id WHERE pb.id=? AND NOT EXISTS(SELECT 1 FROM job_order_units WHERE batch_id=pb.id)`,id);
 if(!batch){res.status(404).json({error:'Non-serialized batch not found.'});return;}
 const balance=batchBalances(id).find(x=>x.location_id===input.location_id);
 if(input.expected_quantity!==(balance?.on_hand??0)){res.status(409).json({error:'This batch balance changed. Reload and recount before saving.'});return;}
 const provenance=queryOne<{received:number;shipped:number;returned:number;elsewhere:number}>(`SELECT
   (SELECT COALESCE(SUM(quantity),0) FROM production_receipt_items WHERE batch_id=?) AS received,
   (SELECT COALESCE(SUM(quantity),0) FROM production_batch_allocations WHERE batch_id=? AND state='shipped') AS shipped,
   (SELECT COALESCE(SUM(r.quantity),0) FROM production_batch_return_links l JOIN sales_returns r ON r.id=l.return_id WHERE l.batch_id=? AND r.status='restocked') AS returned,
   (SELECT COALESCE(SUM(quantity),0) FROM production_batch_stock WHERE batch_id=? AND location_id!=?) AS elsewhere`,id,id,id,id,input.location_id)!;
 if(input.quantity+provenance.elsewhere>provenance.received-provenance.shipped+provenance.returned+1e-9){res.status(409).json({error:'This count exceeds the quantity received from this batch after its known shipments and returns.'});return;}
 const other=queryOne<{n:number}>(`SELECT COALESCE(SUM(s.quantity),0) AS n FROM production_batch_stock s JOIN production_batches pb ON pb.id=s.batch_id JOIN job_orders j ON j.id=pb.job_order_id WHERE s.location_id=? AND s.batch_id!=? AND COALESCE(pb.product_item_id,j.product_item_id)=? AND j.build_mode=?`,input.location_id,id,batch.item_id,batch.build_mode)?.n??0;
 if(input.quantity<(balance?.reserved??0)||input.quantity+other>variantStockAt(batch.item_id,input.location_id,batch.build_mode)+1e-9){res.status(409).json({error:'Count must cover existing reservations and fit within the warehouse build-state stock after other batches.'});return;}
 if(!queryOne('SELECT 1 FROM locations WHERE id=?',input.location_id)){res.status(400).json({error:'Location not found.'});return;}
 db.exec('BEGIN');try{
 run(`INSERT INTO production_batch_stock(batch_id,location_id,quantity,received) VALUES(?,?,?,0) ON CONFLICT(batch_id,location_id) DO UPDATE SET quantity=excluded.quantity`,id,input.location_id,input.quantity);
 run('INSERT INTO production_batch_counts(batch_id,location_id,before_quantity,counted_quantity,reason,counted_by) VALUES(?,?,?,?,?,?)',id,input.location_id,balance?.on_hand??0,input.quantity,input.reason,req.user!.id);
 db.exec('COMMIT');res.json({balances:batchBalances(id)});
 }catch(err){db.exec('ROLLBACK');throw err;}
});

const checkSchema = z.object({
  unit_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  location_id: z.coerce.number().int().positive().optional(),
});

/* POST /api/rts/check — the final duplicate / hold / location check before posting (74:234).
   Writes nothing; products-in re-runs the same checks atomically when the clerk confirms. */
router.post('/check', receiveGate, syncClass('merge'), (req, res) => {
  const input = parseBody(checkSchema, req.body);
  res.json({
    blockers: unitBlockers(input.unit_ids),
    location_error: input.location_id ? locationError(input.location_id, input.unit_ids.length) : null,
  });
});

/* GET /api/rts/lookup?q=&status=ready|allocated|hold — read-only finished-goods lookup (74:483):
   recorded units by serial, SKU, receipt number or location, plus counts per state. */
router.get('/lookup', requireAnyPermission(['inventory.view', 'production.view', 'production.receive']), (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const rows = queryAll<{ id: number; identifier: string | null; status: string; sku: string | null; product_name: string;
    location_name: string | null; order_number: string | null; receipt_number: string | null; received_at: string | null;
    job_order_id: number; held: number }>(
    `SELECT u.id, u.identifier, u.status, i.sku, j.id AS job_order_id, j.product_name, j.build_mode, j.intake_origin, l.name AS location_name, o.number AS order_number,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number,
            (SELECT r.created_at FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS received_at,
            j.id AS job_order_id,
            EXISTS (SELECT 1 FROM production_issues pi WHERE pi.unit_id = u.id AND pi.category = 'Product-data mismatch'
                    AND pi.status = 'open') AS held
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     LEFT JOIN inventory_items i ON i.id = COALESCE(u.product_item_id, j.product_item_id)
     LEFT JOIN locations l ON l.id = u.location_id
     LEFT JOIN orders o ON o.id = u.order_id
     WHERE u.status IN ('in_stock', 'reserved', 'passed')
     ORDER BY u.updated_at DESC, u.id DESC`
  );
  const state = (r: { status: string; held: number }) => (r.held ? 'hold' : r.status === 'reserved' ? 'allocated' : r.status === 'in_stock' ? 'ready' : null);
  const listed = rows.filter((r) => state(r) !== null);
  const counts = { ready: 0, allocated: 0, hold: 0 };
  listed.forEach((r) => { counts[state(r) as keyof typeof counts]++; });
  const matches = listed.filter((r) => (!status || state(r) === status) && (!q ||
    [r.identifier, r.sku, r.receipt_number, r.location_name, r.product_name, r.order_number]
      .some((v) => v != null && String(v).toLowerCase().includes(q))));
  res.json({ counts, units: matches.slice(0, 50).map((r) => ({ ...r, state: state(r), held: !!r.held })) });
});

export default router;
