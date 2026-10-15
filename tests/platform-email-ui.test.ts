import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const root = path.join(import.meta.dirname, '..');
const source = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

it('console saves secrets only when supplied, clears them explicitly, and tests saved settings', async () => {
  const dom = new JSDOM(source('web-console/index.html'), { runScripts: 'outside-only', url: 'https://example.com/_platform' });
  const w = dom.window;
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const tenant = { slug: 'acme', name: 'Acme', status: 'active', plan: 'complete', modules: { effective: ['email'], override: null, plan_default: ['email'] }, photo_retention: {}, log: [] };
  w.localStorage.setItem('vds_platform_token', 'operator-token');
  w.fetch = async (url, init = {}) => {
    const route = String(url).replace('/_platform/api', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method || 'GET', path: route, body });
    let data: unknown = {};
    if (route === '/me') data = { user: { username: 'owner' } };
    else if (route === '/bootstrap') data = { plans: ['complete'], statuses: ['active'], modules: ['email'], module_deps: {} };
    else if (route === '/tenants') data = [tenant];
    else if (route === '/tenants/acme') data = tenant;
    else if (route === '/tenants/acme/setup-invoices') data = [];
    else if (route === '/tenants/acme/mail' && init.method === 'GET') data = { transport: 'smtp', from_email: 'office@example.com', smtp_host: 'smtp.example.com', smtp_port: 587, has_password: true, ready: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    w.eval(source('web-console/app.js'));
    await flush();
    w.document.querySelector<HTMLTableRowElement>('#rows tr')!.click();
    await flush();
    expect(w.document.querySelector('a[href="/guides/email-setup.html"]')).not.toBeNull();
    const buttons = () => [...w.document.querySelectorAll<HTMLButtonElement>('#drawer button')];
    const save = () => buttons().find(b => b.textContent === 'Save email settings')!.click();
    save(); await flush();
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body).not.toHaveProperty('smtp_pass');
    const password = w.document.querySelector<HTMLInputElement>('#smtp-smtp_pass')!;
    password.value = 'new-secret'; save(); await flush();
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body!.smtp_pass).toBe('new-secret');
    expect(password.value).toBe('');
    w.document.querySelector<HTMLInputElement>('#smtp-clear')!.checked = true;
    save(); await flush();
    expect(calls.filter(c => c.method === 'PUT').at(-1)!.body!.smtp_pass).toBe('');
    w.document.querySelector<HTMLInputElement>('#smtp-test_to')!.value = 'test@example.com';
    buttons().find(b => b.textContent === 'Save & send test')!.click(); await flush();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/tenants/acme/mail/test', body: { to: 'test@example.com' } });
    expect(w.document.querySelector('[role="status"]')!.textContent).toContain('Confirm it arrives');
  } finally { dom.window.close(); }
});

it('tenant Email exposes the guide in both the drawer and settings', async () => {
  const dom = new JSDOM('<button class="rail-btn" data-tool="email"></button>', { runScripts: 'outside-only', url: 'https://acme.example.com' });
  const w = dom.window;
  try {
    w.eval(`window.App = { hasPermission: () => true }; window.API = { get: async () => ({ transport: 'off' }) };
      window.UI = { icon: () => '', esc: s => s, drawer: o => { window.drawerOptions = o; }, modal: o => { window.modalOptions = o; } };`);
    w.eval(source('public/js/tools.js'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    w.document.querySelector<HTMLButtonElement>('[data-tool="email"]')!.click();
    expect(w.drawerOptions.footHTML).toContain('/guides/email-setup.html');
    const element = w.document.createElement('div');
    element.innerHTML = w.drawerOptions.footHTML;
    w.drawerOptions.onOpen(element);
    element.querySelector<HTMLButtonElement>('#em-config')!.click();
    await flush();
    expect(w.modalOptions.bodyHTML).toContain('/guides/email-setup.html');
    expect(w.modalOptions.bodyHTML).toContain('assisted setup');
  } finally { dom.window.close(); }
});
