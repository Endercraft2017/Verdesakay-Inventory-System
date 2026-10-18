/**
 * QuickBooks Online integration (per-tenant, BYO — same pattern as src/mailer.ts).
 *
 * OAuth 2.0 with Intuit. The app's client id/secret + redirect URI come from the
 * environment (one Intuit app serves every tenant); the per-tenant realm + rotating
 * tokens are stored in the `settings` k/v store (tokens AES-encrypted via src/secrets.ts).
 * `qbo_links` maps a local record to its QBO id so a re-push updates rather than duplicates.
 *
 * Scope: one-way push of sale orders → Invoices and purchase requests → Bills, plus the
 * Customers / Vendors / Items they reference. It's a beta — the accountant may need to set
 * a default income/expense account in QuickBooks for line items to post cleanly.
 *
 * In NODE_ENV=test every network call is intercepted by `__qboMock` (recorded + canned
 * responses) so the connect + push logic is unit-testable without hitting Intuit.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, getSetting, setSetting, queryOne, run } from '../../shared/db';
import { encryptSecret, decryptSecret } from '../../shared/secrets';
import type { Order, OrderItem } from '../../shared/types';

const CFG_KEY = 'qbo_config';   // { realm_id, company_name, auto_push, connected_at }
const TOK_KEY = 'qbo_tokens';   // AES(JSON { access_token, refresh_token, expires_at })

const CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || '';
const IS_SANDBOX = (process.env.QBO_ENV || 'sandbox') !== 'production';
const API_BASE = IS_SANDBOX
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const SCOPE = 'com.intuit.quickbooks.accounting';
const IS_TEST = process.env.NODE_ENV === 'test';

export function qboConfigured(): boolean {
  return IS_TEST || !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

const ENVIRONMENT = IS_SANDBOX ? 'sandbox' : 'production';

interface QboCfg { environment: string; realm_id: string; company_name: string; auto_push: boolean; connected_at: string; }
function cfg(): Partial<QboCfg> { return getSetting<Partial<QboCfg>>(CFG_KEY) || {}; }
function saveCfg(patch: Partial<QboCfg>): void { setSetting(CFG_KEY, { ...cfg(), ...patch }); }

interface Tokens { access_token: string; refresh_token: string; expires_at: number; }
function tokens(): Partial<Tokens> {
  try { return JSON.parse(decryptSecret(getSetting<string>(TOK_KEY) || '') || '{}'); }
  catch { return {}; }
}
function saveTokens(t: Partial<Tokens>): void { setSetting(TOK_KEY, encryptSecret(JSON.stringify(t))); }

/** Obtain SQLite's writer lock before checking and replacing connection state. No awaits inside. */
function atomicConnectionWrite<T>(write:()=>T):T {
  const db=activeDb();
  db.exec('SAVEPOINT qbo_connection_write');
  try {
    db.exec("UPDATE settings SET value=value WHERE key='qbo_connection_id'");
    const result=write();db.exec('RELEASE qbo_connection_write');return result;
  } catch(error){
    db.exec('ROLLBACK TO qbo_connection_write');db.exec('RELEASE qbo_connection_write');throw error;
  }
}
interface Connection { db: DatabaseSync; id: string; realm: string; company: string }
function connectionId(): string {
  let id=getSetting<string>('qbo_connection_id');
  if (!id) {id=randomUUID();setSetting('qbo_connection_id',id);}
  return id;
}
function conflict(message='QuickBooks connection changed. Start the operation again.'): Error & {status:number} {
  return Object.assign(new Error(message),{status:409});
}
function connection(): Connection {
  const c=cfg();
  if (!c.realm_id || !tokens().refresh_token) throw conflict('QuickBooks is not connected.');
  if (c.environment!==ENVIRONMENT) throw conflict('Reconnect QuickBooks to verify its environment before exporting.');
  return {db:activeDb(),id:connectionId(),realm:c.realm_id,company:`${ENVIRONMENT}:${c.realm_id}`};
}
function assertCurrent(c:Connection): void {
  if (activeDb()!==c.db || connectionId()!==c.id || cfg().realm_id!==c.realm || cfg().environment!==ENVIRONMENT) throw conflict();
}

export function qboConnected(): boolean {
  return !!cfg().realm_id && cfg().environment===ENVIRONMENT && !!tokens().refresh_token;
}

/** Non-secret scope used to bind durable intent; never return credentials. */
export function qboExportScope():{connection_id:string;company_key:string}|null {
  if(!qboConnected())return null;
  const c=connection();return {connection_id:c.id,company_key:c.company};
}

export function getQboStatus() {
  const c = cfg();
  return {
    configured: qboConfigured(),
    connected: qboConnected(),
    realm_id: c.realm_id ?? null,
    company_name: c.company_name ?? null,
    auto_push: !!c.auto_push,
    sandbox: IS_SANDBOX,
  };
}

export function setAutoPush(on: boolean): void { saveCfg({ auto_push: !!on }); }

/** The Intuit authorize URL. `state` must encode the tenant + a CSRF nonce. */
export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', scope: SCOPE,
    redirect_uri: REDIRECT_URI, state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

/** Exchange the OAuth code for tokens and record the realm + company name. */
export async function completeConnect(code: string, realmId: string, authorizationCurrent: () => boolean = () => true): Promise<void> {
  if (!/^[0-9]{1,30}$/.test(realmId)) throw Object.assign(new Error('Invalid QuickBooks company.'),{status:400});
  const originalDb=activeDb(), originalId=connectionId();
  const t = await tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
  }));
  atomicConnectionWrite(()=>{
    if (activeDb()!==originalDb || connectionId()!==originalId) throw conflict();
    if (!authorizationCurrent()) throw Object.assign(new Error('QuickBooks authorization changed. Start the connection again.'),{status:403});
    saveTokens(t);
    run('DELETE FROM qbo_refresh_locks');
    setSetting('qbo_connection_id',randomUUID());
    saveCfg({ realm_id: realmId, environment:ENVIRONMENT, company_name:'', connected_at: new Date().toISOString() });
  });
  const connected=connection();
  try {
    const info = await qboRequest(connected,'GET', `companyinfo/${realmId}`);
    const name = info?.CompanyInfo?.CompanyName as string | undefined;
    if (name && authorizationCurrent()) atomicConnectionWrite(()=>{assertCurrent(connected);saveCfg({ company_name: name });});
  } catch { /* company name is nice-to-have; connection invalidation is not */ }
  assertCurrent(connected);
}

export function disconnect(): void {
  atomicConnectionWrite(()=>{
    setSetting('qbo_connection_id',randomUUID());
    run('DELETE FROM qbo_refresh_locks');
    setSetting('qbo_oauth_state',null);setSetting('qbo_oauth_generation',null);
    setSetting(TOK_KEY, '');
    setSetting(CFG_KEY, { auto_push: !!cfg().auto_push });
  });
}

async function tokenRequest(body: URLSearchParams): Promise<Tokens> {
  let j: {access_token?:unknown;refresh_token?:unknown;expires_in?:unknown};
  if (IS_TEST) {
    __qboMock.tokenCalls.push(body.get('grant_type')!);
    j=await __qboMock.tokenResponder(body.get('grant_type')!);
  } else {
    const res=await fetch(TOKEN_URL,{
      signal:AbortSignal.timeout(30_000),redirect:'error',method:'POST',
      headers:{Authorization:'Basic '+Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body,
    });
    // Never include provider bodies: they can echo credentials or customer records.
    if (!res.ok) throw Object.assign(new Error('QuickBooks authorization failed. Reconnect or try again later.'),{status:502});
    j=await res.json() as typeof j;
  }
  if (!j || typeof j.access_token!=='string' || !j.access_token || j.access_token.length>8192 ||
      /[\r\n]/.test(j.access_token) ||
      (j.refresh_token!==undefined && (typeof j.refresh_token!=='string' || !j.refresh_token || j.refresh_token.length>8192)) ||
      (body.get('grant_type')==='authorization_code' && !j.refresh_token) ||
      (j.expires_in!==undefined && (typeof j.expires_in!=='number' || !Number.isFinite(j.expires_in) || j.expires_in<=0 || j.expires_in>86400))) {
    throw Object.assign(new Error('QuickBooks returned invalid authorization data.'),{status:502});
  }
  return {access_token:j.access_token,refresh_token:(j.refresh_token as string|undefined)||'',
    expires_at:Date.now()+((j.expires_in as number|undefined)??3600)*1000-60_000};
}

const refreshes=new WeakMap<DatabaseSync,Map<string,Promise<string>>>();
async function validToken(c:Connection, rejectedToken?:string): Promise<string> {
  assertCurrent(c);
  const t=tokens();
  if (!t.refresh_token) throw conflict('QuickBooks is not connected.');
  if (t.access_token && (t.expires_at??0)>Date.now() && t.access_token!==rejectedToken) return t.access_token;
  let pending=refreshes.get(c.db);
  if (!pending) {pending=new Map();refreshes.set(c.db,pending);}
  const existing=pending.get(c.id);if(existing)return existing;
  const lock=randomUUID();
  if(Number(c.db.prepare('INSERT OR IGNORE INTO qbo_refresh_locks(connection_id,lock_id) VALUES(?,?)').run(c.id,lock).changes)!==1){
    throw conflict('QuickBooks refresh is active or interrupted. Retry later or reconnect after investigation.');
  }
  const job=(async()=>{
    try {
      assertCurrent(c);
      const latest=tokens(),saved=getSetting<string>(TOK_KEY);
      if(latest.access_token&&(latest.expires_at??0)>Date.now()&&latest.access_token!==rejectedToken)return latest.access_token;
      if(!latest.refresh_token)throw conflict('QuickBooks is not connected.');
      const nt=await tokenRequest(new URLSearchParams({grant_type:'refresh_token',refresh_token:latest.refresh_token}));
      return atomicConnectionWrite(()=>{
        assertCurrent(c);
        // A different process may have rotated it. Never overwrite that newer credential.
        if(getSetting<string>(TOK_KEY)!==saved)throw conflict('QuickBooks credentials changed. Retry the operation.');
        if(!nt.refresh_token)nt.refresh_token=latest.refresh_token!;
        saveTokens(nt);return nt.access_token;
      });
    } finally {c.db.prepare('DELETE FROM qbo_refresh_locks WHERE connection_id=? AND lock_id=?').run(c.id,lock);}
  })();
  pending.set(c.id,job);
  try{return await job;}finally{if(pending.get(c.id)===job)pending.delete(c.id);}
}

/* ---------------------------------------------------- test-mode network hook --- */

export interface QboMock {
  calls: { method: string; path: string; body?: unknown }[];
  responder: (method: string, path: string, body?: unknown) => unknown;
  tokenCalls:string[];
  tokenResponder:(grant:string)=>{access_token?:unknown;refresh_token?:unknown;expires_in?:unknown}|Promise<{access_token?:unknown;refresh_token?:unknown;expires_in?:unknown}>;
  transport:((method:string,path:string,body:unknown,realm:string,requestId?:string)=>Promise<Response>)|null;
  reset(): void;
}
export const __qboMock: QboMock = {
  calls: [],tokenCalls:[],transport:null,
  tokenResponder:()=>({access_token:'test-access',refresh_token:'test-refresh-'+randomUUID(),expires_in:3600}),
  reset() { this.calls = [];this.tokenCalls=[]; },
  responder(_method, path) {
    if (path.startsWith('companyinfo/')) return { CompanyInfo: { CompanyName: 'Test Co (QBO)' } };
    if (path.startsWith('query')) return { QueryResponse: {} }; // "not found" → force a create
    const id = String(100 + __qboMock.calls.length);
    if (path.startsWith('invoice')) return { Invoice: { Id: id, SyncToken: '1', DocNumber: 'INV-' + id } };
    if (path.startsWith('bill')) return { Bill: { Id: id, SyncToken: '1' } };
    if (path.startsWith('customer')) return { Customer: { Id: id, SyncToken: '0' } };
    if (path.startsWith('vendor')) return { Vendor: { Id: id, SyncToken: '0' } };
    if (path.startsWith('item')) return { Item: { Id: id, SyncToken: '0' } };
    return {};
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function qboRequest(c:Connection,method:'GET'|'POST',path:string,body?:unknown,operationKey?:string):Promise<any> {
  assertCurrent(c);
  let requestId:string|undefined;
  if(method==='POST'){
    if(!operationKey)throw new Error('Missing accounting operation key');
    const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior=queryOne<{state:string;payload_hash:string;response_json:string}>(
      'SELECT state,payload_hash,response_json FROM qbo_write_attempts WHERE company_key=? AND operation_key=?',c.company,operationKey);
    if(prior?.state==='pending'||prior?.state==='uncertain')throw conflict('QuickBooks write is in progress or needs reconciliation. Do not retry blindly.');
    if(prior?.state==='succeeded'&&prior.payload_hash===digest)return JSON.parse(prior.response_json);
    requestId=randomUUID();
    const claimed=run(`INSERT INTO qbo_write_attempts(company_key,operation_key,request_id,payload_hash,state)
      VALUES(?,?,?,?,'pending') ON CONFLICT(company_key,operation_key) DO UPDATE SET
      request_id=excluded.request_id,payload_hash=excluded.payload_hash,state='pending',response_json=NULL,updated_at=datetime('now')
      WHERE qbo_write_attempts.state IN ('failed','succeeded')`,c.company,operationKey,requestId,digest);
    if(Number(claimed.changes)!==1)throw conflict('QuickBooks write is already in progress.');
  }
  // Once a POST has been sent, timeout/5xx/malformed response is an uncertain financial outcome.
  let sent=false;
  try {
    const send=async(tok:string)=>{
      assertCurrent(c);sent=true;
      if(IS_TEST){
        __qboMock.calls.push({method,path,body});
        if(__qboMock.transport)return __qboMock.transport(method,path,body,c.realm,requestId);
        return new Response(JSON.stringify(await __qboMock.responder(method,path,body)),{status:200});
      }
      const suffix=path.includes('?')?'&':'?';
      return fetch(`${API_BASE}/v3/company/${c.realm}/${path}${suffix}minorversion=73${requestId?'&requestid='+requestId:''}`,{
        method,signal:AbortSignal.timeout(30_000),redirect:'error',
        headers:{Authorization:`Bearer ${tok}`,Accept:'application/json','Content-Type':'application/json'},
        body:body!=null?JSON.stringify(body):undefined,
      });
    };
    let used=await validToken(c),res=await send(used);
    assertCurrent(c);
    if(res.status===401){
      // Do not clear a newer access token because an old request returned a late 401.
      used=await validToken(c,used);res=await send(used);assertCurrent(c);
    }
    if(!res.ok){
      const knownRejection=res.status>=400&&res.status<500&&![408,429].includes(res.status);
      const error=Object.assign(new Error(`QuickBooks request failed (${res.status}). Check the connection and accounting configuration.`),{status:502,knownRejection});
      throw error;
    }
    const result=await res.json();assertCurrent(c);
    if(method==='POST'){
      const type=path==='invoice'?'Invoice':path==='bill'?'Bill':path==='customer'?'Customer':'Vendor';
      const remote=result?.[type];
      if(typeof remote?.Id!=='string'||!remote.Id||typeof remote.SyncToken!=='string')throw new Error('Invalid accounting write response');
      const safe={[type]:{Id:remote.Id,SyncToken:remote.SyncToken,...(typeof remote.DocNumber==='string'?{DocNumber:remote.DocNumber}:{})}};
      run("UPDATE qbo_write_attempts SET state='succeeded',response_json=?,updated_at=datetime('now') WHERE company_key=? AND operation_key=? AND request_id=?",JSON.stringify(safe),c.company,operationKey!,requestId!);
      return safe;
    }
    return result;
  } catch(error){
    if(requestId)c.db.prepare("UPDATE qbo_write_attempts SET state=?,updated_at=datetime('now') WHERE company_key=? AND operation_key=? AND request_id=?").run(!sent||(error as {knownRejection?:boolean}).knownRejection?'failed':'uncertain',c.company,operationKey!,requestId);
    if((error as {status?:number}).status===409)throw error;
    throw Object.assign(new Error('QuickBooks request failed. Check its outcome before retrying an export.'),{status:502});
  }
}

/* -------------------------------------------------------------- local links --- */

function getLink(c:Connection,entity: string, localId: string) {
  assertCurrent(c);
  const link=queryOne<{qbo_id:string;sync_token:string|null}>('SELECT qbo_id,sync_token FROM qbo_company_links WHERE company_key=? AND entity=? AND local_id=?',c.company,entity,localId);
  // Recover a known completed provider write even if the process stopped before saving its link.
  // This also handles an edited order: do not turn the new payload into a second create.
  if(!link){
    const prior=queryOne<{response_json:string}>("SELECT response_json FROM qbo_write_attempts WHERE company_key=? AND operation_key=? AND state='succeeded'",c.company,`${entity}:${localId}`);
    if(prior){
      const response=JSON.parse(prior.response_json) as Record<string,{Id:string;SyncToken:string}>;
      const type=entity==='order'?(response.Invoice?'Invoice':'Bill'):entity==='customer'?'Customer':'Vendor';
      const remote=response[type];
      if(!remote?.Id||typeof remote.SyncToken!=='string')throw conflict('QuickBooks write receipt needs reconciliation.');
      saveLink(c,entity,localId,type,remote.Id,remote.SyncToken);return {qbo_id:remote.Id,sync_token:remote.SyncToken};
    }
  }
  if(!link&&queryOne('SELECT 1 FROM qbo_links WHERE entity=? AND local_id=?',entity,localId))throw conflict('Legacy QuickBooks link needs company reconciliation before export.');
  return link;
}
function saveLink(c:Connection,entity: string, localId: string, qboType: string, qboId: string, syncToken?: string | null): void {
  assertCurrent(c);
  run(
    `INSERT INTO qbo_company_links (company_key,entity, local_id, qbo_type, qbo_id, sync_token, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(company_key,entity, local_id) DO UPDATE SET
       qbo_id = excluded.qbo_id, sync_token = excluded.sync_token, synced_at = datetime('now')`,
    c.company,entity, localId, qboType, qboId, syncToken ?? null
  );
}

const esc = (s: string) => s.replace(/'/g, "\\'");

async function ensureParty(c:Connection,kind: 'Customer' | 'Vendor', name: string): Promise<string> {
  const entity = kind.toLowerCase();
  const key = `name:${name.toLowerCase()}`;
  const existing = getLink(c,entity, key);
  if (existing) return existing.qbo_id;

  const q = await qboRequest(c,'GET', `query?query=${encodeURIComponent(`select Id from ${kind} where DisplayName = '${esc(name)}'`)}`);
  const rows=q?.QueryResponse?.[kind];
  if(!q?.QueryResponse || typeof q.QueryResponse!=='object' || Array.isArray(q.QueryResponse) ||
      (rows!==undefined&&(!Array.isArray(rows)||rows.length>1||(rows.length===1&&(typeof rows[0]?.Id!=='string'||!rows[0].Id))))){
    throw Object.assign(new Error('QuickBooks party lookup needs reconciliation.'),{status:502});
  }
  const found = rows?.[0]?.Id as string | undefined;
  if (found) { saveLink(c,entity, key, kind, found); return found; }

  const created = await qboRequest(c,'POST', entity, { DisplayName: name },`${entity}:${key}`);
  const obj = created[kind];
  saveLink(c,entity, key, kind, obj.Id, obj.SyncToken);
  return obj.Id;
}

export interface PushResult {
  qbo_type: 'Invoice' | 'Bill';
  qbo_id: string;
  doc_number?: string;
  updated: boolean;
}

/** Push one order to QuickBooks. `sale`/`job` → Invoice, `purchase` → Bill. */
export async function pushOrder(order: Order, items: OrderItem[], expectedConnectionId?:string): Promise<PushResult> {
  const c=connection();
  if(expectedConnectionId&&c.id!==expectedConnectionId)throw conflict();
  const lock=randomUUID();
  const acquired=c.db.prepare('INSERT OR IGNORE INTO qbo_export_locks(company_key,order_id,lock_id) VALUES(?,?,?)').run(c.company,order.id,lock);
  if(Number(acquired.changes)!==1)throw conflict('This order has an active or interrupted QuickBooks export. Reconcile it before retrying.');
  try {return await pushConnectedOrder(c,order,items);}
  finally {c.db.prepare('DELETE FROM qbo_export_locks WHERE company_key=? AND order_id=? AND lock_id=?').run(c.company,order.id,lock);}
}

async function pushConnectedOrder(c:Connection,order:Order,items:OrderItem[]):Promise<PushResult> {
  // Check legacy/ambiguous order state before any party creation.
  const link=getLink(c,'order',String(order.id));
  const prior=queryOne<{state:string}>('SELECT state FROM qbo_write_attempts WHERE company_key=? AND operation_key=?',c.company,`order:${order.id}`);
  if(prior?.state==='pending'||prior?.state==='uncertain')throw conflict('The previous QuickBooks export needs reconciliation before retrying.');
  const isPurchase = order.type === 'purchase';
  const qboType: 'Invoice' | 'Bill' = isPurchase ? 'Bill' : 'Invoice';
  const partyName = (order.customer_name || (isPurchase ? 'Supplier' : 'Customer')).trim();

  const line = (amount: number, desc: string): Record<string, unknown> => isPurchase
    ? { Amount: amount, DetailType: 'AccountBasedExpenseLineDetail', Description: desc, AccountBasedExpenseLineDetail: {} }
    : { Amount: amount, DetailType: 'SalesItemLineDetail', Description: desc, SalesItemLineDetail: {} };

  const lines = (items.length ? items : [null]).map((it) => {
    if (!it) return line(Number(order.total) || 0, order.number);
    const amt = Number(it.line_total) || (Number(it.quantity) * Number(it.unit_price)) || 0;
    const l = line(amt, [it.name, it.description].filter(Boolean).join(' — ') || it.name);
    if (!isPurchase) {
      (l.SalesItemLineDetail as Record<string, unknown>) = {
        Qty: Number(it.quantity) || 1, UnitPrice: Number(it.unit_price) || 0,
      };
    }
    return l;
  });

  const body: Record<string, unknown> = {
    Line: lines,
    DocNumber: order.number.slice(0, 21),
    PrivateNote: order.notes || undefined,
  };
  if (isPurchase) body.VendorRef = { value: await ensureParty(c,'Vendor', partyName) };
  else body.CustomerRef = { value: await ensureParty(c,'Customer', partyName) };
  if (!isPurchase && Number(order.tax_amount) > 0) body.TxnTaxDetail = { TotalTax: Number(order.tax_amount) };

  const resp = link
    ? await qboRequest(c,'POST', qboType.toLowerCase(), { ...body, Id: link.qbo_id, SyncToken: link.sync_token ?? '0', sparse: true },`order:${order.id}`)
    : await qboRequest(c,'POST', qboType.toLowerCase(), body,`order:${order.id}`);

  const obj = resp[qboType];
  saveLink(c,'order', String(order.id), qboType, obj.Id, obj.SyncToken);
  return { qbo_type: qboType, qbo_id: obj.Id, doc_number: obj.DocNumber, updated: !!link };
}

/** The QBO id an order is already linked to (for the UI), or null. */
export function orderLink(orderId: number): { qbo_type: string; qbo_id: string; synced_at: string } | null {
  if(!qboConnected())return null;
  const c=connection();
  return queryOne<{ qbo_type: string; qbo_id: string; synced_at: string }>(
    'SELECT qbo_type, qbo_id, synced_at FROM qbo_company_links WHERE company_key=? AND entity = ? AND local_id = ?', c.company,'order', String(orderId)
  ) ?? null;
}
