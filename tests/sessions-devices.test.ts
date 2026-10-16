/** Session + device tracking (SCHEMA_VERSION 55): where an account is signed in, sign-out that
 *  keeps history, borrowed-phone sessions, remote sign-out, device on activity rows and on
 *  phone punches. See src/shared/auth.ts + src/shared/device.ts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, phonePunch, type TestContext } from './helpers';
// DB-touching modules are imported inside beforeAll, after setupApp() sets DB_PATH (helpers.ts).
let run: typeof import('../src/shared/db').run;
let queryOne: typeof import('../src/shared/db').queryOne;
let queryAll: typeof import('../src/shared/db').queryAll;
let cleanupSessions: typeof import('../src/shared/db').cleanupSessions;
let tokenDigest: typeof import('../src/shared/db').tokenDigest;
let currentKioskCode: typeof import('../src/modules/hr/clock').currentKioskCode;
let deviceLabel: typeof import('../src/shared/device').deviceLabel;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const BEN_PHONE = 'dev-ben-phone-0001';

beforeAll(async () => {
  ctx = await setupApp();
  ({ run, queryOne, queryAll, cleanupSessions, tokenDigest } = await import('../src/shared/db'));
  ({ currentKioskCode } = await import('../src/modules/hr/clock'));
  ({ deviceLabel } = await import('../src/shared/device'));
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

async function signIn(username: string, password: string, device: string, ua = ANDROID_UA, shared = false) {
  const body: Record<string, unknown> = { username, password };
  if (shared) body.shared = true;
  const res = await ctx.api.post('/api/auth/login').set({ 'X-Device-Id': device, 'User-Agent': ua }).send(body);
  expect(res.status).toBe(200);
  return res.body.token as string;
}
const B = (token: string, device?: string) => ({ Authorization: `Bearer ${token}`, ...(device ? { 'X-Device-Id': device } : {}) });

describe('device label', () => {
  it('names common browsers/OSes and falls back gracefully', () => {
    expect(deviceLabel(ANDROID_UA)).toBe('Chrome on Android');
    expect(deviceLabel(IPHONE_UA)).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0'))
      .toBe('Edge on Windows');
    expect(deviceLabel(null)).toBe('Unknown device');
  });
});

describe('sessions', () => {
  it('login records the device, IP and user agent; the list never exposes the token', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, 'dev-list-000001', IPHONE_UA);
    const row = queryOne<{ device_id: string; user_agent: string; ip: string | null; sid: string }>(
      'SELECT device_id, user_agent, ip, sid FROM sessions WHERE token = ?', tokenDigest(token)
    )!;
    expect(row.device_id).toBe('dev-list-000001');
    expect(row.user_agent).toContain('iPhone');
    expect(row.sid).toMatch(/^[0-9a-f]{16}$/);

    const res = await ctx.api.get('/api/auth/sessions').set(B(token));
    expect(res.status).toBe(200);
    const mine = res.body.find((s: { current: boolean }) => s.current);
    expect(mine).toMatchObject({ id: row.sid, device: 'Safari on iPhone', device_id: 'dev-list-000001', shared: false });
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('a malformed device id is ignored rather than stored', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, 'bad id <script>');
    expect(queryOne<{ device_id: string | null }>('SELECT device_id FROM sessions WHERE token = ?', tokenDigest(token))!.device_id).toBeNull();
  });

  it('logout ends the session but keeps it as history', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, 'dev-logout-0001');
    expect((await ctx.api.post('/api/auth/logout').set(B(token))).status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(B(token))).status).toBe(401);
    const row = queryOne<{ ended_at: string | null; end_reason: string }>('SELECT ended_at, end_reason FROM sessions WHERE token = ?', tokenDigest(token))!;
    expect(row.ended_at).toBeTruthy();
    expect(row.end_reason).toBe('logout');

    const other = await login(ctx.api, acc.username, acc.password);
    const hist = await ctx.api.get('/api/auth/sessions?history=1').set(B(other));
    expect(hist.body.some((s: { end_reason: string }) => s.end_reason === 'logout')).toBe(true);
    const live = await ctx.api.get('/api/auth/sessions').set(B(other));
    expect(live.body.every((s: { ended_at: string | null }) => !s.ended_at)).toBe(true);
  });

  it('sign out one other device by id, or all the others; not the current one', async () => {
    const acc = await createEmployee(ctx.api, adminToken); // createEmployee already signed in once
    const phone = await signIn(acc.username, acc.password, 'dev-multi-phone1');
    const pc = await signIn(acc.username, acc.password, 'dev-multi-pc0001');
    const list = (await ctx.api.get('/api/auth/sessions').set(B(pc))).body as Array<{ id: string; current: boolean; device_id: string }>;
    const phoneSid = list.find((s) => s.device_id === 'dev-multi-phone1')!.id;
    const currentSid = list.find((s) => s.current)!.id;

    expect((await ctx.api.post(`/api/auth/sessions/${currentSid}/revoke`).set(B(pc))).status).toBe(400);
    expect((await ctx.api.post(`/api/auth/sessions/${phoneSid}/revoke`).set(B(pc))).status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(B(phone))).status).toBe(401);
    expect((await ctx.api.post(`/api/auth/sessions/${phoneSid}/revoke`).set(B(pc))).status).toBe(404);

    const all = await ctx.api.post('/api/auth/sessions/revoke-others').set(B(pc));
    expect(all.body.ended).toBe(1); // the createEmployee login
    expect((await ctx.api.get('/api/auth/me').set(B(pc))).status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(B(acc.token))).status).toBe(401);
  });

  it("cannot sign out someone else's session by id", async () => {
    const a = await createEmployee(ctx.api, adminToken);
    const b = await createEmployee(ctx.api, adminToken);
    const bSid = queryOne<{ sid: string }>('SELECT sid FROM sessions WHERE token = ?', tokenDigest(b.token))!.sid;
    expect((await ctx.api.post(`/api/auth/sessions/${bSid}/revoke`).set(B(a.token))).status).toBe(404);
    expect((await ctx.api.get('/api/auth/me').set(B(b.token))).status).toBe(200);
  });

  it('changing your password ends all sessions with reason "password"', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const other = await signIn(acc.username, acc.password, 'dev-pw-other001');
    const res = await ctx.api.post('/api/auth/change-password').set(B(acc.token))
      .send({ current_password: acc.password, new_password: 'newsecret1' });
    expect(res.status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(B(other))).status).toBe(401);
    expect(queryOne<{ end_reason: string }>('SELECT end_reason FROM sessions WHERE token = ?', tokenDigest(other))!.end_reason).toBe('password');
    expect((await ctx.api.get('/api/auth/me').set(B(acc.token))).status).toBe(401);
  });

  it('cleanup stamps expired sessions and sweeps old history', () => {
    const acc = queryOne<{ id: number }>("SELECT id FROM users WHERE username = 'admin'")!;
    run(`INSERT INTO sessions (token, sid, user_id, expires_at) VALUES ('tok-expired', 'sid-expired', ?, datetime('now', '-1 hour'))`, acc.id);
    run(`INSERT INTO sessions (token, sid, user_id, expires_at, ended_at, end_reason)
         VALUES ('tok-ancient', 'sid-ancient', ?, datetime('now', '-200 days'), datetime('now', '-200 days'), 'logout')`, acc.id);
    cleanupSessions();
    expect(queryOne<{ end_reason: string }>("SELECT end_reason FROM sessions WHERE token = 'tok-expired'")!.end_reason).toBe('expired');
    expect(queryOne("SELECT 1 AS x FROM sessions WHERE token = 'tok-ancient'")).toBeUndefined();
  });
});

describe('borrowed-phone sign-in', () => {
  it('is a short session flagged shared, reported by /auth/me', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, BEN_PHONE, ANDROID_UA, true);
    const row = queryOne<{ shared: number; idle_minutes: number; hours: number }>(
      "SELECT shared, idle_minutes, round((julianday(expires_at) - julianday(created_at)) * 24) AS hours FROM sessions WHERE token = ?", tokenDigest(token)
    )!;
    expect(row).toEqual({ shared: 1, idle_minutes: 30, hours: 4 });
    const me = await ctx.api.get('/api/auth/me').set(B(token));
    expect(me.body.session).toEqual({ shared: true });
    const act = queryOne<{ summary: string }>(
      "SELECT summary FROM activity_log WHERE action = 'login' AND device_id = ? ORDER BY id DESC LIMIT 1", BEN_PHONE
    )!;
    expect(act.summary).toBe('Signed in on a borrowed device');
  });

  it('times out after 30 idle minutes', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, BEN_PHONE, ANDROID_UA, true);
    run("UPDATE sessions SET last_seen_at = datetime('now', '-31 minutes') WHERE token = ?", tokenDigest(token));
    expect((await ctx.api.get('/api/auth/me').set(B(token))).status).toBe(401);
    const list = await ctx.api.get('/api/auth/sessions?history=1').set(B(acc.token));
    expect(list.body.find((s: { shared: boolean }) => s.shared)).toMatchObject({ end_reason: 'idle' });
  });

  it('cannot turn on push notifications', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, BEN_PHONE, ANDROID_UA, true);
    const res = await ctx.api.post('/api/push/subscribe').set(B(token, BEN_PHONE))
      .send({ endpoint: 'https://fcm.googleapis.com/borrowed', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(403);
  });
});

describe('push on sign-out', () => {
  it("logout drops the user's subscription from that device only; status reports ownership", async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const phone = await signIn(acc.username, acc.password, 'dev-push-phone1');
    const sub = (endpoint: string, device: string, token: string) => ctx.api.post('/api/push/subscribe')
      .set(B(token, device)).send({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
    expect((await sub('https://fcm.googleapis.com/phone', 'dev-push-phone1', phone)).status).toBe(201);
    expect((await sub('https://fcm.googleapis.com/laptop', 'dev-push-laptop', acc.token)).status).toBe(201);

    const st = await ctx.api.get('/api/push/status?endpoint=' + encodeURIComponent('https://fcm.googleapis.com/phone')).set(B(phone));
    expect(st.body.this_device).toBe(true);
    const other = await createEmployee(ctx.api, adminToken);
    const st2 = await ctx.api.get('/api/push/status?endpoint=' + encodeURIComponent('https://fcm.googleapis.com/phone')).set(B(other.token));
    expect(st2.body.this_device).toBe(false);

    await ctx.api.post('/api/auth/logout').set(B(phone, 'dev-push-phone1'));
    const left = queryAll<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', acc.id);
    expect(left.map((r) => r.endpoint)).toEqual(['https://fcm.googleapis.com/laptop']);
  });
});

describe('admin session controls', () => {
  it('users.manage can list and end any account\'s sessions; others cannot', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const phone = await signIn(acc.username, acc.password, 'dev-admin-view01');
    const stranger = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    expect((await ctx.api.get(`/api/users/${acc.id}/sessions`).set(B(stranger.token))).status).toBe(403);

    const list = await ctx.api.get(`/api/users/${acc.id}/sessions`).set(A());
    expect(list.status).toBe(200);
    const phoneSid = list.body.find((s: { device_id: string }) => s.device_id === 'dev-admin-view01').id;
    expect((await ctx.api.post(`/api/users/${acc.id}/sessions/${phoneSid}/revoke`).set(A())).status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(B(phone))).status).toBe(401);

    const all = await ctx.api.post(`/api/users/${acc.id}/sessions/revoke-all`).set(A());
    expect(all.body.ended).toBe(1);
    expect((await ctx.api.get('/api/auth/me').set(B(acc.token))).status).toBe(401);
    expect((await ctx.api.get('/api/auth/me').set(A())).status).toBe(200);
  });

  it('disabling an account ends its sessions with reason "deactivated"', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const res = await ctx.api.put(`/api/users/${acc.id}`).set(A())
      .send({ full_name: 'Test Employee', role: 'admin_staff', department_id: null, active: false });
    expect(res.status).toBe(200);
    expect(queryOne<{ end_reason: string }>('SELECT end_reason FROM sessions WHERE token = ?', tokenDigest(acc.token))!.end_reason).toBe('deactivated');
  });
});

describe('activity log device', () => {
  it('records the device id + label on each row and filters by device and IP', async () => {
    const acc = await createEmployee(ctx.api, adminToken);
    const token = await signIn(acc.username, acc.password, 'dev-activity-001', IPHONE_UA);
    await ctx.api.post('/api/tasks').set({ ...B(token, 'dev-activity-001'), 'User-Agent': IPHONE_UA }).send({ title: 'x' });
    const rows = queryAll<{ device_id: string; device: string; action: string }>(
      "SELECT device_id, device, action FROM activity_log WHERE device_id = 'dev-activity-001'"
    );
    expect(rows.length).toBeGreaterThanOrEqual(2); // the login + the task
    expect(rows.every((r) => r.device === 'Safari on iPhone')).toBe(true);

    const byDevice = await ctx.api.get('/api/activity?device_id=dev-activity-001').set(A());
    expect(byDevice.status).toBe(200);
    expect(byDevice.body.total).toBe(rows.length);
    const ip = byDevice.body.rows[0].ip;
    const byIp = await ctx.api.get('/api/activity?ip=' + encodeURIComponent(ip)).set(A());
    expect(byIp.body.total).toBeGreaterThanOrEqual(rows.length);
  });
});

describe('punch device flag', () => {
  async function linkedEmployee() {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const employee_no = 'E' + Math.floor(Math.random() * 1e6);
    const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
      employee_no, name: acc.username.toUpperCase(), user_id: acc.id, daily_rate: 500, rate_type: 'daily', status: 'regular',
    });
    if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
    return { ...acc, employeeId: emp.body.id as number };
  }
  const lastPunch = (employeeId: number) => queryOne<{ device_id: string | null; device_flag: string | null; device_user_id: number | null }>(
    'SELECT device_id, device_flag, device_user_id FROM time_punches WHERE employee_id = ? ORDER BY id DESC LIMIT 1', employeeId
  )!;

  it("flags a punch on a phone another employee usually uses, and a borrowed-phone punch; not one's own", async () => {
    const ben = await linkedEmployee();
    const benPhone = 'dev-punch-ben001';
    await signIn(ben.username, ben.password, benPhone);
    await signIn(ben.username, ben.password, benPhone);

    // Ben on his own phone: no flag.
    const benTok = await signIn(ben.username, ben.password, benPhone);
    expect((await phonePunch(ctx.api, B(benTok, benPhone), { code: currentKioskCode().code })).status).toBe(200);
    expect(lastPunch(ben.employeeId)).toMatchObject({ device_id: benPhone, device_flag: null });

    // Ana signs in normally on Ben's phone.
    const ana = await linkedEmployee();
    const anaTok = await signIn(ana.username, ana.password, benPhone);
    expect((await phonePunch(ctx.api, B(anaTok, benPhone), { code: currentKioskCode().code })).status).toBe(200);
    expect(lastPunch(ana.employeeId)).toMatchObject({ device_flag: 'other_user', device_user_id: ben.id });

    // Cara uses the borrowed-phone option.
    const cara = await linkedEmployee();
    const caraTok = await signIn(cara.username, cara.password, benPhone, ANDROID_UA, true);
    expect((await phonePunch(ctx.api, B(caraTok, benPhone), { code: currentKioskCode().code })).status).toBe(200);
    expect(lastPunch(cara.employeeId)).toMatchObject({ device_flag: 'borrowed', device_user_id: ben.id });

    const today = new Date().toLocaleDateString('en-CA');
    const log = await ctx.api.get(`/api/hr/clock/punches?from=${today}&to=${today}`).set(A());
    const anaRow = log.body.find((r: { name: string }) => r.name === ana.username.toUpperCase());
    expect(anaRow).toMatchObject({ device_flag: 'other_user', device_user_name: 'Test Employee' });
  });
});
