import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const root = new URL('../web-console/', import.meta.url);
const source = (file: string) => fs.readFileSync(new URL(file, root), 'utf8');

it('configures tenant SMTP and reuses the existing manual billing form for a one-time fee', async () => {
  const dom = new JSDOM(source('index.html'), { runScripts: 'outside-only', url: 'https://example.com/_platform/' });
  const w = dom.window;
  const tenant = { slug: 'acme', name: 'Acme', status: 'active', plan: 'complete', modules: { effective: ['email'], override: null, plan_default: ['email'] }, photo_retention: {}, owner: null, log: [] };
  const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, opts: { method?: string; body?: string }) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    let data: unknown = {};
    if (url.endsWith('/me')) data = { user: { username: 'operator' } };
    else if (url.endsWith('/bootstrap')) data = { plan_modules: { complete: ['email'] }, module_deps: {}, plans: ['complete'], statuses: ['active'], modules: ['email'] };
    else if (url.endsWith('/tenants')) data = [tenant];
    else if (url.endsWith('/tenants/acme')) data = tenant;
    else if (url.endsWith('/analytics')) return new Promise(() => {});
    else if (url.endsWith('/mail') && opts.method === 'GET') data = { transport: 'smtp', smtp_host: 'smtp.example.test', smtp_port: 587, has_password: true, ready: true };
    else if (url.endsWith('/billing/settings')) data = { kinds: ['subscription', 'implementation', 'other'], default_ewt_rate: 2 };
    else if (url.includes('/billing/invoices')) data = [];
    else if (url.endsWith('/invoices')) data = { id: 1, reference: 'INV-1', tenant_slug: 'acme', payments: [], status: 'open', amount: 1250, balance: 1250, vat_rate: 0, ewt_rate: 2, ewt: 25, net_if_withheld: 1225, paid_total: 0 };
    return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => data };
  });
  w.fetch = fetch as unknown as typeof w.fetch;
  w.localStorage.setItem('vds_platform_token', 'operator-token');
  const input = (id: string) => w.document.getElementById(id) as HTMLInputElement;
  const click = (label: string) => [...w.document.querySelectorAll<HTMLButtonElement>('#settings-panel button')].find(b => b.textContent === label)!.click();
  try {
    w.eval(source('app.js')); w.eval(source('billing.js'));
    await vi.waitFor(() => expect(w.document.querySelector('[data-tab="settings"]')).not.toBeNull());
    (w.document.querySelector('[data-tab="settings"]') as HTMLElement).click();
    await vi.waitFor(() => expect(input('smtp-smtp_pass')).not.toBeNull());
    expect(w.document.querySelector('a[href="/_platform/email-setup.html"]')).not.toBeNull();
    click('Save email settings');
    await vi.waitFor(() => expect([...w.document.querySelectorAll<HTMLButtonElement>('#settings-panel button')].find(b => b.textContent === 'Save email settings')!.disabled).toBe(false));
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body).not.toHaveProperty('smtp_pass');
    input('smtp-smtp_pass').value = 'new-secret'; click('Save email settings');
    await vi.waitFor(() => expect(input('smtp-smtp_pass').value).toBe(''));
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body!.smtp_pass).toBe('new-secret');
    input('smtp-clear').checked = true; click('Save email settings');
    await vi.waitFor(() => expect(input('smtp-clear').checked).toBe(false));
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body!.smtp_pass).toBe('');
    input('smtp-test_to').value = 'test@example.test'; click('Save & send test');
    await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/mail/test'))).toBe(true));
    expect(w.document.querySelector('#settings-panel')!.textContent).toContain('Confirm it arrives');
    input('smtp-invoice').click();
    await vi.waitFor(() => expect(input('ni-kind')).not.toBeNull());
    expect(input('ni-kind').value).toBe('implementation');
    expect(input('ni-desc').value).toBe('One-time assisted SMTP setup');
    expect(input('ni-amount').value).toBe('');
    expect(input('ni-ps').value).toBe('');
    expect(input('ni-pe').value).toBe('');
    expect(calls.some(c => c.url.includes('setup-invoices'))).toBe(false);
    input('ni-amount').value = '1250'; input('ni-go').click();
    await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/tenants/acme/invoices'))).toBe(true));
    expect(calls.find(c => c.url.endsWith('/tenants/acme/invoices'))!.body).toMatchObject({ kind: 'implementation', amount: '1250', description: 'One-time assisted SMTP setup', period_start: '', period_end: '' });
    await vi.waitFor(() => expect(w.document.getElementById('drawer')).not.toBeNull());
    expect(w.document.getElementById('ni-go')).toBeNull();
  } finally { w.close(); }
});

it('shows the local setup guide to tenants in the Email drawer and settings', async () => {
  const dom = new JSDOM('<button class="rail-btn" data-tool="email"></button>', { runScripts: 'outside-only', url: 'https://example.com/acme' });
  const w = dom.window;
  try {
    w.eval(`window.App = { hasPermission: () => true }; window.API = { get: async () => ({ transport: 'off' }) };
      window.UI = { icon: () => '', esc: s => s, drawer: o => { window.drawerOptions = o; }, modal: o => { window.modalOptions = o; } };`);
    w.eval(fs.readFileSync(new URL('../public/js/tools.js', import.meta.url), 'utf8'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    (w.document.querySelector('[data-tool="email"]') as HTMLElement).click();
    expect(w.drawerOptions.footHTML).toContain('/email-setup.html');
    const el = w.document.createElement('div'); el.innerHTML = w.drawerOptions.footHTML;
    w.drawerOptions.onOpen(el); (el.querySelector('#em-config') as HTMLElement).click();
    await vi.waitFor(() => expect(w.modalOptions).toBeDefined());
    expect(w.modalOptions.bodyHTML).toContain('/email-setup.html');
  } finally { w.close(); }
});
