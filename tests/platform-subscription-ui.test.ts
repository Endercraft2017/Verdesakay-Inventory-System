import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('web-console/index.html', root), 'utf8');
const script = readFileSync(new URL('web-console/app.js', root), 'utf8');

describe('owner subscription workflow', () => {
  it('creates from one company name, then configures monthly module and seat pricing', async () => {
    const dom = new JSDOM(html, { url: 'https://otom.afkcube.com/_platform', runScripts: 'outside-only' });
    const w = dom.window;
    w.localStorage.setItem('vds_platform_token', 'owner-token');
    const ref = { modules: ['inventory', 'manufacturing', 'hr'], module_deps: { manufacturing: ['inventory'] },
      plans: ['starter', 'operations'], plan_modules: { starter: ['inventory'], operations: ['inventory', 'manufacturing', 'hr'] },
      statuses: ['active', 'suspended'] };
    const full = { slug: 'acme-manufacturing', name: 'Acme Manufacturing', url: 'https://otom.afkcube.com/acme-manufacturing',
      plan: 'starter', status: 'active', modules: { override: [], effective: [], plan_default: ['inventory'] },
      usage: { employees: 0, users: 1 }, photo_retention: {},
      subscription: { mode: 'per_module', bundle: 'starter', modules: [], seat_limit: null,
        bundle_price: null, module_prices: {}, seat_price: null } };
    const fetch = vi.fn(async (url: string, opts: { method: string; body?: string }) => {
      const path = url.replace('/_platform/api', '');
      let data: unknown = full;
      if (path === '/me') data = { user: { username: 'owner' } };
      if (path === '/bootstrap') data = ref;
      if (path === '/tenants' && opts.method === 'GET') data = [];
      return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => data };
    });
    Object.assign(w, { fetch });
    try {
      w.eval(script);
      await vi.waitFor(() => expect(fetch.mock.calls.length).toBe(3));
      (w.document.getElementById('new-btn') as HTMLElement).click();
      expect(w.document.getElementById('n-slug')).toBeNull();
      expect(w.document.getElementById('n-plan')).toBeNull();
      (w.document.getElementById('n-name') as HTMLInputElement).value = 'Acme Manufacturing';
      (w.document.getElementById('n-user') as HTMLInputElement).value = 'owner';
      (w.document.getElementById('n-pass') as HTMLInputElement).value = 'secret123-test-only';
      (w.document.getElementById('n-email') as HTMLInputElement).value = 'owner@acme.test';
      (w.document.getElementById('n-go') as HTMLElement).click();
      await vi.waitFor(() => expect(w.document.querySelector('.subscription-card')).not.toBeNull());
      const create = fetch.mock.calls.find(([url, opts]) => url.endsWith('/tenants') && opts.method === 'POST')!;
      expect(JSON.parse(create[1].body!)).toEqual({ slug: 'acme-manufacturing', name: 'Acme Manufacturing', admin_username: 'owner', admin_password: 'secret123-test-only', is_sandbox: false, admin_email: 'owner@acme.test' });
      const card = w.document.querySelector('.subscription-card')!;
      const checks = card.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
      checks[1]!.click(); // manufacturing pulls in inventory
      expect(checks[0]!.checked).toBe(true);
      expect(checks[0]!.disabled).toBe(true);
      checks[2]!.click();
      const numbers = card.querySelectorAll<HTMLInputElement>('input[type=number]');
      // Bundle price, three module prices, employee allowance, employee price.
      [numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]].forEach((input, i) => {
        input!.value = ['100', '250', '500', '2', '50'][i]!;
        input!.dispatchEvent(new w.Event('input', { bubbles: true }));
      });
      expect(card.querySelector('.subscription-quote')!.textContent).toContain('950.00');
      (card.querySelector('button.btn') as HTMLElement).click();
      await vi.waitFor(() => expect(fetch.mock.calls.some(([, opts]) => opts.method === 'PUT')).toBe(true));
      const saved = JSON.parse(fetch.mock.calls.find(([, opts]) => opts.method === 'PUT')![1].body!);
      expect(saved.modules).toEqual(['inventory', 'manufacturing', 'hr']);
      expect(saved.seat_limit).toBe(2);
      expect(saved.seat_price).toBe(50);
    } finally { w.close(); }
  });
});
