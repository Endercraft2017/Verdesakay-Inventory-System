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
      const out = respond ? respond(String(url), init) : undefined;
      if (out === undefined) return Promise.reject(new Error('no network in test'));
      // { __status, body } fakes an HTTP error response; anything else is a 200 JSON body.
      const status = out && typeof out === 'object' && '__status' in (out as object) ? (out as { __status: number }).__status : 200;
      const body = status === 200 ? out : (out as { body: unknown }).body;
      return Promise.resolve({
        ok: status < 400, status,
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
    // Production Lead + Manager: every Figma frame mapped, live endpoints kept.
    for (const node of ['66:14', '66:79', '66:133', '66:185', '66:240', '66:294', '66:356', '66:408', '66:462', '66:515', '66:580', '66:650']) {
      expect(files.production).toContain("'" + node + "'");
    }
    for (const call of ["'/accept'", "'/units'", "'/progress'", "'/close'", "'/events'", "API.post('/production-issues'"]) {
      expect(files.production).toContain(call);
    }
    expect(files.quality).toContain("data-role-screen', qualityRole");
    expect(files.quality).toContain("qualityRole === 'qa'");
    expect(files.quality).toContain("API.get('/qc/checklists");
    expect(files.rts).toContain("data-role-screen', 'rts'");
    expect(files.rts).toContain("'/job-orders/' + id + '/products-in'");
    expect(files.releasing).toContain("data-role-screen', 'releasing'");
    expect(files.releasing).toContain("'/orders/' + order.id + '/release'");
  });

});
