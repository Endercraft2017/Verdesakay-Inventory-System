import {PasswordWorkBusyError} from '../shared/password-work';
import {prepareInquiryReceipt,saveInquiryReceipt} from './inquiry-receipts';
/**
 * Public "Talk to us" form on the website (POST /site/inquiry), mounted in src/app.ts. Only the
 * cloud's public site host answers it (TENANT_PATH_HOST); anywhere else it 404s. Rate-limited per
 * IP, with a hidden `website` field that only bots fill in. The owner reads these in the console
 * (inquiries-console.routes.ts). See docs/SAAS-READINESS.md §12.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { onTenantPathHost } from './tenant-path';
import { createInquiry } from './inquiries';
import { MODULES } from '../shared/modules';
import { rateLimitKey } from '../shared/device';
import { prepareOwnerAlerts, enqueueOwnerAlert } from './owner-alert-outbox';
import { forwardControlPlaneError } from './request-errors';

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false, keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many messages from this connection. Please try again later, or contact us directly.' },
});

const text = (max: number) => z.string().trim().max(max);
const schema = z.object({
  name: text(120).min(1, 'Enter your name.'),
  company: text(160).min(1, 'Enter your company name.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  phone: text(40).regex(/^[+\d\s()-]*$/, 'Enter a valid phone number.').optional(),
  employees: z.enum(['1-20', '21-50', '51-100', '101-200', '201+', '']).optional(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).optional(),
  message: text(2000).optional(),
  website: z.string().optional(), // honeypot: people never see it, bots fill it in
});

router.post('/', limiter, async (req, res, next) => {
  if (!onTenantPathHost(req.headers.host)) { res.status(404).json({ error: 'Not found' }); return; }
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the form and try again.' });
    return;
  }
  res.set('Cache-Control','no-store');
  const b = parsed.data;
  // A bot filled the hidden field: answer like a success so it learns nothing, store nothing.
  if (b.website) { res.status(201).json({ ok: true }); return; }
  try {
    const input={ name: b.name, company: b.company, email: b.email, phone: b.phone || null,
      employees: b.employees || null, modules: b.modules, message: b.message || null };
    const receipt=await prepareInquiryReceipt(req.get('Idempotency-Key'),input);
    if(receipt?.replay){res.set('Idempotency-Replayed','true').status(201).json({ok:true});return;}
    prepareOwnerAlerts();
    createInquiry(input, inquiry => {
    enqueueOwnerAlert('inquiry', inquiry.id, '', `New inquiry: ${b.company}`, [
      `${b.name} from ${b.company} sent the "Talk to us" form.`, '',
      `Email: ${b.email}`, b.phone ? `Mobile: ${b.phone}` : '', b.employees ? `Employees: ${b.employees}` : '',
      b.modules?.length ? `Interested in: ${b.modules.join(', ')}` : '', b.message ? `\nMessage:\n${b.message}` : '',
    ]);
    saveInquiryReceipt(receipt,inquiry.id);
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    if(error instanceof PasswordWorkBusyError){res.set('Retry-After','5').status(503).json({error:'Inquiry processing is busy. Try again shortly.'});return;}
    forwardControlPlaneError(error, next);
  }
});

export default router;
