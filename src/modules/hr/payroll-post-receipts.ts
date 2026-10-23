/** Originating-server acknowledgements, not global transaction approval. */
import crypto from 'node:crypto';
import type {Request,Response,NextFunction} from 'express';
import {activeDb,db} from '../../shared/db';
import {now,syncContext} from '../../shared/sync-context';
import {getCommand} from '../../sync/commands';
import {syncConfigOf} from '../../sync/node';

// cleanupSessions preserves this namespace; it must never expire into re-execution.
const PREFIX='payroll-gl:v1:';
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
const digest=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict=()=>Object.assign(new Error('This posting reference needs reconciliation. Check the payroll journal before starting another attempt.'),{status:409});
type Ack={body:Record<string,unknown>;command?:string;state?:'local'|'confirmed'};
function binding(req:Request){
 const key=req.get('Idempotency-Key');
 if(!key)return null;
 if(!KEY.test(key))throw Object.assign(new Error('Malformed Idempotency-Key'),{status:400});
 const user=req.user!,scoped=digest([user.id,key]);
 return {key:PREFIX+scoped,legacy:[key,'v2:'+scoped],
  hash:digest([req.method,Number(req.params.id),req.body??null,user.role,user.department_id,[...user.permissions].sort()])};
}
function existing(req:Request):Ack|null{
 const b=binding(req);if(!b)return null;
 if(db.prepare('SELECT 1 FROM idempotency_keys WHERE key IN (?,?)').get(...b.legacy))throw conflict();
 const row=db.prepare('SELECT user_id,method,path,status_code,response,request_hash FROM idempotency_keys WHERE key=?').get(b.key) as
  {user_id:number;method:string;path:string;status_code:number;response:string;request_hash:string}|undefined;
 if(!row)return null;
 if(row.user_id!==req.user!.id||row.method!==req.method||row.path!==String(Number(req.params.id))||row.status_code!==201||row.request_hash!==b.hash)throw conflict();
 let envelope:{version?:number;body?:Record<string,unknown>;command?:string|null};
 try{envelope=JSON.parse(row.response);}catch{throw conflict();}
 if(envelope?.version!==1||envelope.body?.posted!==true||!envelope.body.entry)throw conflict();
 if(envelope.command){
  const command=getCommand(activeDb(),envelope.command);
  if(!command||!['local','host_confirmed','confirmed'].includes(command.state))throw conflict();
  return {body:{...envelope.body,replayed:true},command:command.id,state:command.state==='confirmed'?'confirmed':'local'};
 }
 if(syncConfigOf(activeDb())?.role==='node')throw conflict();
 return {body:{...envelope.body,replayed:true}};
}
function send(res:Response,ack:Ack,replayed:boolean){
 if(replayed)res.setHeader('Idempotency-Replayed','true');
 if(ack.command){res.setHeader('X-Sync-Command',ack.command);res.setHeader('X-Sync-State',ack.state!);}
 return res.status(201).json(ack.body);
}
/** Mounted after current permission checks, before syncClass acquires a new command. */
export function replayPayrollPost(req:Request,res:Response,next:NextFunction):void{
 try{const ack=existing(req);if(ack){send(res,ack,true);return;}next();}catch(error){next(error);}
}
/** Validation, posting and keyed acknowledgement are one SQLite transaction. The
 * node's opt-in capture adds its durable command to the same outer transaction. */
export function postPayrollWithReceipt(req:Request,res:Response,action:()=>{status:number;body:Record<string,unknown>}):void{
 const b=binding(req),outer=!activeDb().isTransaction;
 db.exec(outer?'BEGIN IMMEDIATE':'SAVEPOINT payroll_http_post');
 let response:{status:number;body:Record<string,unknown>},ack:Ack|null=null;
 try{
  ack=existing(req); // Recheck after the database/capture lock, including competing processes.
  if(ack)response={status:201,body:ack.body};
  else{
   response=action();
   const body=JSON.parse(JSON.stringify(response.body)) as Record<string,unknown>;
   response={...response,body};
   if(b&&response.status===201){
    const ctx=syncContext(),command=ctx?.mode==='record'?ctx.commandId??null:null;
    db.prepare('INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?)')
     .run(b.key,req.user!.id,req.method,String(Number(req.params.id)),201,JSON.stringify({version:1,body,command}),b.hash,now().toISOString());
   }
  }
  db.exec(outer?'COMMIT':'RELEASE payroll_http_post');
 }catch(error){
  db.exec(outer?'ROLLBACK':'ROLLBACK TO payroll_http_post; RELEASE payroll_http_post');
  throw error;
 }
 if(ack){send(res,ack,true);return;}
 res.status(response.status).json(response.body);
}
