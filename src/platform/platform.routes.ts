import { prepareCreationReceipt, saveCreationReceipt } from './onboarding-receipts';
import { z } from 'zod';
import { forwardControlPlaneError } from './request-errors';
import { browserMode, browserCsrf } from '../shared/browser-session';
import { loginSchema } from '../shared/validation';
import { BEHIND_PROXY } from '../shared/hosting';
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
  type TenantRow, type TenantStatus, tenantPublicUrl, platformDb,
} from './platform';
import { createTenant, importTenant, purgeTenant } from './provisioning';
import billingConsoleRoutes from './billing-console.routes';
import inquiriesConsoleRoutes from './inquiries-console.routes';
import platformMailRoutes from './platform-mail-console.routes';
import { updateInquiry, getInquiry } from './inquiries';
import { tenantBillingSummary, getBillingSettings } from './billing';
import { tenantAnalytics, saveOwnerDetails, addSupport, updateSupport, replySupport } from './owner-analytics';
import { saveSubscription, subscriptionView } from './subscription';
import { tenantUsage } from './quota';
import { punchPhotoUsageBytes } from '../modules/hr/punch-photos';
import { enabledModules, isModuleName, withDeps, MODULES, MODULE_DEPS } from '../shared/modules';
import { hashPassword, verifyPassword } from '../shared/password-hash';
import { issueAccountRecovery, recoveryEvidenceSchema, credentialStamp, recoveryLinkBase } from '../shared/account-recovery';
import { endUserSessions } from '../shared/auth';
import { getMailSettings, saveMailSettings, mailReady, verifyMailSettings, sendMail } from '../shared/mailer';
import { parseBody, ValidationError, changeUsernameSchema, mailSettingsSchema, resetPasswordSchema, platformCreateTenantSchema } from '../shared/validation';
import { PLANS, PLAN_MODULES, planModules } from './plans';
import { rateLimitKey } from '../shared/device';
import {
  requirePlatformAuth, verifyPlatformPasswordAsync, platformPasswordStillCurrent, createPlatformSession, platformLogout, listPlatformUsers, changePlatformPassword, changePlatformUsername,
  type PlatformAuthedRequest,
} from './platform-users';
import { hasPlatformPasskey, requiresPlatformPasskeySetup, platformSessionVerified, markPlatformSessionVerified, listPlatformPasskeys,
  registrationOptions, finishRegistration, authenticationOptions, finishAuthentication, requireAllPlatformPasskeys, removePlatformPasskey } from './platform-passkeys';
import { PasswordWorkBusyError } from '../shared/password-work';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';

const router = Router();

const TENANT_STATUSES: TenantStatus[] = ['trial', 'active', 'past_due', 'suspended', 'purged'];

/** A client-supplied `modules` array → a stored override list: reject unknown names,
 *  then union in dependencies (same friendliness as `npm run tenant:modules --set`). */
function normalizeModules(arr: unknown[]): string[] {
  const names = arr.map(String);
  const unknown = names.filter((m) => !isModuleName(m));
  if (unknown.length) throw new ValidationError(`Unknown module(s): ${unknown.join(', ')}. Known: ${MODULES.join(', ')}`);
  return withDeps(names);
}

// The console only exists on the apex / default host — never a tenant sub-domain.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
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

router.use(browserCsrf);

// POST /_platform/api/login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
  const { username, password } = parseBody(loginSchema.omit({ shared: true }).strict(), req.body);
  if (!username || !password) { res.status(400).json({ error: 'Username and password are required.' }); return; }
  const verified = await verifyPlatformPasswordAsync(username, password);
  if (!verified) { res.status(401).json({ error: 'Invalid username or password.' }); return; }
  const id = verified.id;
  if (hasPlatformPasskey(id)) {
    const challenge = await authenticationOptions(id);
    if (!platformPasswordStillCurrent(verified)) { res.status(401).json({error:'Invalid username or password.'}); return; }
    res.set('Cache-Control','no-store').json({ passkey_required:true, ...challenge }); return;
  }
  const token = createPlatformSession(id);
  sendOperatorSession(req,res,token);
  } catch (error) { if (error instanceof PasswordWorkBusyError) res.set('Retry-After','5'); next(error); }
});
function sendOperatorSession(req: Request,res: Response,token: string) {
  res.set('Cache-Control','no-store');
  if (browserMode(req)) {
    res.cookie('vds_platform_session', token, { httpOnly: true, secure: req.secure || BEHIND_PROXY, sameSite: 'strict', path: '/_platform', maxAge: 12 * 60 * 60 * 1000 });
    res.json({ browser_session: true });
  } else res.json({ token });
}

const credentialBody = z.object({ token:z.string().length(64), response:z.object({id:z.string().min(1).max(2048),type:z.literal('public-key')}).passthrough() }).strict();
router.post('/passkeys/login', loginLimiter, async(req,res) => {
  try {
    const input=parseBody(credentialBody,req.body);
    const id=await finishAuthentication(input.token,input.response as unknown as AuthenticationResponseJSON);
    const token=createPlatformSession(id); markPlatformSessionVerified(token); sendOperatorSession(req,res,token);
  } catch { res.status(400).json({error:'Passkey verification failed or expired. Start sign-in again.'}); }
});

// Everything below needs a valid operator session.
router.use(requirePlatformAuth);

const passkeyLimiter=rateLimit({windowMs:15*60_000,limit:20,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>String((req as PlatformAuthedRequest).platformUser!.id)});
router.get('/passkeys', (req,res)=>res.json({keys:listPlatformPasskeys((req as PlatformAuthedRequest).platformUser!.id)}));
router.post('/passkeys/register/options',passkeyLimiter,async(req,res,next)=>{
  try { const input=parseBody(z.object({current_password:z.string().min(1).max(256)}).strict(),req.body);const r=req as PlatformAuthedRequest;
    res.set('Cache-Control','no-store').json(await registrationOptions(r.platformUser!.id,r.platformToken!,input.current_password));
  } catch(error){next(error);}
});
router.post('/passkeys/register/verify',passkeyLimiter,async(req,res)=>{
  try {const input=parseBody(credentialBody.extend({label:z.string().trim().min(1).max(80)}),req.body);const r=req as PlatformAuthedRequest;
    await finishRegistration(r.platformUser!.id,r.platformToken!,input.token,input.response as unknown as RegistrationResponseJSON,input.label);
    logProvisioning('_console','passkey.enrolled',`operator=${r.platformUser!.id}`);res.json({ok:true});
  } catch {res.status(400).json({error:'Passkey enrollment failed or expired. Start again.'});}
});
router.post('/passkeys/verify/options',passkeyLimiter,async(req,res,next)=>{
  try {const r=req as PlatformAuthedRequest;res.set('Cache-Control','no-store').json(await authenticationOptions(r.platformUser!.id,r.platformToken!));}catch(error){next(error);}
});
router.post('/passkeys/verify',passkeyLimiter,async(req,res)=>{
  try {const input=parseBody(credentialBody,req.body);const r=req as PlatformAuthedRequest;await finishAuthentication(input.token,input.response as unknown as AuthenticationResponseJSON,r.platformToken!);res.json({ok:true});}
  catch {res.status(400).json({error:'Passkey verification failed or expired. Try again.'});}
});
router.post('/passkeys/require',passkeyLimiter,(req,res,next)=>{
  try {requireAllPlatformPasskeys((req as PlatformAuthedRequest).platformToken!);logProvisioning('_console','passkey.required',`operator=${(req as PlatformAuthedRequest).platformUser!.id}`);res.json({ok:true});}catch(error){next(error);}
});
router.post('/passkeys/remove',passkeyLimiter,(req,res,next)=>{
  try {const input=parseBody(z.object({id:z.string().min(1).max(2048),current_password:z.string().min(1).max(256)}).strict(),req.body);const r=req as PlatformAuthedRequest;
    removePlatformPasskey(r.platformUser!.id,r.platformToken!,input.id,input.current_password);logProvisioning('_console','passkey.removed',`operator=${r.platformUser!.id}`);res.json({ok:true});
  }catch(error){next(error);}
});

router.post('/logout', (req, res) => {
  const t = (req as PlatformAuthedRequest).platformToken;
  if (t) platformLogout(t);
  res.clearCookie('vds_platform_session', { path: '/_platform', httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user=(req as PlatformAuthedRequest).platformUser!;
  res.json({ user, passkey_enrolled:hasPlatformPasskey(user.id), passkey_setup_required:requiresPlatformPasskeySetup(user.id) });
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

// POST /_platform/api/username — self-service operator username change.
router.post('/username', loginLimiter, (req, res) => {
  const r = req as PlatformAuthedRequest;
  const { current_password, new_username } = parseBody(changeUsernameSchema, req.body);
  const error = changePlatformUsername(r.platformUser!.id, current_password, new_username, r.platformToken!);
  if (error) { res.status(error.includes('already in use') ? 409 : 400).json({ error }); return; }
  logProvisioning('_console', 'operator.username', `${r.platformUser!.username} changed their console username to ${new_username}`);
  res.json({ ok: true, username: new_username });
});

// These endpoints always select the catalog tenant, never the operator's default DB.
router.use('/tenants/:slug/mail', (req, res, next) => {
  const t = getTenant(req.params.slug);
  if (!t || t.status === 'purged') {
    res.status(404).json({ error: 'Unknown workspace.' });
    return;
  }
  next();
});

router.get('/tenants/:slug/mail', (req, res) => {
  res.json(withTenant(req.params.slug, () => ({ ...getMailSettings(), ready: mailReady() })));
});

router.put('/tenants/:slug/mail', (req, res, next) => {
  try {
    const input = parseBody(mailSettingsSchema, req.body);
    if (input.transport === 'smtp' && (!input.smtp_host || !input.from_email)) {
      res.status(400).json({ error: 'SMTP host and a From address are required for SMTP.' });
      return;
    }
    const ready = withTenant(req.params.slug, () => {
      saveMailSettings(input);
      return mailReady();
    });
    const by = (req as PlatformAuthedRequest).platformUser!.username;
    // No credentials or user-supplied SMTP values in the operator audit log.
    logProvisioning(req.params.slug, 'email-settings', `${by}: saved email settings (${input.transport})`);
    res.json({ ok: true, ready });
  } catch (e) { next(e); }
});

router.post('/tenants/:slug/mail/test', async (req, res, next) => {
  try {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (to.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      res.status(400).json({ error: 'A valid recipient email is required.' });
      return;
    }
    const result = await withTenant(req.params.slug, async () => {
      const verified = await verifyMailSettings();
      if (!verified.ok) return { ok: false, error: `Connection failed: ${verified.error}` };
      // Operators are not tenant users: don't attach their ID to a tenant foreign key.
      return sendMail({ to, subject: 'Otom — test email', text: 'This is a test message from your Otom system. Email is working.' });
    });
    const by = (req as PlatformAuthedRequest).platformUser!.username;
    logProvisioning(req.params.slug, 'email-test', `${by}: ${result.ok ? 'sent' : 'failed'}`);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { next(e); }
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
    company_id: t.company_id,
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
router.put('/tenants/:slug/owner-details', (req, res, next) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    saveOwnerDetails(req.params.slug, req.body);
    logProvisioning(req.params.slug, 'owner-details', (req as PlatformAuthedRequest).platformUser?.username ?? 'operator');
    res.json({ ok: true });
  } catch (e) { forwardControlPlaneError(e, next); }
});
router.post('/tenants/:slug/support', (req, res, next) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    addSupport(req.params.slug, req.body, (req as PlatformAuthedRequest).platformUser?.username ?? 'operator');
    logProvisioning(req.params.slug, 'support', 'Support entry added');
    res.status(201).json({ ok: true });
  } catch (e) { forwardControlPlaneError(e, next); }
});
router.post('/tenants/:slug/support/:id/replies', (req, res, next) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    if (!replySupport(req.params.slug, Number(req.params.id), req.body, (req as PlatformAuthedRequest).platformUser?.username ?? 'operator', 'owner')) {
      res.status(404).json({ error: 'Unknown ticket.' }); return;
    }
    res.status(201).json({ ok: true });
  } catch (e) { forwardControlPlaneError(e, next); }
});
router.patch('/tenants/:slug/support/:id', (req, res, next) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    if (!updateSupport(req.params.slug, Number(req.params.id), req.body)) { res.status(404).json({ error: 'Unknown support entry.' }); return; }
    logProvisioning(req.params.slug, 'support', `Entry ${req.params.id}: ${req.body.status}`);
    res.json({ ok: true });
  } catch (e) { forwardControlPlaneError(e, next); }
});

// POST /_platform/api/tenants/:slug/reset-owner-password — operator-only recovery.
const supportRecoveryLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String((req as PlatformAuthedRequest).platformUser!.id), message: { error: 'Too many recovery attempts. Try again later.' } });
function supportRecoveryDb() {
  const conn = platformDb();
  conn.exec(`CREATE TABLE IF NOT EXISTS platform_recovery_approvals (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, user_id INTEGER NOT NULL, contact_email TEXT NOT NULL,
    credential_hash TEXT NOT NULL, requested_by INTEGER NOT NULL, approved_by INTEGER,
    reason TEXT NOT NULL, verification_reference TEXT NOT NULL,
    cancel_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'notifying', created_at TEXT NOT NULL DEFAULT(datetime('now')),
    expires_at TEXT NOT NULL DEFAULT(datetime('now','+48 hours'))
  )`);
  return conn;
}
function verifiedOperator(req: Request, password: string): boolean {
  const id = (req as PlatformAuthedRequest).platformUser!.id;
  const row = platformDb().prepare('SELECT password_hash FROM platform_users WHERE id=?').get(id) as { password_hash: string } | undefined;
  return !!row && verifyPassword(password, row.password_hash);
}
router.get('/tenants/:slug/account-recoveries', (req, res) => {
  res.json(supportRecoveryDb().prepare('SELECT id,user_id,requested_by,approved_by,reason,verification_reference,state,created_at,expires_at FROM platform_recovery_approvals WHERE slug=? ORDER BY created_at DESC LIMIT 20').all(String(req.params.slug)));
});
router.post('/tenants/:slug/account-recoveries', supportRecoveryLimiter, async (req, res, next) => {
  try {
    const input = parseBody(recoveryEvidenceSchema.extend({ current_password: z.string().min(1).max(256), owner_id: z.number().int().positive() }).strict(), req.body);
    if (!verifiedOperator(req, input.current_password)) { res.status(403).json({ error: 'Confirm your current console password.' }); return; }
    const tenant = getTenant(String(req.params.slug));
    const owner = tenant && tenant.status !== 'purged' ? tenantOwner(tenant.slug) : null;
    if (!owner || owner.id !== input.owner_id || !owner.active || !owner.email || tenant!.is_sandbox) { res.status(409).json({ error: 'Select the current active owner with an existing recovery email. Sandbox recovery is unavailable.' }); return; }
    const credential = withTenant(tenant!.slug, () => queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', owner.id)!.password_hash);
    const id = crypto.randomUUID();
    const by = (req as PlatformAuthedRequest).platformUser!.id;
    const cancel = crypto.randomBytes(32).toString('hex');
    const conn = supportRecoveryDb();
    conn.prepare('INSERT INTO platform_recovery_approvals(id,slug,user_id,contact_email,credential_hash,requested_by,reason,verification_reference,cancel_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(id, tenant!.slug, owner.id, owner.email, credentialStamp(credential), by, input.reason, input.verification_reference, credentialStamp(cancel));
    try {
      await withTenant(tenant!.slug, async () => {
        if (!mailReady()) throw Object.assign(new Error('Configure working workspace email before recovery.'), { status: 409 });
        const base = recoveryLinkBase(process.env.TENANT_PATH_HOST ? `/${tenant!.slug}` : '');
        const sent = await sendMail({ to: owner.email!, subject: 'Authenticator recovery requested — no changes made', text: `Support requested authenticator recovery for ${owner.username}. No password or factor has changed. Solo support must wait at least 24 hours before approving; requests expire after 48 hours. If this was unexpected, cancel the request during the waiting period using this link and confirmation screen:\n${base}/?cancel_recovery=${id}.${cancel}\n\nContact your company administrator through your established contact details.` });
        if (!sent.ok) throw Object.assign(new Error('Recovery notification could not be delivered.'), { status: 503 });
      });
      conn.prepare("UPDATE platform_recovery_approvals SET state='pending' WHERE id=? AND state='notifying'").run(id);
    } catch (error) { conn.prepare("UPDATE platform_recovery_approvals SET state='failed' WHERE id=? AND state='notifying'").run(id); throw error; }
    logProvisioning(tenant!.slug, 'account-recovery-requested', `operator=${by}; request=${id}; owner=${owner.id}`);
    res.status(201).json({ id, message: 'The existing owner email was notified. Solo approval requires a 24-hour wait, fresh password and renewed identity verification. The request expires in 48 hours.' });
  } catch (error) { next(error); }
});
router.post('/tenants/:slug/account-recoveries/:id/approve', supportRecoveryLimiter, async (req, res, next) => {
  try {
    const input = parseBody(z.object({ current_password: z.string().min(1).max(256), verification_reference: z.string().trim().min(8).max(120) }).strict(), req.body);
    if (!verifiedOperator(req, input.current_password)) { res.status(403).json({ error: 'Confirm your current console password.' }); return; }
    const conn = supportRecoveryDb();
    const request = conn.prepare("SELECT * FROM platform_recovery_approvals WHERE id=? AND slug=? AND state='pending' AND expires_at>datetime('now')").get(String(req.params.id), String(req.params.slug)) as { id: string; slug: string; user_id: number; contact_email: string; credential_hash: string; requested_by: number; reason: string; verification_reference: string } | undefined;
    const by = (req as PlatformAuthedRequest).platformUser!.id;
    if (!request) { res.status(409).json({ error: 'This approval is unavailable or expired.' }); return; }
    if (!conn.prepare("SELECT 1 FROM platform_recovery_approvals WHERE id=? AND created_at<=datetime('now','-24 hours')").get(request.id)) {
      res.status(403).json({ error: 'Solo recovery requires a 24-hour waiting period after notifying the existing owner email.' }); return;
    }
    const tenant = getTenant(request.slug);
    const owner = tenant && tenant.status !== 'purged' ? tenantOwner(tenant.slug) : null;
    const currentHash = owner ? withTenant(request.slug, () => queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', owner.id)!.password_hash) : '';
    if (!owner || owner.id !== request.user_id || !owner.active || owner.email !== request.contact_email || credentialStamp(currentHash) !== request.credential_hash) { res.status(409).json({ error: 'The owner account changed. Start a new verification.' }); return; }
    const claimed = conn.prepare("UPDATE platform_recovery_approvals SET state='issuing',approved_by=? WHERE id=? AND state='pending'").run(by, request.id);
    if (Number(claimed.changes) !== 1) { res.status(409).json({ error: 'Already processed.' }); return; }
    try {
      await withTenant(request.slug, () => issueAccountRecovery(request.user_id, process.env.TENANT_PATH_HOST ? `/${request.slug}` : '', {
        requested_by: `platform:${request.requested_by}`, approved_by: `platform:${by}`, reason: request.reason,
        verification_reference: `${request.verification_reference}; approval: ${input.verification_reference}`,
      }));
      conn.prepare("UPDATE platform_recovery_approvals SET state='issued' WHERE id=?").run(request.id);
    } catch (error) { conn.prepare("UPDATE platform_recovery_approvals SET state='failed' WHERE id=?").run(request.id); throw error; }
    logProvisioning(request.slug, 'account-recovery-approved', `operator=${by}; request=${request.id}; owner=${request.user_id}`);
    res.set('Cache-Control','no-store').json({ ok: true, message: 'A single-use recovery link was sent to the existing owner email. MFA is not removed until redemption.' });
  } catch (error) { next(error); }
});

router.post('/tenants/:slug/account-recoveries/:id/cancel', supportRecoveryLimiter, (req, res, next) => {
  try {
    const input = parseBody(z.object({ current_password: z.string().min(1).max(256) }).strict(), req.body);
    if (!verifiedOperator(req, input.current_password)) { res.status(403).json({ error: 'Confirm your current console password.' }); return; }
    const result = supportRecoveryDb().prepare("UPDATE platform_recovery_approvals SET state='cancelled' WHERE id=? AND slug=? AND state IN ('pending','notifying')").run(String(req.params.id), String(req.params.slug));
    if (!Number(result.changes)) { res.status(409).json({ error: 'This request can no longer be cancelled here. Contact support if recovery was already issued.' }); return; }
    logProvisioning(String(req.params.slug), 'account-recovery-cancelled', `operator=${(req as PlatformAuthedRequest).platformUser!.id}; request=${String(req.params.id)}`);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/tenants/:slug/reset-owner-password', supportRecoveryLimiter, async (req, res, next) => {
  try {
    const t = getTenant(String(req.params.slug));
    if (!t || t.status === 'purged') { res.status(404).json({ error: 'Unknown workspace.' }); return; }
    if ('temporary' in (req.body || {}) && typeof req.body.temporary !== 'boolean') {
      res.status(400).json({ error: 'temporary must be a boolean.' }); return;
    }
    const input = parseBody(resetPasswordSchema.partial().extend({ owner_id: z.number().int().positive(), temporary: z.boolean().optional(), current_password: z.string().min(1).max(256), reason: z.string().trim().min(20).max(500) }).strict().refine(value => value.temporary || !!value.new_password, 'A new password is required'), req.body);
    if (!verifiedOperator(req, input.current_password)) { res.status(403).json({ error: 'Confirm your current console password.' }); return; }
    const temporary = input.temporary === true;
    const new_password = temporary ? crypto.randomBytes(18).toString('base64url') : input.new_password!;
    const expiresAt = temporary ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
    const owner = tenantOwner(t.slug);
    if (!owner) { res.status(409).json({ error: 'This workspace has no administrator account.' }); return; }
    // Confirm the displayed account so a stale drawer cannot reset a different admin.
    if (req.body?.owner_id !== owner.id) {
      res.status(409).json({ error: 'The owner account changed. Reopen the workspace and try again.' }); return;
    }
    const hash = hashPassword(new_password);
    withTenant(t.slug, () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        run('UPDATE users SET password_hash = ?, password_change_required = ?, temporary_password_expires_at = ? WHERE id = ?', hash, temporary ? 1 : 0, expiresAt, owner.id);
        endUserSessions(owner.id, 'password');
        run('DELETE FROM password_resets WHERE user_id = ?', owner.id);
        run('DELETE FROM mfa_challenges WHERE user_id = ?', owner.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    });
    const by = (req as PlatformAuthedRequest).platformUser!.username;
    logProvisioning(t.slug, 'owner-password-reset', `${by}: reset owner ${owner.username} (id=${owner.id}); ${temporary ? 'temporary password' : 'password'}; reason=${input.reason}`);
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
    const receipt = prepareCreationReceipt('console-create:v1:' + (req as PlatformAuthedRequest).platformUser!.id, req.get('Idempotency-Key'), b);
    if (receipt?.replay) { res.set('Idempotency-Replayed', 'true').status(201).json(receipt.replay); return; }
    const modules = b.modules === undefined ? undefined : normalizeModules(b.modules);
    getBillingSettings(); // Warm cached schema outside the publication savepoint.
    const inquiry = b.inquiry_id ? getInquiry(b.inquiry_id) : null;
    let view: ReturnType<typeof tenantView> | undefined;
    createTenant({
      slug: b.slug || availableSlug(b.name),
      name: String(b.name || ''),
      admin_username: String(b.admin_username || ''),
      admin_password: String(b.admin_password || ''),
      admin_email: b.admin_email,
      is_sandbox: b.is_sandbox,
      plan: b.plan ? String(b.plan) : undefined,
    }, slug => {
      // An explicit module set at creation time (optional).
      if (Array.isArray(b.modules)) {
        const list = modules!;
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
      if (b.inquiry_id && inquiry) {
        updateInquiry(b.inquiry_id, { tenant_slug: slug });
        logProvisioning(slug, 'inquiry', `created from website inquiry #${b.inquiry_id}`);
      }
      view = tenantView(getTenant(slug)!);
      saveCreationReceipt(receipt, slug, view);
    });
    res.status(201).json(view);
  } catch (e) { forwardControlPlaneError(e, next); }
});

// POST /_platform/api/tenants/import — multipart { db: <.db file>, slug, name, plan? }.
// Adopts an existing workspace database (e.g. a self-hosted install's snapshot) as a tenant.
const importUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });
router.post('/tenants/import', importUpload.single('db'), (req: Request, res: Response, next) => {
  const file = req.file;
  try {
    if (!file) { res.status(400).json({ error: 'Choose a database (.db) file to import.' }); return; }
    const b = parseBody(z.object({ slug: z.string().min(1).max(31), name: z.string().trim().max(120).default(''), plan: z.string().optional() }), req.body);
    const { slug, users } = importTenant({
      slug: String(b.slug || ''),
      name: String(b.name || ''),
      plan: b.plan ? String(b.plan) : undefined,
      sourceFile: file.path,
    });
    res.status(201).json({ ...tenantView(getTenant(slug)!), imported_users: users });
  } catch (e) { forwardControlPlaneError(e, next);
  } finally {
    if (file) fs.rmSync(file.path, { force: true });
  }
});

// Subscription settings are saved separately from general tenant settings.
/** Synchronous catalog changes and their audit entry succeed or roll back together. */
function settingsWrite<T>(work: () => T): T {
  const database = platformDb();
  database.exec('SAVEPOINT tenant_settings');
  try { const result = work(); database.exec('RELEASE tenant_settings'); return result; }
  catch (error) { database.exec('ROLLBACK TO tenant_settings'); database.exec('RELEASE tenant_settings'); throw error; }
}
router.put('/tenants/:slug/subscription', (req, res, next) => {
  if (!getTenant(req.params.slug)) { res.status(404).json({ error: 'Unknown tenant.' }); return; }
  try {
    const view = settingsWrite(() => {
      saveSubscription(req.params.slug, req.body);
      logProvisioning(req.params.slug, 'subscription', JSON.stringify({ by: (req as PlatformAuthedRequest).platformUser?.username,
        subscription: subscriptionView(getTenant(req.params.slug)!) }));
      return tenantView(getTenant(req.params.slug)!);
    });
    res.json(view);
  } catch (error) { forwardControlPlaneError(error, next); }
});

const tenantSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  awaiting_payment: z.boolean().optional(),
  plan: z.string().refine(value => Object.hasOwn(PLANS, value), 'Unknown plan.').optional(),
  status: z.enum(['trial', 'active', 'past_due', 'suspended']).optional(),
  trial_ends_at: z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO datetime or null.').nullable().optional(),
  modules: z.array(z.enum(MODULES)).nullable().optional(),
  photo_retention_days: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  photo_max_mb: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
// Validate the entire patch before the first mutation, including optional fields.
router.patch('/tenants/:slug', (req, res, next) => {
  const tenant = getTenant(req.params.slug);
  if (!tenant) { res.status(404).json({ error: 'Unknown workspace.' }); return; }
  try {
    const b = parseBody(tenantSettingsSchema, req.body);
    if (tenant.subscription && ('plan' in b || 'modules' in b)) {
      throw new ValidationError('Use subscription settings to change this tenant’s bundle or modules.');
    }
    const view = settingsWrite(() => {
      const changed: string[] = [];
      if (b.name !== undefined && b.name !== tenant.name) { setTenantName(tenant.slug, b.name); changed.push('name'); }
      if (b.awaiting_payment !== undefined && b.awaiting_payment !== !!tenant.awaiting_payment) {
        setAwaitingPayment(tenant.slug, b.awaiting_payment); changed.push(b.awaiting_payment ? 'locked until paid' : 'opened without payment');
      }
      if (b.plan !== undefined && b.plan !== tenant.plan) { setTenantPlan(tenant.slug, b.plan); changed.push(`plan=${b.plan}`); }
      if (b.status !== undefined && b.status !== tenant.status) { setTenantStatus(tenant.slug, b.status); changed.push(`status=${b.status}`); }
      if ('trial_ends_at' in b) { setTrialEndsAt(tenant.slug, b.trial_ends_at === null ? null : new Date(b.trial_ends_at!).toISOString()); changed.push('trial_ends_at'); }
      if ('modules' in b) {
        const modules = b.modules === null ? null : withDeps(b.modules!);
        setTenantModules(tenant.slug, modules); changed.push(`modules=${modules === null ? 'plan-default' : JSON.stringify(modules)}`);
      }
      if ('photo_retention_days' in b || 'photo_max_mb' in b) {
        setTenantPhotoRetention(tenant.slug, { ...('photo_retention_days' in b ? { days: b.photo_retention_days } : {}),
          ...('photo_max_mb' in b ? { maxMb: b.photo_max_mb } : {}) });
        changed.push('photo_retention');
      }
      if (changed.length) logProvisioning(tenant.slug, 'update', `${(req as PlatformAuthedRequest).platformUser?.username || 'operator'}: ${changed.join('; ')}`);
      return tenantView(getTenant(tenant.slug)!);
    });
    res.json(view);
  } catch (error) { forwardControlPlaneError(error, next); }
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
