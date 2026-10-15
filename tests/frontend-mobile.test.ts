/**
 * Mobile app smoke test: load public/mobile/index.html's scripts in the declared
 * order inside jsdom and assert the router boots and every view registers a route.
 * Mirrors frontend.test.ts for the desktop bundle.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EXPECTED_ROUTES = [
  'home', 'work', 'production', 'stock-move', 'damage', 'transfer', 'new-item', 'assign-qr', 'scan',
  'item', 'low-stock', 'location', 'my-log', 'cycle-count', 'receive', 'pick',
  'batch', 'job-orders', 'kit-release', 'unit-issues', 'qc', 'repairs', 'record', 'receiving', 'so', 'report-problem', 'anonymous-report', 'settings', 'queue', 'clock',
  'inbox', 'directory', 'payslips', 'schedule', 'requests', 'tasks', 'notes', 'guides',
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

  it('maps Clock to Figma 46:577 with slot tiles that start the punch (scan, then auto selfie)', () => {
    const source = fs.readFileSync(path.join(PUBLIC, 'mobile', 'modules', 'hr', 'clock.js'), 'utf8');
    expect(source).toContain('data-figma-node="46:577"');
    expect(source).toContain('Tap what you’re recording');
    expect(source).toContain("API.post('/hr/clock/punch/scan'");
    expect(source).toContain('mSelfie.take(');
    expect(source).toContain("fd.append('slot'");
    expect(source).toContain("API.upload('/hr/clock/punch/selfie'");
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
  async function bootAs(me: Record<string, unknown>, respond?: (url: string, init: any) => unknown, factory = new IDBFactory()) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
    win.indexedDB = factory;
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    win.fetch = (url: string, init: unknown) => {
      const out = respond ? respond(String(url), init) : undefined;
      if (out === undefined) return Promise.reject(new Error('no network in test'));
      // { __status, body } fakes an HTTP error response; { __headers, body } a 200 with extra headers
      // (e.g. X-Sync-State); anything else is a 200 JSON body.
      const status = out && typeof out === 'object' && '__status' in (out as object) ? (out as { __status: number }).__status : 200;
      const extra = out && typeof out === 'object' && '__headers' in (out as object) ? (out as { __headers: Record<string, string> }).__headers : null;
      const body = status === 200 && !extra ? out : (out as { body: unknown }).body;
      return Promise.resolve({
        ok: status < 400, status,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json'
          : extra ? (Object.entries(extra).find(([k]) => k.toLowerCase() === h.toLowerCase()) || [])[1] ?? null : null) },
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

  it('a floor desk without the warehouse phone tools (inventory.mobile) still gets its own desk', async () => {
    // The built-in floor roles carry only the phone app + their desk permission (permissions.ts).
    const win = await bootAs({
      id: 9, username: 'qcdesk', full_name: 'QC Desk', role: 'qc_inspector', role_label: 'QC Inspector',
      employee: true, modules: null, permissions: ['mobile.access', 'messages.view', 'messages.send', 'production.inspect_qc'],
    });
    expect(win.MApp.isWarehouse()).toBe(false);
    expect(win.MApp.hasProductionAccess()).toBe(true);
    win.location.hash = '#/work';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('QC technical inspection');
    expect(text).not.toContain('Cycle count');
    win.mQuickOrbit.refresh();
    const orbitRoutes = [...win.document.querySelectorAll('.v2-orbit-action')].map((b: any) => b.dataset.route);
    expect(orbitRoutes).toContain('qc');
    // A warehouse screen opened by its address is refused (ROUTE_NEEDS in app.js).
    win.location.hash = '#/stock-move';
    win.MApp.render();
    expect(win.document.querySelector('#m-view [data-no-permission]')).not.toBeNull();
  });

  it('a new account with the default mobile.access gets in without an employee link, showing its role name', async () => {
    const win = await bootAs({
      id: 7, username: 'acct1', full_name: 'Office One', role: 'line_supervisor', role_label: 'Line Supervisor',
      employee: null, modules: null, permissions: ['mobile.access', 'messages.view', 'messages.send'],
    });
    win.location.hash = '#/home';
    win.MApp.render();
    expect(win.document.getElementById('m-view').textContent).not.toContain('Nothing here for you yet');
    expect(win.document.getElementById('m-ctx-role').textContent).toBe('Line Supervisor');
  });

  it('an account with mobile.access removed and no employee link sees the blocked screen', async () => {
    const win = await bootAs({
      id: 8, username: 'acct2', full_name: 'Office Two', role: 'accounting', employee: null, modules: null,
      permissions: ['accounting.view', 'messages.view'],
    });
    win.location.hash = '#/home';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('Nothing here for you yet');
    expect(text).toContain('Use the phone app');
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

  it('a screen the role does not permit says so up front, whatever link or address opened it', async () => {
    const WAREHOUSE = ['allocate', 'batch', 'cycle-count', 'damage', 'receive', 'pick', 'stock-move', 'transfer',
      'assign-qr', 'new-item', 'item', 'location', 'low-stock'];
    // The shell's background reads (inbox badge, Home summary) answered so neither rejects unhandled;
    // anything else a permitted screen asks for fails like a missing record, which screens handle.
    // (/api/auth/me stays unanswered: the shell catches that and keeps the cached account.)
    // The warehouse screens a permitted account opens load their lists (low stock, locations, orders): empty.
    const quiet = (url: string) => url === '/api/auth/me' ? undefined
      : url === '/api/messages/unread-count' ? { count: 0 } : url === '/api/me/today' ? {}
      : /^\/api\/(inventory|locations|orders)(\?|$)/.test(url) ? []
      : { __status: 404, body: { error: 'Not found' } };
    const qc = await bootAs({ id: 4, username: 'qc8', full_name: 'QC Desk', role: 'qc_inspector', employee: true, modules: null,
      permissions: ['mobile.access', 'inventory.mobile', 'production.inspect_qc', 'messages.view', 'messages.send'] }, quiet);
    const blocked = (win: Record<string, any>, route: string) => {
      win.location.hash = '#/' + route;
      win.MApp.render();
      return !!win.document.querySelector('#m-view [data-no-permission]');
    };
    expect(WAREHOUSE.filter((r) => !blocked(qc, r))).toEqual([]);
    expect(blocked(qc, 'record')).toBe(false); // a desk that handles the unit may open its record
    const wh = await bootAs({ id: 5, username: 'wh8', full_name: 'Warehouse', role: 'warehouse', employee: true, modules: null,
      permissions: ['mobile.access', 'inventory.mobile', 'inventory.view', 'inventory.create', 'inventory.adjust', 'messages.view', 'messages.send'] }, quiet);
    expect(WAREHOUSE.filter((r) => blocked(wh, r))).toEqual([]);
  });

  it('a desk-only account counts its Work tiles from its own queue, never the job-order list', async () => {
    const asked: string[] = [];
    const ME = { id: 3, username: 'qc9', full_name: 'QC Only', role: 'desk_qc', employee: true, modules: null,
      permissions: ['mobile.access', 'production.inspect_qc', 'messages.view', 'messages.send'] };
    const win = await bootAs(ME, (url: string) => {
      asked.push(url);
      if (url.startsWith('/api/qc/queue')) return { role: 'qc', units: [{ id: 1 }, { id: 2 }], completed: [] };
      // The shell's own background reads (inbox badge, Home summary) — answered so neither rejects
      // unhandled. (/api/auth/me is left unanswered: the shell catches that and keeps the cached account.)
      if (url === '/api/messages/unread-count') return { count: 0 };
      if (url === '/api/me/today') return {};
      return undefined;
    });
    win.location.hash = '#/work';
    win.MApp.render();
    await new Promise((r) => setTimeout(r, 60));
    expect(win.document.getElementById('m-view').textContent).toContain('QC technical inspection');
    expect(asked).toContain('/api/qc/queue?role=qc');
    expect(asked.some((u) => u.startsWith('/api/job-orders'))).toBe(false);
  });

  /** Boot the time clock view with a fake server, GPS, QR scanner and front camera; returns the
   *  view, the scan bodies sent, the selfie uploads and the scanner opens. `selfie: false` cancels
   *  the camera. The scanner reads `ABCDEFGHIJ` as soon as it opens. */
  async function bootClock(status: Record<string, unknown>, opts: { selfie?: boolean } = {}) {
    const win = await bootAs({
      id: 3, username: 'drv1', full_name: 'Driver One', role: 'employee', employee: true, modules: null,
      permissions: ['messages.view', 'messages.send'],
    });
    const punches: unknown[] = [];
    const selfies: Array<{ hold_id: unknown; slot: unknown; photo: unknown }> = [];
    const scans: string[] = [];
    const json = (data: unknown) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data });
    win.fetch = async (url: string, init: { body?: any } = {}) => {
      if (url.endsWith('/hr/clock/my-status')) {
        return json({
          employee_name: 'Driver One', clocked_in: false, punches: [], hours_today: 0,
          slots: { in: null, lunchOut: null, lunchIn: null, out: null }, next_slot: 'in', ...status,
        });
      }
      if (url.endsWith('/hr/clock/punch/scan')) {
        punches.push(JSON.parse(init.body || '{}'));
        return json({ hold_id: 41, expires_in_s: 300 });
      }
      if (url.endsWith('/hr/clock/punch/selfie')) {
        selfies.push({ hold_id: init.body.get('hold_id'), slot: init.body.get('slot'), photo: init.body.get('photo') });
        return json({ kind: 'in', segment: 'morning_in', at: '08:00', hours_today: 0, work_date: '2026-09-25', photo_id: 9, replaced: false });
      }
      return json([]);
    };
    win.mSelfie.take = () => (opts.selfie === false
      ? Promise.reject(new Error('cancelled'))
      : Promise.resolve(new win.Blob(['jpeg'], { type: 'image/jpeg' })));
    win.mScanner.open = (o: { title: string; onResult: (c: string) => void }) => { scans.push(o.title); o.onResult('ABCDEFGHIJ'); return { close() {} }; };
    Object.defineProperty(win.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 14.65, longitude: 120.98, accuracy: 12 } }) },
    });
    win.location.hash = '#/clock';
    win.MApp.render();
    await new Promise((r) => setTimeout(r, 0));
    return { win, view: win.document.getElementById('m-view'), punches, selfies, scans };
  }
  const tile = (view: any, slot: string) => view.querySelector(`[data-slot="${slot}"]`);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('time clock: the four kiosk slots are tiles, the suggested one marked Next, filled ones showing their time', async () => {
    const { view } = await bootClock({ slots: { in: '08:02', lunchOut: null, lunchIn: null, out: null }, next_slot: 'lunchOut', clocked_in: true });
    expect([...view.querySelectorAll('[data-slot]')].map((b: any) => b.textContent.replace(/\s+/g, ' ').trim()))
      .toEqual(['Time in08:02', 'Afternoon out Next–', 'Afternoon in–', 'Time out–']);
    expect(tile(view, 'lunchOut').classList.contains('is-next')).toBe(true);
  });

  it('time clock: one tap on a slot scans the office QR, then the selfie records that slot', async () => {
    const { view, punches, selfies, scans } = await bootClock({ location_required: false });
    tile(view, 'in').click();
    await settle();
    expect(scans).toEqual(['Scan the office screen — Time in']);
    expect(punches).toEqual([{ code: 'ABCDEFGHIJ' }]);
    expect(selfies).toHaveLength(1);
    expect(selfies[0]).toMatchObject({ hold_id: '41', slot: 'in' });
    expect(selfies[0]!.photo).toBeTruthy();
    expect(view.textContent).toContain('Time in recorded');
  });

  it('time clock: with the location lock, the QR scan is sent with the GPS fetched meanwhile', async () => {
    const { view, punches } = await bootClock({ location_required: true });
    expect(view.textContent).toContain('time-in only works at the office');
    expect(view.textContent).not.toContain('Outside the office'); // only for staff who may clock in anywhere
    tile(view, 'in').click();
    await settle();
    expect(punches).toEqual([{ code: 'ABCDEFGHIJ', location: { lat: 14.65, lng: 120.98, accuracy_m: 12 } }]);
  });

  it('time clock: staff who may clock in anywhere can choose "Outside the office" — GPS, no QR, then the selfie', async () => {
    const { view, punches, selfies, scans } = await bootClock({ location_required: false, can_clock_anywhere: true });
    view.querySelector('[data-where="outside"]').click();
    tile(view, 'in').click();
    await settle();
    expect(scans).toEqual([]);
    expect(punches).toEqual([{ location: { lat: 14.65, lng: 120.98, accuracy_m: 12 } }]);
    expect(selfies[0]).toMatchObject({ slot: 'in' });
  });

  it('time clock: a filled slot asks before replacing its time and selfie', async () => {
    const { view, punches, selfies } = await bootClock({ slots: { in: '08:02', lunchOut: null, lunchIn: null, out: null }, next_slot: 'out' });
    tile(view, 'in').click();
    await settle();
    expect(punches).toEqual([]); // nothing started yet
    expect(view.textContent).toContain('Replace your time in at 08:02?');
    view.querySelector('[data-keep]').click();
    expect(view.querySelector('.v2-clock-replace').hidden).toBe(true);
    tile(view, 'in').click();
    view.querySelector('[data-replace]').click();
    await settle();
    expect(selfies[0]).toMatchObject({ slot: 'in' });
  });

  it('time clock: a cancelled selfie records nothing and says so', async () => {
    const { win, view, selfies } = await bootClock({ location_required: false }, { selfie: false });
    tile(view, 'in').click();
    await settle();
    expect(selfies).toHaveLength(0);
    expect(view.textContent).not.toContain('recorded');
    expect(win.document.body.textContent).toContain('a selfie is needed to finish');
  });

  it('maps the Schedule route to approved Figma node 46:606 and keeps its live API/request flow', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/hr/schedule.js'), 'utf8');
    expect(source).toContain("view.setAttribute('data-figma-node', '46:606')");
    expect(source).toContain("API.get('/me/schedule')");
    expect(source).toContain("MApp.go('requests', { type: 'schedule_change', date: target })");
    expect(source).toContain('Request schedule change');
  });


  it('maps universal Requests to the approved center, form, and detail Figma nodes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/hr/requests.js'), 'utf8');
    expect(source).toContain("shell(view, '46:634'");
    expect(source).toContain("shell(view, '46:663'");
    expect(source).toContain("shell(view, '46:692'");
    expect(source).toContain("API.get('/me/request-types')");
    expect(source).toContain("API.get('/me/requests')");
    expect(source).toContain("mSubmit('/form-records'");
    expect(source).toContain('Forms available now');
    expect(source).toContain('halfday_request:');
    expect(source).toContain('offset_form:');
  });


  it('maps Reporting Hub and both protected report paths to their Figma nodes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/core/report-problem.js'), 'utf8');
    expect(source).toContain("shell(view, '46:721'");
    expect(source).toContain("shell(view, '46:750'");
    expect(source).toContain("shell(view, '46:779'");
    expect(source).toContain("API.upload('/identified-reports'");
    expect(source).toContain("MApp.route('anonymous-report'");
    // Anonymous path: identity-free transport — a bare fetch with no Authorization header or
    // cookies, never the token-adding API client / offline queue, never Messages or Bug Reports.
    const anon = source.slice(source.indexOf('function anonPost('), source.indexOf('function identifiedList('));
    // API.base() is only the server address the installed app saved (§29) — no token, no queue.
    expect(anon).toContain("fetch(API.base() + '/api/anonymous-reports' + path");
    expect(anon).toContain("credentials: 'omit'");
    expect(anon).not.toMatch(/Authorization|getToken/);
    expect(anon).not.toMatch(/API\.(post|upload)\('\/anonymous-reports'\s*,/);
    expect(anon).not.toMatch(/mSubmit|\/messages|\/bug-reports/);
    expect(anon).toContain("API.post('/anonymous-reports/ticket')"); // only the ticket is authenticated
    // Photos: re-encoded on the phone (drops EXIF/GPS/device/time + the original filename)
    // before they reach the same identity-free transport; never the raw picked file.
    expect(anon).toContain('ImageCompress.reencode(file');
    expect(anon).toMatch(/prepare: scrubPhoto/);
    expect(anon).toContain("fd.append('photos', f, 'photo-' + (i + 1) + '.jpg')");
    expect(anon).not.toMatch(/localStorage[^\n]*anonPhotos|saveDraft\([^)]*anonPhotos/); // photos never persisted
    const lib = fs.readFileSync(path.join(ROOT, 'public/js/lib/image-compress.js'), 'utf8');
    const reencode = lib.slice(lib.indexOf('function reencode('), lib.indexOf('function loadImage('));
    expect(reencode).toContain('lastModified: 0');
    expect(reencode).not.toMatch(/return file;|resolve\(file\)/); // fails closed, never the original
    // PDFs: only page photos drawn by PdfPages are sent, never the PDF file itself.
    expect(anon).toContain('PdfPages.toJpegs(file');
    const pdfLib = fs.readFileSync(path.join(ROOT, 'public/js/lib/pdf-pages.js'), 'utf8');
    expect(pdfLib).toContain('enableScripting: false');
    expect(pdfLib).toContain("lastModified: 0");
    // The reporter's own photos come back over the same identity-free transport, code in the body.
    const own = anon.slice(anon.indexOf('function anonPhotoUrl('), anon.indexOf('function scrubPhoto('));
    expect(own).toContain("credentials: 'omit'");
    expect(own).toContain("fetch(API.base() + '/api/anonymous-reports/photo'");
    expect(own).not.toMatch(/API\.(?!base\(\))|Authorization|\?number=|access_code=/);
  });

  describe('warehouse kit release (Figma 62:*)', () => {
    const WH = { id: 9, username: 'wh', full_name: 'Ana Alvarez', role: 'warehouse', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.adjust', 'inventory.mobile'] };
    const BASE = { id: 184, number: 'JO-2026-184', product_name: 'K4 Electric Bike', qty_ordered: 12, status: 'draft',
      approved_at: 'approved', warehouse_accepted_at: null, prepared_at: null, source_location_name: 'Main Parts' };
    const line = { component_item_id: 1, component_name: 'Controller 60 V', need: 12, have: 30, held_elsewhere: 8, available: 22, short: 0, picked: 0 };
    const wait = () => new Promise((r) => setTimeout(r, 80));
    const click = (win: any, id: string) => (win.document.getElementById(id) as HTMLButtonElement).click();
    const ack = (win: any) => { const el = win.document.getElementById('kr-ack'); el.checked = true; el.dispatchEvent(new win.Event('change')); };
    function fixture(start: Record<string, any> = {}, options: { lost?: string; local?: string; refusal?: any } = {}) {
      const jo: Record<string, any> = { ...BASE, ...start };
      const lines = [{ ...line, picked: jo.prepared_at ? 12 : 0 }];
      const requests: { path: string; key: string; payload: any }[] = [];
      const applied = new Map<string, any>();
      let lose = !!options.lost;
      const respond = (url: string, init: any) => {
        if (init?.method === 'POST') {
          const key = init.headers['Idempotency-Key'], payload = JSON.parse(init.body);
          requests.push({ path: url, key, payload });
          if (options.refusal) return options.refusal;
          if (!applied.has(key)) {
            if (url.endsWith('/warehouse-accept')) jo.warehouse_accepted_at = 'accepted';
            else if (url.endsWith('/prepare')) { lines[0]!.picked = payload.job_orders[0].lines[0]!.qty_picked; jo.prepared_at = lines[0]!.picked === 12 ? 'prepared' : null; }
            else if (url.endsWith('/release')) { jo.status = 'released'; jo.released_at = '2026-10-14 01:00:00'; jo.parts_slip_number = 'PRS-00007'; }
            applied.set(key, { ok: true, job_order: { ...jo }, slip: url.endsWith('/release') ? { number: 'PRS-00007' } : null });
          }
          if (lose && url.endsWith(options.lost!)) { lose = false; return undefined; }
          const body = applied.get(key);
          return options.local ? { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': options.local }, body } : body;
        }
        if (url === '/api/job-orders/184') return { ...jo };
        if (url === '/api/job-orders/184/availability') return { lines: lines.map(l => ({ ...l })), shortfalls: lines.filter(l => l.short > 0), releasable: !!jo.prepared_at && !!jo.warehouse_accepted_at && jo.status === 'draft' && !lines.some(l => l.short > 0) };
        if (url === '/api/sync/command/local-kit') return { state: 'local' };
        return undefined;
      };
      return { jo, lines, requests, applied, respond };
    }
    async function open(win: any, step = '') { win.location.hash = '#/kit-release?id=184' + (step ? '&step=' + step : ''); await wait(); }
    async function review(win: any) { click(win, 'kr-review'); await wait(); }

    it('separates ready, picking, shortage and failed availability checks', async () => {
      const win = await bootAs(WH, (url) => {
        if (url === '/api/job-orders?stage=awaiting_release') return [BASE, { ...BASE, id: 185 }, { ...BASE, id: 186 }, { ...BASE, id: 187 }];
        if (url === '/api/job-orders?status=released') return [];
        if (url === '/api/job-orders/184/availability') return { lines: [line], shortfalls: [], releasable: true };
        if (url === '/api/job-orders/185/availability') return { lines: [line], shortfalls: [], releasable: false };
        if (url === '/api/job-orders/186/availability') return { lines: [line], shortfalls: [{ ...line, short: 3 }], releasable: false };
        return undefined;
      });
      win.location.hash = '#/kit-release'; await wait();
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('1 kit ready');
      expect(view.querySelectorAll('[data-id]')).toHaveLength(1);
      view.querySelector('[data-tab="unknown"]').click();
      expect(view.textContent).toContain('Availability unknown');
      expect(view.querySelector('[data-id]').dataset.id).toBe('187');
      view.querySelector('[data-tab="preparing"]').click();
      expect(view.textContent).toContain('Awaiting warehouse');
      view.querySelector('[data-tab="blocked"]').click();
      expect(view.textContent).toContain('1 part short');
    });

    it('accepts separately, saves and corrects partial picks, then issues one slip', async () => {
      const f = fixture(), win = await bootAs(WH, f.respond); await open(win);
      click(win, 'kr-accept'); await wait(); await review(win);
      const input = () => win.document.querySelector('[data-pick]');
      expect(win.document.getElementById('kr-go')).toBeNull();
      input().value = '5'; input().dispatchEvent(new win.Event('input')); click(win, 'kr-save-pick'); await wait(); await review(win);
      expect(win.document.getElementById('m-view').textContent).toContain('Partially picked');
      expect(input().value).toBe('5');
      input().value = '3'; input().dispatchEvent(new win.Event('input')); click(win, 'kr-save-pick'); await wait(); await review(win);
      expect(input().value).toBe('3');
      input().value = '12'; input().dispatchEvent(new win.Event('input')); click(win, 'kr-save-pick'); await wait(); await review(win);
      expect(win.document.getElementById('kr-save-pick').disabled).toBe(true);
      input().value = '11'; input().dispatchEvent(new win.Event('input'));
      expect(win.document.getElementById('kr-go').disabled).toBe(true);
      input().value = '12'; input().dispatchEvent(new win.Event('input'));
      expect(win.document.getElementById('kr-go').disabled).toBe(false);
      click(win, 'kr-go'); await wait();
      expect(win.document.getElementById('kr-confirm').disabled).toBe(true);
      ack(win); click(win, 'kr-confirm'); await wait(); await review(win);
      expect(win.document.getElementById('m-view').textContent).toContain('Parts released successfully');
      expect(win.document.getElementById('m-view').textContent).toContain('PRS-00007');
      expect(f.requests.map(r => r.path)).toEqual(['/api/job-orders/warehouse-accept', '/api/job-orders/prepare', '/api/job-orders/prepare', '/api/job-orders/prepare', '/api/job-orders/184/release']);
      expect(new Set(f.requests.map(r => r.key)).size).toBe(5);
      expect(f.requests.every(r => !!r.key)).toBe(true);
    });

    it.each(['warehouse-accept', 'prepare', 'release'])('recovers a lost %s response across restart with the identical key and payload', async (stage) => {
      const f = fixture(stage === 'warehouse-accept' ? {} : { warehouse_accepted_at: 'accepted', prepared_at: stage === 'release' ? 'prepared' : null }, { lost: stage });
      const factory = new IDBFactory();
      let win = await bootAs(WH, f.respond, factory); await open(win, stage === 'release' ? 'confirm' : '');
      if (stage === 'warehouse-accept') click(win, 'kr-accept');
      else if (stage === 'prepare') { win.document.querySelector('[data-pick]').value = '6'; win.document.querySelector('[data-pick]').dispatchEvent(new win.Event('input')); click(win, 'kr-save-pick'); }
      else { ack(win); click(win, 'kr-confirm'); }
      await wait();
      expect(win.document.getElementById('kr-retry-action')).toBeTruthy();
      win.close(); win = await bootAs(WH, f.respond, factory); await open(win);
      expect(win.document.getElementById('kr-retry-action')).toBeTruthy();
      click(win, 'kr-retry-action'); await wait();
      expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]); expect(f.applied.size).toBe(1);
      expect(win.document.getElementById('m-view').textContent).toContain('Confirmed by site authority');
      await review(win);
      if (stage === 'release') expect(win.document.getElementById('m-view').textContent).toContain('Parts released successfully');
    });

    it('blocks direct confirmation when stock is held and reports the breakdown', async () => {
      const f = fixture({ warehouse_accepted_at: 'accepted', prepared_at: 'prepared' });
      Object.assign(f.lines[0]!, { have: 12, held_elsewhere: 5, available: 7, short: 5 });
      const win = await bootAs(WH, f.respond); await open(win, 'confirm');
      expect(win.document.getElementById('kr-confirm')).toBeNull();
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('On hand 12 · Held 5'); expect(view.textContent).toContain('Free 7');
      click(win, 'kr-report'); await wait();
      expect(win.document.querySelector('[data-msg]').value).toContain('Main Parts');
      expect(view.textContent).toContain('Held 5'); expect(f.requests).toHaveLength(0);
    });

    it('disables release after a fresh stock change and refuses invalid picked counts', async () => {
      const f = fixture({ warehouse_accepted_at: 'accepted', prepared_at: 'prepared' });
      const win = await bootAs(WH, f.respond); await open(win);
      for (const value of ['', '-1', '1.5', '13']) { win.document.querySelector('[data-pick]').value = value; win.document.querySelector('[data-pick]').dispatchEvent(new win.Event('input')); click(win, 'kr-save-pick'); }
      expect(f.requests).toHaveLength(0);
      await open(win, 'confirm'); ack(win);
      Object.assign(f.lines[0]!, { available: 2, short: 10 });
      click(win, 'kr-confirm'); await wait();
      expect(win.document.getElementById('kr-confirm')).toBeNull(); expect(f.requests).toHaveLength(0);
    });

    it.each([
      { component_name: 'Controller', picking: 12, available: 4 },
      { component_name: 'Controller', need: 12, have: 20, held_elsewhere: 16, available: 4, short: 8 },
    ])('renders the refusal quantity shape without inventing a successful release', async (shortfall) => {
      const f = fixture({ warehouse_accepted_at: 'accepted', prepared_at: 'prepared' }, { refusal: { __status: 400, body: { error: 'Stock changed', shortfalls: [shortfall] } } });
      const win = await bootAs(WH, f.respond); await open(win, 'confirm'); ack(win); click(win, 'kr-confirm'); await wait();
      const text = win.document.getElementById('m-view').textContent;
      expect(text).toContain('Free 4'); expect(text).toContain('action was refused'); expect(text).not.toContain('undefined'); expect(text).not.toContain('Parts released successfully');
      await review(win); expect(win.document.getElementById('kr-save-pick')).toBeTruthy();
    });

    it('retains a local release and never shows handoff success before confirmation', async () => {
      const f = fixture({ warehouse_accepted_at: 'accepted', prepared_at: 'prepared' }, { local: 'local-kit' });
      const factory = new IDBFactory(); let win = await bootAs(WH, f.respond, factory); await open(win, 'confirm'); ack(win); click(win, 'kr-confirm'); await wait();
      expect(win.document.getElementById('m-view').textContent).toContain('awaiting confirmation');
      expect(win.document.getElementById('m-view').textContent).not.toContain('Parts released successfully');
      win.close(); win = await bootAs(WH, f.respond, factory); await open(win, 'done');
      expect(win.document.getElementById('m-view').textContent).toContain('awaiting confirmation'); expect(win.document.getElementById('kr-retry-action')).toBeNull();
      expect(f.requests).toHaveLength(1);
    });

    it('shows unknown availability and a cancelled deep link without success', async () => {
      const win = await bootAs(WH, (url) => url === '/api/job-orders/184' ? BASE : undefined); await open(win, 'confirm');
      expect(win.document.getElementById('m-view').textContent).toContain('Availability unknown'); expect(win.document.getElementById('kr-confirm')).toBeNull();
      const cancelled = await bootAs(WH, (url) => url === '/api/job-orders/184' ? { ...BASE, status: 'cancelled', released_at: '2026-10-14 01:00:00', parts_slip_number: 'PRS-HISTORICAL' } : undefined); await open(cancelled, 'done');
      expect(cancelled.document.getElementById('m-view').textContent).toContain('cancelled'); expect(cancelled.document.getElementById('m-view').textContent).not.toContain('Parts released successfully');
    });
  });

  describe('production lead and manager (Figma 66:*)', () => {
    const LEAD = { id: 11, username: 'lead', full_name: 'Miguel Santos', role: 'production_lead', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.record', 'messages.view', 'messages.send'] };
    const MGR = { id: 12, username: 'pm', full_name: 'Pia Manager', role: 'production_manager', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.record', 'production.pause', 'production.manage', 'messages.view', 'messages.send'] };
    const BASE = { id: 184, number: 'JO-2026-184', product_name: 'K4 Electric Bike', qty_ordered: 12, qty_done: 0, qty_scrapped: 0,
      qc_stages: 2, status: 'released', released_at: '2026-09-28 01:42:00', released_by_name: 'Ana Alvarez', accepted_at: null,
      units_summary: {}, components: [{ component_name: 'Controller 60 V', qty_planned: 12 }] };
    const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

    const APPROVER = { ...MGR, permissions: [...MGR.permissions, 'production.approve', 'production.view'] };
    const DRAFT = { ...BASE, status: 'draft', approved_at: null, released_at: null, approval_revision: 'a'.repeat(64), source_location_name: 'Parts A', output_location_name: 'Finished B', notes: 'Build for depot', team_name: 'Line 2',
      components: [{ component_item_id: 1, component_name: 'Controller', qty_per_unit: 1, qty_planned: 12 }] };
    const STOCK = { approval_revision: DRAFT.approval_revision, source_location_name: 'Parts A', lines: [{ component_name: 'Controller', component_item_id: 1, need: 12, have: 15, held_elsewhere: 9, available: 6, picked: 0, short: 6 }], shortfalls: [{ component_name: 'Controller', short: 6 }] };
    const tick = (win: any, id: string) => { const el = win.document.getElementById(id); el.checked = true; el.dispatchEvent(new win.Event('change')); };

    it('makes awaiting approval discoverable to approvers in Work, the production hub and manager control', async () => {
      const respond = (url: string) => url === '/api/job-orders?stage=awaiting_approval' ? [DRAFT] : url === '/api/job-orders' ? [] : undefined;
      const win = await bootAs(APPROVER, respond);
      win.location.hash = '#/work'; await wait();
      expect(win.document.getElementById('m-view').textContent).toContain('Awaiting production approval');
      win.location.hash = '#/production'; await wait();
      expect(win.document.getElementById('m-view').textContent).toContain('Awaiting approval');
      win.location.hash = '#/job-orders'; await wait();
      (win.document.getElementById('pm-approvals') as HTMLButtonElement).click(); await wait();
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('1 draft'); expect(view.textContent).toContain('JO-2026-184');
      const warehouse = await bootAs({ ...APPROVER, role: 'warehouse', permissions: ['inventory.adjust', 'inventory.view'] }, respond);
      warehouse.location.hash = '#/work'; await wait();
      expect(warehouse.document.getElementById('m-view').textContent).not.toContain('Awaiting production approval');
      warehouse.location.hash = '#/job-orders?view=approval'; await wait();
      expect(warehouse.document.getElementById('m-view').textContent).toContain('requires production approval permission');
    });

    it('reviews the component snapshot, locations and held stock before approving short demand', async () => {
      const posts: any[] = []; let approved = false;
      const win = await bootAs(APPROVER, (url: string, init: any) => {
        if (url === '/api/job-orders/184/approve' && init.method === 'POST') { posts.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); approved = true; return { ok: true }; }
        if (url === '/api/job-orders/184') return { ...DRAFT, approved_at: approved ? 'approved' : null };
        if (url === '/api/job-orders/184/availability') return STOCK;
        return undefined;
      });
      win.location.hash = '#/job-orders?id=184'; await wait(80);
      const view = win.document.getElementById('m-view'), btn = win.document.getElementById('jo-approve');
      expect(view.textContent).toContain('Parts A'); expect(view.textContent).toContain('Finished B'); expect(view.textContent).toContain('Build for depot');
      expect(view.textContent).toContain('Need 12'); expect(view.textContent).toContain('Held 9'); expect(view.textContent).toContain('Free 6 / 12');
      expect(btn.disabled).toBe(true); tick(win, 'jo-plan-reviewed'); expect(btn.disabled).toBe(true);
      tick(win, 'jo-shortage-reviewed'); expect(btn.disabled).toBe(false);
      win.document.querySelector('[data-approval-note]').value = 'Plan shortage follow-up'; btn.click(); await wait(120);
      expect(posts).toHaveLength(1); expect(posts[0].body).toEqual({ notes: 'Plan shortage follow-up', expected_revision: DRAFT.approval_revision }); expect(posts[0].key).toBeTruthy();
      expect(view.textContent).toContain('Approved — the warehouse'); expect(win.document.getElementById('jo-approve')).toBeNull();
    });

    it.each([null, { ...STOCK, approval_revision: 'b'.repeat(64) }])('blocks approval when availability is unknown or the plan changed while loading', async (stock) => {
      const win = await bootAs(APPROVER, (url) => url === '/api/job-orders/184' ? DRAFT : url === '/api/job-orders/184/availability' ? stock ?? undefined : undefined);
      win.location.hash = '#/job-orders?id=184'; await wait(80);
      expect(win.document.getElementById('jo-approve')).toBeNull();
      expect(win.document.getElementById('jo-refresh-draft')).toBeTruthy();
    });

    it('recovers interrupted approval across restart using the original reviewed plan and note', async () => {
      const factory = new IDBFactory(), requests: any[] = [], applied = new Map(); let lost = true, approved = false;
      const respond = (url: string, init: any) => {
        if (url === '/api/job-orders?stage=awaiting_approval') return approved ? [] : [DRAFT];
        if (url === '/api/job-orders/184') return { ...DRAFT, approved_at: approved ? 'approved' : null };
        if (url === '/api/job-orders/184/availability') return STOCK;
        if (url === '/api/job-orders/184/approve' && init.method === 'POST') {
          const request = { key: init.headers['Idempotency-Key'], payload: init.body }; requests.push(request);
          if (!applied.has(request.key)) { approved = true; applied.set(request.key, { ok: true }); }
          if (lost) { lost = false; return undefined; } return applied.get(request.key);
        }
        return undefined;
      };
      let win = await bootAs(APPROVER, respond, factory); win.location.hash = '#/job-orders?id=184'; await wait(80);
      tick(win, 'jo-plan-reviewed'); tick(win, 'jo-shortage-reviewed'); win.document.querySelector('[data-approval-note]').value = 'Original reviewed note'; win.document.getElementById('jo-approve').click(); await wait(100);
      expect(win.document.getElementById('jo-action-retry')).toBeTruthy(); win.close();
      win = await bootAs(APPROVER, respond, factory); win.location.hash = '#/job-orders?id=184'; await wait(80);
      win.location.hash = '#/job-orders?view=approval'; await wait(80);
      // The authority has already approved it; recovery remains discoverable locally.
      expect(win.document.querySelector('[data-id="184"]')).toBeTruthy();
      win.document.querySelector('[data-id="184"]').click(); await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('Original reviewed note');
      expect(win.document.getElementById('m-view').textContent).toContain('Controller');
      win.document.getElementById('jo-action-retry').click(); await wait(80);
      expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(applied.size).toBe(1);
      expect(win.document.getElementById('m-view').textContent).toContain('Confirmed by site authority');
    });

    it('requires a fresh review and key after a stale-plan refusal', async () => {
      let revision = DRAFT.approval_revision; const requests: any[] = [];
      const win = await bootAs(APPROVER, (url: string, init: any) => {
        if (url === '/api/job-orders/184') return { ...DRAFT, approval_revision: revision, qty_ordered: revision === DRAFT.approval_revision ? 12 : 14 };
        if (url === '/api/job-orders/184/availability') return { ...STOCK, approval_revision: revision };
        if (url === '/api/job-orders/184/approve' && init.method === 'POST') {
          requests.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) }); revision = 'b'.repeat(64);
          return { __status: 409, body: { code: 'stale_job_order', error: 'The draft plan changed. Refresh and review it before approving.' } };
        } return undefined;
      });
      win.location.hash = '#/job-orders?id=184'; await wait(80);
      tick(win, 'jo-plan-reviewed'); tick(win, 'jo-shortage-reviewed'); win.document.getElementById('jo-approve').click(); await wait(100);
      expect(win.document.getElementById('jo-action-retry')).toBeNull(); expect(win.document.getElementById('m-view').textContent).toContain('draft plan changed');
      win.document.getElementById('jo-action-back').click(); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('Qty 14'); expect(win.document.getElementById('jo-approve').disabled).toBe(true);
      tick(win, 'jo-plan-reviewed'); tick(win, 'jo-shortage-reviewed'); win.document.getElementById('jo-approve').click(); await wait(80);
      expect(requests[1].key).not.toBe(requests[0].key); expect(requests[1].body.expected_revision).toBe(revision);
    });

    it('keeps a locally saved approval pending across restart', async () => {
      const factory = new IDBFactory(); let posted = false;
      const respond = (url: string, init: any) => {
        if (url === '/api/job-orders/184') return { ...DRAFT, approved_at: posted ? 'approved' : null };
        if (url === '/api/job-orders/184/availability') return STOCK;
        if (url === '/api/sync/command/approval-local') return { state: 'local' };
        if (url === '/api/job-orders/184/approve' && init.method === 'POST') { posted = true; return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': 'approval-local' }, body: { ok: true } }; }
        return undefined;
      };
      let win = await bootAs(APPROVER, respond, factory); win.location.hash = '#/job-orders?id=184'; await wait(80);
      tick(win, 'jo-plan-reviewed'); tick(win, 'jo-shortage-reviewed'); win.document.getElementById('jo-approve').click(); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending');
      win.close(); win = await bootAs(APPROVER, respond, factory); win.location.hash = '#/job-orders?id=184'; await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending'); expect(win.document.getElementById('jo-approve')).toBeNull();
    });

    it('gates Accept job order on the kit count, then accepts', async () => {
      const posts: Array<{ url: string; body: string }> = [];
      const win = await bootAs(LEAD, (url: string, init: { method?: string; body?: string }) => {
        if (init && init.method === 'POST') { posts.push({ url, body: String(init.body) }); return { ok: true, job_order: { ...BASE, accepted_at: 'x' } }; }
        if (url === '/api/job-orders/184') return posts.length ? { ...BASE, accepted_at: '2026-09-28 02:03:00', accepted_by_name: 'Miguel Santos', status: 'released' } : BASE;
        if (url === '/api/job-orders/184/units') return [];
        return undefined;
      });
      win.location.hash = '#/job-orders?id=184';
      await wait();
      const doc = win.document;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:79');
      const accept = doc.getElementById('jo-accept') as HTMLButtonElement;
      expect(accept.disabled).toBe(true);
      const chk = doc.getElementById('jo-counted') as HTMLInputElement;
      chk.checked = true; chk.dispatchEvent(new win.Event('change'));
      accept.click();
      await wait(120);
      expect(posts.map((p) => p.url)).toEqual(['/api/job-orders/184/accept']);
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:185');
    });

    it('saves units one at a time and never re-sends a saved unit after the connection drops', async () => {
      const uploads: string[] = [];
      let failNext = false;
      const ACCEPTED = { ...BASE, accepted_at: '2026-09-28 02:03:00', status: 'in_progress' };
      const win = await bootAs(LEAD, (url: string, init: { method?: string; body?: FormData }) => {
        if (init && init.method === 'POST' && url === '/api/job-orders/184/units') {
          if (failNext) { failNext = false; return undefined; } // network failure
          uploads.push(String(init.body && (init.body as FormData).get('identifier')));
          return { ok: true, id: uploads.length };
        }
        if (url === '/api/job-orders/184') return ACCEPTED;
        return undefined;
      });
      // Photo picker stub: the real one opens the camera.
      win.mPhoto = { pickFile: () => Promise.resolve(new win.File(['x'], 'unit.jpg', { type: 'image/jpeg' })) };
      win.location.hash = '#/job-orders?id=184&step=count';
      await wait();
      const doc = win.document;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:240');
      (doc.querySelector('.rk-stepper input') as HTMLInputElement).value = '2';
      (doc.getElementById('jo-continue') as HTMLButtonElement).click();
      await wait();
      async function fill(id: string) {
        (doc.querySelector('[data-photo]') as HTMLButtonElement).click();
        await wait();
        const ident = doc.getElementById('jo-ident') as HTMLInputElement;
        ident.value = id; ident.dispatchEvent(new win.Event('input'));
      }
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:294');
      await fill('K4-01');
      (doc.getElementById('jo-save') as HTMLButtonElement).click();
      await wait();
      expect(uploads).toEqual(['K4-01']);
      await fill('K4-02');
      failNext = true;
      (doc.getElementById('jo-save') as HTMLButtonElement).click();
      await wait(80);
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('66:356');
      expect(view.textContent).toContain('Confirmed 1 of 2');
      expect(view.textContent).toContain('K4-01');
      (doc.getElementById('jo-retry') as HTMLButtonElement).click();
      await wait(120);
      expect(uploads).toEqual(['K4-01', 'K4-02']); // unit 1 not sent twice
    });

    it.each(['accept', 'output', 'scrap'])('recovers %s after commit/response loss and restart with the original payload and key', async (kind) => {
      const factory = new IDBFactory();
      const calls: Array<{ key: string; body: string }> = [];
      const applied = new Map<string, unknown>();
      let lose = true;
      const jo = { ...BASE, qc_stages: kind === 'output' ? 0 : 2, accepted_at: kind === 'accept' ? null : 'accepted' };
      const path = '/api/job-orders/184/' + (kind === 'accept' ? 'accept' : 'progress');
      const respond = (url: string, init: any) => {
        if (url === '/api/job-orders/184') return { ...jo };
        if (url === path && init.method === 'POST') {
          const key = init.headers['Idempotency-Key']; calls.push({ key, body: init.body });
          if (!applied.has(key)) {
            applied.set(key, JSON.parse(init.body));
            if (kind === 'accept') jo.accepted_at = 'accepted';
            else { jo.qty_done += JSON.parse(init.body).done_delta || 0; jo.qty_scrapped += JSON.parse(init.body).scrapped_delta || 0; }
          }
          if (lose) { lose = false; return undefined; }
          return { ok: true, job_order: jo };
        }
        return undefined;
      };
      const win = await bootAs(LEAD, respond, factory);
      win.location.hash = '#/job-orders?id=184' + (kind === 'accept' ? '' : '&step=' + kind); await wait();
      if (kind === 'accept') {
        const chk = win.document.getElementById('jo-counted'); chk.checked = true; chk.dispatchEvent(new win.Event('change'));
        win.document.querySelector('[data-note]').value = 'Original handover note';
        win.document.getElementById('jo-accept').click();
      } else {
        if (kind === 'output') { win.document.querySelector('[data-done]').value = '3'; win.document.querySelector('[data-scrap]').value = '1'; win.document.querySelector('[data-batch]').value = 'ORIGINAL-LOT'; }
        else { win.document.querySelector('[data-n]').value = '2'; win.document.querySelector('[data-reason]').value = 'Original scrap reason'; }
        win.document.getElementById('jo-save').click();
      }
      await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('Confirmation unknown');
      const restarted = await bootAs(LEAD, respond, factory);
      restarted.location.hash = '#/job-orders?id=184'; await wait();
      expect(restarted.document.getElementById('jo-action-retry')).not.toBeNull();
      restarted.document.getElementById('jo-action-retry').click(); await wait(120);
      expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(applied.size).toBe(1);
      expect(restarted.document.getElementById('m-view').textContent).toContain('Confirmed by site authority');
      restarted.document.getElementById('jo-action-back').click(); await wait();
      expect(await restarted.mProductionDrafts.loadAction(184)).toBeNull();
    });

    it('rejects fractional, empty, negative and over-remaining production quantities', async () => {
      let posts = 0;
      const win = await bootAs(LEAD, (url: string, init: any) => {
        if (init.method === 'POST') { posts++; return { ok: true }; }
        if (url === '/api/job-orders/184') return { ...BASE, accepted_at: 'accepted', qc_stages: 0 };
        return undefined;
      });
      win.location.hash = '#/job-orders?id=184&step=output'; await wait();
      for (const value of ['1.5', '', '-1', '13']) {
        win.document.querySelector('[data-done]').value = value;
        win.document.getElementById('jo-save').click(); await wait(10);
      }
      expect(posts).toBe(0);
    });

    it('starts a fresh reviewed key after a definitive refusal and keeps a site-PC result pending', async () => {
      const calls: any[] = [];
      let outcome = 'refused';
      const win = await bootAs(LEAD, (url: string, init: any) => {
        if (url === '/api/job-orders/184') return { ...BASE, accepted_at: 'accepted', qc_stages: 0 };
        if (url === '/api/job-orders/184/progress' && init.method === 'POST') {
          calls.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) });
          if (outcome === 'refused') return { __status: 409, body: { error: 'Output changed; review the remaining quantity' } };
          return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': 'progress-local-1' }, body: { ok: true } };
        }
        if (url === '/api/sync/command/progress-local-1') return { state: 'local' };
        return undefined;
      });
      win.location.hash = '#/job-orders?id=184&step=output'; await wait();
      win.document.querySelector('[data-done]').value = '3'; win.document.getElementById('jo-save').click(); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('Request refused');
      expect(win.document.getElementById('jo-action-retry')).toBeNull();
      win.document.getElementById('jo-action-back').click(); await wait();
      outcome = 'local';
      win.location.hash = '#/job-orders?id=184&step=output'; await wait();
      win.document.querySelector('[data-done]').value = '2'; win.document.getElementById('jo-save').click(); await wait(100);
      expect(calls[1].key).not.toBe(calls[0].key);
      expect(calls[1].body.done_delta).toBe(2);
      expect(win.document.getElementById('m-view').textContent).toContain('Saved on site PC');
      expect(win.document.getElementById('m-view').textContent).not.toContain('Confirmed by site authority');
      expect((await win.mProductionDrafts.loadAction(184)).operation.local).toBe('progress-local-1');
    });

    it('replays a committed upload after restart with the same key and photo, locking uncertain inputs', async () => {
      const factory = new IDBFactory();
      const requests: { key: string; identifier: string; photo: Blob }[] = [];
      const committed = new Map<string, number>();
      let loseResponse = true;
      const ACCEPTED = { ...BASE, status: 'in_progress', accepted_at: '2026-10-14 00:00:00' };
      const respond = (url: string, init: any) => {
        if (url === '/api/job-orders/184/units' && init.method === 'POST') {
          const key = init.headers['Idempotency-Key'];
          requests.push({ key, identifier: init.body.get('identifier'), photo: init.body.get('image') });
          if (!committed.has(key)) committed.set(key, 91);
          if (loseResponse) { loseResponse = false; return undefined; }
          return { id: committed.get(key) };
        }
        if (url === '/api/job-orders/184') return ACCEPTED;
        return undefined;
      };
      const win = await bootAs(LEAD, respond, factory);
      // Node Blob/FormData preserve photo bytes through the IndexedDB emulator.
      win.FormData = FormData;
      win.mPhoto = { pickFile: () => Promise.resolve(new File(['kept-photo'], 'unit.jpg', { type: 'image/jpeg' })) };
      win.location.hash = '#/job-orders?id=184&step=count'; await wait();
      win.document.querySelector('.rk-stepper input').value = '1';
      win.document.getElementById('jo-continue').click(); await wait();
      win.document.querySelector('[data-photo]').click(); await wait();
      const input = win.document.getElementById('jo-ident'); input.value = 'Repeated serial'; input.dispatchEvent(new win.Event('input'));
      win.document.getElementById('jo-save').click(); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation unknown');
      win.location.hash = '#/job-orders?id=184&step=units'; await wait();
      expect(win.document.getElementById('jo-ident').disabled).toBe(true);
      expect(win.document.querySelector('[data-photo]').disabled).toBe(true);
      const restarted = await bootAs(LEAD, respond, factory); restarted.FormData = FormData;
      restarted.location.hash = '#/job-orders?id=184&step=interrupted'; await wait();
      expect(restarted.document.getElementById('m-view').textContent).toContain('Repeated serial');
      restarted.document.getElementById('jo-retry').click(); await wait(120);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.key).toBe(requests[0]!.key);
      expect(requests[1]!.identifier).toBe('Repeated serial');
      expect(await requests[1]!.photo.text()).toBe('kept-photo');
      expect(committed.size).toBe(1);
      expect(restarted.document.getElementById('m-view').textContent).toContain('Confirmed 1 of 1');
      expect(restarted.document.getElementById('m-view').textContent).toContain('#91');
    });

    it('blocks uploading when the production attempt cannot be persisted', async () => {
      let uploads = 0;
      const win = await bootAs(LEAD, (url: string, init: any) => {
        if (url === '/api/job-orders/184') return { ...BASE, accepted_at: 'x' };
        if (url === '/api/job-orders/184/units' && init.method === 'POST') { uploads++; return { id: 91 }; }
        return undefined;
      });
      win.mProductionDrafts.save = () => Promise.reject(new Error('Device storage full'));
      win.location.hash = '#/job-orders?id=184&step=count'; await wait();
      win.document.getElementById('jo-continue').click(); await wait();
      expect(uploads).toBe(0);
      expect(win.document.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:240');
      expect(win.document.getElementById('jo-continue').disabled).toBe(false);
    });

    it('lands a Production Manager on exceptions and needs the review tick + reason to close early', async () => {
      const posts: string[] = [];
      const PAUSED = { ...BASE, status: 'paused', accepted_at: 'x', qty_done: 7, qty_ordered: 20, paused_at: '2026-09-28 00:00:00', open_issues: 0 };
      const win = await bootAs(MGR, (url: string, init: { method?: string }) => {
        if (init && init.method === 'POST') { posts.push(url); return { ok: true }; }
        if (url === '/api/job-orders') return [PAUSED];
        if (url === '/api/job-orders/184') return PAUSED;
        return undefined;
      });
      win.location.hash = '#/job-orders';
      await wait();
      const doc = win.document;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('66:515');
      expect(doc.getElementById('m-view').textContent).toContain('1 exception');
      win.location.hash = '#/job-orders?id=184&step=close';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('13 units will not be produced');
      const close = doc.getElementById('jo-close') as HTMLButtonElement;
      expect(close.disabled).toBe(true);
      const chk = doc.getElementById('jo-reviewed') as HTMLInputElement;
      chk.checked = true; chk.dispatchEvent(new win.Event('change'));
      close.click(); // no reason yet
      await wait();
      expect(posts).toEqual([]);
      (doc.querySelector('[data-reason]') as HTMLInputElement).value = 'Customer reduced the quantity';
      close.click();
      await wait();
      expect(posts).toEqual(['/api/job-orders/184/close']);
    });
  });

  describe('QC and QA inspection (Figma 69:*, 72:*)', () => {
    const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
    const QC = { id: 21, username: 'qc1', full_name: 'Ramon Cruz', role: 'qc_inspector', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.inspect_qc', 'messages.view', 'messages.send'] };
    const QA = { ...QC, id: 22, username: 'qa1', full_name: 'Lea Santos', role: 'qa_inspector',
      permissions: ['inventory.view', 'inventory.mobile', 'production.inspect_qa', 'messages.view', 'messages.send'] };
    const UNIT = { id: 501, identifier: 'EB-2409-018', status: 'pending', stage: 0, created_at: '2026-09-29 01:00:00', updated_at: '2026-09-29 01:00:00',
      job_order_id: 184, job_order_number: 'JO-2026-184', product_name: 'K4 Electric Bike', qc_stages: 2, priority: 0,
      team_name: 'Line 2', batch_number: null, batch_identifier: null, last_fail: null as unknown, last_pass: null as unknown, open_part_requests: 0 };
    const REWORK = { ...UNIT, id: 502, identifier: 'EB-2409-011', status: 'rework',
      last_fail: { remarks: 'Loose rear fender bolt', checklist: [{ label: 'Frame and fasteners', ok: false, status: 'issue' }],
        repair_station: 'Mechanical', repair_category: 'Mechanical · fasteners', repair_priority: 'Normal', created_at: '2026-09-29 00:30:00' } };
    const JO = { id: 184, number: 'JO-2026-184', product_item_id: 7, qc_stages: 2,
      qc_checklist_qc: { id: 3, name: 'E-bike technical', items: [
        { label: 'Frame and fasteners', required: true, group: 'Safety and mechanical' },
        { label: 'Battery voltage', required: false, group: 'Electrical and function', measure: 'V' },
      ] }, qc_checklist_qa: null };

    const HOLDS = [{ id: 503, identifier: 'EB-2409-020', stage: 1, job_order_id: 184, job_order_number: 'JO-2026-184', product_name: 'K4 Electric Bike',
      qc_stages: 2, record_id: 77, remarks: 'Paint shade differs from sample', held_at: '2026-10-02 01:00:00', held_by_name: 'Lea Santos', evidence: 1,
      issues: [{ label: 'Paint finish', note: 'Shade' }] }];
    function fake(posts: { url: string; body: any }[], queue: Record<string, unknown> = { role: 'qc', units: [UNIT, REWORK], completed: [] }) {
      return (url: string, init: { method?: string; body?: string }) => {
        if (init && init.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body || '{}')) }); return { ok: true, inspected: 1 }; }
        if (url.startsWith('/api/qc/queue')) return queue;
        if (url === '/api/qc/holds') return HOLDS;
        if (url === '/api/job-orders/184') return JO;
        return undefined;
      };
    }

    it('shows the QC queue with Ready and Reinspect lists from /qc/queue', async () => {
      const win = await bootAs(QC, fake([]));
      win.location.hash = '#/qc?role=qc';
      await wait();
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('69:16');
      expect(win.document.documentElement.getAttribute('data-role-accent')).toBe('qc');
      expect(view.textContent).toContain('1 unit');
      expect(view.textContent).toContain('EB-2409-018');
      expect(view.textContent).not.toContain('EB-2409-011');
      (view.querySelector('[data-tab="re"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('EB-2409-011');
      expect(view.textContent).toContain('Reinspection after repair');
    });

    it('walks grouped steps, blocks N/A on a required check, and posts Pass/Issue/N/A with readings', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(QC, fake(posts));
      const doc = win.document;
      win.location.hash = '#/qc?role=qc&unit=501';
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:104');
      (doc.getElementById('qc-start') as HTMLButtonElement).click();
      await wait();
      let view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('69:145');
      expect(view.textContent).toContain('Step 1 of 2');
      (view.querySelector('[data-i="0"]') as HTMLButtonElement).click();
      expect((view.querySelector('[data-set="na"]') as HTMLButtonElement).disabled).toBe(true);
      (view.querySelector('[data-set="pass"]') as HTMLButtonElement).click();
      (doc.getElementById('qc-next') as HTMLButtonElement).click();
      await wait();
      view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('69:197');
      (doc.getElementById('qc-next') as HTMLButtonElement).click(); // no reading yet
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:197');
      const reading = view.querySelector('[data-m="0"]') as HTMLInputElement;
      reading.value = '67.4'; reading.dispatchEvent(new win.Event('input'));
      (view.querySelector('[data-mset="0"][data-v="pass"]') as HTMLButtonElement).click();
      (doc.getElementById('qc-next') as HTMLButtonElement).click();
      await wait();
      view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('69:247');
      expect(view.textContent).toContain('2 passed');
      (view.querySelector('[data-d="pass"]') as HTMLButtonElement).click();
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:286');
      expect(doc.getElementById('m-view').textContent).toContain('Ready for QA');
      (doc.getElementById('qc-confirm') as HTMLButtonElement).click();
      await wait(80);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe('/api/job-orders/184/units/inspect');
      expect(posts[0]!.body).toMatchObject({ unit_ids: [501], result: 'pass', checklist: [
        { label: 'Frame and fasteners', ok: true, status: 'pass' },
        { label: 'Battery voltage', ok: true, status: 'pass', value: '67.4' },
      ] });
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:436');
      expect(doc.getElementById('m-view').textContent).toContain('Passed to QA');
    });

    it('keeps Pass unavailable while an issue is open and sends a repair only with its evidence photo', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(QC, fake(posts));
      const doc = win.document;
      win.location.hash = '#/qc?role=qc&unit=501&step=check&g=0';
      await wait();
      let view = doc.getElementById('m-view');
      (view.querySelector('[data-i="0"]') as HTMLButtonElement).click();
      (view.querySelector('[data-set="issue"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('Issue detected');
      win.location.hash = '#/qc?role=qc&unit=501&step=review';
      await wait();
      view = doc.getElementById('m-view');
      expect((view.querySelector('[data-d="pass"]') as HTMLButtonElement).disabled).toBe(true);
      const rem = view.querySelector('[data-remarks]') as HTMLTextAreaElement;
      rem.value = 'Loose rear fender bolt'; rem.dispatchEvent(new win.Event('input'));
      (view.querySelector('[data-d="repair"]') as HTMLButtonElement).click();
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:323');
      (doc.getElementById('qc-go') as HTMLButtonElement).click(); // no photo yet → evidence screen, nothing sent
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('69:364');
      expect(posts).toEqual([]);
    });

    it('opens the QA desk in amber from the Work hub with QC-passed units and a hold outcome', async () => {
      const passed = { ...UNIT, stage: 1, last_pass: { created_at: '2026-09-29 01:30:00', inspector_name: 'Ramon Cruz', stage: 1, items: 8 } };
      const win = await bootAs(QA, fake([], { role: 'qa', units: [passed], completed: [] }));
      win.location.hash = '#/qc?role=qa';
      await wait();
      const doc = win.document;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('72:16');
      expect(doc.documentElement.getAttribute('data-role-accent')).toBe('qa');
      expect(doc.getElementById('m-view').textContent).toContain('QC passed');
      win.location.hash = '#/qc?role=qa&unit=501';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('Ramon Cruz');
      win.location.hash = '#/qc?role=qa&unit=501&step=fail';
      await wait();
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('72:396');
      expect(view.textContent).toContain('Hold for review (QA decides)');
      expect((doc.getElementById('qc-confirm') as HTMLButtonElement).disabled).toBe(true);
    });

    it('records a hold as a hold, with the evidence photo uploaded for it', async () => {
      const posts: { url: string; body: any }[] = [];
      const passed = { ...UNIT, stage: 1 };
      const win = await bootAs(QA, fake(posts, { role: 'qa', units: [passed], completed: [] }));
      const doc = win.document;
      win.mPhoto.pickFile = () => Promise.resolve(new win.Blob(['x'], { type: 'image/jpeg' }));
      win.mPhoto.attachBlob = () => Promise.resolve({ id: 91 });
      win.location.hash = '#/qc?role=qa&unit=501&step=evidence&then=fail';
      await wait();
      (doc.getElementById('qc-cap') as HTMLButtonElement).click();
      await wait(80);
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('72:396');
      (view.querySelector('[data-out]') as HTMLSelectElement).value = 'hold';
      (view.querySelector('[data-reason]') as HTMLTextAreaElement).value = 'Paint shade differs from sample';
      const chk = doc.getElementById('qc-reviewed') as HTMLInputElement;
      chk.checked = true; chk.dispatchEvent(new win.Event('change'));
      (doc.getElementById('qc-confirm') as HTMLButtonElement).click();
      await wait(80);
      expect(posts[0]).toMatchObject({ url: '/api/job-orders/184/units/inspect',
        body: { unit_ids: [501], result: 'fail', disposition: 'hold', evidence_ids: [91] } });
      expect(posts[0]!.body.repair).toBeUndefined();
    });

    it.each(['qc', 'qa'])('creates separate chassis and fairings reports with their own photos (%s)', async (role) => {
      const who = role === 'qa' ? QA : QC, reports: any[] = [], photos: any[] = [];
      const win = await bootAs(who, (url: string, init: any) => {
        if (url === '/api/production/record?unit=501') return { unit: UNIT, job_order: { ...JO, number: 'JO-2026-184' } };
        if (url.startsWith('/api/production-issues?')) return reports;
        if (url === '/api/production-issues' && init.method === 'POST') { const i = { ...JSON.parse(init.body), id: reports.length + 1, status: 'open', photo_count: 0, reported_by_name: 'Inspector' }; reports.push(i); return i; }
        if (url === '/api/attachments' && init.method === 'POST') { const ref = Number(init.body.get('ref_id')); photos.push({ ref, key: init.headers['Idempotency-Key'] }); reports.find(i => i.id === ref).photo_count++; return { id: photos.length }; }
        return undefined;
      });
      win.FormData = globalThis.FormData;
      win.mPhoto.picker = (opts: any) => { win.issuePicker = opts; return win.document.createElement('div'); };
      win.location.hash = '#/unit-issues?unit=501&role=' + role; await wait(80);
      for (const area of ['Chassis', 'Fairings']) {
        if (area === 'Chassis') win.document.getElementById('ui-new').click();
        else win.document.getElementById('ui-another').click();
        await wait(80);
        const input = win.document.querySelector('[data-area]'); input.value = area; input.dispatchEvent(new win.Event('input'));
        const description = win.document.querySelector('[data-description]'); description.value = area + ' issue description'; description.dispatchEvent(new win.Event('input'));
        win.issuePicker.onChange([new Blob([area + '-image-bytes'], { type: 'image/jpeg' })]); await wait(80);
        win.document.getElementById('ui-send').click(); await wait(120);
        expect(win.document.getElementById('m-view').textContent).toContain('Issue report confirmed');
      }
      expect(reports.map(i => i.category)).toEqual(['Chassis', 'Fairings']); expect(photos.map(p => p.ref)).toEqual([1, 2]); expect(photos[0].key).not.toBe(photos[1].key);
      win.document.getElementById('ui-back').click(); await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('Chassis'); expect(win.document.getElementById('m-view').textContent).toContain('Fairings');
    });

    async function waitForIssueElement(win: any, selector: string) {
      for (let n = 0; n < 100; n++) {
        const element = win.document.querySelector(selector); if (element) return element;
        await wait(20);
      }
      throw new Error('Missing issue element ' + selector + ': ' + win.document.getElementById('m-view').textContent);
    }

    it.each(['report', 'photo'])('recovers a lost %s response with original keys, bytes and links after restart', async (phase) => {
      const factory = new IDBFactory(), created = new Map(), uploaded = new Map(), calls: any[] = []; let lost = true;
      const respond = (url: string, init: any) => {
        if (url === '/api/production/record?unit=501') return { unit: UNIT, job_order: { ...JO, number: 'JO-2026-184' } };
        if (url.startsWith('/api/production-issues?')) return [...created.values()];
        if (url === '/api/production-issues' && init.method === 'POST') {
          const key = init.headers['Idempotency-Key']; calls.push({ phase: 'report', key, body: init.body });
          if (!created.has(key)) created.set(key, { ...JSON.parse(init.body), id: 81, status: 'open', photo_count: uploaded.size });
          if (phase === 'report' && lost) { lost = false; return undefined; } return created.get(key);
        }
        if (url === '/api/attachments' && init.method === 'POST') {
          const key = init.headers['Idempotency-Key']; calls.push({ phase: 'photo', key, ref: init.body.get('ref_id'), image: init.body.get('image') });
          if (!uploaded.has(key)) uploaded.set(key, { id: 91 });
          if (phase === 'photo' && lost) { lost = false; return undefined; } return uploaded.get(key);
        } return undefined;
      };
      function picker(win: any) { win.FormData = globalThis.FormData; win.mPhoto.picker = (opts: any) => { win.issuePicker = opts; return win.document.createElement('div'); }; }
      let win = await bootAs(QC, respond, factory); picker(win); win.location.hash = '#/unit-issues?unit=501&step=new'; await wait(80);
      win.document.querySelector('[data-description]').value = 'Original chassis finding'; win.document.querySelector('[data-description]').dispatchEvent(new win.Event('input'));
      win.issuePicker.onChange([new Blob(['original-chassis-bytes'], { type: 'image/jpeg' })]); await wait(80); win.document.getElementById('ui-send').click(); await wait(100);
      expect(win.document.getElementById('ui-retry')).toBeTruthy(); expect(win.document.querySelector('[data-description]')).toBeNull(); win.close();
      win = await bootAs(QC, respond, factory); picker(win); win.location.hash = '#/unit-issues?unit=501'; await wait(80); (await waitForIssueElement(win, '[data-saved] [data-id]')).click();
      (await waitForIssueElement(win, '#ui-retry')).click(); await wait(120);
      expect(created.size).toBe(1); expect(uploaded.size).toBe(1);
      const retries = calls.filter(c => c.phase === phase); expect(retries).toHaveLength(2); expect(retries[0].key).toBe(retries[1].key);
      if (phase === 'photo') { expect(retries[0].ref).toBe('81'); expect(await retries[1].image.text()).toBe('original-chassis-bytes'); }
      else expect(retries[0].body).toBe(retries[1].body);
    });

    it('retains unsent description and photo bytes as a draft across restart', async () => {
      const factory = new IDBFactory(); const respond = (url: string) => url === '/api/production/record?unit=501' ? { unit: UNIT, job_order: { ...JO, number: 'JO-2026-184' } } : url.startsWith('/api/production-issues?') ? [] : undefined;
      let win = await bootAs(QA, respond, factory); win.mPhoto.picker = (opts: any) => { win.issuePicker = opts; return win.document.createElement('div'); };
      win.location.hash = '#/unit-issues?unit=501&role=qa&step=new'; await wait(80);
      win.document.querySelector('[data-description]').value = 'Fairing scratch draft'; win.document.querySelector('[data-description]').dispatchEvent(new win.Event('input'));
      win.issuePicker.onChange([new Blob(['unsent-fairing-photo'], { type: 'image/jpeg' })]); await wait(80); const savedRoute = win.location.hash; win.close();
      win = await bootAs(QA, respond, factory); let photos: Blob[] = [];
      win.mPhoto.picker = (opts: any) => { photos = opts.initial; return win.document.createElement('div'); };
      win.location.hash = savedRoute; await wait(80);
      expect(win.document.querySelector('[data-description]').value).toBe('Fairing scratch draft'); expect(await photos[0]!.text()).toBe('unsent-fairing-photo');
    });

    it('requires visible-defect photos and gives a corrected refused report a fresh key', async () => {
      const calls: any[] = []; let refused = true;
      const win = await bootAs(QC, (url: string, init: any) => {
        if (url === '/api/production/record?unit=501') return { unit: UNIT, job_order: { ...JO, number: 'JO-2026-184' } };
        if (url.startsWith('/api/production-issues?')) return [];
        if (url === '/api/production-issues' && init.method === 'POST') {
          calls.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) });
          if (refused) { refused = false; return { __status: 400, body: { error: 'Review description' } }; }
          return { id: 81 };
        } return undefined;
      });
      win.mPhoto.picker = () => win.document.createElement('div');
      win.location.hash = '#/unit-issues?unit=501&step=new';
      const description = await waitForIssueElement(win, '[data-description]'); description.value = 'Noise heard during test'; description.dispatchEvent(new win.Event('input'));
      win.document.getElementById('ui-send').click(); await wait(30); expect(calls).toHaveLength(0);
      const visible = win.document.getElementById('ui-visible'); visible.checked = false; visible.dispatchEvent(new win.Event('change'));
      win.document.getElementById('ui-send').click(); (await waitForIssueElement(win, '#ui-correct')).click();
      const corrected = await waitForIssueElement(win, '[data-description]'); corrected.value = 'Intermittent noise at left bearing'; corrected.dispatchEvent(new win.Event('input'));
      win.document.getElementById('ui-send').click(); await waitForIssueElement(win, '#ui-another');
      expect(calls).toHaveLength(2); expect(calls[0].key).not.toBe(calls[1].key); expect(calls[1].body.description).toBe('Intermittent noise at left bearing');
    });

    it('keeps two independent offline issue drafts and their own photos after restart', async () => {
      const factory = new IDBFactory();
      let disconnected = false;
      const respond = (url: string) => disconnected ? undefined : url === '/api/production/record?unit=501' ? { unit: UNIT, job_order: { ...JO, number: 'JO-2026-184' } } : url.startsWith('/api/production-issues?') ? [] : undefined;
      let win = await bootAs(QC, respond, factory);
      Object.defineProperty(win.navigator, 'onLine', { value: false, configurable: true });
      win.mPhoto.picker = (opts: any) => { win.issuePicker = opts; return win.document.createElement('div'); };
      win.location.hash = '#/unit-issues?unit=501'; await wait(80);
      for (const area of ['Chassis', 'Fairings']) {
        win.document.getElementById('ui-new').click(); await wait(80);
        const input = win.document.querySelector('[data-area]'); input.value = area; input.dispatchEvent(new win.Event('input'));
        const description = win.document.querySelector('[data-description]'); description.value = area + ' offline finding'; description.dispatchEvent(new win.Event('input'));
        win.issuePicker.onChange([new Blob([area + '-offline-photo'], { type: 'image/jpeg' })]); await wait(80); disconnected = true;
        win.document.getElementById('ui-send').click(); await wait(30);
        expect(win.document.querySelector('[data-description]')).toBeTruthy();
        win.document.getElementById('ui-list').click(); await wait(80);
      }
      expect(win.document.querySelectorAll('[data-saved] [data-id]')).toHaveLength(2); win.close();
      win = await bootAs(QC, respond, factory); let photos: Blob[] = [];
      win.mPhoto.picker = (opts: any) => { photos = opts.initial; return win.document.createElement('div'); };
      win.location.hash = '#/unit-issues?unit=501'; await wait(80);
      const cards = [...win.document.querySelectorAll('[data-saved] [data-id]')]; expect(cards).toHaveLength(2); expect(win.document.getElementById('m-view').textContent).toContain('Reported issues unknown');
      const routes = cards.map((c: any) => '#/unit-issues?unit=501&draft=' + c.dataset.id);
      const restored = [];
      for (const hash of routes) {
        win.location.hash = hash; await wait(80);
        expect(win.document.getElementById('m-view').textContent).toContain('Using the saved unit details');
        const area = win.document.querySelector('[data-area]').value;
        restored.push(area); expect(win.document.querySelector('[data-description]').value).toBe(area + ' offline finding');
        expect(await photos[0]!.text()).toBe(area + '-offline-photo');
      }
      expect(restored.sort()).toEqual(['Chassis', 'Fairings']);
    });

    it('offers eligible own issue photos as inspection evidence without another upload', async () => {
      const win = await bootAs(QC, (url: string) => {
        if (url.startsWith('/api/qc/queue')) return { units: [UNIT], completed: [] };
        if (url === '/api/job-orders/184') return JO;
        if (url === '/api/production-issues?unit_id=501') return [{ id: 81 }, { id: 82 }];
        if (url === '/api/attachments?kind=production_issue&ref_id=81') return [{ id: 91, inspection_available: true }, { id: 92, inspection_available: false }];
        if (url === '/api/attachments?kind=production_issue&ref_id=82') return [{ id: 93, inspection_available: true }];
        return undefined;
      });
      win.location.hash = '#/qc?role=qc&unit=501&step=evidence&then=fail'; await wait(80);
      win.document.getElementById('qc-report-evidence').click(); await wait(80);
      expect(win.location.hash).toContain('step=fail'); expect(win.document.getElementById('m-view').textContent).toContain('2 close-up photos');
    });

    it('times out a stuck hold lookup and ignores its later response', async () => {
      const win = await bootAs(QA, (url) => url.startsWith('/api/qc/queue') ? { units: [], completed: [] } : undefined);
      const fetch = win.fetch, timeout = win.setTimeout.bind(win);
      let finish: (response: any) => void = () => {};
      win.fetch = (url: string, init: any) => url === '/api/qc/holds' ? new Promise(resolve => { finish = resolve; }) : fetch(url, init);
      win.setTimeout = (fn: any, ms: number, ...args: any[]) => timeout(fn, ms === 20000 ? 1 : ms, ...args);
      win.location.hash = '#/qc?role=qa&tab=hold'; await wait(80);
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('Count unknown'); expect(view.textContent).not.toContain('No units on hold');
      finish({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(HOLDS) }); await wait(40);
      expect(view.textContent).toContain('Count unknown'); expect(view.querySelector('[data-hold]')).toBeNull();
    });

    it.each([403, 500, 0])('shows unknown holds and a retry when lookup fails (%s)', async (status) => {
      let failed = true;
      const win = await bootAs(QA, (url) => {
        if (url.startsWith('/api/qc/queue')) return { units: [], completed: [] };
        if (url === '/api/qc/holds') return failed ? status ? { __status: status, body: { error: 'Hold lookup unavailable' } } : undefined : [];
        return undefined;
      });
      win.location.hash = '#/qc?role=qa&tab=hold'; await wait(80);
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('On hold?'); expect(view.textContent).toContain('Unable to load holds'); expect(view.textContent).not.toContain('No units on hold');
      failed = false; win.document.getElementById('qc-holds-refresh').click(); await wait(80);
      expect(view.textContent).toContain('No units on hold'); expect(view.textContent).toContain('On hold0');
    });

    it.each(['pass', 'rectify', 'fail'])('recovers a lost %s hold decision after restart with one immutable operation', async (outcome) => {
      const factory = new IDBFactory(), requests: any[] = [], applied = new Map(); let lost = true, held = true;
      const respond = (url: string, init: any) => {
        if (url.startsWith('/api/qc/queue')) return { units: [], completed: [] };
        if (url === '/api/qc/holds') return held ? HOLDS : [];
        if (url.endsWith('/hold-decision') && init.method === 'POST') {
          const request = { key: init.headers['Idempotency-Key'], payload: init.body }; requests.push(request);
          if (!applied.has(request.key)) { held = false; applied.set(request.key, { ok: true }); }
          if (lost) { lost = false; return undefined; } return applied.get(request.key);
        } return undefined;
      };
      let win = await bootAs(QA, respond, factory); win.location.hash = '#/qc?role=qa&unit=503&step=hold'; await wait(80);
      win.document.querySelector('[data-o="' + outcome + '"]').click(); win.document.querySelector('[data-why]').value = 'Original hold decision reason';
      if (outcome === 'fail') win.document.querySelector('[data-disp]').value = 'recycle';
      if (outcome === 'rectify') win.document.querySelector('[data-station]').value = 'Paint';
      win.document.getElementById('qc-decide').click(); await wait(80);
      expect(win.document.querySelector('[data-o]')).toBeNull(); expect(win.document.getElementById('qc-hold-retry')).toBeTruthy(); win.close();
      win = await bootAs(QA, respond, factory); win.location.hash = '#/qc?role=qa&tab=hold'; await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('Review saved decision');
      win.document.querySelector('[data-hold="503"]').click(); await wait(80); expect(win.document.getElementById('m-view').textContent).toContain('Original hold decision reason');
      win.document.getElementById('qc-hold-retry').click(); await wait(80);
      expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(applied.size).toBe(1);
      expect(JSON.parse(requests[0].payload)).toMatchObject({ outcome, expected_hold_record_id: 77 });
      expect(win.document.getElementById('m-view').textContent).toContain('Confirmed by site authority');
      if (outcome === 'pass') expect(win.document.getElementById('m-view').textContent).toContain('Stock is added only when receiving');
    });

    it('uses a fresh key for a corrected decision after a definitive refusal and reload', async () => {
      const requests: any[] = []; let recordId = 77;
      const win = await bootAs(QA, (url: string, init: any) => {
        if (url === '/api/qc/holds') return [{ ...HOLDS[0], record_id: recordId }];
        if (url.endsWith('/hold-decision') && init.method === 'POST') {
          requests.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) }); recordId = 78;
          return requests.length === 1 ? { __status: 409, body: { code: 'stale_hold', error: 'Different hold record. Review again.' } } : { ok: true };
        } return undefined;
      });
      win.location.hash = '#/qc?role=qa&unit=503&step=hold'; await wait(80);
      win.document.querySelector('[data-why]').value = 'Original pass reason'; win.document.getElementById('qc-decide').click(); await wait(80);
      expect(win.document.getElementById('qc-hold-retry')).toBeNull(); win.document.getElementById('qc-hold-back').click(); await wait(80);
      win.document.querySelector('[data-o="rectify"]').click(); win.document.querySelector('[data-why]').value = 'Corrected rectification decision'; win.document.getElementById('qc-decide').click(); await wait(80);
      expect(requests[1].key).not.toBe(requests[0].key); expect(requests[1].body).toMatchObject({ outcome: 'rectify', expected_hold_record_id: 78 });
    });

    it('retains a site-PC decision as pending after restart without offering another decision', async () => {
      const factory = new IDBFactory(); let posted = false;
      const respond = (url: string, init: any) => {
        if (url.startsWith('/api/qc/queue')) return { units: [], completed: [] };
        if (url === '/api/qc/holds') return posted ? [] : HOLDS;
        if (url === '/api/sync/command/hold-local') return { state: 'local' };
        if (url.endsWith('/hold-decision') && init.method === 'POST') { posted = true; return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': 'hold-local' }, body: { ok: true } }; }
        return undefined;
      };
      let win = await bootAs(QA, respond, factory); win.location.hash = '#/qc?role=qa&unit=503&step=hold'; await wait(80);
      win.document.querySelector('[data-why]').value = 'Reviewed colour tolerance'; win.document.getElementById('qc-decide').click(); await wait(80); win.close();
      win = await bootAs(QA, respond, factory); win.location.hash = '#/qc?role=qa&unit=503&step=hold'; await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending'); expect(win.document.getElementById('qc-decide')).toBeNull(); expect(win.document.getElementById('qc-hold-retry')).toBeNull();
    });

    it('does not start a hold mutation when durable storage is unavailable', async () => {
      const requests: string[] = [];
      const win = await bootAs(QA, (url: string, init: any) => { if (init?.method === 'POST') requests.push(url); return url === '/api/qc/holds' ? HOLDS : undefined; });
      win.indexedDB = undefined; win.location.hash = '#/qc?role=qa&unit=503&step=hold'; await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('Draft storage is unavailable'); expect(requests).toEqual([]);
    });

    it('lists held units for QA and records the decision with a reason', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(QA, fake(posts, { role: 'qa', units: [], completed: [] }));
      const doc = win.document;
      win.location.hash = '#/qc?role=qa&tab=hold';
      await wait();
      const view = doc.getElementById('m-view');
      expect(view.textContent).toContain('On hold1');
      expect(view.textContent).toContain('Held by Lea Santos');
      (view.querySelector('[data-hold="503"]') as HTMLButtonElement).click();
      await wait();
      expect(view.textContent).toContain('Paint shade differs from sample');
      (view.querySelector('[data-o="rectify"]') as HTMLButtonElement).click();
      (doc.getElementById('qc-decide') as HTMLButtonElement).click();
      expect(posts).toEqual([]); // a reason is required
      (view.querySelector('[data-why]') as HTMLTextAreaElement).value = 'Repaint the fender';
      (doc.getElementById('qc-decide') as HTMLButtonElement).click();
      await wait();
      expect(posts[0]).toMatchObject({ url: '/api/job-orders/184/units/503/hold-decision', body: { outcome: 'rectify', remarks: 'Repaint the fender' } });
    });

    it('opens the hold list to a Production Manager who only decides holds', async () => {
      const PM = { ...QC, id: 23, username: 'pm1', full_name: 'Paolo Manager', role: 'production_manager',
        permissions: ['inventory.view', 'inventory.mobile', 'production.manage', 'production.qa_review', 'messages.view', 'messages.send'] };
      const win = await bootAs(PM, fake([]));
      win.location.hash = '#/qc?tab=hold';
      await wait();
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('72:16');
      expect(view.textContent).toContain('EB-2409-020');
    });

    it('refuses the QA desk to a QC-only inspector', async () => {
      const win = await bootAs(QC, fake([]));
      win.location.hash = '#/qc?role=qa';
      await wait();
      expect(win.document.getElementById('m-view').textContent).toContain('don’t have the QA inspection permission');
    });
  });

describe('Releasing personnel warehouse-out (Figma 78:*)', () => {
    const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
    const REL = { id: 41, username: 'rel1', full_name: 'Ana Dela Cruz', role: 'releasing_clerk', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'orders.view', 'orders.release', 'messages.view', 'messages.send'] };
    const AUTH = { state: 'valid', required: false, id: 5, mode: 'pickup', recipient_name: 'Jordan D.', id_reference: '••4821',
      token_hint: 'PICKUP-••••', valid_until: '2099-01-01 08:00:00', handoff_area: 'Release Bay 1', partial_allowed: false };
    const UNIT = { id: 701, identifier: 'K4-01', status: 'reserved', product_item_id: 7, product_name: 'K4 Electric Bike', location_name: 'FG-A03', receipt_number: 'PI-00042' };
    const CTX = { order: { id: 302, number: 'SO-00302', status: 'released', customer_name: 'ACME', warehouse_accepted_at: '2026-10-02 01:00:00', location_id: 2 },
      lines: [{ id: 1, item_id: 7, name: 'K4 Electric Bike', sku: 'EB-K4', quantity: 1, released_qty: 0, units: 1, serialized: 1 }],
      units: [UNIT], authorization: AUTH, package: [{ item_id: 7, item_name: 'K4 Electric Bike', label: 'Charger and cable', required: true }],
      reports: [], delivery: null, slip: null };
    function fake(posts: { url: string; body: any; key?: string }[], ctxOver: Record<string, unknown> = {}) {
      return (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
        if (init && init.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body || '{}')), key: init.headers && init.headers['Idempotency-Key'] });
          return { ok: true, id: 88 };
        }
        if (url === '/api/release-slips/queue') return { to_accept: [], releasing: [
          { id: 302, number: 'SO-00302', qty_ordered: 1, qty_released: 1, warehouse_accepted_at: 'x', authorization: AUTH, summary: { first_name: 'K4 Electric Bike', lines: 1 }, delivery: null, open_reports: 0 },
          { id: 308, number: 'SO-00308', qty_ordered: 1, qty_released: 0, warehouse_accepted_at: 'x', authorization: { ...AUTH, state: 'revoked', revoke_reason: 'Customer hold' }, summary: { first_name: 'K1 Bike', lines: 1 }, delivery: null, open_reports: 0 },
        ], completed: [], authorization_required: false };
        if (url === '/api/release-slips/orders/302/context') return { ...CTX, ...ctxOver };
        if (url.startsWith('/api/release-slips/orders/302/unit?code=K4-99')) return { state: 'other_order', unit: { ...UNIT, identifier: 'K4-99', order_number: 'SO-00310' } };
        if (url.startsWith('/api/release-slips/orders/302/verify-token?token=PICKUP-7F3Q')) return { ok: true };
        if (url.startsWith('/api/release-slips/orders/302/verify-token')) return { ok: false, error: 'The release token does not match this order.' };
        return undefined;
      };
    }

    async function relElement(win: any, selector: string) {
      for (let i = 0; i < 100; i++) { const e = win.document.querySelector(selector); if (e) return e; await wait(20); }
      throw new Error('Missing releasing element: ' + selector + ' ' + win.document.getElementById('m-view').textContent);
    }
    it('separates unaccepted and partially allocated orders from ready handoff', async () => {
      const win = await bootAs(REL, (url: string) => url === '/api/release-slips/queue' ? { to_accept: [{ id: 301, number: 'SO-NEW', qty_ordered: 2, qty_released: 0, authorization: AUTH, location_name: 'Warehouse A' }], releasing: [{ id: 302, number: 'SO-PARTIAL', qty_ordered: 2, qty_released: 1, warehouse_accepted_at: 'x', authorization: AUTH, location_name: 'Warehouse B' }, { id: 303, number: 'SO-READY', qty_ordered: 2, qty_released: 2, warehouse_accepted_at: 'x', authorization: AUTH, location_name: 'Warehouse B' }], completed: [] } : undefined);
      win.location.hash = '#/so'; await relElement(win, '[data-order="303"]');
      expect(win.document.querySelector('[data-order="301"]')).toBeNull(); expect(win.document.querySelector('[data-order="302"]')).toBeNull();
      win.document.querySelector('[data-tab="accept"]').click(); expect(win.document.querySelector('[data-order="301"]').textContent).toContain('Warehouse A');
      win.document.querySelector('[data-tab="allocating"]').click(); expect(win.document.querySelector('[data-order="302"]').textContent).toContain('1 of 2 allocated');
    });
    it.each(['accept', 'bulk', 'serial'])('recovers interrupted %s with the exact original key and request after restart', async (kind) => {
      const factory = new IDBFactory(), applied = new Map(), calls: any[] = []; let lose = true;
      const context = { ...CTX, order: { ...CTX.order, warehouse_accepted_at: kind === 'accept' ? null : 'x', location_name: 'FG-A03' }, units: [],
        lines: [{ item_id: 7, name: 'Measured goods', quantity: 5.5, released_qty: 0, units: 0, serialized: kind === 'serial' ? 1 : 0 }], availability: [{ item_id: 7, free_to_allocate: 3.25 }] };
      const respond = (url: string, init: any) => {
        if (url === '/api/release-slips/orders/302/context') return context;
        if (url.includes('/orders/302/unit?')) return { state: 'available', unit: { ...UNIT, location_id: 2, status: 'in_stock' } };
        if (url === '/api/orders/302/accept-release' || url === '/api/orders/302/release') { const key = init.headers['Idempotency-Key']; calls.push({ url, key, body: init.body }); if (!applied.has(key)) applied.set(key,{ ok: true }); if (lose) { lose = false; return undefined; } return applied.get(key); }
        return undefined;
      };
      let win = await bootAs({ ...REL, permissions: ['mobile.access', 'orders.release'] }, respond, factory);
      win.location.hash = '#/so?id=302' + (kind === 'accept' ? '' : kind === 'bulk' ? '&step=scan' : '&step=unit&code=K4-01');
      if (kind === 'bulk') { const input = await relElement(win, '[data-qty="7"]'); expect(input.value).toBe('3.25'); input.value = '2.5'; win.document.querySelector('[data-bulk="7"]').click(); }
      else (await relElement(win, kind === 'accept' ? '#rel-go' : '#rel-ok')).click();
      await relElement(win, '#rel-retry'); expect(win.document.querySelector('[data-qty]')).toBeNull(); win.close();
      win = await bootAs(REL, respond, factory); win.location.hash = '#/so'; (await relElement(win, '[data-recovery] [data-id]')).click();
      (await relElement(win, '#rel-retry')).click(); await relElement(win, '#rel-review-current');
      expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(applied.size).toBe(1);
      if (kind === 'bulk') expect(JSON.parse(calls[0].body).bulk[0].quantity).toBe(2.5);
    });
    it('blocks excessive bulk counts and units at a different ship-from location', async () => {
      const calls: any[] = [], base = fake(calls, { lines: [{ item_id: 7, name: 'Measured goods', quantity: 5, released_qty: 0, serialized: 0 }], availability: [{ item_id: 7, free_to_allocate: 1.5 }] });
      const win = await bootAs(REL, (url: string, init: any) => url.includes('/orders/302/unit?') ? { state: 'available', unit: { ...UNIT, location_id: 9 } } : base(url,init));
      win.location.hash = '#/so?id=302&step=scan'; const input = await relElement(win, '[data-qty="7"]');
      for (const value of ['', '0', '-1', '2']) { input.value = value; win.document.querySelector('[data-bulk="7"]').click(); await wait(20); }
      expect(calls).toEqual([]); win.location.hash = '#/so?id=302&step=unit&code=K4-01'; await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('different warehouse'); expect(win.document.getElementById('rel-ok')).toBeNull(); expect(calls).toEqual([]);
    });
    it('does not show a site-PC allocation as confirmed before its original command confirms', async () => {
      const factory = new IDBFactory(); let state = 'pending', calls = 0;
      const base = fake([],{ units: [], lines: [{ item_id: 7, name: 'Measured goods', quantity: 5, released_qty: 0, serialized: 0 }], availability: [{ item_id: 7, free_to_allocate: 3 }] });
      const respond = (url: string, init: any) => { if (url === '/api/orders/302/release') { calls++; return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': 'release-local' }, body: { ok: true } }; } if (url === '/api/sync/command/release-local') return { state }; return base(url,init); };
      let win = await bootAs(REL,respond,factory); win.location.hash = '#/so?id=302&step=scan'; (await relElement(win,'[data-bulk="7"]')).click(); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending'); expect(win.document.getElementById('rel-review-current')).toBeNull(); win.close();
      state = 'confirmed'; win = await bootAs(REL,respond,factory); win.location.hash = '#/so?id=302'; await relElement(win,'#rel-review-current'); expect(calls).toBe(1);
    });

    it('reloads stock after refusal and creates a new key only after review', async () => {
      const calls: any[] = []; let refused = true;
      const base = fake([],{ units: [], lines: [{ item_id: 7, name: 'Measured goods', quantity: 5, released_qty: 0, serialized: 0 }], availability: [{ item_id: 7, free_to_allocate: 3 }] });
      const win = await bootAs(REL,(url: string, init: any) => {
        if (url === '/api/orders/302/release') { calls.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) }); if (refused) { refused = false; return { __status: 409, body: { error: 'Stock changed; review allocation' } }; } return { ok: true }; }
        if (!refused && url === '/api/release-slips/orders/302/context') return { ...CTX, units: [], lines: [{ item_id: 7, name: 'Measured goods', quantity: 5, released_qty: 0, serialized: 0 }], availability: [{ item_id: 7, free_to_allocate: 1.25 }] };
        return base(url,init);
      });
      win.location.hash = '#/so?id=302&step=scan'; (await relElement(win,'[data-bulk="7"]')).click();
      (await relElement(win,'#rel-review-current')).click(); (await relElement(win,'#rel-go')).click();
      const input = await relElement(win,'[data-qty="7"]'); expect(input.value).toBe('1.25'); win.document.querySelector('[data-bulk="7"]').click(); await relElement(win,'#rel-review-current');
      expect(calls).toHaveLength(2); expect(calls[0].key).not.toBe(calls[1].key); expect(calls[1].body.bulk[0].quantity).toBe(1.25);
    });
    it('retains an expired uncertain allocation for reconciliation without reposting', async () => {
      const calls: any[] = []; const win = await bootAs(REL,fake(calls));
      await win.mProductionDrafts.save({ key: win.mProductionDrafts.key('release:302:action'), rows: [], operation: { kind: 'release-action', action: 'allocate', orderId: 302, number: 'SO-00302', location: 'FG-A03', label: 'Original allocation', path: '/orders/302/release', payload: { bulk: [{ item_id: 7, quantity: 2.5 }] }, key: 'original-expired-key', created: Date.now()-8*86400000, state: 'unknown' } });
      win.location.hash = '#/so?id=302&step=recovery'; (await relElement(win,'#rel-retry')).click(); await wait(80);
      expect(calls).toEqual([]); expect(win.document.getElementById('m-view').textContent).toContain('Supervisor reconciliation required'); expect(win.document.getElementById('rel-review-current')).toBeNull();
      expect((await win.mProductionDrafts.loadAction('release:302')).operation.key).toBe('original-expired-key');
    });

    it('splits the queue into Ready and Blocked by authorization state', async () => {
      const win = await bootAs(REL, fake([]));
      win.location.hash = '#/so';
      await wait();
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('78:16');
      expect(win.document.documentElement.getAttribute('data-role-accent')).toBe('rel');
      expect(view.textContent).toContain('SO-00302');
      expect(view.textContent).not.toContain('SO-00308');
      (view.querySelector('[data-tab="blocked"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('Authorization revoked');
    });

    it('never shows the token, and continues only after the presented token verifies', async () => {
      const win = await bootAs(REL, fake([]));
      const doc = win.document;
      win.location.hash = '#/so?id=302';
      await wait();
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('78:68');
      expect(view.textContent).toContain('Jordan D. · ID reference ••4821');
      expect(view.textContent).toContain('PICKUP-••••');
      win.location.hash = '#/so?id=302&step=handoff';
      await wait();
      (doc.getElementById('rel-go') as HTMLButtonElement).click();
      await wait();
      expect(view.getAttribute('data-figma-node')).toBe('78:240'); // blocked until verified
      (view.querySelector('[data-token]') as HTMLInputElement).value = 'pickup-7f3q';
      (view.querySelector('[data-verify]') as HTMLButtonElement).click();
      await wait();
      expect(view.textContent).toContain('PICKUP-7F3Q · Valid');
      (doc.getElementById('rel-go') as HTMLButtonElement).click();
      await wait();
      expect(view.getAttribute('data-figma-node')).toBe('78:281');
    });

    it('needs every required package item before handoff', async () => {
      const win = await bootAs(REL, fake([]));
      const doc = win.document;
      win.location.hash = '#/so?id=302&step=package';
      await wait();
      const go = doc.getElementById('rel-go') as HTMLButtonElement;
      expect(go.disabled).toBe(true);
      (doc.querySelector('[data-p="0"]') as HTMLButtonElement).click();
      expect((doc.getElementById('rel-go') as HTMLButtonElement).disabled).toBe(false);
    });

    it('blocks a serial allocated to another order with no request sent', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(REL, fake(posts));
      win.location.hash = '#/so?id=302&step=unit&code=K4-99';
      await wait(80);
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('78:365');
      expect(view.textContent).toContain('Serial is not allocated');
      expect(view.textContent).toContain('Allocated to SO-00310, not this order.');
      expect(posts).toEqual([]);
    });

    it('records warehouse-out online only, with the token, package and an idempotency key', async () => {
      const posts: { url: string; body: any; key?: string }[] = [];
      const win = await bootAs(REL, fake(posts));
      const doc = win.document;
      win.location.hash = '#/so?id=302&step=handoff';
      await wait();
      (doc.querySelector('[data-token]') as HTMLInputElement).value = 'PICKUP-7F3Q';
      (doc.querySelector('[data-verify]') as HTMLButtonElement).click();
      await wait();
      win.location.hash = '#/so?id=302&step=package';
      await wait();
      (doc.querySelector('[data-p="0"]') as HTMLButtonElement).click();
      // Proof: a photo is required before review / confirm.
      win.mPhoto.pickFile = () => Promise.resolve(new win.Blob(['x'], { type: 'image/jpeg' }));
      win.mPhoto.attachBlob = () => Promise.resolve({ id: 1 });
      win.location.hash = '#/so?id=302&step=proof';
      await wait();
      (doc.querySelector('[data-cap]') as HTMLButtonElement).click();
      await wait();
      win.location.hash = '#/so?id=302&step=confirm';
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('78:401');
      const ok = doc.getElementById('rel-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      Object.defineProperty(win.navigator, 'onLine', { value: false, configurable: true });
      (doc.getElementById('rel-post') as HTMLButtonElement).click();
      await wait();
      expect(posts).toEqual([]);
      Object.defineProperty(win.navigator, 'onLine', { value: true, configurable: true });
      (doc.getElementById('rel-post') as HTMLButtonElement).click();
      await wait(80);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe('/api/orders/302/release-slip');
      expect(posts[0]!.key).toMatch(/^rel-/);
      expect(posts[0]!.body).toMatchObject({ collected_by: 'Jordan D.', authorization_token: 'PICKUP-7F3Q', handoff_area: 'Release Bay 1',
        package: [{ item_id: 7, label: 'Charger and cable', ok: true }], evidence_ids: [1] }); // photos uploaded first, on the order
    });

    it('asks a supervisor to release without the token, with a reason', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(REL, fake(posts));
      const doc = win.document;
      win.location.hash = '#/so?id=302&step=handoff';
      await wait();
      (doc.querySelector('[data-notoken]') as HTMLButtonElement).click();
      await wait();
      const view = doc.getElementById('m-view');
      expect(view.textContent).toContain('Release without token');
      expect(doc.getElementById('rel-approve')).toBeNull(); // not a supervisor
      (doc.getElementById('rel-ask') as HTMLButtonElement).click();
      expect(posts).toEqual([]); // a reason is required
      (view.querySelector('[data-reason]') as HTMLTextAreaElement).value = 'Recipient lost the token message';
      (doc.getElementById('rel-ask') as HTMLButtonElement).click();
      await wait();
      expect(posts[0]).toMatchObject({ url: '/api/release-slips/orders/302/override-request', body: { reason: 'Recipient lost the token message' } });
    });

    it('takes an approved supervisor override in place of the token', async () => {
      const win = await bootAs(REL, fake([], { authorization: { ...AUTH, override: { id: 3, status: 'approved', reason: 'Lost it',
        decided_by_name: 'Sam Supervisor', decision_note: 'ID checked in person' } } }));
      const doc = win.document;
      win.location.hash = '#/so?id=302&step=handoff';
      await wait();
      const view = doc.getElementById('m-view');
      expect(view.textContent).toContain('Supervisor override · Sam Supervisor');
      expect(view.querySelector('[data-token]')).toBeNull();
      (doc.getElementById('rel-go') as HTMLButtonElement).click();
      await wait();
      expect(view.getAttribute('data-figma-node')).toBe('78:281');
    });

    it('lets a supervisor approve a requested override on the phone', async () => {
      const posts: { url: string; body: any }[] = [];
      const SUP = { ...REL, id: 42, role: 'warehouse', permissions: [...REL.permissions, 'inventory.adjust'] };
      const win = await bootAs(SUP, fake(posts, { authorization: { ...AUTH, override: { id: 3, status: 'requested', reason: 'Lost it', requested_by_name: 'Ana Dela Cruz' } } }));
      const doc = win.document;
      win.location.hash = '#/so?id=302&step=override';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('Requested by Ana Dela Cruz');
      (doc.querySelector('[data-reason]') as HTMLTextAreaElement).value = 'ID checked in person';
      (doc.getElementById('rel-approve') as HTMLButtonElement).click();
      await wait();
      expect(posts[0]).toMatchObject({ url: '/api/release-slips/orders/302/override', body: { approve: true, reason: 'ID checked in person' } });
    });
  });

  describe('Parts clerk repair-parts requests (Figma 83:*)', () => {
    const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
    const PC = { id: 51, username: 'pc1', full_name: 'Carlo Reyes', role: 'parts_clerk', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.repairs', 'messages.view', 'messages.send'] };
    const REQ = { id: 81, number: 'RPR-00081', unit_id: 9, unit_identifier: 'K4-MTR-260924-0184-01', job_order_id: 184, job_order_number: 'JO-2026-184',
      kind: 'replace', component_item_id: 12, component_name: 'Left signal assembly', quantity: 1, fault: 'production', return_to_damage: 1,
      status: 'requested', requested_by: 21, decided_by: null, decided_at: null, notes: null };
    const SHORT = { ...REQ, id: 87, number: 'RPR-00087', component_name: 'Warranty card pack' };
    const CTX = { request: REQ, unit: { id: 9, identifier: REQ.unit_identifier, status: 'rework', product_name: 'K4' },
      inspection: { id: 418, stage: 1, remarks: 'Intermittent signal failure confirmed by QC', station: 'Wiring', priority: 'Urgent' },
      item: { id: 12, name: 'Left signal assembly', sku: 'SIG-L-60V-K4' }, duplicates: [],
      sources: [{ id: 2, name: 'Parts Warehouse A-12', type: 'warehouse', is_default: 1, available: 6, approved: true },
        { id: 7, name: 'Van 3', type: 'truck', is_default: 0, available: 2, approved: false }],
      revision: null, events: [], shortage: false };
    function fake(posts: { url: string; body: any; key?: string }[]) {
      return (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
        if (init && init.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body || '{}')), key: init.headers && init.headers['Idempotency-Key'] }); return { ...REQ, status: 'accepted' }; }
        if (url === '/api/production/repairs?status=requested') return [REQ, SHORT];
        if (url === '/api/production/repair-history?state=blocked') return { counts: { issued: 0, rejected: 0, blocked: 1 }, rows: [SHORT] };
        if (url === '/api/production/repair-history?state=issued') return { counts: { issued: 0, rejected: 0, blocked: 1 }, rows: [] };
        if (url === '/api/production/repairs/81/context') return CTX;
        return undefined;
      };
    }

    it('shows stock held for other requests as not free', async () => {
      const base = fake([]);
      const win = await bootAs(PC, (url: string, init: any) => url === '/api/production/repairs/81/context'
        ? { ...CTX, quantity: 1, sources: [{ ...CTX.sources[0], available: 6, free: 0 }, CTX.sources[1]], hold: null, shortage: true } : base(url, init));
      win.location.hash = '#/repairs?id=81&step=source';
      await wait();
      expect(win.document.getElementById('m-view').textContent).toContain('Available 6 · 6 held for others · not enough free');
      expect(win.document.querySelector('[data-l="2"]')).toBeNull();
    });

    it('lets the requester approve a revision from the push, and nobody else\'s screen', async () => {
      const posts: { url: string; body: any }[] = [];
      const QCU = { id: 21, username: 'qc1', full_name: 'Quinn QC', role: 'qc_inspector', employee: true, modules: null,
        permissions: ['inventory.view', 'inventory.mobile', 'production.inspect_qc', 'messages.view', 'messages.send'] };
      const base = fake(posts);
      const win = await bootAs(QCU, (url: string, init: any) => url === '/api/production/repairs/81/context'
        ? { ...CTX, revision: { id: 4, status: 'pending', proposed_name: 'Left signal assembly B', proposed_quantity: 1, proposed_by: 51,
          proposed_by_name: 'Carlo Reyes', reason: 'Original SKU unavailable' } } : base(url, init));
      const doc = win.document;
      win.location.hash = '#/repairs?id=81';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('permission'); // the clerk's screens stay closed
      win.location.hash = '#/repairs?id=81&step=decide';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('Proposed: Left signal assembly B · Qty 1');
      (doc.getElementById('rp-yes') as HTMLButtonElement).click();
      await wait();
      expect(posts[0]).toMatchObject({ url: '/api/production/repairs/81/revision/decide', body: { approve: true } });
    });

    it('splits the queue into Pending and Shortage', async () => {
      const win = await bootAs(PC, fake([]));
      win.location.hash = '#/repairs';
      await wait();
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('83:16');
      expect(win.document.documentElement.getAttribute('data-role-accent')).toBe('parts');
      expect(view.textContent).toContain('RPR-00081');
      expect(view.textContent).not.toContain('RPR-00087');
      (view.querySelector('[data-tab="short"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('RPR-00087');
    });

    it('marks a non-approved source as unpickable and blocks a different scanned SKU', async () => {
      const win = await bootAs(PC, fake([]));
      const doc = win.document;
      win.location.hash = '#/repairs?id=81&step=source';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('Not an approved repair-parts source');
      expect(doc.querySelector('[data-l="7"]')).toBeNull();
      expect(doc.getElementById('rp-go')!.textContent).toBe('Use Parts Warehouse A-12');
      win.mScanner = { open: (o: { onResult: (c: string) => void }) => o.onResult('SIG-L-60V-K4B') };
      win.location.hash = '#/repairs?id=81&step=pick';
      await wait();
      (doc.querySelector('.rk-identify') as HTMLButtonElement).click();
      expect(doc.getElementById('m-view').textContent).toContain('Different part');
      expect(doc.getElementById('rp-rev')!.textContent).toBe('Request revision');
    });

    it('issues online only, with the scanned SKU, exact quantity and an idempotency key', async () => {
      const posts: { url: string; body: any; key?: string }[] = [];
      const win = await bootAs(PC, fake(posts));
      const doc = win.document;
      win.mScanner = { open: (o: { onResult: (c: string) => void }) => o.onResult('SIG-L-60V-K4') };
      win.location.hash = '#/repairs?id=81&step=source';
      await wait();
      (doc.getElementById('rp-go') as HTMLButtonElement).click();
      await wait();
      (doc.querySelector('.rk-identify') as HTMLButtonElement).click();
      (doc.getElementById('rp-go') as HTMLButtonElement).click();
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('83:247');
      win.location.hash = '#/repairs?id=81&step=confirm';
      await wait();
      const ok = doc.getElementById('rp-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      Object.defineProperty(win.navigator, 'onLine', { value: false, configurable: true });
      (doc.getElementById('rp-post') as HTMLButtonElement).click();
      await wait();
      expect(posts).toEqual([]);
      Object.defineProperty(win.navigator, 'onLine', { value: true, configurable: true });
      (doc.getElementById('rp-post') as HTMLButtonElement).click();
      await wait(80);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe('/api/production/repairs/81/accept');
      expect(posts[0]!.body).toEqual({ from_location_id: 2, scanned_code: 'SIG-L-60V-K4', picked_quantity: 1 });
      expect(posts[0]!.key).toMatch(/^rpr-/);
    });

    it('shows an issue only the site PC saved as not final, and follows it to confirmed', async () => {
      let issued = false, polls = 0;
      const win = await bootAs(PC, (url: string, init: any) => {
        if (init && init.method === 'POST') { issued = true; return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': '01SITE' }, body: { ...REQ, status: 'accepted' } }; }
        if (url === '/api/production/repairs/81/context') return issued ? { ...CTX, request: { ...REQ, status: 'accepted' } } : CTX;
        if (url === '/api/sync/command/01SITE') { polls++; return { state: 'local' }; }
        return undefined;
      });
      const doc = win.document;
      win.mScanner = { open: (o: { onResult: (c: string) => void }) => o.onResult('SIG-L-60V-K4') };
      win.location.hash = '#/repairs?id=81&step=source';
      await wait();
      (doc.getElementById('rp-go') as HTMLButtonElement).click();
      await wait();
      (doc.querySelector('.rk-identify') as HTMLButtonElement).click();
      (doc.getElementById('rp-go') as HTMLButtonElement).click();
      await wait();
      win.location.hash = '#/repairs?id=81&step=confirm';
      await wait();
      const ok = doc.getElementById('rp-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      (doc.getElementById('rp-post') as HTMLButtonElement).click();
      await wait(120);
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('83:332');
      expect(view.textContent).toContain('Repair part issued — on the site PC');
      expect(view.textContent).toContain('Saved on the site PC — not final yet');
      expect(polls).toBeGreaterThan(0);
    });

    it('needs the review tick and a reason to reject', async () => {
      const posts: { url: string; body: any }[] = [];
      const win = await bootAs(PC, fake(posts));
      const doc = win.document;
      win.location.hash = '#/repairs?id=81&step=reject';
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('83:375');
      expect((doc.getElementById('rp-post') as HTMLButtonElement).disabled).toBe(true);
      const ok = doc.getElementById('rp-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      (doc.querySelector('[data-det]') as HTMLTextAreaElement).value = 'Covered by RPR-00080';
      (doc.getElementById('rp-post') as HTMLButtonElement).click();
      await wait(80);
      expect(posts[0]).toMatchObject({ url: '/api/production/repairs/81/reject', body: { warehouse_remarks: 'Duplicate / invalid request — Covered by RPR-00080' } });
    });
  });

  describe('RTS clerk ready-to-sell intake (Figma 74:*)', () => {
    const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
    const RTS = { id: 31, username: 'rts1', full_name: 'Carlo Reyes', role: 'receiving_clerk', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.receive', 'messages.view', 'messages.send'] };
    const U = { id: 601, identifier: 'K4-01', updated_at: '2026-10-02 01:00:00', job_order_id: 184, job_order_number: 'JO-2026-184',
      product_name: 'K4 Electric Bike', product_item_id: 7, sku: 'EB-K4-60V-RED', priority: 0, output_location_id: 2,
      output_location_name: 'FG-A03', order_number: null, batch_identifier: null,
      final_pass: { created_at: '2026-10-02 00:42:00', inspector_name: 'Mara Cruz', stage: 2 }, hold: null as unknown };
    const HELD = { ...U, id: 602, identifier: 'K4-02', hold: { id: 9, description: 'Color differs', created_at: '2026-10-02 00:50:00' } };
    const LOCS = [{ id: 2, name: 'FG-A03', type: 'warehouse', is_default: 1 }, { id: 3, name: 'Truck 1', type: 'truck', is_default: 0 }];
    function fake(posts: { url: string; body: any; key: string | undefined }[], over: Record<string, unknown> = {}) {
      return (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
        if (init && init.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body || '{}')), key: init.headers && init.headers['Idempotency-Key'] });
          if (url in over) return over[url];
          if (url === '/api/rts/check') return { blockers: [], location_error: null };
          return { id: 1, number: 'PI-00042' };
        }
        if (url === '/api/rts/queue') return { units: [U, HELD], batches: [], recorded: [] };
        if (url === '/api/locations') return LOCS;
        return undefined;
      };
    }

    async function element(win: any, selector: string) {
      for (let n = 0; n < 100; n++) { const el = win.document.querySelector(selector); if (el) return el; await wait(20); }
      throw new Error('Missing RTS element ' + selector + ': ' + win.document.getElementById('m-view').textContent);
    }
    async function confirmStock(win: any) {
      const tick = await element(win, '#rts-ok'); tick.checked = true; tick.dispatchEvent(new win.Event('change'));
      win.document.getElementById('rts-post').click();
    }
    it.each(['unit', 'batch'])('recovers a committed %s receipt after restart with its exact key and payload', async (kind) => {
      const factory = new IDBFactory(), applied = new Map(), calls: any[] = []; let lose = true;
      const batch = { ...U, id: 81, number: 'LOT-81', remaining_qty: 10 };
      const respond = (url: string, init: any) => {
        if (url === '/api/locations') return LOCS;
        if (url === '/api/rts/queue') return { units: kind === 'unit' && !applied.size ? [U] : [], batches: kind === 'batch' ? [{ ...batch, remaining_qty: 10 - applied.size * 2 }] : [], recorded: [] };
        if (url === '/api/job-orders/184/products-in' && init.method === 'POST') {
          const key = init.headers['Idempotency-Key']; calls.push({ key, payload: init.body });
          if (!applied.has(key)) applied.set(key, { id: 42, number: 'PI-00042' });
          if (lose) { lose = false; return undefined; } return applied.get(key);
        } return undefined;
      };
      let win = await bootAs({ ...RTS, permissions: ['mobile.access', 'production.receive'] }, respond, factory);
      win.location.hash = kind === 'batch' ? '#/receiving?batch=81' : '#/receiving?unit=601&step=confirm';
      await element(win, '#rts-post');
      if (kind === 'batch') { win.document.querySelector('.rk-stepper input').value = '2'; win.document.querySelector('[data-note]').value = 'Original physical count'; }
      await confirmStock(win); await element(win, '#rts-retry'); expect(win.document.querySelector('[data-loc]')).toBeNull(); win.close();
      win = await bootAs(RTS, respond, factory); win.location.hash = '#/receiving';
      (await element(win, '[data-recovery] [data-id]')).click(); (await element(win, '#rts-retry')).click(); await element(win, '#rts-next');
      expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(applied.size).toBe(1);
      if (kind === 'batch') expect(JSON.parse(calls[0].payload)).toEqual({ location_id: 2, batch_id: 81, quantity: 2, notes: 'Original physical count' });
      expect(win.document.getElementById('m-view').textContent).toContain('PI-00042');
    });
    it('retains a partial group and retries only its unresolved job order after restart', async () => {
      const factory = new IDBFactory(), applied = new Map(), calls: any[] = []; let lose = true;
      const other = { ...U, id: 603, identifier: 'K4-03', job_order_id: 185, job_order_number: 'JO-2026-185' };
      const respond = (url: string, init: any) => {
        if (url === '/api/locations') return LOCS;
        if (url === '/api/rts/queue') return { units: [U,other].filter(u => ![...applied.values()].some(a => a.unit === u.id)), batches: [], recorded: [] };
        if (url.endsWith('/products-in') && init.method === 'POST') {
          const key = init.headers['Idempotency-Key']; calls.push({ url, key, body: init.body });
          if (!applied.has(key)) applied.set(key, { id: applied.size + 1, number: 'PI-' + (applied.size + 1), unit: JSON.parse(init.body).unit_ids[0] });
          if (url.includes('/185/') && lose) { lose = false; return undefined; } return applied.get(key);
        } return undefined;
      };
      let win = await bootAs(RTS, respond, factory); win.location.hash = '#/receiving?unit=601&step=group';
      (await element(win, '[data-add="603"]')).click(); win.location.hash = '#/receiving?unit=601&step=confirm';
      await confirmStock(win); await element(win, '#rts-retry');
      expect(win.document.getElementById('m-view').textContent).toContain('1 of 2 confirmed'); win.close();
      win = await bootAs(RTS, respond, factory); win.location.hash = '#/receiving'; (await element(win, '[data-recovery] [data-id]')).click();
      (await element(win, '#rts-retry')).click(); await element(win, '#rts-next');
      expect(calls.map(c => c.url)).toEqual(['/api/job-orders/184/products-in','/api/job-orders/185/products-in','/api/job-orders/185/products-in']);
      expect(calls[1]).toEqual(calls[2]); expect(applied.size).toBe(2); expect(win.document.getElementById('m-view').textContent).toContain('2 of 2 confirmed');
    });
    it('keeps a site-PC receipt pending across restart until its original command confirms', async () => {
      const factory = new IDBFactory(); let state = 'pending', count = 0;
      const respond = (url: string, init: any) => {
        if (url === '/api/locations') return LOCS;
        if (url === '/api/rts/queue') return { units: count ? [] : [U], batches: [], recorded: [] };
        if (url === '/api/sync/command/rts-local') return { state };
        if (url.endsWith('/products-in') && init.method === 'POST') { count++; return { __headers: { 'X-Sync-State': 'local', 'X-Sync-Command': 'rts-local' }, body: { id: 42, number: 'PI-PC' } }; }
        return undefined;
      };
      let win = await bootAs(RTS, respond, factory); win.location.hash = '#/receiving?unit=601&step=confirm'; await confirmStock(win); await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending'); expect(win.document.getElementById('rts-next')).toBeNull(); expect(win.document.getElementById('rts-retry')).toBeNull(); win.close();
      win = await bootAs(RTS, respond, factory); win.location.hash = '#/receiving?unit=601&step=confirm'; await wait(100);
      expect(win.document.getElementById('m-view').textContent).toContain('confirmation pending'); expect(count).toBe(1);
      state = 'confirmed'; win.MApp.render(); await element(win, '#rts-next'); expect(count).toBe(1);
    });
    it('requires review after refusal and uses a fresh key for a corrected location', async () => {
      const calls: any[] = []; let refused = true;
      const base = fake([]);
      const win = await bootAs(RTS, (url: string, init: any) => {
        if (url === '/api/locations') return [...LOCS, { id: 4, name: 'FG-B01', type: 'warehouse' }];
        if (url.endsWith('/products-in') && init.method === 'POST') { calls.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); if (refused) { refused = false; return { __status: 400, body: { error: 'FG-A03 is full', location_error: true } }; } return { id: 42, number: 'PI-00042' }; }
        return base(url,init);
      });
      win.location.hash = '#/receiving?unit=601&step=confirm'; await confirmStock(win);
      (await element(win, '#rts-correct')).click(); await element(win, '#rts-go');
      win.location.hash = '#/receiving?unit=601&step=location'; (await element(win, '[data-l="4"]')).click(); win.document.getElementById('rts-use').click(); await element(win, '#rts-go');
      win.location.hash = '#/receiving?unit=601&step=confirm'; await confirmStock(win); await element(win, '#rts-next');
      expect(calls).toHaveLength(2); expect(calls[0].key).not.toBe(calls[1].key); expect(calls[1].body.location_id).toBe(4);
    });
    it('blocks blank, fractional, negative and excessive batch quantities instead of truncating them', async () => {
      const posts: any[] = [], base = fake(posts);
      const win = await bootAs(RTS, (url: string, init: any) => url === '/api/rts/queue' ? { units: [], batches: [{ ...U, id: 81, number: 'LOT-81', remaining_qty: 5 }], recorded: [] } : base(url,init));
      win.location.hash = '#/receiving?batch=81'; await element(win, '#rts-post');
      const tick = win.document.getElementById('rts-ok'); tick.checked = true; tick.dispatchEvent(new win.Event('change'));
      for (const value of ['', '1.5', '-1', '6']) { win.document.querySelector('.rk-stepper input').value = value; win.document.getElementById('rts-post').click(); await wait(20); }
      expect(posts).toEqual([]); expect(win.document.querySelector('.rk-stepper input')).toBeTruthy();
    });
    it('shows retained receipts while a live queue request is stuck, then shows an unknown count on timeout', async () => {
      const win = await bootAs(RTS, fake([]));
      await win.mRtsRecovery.begin('rts-unit:601', [{ jobId: 184, path: '/job-orders/184/products-in', payload: { location_id: 2, unit_ids: [601] }, labels: ['K4-01'] }], 'FG-A03');
      const fetch = win.fetch, timeout = win.setTimeout.bind(win); let finish: any;
      win.fetch = (url: string, init: any) => url === '/api/rts/queue' ? new Promise(r => { finish = r; }) : fetch(url,init);
      win.setTimeout = (fn: any, ms: number, ...args: any[]) => timeout(fn, ms === 20000 ? 30 : ms, ...args);
      win.location.hash = '#/receiving'; await element(win, '[data-recovery] [data-id]'); await wait(80);
      expect(win.document.getElementById('m-view').textContent).toContain('count unknown');
      finish({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ units: [], batches: [], recorded: [] }) }); await wait(40);
      expect(win.document.getElementById('m-view').textContent).toContain('count unknown'); expect(win.document.getElementById('m-view').textContent).not.toContain('Nothing waiting for stock entry');
    });

    it('shows each location\'s room and won\'t let a full one be picked', async () => {
      const base = fake([]);
      const win = await bootAs(RTS, (url: string, init: any) => url === '/api/locations'
        ? [...LOCS, { id: 4, name: 'FG-B01', type: 'warehouse', is_default: 0, capacity: 10, total_units: 10 },
          { id: 5, name: 'FG-C02', type: 'warehouse', is_default: 0, capacity: 10, total_units: 4 }] : base(url, init));
      win.location.hash = '#/receiving?unit=601&step=location';
      await wait(80);
      const view = win.document.getElementById('m-view');
      expect(view.textContent).toContain('FG-B01Warehouse · full (room for 0)');
      expect(view.textContent).toContain('FG-C02Warehouse · room for 6');
      expect(view.querySelector('[data-l="4"]')).toBeNull();
      expect(view.querySelector('[data-l="5"]')).not.toBeNull();
    });

    it('lists ready units and keeps a mismatch-held unit under Issues', async () => {
      const win = await bootAs(RTS, fake([]));
      win.location.hash = '#/receiving';
      await wait();
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('74:16');
      expect(view.textContent).toContain('1 unit');
      expect(view.textContent).toContain('K4-01');
      expect(view.textContent).not.toContain('K4-02');
      (view.querySelector('[data-tab="issues"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('K4-02');
      win.location.hash = '#/receiving?unit=602&step=confirm'; // a held unit can't reach posting
      await wait();
      expect(view.getAttribute('data-figma-node')).toBe('74:104');
      expect(view.textContent).toContain('Mismatch reported');
      expect(win.document.getElementById('rts-post')).toBeNull();
    });

    it('checks, needs the physical-verification tick, and posts once with an idempotency key', async () => {
      const posts: { url: string; body: any; key: string | undefined }[] = [];
      const win = await bootAs(RTS, fake(posts));
      const doc = win.document;
      win.location.hash = '#/receiving?unit=601&step=stock';
      await wait();
      expect(doc.getElementById('m-view').textContent).toContain('FG-A03');
      (doc.getElementById('rts-go') as HTMLButtonElement).click();
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('74:186');
      (doc.getElementById('rts-one') as HTMLButtonElement).click();
      await wait();
      (doc.getElementById('rts-check') as HTMLButtonElement).click();
      await wait();
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('74:316');
      const post = doc.getElementById('rts-post') as HTMLButtonElement;
      expect(post.disabled).toBe(true);
      const ok = doc.getElementById('rts-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      post.click();
      await wait(80);
      const stock = posts.filter((p) => p.url.endsWith('/products-in'));
      expect(stock).toHaveLength(1);
      expect(stock[0]!.url).toBe('/api/job-orders/184/products-in');
      expect(stock[0]!.body).toEqual({ location_id: 2, unit_ids: [601] });
      expect(stock[0]!.key).toMatch(/^rts-/);
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('74:356');
      expect(doc.getElementById('m-view').textContent).toContain('PI-00042');
    });

    it('shows the existing stock record when the server refuses a duplicate, and posts nothing offline', async () => {
      const posts: { url: string; body: any; key: string | undefined }[] = [];
      const dup = { __status: 409, body: { error: 'K4-01 is already recorded in finished goods', blockers: [{ unit_id: 601, identifier: 'K4-01', reason: 'recorded',
        message: 'K4-01 is already recorded in finished goods', existing: { unit_id: 601, location_name: 'FG-A03', receipt_number: 'PI-00007', received_by_name: 'Carlo Reyes', received_at: '2026-10-02 00:51:00' } }] } };
      const win = await bootAs(RTS, fake(posts, { '/api/job-orders/184/products-in': dup }));
      const doc = win.document;
      win.location.hash = '#/receiving?unit=601&step=confirm';
      await wait();
      const ok = doc.getElementById('rts-ok') as HTMLInputElement;
      ok.checked = true; ok.dispatchEvent(new win.Event('change'));
      Object.defineProperty(win.navigator, 'onLine', { value: false, configurable: true });
      (doc.getElementById('rts-post') as HTMLButtonElement).click();
      await wait();
      expect(posts).toEqual([]); // offline: nothing sent, nothing queued
      Object.defineProperty(win.navigator, 'onLine', { value: true, configurable: true });
      (doc.getElementById('rts-post') as HTMLButtonElement).click();
      await wait(80);
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('74:280');
      expect(view.textContent).toContain('Duplicate serial blocked');
      expect(view.textContent).toContain('PI-00007 · by Carlo Reyes');
    });
  });

  it('clears the previous screen’s data-* tags when routing (no leaked role titles)', async () => {
    const win = await bootAs({ id: 3, username: 'x', full_name: 'X', role: 'csr', employee: true, modules: null, permissions: ['messages.view'] });
    const view = win.document.getElementById('m-view');
    view.setAttribute('data-role-screen', 'production-manager');
    view.setAttribute('data-role-title', 'Job orders');
    win.MApp.render();
    expect(view.hasAttribute('data-role-screen')).toBe(false);
    expect(view.hasAttribute('data-role-title')).toBe(false);
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
    expect(source).toContain('DRAFT · NOT FINALIZED');
    expect(source).toContain("classList.add('is-draft')");
    expect(source).toContain("API.get('/me/payslips/' + record.id + '/timekeeping')");
    const css = fs.readFileSync(path.join(ROOT, 'public/mobile/mobile-v2.css'), 'utf8');
    expect(css).toContain('.m-payslip-v2.is-draft::after');
    expect(css).toContain('.m-payslip-time-panel.is-draft::after');
  });


  it('maps Profile & Settings to Figma and preserves employee-safe controls', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public/mobile/modules/core/settings.js'), 'utf8');
    expect(source).toContain("view.setAttribute('data-figma-node', nodeId || '46:953')");
    expect(source).toContain("API.get('/me')");
    // Preferred name + contact details are saved to the account (re-authenticated), never by
    // rewriting the legal/account name; the old device-only nickname is only offered once.
    expect(source).toContain("API.get('/me/profile')");
    expect(source).toContain("API.put('/me/profile', body)");
    expect(source).toContain('current_password: pw.value');
    expect(source).not.toContain("localStorage.setItem('vds_profile_nickname'");
    expect(source).toContain("MApp.go('requests', { type: 'information_change' })");
    expect(source).toContain('HR-controlled information');
    expect(source).toContain("MApp.go('payslips')");
    expect(source).toContain("MApp.go('requests')");
    expect(source).toContain("MApp.go('report-problem')");
    expect(source).toContain("API.post('/auth/change-password'");
    // Sign-out goes through MApp.signOut (app.js), which flushes/warns about queued actions,
    // releases push, and clears a borrowed phone's data before POST /auth/logout.
    expect(source).toContain('MApp.signOut()');
    expect(source).toContain("API.get('/auth/sessions')");
    expect(fs.readFileSync(path.join(ROOT, 'public/mobile/app.js'), 'utf8')).toContain("API.post('/auth/logout')");
    expect(source).not.toContain("API.put('/auth/profile'");
  });


  it('marks every special-access pipeline screen with its role context and preserves live transactions', () => {
    const files = {
      warehouse: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/repairs.js'), 'utf8'),
      production: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/job-orders.js'), 'utf8'),
      hub: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/production.js'), 'utf8'),
      quality: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/qc.js'), 'utf8'),
      rts: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/receiving.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/rts-recovery.js'), 'utf8'),
      releasing: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/inventory/so.js'), 'utf8'),
    };
    expect(files.warehouse).toContain("role: 'parts'");
    for (const node of ['83:16', '83:68', '83:109', '83:158', '83:206', '83:247', '83:295', '83:332', '83:375', '83:416', '83:452', '83:488']) {
      expect(files.warehouse).toContain("'" + node + "'");
    }
    for (const call of ["'/production/repairs/' + r.id + '/accept'", "'/production/repairs/' + r.id + '/reject'", "'/production/repairs/' + r.id + '/revision'", "'/production/repairs/' + r.id + '/shortage'"]) {
      expect(files.warehouse).toContain(call);
    }
    expect(files.hub).toContain("data-role-screen', 'production-manager'");
    // Production Lead + Manager: every Figma frame mapped, live endpoints kept.
    for (const node of ['66:14', '66:79', '66:133', '66:185', '66:240', '66:294', '66:356', '66:408', '66:462', '66:515', '66:580', '66:650']) {
      expect(files.production).toContain("'" + node + "'");
    }
    for (const call of ["'/accept'", "'/units'", "'/progress'", "'/close'", "'/events'", "API.post('/production-issues'"]) {
      expect(files.production).toContain(call);
    }
    // QC + QA: one inspection engine, every Figma frame mapped, live endpoints kept.
    for (const node of ['69:16', '69:68', '69:104', '69:145', '69:197', '69:247', '69:286', '69:323', '69:364', '69:397', '69:436', '69:478',
      '72:16', '72:68', '72:104', '72:145', '72:197', '72:246', '72:285', '72:322', '72:363', '72:396', '72:435', '72:477']) {
      expect(files.quality).toContain("'" + node + "'");
    }
    for (const call of ["API.get('/qc/queue?role='", "'/units/inspect'", "mPhoto.attachBlob('qc_unit'", "'/production/units/' + u.id + '/repairs'", "API.get('/qc/checklists')"]) {
      expect(files.quality).toContain(call);
    }
    // RTS clerk: role-kit page (R.page draws the role header), every Figma frame mapped, live
    // posting kept (one idempotent products-in per job order).
    expect(files.rts).toContain("R.page(view, { role: 'rts'");
    for (const node of ['74:16', '74:68', '74:104', '74:145', '74:186', '74:234', '74:280', '74:316', '74:356', '74:399', '74:442', '74:483']) {
      expect(files.rts).toContain("'" + node + "'");
    }
    expect(files.rts).toContain("'/job-orders/' + jo + '/products-in'");
    expect(files.releasing).toContain("role: 'releasing'");
    for (const node of ['78:16', '78:68', '78:109', '78:147', '78:188', '78:240', '78:281', '78:317', '78:365', '78:401', '78:438', '78:481']) {
      expect(files.releasing).toContain("'" + node + "'");
    }
    for (const call of ["'/orders/' + c.order.id + '/release'", "'/orders/' + c.order.id + '/release-slip'", "'/orders/' + c.order.id + '/accept-release'", "'/release-slips/orders/' + c.order.id + '/reports'"]) {
      expect(files.releasing).toContain(call);
    }
  });

});
