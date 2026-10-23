import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, it, expect, vi } from 'vitest';

const publicRoot = path.join(import.meta.dirname, '../public');
const contextScript = fs.readFileSync(path.join(publicRoot, 'js/tenant-context.js'), 'utf8');
const apiScript = fs.readFileSync(path.join(publicRoot, 'js/api.js'), 'utf8');
type Client = { getToken: () => string | null; setToken: (token: string) => void; get: (path: string) => Promise<unknown> };
type BrowserContext = { api: Client; storage: Storage };

describe('browser tenancy', () => {
  it('loads separate classic scripts using scoped storage, as the actual app shell does', () => {
    const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://otom.afkcube.com/verdesakay', runScripts: 'dangerously' });
    (dom.window as unknown as { VDS_BASE_PATH: string }).VDS_BASE_PATH = '/verdesakay';
    for (const source of [contextScript, apiScript]) {
      const script = dom.window.document.createElement('script');
      script.textContent = source;
      dom.window.document.head.appendChild(script);
    }
    const api = (dom.window as unknown as { API: { setToken: (token: string) => void; getToken: () => string | null } }).API;
    api.setToken('classic-script-token');
    expect(api.getToken()).toBe('classic-script-token');
    expect(dom.window.localStorage.getItem('vds_token')).toBeNull();
    expect(dom.window.localStorage.getItem('tenant:/verdesakay:vds_token')).toBe('classic-script-token');
    dom.window.close();
  });
  it('separates tokens, kiosk grants, drafts, preferences and clear/enumeration on a shared origin', () => {
    const a = new JSDOM('', { url: 'https://otom.afkcube.com/verdesakay', runScripts: 'outside-only' });
    const b = new JSDOM('', { url: 'https://otom.afkcube.com/otherco', runScripts: 'outside-only' });
    const shared = a.window.localStorage;
    shared.setItem('vds_token', 'original-company-token');
    Object.defineProperty(b.window, 'localStorage', { value: shared });
    (a.window as unknown as { VDS_BASE_PATH: string }).VDS_BASE_PATH = '/verdesakay';
    (b.window as unknown as { VDS_BASE_PATH: string }).VDS_BASE_PATH = '/otherco';
    const ac = a.window.eval(contextScript + '\n' + apiScript + '\n({api: API, storage: localStorage})') as BrowserContext;
    const bc = b.window.eval(contextScript + '\n' + apiScript + '\n({api: API, storage: localStorage})') as BrowserContext;
    expect(ac.api.getToken()).toBeNull();
    ac.api.setToken('a-token'); ac.storage.setItem('vds_kiosk_token', 'a-kiosk'); ac.storage.setItem('vds_draft', 'a-draft');
    bc.api.setToken('b-token'); bc.storage.setItem('vds_kiosk_token', 'b-kiosk');
    expect(ac.api.getToken()).toBe('a-token');
    expect(bc.api.getToken()).toBe('b-token');
    expect(ac.storage.getItem('vds_kiosk_token')).toBe('a-kiosk');
    expect(bc.storage.getItem('vds_draft')).toBeNull();
    expect(bc.storage.length).toBe(2);
    bc.storage.clear();
    expect(ac.api.getToken()).toBe('a-token');
    expect(shared.getItem('vds_token')).toBe('original-company-token');
    a.window.close(); b.window.close();
  });

  it('uses the tenant API URL and identifies the mobile client on a prefixed route', async () => {
    const dom = new JSDOM('', { url: 'https://otom.afkcube.com/verdesakay/m', runScripts: 'outside-only' });
    (dom.window as unknown as { VDS_BASE_PATH: string }).VDS_BASE_PATH = '/verdesakay';
    const fetch = vi.fn(async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
    Object.defineProperty(dom.window, 'fetch', { value: fetch });
    const api = dom.window.eval(contextScript + '\n' + apiScript + '\nAPI') as Client;
    api.setToken('tenant-token');
    await api.get('/auth/me');
    expect(fetch).toHaveBeenCalledWith('/verdesakay/api/auth/me', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tenant-token', 'X-Client': 'mobile' }) }));
    dom.window.close();
  });

  it('keeps service-worker cache cleanup and API handling inside the correct tenant', async () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const deleted: string[] = [];
    const context = vm.createContext({
      TENANT_BASE: '/verdesakay', URL,
      location: { origin: 'https://otom.afkcube.com' }, clients: { claim: async () => {} }, addEventListener: (name: string, callback: (event: unknown) => void) => { listeners[name] = callback; },
      caches: { keys: async () => ['vds-m:/verdesakay:v67', 'vds-m:/verdesakay-industries:v67', 'vds-m:/otherco:v67', 'vds-m-v67'], delete: async (key: string) => { deleted.push(key); } },
    });
    context.self = context;
    context.importScripts = (source: string) => {
      expect(source).toBe('/verdesakay/mobile/lib/queue-store.js');
      vm.runInContext(fs.readFileSync(path.join(publicRoot, 'mobile/lib/queue-store.js'), 'utf8'), context);
    };
    vm.runInContext(fs.readFileSync(path.join(publicRoot, 'mobile/sw.js'), 'utf8'), context);
    let pending: Promise<unknown> | undefined;
    listeners.activate!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(deleted).toEqual(['vds-m:/verdesakay:v67']);
    const respondWith = vi.fn();
    listeners.fetch!({ request: { url: 'https://otom.afkcube.com/verdesakay/api/inventory', method: 'GET' }, respondWith });
    listeners.fetch!({ request: { url: 'https://otom.afkcube.com/otherco/api/inventory', method: 'GET' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(vm.runInContext("'vds_mobile' + TENANT_BASE", context)).toBe('vds_mobile/verdesakay');
  });
});
