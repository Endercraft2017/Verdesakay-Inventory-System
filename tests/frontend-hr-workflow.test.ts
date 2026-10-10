import { it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const publicRoot = path.join(import.meta.dirname, '../public');
const read = (file: string) => fs.readFileSync(path.join(publicRoot, file), 'utf8');
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach((d) => d.window.close()));
function boot(module?: string, get: (p: string) => unknown = () => [], permissions: string[] = []) {
  const dom = new JSDOM(
    '<div id="view"></div><div id="modal-root"></div><div id="toast-root"></div>',
    { runScripts: 'outside-only', url: 'https://localhost/' },
  );
  doms.push(dom);
  const w = dom.window as any,
    routes: any = {},
    posts: any[] = [],
    navigations: any[] = [];
  w.App = {
    register: (name: string, fn: any) => (routes[name] = fn),
    hasPermission: (p: string) => permissions.includes(p),
    navigate: (...args: any[]) => navigations.push(args),
  };
  w.API = {
    get: async (p: string) => get(p),
    post: async (...args: any[]) => {
      posts.push(args);
      return { status: args[1]?.decision || 'pending', applied: true };
    },
    put: async (...args: any[]) => {
      posts.push(args);
      return {};
    },
    del: async () => ({}),
  };
  w.eval(read('js/ui.js') + '\nwindow.auditUI=UI;\n' + (module ? read(module) : ''));
  const ui = w.auditUI;
  ui.toast = () => {};
  return { w, ui, routes, posts, navigations, view: w.document.getElementById('view') };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
it('dirty dialogs protect edits on backdrop and Escape, and restore focus after discard', () => {
  const { w, ui } = boot();
  let asked = 0;
  w.confirm = () => {
    asked++;
    return false;
  };
  const trigger = w.document.createElement('button');
  w.document.body.appendChild(trigger);
  trigger.focus();
  const m = ui.modal({
    title: 'Employee',
    bodyHTML: '<input value="Old">',
    confirmText: 'Save',
    onConfirm: () => true,
  });
  const input = m.overlay.querySelector('input');
  input.value = 'New';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  m.overlay.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  expect(m.overlay.isConnected).toBe(true);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(m.overlay.isConnected).toBe(true);
  expect(asked).toBe(2);
  w.confirm = () => true;
  m.overlay.querySelector('[data-close]').click();
  expect(m.overlay.isConnected).toBe(false);
  expect(w.document.activeElement).toBe(trigger);
});
it('confirmation cancellation resolves when dismissed outside or with Escape', async () => {
  const { w, ui } = boot();
  const outside = ui.confirmDialog('Delete?');
  const ov = w.document.querySelector('.modal-overlay');
  ov.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  expect(await outside).toBe(false);
  const escape = ui.confirmDialog('Delete?');
  w.document
    .querySelector('.modal-overlay')
    .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await escape).toBe(false);
});
it('dialogs trap focus and cannot close while a save is pending', async () => {
  const { w, ui } = boot();
  let resolve: any;
  const pending = new Promise((r) => (resolve = r));
  const m = ui.modal({
    title: 'Save',
    bodyHTML: '<input>',
    confirmText: 'Save',
    onConfirm: () => pending,
  });
  expect(m.overlay.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
  const last = m.overlay.querySelector('[data-confirm]');
  last.focus();
  last.dispatchEvent(
    new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  expect(w.document.activeElement).toBe(m.overlay.querySelector('button'));
  last.click();
  m.overlay.querySelector('[data-close]').click();
  expect(m.overlay.isConnected).toBe(true);
  resolve(true);
  await flush();
  expect(m.overlay.isConnected).toBe(false);
});
it('desktop correction review sends the authorized endpoint and preserves decision notes', async () => {
  const { w, routes, posts, view } = boot('js/modules/hr/hr-approvals.js', (p) =>
    p === '/me/approvals'
      ? {
          can_approve: true,
          requests: [],
          time_corrections: [
            {
              id: 7,
              status: 'pending',
              employee_name: 'Ana',
              work_date: '2026-04-01',
              requested_in: '08:00',
              reason: 'Missed punch',
            },
          ],
          history: [],
        }
      : [],
  );
  await routes['hr-approvals'](view);
  view.querySelector('[data-open]').click();
  const ov = w.document.querySelector('.modal-overlay');
  ov.querySelector('#ap-note').value = 'Attendance verified';
  ov.querySelector('[data-confirm]').click();
  await flush();
  expect(posts[0]).toEqual([
    '/me/approvals/time-corrections/7/decide',
    { decision: 'approved', note: 'Attendance verified' },
  ]);
});
it('users without approval authority see no decision controls', async () => {
  const { routes, view } = boot('js/modules/hr/hr-approvals.js', () => ({
    can_approve: false,
    requests: [],
    time_corrections: [],
    history: [],
  }));
  await routes['hr-approvals'](view);
  expect(view.textContent).toContain('No approval authority assigned');
  expect(view.querySelector('[data-open]')).toBeNull();
});
it('recent desktop decisions show the department approver and note', async () => {
  const { w, routes, view } = boot('js/modules/hr/hr-approvals.js', () => ({
    can_approve: true,
    requests: [],
    time_corrections: [],
    history: [
      {
        id: 8,
        kind: 'request',
        status: 'approved',
        form_name: 'Leave',
        employee_name: 'Ana',
        number: 'LV-8',
        data: { decided_by: 'Department Head', decision_note: 'Coverage arranged' },
      },
    ],
  }));
  await routes['hr-approvals'](view);
  view.querySelector('[data-tab="recent"]').click();
  view.querySelector('[data-open]').click();
  const ov = w.document.querySelector('.modal-overlay');
  expect(ov.textContent).toContain('Department Head');
  expect(ov.textContent).toContain('Coverage arranged');
  expect(ov.querySelector('[data-confirm]')).toBeNull();
});
it('read-only employee profiles expose View rather than editing or deletion', async () => {
  const emp = {
    id: 1,
    name: 'Ana',
    employee_no: 'E1',
    status: 'regular',
    leave_days_per_year: 8,
    leave_days_used: 1,
  };
  const { w, routes, view } = boot(
    'js/modules/hr/hr-employees.js',
    (p) => (p.startsWith('/hr/employees?') ? [emp] : []),
    ['hr.view'],
  );
  await routes['hr-employees'](view);
  expect(view.querySelector('[data-del]')).toBeNull();
  expect(view.querySelector('[data-edit]').title).toBe('View employee');
  view.querySelector('[data-edit]').click();
  const ov = w.document.querySelector('.modal-overlay');
  expect(ov.textContent).toContain('Read-only employee record');
  expect(ov.querySelector('[data-confirm]')).toBeNull();
});
it('employee search failures offer a retry instead of leaving Loading visible', async () => {
  let fail = true;
  const { routes, view } = boot(
    'js/modules/hr/hr-employees.js',
    (p) => {
      if (p.startsWith('/hr/employees?') && fail) throw new Error('Disconnected');
      return [];
    },
    ['hr.view'],
  );
  await routes['hr-employees'](view);
  expect(view.textContent).toContain('Couldn’t load employees');
  fail = false;
  view.querySelector('#emp-retry').click();
  await flush();
  expect(view.querySelector('#emp-retry')).toBeNull();
});
it('My HR lets an employee submit corrections on desktop and shows their individual leave bank', async () => {
  const { w, routes, posts, view } = boot('js/modules/hr/hr-requests.js', (p) =>
    p === '/me'
      ? { employee: { name: 'Ana', leave_days_remaining: 7.5, leave_days_per_year: 9 } }
      : [],
  );
  await routes['hr-requests'](view);
  expect(view.textContent).toContain('7.5 days');
  view.querySelector('[data-tab="corrections"]').click();
  view.querySelector('#myhr-new').click();
  const ov = w.document.querySelector('.modal-overlay');
  ov.querySelector('#myhr-date').value = '2026-04-01';
  ov.querySelector('#myhr-in').value = '08:00';
  ov.querySelector('#myhr-reason').value = 'Missed punch';
  ov.querySelector('[data-confirm]').click();
  await flush();
  expect(posts[0]).toEqual([
    '/me/time-corrections',
    { work_date: '2026-04-01', requested_in: '08:00', requested_out: null, reason: 'Missed punch' },
  ]);
});
it('slug failures keep the requested destination and offer retry', async () => {
  const { routes, navigations, view } = boot('js/modules/core/form-records.js', () => []);
  await routes['form-records'](view, { slug: 'leave_request' });
  expect(view.textContent).toContain('Couldn’t open the requested form');
  view.querySelector('#fr-retry-destination').click();
  expect(navigations[0]).toEqual(['form-records', { slug: 'leave_request' }]);
});
it('late route responses cannot overwrite the current page', async () => {
  const { w } = boot();
  w.eval(
    read('js/nav-config.js') +
      '\n' +
      read('js/app.js').replace(
        "document.addEventListener('DOMContentLoaded', () => App.boot());",
        '',
      ) +
      '\nwindow.router=App;',
  );
  let resolve: any;
  const pending = new Promise((r) => (resolve = r));
  w.router.register('dashboard', async (view: any) => {
    await pending;
    view.textContent = 'Late response';
  });
  w.router.register('hr-approvals', (view: any) => {
    view.textContent = 'Current approvals';
  });
  w.router.navigate('dashboard');
  w.router.navigate('hr-approvals');
  resolve();
  await flush();
  expect(w.document.getElementById('view').textContent).toBe('Current approvals');
});
it('successful modal actions can navigate after saving, while cancelled navigation retains edits', async () => {
  const { w, ui } = boot();
  w.confirm = () => false;
  w.eval(
    read('js/nav-config.js') +
      '\n' +
      read('js/app.js').replace(
        "document.addEventListener('DOMContentLoaded', () => App.boot());",
        '',
      ) +
      '\nwindow.router=App;',
  );
  w.router.register('dashboard', (v: any) => (v.textContent = 'Dashboard'));
  w.router.register('hr-approvals', (v: any) => (v.textContent = 'Approvals'));
  w.router.navigate('dashboard');
  const m = ui.modal({
    title: 'Edit',
    bodyHTML: '<input>',
    confirmText: 'Save',
    onConfirm: () => {
      w.router.navigate('hr-approvals');
      return true;
    },
  });
  const input = m.overlay.querySelector('input');
  input.value = 'edit';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.location.hash = '#/hr-approvals';
  w.router.navigate('hr-approvals');
  expect(w.document.getElementById('view').textContent).toBe('Dashboard');
  expect(w.location.hash).toBe('#dashboard');
  m.overlay.querySelector('[data-confirm]').click();
  await flush();
  expect(w.document.getElementById('view').textContent).toBe('Approvals');
});

it('cutoff deep links from Home retain HR chrome and section styling', () => {
  const { w } = boot();
  w.document.body.insertAdjacentHTML('beforeend', '<div id="tree-nav"></div>');
  w.UI = w.auditUI;
  w.eval(read('js/nav-config.js') + '\n' + read('js/app.js').replace("document.addEventListener('DOMContentLoaded', () => App.boot());", '') + '\nwindow.router=App;');
  w.router.register('dashboard', (view: any) => { view.textContent = 'Home'; });
  w.router.register('hr-timekeeping', (view: any) => { view.textContent = 'Cutoff'; });
  w.router.navigate('dashboard');
  w.router.navigate('hr-timekeeping', { period_id: 123, employee_id: 4 });
  expect(w.document.getElementById('view').dataset.section).toBe('hr');
  expect(w.document.querySelector('.tree-leaf.active')?.dataset.route).toBe('hr-timekeeping');
  expect(w.location.hash).toBe('#hr-timekeeping?period_id=123&employee_id=4');
});
