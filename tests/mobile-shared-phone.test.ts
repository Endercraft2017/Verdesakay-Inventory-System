/**
 * Shared-phone safety in the mobile app (jsdom): the device ID header, borrowed-phone sign-in,
 * one person's local data never shown to the next, and queued offline actions only ever sent
 * as the account that queued them. Server side: tests/sessions-devices.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'mobile', 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="(\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);
const code = srcs.map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8')).join('\n;\n');

/** Just enough IndexedDB for public/mobile/lib/queue.js (one shared instance per test). */
function fakeIndexedDB() {
  const dbs: Record<string, Record<string, { keyPath: string; rows: Map<unknown, unknown> }>> = {};
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    open(name: string) {
      const req: Record<string, any> = {};
      setTimeout(() => {
        const isNew = !dbs[name];
        const stores = (dbs[name] ||= {});
        req.result = {
          objectStoreNames: { contains: (n: string) => n in stores },
          createObjectStore: (n: string, o: { keyPath: string }) => { stores[n] = { keyPath: o.keyPath, rows: new Map() }; },
          transaction: (n: string) => {
            const store = stores[n]!;
            const t: Record<string, any> = {};
            const mk = (fn: () => unknown) => {
              const r: Record<string, any> = { result: fn() };
              setTimeout(() => r.onsuccess && r.onsuccess());
              return r;
            };
            t.objectStore = () => ({
              put: (v: Record<string, unknown>) => mk(() => { store.rows.set(v[store.keyPath], clone(v)); }),
              get: (k: unknown) => mk(() => clone(store.rows.get(k))),
              getAll: () => mk(() => [...store.rows.values()].map(clone)),
              delete: (k: unknown) => mk(() => { store.rows.delete(k); }),
              count: () => mk(() => store.rows.size),
            });
            setTimeout(() => t.oncomplete && t.oncomplete());
            return t;
          },
        };
        if (isNew && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

interface Call { url: string; headers: Record<string, string>; body: any }
type Responder = (url: string, body: any) => unknown;

async function boot(opts: { storage?: Record<string, string>; respond?: Responder; online?: boolean } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
  const win = dom.window as unknown as Record<string, any>;
  const calls: Call[] = [];
  let authenticatedUser: unknown;
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  win.indexedDB = fakeIndexedDB();
  if (opts.online === false) Object.defineProperty(win.navigator, 'onLine', { get: () => false });
  win.confirm = () => true;
  win.fetch = (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), headers: init.headers || {}, body });
    let out = opts.respond ? opts.respond(String(url), body) : undefined;
    if (String(url).endsWith('/auth/login') && out) authenticatedUser = (out as any).user;
    if (String(url).endsWith('/auth/me') && out === undefined && authenticatedUser) out = { user: authenticatedUser };
    if (out === undefined) return Promise.reject(new Error('no network in test'));
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: () => Promise.resolve(out),
    });
  };
  for (const [k, v] of Object.entries(opts.storage || {})) win.localStorage.setItem(k, v);
  win.eval(code + ';\nwindow.__API = API;'); // api.js's `const API` is scoped to this eval
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await tick();
  return { win, calls };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const EMP = (id: number) => ({ id, username: 'u' + id, full_name: 'User ' + id, role: 'warehouse', permissions: ['inventory.mobile'], employee: null, modules: [] });

async function signInVia(win: Record<string, any>, borrowed = false) {
  const doc = win.document;
  (doc.getElementById('m-username') as HTMLInputElement).value = 'someone';
  (doc.getElementById('m-password') as HTMLInputElement).value = 'pw';
  (doc.getElementById('m-shared') as HTMLInputElement).checked = borrowed;
  doc.getElementById('m-login-form').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
}

describe('mobile shared-phone safety', () => {
  it('sends a stable X-Device-Id, but never on anonymous-report calls', async () => {
    const { win, calls } = await boot();
    const API = win.__API;
    await API.get('/x').catch(() => {});
    await API.get('/y').catch(() => {});
    await API.post('/anonymous-reports/ticket').catch(() => {});
    const [a, b, anon] = calls.slice(-3);
    expect(a!.headers['X-Device-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(b!.headers['X-Device-Id']).toBe(a!.headers['X-Device-Id']);
    expect(win.localStorage.getItem('vds_device_id')).toBe(a!.headers['X-Device-Id']);
    expect(anon!.headers['X-Device-Id']).toBeUndefined();
  });

  it('a different person signing in clears the previous person\'s drafts, keeps device settings', async () => {
    const { win } = await boot({
      storage: {
        vds_m_owner: '7', vds_anonymous_report_draft: '{"t":"secret"}', vds_insp_draft_3: '{}',
        vds_m_recent: '[1]', vds_theme: 'dark', vds_device_id: 'dev-keep-me-0001', vds_m_orbit_v2: '{}',
      },
      respond: (url) => (url.endsWith('/auth/login') ? { token: 'tok-9', user: EMP(9), session: { shared: false } } : undefined),
    });
    await signInVia(win);
    const ls = win.localStorage;
    expect(ls.getItem('vds_anonymous_report_draft')).toBeNull();
    expect(ls.getItem('vds_insp_draft_3')).toBeNull();
    expect(ls.getItem('vds_m_recent')).toBeNull();
    expect(ls.getItem('vds_theme')).toBe('dark');
    expect(ls.getItem('vds_device_id')).toBe('dev-keep-me-0001');
    expect(ls.getItem('vds_m_orbit_v2')).toBe('{}');
    expect(ls.getItem('vds_m_owner')).toBe('9');
    expect(ls.getItem('vds_token')).toBe('tok-9');
  });

  it('the same person signing back in keeps their own drafts', async () => {
    const { win } = await boot({
      storage: { vds_m_owner: '9', vds_insp_draft_3: '{"a":1}' },
      respond: (url) => (url.endsWith('/auth/login') ? { token: 'tok-9', user: EMP(9), session: { shared: false } } : undefined),
    });
    await signInVia(win);
    expect(win.localStorage.getItem('vds_insp_draft_3')).toBe('{"a":1}');
  });

  it('borrowed-phone sign-in keeps the token and profile in sessionStorage and shows the banner', async () => {
    let loginBody: any;
    const { win } = await boot({
      respond: (url, body) => {
        if (url.endsWith('/auth/login')) { loginBody = body; return { token: 'tok-b', user: EMP(5), session: { shared: true } }; }
        return undefined;
      },
    });
    await signInVia(win, true);
    expect(loginBody.shared).toBe(true);
    expect(win.sessionStorage.getItem('vds_token')).toBe('tok-b');
    expect(win.localStorage.getItem('vds_token')).toBeNull();
    expect(win.localStorage.getItem('vds_m_me')).toBeNull();
    expect(win.sessionStorage.getItem('vds_m_me')).toContain('"id":5');
    expect(win.document.getElementById('m-shared-banner').classList.contains('hidden')).toBe(false);
    expect(win.MApp.isSharedSession()).toBe(true);
  });

  it('queued offline actions are only listed and sent for the account that queued them', async () => {
    const { win, calls } = await boot({ online: false });
    const q = win.mQueue;
    await q.setToken('tok-ben', { id: 7, full_name: 'Ben' });
    await q.enqueue({ key: 'idem-ben-1', method: 'POST', path: '/inventory/1/adjust', body: { qty: 1 }, label: 'Adjust' });
    expect(await q.count()).toBe(1);

    await q.setToken('tok-ana', { id: 9, full_name: 'Ana' });
    expect(await q.count()).toBe(0);
    expect(await q.foreignCount()).toBe(1);
    const before = calls.length;
    await q.flush();
    expect(calls.slice(before).some((c) => c.url.includes('/inventory/1/adjust'))).toBe(false);
    await q.discard('idem-ben-1'); // not Ana's to discard
    expect(await q.foreignCount()).toBe(1);

    await q.setToken('tok-ben2', { id: 7, full_name: 'Ben' });
    expect(await q.count()).toBe(1);
  });

  it('signing out of a borrowed phone ends the session and leaves none of that person\'s data', async () => {
    const { win, calls } = await boot({
      respond: (url) => {
        if (url.endsWith('/auth/login')) return { token: 'tok-b', user: EMP(5), session: { shared: true } };
        if (url.endsWith('/auth/logout')) return { ok: true };
        return undefined;
      },
    });
    await signInVia(win, true);
    win.localStorage.setItem('vds_identified_report_draft', '{"x":1}');
    await win.MApp.signOut();
    expect(calls.some((c) => c.url.endsWith('/auth/logout') && c.headers.Authorization === 'Bearer tok-b')).toBe(true);
    expect(win.sessionStorage.getItem('vds_token')).toBeNull();
    expect(win.sessionStorage.getItem('vds_m_me')).toBeNull();
    expect(win.localStorage.getItem('vds_identified_report_draft')).toBeNull();
    expect(win.localStorage.getItem('vds_device_id')).toBeTruthy();
  });
});

it('fresh mobile login loads the linked employee profile before enabling HR requests', async () => {
  const profile = { ...EMP(9), modules: ['hr', 'mobile'], permissions: ['mobile.access'], employee: { id: 4, name: 'Linked Employee' } };
  const { win, calls } = await boot({ respond: url => url.endsWith('/auth/login') ? { token: 'employee-token', user: { ...profile, employee: undefined } } : url.endsWith('/auth/me') ? { user: profile } : undefined });
  await signInVia(win);
  expect(calls.some(c => c.url.endsWith('/auth/me') && c.headers.Authorization === 'Bearer employee-token')).toBe(true);
  expect(win.MApp.getMe().employee.id).toBe(4);
  expect(win.MApp.isEmployee()).toBe(true);
  win.close();
});
