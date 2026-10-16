import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

it('shows the owner username, checks confirmation, submits the reset and clears passwords', async () => {
  const root = new URL('../web-console/', import.meta.url);
  const dom = new JSDOM(fs.readFileSync(new URL('index.html', root), 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.com/_platform/',
  });
  const w = dom.window;
  const tenant = {
    slug: 'acme', name: 'Acme', is_sandbox: true, status: 'active', plan: 'starter',
    modules: { effective: ['inventory'], override: null, plan_default: ['inventory'] },
    photo_retention: { retention_days: null, max_mb: null, usage_mb: 0 },
    owner: { id: 1, username: 'original-owner', active: 1 }, log: [],
  };
  const fetch = vi.fn(async (url: string, opts: { body?: string }) => {
    let data: unknown = {};
    if (url.endsWith('/me')) data = { user: { username: 'operator' } };
    else if (url.endsWith('/bootstrap')) data = { plan_modules: { starter: [] }, module_deps: {}, plans: ['starter'], statuses: ['active'], modules: ['inventory'] };
    else if (url.endsWith('/tenants')) data = [tenant];
    else if (url.endsWith('/tenants/acme')) data = tenant;
    else if (url.endsWith('/analytics')) return new Promise(() => {});
    else if (url.endsWith('/reset-owner-password')) data = JSON.parse(opts.body!).temporary ? { username: 'original-owner', temporary_password: 'generated-temporary-pass', expires_at: '2026-10-11T00:00:00Z' } : { ok: true, email: { sent: false, reason: 'SMTP unavailable' } };
    return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => data };
  });
  w.fetch = fetch as unknown as typeof w.fetch;
  w.localStorage.setItem('vds_platform_token', 'operator-token');
  try {
    w.eval(fs.readFileSync(new URL('app.js', root), 'utf8'));
    await vi.waitFor(() => expect(w.document.querySelector('#rows .tenant-choice')).not.toBeNull());
    await vi.waitFor(() => expect(w.document.querySelector('[data-tab="settings"]')).not.toBeNull());
    (w.document.querySelector('[data-tab="settings"]') as HTMLElement).click();
    await vi.waitFor(() => expect(w.document.querySelector('#d-owner-reset')).not.toBeNull());
    expect(w.document.querySelector('#settings-panel')!.textContent).toContain('First admin login: original-owner');
    const password = w.document.querySelector('#d-owner-password') as HTMLInputElement;
    const confirm = w.document.querySelector('#d-owner-confirm') as HTMLInputElement;
    const form = password.closest('form')!;
    password.value = 'newsecret1-test-only'; confirm.value = 'different';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    expect(w.document.querySelector('#d-owner-err')!.textContent).toBe('Passwords do not match.');
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/reset-owner-password'))).toBe(false);
    confirm.value = password.value;
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(password.value).toBe(''));
    expect(confirm.value).toBe('');
    const call = fetch.mock.calls.find(([url]) => url.endsWith('/reset-owner-password'))!;
    expect(JSON.parse(call[1].body!)).toEqual({ owner_id: 1, new_password: 'newsecret1-test-only', current_password: '', reason: '' });
    expect(w.document.querySelector('#d-owner-err')!.textContent).toContain('Password reset for original-owner');
    const fallback = w.document.getElementById('d-owner-temporary') as HTMLButtonElement;
    expect(fallback.classList.contains('hidden')).toBe(false);
    w.confirm = vi.fn(() => true);
    fallback.click();
    await vi.waitFor(() => expect((w.document.getElementById('d-owner-temporary-value') as HTMLInputElement).value).toBe('generated-temporary-pass'));
    expect(w.document.getElementById('d-owner-temporary-info')!.textContent).toContain('expires in 24 hours');
    expect(w.localStorage.getItem('vds_platform_token')).toBeNull();
    expect(JSON.stringify(w.localStorage)).not.toContain('generated-temporary-pass');
    (w.document.querySelector('[data-tab="overview"]') as HTMLButtonElement).click();
    expect(w.document.getElementById('d-owner-temporary-value')).toBeNull();
  } finally { w.close(); }
});

it('requires regular recovery email, creates a minimal sandbox, and offers removal', async () => {
  const root = new URL('../web-console/', import.meta.url);
  const dom = new JSDOM(fs.readFileSync(new URL('index.html', root), 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.com/_platform/',
  });
  const w = dom.window;
  const tenant = {
    slug: 'sandbox-company', name: 'Sandbox Company', is_sandbox: true,
    status: 'active', plan: 'starter', modules: { effective: [], override: null, plan_default: [] },
    photo_retention: { retention_days: null, max_mb: null, usage_mb: 0 },
    owner: { id: 1, username: 'sandboxowner', active: 1 }, log: [],
  };
  const fetch = vi.fn(async (url: string, opts: { method: string; body?: string }) => {
    let data: unknown = {};
    if (url.endsWith('/me')) data = { user: { username: 'operator' } };
    else if (url.endsWith('/bootstrap')) data = { plan_modules: { starter: [] }, module_deps: {}, plans: ['starter'], statuses: ['active'], modules: [] };
    else if (url.endsWith('/tenants')) data = opts.method === 'POST' ? tenant : [];
    else if (url.endsWith('/tenants/sandbox-company')) data = tenant;
    else if (url.endsWith('/analytics')) return new Promise(() => {});
    return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => data };
  });
  w.fetch = fetch as unknown as typeof w.fetch;
  w.localStorage.setItem('vds_platform_token', 'operator-token');
  const input = (id: string) => w.document.getElementById(id) as HTMLInputElement;
  try {
    w.eval(fs.readFileSync(new URL('app.js', root), 'utf8'));
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBe(3));
    input('new-btn').click();
    input('n-name').value = 'Sandbox Company';
    input('n-user').value = 'sandboxowner';
    input('n-pass').value = 'sandboxpass1-test-only';
    input('n-go').click();
    expect(w.document.getElementById('n-err')!.textContent).toContain('recovery email');
    expect(fetch.mock.calls.some(([url, opts]) => url.endsWith('/tenants') && opts.method === 'POST')).toBe(false);
    input('n-sandbox').checked = true;
    input('n-sandbox').dispatchEvent(new w.Event('change'));
    expect(w.document.getElementById('n-email-field')!.classList.contains('hidden')).toBe(true);
    expect(input('n-email').required).toBe(false);
    input('n-go').click();
    await vi.waitFor(() => expect(w.document.querySelector('.subscription-card')).not.toBeNull());
    (w.document.querySelector('[data-tab="settings"]') as HTMLElement).click();
    const create = fetch.mock.calls.find(([url, opts]) => url.endsWith('/tenants') && opts.method === 'POST')!;
    expect(JSON.parse(create[1].body!)).toMatchObject({ name: 'Sandbox Company', admin_username: 'sandboxowner', admin_password: 'sandboxpass1-test-only', is_sandbox: true });
    expect(JSON.parse(create[1].body!).admin_email).toBeUndefined();
    expect(JSON.parse(create[1].body!).slug).toBeUndefined();
    const remove = [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Remove sandbox tenant')!;
    expect(remove).toBeDefined();
    expect(w.document.getElementById('settings-panel')!.textContent).toContain('recovery emails are disabled');
    expect(w.document.getElementById('settings-panel')!.textContent).not.toContain('Email owner username');
    w.prompt = vi.fn(() => null);
    remove.click();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/purge'))).toBe(false);
    w.prompt = vi.fn(() => 'sandbox-company');
    remove.click();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/purge'))).toBe(true));
    const purge = fetch.mock.calls.find(([url]) => url.endsWith('/purge'))!;
    expect(JSON.parse(purge[1].body!)).toEqual({ confirm: 'sandbox-company' });
    await vi.waitFor(() => expect(w.document.getElementById('settings-panel')).toBeNull());
  } finally { w.close(); }
});
