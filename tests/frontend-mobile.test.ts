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
  'batch', 'job-orders', 'kit-release', 'qc', 'repairs', 'record', 'receiving', 'so', 'report-problem', 'anonymous-report', 'settings', 'queue', 'clock',
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
  async function bootAs(me: Record<string, unknown>, respond?: (url: string, init: any) => unknown) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
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
      permissions: ['inventory.view', 'inventory.adjust', 'inventory.mobile', 'messages.view', 'messages.send'] };
    const JO = { id: 184, number: 'JO-2026-184', product_name: 'K4 Electric Bike', qty_ordered: 12, status: 'draft',
      approved_at: '2026-09-28 08:00:00', warehouse_accepted_at: null, prepared_at: null, team_name: 'Line 2',
      source_location_name: 'Main Parts', due_date: null };
    const LINES = [{ component_item_id: 1, component_name: 'Controller 60 V', need: 12, have: 30, short: 0, picked: 0 }];

    it('queues approved kits as Ready or Blocked from availability', async () => {
      const win = await bootAs(WH, (url: string) => {
        if (url === '/api/job-orders?stage=awaiting_release') return [JO, { ...JO, id: 179, number: 'JO-2026-179', product_name: 'Z10 Electric Bike' }];
        if (url === '/api/job-orders?status=released') return [];
        if (url === '/api/job-orders/184/availability') return { lines: LINES, shortfalls: [] };
        if (url === '/api/job-orders/179/availability') return { lines: [], shortfalls: [{ component_name: 'Bolt M8', need: 40, have: 25, short: 15 }] };
        return undefined;
      });
      win.location.hash = '#/kit-release';
      await new Promise((r) => setTimeout(r, 40));
      const view = win.document.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('62:14');
      expect(view.textContent).toContain('1 kit ready');
      expect(view.textContent).toContain('1 blocked by shortage');
      expect(view.textContent).toContain('JO-2026-184');
      expect(view.textContent).not.toContain('JO-2026-179'); // on the Blocked tab, not Ready
      (view.querySelector('[data-tab="blocked"]') as HTMLButtonElement).click();
      expect(view.textContent).toContain('JO-2026-179');
      expect(view.textContent).toContain('1 part short');
    });

    it('needs the kit acknowledgement, then accepts → picks → releases in order', async () => {
      const posts: string[] = [];
      let released = false;
      const RELEASED = { ...JO, status: 'released', released_at: '2026-09-28 01:42:00', released_by_name: 'Ana Alvarez', parts_slip_number: 'PRS-00007' };
      const win = await bootAs(WH, (url: string, init: { method?: string }) => {
        if (init && init.method === 'POST') {
          posts.push(url);
          if (url.endsWith('/release')) { released = true; return { ok: true, job_order: RELEASED, slip: { id: 1, number: 'PRS-00007' } }; }
          return { ok: true };
        }
        if (url === '/api/job-orders/184') return released ? RELEASED : JO;
        if (url === '/api/job-orders/184/availability') return { lines: LINES, shortfalls: [], source_location_name: 'Main Parts' };
        return undefined;
      });
      win.location.hash = '#/kit-release?id=184';
      await new Promise((r) => setTimeout(r, 40));
      const doc = win.document;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('62:79');
      (doc.getElementById('kr-go') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 40)); // each step is its own URL (?step=confirm) and reloads the job order
      const confirm = doc.getElementById('kr-confirm') as HTMLButtonElement;
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('62:150');
      expect(confirm.disabled).toBe(true);
      const ack = doc.getElementById('kr-ack') as HTMLInputElement;
      ack.checked = true;
      ack.dispatchEvent(new win.Event('change'));
      expect(confirm.disabled).toBe(false);
      confirm.click();
      await new Promise((r) => setTimeout(r, 250)); // POSTs → new step URL → reload
      expect(posts).toEqual(['/api/job-orders/warehouse-accept', '/api/job-orders/prepare', '/api/job-orders/184/release']);
      expect(doc.getElementById('m-view').getAttribute('data-figma-node')).toBe('62:317');
      expect(doc.getElementById('m-view').textContent).toContain('PRS-00007');
    });

    it('lands on Release blocked when the server finds a shortfall, and never calls release', async () => {
      const posts: string[] = [];
      const win = await bootAs(WH, (url: string, init: { method?: string }) => {
        if (init && init.method === 'POST') {
          posts.push(url);
          if (url.endsWith('/prepare')) return { __status: 400, body: { error: 'Not enough stock to pick', shortfalls: [{ component_name: 'Bolt M8', picking: 40, available: 25 }] } };
          return { ok: true };
        }
        if (url === '/api/job-orders/184') return { ...JO, warehouse_accepted_at: '2026-09-28 08:10:00' };
        if (url === '/api/job-orders/184/availability') return { lines: LINES, shortfalls: [] };
        return undefined;
      });
      win.location.hash = '#/kit-release?id=184';
      await new Promise((r) => setTimeout(r, 40));
      const doc = win.document;
      (doc.getElementById('kr-go') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 40));
      const ack = doc.getElementById('kr-ack') as HTMLInputElement;
      ack.checked = true; ack.dispatchEvent(new win.Event('change'));
      (doc.getElementById('kr-confirm') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 250)); // POSTs → new step URL → reload
      expect(posts).toEqual(['/api/job-orders/prepare']); // already accepted; no release attempted
      const view = doc.getElementById('m-view');
      expect(view.getAttribute('data-figma-node')).toBe('62:205');
      expect(view.textContent).toContain('Need 40 · Have 25');
      expect(view.textContent).toContain('No stock was deducted.');
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
      expect(view.textContent).toContain('Recorded 1 of 2');
      expect(view.textContent).toContain('K4-01');
      (doc.getElementById('jo-retry') as HTMLButtonElement).click();
      await wait(120);
      expect(uploads).toEqual(['K4-01', 'K4-02']); // unit 1 not sent twice
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
      rts: fs.readFileSync(path.join(ROOT, 'public/mobile/modules/manufacturing/receiving.js'), 'utf8'),
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
