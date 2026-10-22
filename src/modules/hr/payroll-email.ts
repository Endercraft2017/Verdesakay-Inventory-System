/** Reviewed tenant payslip disclosure. SQLite owns acceptance; SMTP owns its external outcome. */
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {db,activeDb,queryOne,queryAll,run,tokenDigest,tenantStore,DEFAULT_TENANT} from '../../shared/db';
import {authUserById} from '../../shared/auth';
import {stepUpCredentialStamp} from '../../shared/step-up';
import {getTenant} from '../../platform/platform';
import {moduleEnabled} from '../../shared/modules';
import {encryptSecret,decryptSecret} from '../../shared/secrets';
import {templateVariables} from '../../shared/doc-render';
import {mailContentHash,mailDigest,singleMailbox,reviewedSmtpConfig,submitReviewedMail,type ReviewedMessage} from '../../shared/reviewed-smtp';
import {companyProfile} from '../payroll/ph-payroll-report-data';
import {assertPayrollRelease} from '../payroll/payroll-release';
import {payrollSourceIndex} from '../payroll/payroll-source';
import {DEPLOY_MODE,syncConfigOf} from '../../sync';
import {sideEffectsSuppressed} from '../../shared/sync-context';
const {renderSlip,FALLBACK_BODY}=createRequire(import.meta.url)('../../../public/js/hr-payroll-print.js') as {renderSlip:(data:Record<string,unknown>,body:string,variables?:unknown[])=>string;FALLBACK_BODY:string};
export const EMAIL_REVIEW_MS=5*60_000,EMAIL_INTERRUPTED_MS=120_000;
type State='review'|'queued'|'sending'|'accepted'|'not_accepted'|'unknown'|'cancelled'|'expired';
interface Release {
 seq:number;id:string;tenant:string;record_id:number;revision:number;record_number:string;state:State;
 actor_id:number;session_hash:string;actor_stamp:string;credential_stamp:string;source_stamp:string;
 recipient_hash:string;recipient_mask:string;content_hash:string;message_id:string;proof_hash:string;payload:string|null;
 retry_of:string|null;reason:string|null;evidence_reference:string|null;created_at:number;expires_at:number;
 confirmed_at:number|null;claimed_at:number|null;finished_at:number|null;outcome_code:string|null;
}
export interface EmailActor {id:number;token:string}
export interface RetryReview {retry_of?:string;reason?:string;evidence_reference?:string;duplicate_risk_acknowledged?:true}
function fail(message:string,status=409):never{throw Object.assign(new Error(message),{status});}
const tenant=()=>tenantStore.getStore()?.slug??DEFAULT_TENANT;
/** Synchronous savepoints only. No promise/network can escape this transaction. */
function atomic<T>(fn:()=>T):T {db.exec('SAVEPOINT payroll_email');try{const result=fn();db.exec('RELEASE payroll_email');return result;}catch(e){db.exec('ROLLBACK TO payroll_email');db.exec('RELEASE payroll_email');throw e;}}
const version=(kind:string,id:number|string='all')=>queryOne<{version:number}>('SELECT version FROM payroll_email_versions WHERE kind=? AND entity=?',kind,String(id))?.version??0;
function actorStamp(id:number){const workspace=tenant()===DEFAULT_TENANT?null:getTenant(tenant());
 if(workspace&&(workspace.status!=='active'&&workspace.status!=='trial'||workspace.status==='trial'&&workspace.trial_ends_at&&Date.parse(workspace.trial_ends_at)<=Date.now()))fail('Workspace authorization changed.',403);
 const actor=authUserById(id);if(!actor||!actor.permissions.includes('payroll.manage')||!moduleEnabled('hr'))fail('Current payroll authorization is required.',403);return mailDigest([actor,version('users',id),version('roles'),version('mfa',id),version('settings','security_policy')]);}
function freshSession(id:number,session:string,credentials:string){
 return !!queryOne(`SELECT 1 FROM sessions s JOIN session_stepups p ON p.token_hash=s.token
  WHERE s.token=? AND s.user_id=? AND s.ended_at IS NULL AND s.expires_at>datetime('now')
  AND (s.idle_minutes IS NULL OR COALESCE(s.last_seen_at,s.created_at)>=datetime('now','-'||s.idle_minutes||' minutes'))
  AND p.user_id=s.user_id AND p.credential_stamp=? AND p.verified_at>datetime('now','-5 minutes')`,session,id,credentials);
}
function source(recordId:number){
 const index=payrollSourceIndex(),p=assertPayrollRelease(index,recordId,true),record=p.raw;
 const recipient=queryOne<{employee_id:number;employee_no:string|null;user_id:number;email:string;active:number}>(
  'SELECT e.id AS employee_id,e.employee_no,u.id AS user_id,u.email,u.active FROM employees e JOIN users u ON u.id=e.user_id WHERE e.id=?',p.employee_id);
 if(!recipient||recipient.active!==1)fail('Link this employee to an active account with one email address before release.');
 const to=singleMailbox(recipient.email),config=reviewedSmtpConfig();
 const template=queryOne<{id:number;body:string}>('SELECT t.id,t.body FROM form_definitions f JOIN doc_templates t ON t.id=f.template_id WHERE f.id=?',record.form_def_id);
 const variables=template?templateVariables(template.id):[],company=companyProfile();
 const globals=queryAll<{key:string;value:string}>('SELECT key,value FROM global_variables ORDER BY key');
 const html=renderSlip({...p.data,company,global:Object.fromEntries(globals.map(v=>[v.key,v.value]))},template?.body||FALLBACK_BODY,variables).replace(/\r\n?/g,'\n');
 if(Buffer.byteLength(html)>1_000_000)fail('Payslip email content exceeds the review limit.');
 const subject=`Payslip — ${p.data!.payroll_period||record.number}`.replace(/[\r\n]/g,' ').slice(0,250);
 // Whole saved row catches revisions, metadata and out-of-band edits; current source gate
 // also catches sibling/ownership conflicts. Rendering dependencies are explicit.
 const stamp=mailDigest([record,recipient,index.periods.get(p.cutoff_id??0),template,variables,company,globals,config.stamp,html,subject,version('form_records',recordId),version('employees',recipient.employee_id),version('users',recipient.user_id),version('templates',template?.id??0),version('variables'),version('globals'),['company_profile','mail_settings','mail_smtp_pass'].map(key=>version('settings',key))]);
 return {record,to,html,subject,stamp,config,recipient};
}
const get=(id:string)=>queryOne<Release>('SELECT * FROM payroll_email_releases WHERE id=?',id);
const head=(recordId:number)=>queryOne<Release>('SELECT * FROM payroll_email_releases WHERE record_id=? AND confirmed_at IS NOT NULL ORDER BY seq DESC LIMIT 1',recordId);
export function emailStatus(r:Release){return {id:r.id,record_id:r.record_id,revision:r.revision,record_number:r.record_number,state:r.state,
 recipient:r.recipient_mask,content_hash:r.content_hash,message_id:r.message_id,retry_of:r.retry_of,reason:r.reason,evidence_reference:r.evidence_reference,
 created_at:r.created_at,expires_at:r.expires_at,confirmed_at:r.confirmed_at,claimed_at:r.claimed_at,finished_at:r.finished_at,outcome_code:r.outcome_code,
 delivery_confirmation:'unavailable',actor_id:r.actor_id};}
function event(r:Release,code:string,actor:number|null){run('INSERT INTO payroll_email_events(release_id,state,code,actor_id,created_at) VALUES(?,?,?,?,?)',r.id,r.state,code,actor,Date.now());}
function transition(r:Release,state:State,code:string,actor:number|null){
 const terminal=!['review','queued','sending'].includes(state);
 const result=run(`UPDATE payroll_email_releases SET state=?,outcome_code=?,claimed_at=CASE WHEN ?='sending' THEN ? ELSE claimed_at END,
  finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=? AND state=?`,state,code,state,Date.now(),terminal?1:0,Date.now(),r.id,r.state);
 if(Number(result.changes)!==1)fail('Email release changed. Refresh its status.');
 const updated=get(r.id)!;event(updated,code,actor);return updated;
}
export function maintainPayrollEmail(){
 atomic(()=>{
  for(const r of queryAll<Release>("SELECT * FROM payroll_email_releases WHERE (state IN ('review','queued') AND expires_at<=?) OR (state='sending' AND claimed_at<=?) ORDER BY seq LIMIT 100",Date.now(),Date.now()-EMAIL_INTERRUPTED_MS))
   transition(r,r.state==='sending'?'unknown':'expired',r.state==='sending'?'worker_interrupted':'approval_expired',null);
  run("UPDATE payroll_email_releases SET payload=NULL WHERE payload IS NOT NULL AND ((state IN ('expired','cancelled') AND confirmed_at IS NULL) OR (finished_at IS NOT NULL AND finished_at<?))",Date.now()-86_400_000);
 });
}
export function emailPreflight(recordId:number){
 maintainPayrollEmail();
 // History is still recoverable if its source was edited, removed or made ineligible.
 const history=queryAll<Release>('SELECT * FROM payroll_email_releases WHERE record_id=? AND confirmed_at IS NOT NULL ORDER BY seq DESC LIMIT 20',recordId).map(emailStatus);
 try {return atomic(()=>{const s=source(recordId);return {record:{id:recordId,number:s.record.number,revision:s.record.revision},recipient:s.to,source_stamp:s.stamp,history,legacy_attempts:legacyAttempts(recordId),release_error:null};});}
 catch(e){if(history.length)return {record:{id:recordId,number:history[0]!.record_number,revision:history[0]!.revision},recipient:null,source_stamp:null,history,legacy_attempts:legacyAttempts(recordId),release_error:(e as Error).message};throw e;}
}
function legacyAttempts(recordId:number):boolean {
 return !!queryOne(`SELECT 1 FROM mail_log m WHERE m.subject IN (
   SELECT 'Payslip — '||number FROM form_records WHERE id=?
   UNION SELECT 'Payslip — '||json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.payroll_period') FROM form_records WHERE id=?
   UNION SELECT 'Payslip — '||json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.payroll_period') FROM form_record_revisions WHERE record_id=?
  ) LIMIT 1`,recordId,recordId,recordId);
}
function assertRetry(recordId:number,input:RetryReview){
 const previous=head(recordId);
 if(!previous){if(input.retry_of)fail('There is no previous confirmed email release.');
  if(legacyAttempts(recordId)&&(!input.reason||!input.evidence_reference||input.duplicate_risk_acknowledged!==true))fail('Legacy email history has no reliable delivery evidence. Investigate it and acknowledge duplicate risk before another release.');return;}
 if(['queued','sending'].includes(previous.state))fail('An email release is already queued or sending. Refresh its status.');
 if(input.retry_of!==previous.id||!input.reason||!input.evidence_reference||input.duplicate_risk_acknowledged!==true)
  fail('Review the previous attempt and record a recovery reason, provider-check reference and duplicate-risk acknowledgement before another release.');
}
export function reviewPayrollEmail(recordId:number,actor:EmailActor,expected:string,input:RetryReview){
 maintainPayrollEmail();
 return atomic(()=>{
  const s=source(recordId);if(s.stamp!==expected)fail('The payslip, recipient or email settings changed. Start review again.');
  const credentials=stepUpCredentialStamp(actor.id),session=tokenDigest(actor.token),actor_stamp=actorStamp(actor.id);
  if(!freshSession(actor.id,session,credentials))fail('Confirm your identity again before payroll email release.',403);
  assertRetry(recordId,input);
  if(queryOne<{n:number}>("SELECT count(*) AS n FROM payroll_email_releases WHERE actor_id=? AND state='review'",actor.id)!.n>=20)fail('Too many open email reviews. Cancel or let them expire.');
  const id=randomUUID(),proof=randomBytes(32).toString('base64url'),created=Date.now(),expires=Math.min(created+EMAIL_REVIEW_MS,queryOne<{until:number}>('SELECT unixepoch(verified_at)*1000+? AS until FROM session_stepups WHERE token_hash=?',EMAIL_REVIEW_MS,session)!.until);
  const message:ReviewedMessage={to:s.to,html:s.html,subject:s.subject,message_id:`<payroll-${id}@${s.config.settings.from_email.split('@')[1]}>`,date:new Date(created).toISOString()};
  const mask=s.to[0]+'***@'+s.to.split('@')[1];
  run(`INSERT INTO payroll_email_releases(id,tenant,record_id,revision,record_number,employee_id,recipient_user_id,state,actor_id,session_hash,actor_stamp,credential_stamp,
   source_stamp,recipient_hash,recipient_mask,content_hash,message_id,proof_hash,payload,retry_of,reason,evidence_reference,created_at,expires_at)
   VALUES(?,?,?,?,?,?,?,'review',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,tenant(),recordId,s.record.revision,s.record.number,s.recipient.employee_id,s.recipient.user_id,actor.id,session,actor_stamp,credentials,
   s.stamp,mailDigest(s.to),mask,mailContentHash(s.html),message.message_id,tokenDigest(proof),encryptSecret(JSON.stringify(message)),input.retry_of??null,input.reason??null,input.evidence_reference??null,created,expires);
  const r=get(id)!;event(r,'review_created',actor.id);
  return {...emailStatus(r),recipient:s.to,from:s.config.settings.from_email,subject:s.subject,html:s.html,review_token:proof};
 });
}
function bound(recordId:number,id:string,proof:string,actor:EmailActor){
 const r=get(id);if(!r||r.record_id!==recordId||r.tenant!==tenant()||r.proof_hash!==tokenDigest(proof))fail('Invalid email review. Start again.');
 if(r.actor_id!==actor.id||r.session_hash!==tokenDigest(actor.token)||r.actor_stamp!==actorStamp(actor.id)||r.credential_stamp!==stepUpCredentialStamp(actor.id)||!freshSession(actor.id,r.session_hash,r.credential_stamp))fail('The operator, session or authorization changed. Start review again.');
 return r;
}
export function confirmPayrollEmail(recordId:number,id:string,proof:string,actor:EmailActor){
 maintainPayrollEmail();
 return atomic(()=>{
  const r=bound(recordId,id,proof,actor);
  // Historical acknowledgement: replays never authorize another send or a changed payload.
  if(r.confirmed_at!==null)return emailStatus(r);
  if(r.state!=='review'||r.expires_at<=Date.now())fail('Email review expired or was cancelled. Start again.');
  if(source(recordId).stamp!==r.source_stamp)fail('The payslip, recipient or email settings changed. Start review again.');
  assertRetry(recordId,{retry_of:r.retry_of??undefined,reason:r.reason??undefined,evidence_reference:r.evidence_reference??undefined,duplicate_risk_acknowledged:true});
  run('UPDATE payroll_email_releases SET confirmed_at=? WHERE id=?',Date.now(),id);
  return emailStatus(transition(r,'queued','operator_confirmed',actor.id));
 });
}
export function cancelPayrollEmail(recordId:number,id:string,actorId:number){
 return atomic(()=>{const r=get(id);if(!r||r.record_id!==recordId||r.tenant!==tenant())fail('Email release not found.',404);
  actorStamp(actorId);if(!['review','queued'].includes(r.state))fail('This release can no longer be cancelled. Refresh its outcome.');
  return emailStatus(transition(r,'cancelled','operator_cancelled',actorId));});
}
export async function processOnePayrollEmail():Promise<boolean>{
 if(DEPLOY_MODE!=='cloud'||syncConfigOf(activeDb())?.role==='node'||sideEffectsSuppressed('email'))return false;
 maintainPayrollEmail();
 const claimed=atomic(()=>{
  const r=queryOne<Release>("SELECT * FROM payroll_email_releases WHERE state='queued' ORDER BY seq LIMIT 1");if(!r)return null;
  let s:ReturnType<typeof source>,message:ReviewedMessage;
  try {
   if(r.tenant!==tenant()||r.expires_at<=Date.now()||actorStamp(r.actor_id)!==r.actor_stamp||stepUpCredentialStamp(r.actor_id)!==r.credential_stamp||!freshSession(r.actor_id,r.session_hash,r.credential_stamp))fail('Approval no longer current');
   s=source(r.record_id);if(s.stamp!==r.source_stamp)fail('Source changed');
   message=JSON.parse(decryptSecret(r.payload||''));
   if(mailDigest(message.to)!==r.recipient_hash||mailContentHash(message.html)!==r.content_hash||message.message_id!==r.message_id)fail('Payload unavailable');
  }catch {transition(r,'cancelled','approval_or_source_changed',null);return {blocked:true as const};}
  transition(r,'sending','worker_claimed',null);return {blocked:false as const,r,message,config:s.config};
 });
 if(!claimed)return false;if(claimed.blocked)return true;
 // A crash anywhere after claim is conservatively unknown, even if before DATA.
 const outcome=await submitReviewedMail(claimed.message,claimed.config);
 atomic(()=>{const current=get(claimed.r.id)!;if(current.state==='sending')transition(current,outcome.state,outcome.code,null);});
 return true;
}
