/** Email: BYO-SMTP config (users.manage), sending (mail.send), and a send log. */
import { Router } from 'express';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, mailSettingsSchema, sendMailSchema } from '../../shared/validation';
import { getMailSettings, saveMailSettings, sendMail, verifyMailSettings, mailLog, mailReady } from '../../shared/mailer';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);

const configGate = requirePermission('users.manage');

// GET /api/mail/settings — current config (password never returned; `has_password` flag instead)
router.get('/settings', configGate, (_req, res) => {
  res.json({ ...getMailSettings(), ready: mailReady() });
});

// PUT /api/mail/settings
// The company's mail server and its password are cloud-only (D8).
router.put('/settings', configGate, syncClass('online'), (req, res) => {
  const input = parseBody(mailSettingsSchema, req.body);
  if (input.transport === 'smtp' && (!input.smtp_host || !input.from_email)) {
    res.status(400).json({ error: 'SMTP host and a From address are required for SMTP.' });
    return;
  }
  saveMailSettings(input);
  res.json({ ok: true, ready: mailReady() });
});

// POST /api/mail/test — verify the connection, then send a test message
router.post('/test', configGate, syncClass('online'), async (req, res, next) => {
  try {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      res.status(400).json({ error: 'A valid recipient email is required.' });
      return;
    }
    const v = await verifyMailSettings();
    if (!v.ok) {
      res.status(400).json({ error: `Connection failed: ${v.error}` });
      return;
    }
    const r = await sendMail(
      { to, subject: 'Verdesakay — test email', text: 'This is a test message from your Verdesakay system. Email is working.' },
      req.user!.id
    );
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    next(e);
  }
});

// POST /api/mail/send — send an email (used by the Email drawer and the AI tool's route peer)
router.post('/send', requirePermission('mail.send'), syncClass('online'), async (req, res, next) => {
  try {
    const { to, subject, body } = parseBody(sendMailSchema, req.body);
    const r = await sendMail({ to, subject, text: body }, req.user!.id);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    next(e);
  }
});

// GET /api/mail/log — recent sends
router.get('/log', configGate, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(mailLog(limit, offset));
});

export default router;
