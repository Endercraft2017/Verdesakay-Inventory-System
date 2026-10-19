/**
 * Workspace billing (docs/SAAS-READINESS.md §12, phase a): invoices we issue to each tenant and
 * the payments against them. Lives in the control plane (`platform.db`), never in a tenant DB —
 * it is our ledger, not the customer's, so it does not sync to installed PCs and survives a purge.
 *
 * Payment paths: a **bank transfer or GCash payment** the customer reports (reference + proof +
 * optional BIR 2307) that an operator confirms, or a payment the operator records directly (a
 * check, a transfer seen on the bank app). PayMongo (phase b) will add a webhook-confirmed path.
 *
 * Self-serve sign-ups pay before they get in: signup.routes.ts creates the workspace with
 * `awaiting_payment` set and, when the price list below is complete, its first invoice. Confirming
 * that invoice opens the workspace. Workspaces an operator creates are never locked.
 *
 * Money is integer centavos. Buyers that are BIR Top Withholding Agents withhold EWT on the
 * amount net of VAT, so each invoice stores its VAT and EWT rates and exposes the net it expects.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { platformDb, getTenant, setTenantStatus, setAwaitingPayment, logProvisioning, PLATFORM_DB_PATH } from './platform';
import { MODULES, withDeps } from '../shared/modules';

export type InvoiceStatus = 'open' | 'payment_submitted' | 'paid' | 'void';
export type InvoiceKind = 'subscription' | 'implementation' | 'other';
export type PaymentStatus = 'pending' | 'confirmed' | 'rejected';
export type FileKind = 'proof' | 'form_2307';

export const INVOICE_KINDS: InvoiceKind[] = ['subscription', 'implementation', 'other'];
/** A confirmed total this close to the expected net (in centavos) settles the invoice. */
const SETTLE_TOLERANCE = 100;

export interface InvoiceRow {
  id: number;
  tenant_slug: string;
  reference: string;
  kind: InvoiceKind;
  description: string;
  period_start: string | null;
  period_end: string | null;
  amount_centavos: number;
  vat_rate: number;
  ewt_rate: number;
  status: InvoiceStatus;
  issued_on: string;
  due_on: string;
  paid_at: string | null;
  bir_invoice_no: string | null;
  void_reason: string | null;
  created_by: string;
  created_at: string;
}

export type PaymentMethod = 'bank' | 'gcash' | 'recorded';
export const CUSTOMER_CHANNELS = ['bank', 'gcash'] as const;

export interface PaymentRow {
  id: number;
  invoice_id: number;
  method: PaymentMethod;
  reference_no: string | null;
  amount_centavos: number;
  paid_on: string | null;
  proof_file: string | null;
  form_2307_file: string | null;
  note: string | null;
  status: PaymentStatus;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

const ready = new WeakSet<DatabaseSync>();
function db(): DatabaseSync {
  const d = platformDb();
  if (ready.has(d)) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS billing_invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_slug     TEXT NOT NULL,
      reference       TEXT NOT NULL UNIQUE,
      kind            TEXT NOT NULL CHECK (kind IN ('subscription','implementation','other')),
      description     TEXT NOT NULL,
      period_start    TEXT,
      period_end      TEXT,
      amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
      vat_rate        REAL NOT NULL DEFAULT 0,
      ewt_rate        REAL NOT NULL DEFAULT 2,
      status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','payment_submitted','paid','void')),
      issued_on       TEXT NOT NULL,
      due_on          TEXT NOT NULL,
      paid_at         TEXT,
      bir_invoice_no  TEXT,
      void_reason     TEXT,
      created_by      TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS billing_invoices_tenant ON billing_invoices (tenant_slug, status);
    CREATE TABLE IF NOT EXISTS billing_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id      INTEGER NOT NULL REFERENCES billing_invoices(id),
      method          TEXT NOT NULL CHECK (method IN ('bank','gcash','recorded')),
      reference_no    TEXT,
      amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
      paid_on         TEXT,
      proof_file      TEXT,
      form_2307_file  TEXT,
      note            TEXT,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
      submitted_by    TEXT NOT NULL,
      submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_by     TEXT,
      reviewed_at     TEXT,
      review_note     TEXT
    );
    CREATE INDEX IF NOT EXISTS billing_payments_invoice ON billing_payments (invoice_id);
    CREATE TABLE IF NOT EXISTS billing_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Backfill surviving proof files and the QR image from installations that stored
  // them only beside platform.db before the durable copy was introduced.
  const keep = d.prepare('INSERT OR IGNORE INTO platform_durable_files (slug, name, data, size_bytes) VALUES (?, ?, ?, ?)');
  const legacy = d.prepare(
    `SELECT i.tenant_slug AS slug, p.proof_file, p.form_2307_file
     FROM billing_payments p JOIN billing_invoices i ON i.id = p.invoice_id`
  ).all() as Array<{ slug: string; proof_file: string | null; form_2307_file: string | null }>;
  const qr = d.prepare("SELECT value FROM billing_settings WHERE key = 'gcash_qr'").get() as { value: string } | undefined;
  const references = legacy.flatMap((row) => [row.proof_file, row.form_2307_file]
    .filter((name): name is string => !!name).map((name) => ({ slug: row.slug, name })));
  if (qr?.value) references.push({ slug: '_settings', name: qr.value });
  for (const { slug, name } of references) {
    if (path.basename(name) !== name) continue;
    const file = path.join(billingFilesDir(slug), name);
    if (fs.existsSync(file)) { const bytes = fs.readFileSync(file); keep.run(slug, name, bytes, bytes.length); }
  }
  ready.add(d);
  return d;
}

/* ---------------- settings ---------------- */

export interface BillingSettings {
  /** Shown to customers on the bank-transfer option: bank, account name, number, branch. */
  bank_details: string;
  /** Shown to customers on the GCash option. Empty number = GCash not offered. */
  gcash_name: string;
  gcash_number: string;
  /** File name of the GCash QR image in billingFilesDir('_settings'), or '' for none. */
  gcash_qr: string;
  /** Monthly price list for self-serve sign-ups: pesos per module, and per login seat. A sign-up
   *  is invoiced automatically only when every chosen module has a price and the seat price is set. */
  module_prices: Partial<Record<string, number>>;
  seat_price: number | null;
  /** Invoice reference prefix: `<prefix>-<year>-<0001>`. */
  reference_prefix: string;
  /** Whether we charge 12% VAT — changes the EWT base (EWT is on the amount net of VAT). */
  vat_registered: boolean;
  /** Default EWT rate (percent) a new invoice expects the buyer to withhold. */
  default_ewt_rate: number;
}

const DEFAULTS: BillingSettings = {
  bank_details: '', gcash_name: '', gcash_number: '', gcash_qr: '', module_prices: {}, seat_price: null,
  reference_prefix: 'INV', vat_registered: false, default_ewt_rate: 2,
};

export function getBillingSettings(): BillingSettings {
  const rows = db().prepare('SELECT key, value FROM billing_settings').all() as unknown as Array<{ key: string; value: string }>;
  const out: BillingSettings = { ...DEFAULTS, module_prices: {} };
  for (const r of rows) {
    if (r.key === 'bank_details') out.bank_details = r.value;
    else if (r.key === 'gcash_name') out.gcash_name = r.value;
    else if (r.key === 'gcash_number') out.gcash_number = r.value;
    else if (r.key === 'gcash_qr') out.gcash_qr = r.value;
    else if (r.key === 'module_prices') { try { out.module_prices = JSON.parse(r.value) || {}; } catch { out.module_prices = {}; } }
    else if (r.key === 'seat_price') out.seat_price = r.value === '' ? null : Number(r.value);
    else if (r.key === 'reference_prefix') out.reference_prefix = r.value;
    else if (r.key === 'vat_registered') out.vat_registered = r.value === '1';
    else if (r.key === 'default_ewt_rate') out.default_ewt_rate = Number(r.value);
  }
  return out;
}

export function setBillingSettings(patch: Partial<BillingSettings>): BillingSettings {
  const put = db().prepare(
    'INSERT INTO billing_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  if (patch.bank_details !== undefined) put.run('bank_details', patch.bank_details);
  if (patch.gcash_name !== undefined) put.run('gcash_name', patch.gcash_name);
  if (patch.gcash_number !== undefined) put.run('gcash_number', patch.gcash_number);
  if (patch.gcash_qr !== undefined) put.run('gcash_qr', patch.gcash_qr);
  if (patch.module_prices !== undefined) put.run('module_prices', JSON.stringify(patch.module_prices));
  if (patch.seat_price !== undefined) put.run('seat_price', patch.seat_price === null ? '' : String(patch.seat_price));
  if (patch.reference_prefix !== undefined) put.run('reference_prefix', patch.reference_prefix);
  if (patch.vat_registered !== undefined) put.run('vat_registered', patch.vat_registered ? '1' : '0');
  if (patch.default_ewt_rate !== undefined) put.run('default_ewt_rate', String(patch.default_ewt_rate));
  return getBillingSettings();
}

/** What a signed-in customer is shown on how to pay (no operator-only settings). */
export function paymentInstructions(s = getBillingSettings()) {
  return {
    bank_details: s.bank_details,
    gcash: s.gcash_number ? { name: s.gcash_name, number: s.gcash_number, has_qr: !!s.gcash_qr } : null,
  };
}

/** Store (or, with null, remove) the GCash QR image customers scan. */
export function setGcashQr(f: UploadedFile | null): BillingSettings {
  const dir = billingFilesDir('_settings');
  const old = getBillingSettings().gcash_qr;
  const ext = f ? ALLOWED_TYPES[f.mimetype] : null;
  if (f && (!ext || ext === '.pdf')) throw new BillingError('Upload the QR code as a JPG, PNG or WebP image.');
  if (!f) {
    const settings = setBillingSettings({ gcash_qr: '' });
    if (old) {
      fs.rmSync(path.join(dir, old), { force: true });
      platformDb().prepare('DELETE FROM platform_durable_files WHERE slug = ? AND name = ?').run('_settings', old);
    }
    return settings;
  }
  fs.mkdirSync(dir, { recursive: true });
  const name = `gcash-qr-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(dir, name), f.buffer);
  keepBillingFile('_settings', name, f.buffer);
  const settings = setBillingSettings({ gcash_qr: name });
  if (old) {
    fs.rmSync(path.join(dir, old), { force: true });
    platformDb().prepare('DELETE FROM platform_durable_files WHERE slug = ? AND name = ?').run('_settings', old);
  }
  return settings;
}

/** The monthly total the price list gives for these modules and seats, or null when a chosen
 *  module (or the seat price) has no price yet. */
export function priceListQuote(modules: string[], seats: number, s = getBillingSettings()) {
  const mods = withDeps(modules.filter((m) => (MODULES as readonly string[]).includes(m)));
  const missing = mods.filter((m) => typeof s.module_prices[m] !== 'number');
  if (missing.length || s.seat_price === null) return { modules: mods, total_centavos: null as number | null, missing };
  const total = mods.reduce((sum, m) => sum + Math.round(s.module_prices[m]! * 100), 0)
    + seats * Math.round(s.seat_price * 100);
  return { modules: mods, total_centavos: total as number | null, missing };
}

/* ---------------- amounts ---------------- */

/** VAT, the EWT the buyer may withhold (on the amount net of VAT), and what they then pay. */
export function invoiceAmounts(inv: Pick<InvoiceRow, 'amount_centavos' | 'vat_rate' | 'ewt_rate'>) {
  const gross = inv.amount_centavos;
  const base = Math.round(gross / (1 + inv.vat_rate / 100));
  const vat = gross - base;
  const ewt = Math.round(base * inv.ewt_rate / 100);
  return { gross, vat, ewt, net: gross - ewt };
}

/* ---------------- invoices ---------------- */

export class BillingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);

export interface NewInvoice {
  kind: InvoiceKind;
  description: string;
  amount_centavos: number;
  due_on: string;
  period_start?: string | null;
  period_end?: string | null;
  ewt_rate?: number;
}

export function createInvoice(slug: string, input: NewInvoice, by: string): InvoiceRow {
  const t = getTenant(slug);
  if (!t || t.status === 'purged') throw new BillingError('Unknown workspace.', 404);
  if (!INVOICE_KINDS.includes(input.kind)) throw new BillingError(`kind must be one of ${INVOICE_KINDS.join(', ')}.`);
  const description = String(input.description || '').trim();
  if (!description) throw new BillingError('Enter a description.');
  if (!Number.isInteger(input.amount_centavos) || input.amount_centavos <= 0) throw new BillingError('Enter an amount above zero.');
  if (!isDate(input.due_on)) throw new BillingError('due_on must be a date (YYYY-MM-DD).');
  for (const k of ['period_start', 'period_end'] as const) {
    if (input[k] != null && input[k] !== '' && !isDate(input[k])) throw new BillingError(`${k} must be a date (YYYY-MM-DD).`);
  }
  const s = getBillingSettings();
  const ewt = input.ewt_rate ?? s.default_ewt_rate;
  if (typeof ewt !== 'number' || !Number.isFinite(ewt) || ewt < 0 || ewt > 15) throw new BillingError('ewt_rate must be a percentage from 0 to 15.');

  const d = db();
  d.exec('SAVEPOINT issue_invoice');
  try {
    // Acquire the writer before reading the sequence; also works inside signup publication.
    d.prepare('UPDATE billing_settings SET value = value WHERE key = ?').run('reference_prefix');
    const issued = today();
    const year = issued.slice(0, 4);
    const prefix = `${s.reference_prefix}-${year}-`;
    const last = d.prepare('SELECT reference FROM billing_invoices WHERE reference LIKE ? ORDER BY id DESC LIMIT 1')
      .get(`${prefix}%`) as { reference: string } | undefined;
    const seq = last ? Number(last.reference.slice(prefix.length)) + 1 : 1;
    const reference = `${prefix}${String(seq).padStart(4, '0')}`;
    const info = d.prepare(
      `INSERT INTO billing_invoices (tenant_slug, reference, kind, description, period_start, period_end,
         amount_centavos, vat_rate, ewt_rate, issued_on, due_on, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, reference, input.kind, description, input.period_start || null, input.period_end || null,
      input.amount_centavos, s.vat_registered ? 12 : 0, ewt, issued, input.due_on, by);
    logProvisioning(slug, 'billing', `${by}: issued ${reference}`);
    const invoice = getInvoice(Number(info.lastInsertRowid))!;
    d.exec('RELEASE issue_invoice');
    return invoice;
  } catch (e) {
    d.exec('ROLLBACK TO issue_invoice'); d.exec('RELEASE issue_invoice');
    throw e;
  }
}

export function getInvoice(id: number): InvoiceRow | null {
  return (db().prepare('SELECT * FROM billing_invoices WHERE id = ?').get(id) as unknown as InvoiceRow | undefined) ?? null;
}

export function listInvoices(filter: { slug?: string; status?: string } = {}): InvoiceRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.slug) { where.push('tenant_slug = ?'); args.push(filter.slug); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  return db().prepare(
    `SELECT * FROM billing_invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...args) as unknown as InvoiceRow[];
}

export function listPayments(invoiceId: number): PaymentRow[] {
  return db().prepare('SELECT * FROM billing_payments WHERE invoice_id = ? ORDER BY id').all(invoiceId) as unknown as PaymentRow[];
}

export function getPayment(id: number): PaymentRow | null {
  return (db().prepare('SELECT * FROM billing_payments WHERE id = ?').get(id) as unknown as PaymentRow | undefined) ?? null;
}

const peso = (c: number) => Math.round(c) / 100;

/** The JSON shape both the console and the tenant see (the tenant gets no operator notes). */
export function invoiceView(inv: InvoiceRow, opts: { forOperator?: boolean } = {}) {
  const a = invoiceAmounts(inv);
  const payments = listPayments(inv.id);
  const confirmed = payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount_centavos, 0);
  return {
    id: inv.id,
    tenant_slug: inv.tenant_slug,
    reference: inv.reference,
    kind: inv.kind,
    description: inv.description,
    period_start: inv.period_start,
    period_end: inv.period_end,
    amount: peso(a.gross),
    vat_rate: inv.vat_rate,
    vat: peso(a.vat),
    ewt_rate: inv.ewt_rate,
    ewt: peso(a.ewt),
    net_if_withheld: peso(a.net),
    paid_total: peso(confirmed),
    balance: peso(Math.max(0, a.net - confirmed)),
    status: inv.status,
    overdue: inv.status === 'open' && inv.due_on < today(),
    issued_on: inv.issued_on,
    due_on: inv.due_on,
    paid_at: inv.paid_at,
    bir_invoice_no: inv.bir_invoice_no,
    void_reason: inv.void_reason,
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      reference_no: p.reference_no,
      amount: peso(p.amount_centavos),
      paid_on: p.paid_on,
      has_proof: !!p.proof_file,
      has_2307: !!p.form_2307_file,
      note: p.note,
      status: p.status,
      submitted_by: p.submitted_by,
      submitted_at: p.submitted_at,
      reviewed_at: p.reviewed_at,
      review_note: p.review_note,
      ...(opts.forOperator ? { reviewed_by: p.reviewed_by } : {}),
    })),
    ...(opts.forOperator ? { created_by: inv.created_by } : {}),
  };
}

/** Open / overdue counts for one tenant — the workspace banner. */
export function tenantBillingSummary(slug: string): { open: number; overdue: number; submitted: number } {
  const rows = listInvoices({ slug });
  const t = today();
  return {
    open: rows.filter((r) => r.status === 'open').length,
    overdue: rows.filter((r) => r.status === 'open' && r.due_on < t).length,
    submitted: rows.filter((r) => r.status === 'payment_submitted').length,
  };
}

/** Re-derive an invoice's status from its payments after one is confirmed / rejected / added. */
function settle(invoiceId: number, by: string): InvoiceRow {
  const inv = getInvoice(invoiceId)!;
  if (inv.status === 'void' || inv.status === 'paid') return inv;
  const payments = listPayments(invoiceId);
  const confirmed = payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount_centavos, 0);
  const { net } = invoiceAmounts(inv);
  let status: InvoiceStatus;
  if (confirmed >= net - SETTLE_TOLERANCE) status = 'paid';
  else if (payments.some((p) => p.status === 'pending')) status = 'payment_submitted';
  else status = 'open';
  if (status === 'paid') {
    db().prepare(`UPDATE billing_invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(invoiceId);
    logProvisioning(inv.tenant_slug, 'billing', `${by}: ${inv.reference} paid`);
    // One-time service fees must never clear subscription arrears or signup locks.
    if (inv.kind === 'subscription') reactivate(inv.tenant_slug, by);
  } else if (status !== inv.status) {
    db().prepare('UPDATE billing_invoices SET status = ? WHERE id = ?').run(status, invoiceId);
  }
  return getInvoice(invoiceId)!;
}

/** Paying lifts a billing lock: a self-signed-up workspace opens, and a trial or past-due one
 *  becomes active. A suspension is an operator decision and is left alone. */
function reactivate(slug: string, by: string): void {
  const t = getTenant(slug);
  if (!t) return;
  if (t.awaiting_payment) {
    setAwaitingPayment(slug, false);
    logProvisioning(slug, 'update', `${by}: workspace opened (first payment confirmed)`);
  }
  if (t.status !== 'past_due' && t.status !== 'trial') return;
  setTenantStatus(slug, 'active');
  logProvisioning(slug, 'update', `${by}: status=active (invoice paid)`);
}

/* ---------------- payments ---------------- */

/** Where a tenant's proof files live: beside platform.db, outside every tenant's uploads. */
export function billingFilesDir(slug: string): string {
  return path.join(path.dirname(PLATFORM_DB_PATH), 'billing-files', slug);
}

function billingFileName(name: string): string {
  if (!name || path.basename(name) !== name || name.startsWith('.')) throw new BillingError('Invalid billing file name');
  return name;
}

function keepBillingFile(slug: string, name: string, bytes: Buffer): void {
  platformDb().prepare(
    `INSERT INTO platform_durable_files (slug, name, data, size_bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug, name) DO UPDATE SET data = excluded.data, size_bytes = excluded.size_bytes`
  ).run(slug, billingFileName(name), bytes, bytes.length);
}

export function resolveBillingFile(slug: string, name: string): string | null {
  const safe = billingFileName(name);
  const file = path.join(billingFilesDir(slug), safe);
  if (fs.existsSync(file)) return file;
  const row = platformDb().prepare('SELECT data FROM platform_durable_files WHERE slug = ? AND name = ?')
    .get(slug, safe) as { data: Uint8Array } | undefined;
  if (!row) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, Buffer.from(row.data), { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch { /* already moved */ } }
  return file;
}

export interface UploadedFile { buffer: Buffer; originalname: string; mimetype: string }

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf',
};
export const BILLING_FILE_MAX_BYTES = 10 * 1024 * 1024;

function saveFile(slug: string, paymentTag: string, kind: FileKind, f: UploadedFile): string {
  const ext = ALLOWED_TYPES[f.mimetype];
  if (!ext) throw new BillingError('Upload a JPG, PNG, WebP or PDF file.');
  const dir = billingFilesDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${paymentTag}-${kind}${ext}`;
  fs.writeFileSync(path.join(dir, name), f.buffer);
  keepBillingFile(slug, name, f.buffer);
  return name;
}

export function fileType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return Object.entries(ALLOWED_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
}

/** A customer reports a bank transfer or GCash payment. The invoice waits for an operator to confirm it. */
export function submitPayment(slug: string, invoiceId: number, input: {
  channel: string; reference_no: string; amount_centavos: number; paid_on: string; note?: string;
  proof: UploadedFile | null; form_2307?: UploadedFile | null;
}, by: string): PaymentRow {
  const channel = input.channel || 'bank';
  if (!(CUSTOMER_CHANNELS as readonly string[]).includes(channel)) throw new BillingError('Choose bank transfer or GCash.');
  const inv = getInvoice(invoiceId);
  if (!inv || inv.tenant_slug !== slug) throw new BillingError('Invoice not found.', 404);
  if (inv.status === 'paid' || inv.status === 'void') throw new BillingError(`This invoice is already ${inv.status}.`, 409);
  const reference = String(input.reference_no || '').trim();
  if (!reference) throw new BillingError(channel === 'gcash' ? 'Enter the GCash reference number.' : 'Enter the bank transfer reference number.');
  if (!Number.isInteger(input.amount_centavos) || input.amount_centavos <= 0) throw new BillingError('Enter the amount you transferred.');
  if (!isDate(input.paid_on) || input.paid_on > today()) throw new BillingError('Enter the date of the transfer.');
  if (!input.proof) throw new BillingError('Attach the transfer receipt or deposit slip.');

  const tag = `${inv.reference}-${Date.now().toString(36)}`;
  const proof = saveFile(slug, tag, 'proof', input.proof);
  const f2307 = input.form_2307 ? saveFile(slug, tag, 'form_2307', input.form_2307) : null;
  const info = db().prepare(
    `INSERT INTO billing_payments (invoice_id, method, reference_no, amount_centavos, paid_on, proof_file,
       form_2307_file, note, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(invoiceId, channel, reference, input.amount_centavos, input.paid_on, proof, f2307, input.note?.trim() || null, by);
  logProvisioning(slug, 'billing', `${by}: reported a ${channel === 'gcash' ? 'GCash payment' : 'transfer'} for ${inv.reference}`);
  settle(invoiceId, by);
  return getPayment(Number(info.lastInsertRowid))!;
}

export function confirmPayment(paymentId: number, by: string, opts: { bir_invoice_no?: string; note?: string } = {}): InvoiceRow {
  const p = getPayment(paymentId);
  if (!p) throw new BillingError('Payment not found.', 404);
  if (p.status !== 'pending') throw new BillingError(`This payment is already ${p.status}.`, 409);
  const inv = getInvoice(p.invoice_id)!;
  if (inv.status === 'void') throw new BillingError('This invoice is void.', 409);
  db().prepare(
    `UPDATE billing_payments SET status = 'confirmed', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
  ).run(by, opts.note?.trim() || null, paymentId);
  if (opts.bir_invoice_no?.trim()) setBirInvoiceNo(inv.id, opts.bir_invoice_no);
  logProvisioning(inv.tenant_slug, 'billing', `${by}: confirmed ${inv.reference} transfer ${p.reference_no ?? ''}`.trim());
  return settle(inv.id, by);
}

export function rejectPayment(paymentId: number, by: string, note: string): InvoiceRow {
  const p = getPayment(paymentId);
  if (!p) throw new BillingError('Payment not found.', 404);
  if (p.status !== 'pending') throw new BillingError(`This payment is already ${p.status}.`, 409);
  const why = String(note || '').trim();
  if (!why) throw new BillingError('Say why, so the customer knows what to fix.');
  db().prepare(
    `UPDATE billing_payments SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
  ).run(by, why, paymentId);
  const inv = getInvoice(p.invoice_id)!;
  logProvisioning(inv.tenant_slug, 'billing', `${by}: rejected ${inv.reference} transfer — ${why}`);
  return settle(inv.id, by);
}

/** The operator records a payment they saw themselves (a check, a transfer on the bank app). */
export function recordPayment(invoiceId: number, input: {
  amount_centavos: number; paid_on: string; reference_no?: string; note?: string; bir_invoice_no?: string;
}, by: string): InvoiceRow {
  const inv = getInvoice(invoiceId);
  if (!inv) throw new BillingError('Invoice not found.', 404);
  if (inv.status === 'paid' || inv.status === 'void') throw new BillingError(`This invoice is already ${inv.status}.`, 409);
  if (!Number.isInteger(input.amount_centavos) || input.amount_centavos <= 0) throw new BillingError('Enter the amount received.');
  if (!isDate(input.paid_on) || input.paid_on > today()) throw new BillingError('Enter the date it was received.');
  db().prepare(
    `INSERT INTO billing_payments (invoice_id, method, reference_no, amount_centavos, paid_on, note, status,
       submitted_by, reviewed_by, reviewed_at)
     VALUES (?, 'recorded', ?, ?, ?, ?, 'confirmed', ?, ?, datetime('now'))`
  ).run(invoiceId, input.reference_no?.trim() || null, input.amount_centavos, input.paid_on, input.note?.trim() || null, by, by);
  if (input.bir_invoice_no?.trim()) setBirInvoiceNo(invoiceId, input.bir_invoice_no);
  logProvisioning(inv.tenant_slug, 'billing', `${by}: recorded a payment on ${inv.reference}`);
  return settle(invoiceId, by);
}

/** The number on the BIR-registered invoice issued for this bill (from the company's own
 *  registered invoicing — this app does not print BIR invoices). */
export function setBirInvoiceNo(invoiceId: number, no: string | null): void {
  db().prepare('UPDATE billing_invoices SET bir_invoice_no = ? WHERE id = ?').run(no?.trim() || null, invoiceId);
}

export function voidInvoice(invoiceId: number, by: string, reason: string): InvoiceRow {
  const inv = getInvoice(invoiceId);
  if (!inv) throw new BillingError('Invoice not found.', 404);
  if (inv.status === 'paid') throw new BillingError('A paid invoice cannot be voided.', 409);
  if (inv.status === 'void') return inv;
  const why = String(reason || '').trim();
  if (!why) throw new BillingError('Enter a reason for voiding.');
  db().prepare(`UPDATE billing_invoices SET status = 'void', void_reason = ? WHERE id = ?`).run(why, invoiceId);
  logProvisioning(inv.tenant_slug, 'billing', `${by}: voided ${inv.reference} — ${why}`);
  return getInvoice(invoiceId)!;
}

/** Pesos from a client (number or numeric string) → integer centavos, or NaN. */
export function toCentavos(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
