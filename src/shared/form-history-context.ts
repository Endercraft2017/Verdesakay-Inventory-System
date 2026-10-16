import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { now } from './sync-context';

interface Change { request?:Request; actor?:number; name?:string; reason?:string; source?:string; }
const context=new AsyncLocalStorage<Change>();
export function formHistoryRequestContext(req:Request,_res:Response,next:NextFunction) { context.run({request:req},next); }
export function withFormChange<T>(change:Change,write:()=>T):T { return context.run({...context.getStore(),...change},write); }
function current() {
  const change=context.getStore(),req=change?.request;
  const path=req?req.baseUrl+req.path:'';
  const source=change?.source || (!req?.user?'system':path.includes('generate-payslips')?'generated':path.includes('rate-change')?'rate-change':path.includes('/decide')?'approval':path.includes('mark-paid')?'payment':'update');
  const text=change?.reason??req?.body?.change_reason??req?.body?.note;
  return {actor:change?.actor??req?.user?.id??null,name:change?.name??req?.user?.full_name??null,reason:typeof text==='string'?text.trim().slice(0,1000)||null:null,source};
}
/** Also installed on raw sync connections: triggers and replicated effects use the same schema. */
const applying = new WeakSet<DatabaseSync>();
export function withoutFormHistoryTriggers<T>(conn:DatabaseSync,write:()=>T):T {
  applying.add(conn);
  try { return write(); } finally { applying.delete(conn); }
}
export function configureFormHistoryConnection(conn:DatabaseSync) {
  conn.function('form_history_enabled',()=>applying.has(conn)?0:1);
  conn.function('form_change_actor',()=>current().actor);
  conn.function('form_change_name',()=>current().name);
  conn.function('form_change_reason',()=>current().reason);
  conn.function('form_change_source',()=>current().source);
  conn.function('form_change_time',()=>now().toISOString());
}
