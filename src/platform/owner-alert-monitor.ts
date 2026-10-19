/** Read-only delivery observations and durable worker liveness; no resend or provider lookup. */
import {randomUUID} from 'node:crypto';
import {platformDb} from './platform';
import {processOneOwnerAlert,ownerAlertSource} from './owner-alert-outbox';
import {ControlPlaneError} from './request-errors';
const DAY=86400000,STALE=120000,OVERDUE=300000;
const EVENTS=`SELECT 'signup' AS queue,id,event_key,tenant_slug,state,attempts,error_code,next_attempt_at,claimed_at,created_at,updated_at FROM platform_owner_outbox
 UNION ALL SELECT 'business' AS queue,id,event_key,tenant_slug,state,attempts,error_code,next_attempt_at,claimed_at,created_at,updated_at FROM platform_business_outbox`;
function attention(at:number):string {
  return `(state IN ('blocked','unknown') OR (state='cancelled' AND error_code='event_expired')
    OR (state='inflight' AND (claimed_at IS NULL OR claimed_at<=${at-STALE})) OR (state IN ('pending','retry') AND (attempts>=5 OR next_attempt_at<=${at-OVERDUE} OR created_at<=${at-7*DAY} OR created_at>${at+60000})))`;
}

/** The sole server wrapper records a guarded pass; heartbeat failure never requeues delivery. */
export async function runOwnerAlertPass():Promise<boolean> {
  const d=platformDb(),id=randomUUID();
  d.prepare(`INSERT INTO platform_owner_alert_worker(id,run_id,started_at,finished_at,outcome,last_success_at) VALUES(1,?,?,NULL,NULL,NULL)
    ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,started_at=excluded.started_at,finished_at=NULL,outcome=NULL`).run(id,Date.now());
  const finish=(outcome:'idle'|'processed'|'failed')=>d.prepare(`UPDATE platform_owner_alert_worker SET finished_at=?,outcome=?,
    last_success_at=CASE WHEN ?='failed' THEN last_success_at ELSE ? END WHERE id=1 AND run_id=?`).run(Date.now(),outcome,outcome,Date.now(),id);
  try{const processed=await processOneOwnerAlert();finish(processed?'processed':'idle');return processed;}
  catch(error){try{finish('failed');}catch{/* preserve original failure; a stale heartbeat remains visible */}throw error;}
}

export function ownerAlertHealth(){
  const at=Date.now();
  const row=platformDb().prepare(`WITH events AS (${EVENTS}), totals AS (SELECT COUNT(*) AS total,
    ${['pending','retry','inflight','accepted','blocked','unknown','cancelled'].map(s=>`COALESCE(SUM(state='${s}'),0) AS ${s}`).join(',')},
    COALESCE(SUM(state IN ('pending','retry') AND next_attempt_at<=${at}),0) AS due,
    COALESCE(SUM(${attention(at)}),0) AS attention,
    MIN(CASE WHEN state IN ('pending','retry') THEN created_at END) AS oldest_queued_at
    FROM events)
    SELECT totals.*,w.started_at,w.finished_at,w.outcome,w.last_success_at FROM totals LEFT JOIN platform_owner_alert_worker w ON w.id=1`).get()!;
  const started=row.started_at==null?null:Number(row.started_at),finished=row.finished_at==null?null:Number(row.finished_at),lastSuccess=row.last_success_at==null?null:Number(row.last_success_at);
  const enabled=process.env.DEPLOY_MODE!=='node';
  const invalid=[started,finished,lastSuccess].some(t=>t!==null&&(!Number.isSafeInteger(t)||t<0||t>at+60000))||(started!==null&&finished!==null&&finished<started);
  const malformed=(finished===null&&row.outcome!=null)||(finished!==null&&!['idle','processed','failed'].includes(String(row.outcome)));
  const state=!enabled?'disabled':invalid?'clock_invalid':malformed?'invalid':started===null?'unobserved':at-(finished??started)>STALE?'stale':row.outcome==='failed'?'failed':finished===null?'running':String(row.outcome);
  const counts=Object.fromEntries(['pending','retry','inflight','accepted','blocked','unknown','cancelled'].map(s=>[s,Number(row[s])]));
  return {checked_at:at,total:Number(row.total),counts,due:Number(row.due),attention:Number(row.attention),oldest_queued_at:row.oldest_queued_at==null?null:Number(row.oldest_queued_at),
    worker:{enabled,state,started_at:started,finished_at:finished,last_success_at:lastSuccess},
    thresholds:{overdue_ms:OVERDUE,worker_stale_ms:STALE},
    status:Number(row.attention)>0||['failed','stale','clock_invalid','invalid'].includes(state)?'attention':state==='disabled'?'disabled':state==='unobserved'?'unobserved':'clear'};
}

type Cursor={v:1;filter:string;at:number;created:number;id:string;queue:string};
export function ownerAlertHistory(input:{filter?:unknown;limit?:unknown;cursor?:unknown}={}){
  const filter=input.filter===undefined?'all':input.filter;
  if(typeof filter!=='string'||!['all','attention','queued'].includes(filter))throw new ControlPlaneError(400,'Choose all, attention or queued delivery records.');
  const limit=input.limit===undefined?30:typeof input.limit==='number'?input.limit:typeof input.limit==='string'&&/^\d{1,2}$/.test(input.limit)?Number(input.limit):NaN;
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ControlPlaneError(400,'Delivery limit must be an integer from 1 to 50.');
  let cursor:Cursor|null=null;
  if(input.cursor!==undefined){
    try{
      if(typeof input.cursor!=='string'||input.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw 0;
      const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')) as Cursor;
      if(!c||c.v!==1||c.filter!==filter||!Number.isSafeInteger(c.at)||c.at<0||c.at>Date.now()+60000||!Number.isSafeInteger(c.created)||typeof c.id!=='string'||!c.id.length||c.id.length>128||!['signup','business'].includes(c.queue))throw 0;
      cursor=c;
    }catch{throw new ControlPlaneError(400,'Invalid delivery cursor. Refresh the delivery list.');}
  }
  const at=cursor?.at??Date.now();
  const where=filter==='attention'?attention(at):filter==='queued'?"state IN ('pending','retry','inflight')":'1';
  const after=cursor?' AND (created_at<? OR (created_at=? AND (queue>? OR (queue=? AND id<?))))':'';
  const params=cursor?[cursor.created,cursor.created,cursor.queue,cursor.queue,cursor.id,limit+1]:[limit+1];
  const rows=platformDb().prepare(`SELECT queue,id,event_key,tenant_slug,state,attempts,error_code,created_at,updated_at FROM (${EVENTS})
    WHERE ${where}${after} ORDER BY created_at DESC,queue,id DESC LIMIT ?`).all(...params) as Array<{queue:string;id:string;event_key:string;tenant_slug:string;state:string;attempts:number;error_code:string|null;created_at:number;updated_at:number}>;
  const page=rows.slice(0,limit),last=page.at(-1);
  const next=rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,filter,at,created:last.created_at,id:last.id,queue:last.queue})).toString('base64url'):null;
  return {filter,at,rows:page.map(({event_key,...r})=>{
    const source=ownerAlertSource(event_key);
    return {...r,kind:source.kind,source_id:source.id??null};
  }),next_cursor:next};
}
