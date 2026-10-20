/** QuickBooks Online: OAuth connect/disconnect + push an order. See src/quickbooks.ts. */
import crypto from 'node:crypto';
import {exportJobs,retryExportJob} from './export-jobs';
import { Router } from 'express';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { canOnOrder } from '../inventory/order-access';
import { withTenant, getSetting, setSetting, queryOne, queryAll, activeDb, DEFAULT_TENANT, tokenDigest } from '../../shared/db';
import { isValidSlug, getTenant, retiredDefaultTenant } from '../../platform/platform';
import { parseBody } from '../../shared/validation';
import { z } from 'zod';
import {
  getQboStatus, qboConfigured, authUrl, completeConnect, disconnect, setAutoPush, pushOrder, orderLink,
} from './quickbooks';
import { currentSlug } from '../../platform/quota';
import type { Order, OrderItem } from '../../shared/types';
import { syncClass } from '../../sync';
import { requireFreshVerification, hasFreshVerification, stepUpCredentialStamp, isSavedVerificationContextCurrent, type SavedVerificationContext } from '../../shared/step-up';

const router = Router();

const STATE_KEY = 'qbo_oauth_state';
const GENERATION_KEY = 'qbo_oauth_generation';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The OAuth `state` names a workspace this server actually hosts (and that is active). */
function knownWorkspace(slug: string): boolean {
  if (slug === DEFAULT_TENANT) return !retiredDefaultTenant();
  if (!isValidSlug(slug)) return false;
  const t = getTenant(slug);
  return !!t && t.status !== 'suspended' && t.status !== 'purged';
}

// GET /api/quickbooks/callback — Intuit redirects here (public, no session). `state`
// carries the tenant slug + a CSRF nonce created by /connect.
router.get('/callback', async (req, res, next) => {
  try {
    const { code, realmId, state, error } = req.query as Record<string, string>;
    // Public page: everything that came from the query string is escaped before it is written.
    const done = (msg: string, ok: boolean) =>
      res.status(ok ? 200 : 400).type('html').send(
        `<!doctype html><meta charset=utf-8><title>QuickBooks</title>
         <body style="font:15px system-ui;padding:40px;text-align:center">
         <h2>${ok ? '✅ Connected to QuickBooks' : '⚠️ QuickBooks connection failed'}</h2>
         <p>${escapeHtml(msg)}</p><p>You can close this tab.</p>
         <script nonce="${String(res.locals.cspNonce || '')}">try{window.opener&&window.opener.postMessage('qbo:${ok ? 'ok' : 'fail'}','*')}catch(e){}</script>`);

    if (error) { done(`Intuit returned: ${String(error).slice(0, 200)}`, false); return; }
    const [slug, nonce] = String(state || '').split('.', 2);
    if (!slug || !nonce || !/^[a-f0-9]{32}$/.test(nonce) || typeof code !== 'string' || typeof realmId !== 'string') { done('Missing parameters.', false); return; }
    // Only a workspace that exists may be opened: getDb() would otherwise create, migrate and seed
    // a database for any name in the query string.
    if (!knownWorkspace(slug)) { done('Unknown workspace.', false); return; }

    const bound = withTenant(slug, () => {
      const state = getSetting<{nonce:string;ts:number}&Partial<SavedVerificationContext>>(STATE_KEY);
      const age=state ? Date.now()-state.ts : NaN;
      const matched=!!state && state.nonce===nonce && age>=0 && age<10*60_000;
      if (matched) setSetting(STATE_KEY,null); // single-use, even when its actor has been revoked
      return matched && isSavedVerificationContextCurrent(state!) && getSetting(GENERATION_KEY)===nonce ? state : null;
    });
    if (!bound) { done('The connection link expired — start again from Settings.', false); return; }

    await withTenant(slug, async () => {
      await completeConnect(code, realmId,()=>isSavedVerificationContextCurrent(bound) && getSetting(GENERATION_KEY)===nonce);
      if (getSetting(GENERATION_KEY)===nonce) { setSetting(STATE_KEY,null);setSetting(GENERATION_KEY,null); }
    });
    done('Your workspace is now linked. Orders can be pushed to QuickBooks.', true);
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);

router.get('/exports',requirePermission('users.manage'),(_req,res)=>{res.set('Cache-Control','no-store').json(exportJobs());});
router.post('/exports/:connection/:id/retry',requirePermission('users.manage'),syncClass('online'),requireFreshVerification,(req,res)=>{
  const input=parseBody(z.object({connection:z.string().uuid(),id:z.coerce.number().int().positive()}),req.params);
  retryExportJob(input.connection,input.id);res.json({ok:true});
});

// GET /api/quickbooks/status
router.get('/status', requireAnyPermission(['users.manage','orders.edit','purchasing.manage']), (_req, res) => {
  res.json({ ...getQboStatus(), last_order_link: null });
});

// GET /api/quickbooks/connect — returns the Intuit authorize URL to open
router.get('/connect', requirePermission('users.manage'), syncClass('online'), requireFreshVerification, (req, res) => {
  if (!qboConfigured()) {
    res.status(503).json({ error: 'QuickBooks is not set up on this server (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI).' });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  setSetting(STATE_KEY, { nonce, ts: Date.now(), user_id:req.user!.id, session_hash:tokenDigest(req.token!), credential_stamp:stepUpCredentialStamp(req.user!.id) });
  setSetting(GENERATION_KEY,nonce);
  res.json({ url: authUrl(`${currentSlug()}.${nonce}`) });
});

// POST /api/quickbooks/disconnect
// QuickBooks is reached from the cloud only (D8).
router.post('/disconnect', requirePermission('users.manage'), syncClass('online'), requireFreshVerification, (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

// PUT /api/quickbooks/auto-push  { enabled: boolean }
router.put('/auto-push', requirePermission('users.manage'), syncClass('online'), requireFreshVerification, (req, res) => {
  const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req.body);
  setAutoPush(enabled);
  res.json({ ok: true, auto_push: enabled });
});

function orderStamp(order:Order|undefined,items:OrderItem[]):string {
  return crypto.createHash('sha256').update(JSON.stringify([order,items])).digest('hex');
}

// Current review data and source precondition; no provider call or authorization token is minted.
router.get('/order/:id/preview',requireAnyPermission(['orders.edit','purchasing.manage']),syncClass('online'),(req,res,next)=>{
  const d=activeDb();d.exec('SAVEPOINT manual_export_preview');
  try {
    const id=Number(req.params.id),order=queryOne<Order>('SELECT * FROM orders WHERE id=?',id);
    if(!order){d.exec('RELEASE manual_export_preview');res.status(404).json({error:'Order not found'});return;}
    if(!canOnOrder(req.user!,order.type,'edit')){d.exec('RELEASE manual_export_preview');res.status(403).json({error:'Forbidden: insufficient permissions'});return;}
    const items=queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id=? ORDER BY sort,id',id),status=getQboStatus();
    if(!status.connected){d.exec('RELEASE manual_export_preview');res.status(409).json({error:'Connect QuickBooks before reviewing an export.'});return;}
    const preview={connection_id:status.connection_id,order_stamp:orderStamp(order,items),number:order.number,total:order.total,
      qbo_type:order.type==='purchase'?'Bill':'Invoice',company_name:status.company_name,sandbox:status.sandbox};
    d.exec('RELEASE manual_export_preview');res.set('Cache-Control','no-store').json(preview);
  }catch(error){d.exec('ROLLBACK TO manual_export_preview');d.exec('RELEASE manual_export_preview');next(error);}
});

// POST /api/quickbooks/push/order/:id — push a single order (create or update in QBO)
router.post('/push/order/:id', requireAnyPermission(['orders.edit', 'purchasing.manage']), syncClass('online'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    // A purchase order (pushed as a QBO Bill) is purchasing's; a sale order the orders module's.
    if (!canOnOrder(req.user!, order.type, 'edit')) { res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return; }
    // Object-specific permission precedes reauthentication. The online sync gate already ran.
    let verified=false;
    requireFreshVerification(req,res,()=>{verified=true;});
    if(!verified)return;
    if(typeof req.body?.connection_id!=='string'){res.status(400).json({error:'Refresh QuickBooks connection status before exporting.'});return;}
    const {connection_id,order_stamp}=parseBody(z.object({connection_id:z.string().uuid('Refresh QuickBooks connection status before exporting.'),order_stamp:z.string().regex(/^[a-f0-9]{64}$/,'Review the current order before exporting.')}),req.body);
    const items = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
    const stamp=stepUpCredentialStamp(req.user!.id), snapshot=orderStamp(order,items);
    if(order_stamp!==snapshot){res.status(409).json({error:'Order changed after review. Review the current order before exporting.'});return;}
    const authorize=()=>{
      const current=queryOne<Order>('SELECT * FROM orders WHERE id=?',id);
      const currentItems=queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id=? ORDER BY sort,id',id);
      if(!req.token||!hasFreshVerification(req.user!.id,req.token)||stepUpCredentialStamp(req.user!.id)!==stamp||
        orderStamp(current,currentItems)!==snapshot){
        throw Object.assign(new Error('Export authorization or order changed. Review the order and QuickBooks outcome before starting again.'),{status:409});
      }
    };
    const result = await pushOrder(order, items, connection_id, authorize);
    res.json(result);
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status && err.status < 500) { res.status(err.status).json({ error: err.message }); return; }
    next(e);
  }
});

// GET /api/quickbooks/order/:id/link — the QBO link for an order (for the UI badge)
router.get('/order/:id/link', requireAnyPermission(['orders.view', 'purchasing.view']), (req, res) => {
  const order = queryOne<{ type: string }>('SELECT type FROM orders WHERE id = ?', Number(req.params.id));
  if (order && !canOnOrder(req.user!, order.type, 'view')) { res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return; }
  res.json(orderLink(Number(req.params.id)));
});

export default router;
