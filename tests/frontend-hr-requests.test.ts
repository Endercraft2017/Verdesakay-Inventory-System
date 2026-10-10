import { it, expect, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '../public');
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach(d => d.window.close()));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
const types = [
  { slug: 'leave_request', fields: [{ key: 'date_from', label: 'From', type: 'date', required: true }, { key: 'date_to', label: 'To', type: 'date', required: true }, { key: 'days', label: 'Days', type: 'number', required: true }, { key: 'with_pay', label: 'With pay', type: 'select', options: ['Yes', 'No'], required: true }] },
  { slug: 'halfday_request', fields: [{ key: 'date', label: 'Date', type: 'date', required: true }, { key: 'session', label: 'Session', type: 'select', options: ['Morning (AM)', 'Afternoon (PM)'], required: true }] },
  { slug: 'offset_form', fields: [{ key: 'work_date', label: 'Date', type: 'date', required: true }, { key: 'new_time_in', label: 'Time in', type: 'time' }, { key: 'new_time_out', label: 'Time out', type: 'time', required: true }] },
].map((t, i) => ({ ...t, id: 10 + i, name: t.slug, fields: [{ key: 'employee_name', label: 'Employee', type: 'employee', required: true }, ...t.fields, { key: 'reason', label: 'Reason', type: 'textarea', required: true }] }));
function boot(mobile: boolean, type: typeof types[number], linked = true) {
  const d = new JSDOM('<main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/' });doms.push(d);
  const w = d.window as any, routes: any = {}, posts: any[] = [], errors: string[] = [];
  const employee = linked ? { id: 7, name: 'Employee One', leave_days_remaining: 8 } : null;
  w.API = { get: async (p: string) => p === '/me' ? { employee } : p === '/me/request-types' ? [type] : [], post: async (...args: any[]) => { posts.push(args);return { id: 1 }; } };
  if (mobile) {
    w.MApp = { route: (k: string, fn: any) => routes[k] = fn, setTitle() {}, getMe: () => ({ employee }) };
    w.mEsc = (x: unknown) => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    w.mEl = (html: string) => { const box = w.document.createElement('div');box.innerHTML = html;return box.firstElementChild; };
    w.mToast = (msg: string) => errors.push(msg);
    w.eval(fs.readFileSync(path.join(root, 'mobile/modules/hr/requests.js'), 'utf8'));
  } else {
    w.App = { register: (k: string, fn: any) => routes[k] = fn };
    w.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'js/modules/hr/hr-requests.js'), 'utf8'));
  }
  return { w, routes, posts, errors, view: w.document.querySelector('#view') };
}
function fill(w: any, selector: string) {
  for (const el of w.document.querySelectorAll(selector)) {
    el.value = el.type === 'select-one' ? el.options[1].value : el.type === 'date' ? '2026-10-09' : el.type === 'time' ? '18:00' : el.type === 'number' ? '1' : 'Medical appointment';
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
}
it.each(types)('mobile $slug requires details and preserves them when editing the review', async type => {
  const { w, routes, posts, errors, view } = boot(true, type);
  routes.requests(view, { type: type.slug });await flush();
  expect(w.document.querySelector('[data-k="employee_name"]')).toBeNull();
  view.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(errors.length).toBeGreaterThan(0);expect(posts).toHaveLength(0);
  fill(w, '[data-k]');
  view.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(view.textContent).toContain('Medical appointment');
  view.querySelector('.m-request-back').click();
  expect(view.querySelector('[data-k="reason"]').value).toBe('Medical appointment');
  for (const field of type.fields.filter(f => f.key !== 'employee_name')) expect(view.querySelector('[data-k="'+field.key+'"]').value).not.toBe('');
  view.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  view.querySelector('#m-request-submit').click();await flush();
  expect(posts).toHaveLength(1);expect(posts[0][1]).toMatchObject({ form_def_id: type.id, status: 'pending', data: { employee_name: 'Employee One', reason: 'Medical appointment' } });
});
it.each(types)('desktop $slug renders configured details and submits a pending self request', async type => {
  const { w, routes, posts, view } = boot(false, type);
  await routes['hr-requests'](view);view.querySelector('#myhr-new').click();w.document.querySelector('[data-type]').click();
  for (const field of type.fields.filter(f => f.key !== 'employee_name')) expect([...w.document.querySelectorAll('.modal label')].some((x: any) => x.textContent.includes(field.label))).toBe(true);
  fill(w, '[data-field]');w.document.querySelector('[data-confirm]').click();await flush();
  expect(posts).toHaveLength(1);expect(posts[0][1]).toMatchObject({ form_def_id: type.id, status: 'pending', data: { employee_name: 'Employee One', reason: 'Medical appointment' } });
});
it('mobile explains an unlinked account instead of presenting an empty employee picker', async () => {
  const { routes, view, posts } = boot(true, types[0]!, false);routes.requests(view, { type: 'leave_request' });await flush();
  expect(view.textContent).toContain('not linked');expect(view.querySelector('form')).toBeNull();expect(posts).toHaveLength(0);
});
