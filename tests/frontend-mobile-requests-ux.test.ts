import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '../public');
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach(d => d.window.close()));
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
const deferred = () => { let resolve: any, reject: any; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const types = [
  { id: 10, slug: 'schedule_change', name: 'Schedule Change Request', fields: [{ key: 'employee_name', label: 'Employee', type: 'employee', required: true }, { key: 'work_date', label: 'Published work date', type: 'date', required: true }, { key: 'requested_shift_id', label: 'Requested shift', type: 'select', required: true, options: [{ value: '7', label: 'Day shift · 08:00–17:00' }] }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }] },
  { id: 11, slug: 'overtime_request', name: 'Overtime Request', fields: [{ key: 'work_date', label: 'Date', type: 'date', required: true }, { key: 'hours_estimate', label: 'Estimated OT Hours', type: 'number' }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }, { key: 'early_ot', label: 'Early OT', type: 'checkbox' }] },
  { id: 12, slug: 'leave_request', name: 'Leave Request', fields: [{ key: 'date_from', label: 'From', type: 'date', required: true }, { key: 'date_to', label: 'To', type: 'date', required: true }, { key: 'with_pay', label: 'With pay', type: 'select', required: true, options: ['Yes', 'No'] }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }] },
  { id: 13, slug: 'custom_example', name: 'Configured example', fields: [{ key: 'extra', label: 'Extra configured field', type: 'text' }] }
];
const record = { id: 42, number: 'SCH-00042', form_name: 'Schedule Change Request', status: 'pending', created_at: '2026-10-20', fields: types[0]!.fields, data: { work_date: '2026-10-23', requested_shift_id: '7', reason: 'Family appointment' }, display_data: { 'Work date': '2026-10-23', 'Requested shift': 'Day shift · 08:00–17:00', Reason: 'Family appointment' } };
function boot() {
  const dom = new JSDOM('<main id="view"></main>', { runScripts: 'outside-only', url: 'https://localhost/m/#requests' }); doms.push(dom);
  const w = dom.window as any, routes: any = {}, view = w.document.querySelector('main'), gets: string[] = [], sends: any[] = [], posts: any[] = [], toasts: string[] = [];
  let user: any = { id: 1, employee: { id: 7, name: 'Employee One', leave_days_per_year: 15, leave_days_remaining: 8 } }, token = crypto.randomUUID();
  const records = [structuredClone(record)];
  const api: any = { get: async (p: string) => p === '/me' ? { employee: user.employee } : p === '/me/request-types' ? structuredClone(types) : records, post: async () => ({ ok: true }), send: async () => ({ response: { id: 43, number: 'SCH-00043' } }) };
  w.API = { getToken: () => token, isSharedSession: () => false, syncLocal: (r: any) => r?.__syncCommand || null, get: (p: string) => { gets.push(p); return api.get(p); }, post: (p: string, b: any) => { posts.push([p, b]); return p === '/me/leave-preview' ? Promise.resolve({ days: 1, remaining: 8, warnings: [] }) : api.post(p, b); } };
  w.mSubmit = (p: string, b: any) => { sends.push([p, b]); return api.send(p, b); };
  w.mEsc = (v: unknown) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  w.mEl = (html: string) => { const box = w.document.createElement('div'); box.innerHTML = html; return box.firstElementChild; };
  w.mToast = (s: string) => toasts.push(s);
  w.MApp = { route: (k: string, fn: any) => routes[k] = fn, setTitle() {}, getMe: () => user, go: (r: string) => { if (w.mPersonalDraft.allow('#' + r)) { w.location.hash = r; view.innerHTML = '<h1>Other screen</h1>'; } } };
  for (const file of ['js/lib/form-validation.js', 'js/leave-dates.js', 'mobile/lib/personal.js', 'mobile/modules/hr/requests.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const render = (params: any = {}) => routes.requests(view, params);
  const click = (selector: string) => { const el = view.querySelector(selector); expect(el, selector).not.toBeNull(); el.click(); };
  const input = (key: string, value: string | boolean) => { const el = view.querySelector('[data-k="' + key + '"]'); if (typeof value === 'boolean') el.checked = value; else el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const review = async (slug = 'schedule_change') => { render({ type: slug }); await tick(); input('work_date', '2026-10-23'); if (slug === 'schedule_change') input('requested_shift_id', '7'); input('reason', 'Family appointment'); view.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
  return { w, view, api, gets, sends, posts, toasts, records, render, click, input, review, setIdentity: (u: any, t = crypto.randomUUID()) => { user = u; token = t; } };
}
it('opens notification request IDs and keeps the filter and row focus on Back without refetching each tab', async () => {
  const b = boot(); b.render({ id: 42, filter: 'pending' }); await tick(); expect(b.view.textContent).toContain('SCH-00042'); b.click('.m-request-back'); await tick(); expect(b.view.querySelector('[aria-pressed=true]').dataset.filter).toBe('pending'); expect(b.w.document.activeElement.dataset.requestId).toBe('42');
  b.click('[data-filter=approved]'); b.click('[data-filter=pending]'); b.click('[data-filter=pending]'); expect(b.gets.filter(p => p === '/me/requests')).toHaveLength(1);
});
it('shares delayed reads across rerenders, retains confirmed rows on refresh failure and guards Retry', async () => {
  const b = boot(); const d = deferred(); b.api.get = (p: string) => p === '/me/requests' ? d.promise : Promise.resolve(p === '/me' ? { employee: {} } : types); b.render(); b.render(); await tick(); expect(b.gets.filter(p => p === '/me/requests')).toHaveLength(1); d.resolve(b.records); await tick();
  const retry = deferred(); b.api.get = () => retry.promise; b.click('#m-req-retry'); b.click('#m-req-retry'); await tick(); expect(b.gets.filter(p => p === '/me/requests')).toHaveLength(2); retry.reject(new Error('Connection lost')); await tick(); expect(b.view.textContent).toContain('last loaded list'); expect(b.view.textContent).toContain('SCH-00042'); expect(b.view.querySelector('#m-req-retry').disabled).toBe(false);
});
it('ignores a type-link response after another route has opened', async () => {
  const b = boot(), d = deferred(); b.api.get = () => d.promise; b.render({ type: 'schedule_change' }); b.w.MApp.go('home'); d.resolve(types); await tick(); expect(b.view.querySelector('h1').textContent).toBe('Other screen');
});
it('searches every configured type without replacing the search input or hiding custom forms', async () => {
  const b = boot(); b.render(); await tick(); b.click('#m-req-new'); const search = b.view.querySelector('[data-type-search]'); search.focus(); search.value = 'overtime'; search.dispatchEvent(new b.w.Event('input')); expect(b.view.querySelectorAll('[data-type-id]')).toHaveLength(1); expect(b.w.document.activeElement).toBe(search); search.value = 'missing'; search.dispatchEvent(new b.w.Event('input')); b.click('[data-clear-search]'); expect(b.view.querySelectorAll('[data-type-id]')).toHaveLength(4); b.click('[data-type-id="13"]'); expect(b.view.textContent).toContain('Extra configured field');
});
it('keeps separate drafts including optional number and checkbox fields across type changes and route reentry', async () => {
  const b = boot(); b.render({ type: 'overtime_request' }); await tick(); b.input('reason', 'Do not lose this overtime reason'); b.input('hours_estimate', '2.5'); b.input('early_ot', true); b.click('.m-request-selected-type'); b.click('[data-type-id="10"]'); b.input('reason', 'Separate schedule draft'); b.click('.m-request-back'); b.click('[data-type-id="11"]'); expect(b.view.querySelector('[data-k=reason]').value).toBe('Do not lose this overtime reason'); expect(b.view.querySelector('[data-k=hours_estimate]').value).toBe('2.5'); expect(b.view.querySelector('[data-k=early_ot]').checked).toBe(true);
  b.w.MApp.go('home'); b.w.location.hash = 'requests'; b.render({ type: 'overtime_request' }); await tick(); expect(b.view.querySelector('[data-k=early_ot]').checked).toBe(true); const e = new b.w.Event('beforeunload', { cancelable: true }); b.w.dispatchEvent(e); expect(e.defaultPrevented).toBe(true);
});
it('retains selected leave dates, pending date input and configured fields through review editing', async () => {
  const b = boot(); b.render({ type: 'leave_request', date: '2026-10-23' }); await tick(); b.input('with_pay', 'Yes'); b.input('reason', 'Medical appointment'); const single = b.view.querySelector('[data-leave-single]'); single.value = '2026-10-26'; b.click('[data-leave-add]'); single.value = '2026-10-28'; single.dispatchEvent(new b.w.Event('input', { bubbles: true })); b.view.querySelector('form').dispatchEvent(new b.w.Event('submit', { cancelable: true })); expect(b.view.textContent).toContain('Selected leave dates'); b.click('.m-request-back'); expect(b.view.querySelectorAll('[data-leave-remove]')).toHaveLength(2); expect(b.view.querySelector('[data-leave-single]').value).toBe('2026-10-28'); expect(b.view.querySelector('[data-k=with_pay]').value).toBe('Yes'); expect(b.view.querySelector('[data-k=reason]').value).toBe('Medical appointment');
});
it('shows configured review labels and shift names, keeps validation and leaves the payload IDs intact', async () => {
  const b = boot(); b.render({ type: 'schedule_change' }); await tick(); b.view.querySelector('form').dispatchEvent(new b.w.Event('submit', { cancelable: true })); expect(b.view.querySelector('[data-validation-summary]').hidden).toBe(false); expect(b.sends).toHaveLength(0); await b.review(); expect(b.view.textContent).toContain('Published work date'); expect(b.view.textContent).toContain('Day shift · 08:00–17:00'); expect(b.view.textContent).not.toContain('Requested Shift Id'); b.click('#m-request-submit'); await tick(); expect(b.sends[0][1]).toMatchObject({ form_def_id: 10, status: 'pending', data: { requested_shift_id: '7', employee_name: 'Employee One' } });
});
it('guards repeated and detached submits, navigation and forced rerenders while sending, then shows one receipt', async () => {
  const b = boot(), d = deferred(); b.api.send = () => d.promise; await b.review(); const old = b.view.querySelector('#m-request-submit'); old.click(); old.dispatchEvent(new b.w.MouseEvent('click')); expect(b.view.querySelector('.m-request-back').disabled).toBe(true); b.w.MApp.go('home'); expect(b.view.textContent).toContain('Submitting…'); b.render(); b.click('#m-request-submit'); expect(b.sends).toHaveLength(1); const e = new b.w.Event('beforeunload', { cancelable: true }); b.w.dispatchEvent(e); expect(e.defaultPrevented).toBe(true); d.resolve({ response: { id: 43, number: 'SCH-00043', action_warnings: ['Approval action needs HR attention'] } }); await tick(); expect(b.view.textContent).toContain('Request submitted'); expect(b.view.textContent).toContain('Approval action needs HR attention'); expect(b.view.querySelector('#m-request-submit')).toBeNull();
});
it('retains a failed submission visibly and permits editing and retrying it', async () => {
  const b = boot(); b.api.send = async () => { throw new Error('Connection interrupted'); }; await b.review(); b.click('#m-request-submit'); await tick(); expect(b.view.textContent).toContain('Submission was not confirmed'); expect(b.view.textContent).toContain('Family appointment'); expect(b.w.document.activeElement.getAttribute('role')).toBe('alert'); b.click('.m-request-back'); expect(b.view.querySelector('[data-k=reason]').value).toBe('Family appointment');
  b.api.send = async () => ({ response: { id: 43 } }); b.view.querySelector('form').dispatchEvent(new b.w.Event('submit', { cancelable: true })); b.click('#m-request-submit'); await tick(); expect(b.view.textContent).toContain('Request submitted');
});
it.each([{ kind: 'queued', result: { queued: true }, title: 'Saved on this phone' }, { kind: 'local', result: { local: 'sample-command', response: {} }, title: 'Saved on the site PC' }])('shows an honest $kind receipt and requires an explicit new request to file another copy', async ({ kind, result, title }) => {
  const b = boot(); b.api.send = async () => result; await b.review(); b.click('#m-request-submit'); await tick(); expect(b.view.textContent).toContain(title); expect(b.view.textContent).not.toContain('Request submitted'); expect(!!b.view.querySelector('[data-receipt-queue]')).toBe(kind === 'queued'); b.render({ type: 'schedule_change' }); await tick(); expect(b.view.textContent).toContain(title); expect(b.sends).toHaveLength(1); b.click('[data-another-request]'); expect(b.view.querySelector('[data-k=reason]').value).toBe('');
});
it('matches cancellation availability to the server and avoids inferred stages for cancelled and rejected records', async () => {
  const b = boot(); for (const status of ['pending', 'draft', 'review', 'approved', 'cancelled', 'rejected', 'completed']) { b.records[0]!.status = status; b.render({ id: 42 }); await tick(); expect(!!b.view.querySelector('[data-cancel-start]')).toBe(['pending', 'draft'].includes(status)); expect(b.view.querySelector('.m-request-timeline').textContent).not.toContain('○ Final processing'); }
});
it('confirms cancellation inline, keeps failure recovery visible and allows only one pending cancel across rerenders', async () => {
  const b = boot(), d = deferred(); b.api.post = () => d.promise; b.render({ id: 42, filter: 'pending' }); await tick(); b.click('[data-cancel-start]'); expect(b.w.document.activeElement.hasAttribute('data-cancel-keep')).toBe(true); b.click('[data-cancel-keep]'); expect(b.view.querySelector('[data-cancel-confirm]')).toBeNull(); b.click('[data-cancel-start]'); const old = b.view.querySelector('[data-cancel-confirm]'); old.click(); old.dispatchEvent(new b.w.MouseEvent('click')); b.render(); b.click('[data-cancel-confirm]'); expect(b.posts).toHaveLength(1); b.w.MApp.go('home'); expect(b.view.textContent).toContain('Cancelling…'); d.reject(new Error('Timeout')); await tick(); expect(b.view.textContent).toContain('Cancellation was not confirmed');
  b.api.post = async () => ({ ok: true, status: 'cancelled' }); b.click('[data-cancel-confirm]'); await tick(); expect(b.view.textContent).toContain('Request cancelled.'); expect(b.view.querySelector('[data-cancel-start]')).toBeNull(); b.click('.m-request-back'); expect(b.view.querySelector('[aria-pressed=true]').dataset.filter).toBe('pending'); expect(b.view.querySelector('[data-request-id]')).toBeNull();
});
it('keeps case details after refresh failure and reports an unavailable notification target without opening the wrong row', async () => {
  const b = boot(); b.render({ id: 42 }); await tick(); b.api.get = async () => { throw new Error('Offline'); }; b.click('[data-refresh-request]'); await tick(); expect(b.view.textContent).toContain('Last loaded details'); expect(b.view.textContent).toContain('SCH-00042'); b.render({ id: 9999 }); expect(b.view.textContent).toContain('not in your latest request list'); expect(b.view.querySelector('[data-cancel-start]')).toBeNull();
});
it('isolates drafts and late submission responses when the account or sign-in changes', async () => {
  const b = boot(), d = deferred(); b.api.send = () => d.promise; await b.review(); b.click('#m-request-submit'); b.setIdentity({ id: 2, employee: { id: 8, name: 'Employee Two' } }); b.render({ type: 'schedule_change' }); await tick(); expect(b.view.querySelector('[data-k=reason]').value).toBe(''); d.resolve({ response: { id: 43, number: 'OLD-ACCOUNT' } }); await tick(); expect(b.view.querySelector('form')).not.toBeNull(); expect(b.view.textContent).not.toContain('OLD-ACCOUNT'); expect(b.view.textContent).not.toContain('Request submitted');
});
it('blocks an unlinked employee and a schedule form with no configured shifts, including a synthetic submit', async () => {
  const b = boot(); b.setIdentity({ id: 1, employee: null }); b.render({ type: 'schedule_change' }); await tick(); expect(b.view.textContent).toContain('not linked'); expect(b.view.querySelector('form')).toBeNull();
  b.setIdentity({ id: 1, employee: { id: 7 } }); b.api.get = async () => [{ ...types[0], fields: types[0]!.fields.map(f => f.key === 'requested_shift_id' ? { ...f, options: [] } : f) }]; b.render({ type: 'schedule_change' }); await tick(); expect(b.view.querySelector('[type=submit]').disabled).toBe(true); b.view.querySelector('form').dispatchEvent(new b.w.Event('submit', { cancelable: true })); expect(b.sends).toHaveLength(0); expect(b.view.textContent).toContain('configure work shifts');
});

it('labels a cancellation saved on a site PC as awaiting cloud confirmation', async () => {
  const b = boot(); b.api.post = async () => ({ ok: true, status: 'cancelled', __syncCommand: crypto.randomUUID() }); b.render({ id: 42 }); await tick(); b.click('[data-cancel-start]'); b.click('[data-cancel-confirm]'); await tick(); expect(b.view.querySelector('.m-request-status b').textContent).toBe('Cancelled on site PC'); expect(b.view.querySelector('.m-request-timeline').textContent).toContain('Cloud confirmation pending'); expect(b.view.querySelector('[data-cancel-start]')).toBeNull();
});
