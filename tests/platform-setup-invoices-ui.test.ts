import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const root = path.join(import.meta.dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
it('records manual invoices and requires separate payment and service actions in the console', async () => {
  const dom = new JSDOM(source('web-console/index.html'), { runScripts: 'outside-only', url: 'https://example.com/_platform' });
  const w = dom.window;
  const calls: { method: string; route: string; body?: Record<string, unknown> }[] = [];
  const tenant = { slug: 'acme', name: 'Acme', status: 'active', plan: 'complete', modules: { effective: ['email'], override: null, plan_default: ['email'] }, photo_retention: {}, log: [] };
  let rows: Record<string, unknown>[] = [];
  w.localStorage.setItem('vds_platform_token', 'token');
  w.fetch = async (url, init = {}) => {
    const route = String(url).replace('/_platform/api', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, route, body });
    let data: unknown = {};
    if (route === '/me') data = { user: { username: 'owner' } };
    else if (route === '/bootstrap') data = { plans: ['complete'], statuses: ['active'], modules: ['email'], module_deps: {}, setup_currencies: ['PHP', 'USD'] };
    else if (route === '/tenants') data = [tenant];
    else if (route === '/tenants/acme') data = tenant;
    else if (route === '/tenants/acme/mail') data = { transport: 'off' };
    else if (route === '/tenants/acme/setup-invoices') {
      if (method === 'POST') {
        rows = [{ ...body, id: 1, amount_minor: 125050, status: 'issued', service_status: 'pending', version: 1 }];
        data = rows[0];
      } else data = rows;
    } else if (route === '/tenants/acme/setup-invoices/1') {
      if (body.action === 'paid') rows[0] = { ...rows[0], status: 'paid', paid_on: body.paid_on, payment_reference: body.payment_reference, version: 2 };
      else rows[0] = { ...rows[0], service_status: 'completed', version: 3 };
      data = rows[0];
    }
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  const set = (id: string, value: string) => { (w.document.getElementById(id) as HTMLInputElement).value = value; };
  const click = (label: string) => [...w.document.querySelectorAll<HTMLButtonElement>('#setup-invoices button')].find(b => b.textContent === label)!.click();
  try {
    w.eval(source('web-console/app.js')); await flush();
    w.document.querySelector<HTMLTableRowElement>('#rows tr')!.click(); await flush();
    expect(w.document.querySelector('#setup-invoices')!.textContent).toContain('does not issue tax invoices');
    expect((w.document.getElementById('invoice-currency') as HTMLSelectElement).value).toBe('');
    set('invoice-number', '<script>alert(1)</script>'); set('invoice-amount', '1250.50'); set('invoice-currency', 'PHP');
    set('invoice-issued', '2026-10-15'); set('invoice-due', '2026-10-30');
    click('Record issued invoice'); await flush();
    expect(calls.find(c => c.method === 'POST')!.body).toMatchObject({ amount: '1250.50', currency: 'PHP' });
    expect(w.document.querySelector('#invoice-list script')).toBeNull();
    expect(w.document.querySelector('#invoice-list')!.textContent).toContain('PHP 1250.50');
    click('Record payment'); await flush();
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    set('paid-on-1', '2026-10-15'); set('paid-ref-1', 'BANK-REF');
    click('Record payment'); await flush();
    expect(calls.filter(c => c.method === 'PATCH').at(-1)!.body).toEqual({ version: 1, action: 'paid', paid_on: '2026-10-15', payment_reference: 'BANK-REF' });
    expect(w.document.querySelector('#invoice-list')!.textContent).toContain('Service: pending');
    click('Mark setup completed'); await flush();
    expect(calls.filter(c => c.method === 'PATCH').at(-1)!.body).toEqual({ version: 2, action: 'complete' });
    expect(w.document.querySelector('#invoice-list')!.textContent).toContain('Service: completed');
    expect(w.document.querySelector('#invoice-list')!.textContent).not.toContain('Void unpaid invoice');
  } finally { w.close(); }
});
