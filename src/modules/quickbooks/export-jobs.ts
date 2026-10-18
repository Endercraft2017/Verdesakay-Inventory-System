/** Cloud-only durable export intent. Business saves commit intent, never a remote success. */
import {randomUUID} from 'node:crypto';
import {activeDb,queryOne,queryAll,run} from '../../shared/db';
import {moduleEnabled} from '../../shared/modules';
import {syncConfigOf} from '../../sync/node';
import {getQboStatus,qboExportScope,pushOrder} from './quickbooks';
import type {Order,OrderItem} from '../../shared/types';

interface Job {connection_id:string;company_key:string;order_id:number;version:number;state:string;attempts:number;worker_id:string|null;next_attempt_at:string;error_code:string|null;updated_at:string}
function cloud(){return process.env.DEPLOY_MODE!=='node'&&syncConfigOf(activeDb())?.role!=='node';}
export function enqueueOrderExport(orderId:number):void {
  if(!cloud()||!moduleEnabled('quickbooks')||!getQboStatus().auto_push)return;
  const scope=qboExportScope();if(!scope)return;
  run(`INSERT INTO qbo_export_jobs(connection_id,company_key,order_id) VALUES(?,?,?)
    ON CONFLICT(connection_id,order_id) DO UPDATE SET version=version+1,
    state=CASE WHEN state IN ('running','blocked') THEN state ELSE 'queued' END,
    attempts=CASE WHEN state='running' THEN attempts ELSE 0 END,
    next_attempt_at=datetime('now'),updated_at=datetime('now')`,scope.connection_id,scope.company_key,orderId);
}
export function exportJobs() {
  const jobs=queryAll(`SELECT j.connection_id,j.order_id,o.number,o.type,j.company_key,j.state,j.version,j.completed_version,
    j.attempts,j.error_code,j.updated_at,j.next_attempt_at FROM qbo_export_jobs j
    LEFT JOIN orders o ON o.id=j.order_id
    ORDER BY CASE j.state WHEN 'blocked' THEN 0 WHEN 'running' THEN 1 WHEN 'retry' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
    j.updated_at DESC,j.order_id DESC LIMIT 100`);
  const counts=queryAll<{state:string;count:number}>('SELECT state,COUNT(*) AS count FROM qbo_export_jobs GROUP BY state');
  return {jobs,counts:Object.fromEntries(counts.map(row=>[row.state,row.count]))};
}
/** Explicit safe resume; unknown outcomes and interrupted claims have no retry bypass. */
export function retryExportJob(connectionId:string,orderId:number):void {
  const scope=qboExportScope();
  if(!cloud()||!scope||scope.connection_id!==connectionId||!getQboStatus().auto_push){
    throw Object.assign(new Error('Enable automatic exports on the original connection before retrying.'),{status:409});
  }
  const changed=run(`UPDATE qbo_export_jobs SET state='queued',attempts=0,error_code=NULL,
    next_attempt_at=datetime('now'),updated_at=datetime('now') WHERE connection_id=? AND order_id=?
    AND state='blocked' AND error_code IN ('automatic_export_disabled','retry_limit','provider_rejected')`,connectionId,orderId);
  if(Number(changed.changes)!==1)throw Object.assign(new Error('This export requires reconciliation or is already active; it cannot be retried here.'),{status:409});
}
/** One persisted claim per call; multiple processes cannot claim the same job. No lease stealing. */
export async function processOneExport():Promise<boolean> {
  if(!cloud()||!moduleEnabled('quickbooks'))return false;
  const db=activeDb();
  const owner=randomUUID();
  const job=db.prepare(`UPDATE qbo_export_jobs SET state='running',worker_id=?,updated_at=datetime('now')
    WHERE rowid=(SELECT rowid FROM qbo_export_jobs WHERE state IN ('queued','retry')
    AND next_attempt_at<=datetime('now') ORDER BY next_attempt_at,rowid LIMIT 1)
    AND state IN ('queued','retry') RETURNING *`).get(owner) as unknown as Job|undefined;
  if(!job)return false;
  const finish=(state:string,code:string|null,delay=0)=>{
    db.prepare(`UPDATE qbo_export_jobs SET state=?,error_code=?,worker_id=NULL,
      attempts=attempts+1,next_attempt_at=datetime('now',?),updated_at=datetime('now')
      WHERE connection_id=? AND order_id=? AND worker_id=?`).run(state,code,`+${delay} seconds`,job.connection_id,job.order_id,owner);
  };
  const scope=qboExportScope();
  if(!scope||scope.connection_id!==job.connection_id||scope.company_key!==job.company_key){finish('blocked','connection_changed');return true;}
  if(!getQboStatus().auto_push){finish('blocked','automatic_export_disabled');return true;}
  const order=queryOne<Order>('SELECT * FROM orders WHERE id=?',job.order_id);
  if(!order){finish('blocked','order_removed');return true;}
  const items=queryAll<OrderItem>("SELECT * FROM order_items WHERE order_id=? AND fulfillment_mode!='ckd_component' ORDER BY sort,id",order.id);
  try {
    await pushOrder(order,items,job.connection_id);
    db.prepare(`UPDATE qbo_export_jobs SET state=CASE WHEN version>? THEN 'queued' ELSE 'succeeded' END,
      completed_version=?,worker_id=NULL,error_code=NULL,attempts=0,next_attempt_at=datetime('now'),updated_at=datetime('now')
      WHERE connection_id=? AND order_id=? AND worker_id=?`).run(job.version,job.version,job.connection_id,job.order_id,owner);
  } catch {
    // Never retry a sent write whose financial outcome is unknown, even after a fresh save.
    const uncertain=db.prepare(`SELECT 1 FROM qbo_write_attempts WHERE company_key=?
      AND state IN ('pending','uncertain') AND operation_key IN (?,?,?)`).get(job.company_key,`order:${order.id}`,
        `customer:name:${(order.customer_name||'Customer').trim().toLowerCase()}`,
        `vendor:name:${(order.customer_name||'Supplier').trim().toLowerCase()}`);
    const rejected=db.prepare(`SELECT 1 FROM qbo_write_attempts WHERE company_key=?
      AND state='failed' AND operation_key IN (?,?,?)`).get(job.company_key,`order:${order.id}`,
        `customer:name:${(order.customer_name||'Customer').trim().toLowerCase()}`,
        `vendor:name:${(order.customer_name||'Supplier').trim().toLowerCase()}`);
    const current=qboExportScope();
    if(!current||current.connection_id!==job.connection_id)finish('blocked','connection_changed');
    else if(uncertain)finish('blocked','outcome_unknown');
    else if(rejected)finish('blocked','provider_rejected');
    else if(job.attempts>=4)finish('blocked','retry_limit');
    else finish('retry','temporary_failure',Math.min(900,15*2**job.attempts)+Math.floor(Math.random()*10));
  }
  return true;
}
