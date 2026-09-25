/** Office location lock for phone time-in (src/modules/hr/clock-geofence.ts): the per-company
 *  site list + radius, the per-employee "can time in outside the office" exemption, and the
 *  location stored on each phone punch. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// Dynamic imports after setupApp() — see the note at the top of tests/clock.test.ts.
let queryOne: typeof import('../src/shared/db').queryOne;
let setSetting: typeof import('../src/shared/db').setSetting;
let currentKioskCode: typeof import('../src/modules/hr/clock').currentKioskCode;
let geofence: typeof import('../src/modules/hr/clock-geofence');

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const code = () => currentKioskCode().code;

const OFFICE = { name: 'Main office', lat: 14.5995, lng: 120.9842, radius_m: 150 };
const NEAR = { lat: 14.6, lng: 120.9842, accuracy_m: 20 };        // ~55 m north
const FAR = { lat: 14.65, lng: 120.9842, accuracy_m: 20 };        // ~5.6 km north

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne, setSetting } = await import('../src/shared/db'));
  ({ currentKioskCode } = await import('../src/modules/hr/clock'));
  geofence = await import('../src/modules/hr/clock-geofence');
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));
beforeEach(() => { setSetting('clock_geofence', { enabled: true, sites: [OFFICE], max_accuracy_m: 100 }); });

async function linkedEmployee(overrides: Record<string, unknown> = {}) {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const employee_no = 'G' + Math.floor(Math.random() * 1e6);
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no, name: acc.username.toUpperCase(), user_id: acc.id, daily_rate: 500, rate_type: 'daily', status: 'regular', ...overrides,
  });
  if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
  return { h: { Authorization: `Bearer ${acc.token}` }, employeeId: emp.body.id as number, employee_no };
}

const punchRow = (id: number) => queryOne<{
  source: string; lat: number | null; lng: number | null; accuracy_m: number | null; distance_m: number | null; geo_site: string | null;
}>('SELECT source, lat, lng, accuracy_m, distance_m, geo_site FROM time_punches WHERE id = ?', id)!;

describe('distance', () => {
  it('haversine: one degree of latitude is ~111 km', () => {
    expect(geofence.distanceM(14, 121, 15, 121)).toBeGreaterThan(110_000);
    expect(geofence.distanceM(14, 121, 15, 121)).toBeLessThan(112_000);
    expect(Math.round(geofence.distanceM(OFFICE.lat, OFFICE.lng, NEAR.lat, NEAR.lng))).toBeLessThan(60);
  });
});

describe('lock off (the default) — phones punch as before', () => {
  it('a QR punch needs no location; a sent location is still stored', async () => {
    setSetting('clock_geofence', { enabled: false, sites: [OFFICE], max_accuracy_m: 100 });
    const a = await linkedEmployee();
    const r = await ctx.api.post('/api/hr/clock/punch').set(a.h).send({ code: code() });
    expect(r.status).toBe(200);
    expect(punchRow(r.body.id).lat).toBeNull();

    const b = await linkedEmployee();
    const r2 = await ctx.api.post('/api/hr/clock/punch').set(b.h).send({ code: code(), location: FAR });
    expect(r2.status).toBe(200);
    expect(punchRow(r2.body.id)).toMatchObject({ source: 'phone', geo_site: null });
    expect(punchRow(r2.body.id).distance_m).toBeGreaterThan(5000);
  });
});

describe('lock on', () => {
  it('refuses a QR punch with no location, from far away, or with an imprecise fix', async () => {
    const e = await linkedEmployee();
    const none = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ code: code() });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/Turn on location/);

    const far = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ code: code(), location: FAR });
    expect(far.status).toBe(403);
    expect(far.body.error).toMatch(/5\.\d km from Main office/);

    const fuzzy = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ code: code(), location: { ...NEAR, accuracy_m: 400 } });
    expect(fuzzy.status).toBe(400);
    expect(fuzzy.body.error).toMatch(/too imprecise/);
    expect(queryOne('SELECT id FROM time_punches WHERE employee_id = ?', e.employeeId)).toBeUndefined();
  });

  it('accepts a QR punch on-site and records where it came from', async () => {
    const e = await linkedEmployee();
    const r = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ code: code(), location: NEAR });
    expect(r.status).toBe(200);
    const row = punchRow(r.body.id);
    expect(row).toMatchObject({ source: 'phone', geo_site: 'Main office', lat: NEAR.lat, accuracy_m: 20 });
    expect(row.distance_m).toBeLessThan(60);
  });

  it('a non-exempt employee cannot skip the QR, even on-site', async () => {
    const e = await linkedEmployee();
    const r = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ location: NEAR });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Scan the code/);
  });

  it('kiosk punches at the office PC are not affected', async () => {
    const e = await linkedEmployee();
    const r = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: code(), employee_no: e.employee_no });
    expect(r.status).toBe(200);
  });

  it('my-status tells the phone to send its location', async () => {
    const e = await linkedEmployee();
    const s = await ctx.api.get('/api/hr/clock/my-status').set(e.h);
    expect(s.body).toMatchObject({ location_required: true, can_clock_anywhere: false });
  });
});

describe('"can time in outside the office" exemption', () => {
  it('punches from anywhere without the QR, as a remote punch with its location saved', async () => {
    const e = await linkedEmployee({ clock_anywhere: true });
    const s = await ctx.api.get('/api/hr/clock/my-status').set(e.h);
    expect(s.body).toMatchObject({ location_required: false, can_clock_anywhere: true });

    const r = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ location: FAR });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('remote');
    expect(punchRow(r.body.id)).toMatchObject({ source: 'remote', lat: FAR.lat, geo_site: null });
  });

  it('still needs a location for a no-QR punch (its only evidence)', async () => {
    const e = await linkedEmployee({ clock_anywhere: true });
    const r = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Turn on location/);
  });

  it('may still use the QR, from anywhere, without sending a location', async () => {
    const e = await linkedEmployee({ clock_anywhere: true });
    const r = await ctx.api.post('/api/hr/clock/punch').set(e.h).send({ code: code() });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('phone');
  });

  it('round-trips on the employee record; an update that omits it keeps it', async () => {
    const e = await linkedEmployee({ clock_anywhere: true });
    const flag = () => queryOne<{ clock_anywhere: number }>('SELECT clock_anywhere FROM employees WHERE id = ?', e.employeeId)!.clock_anywhere;
    expect(flag()).toBe(1);
    const base = { employee_no: e.employee_no, name: 'Renamed', daily_rate: 500, rate_type: 'daily', status: 'regular' };
    expect((await ctx.api.put(`/api/hr/employees/${e.employeeId}`).set(A()).send(base)).status).toBe(200);
    expect(flag()).toBe(1);
    expect((await ctx.api.put(`/api/hr/employees/${e.employeeId}`).set(A()).send({ ...base, clock_anywhere: false })).status).toBe(200);
    expect(flag()).toBe(0);
  });
});

describe('Punch Log', () => {
  it('lists punches in a date range with where each phone punch came from, filterable by source', async () => {
    const onsite = await linkedEmployee();
    const field = await linkedEmployee({ clock_anywhere: true });
    const a = await ctx.api.post('/api/hr/clock/punch').set(onsite.h).send({ code: code(), location: NEAR });
    const b = await ctx.api.post('/api/hr/clock/punch').set(field.h).send({ location: FAR });
    const day = a.body.work_date;

    const all = await ctx.api.get(`/api/hr/clock/punches?from=${day}&to=${day}`).set(A());
    expect(all.status).toBe(200);
    const rowA = all.body.find((r: { id: number }) => r.id === a.body.id);
    expect(rowA).toMatchObject({ source: 'phone', geo_site: 'Main office' });
    expect(all.body.find((r: { id: number }) => r.id === b.body.id)).toMatchObject({ source: 'remote', lat: FAR.lat, geo_site: null });

    const remote = await ctx.api.get(`/api/hr/clock/punches?from=${day}&to=${day}&source=remote`).set(A());
    expect(remote.body.every((r: { source: string }) => r.source === 'remote')).toBe(true);
    expect(remote.body.some((r: { id: number }) => r.id === b.body.id)).toBe(true);
  });

  it('rejects a bad range and needs hr.view', async () => {
    expect((await ctx.api.get('/api/hr/clock/punches?from=2026-09-30&to=2026-09-01').set(A())).status).toBe(400);
    expect((await ctx.api.get('/api/hr/clock/punches?from=yesterday&to=today').set(A())).status).toBe(400);
    const e = await linkedEmployee();
    expect((await ctx.api.get('/api/hr/clock/punches?from=2026-09-01&to=2026-09-30').set(e.h)).status).toBe(403);
  });
});

describe('settings API', () => {
  it('HR managers save the lock; it refuses "on" with no locations; employees cannot change it', async () => {
    const off = await ctx.api.put('/api/hr/clock/geofence').set(A()).send({ enabled: false, sites: [], max_accuracy_m: 100 });
    expect(off.status).toBe(200);
    const bad = await ctx.api.put('/api/hr/clock/geofence').set(A()).send({ enabled: true, sites: [], max_accuracy_m: 100 });
    expect(bad.status).toBe(400);
    const tiny = await ctx.api.put('/api/hr/clock/geofence').set(A()).send({ enabled: true, sites: [{ ...OFFICE, radius_m: 5 }] });
    expect(tiny.status).toBe(400);
    const ok = await ctx.api.put('/api/hr/clock/geofence').set(A()).send({ enabled: true, sites: [OFFICE] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, max_accuracy_m: 100 });
    expect((await ctx.api.get('/api/hr/clock/geofence').set(A())).body.sites[0].name).toBe('Main office');

    const e = await linkedEmployee();
    expect((await ctx.api.put('/api/hr/clock/geofence').set(e.h).send({ enabled: false, sites: [] })).status).toBe(403);
  });
});
