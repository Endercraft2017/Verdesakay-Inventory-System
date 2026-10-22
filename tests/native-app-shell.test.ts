/** The installable phone app shell (docs/OFFLINE-FIRST.md §29, phase 7a): api.js talks to the
    saved server address only inside the app, native.js keeps just the address's origin, and the
    page the app bundles still has the script build-web.mjs anchors on. (CORS for the app's
    origins: native-app-cors.test.ts.) */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

type ApiClient = { get: (p: string) => Promise<unknown>; base: () => string };

function loadApi(): ApiClient {
  const src = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn API;`)() as ApiClient;
}

describe('api.js server address', () => {
  const w = window as unknown as { VDS_NATIVE?: boolean };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    delete w.VDS_NATIVE;
    fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterAll(() => { delete w.VDS_NATIVE; vi.unstubAllGlobals(); });

  it('inside the app, calls the saved server and says it is the phone app', async () => {
    w.VDS_NATIVE = true;
    localStorage.setItem('vds_api_base', 'https://acme.example.com/');
    const API = loadApi();
    expect(API.base()).toBe('https://acme.example.com');
    await API.get('/auth/me');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.example.com/api/auth/me');
    expect((init.headers as Record<string, string>)['X-Client']).toBe('mobile');
  });

  it('in a browser, ignores a saved address and stays on its own server', async () => {
    localStorage.setItem('vds_api_base', 'https://elsewhere.example.com');
    const API = loadApi();
    expect(API.base()).toBe('');
    await API.get('/auth/me');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/me');
  });
});

describe('native.js', () => {
  type VdsNative = { normalise: (s: string) => string; forgetServer: () => void };
  let N: VdsNative;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(root, 'public/mobile/native.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(src)();
    N = (window as unknown as { VdsNative: VdsNative }).VdsNative;
  });
  afterAll(() => { delete (window as unknown as { VDS_NATIVE?: boolean }).VDS_NATIVE; });

  it('keeps only scheme, host and port, defaulting to https', () => {
    expect(N.normalise('acme.example.com')).toBe('https://acme.example.com');
    expect(N.normalise('  https://acme.example.com/m/#/home ')).toBe('https://acme.example.com');
    expect(N.normalise('192.168.1.20:3000')).toBe('https://192.168.1.20:3000');
    expect(N.normalise('http://192.168.1.20:3000/')).toBe('http://192.168.1.20:3000');
    expect(N.normalise('')).toBe('');
    expect(N.normalise('https://')).toBe('');
  });

  it('forgetting the server clears the saved address', () => {
    localStorage.setItem('vds_api_base', 'https://acme.example.com');
    N.forgetServer();
    expect(localStorage.getItem('vds_api_base')).toBeNull();
  });
});

describe('bundled page', () => {
  it('the phone page still loads api.js the way mobile-app/build-web.mjs expects', () => {
    const page = fs.readFileSync(path.join(root, 'public/mobile/index.html'), 'utf8');
    expect(page).toContain('<script src="/js/api.js"></script>');
  });
});
