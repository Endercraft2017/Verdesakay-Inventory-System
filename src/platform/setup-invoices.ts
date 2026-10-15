/** References to invoices issued manually by the operator, never tenant accounting entries. */
import { z } from 'zod';
import { platformDb, logProvisioning } from './platform';

export const SETUP_CURRENCIES = ['PHP', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'] as const;
export const setupInvoiceSchema = z.object({
  invoice_number: z.string().trim().min(1).max(80),
  // Accepted currencies have two decimal places. Avoid floating-point money storage.
  amount: z.string().trim().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/, 'Enter a positive amount with up to 2 decimal places')
    .refine(v => Number(v) > 0, 'Amount must be positive'),
  currency: z.enum(SETUP_CURRENCIES),
  issued_on: z.iso.date(),
  due_on: z.iso.date(),
}).strict().refine(v => v.due_on >= v.issued_on, 'Due date must be on or after issue date');

export const setupInvoiceActionSchema = z.object({
  version: z.number().int().positive(),
  action: z.enum(['paid', 'void', 'complete']),
  paid_on: z.iso.date().optional(),
  payment_reference: z.string().trim().min(1).max(200).optional(),
}).strict().refine(v => v.action !== 'paid' || (!!v.paid_on && !!v.payment_reference), 'Payment date and reference are required to record payment');

interface SetupInvoice {
  id: number; tenant_slug: string; invoice_number: string; amount_minor: number; currency: string;
  issued_on: string; due_on: string; status: 'issued' | 'paid' | 'void';
  service_status: 'pending' | 'completed'; paid_on: string | null; payment_reference: string | null;
  version: number; created_by: string; created_at: string; updated_at: string;
}
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function transaction<T>(fn: () => T): T {
  const db = platformDb();
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function listSetupInvoices(slug: string): SetupInvoice[] {
  return platformDb().prepare('SELECT * FROM setup_invoices WHERE tenant_slug = ? ORDER BY id DESC').all(slug) as unknown as SetupInvoice[];
}
export function createSetupInvoice(slug: string, input: z.infer<typeof setupInvoiceSchema>, by: string): SetupInvoice {
  return transaction(() => {
    const db = platformDb();
    if (db.prepare('SELECT id FROM setup_invoices WHERE invoice_number = ?').get(input.invoice_number)) {
      fail(409, 'Invoice number already recorded. Use the existing record or a distinct invoice number.');
    }
    const [whole, fraction = ''] = input.amount.split('.');
    const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const r = db.prepare(`INSERT INTO setup_invoices
      (tenant_slug, invoice_number, amount_minor, currency, issued_on, due_on, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(slug, input.invoice_number, amountMinor, input.currency, input.issued_on, input.due_on, by);
    logProvisioning(slug, 'setup-invoice-created', `${by}: invoice record ${r.lastInsertRowid}`);
    return db.prepare('SELECT * FROM setup_invoices WHERE id = ?').get(r.lastInsertRowid) as unknown as SetupInvoice;
  });
}
export function updateSetupInvoice(slug: string, id: number, input: z.infer<typeof setupInvoiceActionSchema>, by: string): SetupInvoice {
  return transaction(() => {
    const db = platformDb();
    const row = db.prepare('SELECT * FROM setup_invoices WHERE tenant_slug = ? AND id = ?').get(slug, id) as unknown as SetupInvoice | undefined;
    if (!row) fail(404, 'Invoice not found.');
    if (row.version !== input.version) fail(409, 'Invoice changed. Reload before updating.');
    if (row.status === 'void') fail(409, 'Voided invoices cannot be changed.');
    if (input.action === 'paid') {
      if (row.status !== 'issued') fail(409, 'Only an issued invoice can be marked paid.');
      if (input.paid_on! < row.issued_on) fail(400, 'Payment date must be on or after issue date.');
      db.prepare("UPDATE setup_invoices SET status = 'paid', paid_on = ?, payment_reference = ? WHERE id = ?")
        .run(input.paid_on!, input.payment_reference!, id);
    } else if (input.action === 'void') {
      if (row.status === 'paid') fail(409, 'Paid invoices cannot be voided. Handle refunds separately.');
      db.prepare("UPDATE setup_invoices SET status = 'void' WHERE id = ?").run(id);
    } else {
      if (row.service_status === 'completed') fail(409, 'Service is already completed.');
      db.prepare("UPDATE setup_invoices SET service_status = 'completed' WHERE id = ?").run(id);
    }
    db.prepare("UPDATE setup_invoices SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(id);
    logProvisioning(slug, 'setup-invoice-updated', `${by}: invoice record ${id}, ${input.action}`);
    return db.prepare('SELECT * FROM setup_invoices WHERE id = ?').get(id) as unknown as SetupInvoice;
  });
}
