import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '../public');
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach(d => d.window.close()));
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
const deferred = () => { let resolve: any, reject: any; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const record = { id: 41, work_date: '2026-10-20', requested_in: '08:00', requested_out: '17:00', reason: 'Forgot to scan after delivery.', status: 'pending', created_at: '2026-10-21 02:15:00', decided_at: null, decided_by_name: null, decision_note: null };
function boot() {
  const dom = new JSDOM('<main></main><div id="m-toasts"></div>', { runScripts: 'outside-only', url: 'https://localhost/m/#/time-fix' }); doms.push(dom);
  const w = dom.window as any, view = w.document.querySelector('main'), routes: any = {}, calls: any[] = [];
  let account = 1, token = crypto.randomUUID(); const rows: any[] = [structuredClone(record)];
  const api: any = { get: async () => structuredClone(rows), post: async () => ({ ok: true, status: 'cancelled' }), send: async () => ({ ok: true, response: { id: 42 } }) };
  w.API = { getToken: () => token, isSharedSession: () => false, syncLocal: (r: any) => r?.__syncCommand || null,
    get: (p: string, o: any) => { calls.push(['get', p, o]); return api.get(p, o); },
    post: (p: string, b: any, o: any) => { calls.push(['post', p, b, o]); return api.post(p, b, o); } };
  w.mSubmit = (p: string, b: any, o: any) => { calls.push(['send', p, b, o]); return api.send(p, b, o); };
  w.MApp = { route: (n: string, f: any) => routes[n] = f, getMe: () => ({ id: account, employee: { id: account + 10 } }), setTitle() {}, go: (n: string) => { if (w.mPersonalDraft.allow('#/' + n)) { w.location.hash = '#/' + n; view.innerHTML = '<h1>Other screen</h1>'; } } };
  w.MApp.render = () => { if (w.location.hash === '#/time-fix') routes['time-fix'](view); else view.innerHTML = '<h1>Other screen</h1>'; };
  for (const f of ['mobile/lib/dom.js', 'mobile/lib/personal.js', 'mobile/modules/hr/time-fix.js']) w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
  const render = () => routes['time-fix'](view);
  const click = (q: string) => { const e = view.querySelector(q); expect(e, q).not.toBeNull(); e.click(); };
  const input = (k: string, v: string) => { const e = view.querySelector('[data-k=' + k + ']'); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const fill = () => { input('work_date', '2026-10-20'); input('requested_in', '08:00'); input('requested_out', '17:00'); input('reason', 'Forgot to scan after delivery.'); };
  const form = async () => { render(); await tick(); click('#m-tf-new'); fill(); };
  const submit = () => view.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const detail = async () => { render(); await tick(); click('[data-tf-id="41"]'); await tick(); };
  const count = (m: string) => calls.filter(c => c[0] === m).length;
  return { w, view, api, rows, calls, render, click, input, fill, form, submit, detail, count, changeAccount: () => { account++; token = crypto.randomUUID(); } };
}
it('shares list reads, retains loaded rows on failure and retries without stealing another route', async () => {
  const b = boot(), d = deferred(); b.api.get = () => d.promise; b.render(); b.render(); await tick(); expect(b.count('get')).toBe(1); d.resolve(b.rows); await tick(); expect(b.view.querySelector('[data-tf-id="41"]').tagName).toBe('BUTTON');
  b.api.get = async () => { throw Error('Offline'); }; b.click('[data-tf-refresh]'); await tick(); expect(b.view.textContent).toContain('Last loaded'); expect(b.view.querySelector('[data-tf-id="41"]')).not.toBeNull(); expect(b.view.querySelector('[role=alert]')).not.toBeNull();
  const late = deferred(); b.api.get = () => late.promise; b.click('[data-tf-refresh]'); b.w.MApp.go('home'); late.resolve([]); await tick(); expect(b.view.textContent).toBe('Other screen');
});
it('keeps the four fields and validates inline without imposing new date or overnight restrictions', async () => {
  const b = boot(); b.render(); await tick(); b.click('#m-tf-new'); b.submit(); expect(b.count('send')).toBe(0); expect(b.view.querySelectorAll('[aria-invalid=true]')).toHaveLength(3); expect(b.w.document.activeElement.dataset.k).toBe('work_date');
  b.input('work_date', '2040-01-01'); b.input('requested_in', '22:00'); b.input('requested_out', '06:00'); b.input('reason', 'Overnight shift'); b.submit(); await tick(); expect(b.calls.find(c => c[0] === 'send')[2]).toMatchObject({ work_date: '2040-01-01', requested_in: '22:00', requested_out: '06:00', reason: 'Overnight shift' });
});
it('preserves a draft across same-route app renders and confirms both Back and router departures inline', async () => {
  const b = boot(); await b.form(); expect(b.w.mPersonalDraft.allow()).toBe(true); b.view.innerHTML = ''; b.render(); expect(b.view.querySelector('[data-k=reason]').value).toBe(record.reason);
  b.click('[data-tf-back]'); expect(b.view.textContent).toContain('Discard your draft'); b.click('[data-tf-keep-draft]'); expect(b.view.querySelector('[data-k=reason]').value).toBe(record.reason);
  b.w.MApp.go('home'); expect(b.view.textContent).toContain('Discard your draft'); expect(b.w.document.activeElement.hasAttribute('data-tf-keep-draft')).toBe(true); b.click('[data-tf-discard]'); expect(b.w.location.hash).toBe('#/home');
});
it('locks one submission across repeated and detached events, rerenders and navigation', async () => {
  const b = boot(), d = deferred(); b.api.send = () => d.promise; await b.form(); const old = b.view.querySelector('form'); b.submit(); old.dispatchEvent(new b.w.Event('submit', { cancelable: true })); b.click('[data-tf-back]'); b.w.MApp.go('home'); b.render(); expect(b.count('send')).toBe(1); expect(b.view.querySelector('[data-tf-back]').disabled).toBe(true);
  const e = new b.w.Event('beforeunload', { cancelable: true }); b.w.dispatchEvent(e); expect(e.defaultPrevented).toBe(true); d.resolve({ response: { id: 42 } }); await tick(); expect(b.view.textContent).toContain('Request submitted'); old.dispatchEvent(new b.w.Event('submit', { cancelable: true })); expect(b.count('send')).toBe(1);
});
it('retains a failed submission and reuses its logical request key unless the payload changes', async () => {
  const b = boot(); b.api.send = async () => { throw Error('Server unavailable'); }; await b.form(); b.submit(); await tick(); expect(b.view.querySelector('[role=alert]').textContent).toContain('not confirmed'); expect(b.view.querySelector('[data-k=reason]').value).toBe(record.reason);
  b.submit(); await tick(); const sends = b.calls.filter(c => c[0] === 'send'); expect(sends[0][3].idempotencyKey).toBe(sends[1][3].idempotencyKey); b.input('reason', 'Different requested correction.'); b.submit(); await tick(); expect(b.calls.filter(c => c[0] === 'send')[2][3].idempotencyKey).not.toBe(sends[0][3].idempotencyKey);
});
it.each([{ result: { queued: true }, title: 'Saved on this phone' }, { result: { local: 'sample', response: { id: 42 } }, title: 'Saved on the site PC' }])('keeps $title distinct from a submitted request across rerenders', async ({ result, title }) => {
  const b = boot(); b.api.send = async () => result; await b.form(); b.submit(); await tick(); b.render(); expect(b.view.textContent).toContain(title); expect(b.view.textContent).not.toContain('Request submitted'); expect(b.view.querySelector('form')).toBeNull(); expect(b.view.querySelector('[data-tf-view-created]')).toBeNull(); expect(b.count('send')).toBe(1);
});
it('keeps a confirmed receipt without inventing a new list entry and loads the actual created request on demand', async () => {
  const b = boot(); await b.form(); b.submit(); await tick(); expect(b.view.textContent).toContain('Request submitted'); b.rows.unshift({ ...record, id: 42 }); b.click('[data-tf-view-created]'); await tick(); expect(b.view.textContent).toContain('#42'); expect(b.count('send')).toBe(1);
});
it('refreshes details before enabling cancel, confirms inline with Keep focused and sends once', async () => {
  const b = boot(); await b.detail(); b.click('[data-tf-cancel-start]'); expect(b.count('post')).toBe(0); expect(b.w.document.activeElement.hasAttribute('data-tf-cancel-keep')).toBe(true); b.click('[data-tf-cancel-keep]');
  const d = deferred(); b.api.post = () => d.promise; b.click('[data-tf-cancel-start]'); const old = b.view.querySelector('[data-tf-cancel-confirm]'); old.click(); old.dispatchEvent(new b.w.MouseEvent('click')); b.render(); b.w.MApp.go('home'); await tick(); expect(b.count('post')).toBe(1); expect(b.view.querySelector('[data-tf-back]').disabled).toBe(true); d.resolve({ ok: true, status: 'cancelled' }); await tick(); expect(b.view.textContent).toContain('Request cancelled'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull();
});
it('requires a successful readonly status check after an uncertain cancellation before another cancel', async () => {
  const b = boot(); b.api.post = async () => { throw Error('Connection interrupted'); }; await b.detail(); b.click('[data-tf-cancel-start]'); b.click('[data-tf-cancel-confirm]'); await tick(); expect(b.view.textContent).toContain('Cancellation was not confirmed'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull();
  b.api.get = async () => { throw Error('Read failed'); }; b.click('[data-tf-check-status]'); await tick(); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull(); expect(b.count('post')).toBe(1);
  b.rows[0].status = 'approved'; b.rows[0].decision_note = 'Verified'; b.api.get = async () => b.rows; b.click('[data-tf-check-status]'); await tick(); expect(b.view.textContent).toContain('Approved'); expect(b.view.textContent).toContain('Verified'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull(); expect(b.count('post')).toBe(1);
});
it('does not allow cancellation from stale, unavailable or nonpending details and escapes supplied text', async () => {
  const b = boot(); await b.detail(); b.api.get = async () => { throw Error('Offline'); }; b.click('[data-tf-check-status]'); await tick(); expect(b.view.querySelector('[data-tf-cancel-start]')?.disabled ?? true).toBe(true);
  b.api.get = async () => []; b.click('[data-tf-check-status]'); await tick(); expect(b.view.textContent).toContain('latest 100'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull();
  b.rows[0].status = 'rejected'; b.rows[0].reason = '<img src=x onerror=alert(1)>'; b.api.get = async () => b.rows; b.click('[data-tf-check-status]'); await tick(); expect(b.view.querySelector('img')).toBeNull(); expect(b.view.textContent).toContain('<img src=x'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull();
});
it('labels local cancellation as awaiting cloud confirmation and prevents a second cancellation', async () => {
  const b = boot(); b.api.post = async () => ({ ok: true, status: 'cancelled', __syncCommand: 'sample-command' }); await b.detail(); b.click('[data-tf-cancel-start]'); b.click('[data-tf-cancel-confirm]'); await tick(); expect(b.view.textContent).toContain('Cloud confirmation is pending'); b.click('[data-tf-check-status]'); await tick(); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull();
});
it('ignores late reads and submission receipts after an account or route changes', async () => {
  const b = boot(), d = deferred(); b.api.send = () => d.promise; await b.form(); b.submit(); b.changeAccount(); b.render(); await tick(); d.resolve({ response: { id: 42 } }); await tick(); expect(b.view.textContent).not.toContain('Request submitted'); expect(b.view.querySelector('[data-k=reason]')).toBeNull();
  const next = deferred(); b.api.get = () => next.promise; b.click('[data-tf-refresh]'); b.w.MApp.go('home'); next.resolve([{ ...record, reason: 'Old response' }]); await tick(); expect(b.view.textContent).toBe('Other screen');
});
it('does not replace another route with a late forced-departure write but retains its receipt for this sign-in', async () => {
  const b = boot(), d = deferred(); b.api.send = () => d.promise; await b.form(); b.submit(); b.w.mPersonalDraft.clear(); b.w.MApp.go('home'); d.resolve({ response: { id: 42 } }); await tick(); expect(b.view.textContent).toBe('Other screen'); b.w.location.hash = '#/time-fix'; b.render(); expect(b.view.textContent).toContain('Request submitted');
});
it('opts the real queue helper into stable keys and never queues a departed account’s late failure', async () => {
  const b = boot(), d = deferred(); Object.defineProperty(b.w.navigator, 'onLine', { value: false }); b.w.eval(fs.readFileSync(path.join(root, 'mobile/lib/queue.js'), 'utf8')); await b.w.mQueue.setToken(b.w.API.getToken(), { id: 1 }); const queued: any[] = []; b.w.mQueue.enqueue = async (o: any) => { queued.push(o); };
  let current = true; b.api.post = () => d.promise; const pending = b.w.mSubmit('/me/time-corrections', {}, { idempotencyKey: 'idem-sample', isCurrent: () => current }); current = false; d.reject(Object.assign(Error('Offline'), { offline: true })); await expect(pending).rejects.toThrow('Offline'); expect(queued).toHaveLength(0);
  current = true; b.api.post = async () => { throw Object.assign(Error('Offline'), { offline: true }); }; await b.w.mSubmit('/me/time-corrections', {}, { idempotencyKey: 'idem-sample', isCurrent: () => current }); expect(queued[0].key).toBe('idem-sample'); expect(b.calls.filter(c => c[0] === 'post').every(c => c[3].idempotencyKey === 'idem-sample')).toBe(true);
});
it('bounds unanswered reads and cancellation, aborting transport and requiring readonly recovery', async () => {
  const b = boot(); const original = b.w.setTimeout.bind(b.w); b.w.setTimeout = (fn: any, ms: number, ...args: any[]) => original(fn, ms === 20000 || ms === 30000 ? 25 : ms, ...args);
  b.api.get = () => new Promise(() => {}); b.render(); await new Promise(r => setTimeout(r, 45)); expect(b.view.querySelector('[role=alert]').textContent).toContain('timed out'); expect(b.calls[0][2].signal.aborted).toBe(true);
  b.api.get = async () => b.rows; b.click('[data-tf-refresh]'); await tick(); b.click('[data-tf-id="41"]'); await tick(); b.api.post = () => new Promise(() => {}); b.click('[data-tf-cancel-start]'); b.click('[data-tf-cancel-confirm]'); await new Promise(r => setTimeout(r, 45)); expect(b.view.textContent).toContain('Cancellation was not confirmed'); expect(b.view.querySelector('[data-tf-cancel-start]')).toBeNull(); expect(b.calls.find(c => c[0] === 'post')[3].signal.aborted).toBe(true);
});
it('validates the reason limit and supports the existing insecure-LAN UUID fallback', async () => {
  const b = boot(); Object.defineProperty(b.w.crypto, 'randomUUID', { value: undefined }); await b.form(); b.input('reason', 'a'.repeat(1001)); b.submit(); expect(b.count('send')).toBe(0); expect(b.view.querySelector('[aria-invalid=true]').dataset.k).toBe('reason'); b.input('reason', 'Three or more characters.'); b.submit(); await tick(); expect(b.view.textContent).toContain('Request submitted'); expect(b.calls.find(c => c[0] === 'send')[3].idempotencyKey).toMatch(/^idem-/);
});
it('does not let a pre-submit list read suppress the fresh read for the created request', async () => {
  const b = boot(), d = deferred(); b.api.get = () => d.promise; b.render(); b.click('#m-tf-new'); b.fill(); b.submit(); await tick(); expect(b.view.textContent).toContain('Request submitted'); b.click('[data-tf-view-created]'); b.rows.unshift({ ...record, id: 42 }); b.api.get = async () => b.rows; d.resolve([record]); await tick(); expect(b.view.textContent).toContain('#42'); expect(b.view.textContent).not.toContain('not in your latest');
});
