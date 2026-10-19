/** Completed payment-report receipts share the source transaction; never tenant sync. */
import { createHash } from 'node:crypto';
import { platformDb, getTenant } from './platform';
import { getPayment, getInvoice, type submitPayment } from './billing';
import { db } from '../shared/db';
import { hashPassword, verifyPassword } from '../shared/password-hash';
import { ControlPlaneError } from './request-errors';

type Input = Parameters<typeof submitPayment>[2];
export type PaymentReportReceipt = { slug: string; actor: number; keyHash: string; verifier: string; replay?: unknown };
type Row = { verifier: string|null; response: string|null; payment_id: number; expires_at: number };
const TTL = 24 * 60 * 60 * 1000;

export function prunePaymentReportReceipts(): void {
  // A permanent minimal tombstone refuses reapplication after the response is removed.
  platformDb().prepare(`UPDATE platform_payment_report_receipts SET verifier=NULL,response=NULL
    WHERE expires_at<=? AND response IS NOT NULL`).run(Date.now());
}

export function preparePaymentReportReceipt(slug: string, actor: number, key: string|undefined, invoiceId: number, input: Input): PaymentReportReceipt|null {
  if (key === undefined) return null; // Legacy clients have no request replay guarantee.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new ControlPlaneError(400,'Idempotency-Key must be a random UUID v4.');
  }
  // Old generic multipart receipts were not bound to bytes/permission gates. Never replay them
  // or silently repeat their action. Check exact and common UUID case variants, including raw legacy keys.
  for (const previous of new Set([key,key.toLowerCase(),key.toUpperCase()])) {
    const scoped = 'v2:' + createHash('sha256').update(JSON.stringify([actor,previous])).digest('hex');
    if (db.prepare('SELECT 1 FROM idempotency_keys WHERE key IN (?,?)').get(previous,scoped)) {
      throw new ControlPlaneError(409,'This report request predates the billing retry upgrade. Check Billing before reporting again.');
    }
  }
  prunePaymentReportReceipts();
  const attachment = (file: Input['proof']) => file ? [file.mimetype,createHash('sha256').update(file.buffer).digest('hex')] : null;
  // Fixed tuple avoids property-order differences; filenames/multipart boundaries do not affect intent.
  const digest = createHash('sha256').update(JSON.stringify([invoiceId,input.channel || 'bank',input.reference_no.trim(),input.amount_centavos,
    input.paid_on,input.note?.trim() || null,attachment(input.proof),attachment(input.form_2307 ?? null)])).digest('hex');
  const keyHash = createHash('sha256').update(key.toLowerCase()).digest('hex');
  const row = platformDb().prepare(`SELECT verifier,response,payment_id,expires_at FROM platform_payment_report_receipts
    WHERE tenant_slug=? AND actor_id=? AND key_hash=?`).get(slug,actor,keyHash) as Row|undefined;
  if (row) {
    if (!row.verifier || !row.response || row.expires_at<=Date.now()) throw new ControlPlaneError(409,'This report request has expired. Check Billing before reporting again.');
    if (!verifyPassword(digest,row.verifier)) throw new ControlPlaneError(409,'This report request was used with different details. Check Billing before reporting again.');
    const payment = getPayment(row.payment_id), tenant = getTenant(slug);
    const invoice = payment ? getInvoice(payment.invoice_id) : null;
    if (!tenant || tenant.status==='purged' || !invoice || invoice.tenant_slug!==slug || invoice.id!==invoiceId) {
      throw new ControlPlaneError(409,'The original payment report is no longer available. Contact support before reporting again.');
    }
    return {slug,actor,keyHash,verifier:row.verifier,replay:JSON.parse(row.response)};
  }
  // Slow salted binding avoids a cheap oracle for low-entropy private references/notes.
  return {slug,actor,keyHash,verifier:hashPassword(digest)};
}

/** Trusted synchronous callback inside submitPayment, after its response/intent are prepared. */
export function savePaymentReportReceipt(receipt: PaymentReportReceipt|null, paymentId: number, response: unknown): undefined {
  if (!receipt) return;
  const inserted = platformDb().prepare(`INSERT INTO platform_payment_report_receipts
    (tenant_slug,actor_id,key_hash,verifier,response,payment_id,expires_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(tenant_slug,actor_id,key_hash) DO NOTHING`).run(receipt.slug,receipt.actor,receipt.keyHash,receipt.verifier,JSON.stringify(response),paymentId,Date.now()+TTL);
  if (inserted.changes!==1) throw new ControlPlaneError(409,'Another request completed this report. Retry with the same details.');
}
