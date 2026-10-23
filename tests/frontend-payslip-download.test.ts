import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach((d) => d.window.close()));
function deferred() {
  let resolve: any;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
function boot() {
  const d = new JSDOM('<body></body>', { url: 'https://localhost/m/', runScripts: 'outside-only' });
  doms.push(d);
  const w = d.window as any;
  let saved = 0,
    revoked = 0,
    created = 0,
    login = 0;
  const calls: any[] = [];
  w.URL.createObjectURL = () => {
    created++;
    return 'blob:sample';
  };
  w.URL.revokeObjectURL = () => revoked++;
  w.HTMLAnchorElement.prototype.click = function () {
    saved++;
  };
  w.App = { showLogin: () => login++ };
  const fetcher: any = {
    reply: async () => ({ status: 200, ok: true, blob: async () => new w.Blob(['pdf']) }),
  };
  w.fetch = (p: any, o: any) => {
    calls.push([p, o]);
    return fetcher.reply(p, o);
  };
  w.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/js/api.js'), 'utf8'));
  w.API.setToken('fictional-session-one');
  return { w, api: w.API, fetcher, calls, counts: () => ({ saved, revoked, created, login }) };
}
it('delivers a current authenticated PDF and passes an opted-in cancellation signal', async () => {
  const b = boot(),
    c = new b.w.AbortController();
  await b.api.download('/me/payslips/11/pdf', 'Payslip.pdf', { signal: c.signal, isCurrent: () => true });
  expect(b.calls[0][1].signal).toBe(c.signal);
  expect(b.calls[0][1].headers.Authorization).toBe('Bearer fictional-session-one');
  expect(b.counts().saved).toBe(1);
});
it('does not fetch or deliver a PDF after its owning screen has closed', async () => {
  const b = boot();
  await expect(b.api.download('/pdf', 'Payslip.pdf', { isCurrent: () => false })).rejects.toThrow(
    'cancelled',
  );
  expect(b.calls).toHaveLength(0);
  expect(b.counts().saved).toBe(0);
});
it('does not deliver bytes that finish loading after a changed sign-in', async () => {
  const b = boot(),
    bytes = deferred();
  b.fetcher.reply = async () => ({ ok: true, status: 200, blob: () => bytes.promise });
  const p = b.api.download('/pdf', 'Payslip.pdf', { isCurrent: () => true });
  await new Promise((r) => setTimeout(r, 0));
  b.api.setToken('fictional-session-two');
  bytes.resolve(new b.w.Blob(['pdf']));
  await expect(p).rejects.toThrow('cancelled');
  expect(b.counts().created).toBe(0);
  expect(b.counts().saved).toBe(0);
});
it('an earlier cancelled PDF 401 cannot sign out a newer session', async () => {
  const b = boot(),
    d = deferred();
  b.fetcher.reply = () => d.promise;
  const p = b.api.download('/pdf', 'Payslip.pdf', { isCurrent: () => true });
  b.api.setToken('fictional-session-two');
  d.resolve({ status: 401 });
  await expect(p).rejects.toThrow('cancelled');
  expect(b.api.getToken()).toBe('fictional-session-two');
  expect(b.counts().login).toBe(0);
});
it('revokes an object URL instead of delivering it if ownership expires between preparation and delivery', async () => {
  const b = boot();
  let current = true;
  b.w.URL.createObjectURL = () => {
    current = false;
    return 'blob:sample';
  };
  await expect(b.api.download('/pdf', 'Payslip.pdf', { isCurrent: () => current })).rejects.toThrow(
    'cancelled',
  );
  expect(b.counts().saved).toBe(0);
  expect(b.counts().revoked).toBe(1);
});
it('an earlier employee read 401 cannot expire a newer session', async () => {
  const b = boot(),
    d = deferred();
  b.fetcher.reply = () => d.promise;
  const p = b.api.get('/me/payslips', { isCurrent: () => true });
  b.api.setToken('fictional-session-two');
  d.resolve({ status: 401 });
  await expect(p).rejects.toThrow('cancelled');
  expect(b.api.getToken()).toBe('fictional-session-two');
  expect(b.counts().login).toBe(0);
});
it('does not fetch an employee read whose owning context has already expired', async () => {
  const b = boot();
  await expect(b.api.get('/me/schedule', { isCurrent: () => false })).rejects.toThrow('cancelled');
  expect(b.calls).toHaveLength(0);
});
