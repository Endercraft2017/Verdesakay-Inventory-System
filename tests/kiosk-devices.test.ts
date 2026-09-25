/** Approved kiosk devices (src/modules/hr/kiosk-devices.ts): with the kiosk lock on, the kiosk
 *  endpoints — current QR code, typed punches, corrections, field-work punches — only answer a
 *  browser an HR manager approved. Office-LAN default: lock off (see kiosk-devices-hosted.test.ts
 *  for the internet-facing default). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let setSetting: typeof import('../src/shared/db').setSetting;
let queryAll: typeof import('../src/shared/db').queryAll;
let currentKioskCode: typeof import('../src/modules/hr/clock').currentKioskCode;

let ctx: TestContext;
let adminToken: string;
let employeeNo: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const code = () => currentKioskCode().code;

beforeAll(async () => {
  ctx = await setupApp();
  ({ setSetting, queryAll } = await import('../src/shared/db'));
  ({ currentKioskCode } = await import('../src/modules/hr/clock'));
  adminToken = await login(ctx.api);
  employeeNo = 'K' + Math.floor(Math.random() * 1e6);
  const emp = await ctx.api.post('/api/hr/employees').set(A())
    .send({ employee_no: employeeNo, name: 'KIOSK TESTER', daily_rate: 500, rate_type: 'daily', status: 'regular' });
  expect(emp.status).toBe(201);
});
afterAll(() => cleanup(ctx));

describe('office-LAN install (lock off by default)', () => {
  it('the kiosk works without any approval, as before', async () => {
    const info = await ctx.api.get('/api/hr/clock/kiosk-devices').set(A());
    expect(info.body).toMatchObject({ lock_active: false, lock_setting: null, this_device: null, devices: [] });
    expect((await ctx.api.get('/api/hr/clock/code').set(A())).status).toBe(200);
  });
});

describe('lock on', () => {
  let token: string;
  let deviceId: number;

  it('refuses every kiosk endpoint from an unapproved browser', async () => {
    expect((await ctx.api.put('/api/hr/clock/kiosk-lock').set(A()).send({ enabled: true })).body.lock_active).toBe(true);
    const c = await ctx.api.get('/api/hr/clock/code').set(A());
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('KIOSK_NOT_APPROVED');
    const guessed = currentKioskCode().code; // even with a valid code in hand
    expect((await ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: guessed, employee_no: employeeNo })).status).toBe(403);
    expect((await ctx.api.post('/api/hr/clock/correct').set(A()).send({ code: guessed, employee_no: employeeNo, slot: 'in' })).status).toBe(403);
    expect((await ctx.api.post('/api/hr/field/kiosk-punch').set(A()).send({ code: guessed, employee_no: employeeNo })).status).toBe(403);
    // Read-only HR data isn't locked.
    expect((await ctx.api.get('/api/hr/clock/recent').set(A())).status).toBe(200);
  });

  it('an HR manager approves this PC; its token unlocks the kiosk', async () => {
    const r = await ctx.api.post('/api/hr/clock/kiosk-devices').set(A()).send({ name: 'Front desk PC' });
    expect(r.status).toBe(201);
    token = r.body.token;
    deviceId = r.body.id;
    const K = { ...A(), 'X-Kiosk-Token': token };
    expect((await ctx.api.get('/api/hr/clock/code').set(K)).status).toBe(200);
    const punch = await ctx.api.post('/api/hr/clock/kiosk-punch').set(K).send({ code: code(), employee_no: employeeNo });
    expect(punch.status).toBe(200);
    const info = await ctx.api.get('/api/hr/clock/kiosk-devices').set(K);
    expect(info.body.this_device).toMatchObject({ id: deviceId, name: 'Front desk PC' });
    expect(info.body.devices[0]).toMatchObject({ name: 'Front desk PC', created_by_name: 'System Administrator' });
  });

  it('stores only a hash of the token, and rejects a wrong one', async () => {
    const rows = queryAll<{ token_hash: string }>('SELECT token_hash FROM kiosk_devices');
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect((await ctx.api.get('/api/hr/clock/code').set({ ...A(), 'X-Kiosk-Token': token + 'x' })).status).toBe(403);
  });

  it('staff without hr.manage cannot approve a PC or change the lock', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const H = { Authorization: `Bearer ${acc.token}` };
    expect((await ctx.api.post('/api/hr/clock/kiosk-devices').set(H).send({ name: 'Home PC' })).status).toBe(403);
    expect((await ctx.api.put('/api/hr/clock/kiosk-lock').set(H).send({ enabled: false })).status).toBe(403);
  });

  it('a revoked PC is locked out at once', async () => {
    expect((await ctx.api.delete(`/api/hr/clock/kiosk-devices/${deviceId}`).set(A())).status).toBe(200);
    expect((await ctx.api.get('/api/hr/clock/code').set({ ...A(), 'X-Kiosk-Token': token })).status).toBe(403);
    expect((await ctx.api.get('/api/hr/clock/kiosk-devices').set(A())).body.devices).toEqual([]);
  });

  it('turning the lock off opens the kiosk again', async () => {
    const off = await ctx.api.put('/api/hr/clock/kiosk-lock').set(A()).send({ enabled: false });
    expect(off.body).toMatchObject({ lock_active: false, lock_setting: false });
    expect((await ctx.api.get('/api/hr/clock/code').set(A())).status).toBe(200);
    setSetting('kiosk_lock', null);
  });
});
