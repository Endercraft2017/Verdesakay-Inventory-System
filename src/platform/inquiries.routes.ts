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

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
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

router.post('/', limiter, (req, res) => {
  if (!onTenantPathHost(req.headers.host)) { res.status(404).json({ error: 'Not found' }); return; }
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the form and try again.' });
    return;
  }
  const b = parsed.data;
  // A bot filled the hidden field: answer like a success so it learns nothing, store nothing.
  if (b.website) { res.status(201).json({ ok: true }); return; }
  createInquiry({ name: b.name, company: b.company, email: b.email, phone: b.phone || null,
    employees: b.employees || null, modules: b.modules, message: b.message || null });
  res.status(201).json({ ok: true });
});

export default router;
