/** Employee self-service profile — /api/me/profile (preferred name + contact details, password
 *  re-auth, never the legal name) and /api/hr/employee-profiles (HR verification). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// Dynamic import after setupApp() sets DB_PATH (see helpers.ts).
let queryOne: typeof import('../src/shared/db').queryOne;
let queryAll: typeof import('../src/shared/db').queryAll;

let ctx: TestContext;
let adminToken: string;
let emp: { id: number; token: string; password: string };
let hrUser: { id: number; token: string };
let unlinked: { id: number; token: string };
let employeeId: number;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne, queryAll } = await import('../src/shared/db'));
  adminToken = await login(ctx.api);
  emp = await createEmployee(ctx.api, adminToken, { role: 'csr', full_name: 'Account Name' });
  hrUser = await createEmployee(ctx.api, adminToken, { role: 'hr' });
  unlinked = await createEmployee(ctx.api, adminToken, { role: 'csr' });
  const r = await ctx.api.post('/api/hr/employees').set(bearer(adminToken))
    .send({ employee_no: 'PRF-1', name: 'Juana Dela Cruz', user_id: emp.id, position: 'Assembler', daily_rate: 650 });
  employeeId = r.body.id;
});
afterAll(() => cleanup(ctx));

const put = (body: Record<string, unknown>, token = emp.token) => ctx.api.put('/api/me/profile').set(bearer(token)).send(body);

describe('self-service profile', () => {
  it('returns empty editable fields plus the read-only official record', async () => {
    const r = await ctx.api.get('/api/me/profile').set(bearer(emp.token));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ preferred_name: null, mobile_phone: null, verified_at: null, needs_verification: false });
    expect(r.body.official).toMatchObject({ name: 'Juana Dela Cruz', employee_no: 'PRF-1', position: 'Assembler' });
  });

  it('requires the current password (400, never 401) and changes nothing without it', async () => {
    expect((await put({ mobile_phone: '09171234567' })).status).toBe(400);
    const wrong = await put({ current_password: 'nope', mobile_phone: '09171234567' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/password/i);
    expect(queryOne('SELECT * FROM employee_profiles WHERE employee_id = ?', employeeId)).toBeUndefined();
  });

  it('rejects authoritative fields outright instead of ignoring them', async () => {
    for (const body of [{ name: 'Someone Else' }, { daily_rate: 9999 }, { position: 'Manager' }, { full_name: 'X' }]) {
      const r = await put({ current_password: emp.password, ...body });
      expect(r.status).toBe(400);
    }
    expect(queryOne<{ name: string; daily_rate: number }>('SELECT name, daily_rate FROM employees WHERE id = ?', employeeId))
      .toEqual({ name: 'Juana Dela Cruz', daily_rate: 650 });
    expect(queryOne<{ full_name: string }>('SELECT full_name FROM users WHERE id = ?', emp.id)!.full_name).toBe('Account Name');
  });

  it('validates and normalizes contact details, records history, redacts the password in the audit log', async () => {
    expect((await put({ current_password: emp.password, mobile_phone: '12345' })).status).toBe(400);
    expect((await put({ current_password: emp.password, personal_email: 'not-an-email' })).status).toBe(400);

    const r = await put({
      current_password: emp.password, preferred_name: 'Jen', mobile_phone: '0917 123 4567',
      personal_email: 'Juana@Example.com', emergency_contact_name: 'Pedro', emergency_contact_phone: '+63 918 765 4321',
    });
    expect(r.status).toBe(200);
    expect(r.body.changed.sort()).toEqual(['emergency_contact_name', 'emergency_contact_phone', 'mobile_phone', 'personal_email', 'preferred_name']);
    expect(r.body.profile).toMatchObject({
      preferred_name: 'Jen', mobile_phone: '+639171234567', personal_email: 'juana@example.com',
      emergency_contact_phone: '+639187654321', needs_verification: true,
    });
    // Legal name untouched; preferred name surfaces on GET /me for greetings.
    expect(queryOne<{ name: string }>('SELECT name FROM employees WHERE id = ?', employeeId)!.name).toBe('Juana Dela Cruz');
    expect((await ctx.api.get('/api/me').set(bearer(emp.token))).body.employee.preferred_name).toBe('Jen');

    const hist = queryAll<{ field: string; source: string }>('SELECT field, source FROM employee_profile_changes WHERE employee_id = ?', employeeId);
    expect(hist).toHaveLength(5);
    expect(hist.every((h) => h.source === 'self')).toBe(true);
    const own = await ctx.api.get('/api/me/profile/history').set(bearer(emp.token));
    expect(own.body.map((h: { field: string }) => h.field)).toContain('mobile_phone');

    const log = queryOne<{ meta: string }>("SELECT meta FROM activity_log WHERE path = '/api/me/profile' AND status_code = 200 ORDER BY id DESC LIMIT 1")!;
    expect(JSON.parse(log.meta).body.redacted).toBe(true);
    expect(log.meta).not.toContain('juana@example.com');
    expect(log.meta).not.toContain(emp.password);
  });

  it('a partial update only touches the keys sent', async () => {
    const r = await put({ current_password: emp.password, home_address: 'Blk 1 Lot 2, Cavite' });
    expect(r.body.changed).toEqual(['home_address']);
    expect(r.body.profile.mobile_phone).toBe('+639171234567');
  });

  it('403s for an account with no employee record', async () => {
    expect((await ctx.api.get('/api/me/profile').set(bearer(unlinked.token))).status).toBe(403);
  });
});

describe('HR verification', () => {
  it('lists unverified profiles and lets hr.manage verify them', async () => {
    expect((await ctx.api.get('/api/hr/employee-profiles').set(bearer(emp.token))).status).toBe(403);
    const list = await ctx.api.get('/api/hr/employee-profiles').set(bearer(hrUser.token));
    expect(list.status).toBe(200);
    expect(list.body.map((r: { employee_id: number }) => r.employee_id)).toContain(employeeId);

    expect((await ctx.api.post(`/api/hr/employee-profiles/${employeeId}/verify`).set(bearer(emp.token))).status).toBe(403);
    const v = await ctx.api.post(`/api/hr/employee-profiles/${employeeId}/verify`).set(bearer(hrUser.token));
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ needs_verification: false });
    expect(v.body.verified_at).toBeTruthy();

    const detail = await ctx.api.get(`/api/hr/employee-profiles/${employeeId}`).set(bearer(hrUser.token));
    expect(detail.body.history[0]).toMatchObject({ field: 'verified', source: 'hr_verify' });
  });

  it('keeps verification when only the preferred name changes, clears it on a contact change', async () => {
    const nick = await put({ current_password: emp.password, preferred_name: 'Juana' });
    expect(nick.body.verification_cleared).toBe(false);
    expect(nick.body.profile.verified_at).toBeTruthy();

    const phone = await put({ current_password: emp.password, mobile_phone: '09998887777' });
    expect(phone.body.verification_cleared).toBe(true);
    expect(phone.body.profile).toMatchObject({ verified_at: null, needs_verification: true });
  });

  it('refuses to verify a profile with no contact details', async () => {
    const other = await ctx.api.post('/api/hr/employees').set(bearer(adminToken)).send({ employee_no: 'PRF-2', name: 'No Contacts', daily_rate: 600 });
    expect((await ctx.api.post(`/api/hr/employee-profiles/${other.body.id}/verify`).set(bearer(hrUser.token))).status).toBe(400);
  });
});
