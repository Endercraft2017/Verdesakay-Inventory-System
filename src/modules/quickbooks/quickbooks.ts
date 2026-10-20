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
import { getSetting, setSetting, queryOne, run } from '../../shared/db';
import { encryptSecret, decryptSecret } from '../../shared/secrets';
import type { Order, OrderItem, Permission } from '../../shared/types';

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

interface QboCfg { realm_id: string; company_name: string; auto_push: boolean; connected_at: string; }
function cfg(): Partial<QboCfg> { return getSetting<Partial<QboCfg>>(CFG_KEY) || {}; }
function saveCfg(patch: Partial<QboCfg>): void { setSetting(CFG_KEY, { ...cfg(), ...patch }); }

interface Tokens { access_token: string; refresh_token: string; expires_at: number; }
function tokens(): Partial<Tokens> {
  try { return JSON.parse(decryptSecret(getSetting<string>(TOK_KEY) || '') || '{}'); }
  catch { return {}; }
}
function saveTokens(t: Partial<Tokens>): void { setSetting(TOK_KEY, encryptSecret(JSON.stringify(t))); }

export function qboConnected(): boolean {
  return !!cfg().realm_id && !!tokens().refresh_token;
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
export async function completeConnect(code: string, realmId: string): Promise<void> {
  const t = await tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
  }));
  saveTokens(t);
  saveCfg({ realm_id: realmId, connected_at: new Date().toISOString() });
  try {
    const info = await qboRequest('GET', `companyinfo/${realmId}`);
    const name = info?.CompanyInfo?.CompanyName as string | undefined;
    if (name) saveCfg({ company_name: name });
  } catch { /* company name is nice-to-have */ }
}

export function disconnect(): void {
  setSetting(TOK_KEY, '');
  setSetting(CFG_KEY, { auto_push: !!cfg().auto_push });
}

async function tokenRequest(body: URLSearchParams): Promise<Tokens> {
  if (IS_TEST) {
    return { access_token: 'test-access', refresh_token: 'test-refresh-' + Date.now(), expires_at: Date.now() + 3_600_000 };
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`QuickBooks token error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as { access_token: string; refresh_token: string; expires_in?: number };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000,
  };
}

async function validToken(): Promise<string> {
  const t = tokens();
  if (!t.refresh_token) throw Object.assign(new Error('QuickBooks is not connected.'), { status: 409 });
  if (t.access_token && (t.expires_at ?? 0) > Date.now()) return t.access_token;
  const nt = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  if (!nt.refresh_token) nt.refresh_token = t.refresh_token; // keep old if Intuit didn't rotate
  saveTokens(nt);
  return nt.access_token;
}

/* ---------------------------------------------------- test-mode network hook --- */

export interface QboMock {
  calls: { method: string; path: string; body?: unknown }[];
  responder: (method: string, path: string, body?: unknown) => unknown;
  reset(): void;
}
export const __qboMock: QboMock = {
  calls: [],
  reset() { this.calls = []; },
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
async function qboRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  if (!cfg().realm_id && !path.startsWith('companyinfo/')) {
    throw Object.assign(new Error('QuickBooks is not connected.'), { status: 409 });
  }
  if (IS_TEST) {
    __qboMock.calls.push({ method, path, body });
    return __qboMock.responder(method, path, body);
  }
  const realm = cfg().realm_id;
  const url = `${API_BASE}/v3/company/${realm}/${path}${path.includes('?') ? '&' : '?'}minorversion=73`;
  const send = (tok: string) => fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let res = await send(await validToken());
  if (res.status === 401) {
    saveTokens({ ...tokens(), access_token: '', expires_at: 0 }); // force refresh
    res = await send(await validToken());
  }
  if (!res.ok) throw new Error(`QuickBooks API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/* -------------------------------------------------------------- local links --- */

function getLink(entity: string, localId: string) {
  return queryOne<{ qbo_id: string; sync_token: string | null }>(
    'SELECT qbo_id, sync_token FROM qbo_links WHERE entity = ? AND local_id = ?', entity, localId
  );
}
function saveLink(entity: string, localId: string, qboType: string, qboId: string, syncToken?: string | null): void {
  run(
    `INSERT INTO qbo_links (entity, local_id, qbo_type, qbo_id, sync_token, synced_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(entity, local_id) DO UPDATE SET
       qbo_id = excluded.qbo_id, sync_token = excluded.sync_token, synced_at = datetime('now')`,
    entity, localId, qboType, qboId, syncToken ?? null
  );
}

const esc = (s: string) => s.replace(/'/g, "\\'");

async function ensureParty(kind: 'Customer' | 'Vendor', name: string): Promise<string> {
  const entity = kind.toLowerCase();
  const key = `name:${name.toLowerCase()}`;
  const existing = getLink(entity, key);
  if (existing) return existing.qbo_id;

  const q = await qboRequest('GET', `query?query=${encodeURIComponent(`select Id from ${kind} where DisplayName = '${esc(name)}'`)}`);
  const found = q?.QueryResponse?.[kind]?.[0]?.Id as string | undefined;
  if (found) { saveLink(entity, key, kind, found); return found; }

  const created = await qboRequest('POST', entity, { DisplayName: name });
  const obj = created[kind];
  saveLink(entity, key, kind, obj.Id, obj.SyncToken);
  return obj.Id;
}

export interface PushResult {
  qbo_type: 'Invoice' | 'Bill';
  qbo_id: string;
  doc_number?: string;
  updated: boolean;
}

export function orderExportPermission(type: string): Permission {
  return type === 'purchase' ? 'purchasing.approve_bills' : 'orders.approve';
}

/** Drafts and cancelled documents must never become financial documents through auto-push. */
export function orderReadyForExport(order: Pick<Order, 'status'>): boolean {
  return ['approved', 'confirmed', 'released', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(String(order.status).toLowerCase());
}

/** Push one approved order to QuickBooks. `sale`/`job` → Invoice, `purchase` → Bill. */
export async function pushOrder(order: Order, items: OrderItem[]): Promise<PushResult> {
  if (!orderReadyForExport(order)) {
    throw Object.assign(new Error('Approve this order before exporting it to QuickBooks.'), {status:409});
  }
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
  if (isPurchase) body.VendorRef = { value: await ensureParty('Vendor', partyName) };
  else body.CustomerRef = { value: await ensureParty('Customer', partyName) };
  if (!isPurchase && Number(order.tax_amount) > 0) body.TxnTaxDetail = { TotalTax: Number(order.tax_amount) };

  const link = getLink('order', String(order.id));
  const resp = link
    ? await qboRequest('POST', qboType.toLowerCase(), { ...body, Id: link.qbo_id, SyncToken: link.sync_token ?? '0', sparse: true })
    : await qboRequest('POST', qboType.toLowerCase(), body);

  const obj = resp[qboType];
  saveLink('order', String(order.id), qboType, obj.Id, obj.SyncToken);
  return { qbo_type: qboType, qbo_id: obj.Id, doc_number: obj.DocNumber, updated: !!link };
}

/** The QBO id an order is already linked to (for the UI), or null. */
export function orderLink(orderId: number): { qbo_type: string; qbo_id: string; synced_at: string } | null {
  return queryOne<{ qbo_type: string; qbo_id: string; synced_at: string }>(
    'SELECT qbo_type, qbo_id, synced_at FROM qbo_links WHERE entity = ? AND local_id = ?', 'order', String(orderId)
  ) ?? null;
}
