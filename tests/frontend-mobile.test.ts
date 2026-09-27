/**
 * Mobile app smoke test: load public/mobile/index.html's scripts in the declared
 * order inside jsdom and assert the router boots and every view registers a route.
 * Mirrors frontend.test.ts for the desktop bundle.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EXPECTED_ROUTES = [
  'home', 'work', 'production', 'stock-move', 'damage', 'transfer', 'new-item', 'assign-qr', 'scan',
  'item', 'low-stock', 'location', 'my-log', 'cycle-count', 'receive', 'pick',
  'batch', 'job-orders', 'qc', 'repairs', 'record', 'receiving', 'so', 'report-problem', 'anonymous-report', 'settings', 'queue', 'clock',
  'inbox', 'directory', 'payslips', 'schedule', 'requests', 'tasks',
  'announcements', 'notifications', 'confidential-reports', 'time-fix', 'approvals', 'allocate', 'deliveries',
];

describe('mobile bootstrap', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'mobile', 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);

  it('uses the approved five-destination V2 dock and keeps Clock universal', () => {
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(['home', 'work', 'clock', 'inbox', 'profile']);
    expect(html).not.toContain('data-tab="production"');
    expect(html).not.toContain('data-tab="action"');
    expect(html).toContain('/mobile/mobile-v2.css');
    expect(html).toContain('/mobile/lib/quick-orbit.js');
  });

  it('maps Work to the approved Figma V2 frame and permission-driven queues', () => {
    const source = fs.readFileSync(path.join(PUBLIC, 'mobile', 'modules', 'hr', 'work.js'), 'utf8');
    expect(source).toContain('data-figma-node="46:548"');
    expect(source).toContain('What do I need to do now?');
    expect(source).toContain('Report a blocker');
    expect(source).toContain("MApp.can(op.permission)");
  });

  it('maps Clock to the approved Figma V2 frame and server-authoritative review flow', () => {
    const source = fs.readFileSync(path.join(PUBLIC, 'mobile', 'modules', 'hr', 'clock.js'), 'utf8');
    expect(source).toContain('data-figma-node="46:577"');
    expect(source).toContain('Select an action before confirming');
    expect(source).toContain('Review & confirm');
    expect(source).toContain("API.post('/hr/clock/punch'");
  });

  it('maps Home to the approved Figma V2 frame', () => {
    const source = fs.readFileSync(path.join(PUBLIC, 'mobile', 'modules', 'core', 'home.js'), 'utf8');
    expect(source).toContain('data-figma-node="46:519"');
    expect(source).toContain('TODAY’S ATTENDANCE');
    expect(source).toContain('New request');
    expect(source).toContain('Report issue');
  });

  it('declares app.js before any view module', () => {
    const appIdx = srcs.indexOf('/mobile/app.js');
    const firstView = srcs.findIndex((s) => s.startsWith('/mobile/modules/'));
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(firstView).toBeGreaterThan(appIdx);
  });

  it('boots the router and registers every view', () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    win.fetch = () => Promise.reject(new Error('no network in test'));

    const code = srcs
      .map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8'))
      .join('\n;\n');
    win.eval(code);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));

    expect(typeof win.MApp).toBe('object');
    expect(win.MApp.routes().sort()).toEqual([...EXPECTED_ROUTES].sort());
    // Login wiring ran without throwing.
    expect(win.document.getElementById('m-login-form')).toBeTruthy();
  });

  /** Boots the real app with a pre-seeded session (no network — /auth/me rejects with
      .offline, so boot() falls back to the cached `me` it just read from localStorage,
      same path a real phone takes reopening the app offline) so route rendering can be
      exercised under a specific account's actual permissions, not just route registration. */
  /** `respond(url, init)` may return a JSON body for a URL; anything it doesn't answer (returns
   *  undefined) rejects like a dead network, which is the default for every call. */
  async function bootAs(me: Record<string, unknown>, respond?: (url: string, init: any) => unknown) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    win.fetch = (url: string, init: unknown) => {
      const body = respond ? respond(String(url), init) : undefined;
      if (body === undefined) return Promise.reject(new Error('no network in test'));
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: () => Promise.resolve(body),
      });
    };
    win.localStorage.setItem('vds_token', 'test-token');
    win.localStorage.setItem('vds_m_me', JSON.stringify(me));

    const code = srcs
      .map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8'))
      .join('\n;\n');
    win.eval(code);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    // enterApp() runs at the end of a `/auth/me` rejection chain (a couple of microtask
    // hops through api.js's async request() + boot()'s .catch) — flush a real macrotask
    // so it's landed before we drive the router.
    await new Promise((r) => setTimeout(r, 0));
    return win;
  }

  it('a qc_inspector-only account gets the Production tab with just its own row', async () => {
    const win = await bootAs({
      id: 1, username: 'qc1', full_name: 'QC One', role: 'qc_inspector', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.inspect_qc', 'messages.view', 'messages.send'],
    });
    expect(win.MApp.hasProductionAccess()).toBe(true);
    win.location.hash = '#/production';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('QC / QA');
    expect(text).not.toContain('Job Orders');
    expect(text).not.toContain('Repairs');
    expect(text).not.toContain('Products In');
  });

  it('a releasing_clerk-only account has no Production tab access but sees Release orders on Work', async () => {
    const win = await bootAs({
      id: 2, username: 'rel1', full_name: 'Release One', role: 'releasing_clerk', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'orders.view', 'orders.release', 'messages.view', 'messages.send'],
    });
    expect(win.MApp.hasProductionAccess()).toBe(false);
    win.location.hash = '#/work';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('Release orders');
    expect(text).not.toContain('Accept Parts Request');
    expect(text).not.toContain('Products In');
  });

  /** Boot the time clock view with a fake server + GPS; returns the view and the punch bodies sent. */
  async function bootClock(status: Record<string, unknown>) {
    const win = await bootAs({
      id: 3, username: 'drv1', full_name: 'Driver One', role: 'employee', employee: true, modules: null,
      permissions: ['messages.view', 'messages.send'],
    });
    const punches: unknown[] = [];
    const json = (data: unknown) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data });
    win.fetch = async (url: string, init: { body?: string } = {}) => {
      if (url.endsWith('/hr/clock/my-status')) {
        return json({ employee_name: 'Driver One', clocked_in: false, punches: [], hours_today: 0, ...status });
      }
      if (url.endsWith('/hr/clock/punch')) {
        punches.push(JSON.parse(init.body || '{}'));
        return json({ kind: 'in', segment: 'morning_in', at: '08:00', hours_today: 0, work_date: '2026-09-25' });
      }
      return json([]);
    };
    Object.defineProperty(win.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 14.65, longitude: 120.98, accuracy: 12 } }) },
    });
    win.location.hash = '#/clock';
    win.MApp.render();
    await new Promise((r) => setTimeout(r, 0));
    return { win, view: win.document.getElementById('m-view'), punches };
  }

  it('time clock: staff who may clock in anywhere get "Clock in here", which sends GPS and no QR code', async () => {
    const { view, punches } = await bootClock({ location_required: false, can_clock_anywhere: true });
    const review = [...view.querySelectorAll('button')].find((b: { textContent: string }) => b.textContent.includes('Review & confirm'));
    expect(review).toBeTruthy();
    review.click();
    const here = [...view.querySelectorAll('button')].find((b: { textContent: string }) => b.textContent.includes('Clock in here'));
    expect(here).toBeTruthy();
    here.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(punches).toEqual([{ location: { lat: 14.65, lng: 120.98, accuracy_m: 12 } }]);
  });

  it('time clock: ordinary staff get no "Clock in here" button, and are told location is checked when locked', async () => {
    const { view } = await bootClock({ location_required: true, can_clock_anywhere: false });
    expect(view.textContent).not.toContain('Clock in here');
    expect(view.textContent).toContain('time-in only works at the office');
    expect(view.textContent).toContain('Review & confirm');
  });

  it('maps the Schedule route to approved Figma node 46:606 and keeps its live API/request flow', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/hr/schedule.js'), 'utf8');
    expect(source).toContain("view.setAttribute('data-figma-node', '46:606')");
    expect(source).toContain("API.get('/me/schedule')");
    expect(source).toContain("MApp.go('requests')");
    expect(source).toContain('Request schedule change');
  });


  it('maps universal Requests to the approved center, form, and detail Figma nodes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/hr/requests.js'), 'utf8');
    expect(source).toContain("shell(view, '46:634'");
    expect(source).toContain("shell(view, '46:663'");
    expect(source).toContain("shell(view, '46:692'");
    expect(source).toContain("API.get('/me/request-types')");
    expect(source).toContain("API.get('/me/requests')");
    expect(source).toContain("API.post('/form-records'");
    expect(source).toContain('Half-day · Undertime');
    expect(source).toContain('Offset · Time correction · Schedule change');
  });


  it('maps Reporting Hub and both protected report paths to their Figma nodes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/core/report-problem.js'), 'utf8');
    expect(source).toContain("shell(view, '46:721'");
    expect(source).toContain("shell(view, '46:750'");
    expect(source).toContain("shell(view, '46:779'");
    expect(source).toContain("API.upload('/messages'");
    expect(source).toContain("MApp.route('anonymous-report'");
    // Anonymous path: identity-free transport — a bare fetch with no Authorization header or
    // cookies, never the token-adding API client / offline queue, never Messages or Bug Reports.
    const anon = source.slice(source.indexOf('function anonPost('), source.indexOf('function identifiedList('));
    expect(anon).toContain("fetch('/api/anonymous-reports' + path");
    expect(anon).toContain("credentials: 'omit'");
    expect(anon).not.toMatch(/Authorization|getToken/);
    expect(anon).not.toMatch(/API\.(post|upload)\('\/anonymous-reports'\s*,/);
    expect(anon).not.toMatch(/mSubmit|\/messages|\/bug-reports/);
    expect(anon).toContain("API.post('/anonymous-reports/ticket')"); // only the ticket is authenticated
    expect(anon).not.toMatch(/type="file"/); // no attachments on this channel
  });

  it('keeps the anonymous submit off the auth header at runtime', async () => {
    const calls: Array<{ url: string; init: { headers?: Record<string, string>; credentials?: string } }> = [];
    const win = await bootAs({
      id: 5, username: 'e5', full_name: 'Emp Five', role: 'csr', employee: true, modules: null,
      permissions: ['messages.view', 'messages.send'],
    }, (url: string, init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string }) => {
      calls.push({ url, init: init || {} });
      if (url === '/api/anonymous-reports/ticket') return { ticket: 't'.repeat(32), expires_in_minutes: 120 };
      if (url === '/api/anonymous-reports') return { number: 'CR-00007', access_code: 'ABCDE-FGHJK-MNPQR-STVWX' };
      return undefined;
    });
    win.location.hash = '#/anonymous-report';
    await new Promise((r) => setTimeout(r, 20)); // let the hashchange render settle first
    const doc = win.document;
    (doc.querySelector('[data-anon="details"]') as HTMLTextAreaElement).value = 'Pallets are blocking the fire exit.';
    (doc.querySelector('.m-report-anon-form') as HTMLFormElement).dispatchEvent(new win.Event('submit', { cancelable: true }));
    (doc.getElementById('m-anon-send') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    const submit = calls.find((c) => c.url === '/api/anonymous-reports');
    expect(submit).toBeTruthy();
    expect(submit!.init.credentials).toBe('omit');
    expect(JSON.stringify(submit!.init.headers || {})).not.toMatch(/Authorization/i);
    const ticketCall = calls.find((c) => c.url === '/api/anonymous-reports/ticket');
    expect(JSON.stringify(ticketCall!.init.headers || {})).toMatch(/Authorization/i);
    expect(doc.getElementById('m-view')!.textContent).toContain('ABCDE-FGHJK-MNPQR-STVWX');
  });


  it('maps Inbox and Conversation to approved Figma nodes while retaining messaging capabilities', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/core/inbox.js'), 'utf8');
    expect(source).toContain("view.setAttribute('data-figma-node', '46:808')");
    expect(source).toContain("view.setAttribute('data-figma-node', '46:837')");
    expect(source).toContain("API.get('/messages/conversations')");
    expect(source).toContain("API.upload('/messages'");
    expect(source).toContain("API.patch('/messages/'");
    expect(source).toContain("API.del('/messages/'");
    expect(source).toContain("'/react'");
    expect(source).toContain("ChatWS.send({ type: 'typing'");
  });


  it('maps Payslips and Payslip Detail to Figma with a fail-closed download gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/hr/payslips.js'), 'utf8');
    expect(source).toContain("shell(view, '46:895'");
    expect(source).toContain("shell(view, '46:924'");
    expect(source).toContain("API.get('/me/payslips')");
    expect(source).toContain("record.finalized === true");
    expect(source).toContain("typeof record.download_url === 'string'");
    expect(source).toContain('API.download(record.download_url');
    expect(source).toContain('Payroll is still being finalized');
  });


  it('maps Profile & Settings to Figma and preserves employee-safe controls', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/core/settings.js'), 'utf8');
    expect(source).toContain("view.setAttribute('data-figma-node', nodeId || '46:953')");
    expect(source).toContain("API.get('/me')");
    expect(source).toContain("localStorage.setItem('vds_profile_nickname'");
    expect(source).toContain('Nickname is saved on this device only');
    expect(source).toContain('HR-controlled information');
    expect(source).toContain("MApp.go('payslips')");
    expect(source).toContain("MApp.go('requests')");
    expect(source).toContain("MApp.go('report-problem')");
    expect(source).toContain("API.post('/auth/change-password'");
    expect(source).toContain("API.post('/auth/logout')");
    expect(source).not.toContain("API.put('/auth/profile'");
  });


  it('marks every special-access pipeline screen with its role context and preserves live transactions', () => {
    const files = {
      warehouse: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/repairs.js'), 'utf8'),
      production: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/job-orders.js'), 'utf8'),
      hub: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/production.js'), 'utf8'),
      quality: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/qc.js'), 'utf8'),
      rts: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/receiving.js'), 'utf8'),
      releasing: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/inventory/so.js'), 'utf8'),
    };
    expect(files.warehouse).toContain("data-role-screen', 'warehouseman'");
    expect(files.warehouse).toContain("'/production/repairs/' + r.id + '/accept'");
    expect(files.warehouse).toContain("'/production/repairs/' + r.id + '/reject'");
    expect(files.hub).toContain("data-role-screen', 'production-manager'");
    expect(files.production).toContain("data-role-screen', 'production-manager'");
    expect(files.production).toContain("API.post('/job-orders/'");
    expect(files.quality).toContain("data-role-screen', qualityRole");
    expect(files.quality).toContain("qualityRole === 'qa'");
    expect(files.quality).toContain("API.get('/qc/checklists");
    expect(files.rts).toContain("data-role-screen', 'rts'");
    expect(files.rts).toContain("'/job-orders/' + id + '/products-in'");
    expect(files.releasing).toContain("data-role-screen', 'releasing'");
    expect(files.releasing).toContain("'/orders/' + order.id + '/release'");
  });

});
