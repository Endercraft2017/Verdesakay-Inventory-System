/** QuickBooks Online: OAuth connect/disconnect + push an order. See src/quickbooks.ts. */
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { canOnOrder } from '../inventory/order-access';
import { withTenant, getSetting, setSetting, queryOne, queryAll, DEFAULT_TENANT } from '../../shared/db';
import { isValidSlug, getTenant, retiredDefaultTenant } from '../../platform/platform';
import { parseBody } from '../../shared/validation';
import { z } from 'zod';
import {
  getQboStatus, qboConfigured, authUrl, completeConnect, disconnect, setAutoPush, pushOrder, orderLink,
} from './quickbooks';
import { currentSlug } from '../../platform/quota';
import type { Order, OrderItem } from '../../shared/types';
import { syncClass } from '../../sync';

const router = Router();

const STATE_KEY = 'qbo_oauth_state'; // { nonce, ts }

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

    const valid = withTenant(slug, () => {
      const s = getSetting<{ nonce: string; ts: number }>(STATE_KEY);
      const valid = !!s && s.nonce === nonce && Date.now() - s.ts < 10 * 60_000;
      if (valid) setSetting(STATE_KEY, null);
      return valid;
    });
    if (!valid) { done('The connection link expired — start again from Settings.', false); return; }

    await withTenant(slug, async () => {
      await completeConnect(code, realmId);
      setSetting(STATE_KEY, null);
    });
    done('Your workspace is now linked. Orders can be pushed to QuickBooks.', true);
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);

// GET /api/quickbooks/status
router.get('/status', requirePermission('users.manage'), (_req, res) => {
  res.json({ ...getQboStatus(), last_order_link: null });
});

// GET /api/quickbooks/connect — returns the Intuit authorize URL to open
router.get('/connect', requirePermission('users.manage'), (_req, res) => {
  if (!qboConfigured()) {
    res.status(503).json({ error: 'QuickBooks is not set up on this server (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI).' });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  setSetting(STATE_KEY, { nonce, ts: Date.now() });
  res.json({ url: authUrl(`${currentSlug()}.${nonce}`) });
});

// POST /api/quickbooks/disconnect
// QuickBooks is reached from the cloud only (D8).
router.post('/disconnect', requirePermission('users.manage'), syncClass('online'), (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

// PUT /api/quickbooks/auto-push  { enabled: boolean }
router.put('/auto-push', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req.body);
  setAutoPush(enabled);
  res.json({ ok: true, auto_push: enabled });
});

// POST /api/quickbooks/push/order/:id — push a single order (create or update in QBO)
router.post('/push/order/:id', requireAnyPermission(['orders.edit', 'purchasing.manage']), syncClass('online'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    // A purchase order (pushed as a QBO Bill) is purchasing's; a sale order the orders module's.
    if (!canOnOrder(req.user!, order.type, 'edit')) { res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return; }
    const items = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
    const result = await pushOrder(order, items);
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
