/**
 * The owner's side of website inquiries (docs/SAAS-READINESS.md §12), mounted inside the owner
 * console router (platform.routes.ts) after operator auth: list and follow up on "Talk to us"
 * messages, and keep the contact details the website shows beside the form.
 */
import { Router, type Request } from 'express';
import {
  listInquiries, getInquiry, updateInquiry, inquiryView, countNewInquiries,
  getSiteContact, setSiteContact, INQUIRY_STATUSES, type InquiryStatus,
} from './inquiries';
import { getTenant, logProvisioning } from './platform';
import type { PlatformAuthedRequest } from './platform-users';

const router = Router();
const operator = (req: Request) => (req as PlatformAuthedRequest).platformUser?.username || 'operator';

// GET /_platform/api/inquiries?status=
router.get('/inquiries', (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  res.json({ new_count: countNewInquiries(), statuses: INQUIRY_STATUSES, inquiries: listInquiries(status).map(inquiryView) });
});

// PATCH /_platform/api/inquiries/:id — { status?, notes?, tenant_slug? }
router.patch('/inquiries/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getInquiry(id)) { res.status(404).json({ error: 'Inquiry not found.' }); return; }
  const b = req.body || {};
  const patch: { status?: InquiryStatus; notes?: string | null; tenant_slug?: string | null } = {};
  if (b.status !== undefined) {
    if (!INQUIRY_STATUSES.includes(b.status)) { res.status(400).json({ error: `status must be one of ${INQUIRY_STATUSES.join(', ')}.` }); return; }
    patch.status = b.status;
  }
  if ('notes' in b) patch.notes = b.notes == null ? null : String(b.notes).slice(0, 4000);
  if ('tenant_slug' in b) {
    if (b.tenant_slug && !getTenant(String(b.tenant_slug))) { res.status(400).json({ error: 'Unknown workspace.' }); return; }
    patch.tenant_slug = b.tenant_slug ? String(b.tenant_slug) : null;
  }
  const r = updateInquiry(id, patch)!;
  if (patch.tenant_slug) logProvisioning(patch.tenant_slug, 'inquiry', `${operator(req)}: linked website inquiry #${id}`);
  res.json(inquiryView(r));
});

// GET|PUT /_platform/api/site/contact — { email?, phone?, messenger? } shown beside the website form
router.get('/site/contact', (_req, res) => { res.json(getSiteContact()); });
router.put('/site/contact', (req, res) => {
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.trim() : undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
  const phone = typeof b.phone === 'string' ? b.phone.trim() : undefined;
  if (phone && !/^[+\d\s()-]{6,40}$/.test(phone)) { res.status(400).json({ error: 'Enter a valid phone number.' }); return; }
  const messenger = typeof b.messenger === 'string' ? b.messenger.trim() : undefined;
  if (messenger && !/^https:\/\/(m\.me|www\.messenger\.com|www\.facebook\.com|facebook\.com)\//i.test(messenger)) {
    res.status(400).json({ error: 'The Messenger link starts with https://m.me/ (or your Facebook page link).' }); return;
  }
  res.json(setSiteContact({ email, phone, messenger }));
});

export default router;
