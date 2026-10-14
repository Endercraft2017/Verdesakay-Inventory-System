/** HR desktop UX: Time Keeping cutoff list + roster (hr-timekeeping.js) and the Payroll
    form-records list (form-records.js payroll branch). Loads the real ui.js and view script into
    jsdom with a stubbed App/API, then drives the rendered DOM: keyboard-reachable row entry
    points, local filtering + reset, error -> retry recovery, per-role controls, and a check that
    an ordinary (non-payroll) form keeps its original toolbar. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
const TK_SRC = fs.readFileSync(path.join(PUBLIC, 'js', 'modules', 'hr', 'hr-timekeeping.js'), 'utf8');
const FR_SRC = fs.readFileSync(path.join(PUBLIC, 'js', 'modules', 'core', 'form-records.js'), 'utf8');

type GetHandler = (p: string) => unknown;

function boot(src: string, perms: string[], get: GetHandler) {
  const dom = new JSDOM('<!doctype html><html><body><div id="view"></div><div id="modal-root"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://localhost/' });
  const win = dom.window as unknown as Record<string, any>;
  const routes: Record<string, (view: HTMLElement, filter?: unknown) => Promise<void>> = {};
  const navigations: Array<[string, unknown]> = [];
  const gets: string[] = [];
  const toasts: string[] = [];
  win.App = {
    register: (name: string, fn: (view: HTMLElement, filter?: unknown) => Promise<void>) => { routes[name] = fn; },
    hasPermission: (p: string) => perms.includes(p),
    navigate: (route: string, filter?: unknown) => { navigations.push([route, filter]); },
  };
  win.API = {
    get: (p: string) => {
      gets.push(p);
      try { return Promise.resolve(get(p)); } catch (e) { return Promise.reject(e); }
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
    download: () => Promise.resolve(),
  };
  // One script, as in frontend-mobile.test.ts: top-level `const UI` isn't shared across evals.
  win.eval(`${UI_SRC}\n${fs.readFileSync(path.join(PUBLIC, "js/lib/data-forms.js"), "utf8")}\nwindow.__UI = UI;\n${fs.readFileSync(path.join(PUBLIC, "js/leave-dates.js"), "utf8")}\n${src}`);
  const UI = win.__UI;
  UI.toast = (msg: string) => { toasts.push(msg); };
  UI.confirmDialog = () => Promise.resolve(false);
  UI.modal = () => ({ close() {} });
  const view = win.document.getElementById('view') as HTMLElement;
  return { win, view, routes, navigations, gets, toasts };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const q = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement | null;
const qa = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
function setValue(el: HTMLElement | null, value: string, type = 'input') {
  const input = el as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new input.ownerDocument.defaultView!.Event(type, { bubbles: true }));
}

const CUTOFFS = [
  { id: 3, label: 'March 1-15', start_date: '2026-03-01', end_date: '2026-03-15', employee_count: 4 },
  { id: 2, label: 'February 16-28', start_date: '2026-02-16', end_date: '2026-02-28', employee_count: 4 },
  { id: 1, label: 'December 16-31', start_date: '2025-12-16', end_date: '2025-12-31', employee_count: 3 },
];

describe('Time Keeping cutoff list', () => {
  it('leads with a heading, one primary action, and rare tools behind an inline disclosure', async () => {
    const { view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage', 'payroll.view'], () => CUTOFFS);
    await routes['hr-timekeeping']!(view, {});
    await flush();
    expect(q(view, '.topbar h2')!.textContent).toBe('Time Keeping');
    expect(q(view, '.topbar .sub')!.textContent).toMatch(/cutoffs/i);
    expect(qa(view, '.topbar .btn:not(.secondary)').map((b) => b.id)).toEqual(['tk-new']);

    const toggle = q(view, '#tk-tools-toggle')!;
    const tools = q(view, '#tk-tools')!;
    expect(toggle.getAttribute('aria-controls')).toBe('tk-tools');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(tools.hidden).toBe(true);
    for (const id of ['tk-holidays', 'tk-noWork', 'tk-punchlog', 'tk-policy', 'tk-govforms']) {
      expect(tools.querySelector('#' + id), id).not.toBeNull();
    }
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(tools.hidden).toBe(false);
    toggle.click();
    expect(tools.hidden).toBe(true);
  });

  it('opens a cutoff from a focusable button in the row, and labels the icon-only delete', async () => {
    const { view, routes, navigations } = boot(TK_SRC, ['hr.view', 'hr.manage'], () => CUTOFFS);
    await routes['hr-timekeeping']!(view, {});
    await flush();
    const opener = q(view, 'tr[data-open="2"] .hr-row-open') as HTMLButtonElement;
    expect(opener.tagName).toBe('BUTTON');
    expect(opener.type).toBe('button');
    expect(opener.textContent).toBe('February 16-28');
    opener.click(); // Enter/Space on a native button fires click
    expect(navigations).toEqual([['hr-timekeeping', { period_id: '2' }]]);

    const del = q(view, 'tr[data-open="3"] [data-del]')!;
    expect(del.getAttribute('aria-label')).toBe('Delete cutoff March 1-15');
    expect(q(view, 'label[for="tk-search"]')).not.toBeNull();
  });

  it('filters by search and year locally, with Reset and a no-match Clear filters', async () => {
    const { view, routes, gets } = boot(TK_SRC, ['hr.view', 'hr.manage'], () => CUTOFFS);
    await routes['hr-timekeeping']!(view, {});
    await flush();
    const rows = () => qa(view, '#tk-table tr[data-open]').map((r) => r.dataset.open);
    expect(rows()).toEqual(['3', '2', '1']);
    expect(q(view, '#tk-count')!.textContent).toBe('3 cutoffs');
    expect(q(view, '#tk-filter-reset')!.hidden).toBe(true);
    expect(qa(view, '#tk-year option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', '2026', '2025']);

    setValue(q(view, '#tk-search'), 'march');
    expect(rows()).toEqual(['3']);
    expect(q(view, '#tk-count')!.textContent).toBe('1 of 3 cutoffs');
    expect(q(view, '#tk-filter-reset')!.hidden).toBe(false);

    q(view, '#tk-filter-reset')!.click();
    expect(rows()).toEqual(['3', '2', '1']);
    expect((q(view, '#tk-search') as HTMLInputElement).value).toBe('');

    setValue(q(view, '#tk-year'), '2025', 'change');
    expect(rows()).toEqual(['1']);
    setValue(q(view, '#tk-search'), 'march');
    expect(rows()).toEqual([]);
    expect(q(view, '#tk-table .empty-title')!.textContent).toMatch(/No cutoffs match/);
    q(view, '#tk-clear-filters')!.click();
    expect(rows()).toEqual(['3', '2', '1']);
    expect((q(view, '#tk-year') as HTMLSelectElement).value).toBe('');
    // Filtering never re-fetched.
    expect(gets.filter((p) => p === '/hr/periods')).toHaveLength(1);
  });

  it('shows a retryable error instead of hanging on Loading', async () => {
    let fail = true;
    const { view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage'], () => {
      if (fail) throw new Error('Network down');
      return CUTOFFS;
    });
    await routes['hr-timekeeping']!(view, {});
    await flush();
    expect(q(view, '#tk-table .empty-title')!.textContent).toBe('Couldn’t load cutoffs');
    expect(q(view, '#tk-table .empty-hint')!.textContent).toBe('Network down');
    expect(q(view, '#tk-filters')!.hidden).toBe(true);
    fail = false;
    q(view, '#tk-retry')!.click();
    await flush();
    expect(qa(view, '#tk-table tr[data-open]')).toHaveLength(3);
    expect(q(view, '#tk-filters')!.hidden).toBe(false);
  });

  it('read-only HR viewers get the list and tools but no create/delete', async () => {
    const { view, routes } = boot(TK_SRC, ['hr.view'], () => CUTOFFS);
    await routes['hr-timekeeping']!(view, {});
    await flush();
    expect(q(view, '#tk-new')).toBeNull();
    expect(q(view, '#tk-govforms')).toBeNull(); // payroll.view only
    expect(q(view, '#tk-holidays')).not.toBeNull();
    expect(qa(view, '[data-del]')).toHaveLength(0);
    expect(qa(view, '#tk-table tr[data-open] .hr-row-open')).toHaveLength(3);

    const empty = boot(TK_SRC, ['hr.view'], () => []);
    await empty.routes['hr-timekeeping']!(empty.view, {});
    await flush();
    expect(q(empty.view, '#tk-table .empty-title')!.textContent).toBe('No cutoffs yet');
    expect(q(empty.view, '#tk-empty-new')).toBeNull();
    expect(q(empty.view, '#tk-filters')!.hidden).toBe(true);
  });
});

const PERIOD = {
  id: 7, label: 'March 1-15', start_date: '2026-03-01', end_date: '2026-03-15',
  roster: [
    { employee_id: 11, user_id: 5, name: 'Ana Cruz', department_name: 'Assembly', status: 'regular', daily_rate: 700, days_logged: 9, days_total: 11, days_incomplete: 1 },
    { employee_id: 12, user_id: null, name: 'Ben Reyes', department_name: 'Assembly', status: 'probationary', daily_rate: 650, days_logged: 0, days_total: 11, days_incomplete: 0 },
    { employee_id: 13, user_id: 6, name: 'Cara Lim', department_name: 'Warehouse', status: 'regular', daily_rate: 680, days_logged: 11, days_total: 11, days_incomplete: 0 },
  ],
};
const periodGet: GetHandler = (p) => (p === '/hr/periods/7' ? PERIOD : []);

describe('Time Keeping cutoff roster', () => {
  it.each([false, true])('daily time permits edits only for HR managers (manage=%s)', async (manage) => {
    const { win, view, routes } = boot(TK_SRC, manage ? ['hr.view', 'hr.manage'] : ['hr.view'], (p) => {
      if (p.startsWith('/hr/requests/eligible')) return [];
    if (p.includes('/attendance?')) return [{ work_date: '2026-03-02', time_in: '08:00', time_out: '17:00', notes: 'Preview' }];
      if (p === '/hr/payroll-policy') return { default_rest_days: [0, 6] };
      return periodGet(p);
    });
    let modal: any;
    let writes = 0;
    win.API.put = async () => { writes++; return {}; };
    const overlay = view.ownerDocument.createElement('div');
    win.__UI.modal = (options: any) => {
      modal = options;
      overlay.innerHTML = options.bodyHTML;
      options.onOpen?.(overlay);
      return { close() {} };
    };
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    q(view, '.hr-row-open')!.click();
    await flush();
    expect(modal.confirmText).toBe(manage ? 'Save' : null);
    expect(Boolean(modal.headActionHTML)).toBe(manage);
    const fields = Array.from(overlay.querySelectorAll<HTMLInputElement>('input, select, textarea'));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.disabled === !manage)).toBe(true);
    expect((q(overlay, '[data-link]') as HTMLButtonElement).hidden).toBe(!manage);
    if (!manage) {
      await modal.onConfirm();
      expect(writes).toBe(0);
    }
    win.close();
  });

  it('managers get grouped cutoff tools, a primary Generate Payslips, and labelled row controls', async () => {
    const { view, routes, gets } = boot(TK_SRC, ['hr.view', 'hr.manage', 'payroll.view', 'payroll.manage'], periodGet);
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    await flush();
    expect(q(view, '#tk-period-title')!.textContent).toBe('March 1-15');
    expect(q(view, '#tk-period-sub')!.textContent).toBe('2026-03-01 – 2026-03-15 · 3 employees on roster');
    expect(qa(view, '.topbar .btn:not(.secondary)').map((b) => b.id)).toEqual(['tk-generate']);
    const more = q(view, '#tk-more')!;
    expect(more.hidden).toBe(true);
    for (const id of ['tk-edit-period', 'tk-import-punches', 'tk-post-gl']) expect(more.querySelector('#' + id), id).not.toBeNull();
    q(view, '#tk-more-toggle')!.click();
    expect(more.hidden).toBe(false);

    expect(q(view, '.tk-roster-chk[data-emp="11"]')!.getAttribute('aria-label')).toBe('Select Ana Cruz');
    expect(q(view, '[data-rm="12"]')!.getAttribute('aria-label')).toBe('Remove Ben Reyes from cutoff');
    expect(q(view, '[data-notify="11"]')!.getAttribute('aria-label')).toMatch(/Ana Cruz/);
    expect(q(view, 'label[for="tk-roster-search"]')).not.toBeNull();

    const opener = q(view, 'tr[data-open="13"] .hr-row-open') as HTMLButtonElement;
    expect(opener.tagName).toBe('BUTTON');
    opener.click();
    await flush();
    expect(gets).toContain('/hr/periods/7/attendance?employee_id=13');
  });

  it('filters the roster by name and by Show, with Reset back to the defaults', async () => {
    const { view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage', 'payroll.view'], periodGet);
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    await flush();
    const rows = () => qa(view, '#tk-roster tr[data-open]').map((r) => r.dataset.open);
    expect(rows()).toEqual(['11', '12', '13']);
    expect(q(view, '#tk-roster-count')!.textContent).toBe('3 employees');
    expect((q(view, '#tk-roster-reset') as HTMLButtonElement).disabled).toBe(true);

    setValue(q(view, '#tk-roster-show'), 'incomplete', 'change');
    expect(rows()).toEqual(['11']);
    expect(q(view, '#tk-roster-count')!.textContent).toBe('1 of 3 employees');
    setValue(q(view, '#tk-roster-show'), 'unlogged', 'change');
    expect(rows()).toEqual(['12']);
    expect((q(view, '#tk-roster-reset') as HTMLButtonElement).disabled).toBe(false);

    setValue(q(view, '#tk-roster-search'), 'zzz');
    expect(rows()).toEqual([]);
    q(view, '#tk-roster-clear')!.click();
    expect(rows()).toEqual(['11', '12', '13']);
    expect((q(view, '#tk-roster-show') as HTMLSelectElement).value).toBe('');

    setValue(q(view, '#tk-roster-group'), 'none', 'change');
    (q(view, '.tk-roster-chk[data-emp="11"]') as HTMLInputElement).checked = true;
    const toolbar = q(view, '.tk-roster-filters');
    q(view, '#tk-roster-sort-dir')!.click();
    expect(q(view, '.tk-roster-filters')).toBe(toolbar);
    expect(q(view, '#tk-roster-sort-dir')!.textContent).toBe('Z–A');
    expect((q(view, '.tk-roster-chk[data-emp="11"]') as HTMLInputElement).checked).toBe(true);
    expect(q(view, '#tk-roster-reset')!.hidden).toBe(false);
    expect(rows()).toEqual(['13', '12', '11']);
    expect(q(view, '#tk-roster-sort-dir')!.getAttribute('aria-label')).toBe('Sort ascending');
    q(view, '#tk-roster-reset')!.click();
    expect(rows()).toEqual(['11', '12', '13']);
    expect((q(view, '#tk-roster-group') as HTMLSelectElement).value).toBe('department');
    expect((q(view, '#tk-roster-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('read-only viewers keep the roster and CSV export without write controls or pay rates', async () => {
    const { view, routes } = boot(TK_SRC, ['hr.view'], periodGet);
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    await flush();
    for (const sel of ['#tk-add-emp', '#tk-remove-selected', '#tk-more-toggle', '#tk-more', '#tk-generate', '#tk-edit-period', '.tk-roster-chk', '[data-rm]', '[data-notify]']) {
      expect(q(view, sel), sel).toBeNull();
    }
    expect(q(view, '#tk-export-csv')).not.toBeNull();
    expect(qa(view, '.tk-roster-table thead th')).toHaveLength(5);
    expect(qa(view, '.tk-roster-table col')).toHaveLength(5);
    expect(q(view, 'tr.tk-group-row td')!.getAttribute('colspan')).toBe('5');
    expect(q(view, '#tk-roster-sort option[value="daily_rate"]')).toBeNull();
  });

  it('distinguishes a missing cutoff from a failed load, and retries the latter', async () => {
    let mode: 'missing' | 'down' | 'ok' = 'missing';
    const get: GetHandler = (p) => {
      if (mode === 'missing') throw Object.assign(new Error('Not found'), { status: 404 });
      if (mode === 'down') throw new Error('Network down');
      return periodGet(p);
    };
    const { view, routes, navigations } = boot(TK_SRC, ['hr.view'], get);
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    await flush();
    expect(q(view, '.empty-title')!.textContent).toBe('Cutoff not found');
    expect(q(view, '#tk-retry')).toBeNull();
    q(view, '#tk-back')!.click();
    expect(navigations).toEqual([['hr-timekeeping', undefined]]);

    mode = 'down';
    await routes['hr-timekeeping']!(view, { period_id: 7 });
    await flush();
    expect(q(view, '.empty-title')!.textContent).toBe('Couldn’t load this cutoff');
    mode = 'ok';
    q(view, '#tk-retry')!.click();
    await flush();
    expect(qa(view, '#tk-roster tr[data-open]')).toHaveLength(3);
  });
});

const PAYROLL_FORM = {
  id: 40, slug: 'hr_payroll', name: 'HR Payroll', scope: 'hr', icon: 'sheet', template_id: null,
  fields: [{ key: 'employee_name', label: 'Employee' }, { key: 'department', label: 'Department' }],
  actions: [],
};
const PAYSLIPS = [
  { id: 101, number: 'PAY-0001', status: 'approved', period: 'March 1-15', created_at: '2026-03-16T00:00:00Z', data: { employee_name: 'Ana Cruz', net_pay: 5000 } },
  { id: 102, number: 'PAY-0002', status: 'paid', period: 'February 16-28', created_at: '2026-03-01T00:00:00Z', data: { employee_name: 'Ben Reyes', net_pay: 4500 } },
];

function payrollGet(records: () => unknown) {
  return (p: string) => {
    if (p === '/form-definitions/40') return PAYROLL_FORM;
    if (p.startsWith('/form-definitions/40/records')) return records();
    if (p === '/form-definitions/40/periods') return ['March 1-15', 'February 16-28'];
    if (p === '/hr/periods') return [];
    // The detail modal's own error path is enough to prove the row opened it.
    if (/^\/hr\/payroll\/\d+\/detail$/.test(p)) throw new Error('detail not stubbed');
    return {};
  };
}

describe('Payroll records list', () => {
  it('separates heading, filters and print/export; payroll.view readers get no write controls', async () => {
    const { view, routes } = boot(FR_SRC, ['payroll.view'], payrollGet(() => PAYSLIPS));
    await routes['form-records']!(view, { form_id: 40, period: 'March 1-15' });
    await flush();
    expect(q(view, '.topbar h2')!.textContent).toBe('HR Payroll');
    for (const sel of ['#fr-new', '#fr-more-toggle', '#fr-import-csv', '#fr-del-all', '#fr-bulk-status', '#fr-bulk-del', '[data-edit]', '[data-del]']) {
      expect(q(view, sel), sel).toBeNull();
    }
    const filters = q(view, '.hr-filters-bar')!;
    for (const id of ['fr-search', 'fr-status', 'fr-period', 'fr-print-slips', 'fr-print-summary', 'fr-download-csv']) {
      expect(filters.querySelector('#' + id), id).not.toBeNull();
      if (['fr-search', 'fr-status', 'fr-period'].includes(id)) expect(q(view, `label[for="${id}"]`), id).not.toBeNull();
    }
    expect(q(view, '#fr-bulk-print')).not.toBeNull();
  });

  it('managers reach import/cleanup through the disclosure, and Reset clears every filter', async () => {
    const { view, routes, gets } = boot(FR_SRC, ['payroll.view', 'payroll.manage'], payrollGet(() => PAYSLIPS));
    await routes['form-records']!(view, { form_id: 40, period: 'March 1-15' });
    await flush();
    expect(qa(view, '.topbar .btn:not(.secondary)').map((b) => b.id)).toEqual(['fr-new']);
    const more = q(view, '#fr-more')!;
    expect(more.hidden).toBe(true);
    q(view, '#fr-more-toggle')!.click();
    expect(more.hidden).toBe(false);
    expect(more.querySelector('#fr-import-csv')).not.toBeNull();
    expect(more.querySelector('#fr-del-all')).not.toBeNull();
    expect(q(view, '[data-del="101"]')!.getAttribute('aria-label')).toBe('Delete payslip PAY-0001');

    expect(q(view, '#fr-filter-reset')!.hidden).toBe(false); // arrived filtered to a period
    setValue(q(view, '#fr-status'), 'approved', 'change');
    await flush();
    q(view, '#fr-filter-reset')!.click();
    await flush();
    expect(gets.filter((p) => p.startsWith('/form-definitions/40/records')).pop()).toBe('/form-definitions/40/records?');
    expect((q(view, '#fr-status') as HTMLSelectElement).value).toBe('');
    expect((q(view, '#fr-period') as HTMLInputElement).value).toBe('All periods');
    expect(q(view, '#fr-filter-reset')!.hidden).toBe(true);
  });

  it('Period is a type-to-search box: typing filters the list, picking one reloads that period', async () => {
    const { view, routes, gets } = boot(FR_SRC, ['payroll.view'], payrollGet(() => PAYSLIPS));
    await routes['form-records']!(view, { form_id: 40 });
    await flush();
    const input = q(view, '#fr-period') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.value).toBe('All periods');
    const win = input.ownerDocument.defaultView!;
    input.dispatchEvent(new win.Event('focus'));
    setValue(input, 'feb', 'input');
    const options = qa(view, '#fr-period-combo .combo-option');
    expect(options.map((o) => o.textContent)).toEqual(['February 16-28']);
    options[0]!.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect(gets.filter((p) => p.startsWith('/form-definitions/40/records')).pop())
      .toBe('/form-definitions/40/records?period=February+16-28');
    expect(input.value).toBe('February 16-28');
    expect(q(view, '#fr-filter-reset')!.hidden).toBe(false);
  });

  it('opens a payslip from a focusable row button and toggles period bundles from a real disclosure button', async () => {
    const { view, routes, gets } = boot(FR_SRC, ['payroll.view'], payrollGet(() => PAYSLIPS));
    await routes['form-records']!(view, { form_id: 40 });
    await flush();
    const toggles = qa(view, '.payroll-bundle-toggle');
    expect(toggles).toHaveLength(2);
    const firstOpen = toggles.find((t) => t.getAttribute('aria-expanded') === 'true')!;
    const closed = toggles.find((t) => t.getAttribute('aria-expanded') === 'false')!;
    expect(view.querySelector('#' + firstOpen.getAttribute('aria-controls'))!.hasAttribute('hidden')).toBe(false);
    const closedBody = closed.getAttribute('aria-controls')!;
    closed.click();
    const reopened = qa(view, '.payroll-bundle-toggle').find((t) => t.getAttribute('aria-controls') === closedBody)!;
    expect(reopened.getAttribute('aria-expanded')).toBe('true');
    expect(view.ownerDocument.activeElement).toBe(reopened);

    const opener = q(view, 'tr[data-id="101"] .hr-row-open') as HTMLButtonElement;
    expect(opener.tagName).toBe('BUTTON');
    opener.click();
    await flush();
    expect(gets).toContain('/hr/payroll/101/detail');
  });

  it('shows a retryable error and a filtered empty state with one-step recovery', async () => {
    let mode: 'down' | 'empty' | 'ok' = 'down';
    const { view, routes } = boot(FR_SRC, ['payroll.view'], payrollGet(() => {
      if (mode === 'down') throw new Error('Network down');
      return mode === 'empty' ? [] : PAYSLIPS;
    }));
    await routes['form-records']!(view, { form_id: 40, period: 'March 1-15' });
    await flush();
    expect(q(view, '#fr-load-error')!.textContent).toContain('Could not load records. Network down');
    mode = 'empty';
    q(view, '#fr-load-error button')!.click();
    await flush();
    expect(q(view, '#fr-table .empty-title')!.textContent).toBe('No payslips match these filters');
    expect(q(view, '#fr-empty-new')).toBeNull();
    mode = 'ok';
    q(view, '#fr-empty-clear')!.click();
    await flush();
    expect(qa(view, '.payroll-bundle')).toHaveLength(2);
  });
});

describe('Ordinary form records are unaffected', () => {
  it('keeps the original single toolbar, write controls and plain row numbers', async () => {
    const form = { id: 9, slug: 'hr_notice', name: 'HR Notice', scope: 'hr', icon: 'file', template_id: null, fields: [{ key: 'reason', label: 'Reason' }], actions: [] };
    const records = [{ id: 1, number: 'LR-0001', status: 'pending', period: null, created_at: '2026-03-02T00:00:00Z', data: { reason: 'Sick' } }];
    const { view, routes } = boot(FR_SRC, ['forms.manage.hr'], (p) => (p === '/form-definitions/9' ? form : records));
    await routes['form-records']!(view, { form_id: 9 });
    await flush();
    const topbar = q(view, '.topbar')!;
    for (const id of ['fr-back', 'fr-search', 'fr-status', 'fr-download-csv', 'fr-del-all', 'fr-new']) {
      expect(topbar.querySelector('#' + id), id).not.toBeNull();
    }
    expect(q(view, '#fr-download-csv')!.textContent).toMatch(/Download CSV/);
    for (const sel of ['.hr-filters', '#fr-period', '#fr-more-toggle', '#fr-filter-reset', '.hr-row-open']) {
      expect(q(view, sel), sel).toBeNull();
    }
    expect(q(view, 'tr[data-id="1"] strong')!.textContent).toBe('LR-0001');
    expect(q(view, '[data-edit="1"]')).not.toBeNull();
    expect(q(view, '[data-del="1"]')).not.toBeNull();
    expect(q(view, '#fr-bulk-status')).not.toBeNull();
    expect(q(view, '#fr-bulk-del')).not.toBeNull();
  });
});

it.each(['leave_request', 'halfday_request', 'offset_form', 'overtime_request', 'undertime_request', 'lunch_offset_form', 'rest_day_work_request', 'rest_day_change', 'reported_absence'])('Timekeeping %s retains configured details, requires a reason and shows its real status', async (slug) => {
  const form = { id: 40, slug, name: 'Configured request', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }, { key: 'contact', label: 'Contact during absence', type: 'text', required: true }] };
  const { win, view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage', 'forms.manage.hr'], p => {
    if (p.startsWith('/hr/requests/eligible')) return [];
    if (p.includes('/attendance?')) return [{ work_date: '2026-03-02', time_in: '08:00', time_out: '17:00', notes: '' }];
    if (p === '/hr/payroll-policy') return { default_rest_days: [0, 6] };
    if (p === '/form-definitions') return [form];
    return periodGet(p);
  });
  const modals: HTMLElement[] = [];
  const posts: any[] = [];
  win.API.post = async (path: string, body: any) => { if (path === '/hr/leave-preview') return { days: 1, remaining: 8, warnings: [] }; posts.push({ path, body }); return { id: 50, number: 'REQ-50' }; };
  win.__UI.modal = (options: any) => {
    const overlay = win.document.createElement('div');
    overlay.innerHTML = (options.headActionHTML || '') + options.bodyHTML;
    win.document.body.appendChild(overlay);
    modals.push(overlay);
    options.onOpen?.(overlay);
    return { overlay, close() { overlay.remove(); } };
  };
  await routes['hr-timekeeping']!(view, { period_id: 7 });
  q(view, '.hr-row-open')!.click();await flush();
  q(modals[0]!, '[data-link]')!.click();await flush();
  const modal = modals[1]!;
  setValue(q(modal, '#mf-type'), slug, 'change');
  expect(q(modal, 'textarea[data-mf="reason"]')).not.toBeNull();
  expect(q(modal, '[data-mf="contact"]')).not.toBeNull();
  for (const input of qa(modal, '[data-mf]') as HTMLInputElement[]) {
    if (input.dataset.mf === 'reason') continue;
    input.value = input.type === 'select-one' ? (input as unknown as HTMLSelectElement).options[1]!.value : input.type === 'date' ? '2026-03-03' : input.type === 'time' ? '18:00' : input.type === 'number' ? '1' : 'Emergency contact';
  }
  q(modal, '#mf-create')!.click();await flush();
  expect(posts).toHaveLength(0);
  expect(q(modal, '#mf-err')!.textContent).toContain('Reason is required');
  setValue(q(modal, '[data-mf="reason"]'), 'Medical appointment');
  q(modal, '#mf-create')!.click();await flush();
  expect(posts).toHaveLength(1);
  expect(posts[0].body.data).toMatchObject({ employee_id: 11, employee_name: 'Ana Cruz', reason: 'Medical appointment', contact: 'Emergency contact' });
  expect(posts[0].body.status).toBe(slug === 'reported_absence' ? 'approved' : 'pending');
  if (slug === 'leave_request') expect(posts[0].body.data).toMatchObject({ date_from: '2026-03-02', date_to: '2026-03-02', leave_dates: '2026-03-02' });
  if (slug === 'halfday_request') expect(qa(modals[0]!, '.badge-pill.status-confirmed').some(b => b.textContent?.includes('Half Day (AM)'))).toBe(false);
  win.close();
});

it('Timekeeping previews saved reason and dates before confirming a multi-day link', async () => {
  const form = { id: 40, slug: 'leave_request', name: 'Leave Request', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }] };
  const record = { id: 50, form_def_id: 40, number: 'LV-50', slug: 'leave_request', status: 'approved', data: { employee_id: 11, employee_name: 'Ana Cruz', leave_dates: '2026-03-02,2026-03-04', reason: 'Medical procedure and follow-up' } };
  const { win, view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage', 'forms.manage.hr'], p => {
    if (p.startsWith('/hr/requests/eligible')) return [record];
    if (p.includes('/attendance?')) return ['2026-03-02','2026-03-03','2026-03-04'].map(work_date => ({ work_date, notes: '' }));
    if (p === '/form-definitions') return [form]; return periodGet(p);
  });
  const modals: any[] = [], posts: string[] = [];
  win.API.post = async (path: string) => { posts.push(path); return path === '/hr/leave-preview' ? { days: 2, remaining: 8, warnings: [] } : { warnings: [] }; };
  win.__UI.modal = (options: any) => { const overlay = win.document.createElement('div'); overlay.innerHTML = (options.headActionHTML || '') + options.bodyHTML;
    win.document.body.appendChild(overlay); modals.push({ options, overlay }); options.onOpen?.(overlay); return { overlay, close() { overlay.remove(); } }; };
  await routes['hr-timekeeping']!(view, { period_id: 7 }); q(view, '.hr-row-open')!.click(); await flush();
  q(modals[0].overlay, '[data-link]')!.click(); await flush();
  q(modals[1].overlay, '[data-pick]')!.click(); await flush();
  expect(posts).not.toContain('/hr/requests/50/link-attendance');
  expect(modals[2].overlay.textContent).toContain('Medical procedure and follow-up');
  expect(modals[2].overlay.textContent).toContain('2026-03-02,2026-03-04');
  expect(modals[2].options.confirmText).toBe('Link all covered dates');
  await modals[2].options.onConfirm(); await flush();
  expect(posts).toContain('/hr/requests/50/link-attendance');
  const linkButtons = qa(modals[0].overlay, '[data-unlink]');
  expect(linkButtons.map(b => b.dataset.unlink)).toEqual(['0','2']);
  win.close();
});

it('opens linked form details without unlinking; x confirms unless Shift is held', async () => {
  const form = { id: 40, slug: 'overtime_request', name: 'Overtime Request', fields: [{ key: 'reason', label: 'Reason' }] };
  const record = { id: 50, form_name: form.name, form_slug: form.slug, number: 'OT-00095', status: 'pending', data: { employee_id: 11, reason: 'Urgent shipment', work_date: '2026-03-02' } };
  const { win, view, routes } = boot(TK_SRC, ['hr.view', 'hr.manage'], p => {
    if (p.includes('/attendance?')) return [{ work_date: '2026-03-02', form_record_ids: '[50,51]', notes: '' }];
    if (p === '/form-records/50' || p === '/form-records/51') return { ...record, id: Number(p.split('/').at(-1)), number: p.endsWith('51') ? 'OT-00096' : record.number };
    if (p === '/form-definitions') return [form];
    if (p === '/hr/payroll-policy') return { default_rest_days: [0, 6] };
    return periodGet(p);
  });
  const modals: any[] = [];
  win.__UI.modal = (options: any) => {
    const overlay = win.document.createElement('div'); overlay.innerHTML = options.bodyHTML;
    win.document.body.appendChild(overlay); modals.push({ options, overlay });
    options.onOpen?.(overlay); return { overlay, close() { overlay.remove(); } };
  };
  let approve = false, prompts = 0;
  win.__UI.confirmDialog = async () => { prompts++; return approve; };
  await routes['hr-timekeeping']!(view, { period_id: 7 });
  q(view, '.hr-row-open')!.click(); await flush();
  const grid = modals[0].overlay;
  const linked = () => q(grid, '[data-view-form]');
  expect(linked()).not.toBeNull();
  linked()!.click(); await flush();
  expect(modals[1].overlay.textContent).toContain('Urgent shipment');
  expect(linked()).not.toBeNull(); expect(prompts).toBe(0);
  q(grid, '[data-unlink]')!.click(); await flush();
  expect(prompts).toBe(1); expect(linked()).not.toBeNull();
  approve = true;
  q(grid, '[data-unlink]')!.click(); await flush();
  expect(prompts).toBe(2); expect(qa(grid, '[data-view-form]')).toHaveLength(1);
  q(grid, '[data-unlink]')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true })); await flush();
  expect(prompts).toBe(2); expect(linked()).toBeNull();
  win.close();
});

it('lets read-only HR inspect a linked form without an unlink control', async () => {
  const { win, view, routes } = boot(TK_SRC, ['hr.view'], p => {
    if (p.includes('/attendance?')) return [{ work_date: '2026-03-02', form_record_ids: '[50]', notes: '' }];
    if (p === '/form-records/50') return { form_name: 'Overtime Request', form_slug: 'overtime_request', number: 'OT-00095', status: 'pending', data: { reason: 'Urgent shipment' } };
    return periodGet(p);
  });
  const modals: any[] = [];
  win.__UI.modal = (options: any) => { const overlay = win.document.createElement('div'); overlay.innerHTML = options.bodyHTML;
    win.document.body.appendChild(overlay); modals.push(overlay); options.onOpen?.(overlay); return { overlay, close() {} }; };
  await routes['hr-timekeeping']!(view, { period_id: 7 });
  q(view, '.hr-row-open')!.click(); await flush();
  expect(q(modals[0], '[data-unlink]')).toBeNull();
  q(modals[0], '[data-view-form]')!.click(); await flush();
  expect(modals[1].textContent).toContain('Urgent shipment');
  win.close();
});

it('keeps payroll warnings behind a compact header action and exposes details on demand', async () => {
  const warnings = ['No punches recorded', 'Pending employee requests'];
  const { win, view, routes, navigations } = boot(TK_SRC, ['hr.view', 'hr.manage', 'payroll.manage'], p => p === '/hr/periods/7' ? { ...PERIOD, warnings } : []);
  let modal: any; win.__UI.modal = (opts: any) => { modal = opts; return { close() {} }; };
  await routes['hr-timekeeping']!(view, { period_id: 7 });
  const trigger = q(view, '.topbar #tk-warnings')!;
  expect(trigger).not.toBeNull(); expect(trigger.textContent).toContain('2');
  expect(q(view, '.hr-workflow-notice')).toBeNull(); expect(view.textContent).not.toContain(warnings[0]);
  trigger.click(); expect(modal.bodyHTML).toContain(warnings[0]); expect(modal.bodyHTML).toContain('do not block'); modal.onConfirm(); expect(navigations).toContainEqual(['hr-approvals', undefined]);
});
