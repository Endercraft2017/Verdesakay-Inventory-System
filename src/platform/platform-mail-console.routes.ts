import {ownerAlertHealth,ownerAlertHistory} from './owner-alert-monitor';
import { forwardControlPlaneError } from './request-errors';
import { ownerAlertStatus } from './owner-alert-outbox';
/**
 * Owner console: the platform mailbox and owner alerts (platform-mail.ts). Mounted inside the
 * console router (platform.routes.ts) after operator auth. The secret is write-only: the console
 * learns only whether one is saved.
 */
import { Router } from 'express';
import { platformDb, logProvisioning } from './platform';
import type { PlatformAuthedRequest } from './platform-users';
import { getPlatformMail, savePlatformMail, sendPlatformMail, platformMailLog, type PlatformMailSettings } from './platform-mail';

const router = Router();
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// GET /_platform/api/mail — settings (never the secret) + the recent send log
router.get('/mail/delivery', (req,res,next) => {
  try { const history=ownerAlertHistory({filter:req.query.filter,limit:req.query.limit,cursor:req.query.cursor});res.json({health:ownerAlertHealth(),...history}); }
  catch(error){forwardControlPlaneError(error,next);}
});

router.get('/mail', (_req, res, next) => {
  try {res.json({ settings: getPlatformMail(), log: platformMailLog(20), outbox: ownerAlertStatus(), delivery_health: ownerAlertHealth() });}
  catch(error){forwardControlPlaneError(error,next);}
});

// PUT /_platform/api/mail — { transport, from_name, from_email, smtp_*, alert_*, secret? }
router.put('/mail', (req, res, next) => {
  const b = req.body || {};
  const patch: Partial<PlatformMailSettings> = {};
  if (b.transport !== undefined) {
    if (!['off', 'brevo', 'smtp'].includes(b.transport)) { res.status(400).json({ error: 'transport must be off, brevo or smtp.' }); return; }
    patch.transport = b.transport;
  }
  if (typeof b.from_name === 'string') patch.from_name = b.from_name.trim().slice(0, 80);
  if (typeof b.from_email === 'string') {
    const v = b.from_email.trim();
    if (v && !EMAIL.test(v)) { res.status(400).json({ error: 'Enter a valid From address.' }); return; }
    patch.from_email = v;
  }
  if (typeof b.alert_to === 'string') {
    const list = b.alert_to.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (list.some((a: string) => !EMAIL.test(a))) { res.status(400).json({ error: 'Alert recipients must be email addresses, separated by commas.' }); return; }
    patch.alert_to = list.join(', ');
  }
  if (typeof b.smtp_host === 'string') patch.smtp_host = b.smtp_host.trim();
  if (b.smtp_port !== undefined) {
    const p = Number(b.smtp_port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { res.status(400).json({ error: 'Enter a valid SMTP port.' }); return; }
    patch.smtp_port = p;
  }
  if (typeof b.smtp_secure === 'boolean') patch.smtp_secure = b.smtp_secure;
  if (typeof b.smtp_user === 'string') patch.smtp_user = b.smtp_user.trim();
  for (const k of ['alert_inquiry', 'alert_payment', 'alert_signup'] as const) if (typeof b[k] === 'boolean') patch[k] = b[k];
  const secret = typeof b.secret === 'string' ? b.secret.trim() : undefined;
  if (b.clear_secret !== undefined && typeof b.clear_secret !== 'boolean') {
    res.status(400).json({ error: 'clear_secret must be a boolean.' }); return;
  }
  if (b.clear_secret && secret) {
    res.status(400).json({ error: 'Choose either a new secret or clear the saved secret.' }); return;
  }
  getPlatformMail(); // Warm mailbox schema before rollbackable configuration/audit.
  const d = platformDb();
  d.exec('SAVEPOINT console_mail_settings');
  try {
    const settings = savePlatformMail(patch,b.clear_secret ? '' : secret || undefined);
    logProvisioning('_console','platform-mail-settings',`${(req as PlatformAuthedRequest).platformUser!.username}: saved email settings`);
    const result = {settings,log:platformMailLog(20),outbox:ownerAlertStatus(),delivery_health:ownerAlertHealth()};
    d.exec('RELEASE console_mail_settings');
    res.json(result);
  } catch(error) { d.exec('ROLLBACK TO console_mail_settings');d.exec('RELEASE console_mail_settings');forwardControlPlaneError(error,next); }

});

// POST /_platform/api/mail/test — { to? } (defaults to the alert recipients)
router.post('/mail/test', async (req, res, next) => {
  try {
  const s = getPlatformMail();
  const to = String(req.body?.to || s.alert_to || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!to.length || to.some((a) => !EMAIL.test(a))) { res.status(400).json({ error: 'Enter who should receive the test email.' }); return; }
  const r = await sendPlatformMail({ to, subject: 'OTOM test email', kind: 'test',
    text: 'This is a test from your OTOM owner console. If you can read this, owner alerts will reach you.' });
  res.status(r.ok ? 200 : 502).json({ ...r, log: platformMailLog(20), outbox: ownerAlertStatus(), delivery_health: ownerAlertHealth() });
  } catch (error) { forwardControlPlaneError(error, next); }
});

export default router;
