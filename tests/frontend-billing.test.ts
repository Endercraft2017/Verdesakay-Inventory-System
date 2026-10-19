/** Desktop Billing view (public/js/modules/core/billing.js): loads the real ui.js and the view into
    jsdom with a stubbed App/API, then checks the bank-transfer instructions, the invoice table's
    states, and that "Report payment" refuses to send without a receipt and posts the form with one. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
const SRC = fs.readFileSync(path.join(PUBLIC, 'js', 'modules', 'core', 'billing.js'), 'utf8');

const INVOICE = {
  id: 7, tenant_slug: 'acme', reference: 'INV-2026-0007', kind: 'subscription', description: 'Growth plan — October',
  period_start: null, period_end: null, amount: 25000, vat_rate: 0, vat: 0, ewt_rate: 2, ewt: 500,
  net_if_withheld: 24500, paid_total: 0, balance: 24500, status: 'open', overdue: false,
  issued_on: '2026-10-01', due_on: '2026-10-16', paid_at: null, bir_invoice_no: null, void_reason: null, payments: [],
};

function boot(billing: unknown) {
  const dom = new JSDOM('<!doctype html><html><body><div id="view"></div><div id="modal-root"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://localhost/' });
  const win = dom.window as unknown as Record<string, any>;
  const routes: Record<string, (view: HTMLElement) => Promise<void>> = {};
  const uploads: Array<[string, FormData, {idempotencyKey:string}]> = [];
  win.App = { register: (n: string, fn: (v: HTMLElement) => Promise<void>) => { routes[n] = fn; }, hasPermission: () => true };
  win.API = {
    get: () => Promise.resolve(billing),
    upload: (p: string, fd: FormData, opts: {idempotencyKey:string}) => { uploads.push([p, fd, opts]); return Promise.resolve({}); },
    blobUrl: () => Promise.resolve('blob:x'),
  };
  win.eval(`${UI_SRC}\nwindow.__UI = UI;\n${SRC}`);
  win.__UI.toast = () => {};
  return { win, view: win.document.getElementById('view') as HTMLElement, routes, uploads };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('desktop Billing view', () => {
  it('shows the bank details, the invoice and its withholding amount', async () => {
    const { view, routes } = boot({ enabled: true, bank_details: 'BPI · Our Co · 1234', invoices: [INVOICE, { ...INVOICE, id: 8, reference: 'INV-2026-0008', status: 'paid', balance: 0 }] });
    await routes.billing!(view);
    expect(view.textContent).toContain('BPI · Our Co · 1234');
    const rows = view.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('₱24,500.00');
    expect(rows[0]!.textContent).toContain('Unpaid');
    expect(rows[0]!.querySelector('[data-pay]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain('Paid');
    expect(rows[1]!.querySelector('[data-pay]')).toBeNull(); // nothing to report on a paid invoice
  });

  it('a transfer awaiting our check cannot be reported twice', async () => {
    const { view, routes } = boot({ enabled: true, bank_details: 'BPI', invoices: [{ ...INVOICE, status: 'payment_submitted' }] });
    await routes.billing!(view);
    expect(view.textContent).toContain('Being verified');
    expect(view.querySelector('[data-pay]')).toBeNull();
  });

  it('marks an overdue invoice and explains a missing bank setup', async () => {
    const { view, routes } = boot({ enabled: true, bank_details: '', invoices: [{ ...INVOICE, overdue: true }] });
    await routes.billing!(view);
    expect(view.textContent).toContain('Overdue');
    expect(view.textContent).toContain('Payment details are not set yet');
  });

  it('says so when this installation has no billing', async () => {
    const { view, routes } = boot({ enabled: false, bank_details: '', invoices: [] });
    await routes.billing!(view);
    expect(view.textContent).toContain('No billing on this installation');
    expect(view.querySelector('table')).toBeNull();
  });

  it('will not send a report without a receipt, and posts one that has it', async () => {
    const { win, view, routes, uploads } = boot({ enabled: true, bank_details: 'BPI', invoices: [INVOICE] });
    await routes.billing!(view);
    (view.querySelector('[data-pay]') as HTMLElement).click();
    const modal = win.document.querySelector('.modal-overlay') as HTMLElement;
    expect(modal.textContent).toContain('Report payment — INV-2026-0007');
    expect((modal.querySelector('[data-f="amount"]') as HTMLInputElement).value).toBe('24500');

    (modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).value = 'IP-1001';
    (modal.querySelector('[data-confirm]') as HTMLElement).click();
    await flush();
    expect(modal.querySelector('[data-modal-error]')!.textContent).toContain('Attach the receipt screenshot');
    expect(uploads.length).toBe(0);

    const file = new win.File(['x'], 'receipt.png', { type: 'image/png' });
    Object.defineProperty(modal.querySelector('[data-f="proof"]'), 'files', { value: [file] });
    (modal.querySelector('[data-confirm]') as HTMLElement).click();
    await flush();
    expect(uploads.length).toBe(1);
    const [p, fd] = uploads[0]!;
    expect(p).toBe('/tenant/billing/invoices/7/payments');
    expect(fd.get('reference_no')).toBe('IP-1001');
    expect(fd.get('amount')).toBe('24500');
    expect((fd.get('proof') as File).name).toBe('receipt.png');
    expect(fd.get('form_2307')).toBeNull();
    expect(uploads[0]![2].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(fd.get('channel')).toBe('bank'); // only bank details are set, so bank is the one choice
  });

  it('shows GCash with its QR code and lets the customer report a GCash payment', async () => {
    const { win, view, routes, uploads } = boot({ enabled: true, bank_details: '', gcash: { name: 'Juan D.', number: '09171234567', has_qr: true }, invoices: [INVOICE] });
    await routes.billing!(view);
    await flush();
    expect(view.textContent).toContain('09171234567');
    expect((view.querySelector('#gcash-qr') as HTMLImageElement).src).toBe('blob:x');
    (view.querySelector('[data-pay]') as HTMLElement).click();
    const modal = win.document.querySelector('.modal-overlay') as HTMLElement;
    const channel = modal.querySelector('[data-f="channel"]') as HTMLSelectElement;
    expect([...channel.options].map((o) => o.value)).toEqual(['gcash']);
    (modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).value = '5012345678901';
    Object.defineProperty(modal.querySelector('[data-f="proof"]'), 'files', { value: [new win.File(['x'], 'g.png', { type: 'image/png' })] });
    (modal.querySelector('[data-confirm]') as HTMLElement).click();
    await flush();
    expect(uploads[0]![1].get('channel')).toBe('gcash');
  });

  it('preserves an uncertain submission and retries the same bytes/key while refusing edits', async () => {
    const { win, view, routes } = boot({ enabled: true, bank_details: 'BPI', invoices: [INVOICE] });
    const attempts: Array<{fd:FormData;key:string}> = [];
    win.API.upload = (_path:string,fd:FormData,opts:{idempotencyKey:string}) => { attempts.push({fd,key:opts.idempotencyKey});return Promise.reject(new Error('Network unavailable')); };
    await routes.billing!(view); (view.querySelector('[data-pay]') as HTMLElement).click();
    const modal=win.document.querySelector('.modal-overlay') as HTMLElement;
    (modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).value='Original reference';
    Object.defineProperty(modal.querySelector('[data-f="proof"]'),'files',{value:[new win.File(['proof'],'proof.png',{type:'image/png'})]});
    (modal.querySelector('[data-confirm]') as HTMLElement).click(); await flush();
    expect(modal.textContent).toContain('Report outcome is unconfirmed');
    expect((modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).disabled).toBe(true);
    (modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).value='Programmatic edit';
    (modal.querySelector('[data-confirm]') as HTMLElement).click(); await flush();
    expect(attempts).toHaveLength(2); expect(attempts[1]!.fd).toBe(attempts[0]!.fd);expect(attempts[1]!.key).toBe(attempts[0]!.key);
    expect(attempts[1]!.fd.get('reference_no')).toBe('Original reference');
  });

  it('allows correction after an explicit 400 without reusing the refused request key', async () => {
    const { win, view, routes } = boot({ enabled: true, bank_details: 'BPI', invoices: [INVOICE] });
    const keys:string[]=[];
    win.API.upload = (_path:string,_fd:FormData,opts:{idempotencyKey:string}) => {keys.push(opts.idempotencyKey);return Promise.reject(Object.assign(new Error('Upload refused'),{status:400}));};
    await routes.billing!(view);(view.querySelector('[data-pay]') as HTMLElement).click();const modal=win.document.querySelector('.modal-overlay') as HTMLElement;
    (modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).value='Reference';Object.defineProperty(modal.querySelector('[data-f="proof"]'),'files',{value:[new win.File(['x'],'proof.png',{type:'image/png'})]});
    (modal.querySelector('[data-confirm]') as HTMLElement).click();await flush();expect(modal.textContent).toContain('Upload refused');
    expect((modal.querySelector('[data-f="reference_no"]') as HTMLInputElement).disabled).toBe(false);
    (modal.querySelector('[data-confirm]') as HTMLElement).click();await flush();expect(keys).toHaveLength(2);expect(keys[1]).not.toBe(keys[0]);
  });

  it('a workspace awaiting its first payment is told it opens once paid', async () => {
    const { view, routes } = boot({ enabled: true, bank_details: 'BPI', awaiting_payment: true, invoices: [] });
    await routes.billing!(view);
    expect(view.textContent).toContain('Your workspace opens once your first payment is confirmed');
    expect(view.textContent).toContain('preparing your first invoice');
  });
});
