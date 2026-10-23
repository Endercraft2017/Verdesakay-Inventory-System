/** Cloud-only atomic replay of the existing synchronous payroll GL route. */
import crypto from 'node:crypto';
import type {NextFunction,Request,Response} from 'express';
import type {DatabaseSync} from 'node:sqlite';
import {syncContext} from '../shared/sync-context';
import {getCommand,insertCommand,type SyncCommand,type CommandRow} from './commands';
import {drainRecorder,isReplicated} from './node';
import {filterChangeset} from './changeset';
import {flushEffects} from './authority';
import {sqliteTime} from './clock';

export function isAtomicPayrollReplay(cmd:Pick<SyncCommand,'method'|'path'>):boolean{
 return typeof cmd.method==='string'&&cmd.method.toUpperCase()==='POST'&&typeof cmd.path==='string'
  &&/\/api\/hr\/periods\/[^/]+\/post-payroll-gl\/?$/i.test(cmd.path.split('?')[0]!);
}
const digest=(cmd:SyncCommand)=>crypto.createHash('sha256').update(JSON.stringify([
 cmd.id,cmd.node_no,cmd.node_seq,cmd.hlc,cmd.occurred_at,cmd.occurred_date,cmd.actor_user_id,cmd.device_id,
 cmd.method,cmd.path,cmd.body,cmd.sync_class,cmd.allocation_plan,cmd.app_version,cmd.unattributed,cmd.context??null,
])).digest('hex');
const hold=()=>Object.assign(new Error('An undecided payroll posting needs reconciliation on the cloud. Keep the original local command; do not create another posting.'),{status:409});
export const payrollReplayUnavailable=()=>Object.assign(new Error('Payroll confirmation is temporarily unavailable. The original local command remains pending; retry synchronization.'),{status:503,expose:true});
type Marker={request_hash:string;protocol:number};
const marker=(conn:DatabaseSync,id:string)=>conn.prepare('SELECT request_hash,protocol FROM sync_payroll_replays WHERE command_id=?').get(id) as Marker|undefined;
export const hasPayrollReplayMarker=(conn:DatabaseSync,id:string)=>!!marker(conn,id);

/** The inbox and its protocol proof commit before dispatch. An older received row
 * may already have changed the books, so it must never be upgraded by assumption. */
export function preparePayrollReplay(conn:DatabaseSync,cmd:SyncCommand):CommandRow{
 conn.exec('BEGIN IMMEDIATE');
 try{
  let stored=getCommand(conn,cmd.id);const proof=marker(conn,cmd.id),hash=digest(cmd);
  if(stored){
   if(digest(stored)!==hash)throw Object.assign(new Error('This payroll command ID belongs to different immutable command data.'),{status:409});
   if(proof&&(proof.protocol!==1||proof.request_hash!==hash))throw hold();
   if(stored.state==='received'&&!proof)throw hold();
  }else{
   if(proof)throw hold(); // Retained marker after a trimmed/deleted command is a tombstone.
   insertCommand(conn,cmd,{state:'received'});
   conn.prepare('INSERT INTO sync_payroll_replays(command_id,request_hash) VALUES(?,?)').run(cmd.id,hash);
   stored=getCommand(conn,cmd.id)!;
  }
  conn.exec('COMMIT');return stored;
 }catch(error){if(conn.isTransaction)conn.exec('ROLLBACK');throw error;}
}

/** Invoked only at the known synchronous route's class gate, after global middleware.
 * No transaction spans the orchestrator's asynchronous loopback dispatch. */
export function atomicCloudPayrollReplay(conn:DatabaseSync,req:Request,res:Response,next:NextFunction):void{
 const ctx=syncContext();
 if(!ctx?.commandId||ctx.mode!=='replay'||conn.isTransaction)throw payrollReplayUnavailable();
 flushEffects(conn,null); // Preserve unrelated earlier changes before isolating this action.
 conn.exec('BEGIN IMMEDIATE');
 let open=true,session:ReturnType<DatabaseSync['createSession']>|undefined;
 const discard=()=>{session?.close();session=undefined;drainRecorder(conn);};
 const rollback=()=>{try{if(open&&conn.isTransaction)conn.exec('ROLLBACK');}finally{open=false;discard();}};
 try{
  const cmd=getCommand(conn,ctx.commandId),proof=marker(conn,ctx.commandId);
  if(!cmd||!proof||proof.protocol!==1||proof.request_hash!==digest(cmd))throw payrollReplayUnavailable();
  // Another process can decide it between inbox lookup and this write lock.
  if(cmd.state!=='received'){
   if(!['confirmed','rejected'].includes(cmd.state))throw payrollReplayUnavailable();
   conn.exec('ROLLBACK');open=false;
   res.status(cmd.response_status??409).json(cmd.state==='confirmed'?{replayed:true}:{error:cmd.error??'Payroll posting refused.'});return;
  }
  conn.exec('SAVEPOINT payroll_replay_action');session=conn.createSession();
  const json=res.json.bind(res);
  res.json=(body:unknown)=>{
   if(!open)return json(body);
   try{
    const prepared=JSON.parse(JSON.stringify(body));
    if(res.statusCode>=500||res.statusCode<200||res.statusCode>=300&&res.statusCode<400){
     rollback();return json(prepared);
    }
    const ok=res.statusCode<300;
    if(!ok)conn.exec('ROLLBACK TO payroll_replay_action');
    conn.exec('RELEASE payroll_replay_action');
    const changes=ok?filterChangeset(session!.changeset(),isReplicated):new Uint8Array();
    // Technical retention starts at confirmation, independently of the command's
    // preserved business clock (which can be months old after an office outage).
    const decidedAt=sqliteTime(new Date());
    let seq:number|null=null;
    if(changes.length)seq=(conn.prepare('INSERT INTO sync_effects(command_id,changeset,created_at) VALUES(?,?,?) RETURNING authority_seq').get(cmd.id,changes,decidedAt) as {authority_seq:number}).authority_seq;
    const error=ok?null:typeof prepared?.error==='string'?prepared.error:`HTTP ${res.statusCode}`;
    conn.prepare("UPDATE sync_commands SET state=?,authority_seq=?,response_status=?,error=?,plan_misses=?,updated_at=? WHERE id=? AND state='received'")
     .run(ok?'confirmed':'rejected',seq,res.statusCode,error,ctx.planMisses??0,decidedAt,cmd.id);
    discard(); // Its effect is already durable in this transaction; don't publish it twice.
    conn.exec('COMMIT');open=false;
    return json(prepared);
   }catch{
    try{rollback();}catch{/* No success or rejection is asserted on infrastructure failure. */}
    res.status(503);return json({error:payrollReplayUnavailable().message});
   }
  };
  res.once('close',()=>{if(open)rollback();});
  next();
  if(open){rollback();throw new Error('Atomic payroll replay requires a synchronous JSON handler.');}
 }catch(error){if(open)rollback();throw error;}
}
