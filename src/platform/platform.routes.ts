/**
 * Owner console API — mounted at `/_platform/api` ONLY when PLATFORM_CONSOLE=true
 * (see src/app.ts). Operator auth lives in src/platform-users.ts and is completely
 * separate from tenant auth. Every handler here talks to the control plane
 * (src/platform.ts) + provisioning (src/provisioning.ts) — the same primitives the
 * `npm run tenant:*` CLI uses. Requests that resolved to a tenant sub-domain are 404'd:
 * the console only answers on the apex / default host.
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { tenantStore, withTenant, DEFAULT_TENANT, db, queryOne, run } from '../shared/db';
import {
  listTenants, getTenant, isValidSlug, setTenantPlan, setTenantStatus, setTenantName,
  setTrialEndsAt, setTenantModules, setTenantPhotoRetention, listProvisioningLog, logProvisioning, setAwaitingPayment,
  type TenantRow, type TenantStatus, tenantPublicUrl,
} from './platform';
import { createTenant, importTenant, purgeTenant } from './provisioning';
import billingConsoleRoutes from './billing-console.routes';
import inquiriesConsoleRoutes from './inquiries-console.routes';
import platformMailRoutes from './platform-mail-console.routes';
import { updateInquiry, getInquiry } from './inquiries';
import { tenantBillingSummary } from './billing';
import { tenantAnalytics, saveOwnerDetails, addSupport, updateSupport, replySupport } from './owner-analytics';
import { saveSubscription, subscriptionView } from './subscription';
import { tenantUsage } from './quota';
import { punchPhotoUsageBytes } from '../modules/hr/punch-photos';
import { enabledModules, isModuleName, withDeps, MODULES, MODULE_DEPS } from '../shared/modules';
import bcrypt from 'bcryptjs';
import { endUserSessions } from '../shared/auth';
import { sendMail } from '../shared/mailer';
import { parseBody, resetPasswordSchema, platformCreateTenantSchema } from '../shared/validation';
import { PLANS, PLAN_MODULES, planModules } from './plans';
import { rateLimitKey } from '../shared/device';
import {
  requirePlatformAuth, platformLogin, platformLogout, listPlatformUsers, changePlatformPassword,
  type PlatformAuthedRequest,
} from './platform-users';

const router = Router();

const TENANT_STATUSES: TenantStatus[] = ['trial', 'active', 'past_due', 'suspended', 'purged'];

/** A client-supplied `modules` array → a stored override list: reject unknown names,
 *  then union in dependencies (same friendliness as `npm run tenant:modules --set`). */
function normalizeModules(arr: unknown[]): string[] {
  const names = arr.map(String);
  const unknown = names.filter((m) => !isModuleName(m));
  if (unknown.length) throw new Error(`Unknown module(s): ${unknown.join(', ')}. Known: ${MODULES.join(', ')}`);
  return withDeps(names);
}

// The console only exists on the apex / default host — never a tenant sub-domain.
router.use((_req, res, next) => {
  if ((tenantStore.getStore()?.slug ?? DEFAULT_TENANT) !== DEFAULT_TENANT) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false, keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

// POST /_platform/api/login
router.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) { res.status(400).json({ error: 'Username and password are required.' }); return; }
  const token = platformLogin(username, password);
  if (!token) { res.status(401).json({ error: 'Invalid username or password.' }); return; }
  res.json({ token });
});

// Everything below needs a valid operator session.
router.use(requirePlatformAuth);

router.post('/logout', (req, res) => {
  const t = (req as PlatformAuthedRequest).platformToken;
  if (t) platformLogout(t);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: (req as PlatformAuthedRequest).platformUser });
});

// POST /_platform/api/password — change your own console password; other sessions end.
router.post('/password', loginLimiter, (req, res) => {
  const r = req as PlatformAuthedRequest;
  const error = changePlatformPassword(r.platformUser!.id, String(req.body?.current_password || ''),
    String(req.body?.new_password || ''), r.platformToken!);
  if (error) { res.status(400).json({ error }); return; }
  logProvisioning('_console', 'operator.password', `${r.platformUser!.username} changed their console password`);
  res.json({ ok: true });
});

// GET /_platform/api/bootstrap — static reference the UI needs to render its controls.
router.get('/bootstrap', (_req, res) => {
  res.json({
    modules: MODULES,
    module_deps: MODULE_DEPS,
    plans: Object.keys(PLANS),
    plan_limits: PLANS,
    plan_modules: PLAN_MODULES,
    statuses: TENANT_STATUSES.filter((s) => s !== 'purged'),
    operators: listPlatformUsers(),
  });
});

/** Full view of one tenant for the console: catalog row + resolved module picture + live
 *  usage (best-effort — a brand-new or unreachable tenant DB just yields null). */
function tenantView(t: TenantRow) {
  let override: string[] | null = null;
  if (t.modules) {
    try { const a = JSON.parse(t.modules); if (Array.isArray(a)) override = a.map(String); } catch { /* ignore */ }
  }
  let usage: Record<string, number> | null = null;
  try { usage = withTenant(t.slug, () => tenantUsage(t.slug)); } catch { usage = null; }
  let photoUsageMb: number | null = null;
  try { photoUsageMb = Math.round(withTenant(t.slug, () => punchPhotoUsageBytes()) / (1024 * 1024) * 10) / 10; } catch { photoUsageMb = null; }
  return {
    slug: t.slug,
    url: tenantPublicUrl(t.slug),
    name: t.name,
    status: t.status,
    plan: t.plan,
    subscription: subscriptionView(t),
    trial_ends_at: t.trial_ends_at,
    created_at: t.created_at,
    is_sandbox: t.is_sandbox === 1,
    modules: {
      effective: [...enabledModules(t.slug)],
      override,
      plan_default: planModules(t.plan),
    },
    usage,
    photo_retention: {
      retention_days: t.photo_retention_days, // null = system default, 0 = no limit
      max_mb: t.photo_max_mb,
      usage_mb: photoUsageMb,
    },
    awaiting_payment: !!t.awaiting_payment, // self-signed-up, locked until the first payment is confirmed
    billing: tenantBillingSummary(t.slug),
  };
}

// The first administrator is the tenant owner's login.
function tenantOwner(slug: string) {
  return withTenant(slug, () => queryOne<{ id: number; username: string; full_name: string; active: number; email: string | null }>(
    "SELECT id, username, full_name, active, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
  ) ?? null);
}

// GET /_platform/api/tenants
router.get('/tenants', (_req, res) => {
  res.json(listTenants().filter((t) => t.status !== 'purged').map(tenantView));
});

// GET /_platform/api/tenants/:slug
router.get('/tenants/:slug', (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown workspace.' }); return; }
  res.json({ ...tenantView(t), owner: tenantOwner(t.slug), log: listProvisioningLog(t.slug, 50) });
});

// Owner-only aggregate analytics and operational notes.
router.get('/tenants/:slug/analytics', (req, res, next) => {
  const t = getTenant(req.params.slug);
  if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try { res.json(tenantAnalytics(t)); } catch (e) { next(e); }
});
router.get('/tenants/:slug/analytics/export', (req, res, next) => {
  const t = getTenant(req.params.slug);
  if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    res.set('Content-Disposition', `attachment; filename="${t.slug}-analytics.json"`);
    res.json({ tenant: { slug: t.slug, name: t.name }, analytics: tenantAnalytics(t) });
  } catch (e) { next(e); }
});
router.put('/tenants/:slug/owner-details', (req, res) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    saveOwnerDetails(req.params.slug, req.body);
    logProvisioning(req.params.slug, 'owner-details', (req as PlatformAuthedRequest).platformUser?.username ?? 'operator');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/tenants/:slug/support', (req, res) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    addSupport(req.params.slug, req.body, (req as PlatformAuthedRequest).platformUser?.username ?? 'operator');
    logProvisioning(req.params.slug, 'support', 'Support entry added');
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/tenants/:slug/support/:id/replies', (req, res) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    if (!replySupport(req.params.slug, Number(req.params.id), req.body, (req as PlatformAuthedRequest).platformUser?.username ?? 'operator', 'owner')) {
      res.status(404).json({ error: 'Unknown ticket.' }); return;
    }
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.patch('/tenants/:slug/support/:id', (req, res) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    if (!updateSupport(req.params.slug, Number(req.params.id), req.body)) { res.status(404).json({ error: 'Unknown support entry.' }); return; }
    logProvisioning(req.params.slug, 'support', `Entry ${req.params.id}: ${req.body.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// POST /_platform/api/tenants/:slug/reset-owner-password — operator-only recovery.
router.post('/tenants/:slug/reset-owner-password', async (req, res, next) => {
  try {
    const t = getTenant(req.params.slug);
    if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown workspace.' }); return; }
    if ('temporary' in (req.body || {}) && typeof req.body.temporary !== 'boolean') {
      res.status(400).json({ error: 'temporary must be a boolean.' }); return;
    }
    const temporary = req.body?.temporary === true;
    const new_password = temporary ? crypto.randomBytes(18).toString('base64url') : parseBody(resetPasswordSchema, req.body).new_password;
    const expiresAt = temporary ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
    const owner = tenantOwner(t.slug);
    if (!owner) { res.status(409).json({ error: 'This workspace has no administrator account.' }); return; }
    // Confirm the displayed account so a stale drawer cannot reset a different admin.
    if (req.body?.owner_id !== owner.id) {
      res.status(409).json({ error: 'The owner account changed. Reopen the workspace and try again.' }); return;
    }
    const hash = bcrypt.hashSync(new_password, 10);
    withTenant(t.slug, () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        run('UPDATE users SET password_hash = ?, password_change_required = ?, temporary_password_expires_at = ? WHERE id = ?', hash, temporary ? 1 : 0, expiresAt, owner.id);
        endUserSessions(owner.id, 'password');
        run('DELETE FROM password_resets WHERE user_id = ?', owner.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    });
    const by = (req as PlatformAuthedRequest).platformUser!.username;
    logProvisioning(t.slug, 'owner-password-reset', `${by}: reset owner ${owner.username} (id=${owner.id}); ${temporary ? 'temporary password' : 'password'}`);
    const email = temporary ? { sent: false, reason: 'Share the temporary password directly with the owner.' } : t.is_sandbox === 1 ? { sent: false, reason: 'sandbox' } :
      owner.email ? await withTenant(t.slug, async () => {
        const result = await sendMail({
          to: owner.email!, subject: 'Owner login password reset',
          text: `The password for your ${t.name} workspace was reset by a platform administrator.\n\nYour username: ${owner.username}\n\nContact your SaaS provider for the new password.`,
        });
        return { sent: result.ok, reason: result.ok ? '' : result.error };
      }) : { sent: false, reason: 'No recovery email on file.' };
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, username: owner.username, email,
      ...(temporary ? { temporary_password: new_password, expires_at: expiresAt } : {}),
    });
  } catch (e) { next(e); }
});

// Send a forgotten username to the recorded owner email; sandbox recovery stays manual.
router.post('/tenants/:slug/recover-owner-username', async (req, res, next) => {
  try {
    const t = getTenant(req.params.slug);
    if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown workspace.' }); return; }
    const owner = tenantOwner(t.slug);
    if (!owner) { res.status(409).json({ error: 'This workspace has no administrator account.' }); return; }
    if (t.is_sandbox === 1) { res.json({ ok: true, username: owner.username, email: { sent: false, reason: 'sandbox' } }); return; }
    if (!owner.email) { res.status(409).json({ error: 'No recovery email on file.' }); return; }
    const result = await withTenant(t.slug, () => sendMail({
      to: owner.email!, subject: 'Your workspace owner username',
      text: `Your username for ${t.name}: ${owner.username}\n\nIf you also forgot your password, use Forgot username or password on the workspace sign-in page.`,
    }));
    logProvisioning(t.slug, 'owner-username-recovery', `${(req as PlatformAuthedRequest).platformUser!.username}: ${owner.username}; email ${result.ok ? 'sent' : 'failed'}`);
    res.json({ ok: true, username: owner.username, email: { sent: result.ok, reason: result.error || '' } });
  } catch (e) { next(e); }
});

/** A missing slug is derived from the company name, with a suffix for collisions. */
function availableSlug(name: string): string {
  let base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  if (!isValidSlug(base)) base = 'workspace';
  let slug = base;
  for (let i = 2; getTenant(slug); i++) slug = `${base}-${i}`;
  return slug;
}

// POST /_platform/api/tenants — provision a new workspace.
router.post('/tenants', (req: Request, res: Response, next) => {
  try {
    const b = parseBody(platformCreateTenantSchema, req.body);
    const { slug } = createTenant({
      slug: b.slug || availableSlug(b.name),
      name: String(b.name || ''),
      admin_username: String(b.admin_username || ''),
      admin_password: String(b.admin_password || ''),
      admin_email: b.admin_email,
      is_sandbox: b.is_sandbox,
      plan: b.plan ? String(b.plan) : undefined,
    });
    // An explicit module set at creation time (optional).
    if (Array.isArray(b.modules)) {
      const list = normalizeModules(b.modules);
      setTenantModules(slug, list);
      logProvisioning(slug, 'modules', JSON.stringify(list));
    }
    if (!b.plan && !Array.isArray(b.modules)) {
      saveSubscription(slug, { mode: 'per_module', bundle: 'starter', modules: [], seat_limit: null,
        bundle_price: null, module_prices: {}, seat_price: null });
    }
    // Optional: keep it on the Billing screen until the first payment is confirmed (billing.ts).
    if (b.awaiting_payment) { setAwaitingPayment(slug, true); logProvisioning(slug, 'update', 'locked until first payment'); }
    // Created from a website inquiry: link the two so the inquiry shows its workspace.
    if (b.inquiry_id && getInquiry(b.inquiry_id)) {
      updateInquiry(b.inquiry_id, { tenant_slug: slug });
      logProvisioning(slug, 'inquiry', `created from website inquiry #${b.inquiry_id}`);
    }
    const t = getTenant(slug)!;
    res.status(201).json(tenantView(t));
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status && err.status < 500) { res.status(err.status).json({ error: err.message }); return; }
    if (err instanceof Error && /module/i.test(err.message)) { res.status(400).json({ error: err.message }); return; }
    next(e);
  }
});

// POST /_platform/api/tenants/import — multipart { db: <.db file>, slug, name, plan? }.
// Adopts an existing workspace database (e.g. a self-hosted install's snapshot) as a tenant.
const importUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });
router.post('/tenants/import', importUpload.single('db'), (req: Request, res: Response, next) => {
  const file = req.file;
  try {
    if (!file) { res.status(400).json({ error: 'Choose a database (.db) file to import.' }); return; }
    const b = req.body || {};
    const { slug, users } = importTenant({
      slug: String(b.slug || ''),
      name: String(b.name || ''),
      plan: b.plan ? String(b.plan) : undefined,
      sourceFile: file.path,
    });
    res.status(201).json({ ...tenantView(getTenant(slug)!), imported_users: users });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status && err.status < 500) { res.status(err.status).json({ error: err.message }); return; }
    next(e);
  } finally {
    if (file) fs.rmSync(file.path, { force: true });
  }
});

// Subscription settings are saved separately from general tenant settings.
router.put('/tenants/:slug/subscription', (req, res) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    saveSubscription(req.params.slug, req.body);
    logProvisioning(req.params.slug, 'subscription', JSON.stringify({
      by: (req as PlatformAuthedRequest).platformUser?.username,
      subscription: subscriptionView(getTenant(req.params.slug)!),
    }));
    res.json(tenantView(getTenant(req.params.slug)!));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// PATCH /_platform/api/tenants/:slug — { name?, plan?, status?, trial_ends_at?, modules? }
// `modules`: an array (explicit override, dependencies auto-added) or null (use the plan default).
router.patch('/tenants/:slug', (req, res, next) => {
  const t = getTenant(req.params.slug);
  if (!t) { res.status(404).json({ error: 'Unknown workspace.' }); return; }
  const b = req.body || {};
  const by = (req as PlatformAuthedRequest).platformUser?.username || 'operator';
  const changed: string[] = [];
  if (t.subscription && ('plan' in b || 'modules' in b)) {
    res.status(400).json({ error: 'Use subscription settings to change this tenant’s bundle or modules.' }); return;
  }
  try {
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== t.name) {
      setTenantName(t.slug, b.name.trim()); changed.push('name');
    }
    // Open a self-signed-up workspace without waiting for payment (or lock it again).
    if (typeof b.awaiting_payment === 'boolean' && b.awaiting_payment !== !!t.awaiting_payment) {
      setAwaitingPayment(t.slug, b.awaiting_payment); changed.push(b.awaiting_payment ? 'locked until paid' : 'opened without payment');
    }
    if (typeof b.plan === 'string' && b.plan !== t.plan) {
      if (!(b.plan in PLANS)) { res.status(400).json({ error: `Unknown plan "${b.plan}".` }); return; }
      setTenantPlan(t.slug, b.plan); changed.push(`plan=${b.plan}`);
    }
    if (typeof b.status === 'string' && b.status !== t.status) {
      if (!TENANT_STATUSES.includes(b.status as TenantStatus) || b.status === 'purged') {
        res.status(400).json({ error: `Invalid status "${b.status}".` }); return;
      }
      setTenantStatus(t.slug, b.status as TenantStatus); changed.push(`status=${b.status}`);
    }
    if ('trial_ends_at' in b) {
      const v = b.trial_ends_at;
      if (v !== null && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
        res.status(400).json({ error: 'trial_ends_at must be an ISO datetime or null.' }); return;
      }
      setTrialEndsAt(t.slug, v === null ? null : new Date(v).toISOString());
      changed.push('trial_ends_at');
    }
    if ('modules' in b) {
      if (b.modules === null) {
        setTenantModules(t.slug, null); changed.push('modules=plan-default');
      } else if (Array.isArray(b.modules)) {
        const list = normalizeModules(b.modules); // throws on an unknown name; deps unioned in
        setTenantModules(t.slug, list); changed.push(`modules=[${list.join(',')}]`);
      } else {
        res.status(400).json({ error: 'modules must be an array or null.' }); return;
      }
    }
    if ('photo_retention_days' in b || 'photo_max_mb' in b) {
      const nonNegInt = (v: unknown, field: string): number | null => {
        if (v === null) return null;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          throw new Error(`${field} must be a non-negative integer, or null for the system default.`);
        }
        return v;
      };
      const patch: { days?: number | null; maxMb?: number | null } = {};
      const desc: string[] = [];
      if ('photo_retention_days' in b) {
        patch.days = nonNegInt(b.photo_retention_days, 'photo_retention_days');
        desc.push(`days:${patch.days ?? 'default'}`);
      }
      if ('photo_max_mb' in b) {
        patch.maxMb = nonNegInt(b.photo_max_mb, 'photo_max_mb');
        desc.push(`maxMb:${patch.maxMb ?? 'default'}`);
      }
      setTenantPhotoRetention(t.slug, patch);
      changed.push(`photo_retention=[${desc.join(', ')}]`);
    }
  } catch (e) {
    res.status(400).json({ error: (e as Error).message }); return;
  }
  if (changed.length) logProvisioning(t.slug, 'update', `${by}: ${changed.join('; ')}`);
  res.json(tenantView(getTenant(t.slug)!));
});

// POST /_platform/api/tenants/:slug/purge — { confirm: "<slug>" }  irreversible.
router.post('/tenants/:slug/purge', (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t) { res.status(404).json({ error: 'Unknown workspace.' }); return; }
  if (String(req.body?.confirm || '') !== t.slug) {
    res.status(400).json({ error: `Type the workspace slug ("${t.slug}") to confirm.` }); return;
  }
  purgeTenant(t.slug);
  res.json({ ok: true });
});

// GET /_platform/api/log?slug=&limit=
router.get('/log', (req, res) => {
  const slug = typeof req.query.slug === 'string' && req.query.slug ? req.query.slug : undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(listProvisioningLog(slug, limit));
});

// Workspace billing: invoices, reported payments, bank + GCash details, price list (billing-console.routes.ts).
router.use(billingConsoleRoutes);
// Website "Talk to us" inquiries + the contact details the site shows (inquiries-console.routes.ts).
router.use(inquiriesConsoleRoutes);
// The platform mailbox + owner alerts (platform-mail-console.routes.ts).
router.use(platformMailRoutes);

export default router;
