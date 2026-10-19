/**
 * The customer's side of workspace billing (docs/SAAS-READINESS.md §12), mounted at
 * `/api/tenant/billing`: a workspace admin sees our invoices and how to pay (bank, GCash), and
 * reports a bank transfer or GCash payment with its proof (and the BIR 2307 if they withheld). An operator confirms it in the
 * owner console (billing-console.routes.ts). Allowed while the workspace is past due (src/app.ts),
 * since paying is how they get out of it. The single-tenant `default` install has no billing.
 */
import { Router, type Request } from 'express';
import multer from 'multer';
import { requireAuth, requirePermission } from '../shared/auth';
import { keepRequestContext } from '../shared/request-context';
import { syncClass } from '../sync';
import { DEFAULT_TENANT } from '../shared/db';
import { currentSlug } from './quota';
import { getTenant } from './platform';
import { prepareOwnerAlerts, enqueueOwnerAlert } from './owner-alert-outbox';
import { forwardControlPlaneError } from './request-errors';
import {
  listInvoices, getInvoice, getPayment, invoiceView, getBillingSettings, submitPayment, paymentInstructions,
  resolveBillingFile, fileType, toCentavos, BillingError, BILLING_FILE_MAX_BYTES, type UploadedFile,
} from './billing';

const router = Router();
router.use(requireAuth, requirePermission('users.manage'));

const upload = keepRequestContext(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BILLING_FILE_MAX_BYTES, files: 2, fields: 10 },
}).fields([{ name: 'proof', maxCount: 1 }, { name: 'form_2307', maxCount: 1 }]));

// GET /api/tenant/billing — this workspace's invoices + how to pay by bank transfer.
router.get('/', (_req, res) => {
  const slug = currentSlug();
  if (slug === DEFAULT_TENANT) { res.json({ enabled: false, bank_details: '', gcash: null, awaiting_payment: false, invoices: [] }); return; }
  res.json({
    enabled: true,
    ...paymentInstructions(),
    awaiting_payment: !!getTenant(slug)?.awaiting_payment,
    invoices: listInvoices({ slug }).map((i) => invoiceView(i)),
  });
});

// GET /api/tenant/billing/gcash-qr — the GCash QR image customers scan to pay.
router.get('/gcash-qr', (_req, res) => {
  const name = getBillingSettings().gcash_qr;
  const file = name ? resolveBillingFile('_settings', name) : null;
  if (!file) { res.status(404).json({ error: 'Not found' }); return; }
  res.type(fileType(name)).sendFile(file);
});

// POST /api/tenant/billing/invoices/:id/payments — multipart
// { channel: 'bank'|'gcash', reference_no, amount, paid_on, note?, proof: <file>, form_2307?: <file> }
router.post('/invoices/:id/payments', syncClass('online'), upload, (req: Request, res, next) => {
  const slug = currentSlug();
  if (slug === DEFAULT_TENANT) { res.status(404).json({ error: 'Billing is not used on this installation.' }); return; }
  const files = (req.files || {}) as Record<string, Express.Multer.File[] | undefined>;
  const asUpload = (f?: Express.Multer.File): UploadedFile | null =>
    f ? { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype } : null;
  try {
    const b = req.body || {};
    prepareOwnerAlerts();
    let view: ReturnType<typeof invoiceView> | undefined;
    submitPayment(slug, Number(req.params.id), {
      channel: String(b.channel || 'bank'),
      reference_no: String(b.reference_no || ''),
      amount_centavos: toCentavos(b.amount),
      paid_on: String(b.paid_on || ''),
      note: b.note ? String(b.note) : undefined,
      proof: asUpload(files.proof?.[0]),
      form_2307: asUpload(files.form_2307?.[0]),
    }, req.user!.username, (payment, invoice) => {
      const inv = invoiceView(invoice);
      const channel = payment.method === 'gcash' ? 'GCash' : 'bank transfer';
      enqueueOwnerAlert('payment', payment.id, slug, `Payment to check: ${slug} ${inv.reference}`, [
        `${getTenant(slug)?.name || slug} reported a ${channel} for invoice ${inv.reference}.`, '',
        `Amount: ₱${(payment.amount_centavos / 100).toFixed(2)}`, `Reference no.: ${payment.reference_no || ''}`, `Paid on: ${payment.paid_on || ''}`,
        `Check it in your ${channel === 'GCash' ? 'GCash history' : 'bank app'}, then confirm or reject it in Billing.`,
      ]);
      view = inv;
    });
    res.status(201).json(view);
  } catch (e) {
    if (e instanceof BillingError) { res.status(e.status).json({ error: e.message }); return; }
    forwardControlPlaneError(e, next);
  }
});

// GET /api/tenant/billing/payments/:id/files/:kind — the customer's own uploaded proof / 2307.
router.get('/payments/:id/files/:kind', (req, res) => {
  const slug = currentSlug();
  const p = getPayment(Number(req.params.id));
  const inv = p ? getInvoice(p.invoice_id) : null;
  const name = req.params.kind === 'proof' ? p?.proof_file : req.params.kind === 'form_2307' ? p?.form_2307_file : null;
  if (!p || !inv || inv.tenant_slug !== slug || !name) { res.status(404).json({ error: 'Not found' }); return; }
  const file = resolveBillingFile(slug, name);
  if (!file) { res.status(404).json({ error: 'Not found' }); return; }
  res.type(fileType(name)).sendFile(file);
});

export default router;
