/**
 * The operator's side of workspace billing (docs/SAAS-READINESS.md §12). Mounted inside the owner
 * console router (platform.routes.ts) after `requirePlatformAuth`, so it inherits the console's
 * apex-host-only rule and operator auth. Issue invoices, review the transfers customers report,
 * record payments seen directly, void, and keep the bank details customers are shown.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { MODULES } from '../shared/modules';
import {
  createInvoice, listInvoices, getInvoice, getPayment, invoiceView, voidInvoice, confirmPayment,
  rejectPayment, recordPayment, setBirInvoiceNo, getBillingSettings, setBillingSettings,
  resolveBillingFile, fileType, toCentavos, BillingError, INVOICE_KINDS, setGcashQr, BILLING_FILE_MAX_BYTES,
  type InvoiceKind,
} from './billing';
import type { PlatformAuthedRequest } from './platform-users';

const router = Router();

const operator = (req: Request) => (req as PlatformAuthedRequest).platformUser?.username || 'operator';

/** Run a handler, turning a BillingError into its HTTP status. */
const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: (e?: unknown) => void) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof BillingError) { res.status(e.status).json({ error: e.message }); return; }
    next(e);
  }
};

// GET /_platform/api/billing/settings
router.get('/billing/settings', (_req, res) => {
  res.json({ ...getBillingSettings(), kinds: INVOICE_KINDS, modules: MODULES });
});

// PUT /_platform/api/billing/settings — { bank_details?, gcash_name?, gcash_number?, module_prices?,
// seat_price?, reference_prefix?, vat_registered?, default_ewt_rate? }
router.put('/billing/settings', handle((req, res) => {
  const b = req.body || {};
  const patch: Parameters<typeof setBillingSettings>[0] = {};
  if (typeof b.bank_details === 'string') patch.bank_details = b.bank_details.trim();
  if (typeof b.gcash_name === 'string') patch.gcash_name = b.gcash_name.trim();
  if (typeof b.gcash_number === 'string') {
    const n = b.gcash_number.replace(/[\s-]/g, '');
    if (n && !/^(\+?63|0)9\d{9}$/.test(n)) throw new BillingError('Enter the GCash number as 09XXXXXXXXX.');
    patch.gcash_number = n;
  }
  const money = (v: unknown, field: string): number | null => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new BillingError(`${field} must be a peso amount.`);
    return Math.round(n * 100) / 100;
  };
  if (b.module_prices !== undefined) {
    if (!b.module_prices || typeof b.module_prices !== 'object' || Array.isArray(b.module_prices)) throw new BillingError('module_prices must be an object.');
    const out: Record<string, number> = {};
    for (const [m, v] of Object.entries(b.module_prices as Record<string, unknown>)) {
      if (!(MODULES as readonly string[]).includes(m)) throw new BillingError(`Unknown module "${m}".`);
      const n = money(v, `The ${m} price`);
      if (n !== null) out[m] = n;
    }
    patch.module_prices = out;
  }
  if (b.seat_price !== undefined) patch.seat_price = money(b.seat_price, 'The seat price');
  if (typeof b.reference_prefix === 'string') {
    const p = b.reference_prefix.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(p)) throw new BillingError('The reference prefix is 1–10 letters or digits.');
    patch.reference_prefix = p;
  }
  if (typeof b.vat_registered === 'boolean') patch.vat_registered = b.vat_registered;
  if (b.default_ewt_rate !== undefined) {
    const r = Number(b.default_ewt_rate);
    if (!Number.isFinite(r) || r < 0 || r > 15) throw new BillingError('The EWT rate is a percentage from 0 to 15.');
    patch.default_ewt_rate = r;
  }
  res.json(setBillingSettings(patch));
}));

// POST /_platform/api/billing/settings/gcash-qr — multipart { qr: <image> }; DELETE removes it.
const qrUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: BILLING_FILE_MAX_BYTES, files: 1 } }).single('qr');
router.post('/billing/settings/gcash-qr', qrUpload, handle((req, res) => {
  const f = req.file;
  if (!f) throw new BillingError('Choose the QR code image.');
  res.json(setGcashQr({ buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype }));
}));
router.delete('/billing/settings/gcash-qr', handle((_req, res) => { res.json(setGcashQr(null)); }));
router.get('/billing/settings/gcash-qr', (_req, res) => {
  const name = getBillingSettings().gcash_qr;
  const file = name ? resolveBillingFile('_settings', name) : null;
  if (!file) { res.status(404).json({ error: 'Not found' }); return; }
  res.type(fileType(name)).sendFile(file);
});

// GET /_platform/api/billing/invoices?slug=&status=
router.get('/billing/invoices', (req, res) => {
  const slug = typeof req.query.slug === 'string' && req.query.slug ? req.query.slug : undefined;
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  res.json(listInvoices({ slug, status }).map((i) => invoiceView(i, { forOperator: true })));
});

// GET /_platform/api/billing/invoices/:id
router.get('/billing/invoices/:id', (req, res) => {
  const inv = getInvoice(Number(req.params.id));
  if (!inv) { res.status(404).json({ error: 'Invoice not found.' }); return; }
  res.json(invoiceView(inv, { forOperator: true }));
});

// POST /_platform/api/tenants/:slug/invoices — { kind, description, amount, due_on, period_start?, period_end?, ewt_rate? }
router.post('/tenants/:slug/invoices', handle((req, res) => {
  const b = req.body || {};
  const inv = createInvoice(String(req.params.slug), {
    kind: String(b.kind || '') as InvoiceKind,
    description: String(b.description || ''),
    amount_centavos: toCentavos(b.amount),
    due_on: String(b.due_on || ''),
    period_start: b.period_start ? String(b.period_start) : null,
    period_end: b.period_end ? String(b.period_end) : null,
    ewt_rate: b.ewt_rate === undefined || b.ewt_rate === '' ? undefined : Number(b.ewt_rate),
  }, operator(req));
  res.status(201).json(invoiceView(inv, { forOperator: true }));
}));

// POST /_platform/api/billing/invoices/:id/void — { reason }
router.post('/billing/invoices/:id/void', handle((req, res) => {
  const inv = voidInvoice(Number(req.params.id), operator(req), String(req.body?.reason || ''));
  res.json(invoiceView(inv, { forOperator: true }));
}));

// POST /_platform/api/billing/invoices/:id/record-payment — { amount, paid_on, reference_no?, note?, bir_invoice_no? }
router.post('/billing/invoices/:id/record-payment', handle((req, res) => {
  const b = req.body || {};
  const inv = recordPayment(Number(req.params.id), {
    amount_centavos: toCentavos(b.amount),
    paid_on: String(b.paid_on || ''),
    reference_no: b.reference_no ? String(b.reference_no) : undefined,
    note: b.note ? String(b.note) : undefined,
    bir_invoice_no: b.bir_invoice_no ? String(b.bir_invoice_no) : undefined,
  }, operator(req));
  res.json(invoiceView(inv, { forOperator: true }));
}));

// PATCH /_platform/api/billing/invoices/:id — { bir_invoice_no } (the number on the BIR invoice issued)
router.patch('/billing/invoices/:id', handle((req, res) => {
  const inv = getInvoice(Number(req.params.id));
  if (!inv) throw new BillingError('Invoice not found.', 404);
  if ('bir_invoice_no' in (req.body || {})) setBirInvoiceNo(inv.id, req.body.bir_invoice_no == null ? null : String(req.body.bir_invoice_no));
  res.json(invoiceView(getInvoice(inv.id)!, { forOperator: true }));
}));

// POST /_platform/api/billing/payments/:id/confirm — { bir_invoice_no?, note? }
router.post('/billing/payments/:id/confirm', handle((req, res) => {
  const b = req.body || {};
  const inv = confirmPayment(Number(req.params.id), operator(req), {
    bir_invoice_no: b.bir_invoice_no ? String(b.bir_invoice_no) : undefined,
    note: b.note ? String(b.note) : undefined,
  });
  res.json(invoiceView(inv, { forOperator: true }));
}));

// POST /_platform/api/billing/payments/:id/reject — { note }
router.post('/billing/payments/:id/reject', handle((req, res) => {
  const inv = rejectPayment(Number(req.params.id), operator(req), String(req.body?.note || ''));
  res.json(invoiceView(inv, { forOperator: true }));
}));

// GET /_platform/api/billing/payments/:id/files/:kind — the proof or the 2307 a customer uploaded.
router.get('/billing/payments/:id/files/:kind', (req, res) => {
  const p = getPayment(Number(req.params.id));
  const inv = p ? getInvoice(p.invoice_id) : null;
  const name = req.params.kind === 'proof' ? p?.proof_file : req.params.kind === 'form_2307' ? p?.form_2307_file : null;
  if (!p || !inv || !name) { res.status(404).json({ error: 'Not found' }); return; }
  const file = resolveBillingFile(inv.tenant_slug, name);
  if (!file) { res.status(404).json({ error: 'Not found' }); return; }
  res.type(fileType(name)).sendFile(file);
});

export default router;
