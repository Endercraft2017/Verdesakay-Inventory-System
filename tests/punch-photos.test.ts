/** Kiosk punch photos: upload/serve for attendance + field-work punches, replace-in-place on
 *  a correction (or a second upload for the same punch), and per-tenant retention (owner-only
 *  settings, enforced lazily on each save -- see src/punch-photos.ts). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// See clock.test.ts's doc comment for why these are imported dynamically inside beforeAll.
let queryOne: typeof import('../src/shared/db').queryOne;
let run: typeof import('../src/shared/db').run;
let withTenant: typeof import('../src/shared/db').withTenant;
let currentKioskCode: typeof import('../src/modules/hr/clock').currentKioskCode;
let provisioning: typeof import('../src/platform/provisioning');
let platform: typeof import('../src/platform/platform');

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne, run, withTenant } = await import('../src/shared/db'));
  ({ currentKioskCode } = await import('../src/modules/hr/clock'));
  provisioning = await import('../src/platform/provisioning');
  platform = await import('../src/platform/platform');
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const code = () => currentKioskCode().code;
const jpeg = (sizeBytes: number) => Buffer.alloc(sizeBytes, 1);
// `url` in a punch-photo response is /api-relative (this app's convention -- see
// API.get/post/blobUrl in public/js/api.js), so a raw request needs /api prepended.
const fetchable = (url: string) => '/api' + url;

async function employee() {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const employee_no = 'E' + Math.floor(Math.random() * 1e6);
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no, name: acc.username.toUpperCase(), user_id: acc.id,
    daily_rate: 500, rate_type: 'daily', status: 'regular',
  });
  if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
  return { employeeId: emp.body.id as number, employee_no };
}

describe('punch photos: upload, serve, replace', () => {
  it('uploads a photo for an attendance punch and serves it back', async () => {
    const e = await employee();
    const punch = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: code(), employee_no: e.employee_no });
    expect(punch.status).toBe(200);

    const up = await ctx.api.post(`/api/hr/clock/photo/${punch.body.id}`).set(A()).attach('photo', jpeg(500), 'a.jpg');
    expect(up.status).toBe(201);
    expect(up.body.url).toBe(`/hr/clock/photo/${up.body.id}`);

    const img = await ctx.api.get(fetchable(up.body.url)).set(A());
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect(Number(img.headers['content-length'])).toBe(500);
  });

  it('404s uploading a photo for a punch that does not exist', async () => {
    const res = await ctx.api.post('/api/hr/clock/photo/999999999').set(A()).attach('photo', jpeg(200), 'x.jpg');
    expect(res.status).toBe(404);
  });

  it('404s serving an unknown photo id', async () => {
    expect((await ctx.api.get('/api/hr/clock/photo/999999999').set(A())).status).toBe(404);
  });

  it('replaces the existing photo in place (same row) instead of accumulating', async () => {
    const e = await employee();
    const punch = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: code(), employee_no: e.employee_no });

    const first = await ctx.api.post(`/api/hr/clock/photo/${punch.body.id}`).set(A()).attach('photo', jpeg(500), 'first.jpg');
    const second = await ctx.api.post(`/api/hr/clock/photo/${punch.body.id}`).set(A()).attach('photo', jpeg(900), 'second.jpg');

    expect(second.body.id).toBe(first.body.id); // same row, reused
    const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM punch_photos WHERE punch_id = ?', punch.body.id)!.n;
    expect(n).toBe(1);

    const img = await ctx.api.get(fetchable(first.body.url)).set(A());
    expect(Number(img.headers['content-length'])).toBe(900); // serves the newer file, old one's gone
  });

  it('uploads and serves a photo for a field-work punch too, kept separate from attendance', async () => {
    const e = await employee();
    const punch = await ctx.api.post('/api/hr/field/kiosk-punch').set(A()).send({ code: code(), employee_no: e.employee_no });
    const up = await ctx.api.post(`/api/hr/field/photo/${punch.body.id}`).set(A()).attach('photo', jpeg(300), 'f.jpg');
    expect(up.status).toBe(201);
    expect(up.body.url).toBe(`/hr/field/photo/${up.body.id}`);
    expect((await ctx.api.get(fetchable(up.body.url)).set(A())).status).toBe(200);

    const row = queryOne<{ punch_kind: string }>('SELECT punch_kind FROM punch_photos WHERE id = ?', up.body.id)!;
    expect(row.punch_kind).toBe('field');
  });
});

describe('attendance grid surfaces photo urls', () => {
  it('GET /periods/:id/attendance includes a photo url only for the slot that has one', async () => {
    const e = await employee();
    const todayStr = new Date().toLocaleDateString('en-CA'); // local date, like the server's work_date
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Photo grid test', start_date: todayStr, end_date: todayStr });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const punch = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: code(), employee_no: e.employee_no });
    const day = punch.body.work_date as string;
    const up = await ctx.api.post(`/api/hr/clock/photo/${punch.body.id}`).set(A()).attach('photo', jpeg(400), 'x.jpg');

    const grid = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${e.employeeId}`).set(A());
    expect(grid.status).toBe(200);
    const row = grid.body.find((r: { work_date: string }) => r.work_date === day);
    expect(row).toBeTruthy();
    expect(row.photos).toEqual({
      time_in: `/hr/clock/photo/${up.body.id}`,
      lunch_out: null,
      lunch_in: null,
      time_out: null,
    });
  });

  it('a day with no punches at all still gets an all-null photos object', async () => {
    const e = await employee();
    const todayStr = new Date().toLocaleDateString('en-CA'); // local date, like the server's work_date
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Photo grid blank', start_date: todayStr, end_date: todayStr });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const grid = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${e.employeeId}`).set(A());
    expect(grid.body[0].photos).toEqual({ time_in: null, lunch_out: null, lunch_in: null, time_out: null });
  });
});

describe('per-tenant punch-photo retention (owner-only)', () => {
  const slug = 'photoco' + Math.floor(Math.random() * 1e6);
  const asTenant = () => ({ 'X-Tenant': slug });
  let tkn: string;

  beforeAll(async () => {
    provisioning.createTenant({ slug, name: 'Photo Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'trial' });
    const r = await ctx.api.post('/api/auth/login').set(asTenant()).send({ username: 'owner', password: 'ownerpass1' });
    tkn = r.body.token;
  });

  const H = () => ({ ...asTenant(), Authorization: `Bearer ${tkn}` });
  const tenantCode = () => withTenant(slug, () => currentKioskCode().code);

  async function tenantEmployee() {
    const acc = await ctx.api.post('/api/users').set(H())
      .send({ username: 't' + Math.floor(Math.random() * 1e6), full_name: 'T', password: 'secret1', role: 'warehouse' });
    const employee_no = 'T' + Math.floor(Math.random() * 1e6);
    const emp = await ctx.api.post('/api/hr/employees').set(H())
      .send({ employee_no, name: 'TENANT EMP', user_id: acc.body.id, daily_rate: 500, rate_type: 'daily', status: 'regular' });
    return { employee_no };
  }

  it('evicts the oldest photo once the owner-set size cap is exceeded', async () => {
    platform.setTenantPhotoRetention(slug, { days: 0, maxMb: 0.01 }); // ~10.5KB cap, no age limit

    const e1 = await tenantEmployee();
    const p1 = await ctx.api.post('/api/hr/clock/kiosk-punch').set(H()).send({ code: tenantCode(), employee_no: e1.employee_no });
    const up1 = await ctx.api.post(`/api/hr/clock/photo/${p1.body.id}`).set(H()).attach('photo', jpeg(6000), 'a.jpg');
    expect(up1.status).toBe(201);

    const e2 = await tenantEmployee();
    const p2 = await ctx.api.post('/api/hr/clock/kiosk-punch').set(H()).send({ code: tenantCode(), employee_no: e2.employee_no });
    const up2 = await ctx.api.post(`/api/hr/clock/photo/${p2.body.id}`).set(H()).attach('photo', jpeg(6000), 'b.jpg');
    expect(up2.status).toBe(201);

    // Total (12000 bytes) now exceeds the ~10.5KB cap -- the older photo was evicted to fit.
    expect((await ctx.api.get(fetchable(up1.body.url)).set(H())).status).toBe(404);
    expect((await ctx.api.get(fetchable(up2.body.url)).set(H())).status).toBe(200);
    const n = withTenant(slug, () => queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM punch_photos')!.n);
    expect(n).toBe(1);
  });

  it('evicts anything past the owner-set age limit, checked on the next save', async () => {
    platform.setTenantPhotoRetention(slug, { days: 5, maxMb: 0 }); // age limit only

    const e1 = await tenantEmployee();
    const p1 = await ctx.api.post('/api/hr/clock/kiosk-punch').set(H()).send({ code: tenantCode(), employee_no: e1.employee_no });
    const up1 = await ctx.api.post(`/api/hr/clock/photo/${p1.body.id}`).set(H()).attach('photo', jpeg(500), 'old.jpg');
    withTenant(slug, () => run("UPDATE punch_photos SET created_at = datetime('now', '-10 days') WHERE id = ?", up1.body.id));

    const e2 = await tenantEmployee();
    const p2 = await ctx.api.post('/api/hr/clock/kiosk-punch').set(H()).send({ code: tenantCode(), employee_no: e2.employee_no });
    await ctx.api.post(`/api/hr/clock/photo/${p2.body.id}`).set(H()).attach('photo', jpeg(500), 'new.jpg');

    expect((await ctx.api.get(fetchable(up1.body.url)).set(H())).status).toBe(404);
  });
});
