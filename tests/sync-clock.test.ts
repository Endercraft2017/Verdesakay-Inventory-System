/**
 * Offline-first sync, phase 4a (docs/OFFLINE-FIRST.md §20): the time clock offline. A punch made
 * while the internet is down keeps the minute it happened; its kiosk code is checked against the
 * window it was scanned in; a locked kiosk is re-checked on the cloud; a borrowed phone stays
 * flagged; punch photos travel both ways under the same name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, phonePunch } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
const api = () => T.ctx.api;
let emp: { employee_no: string; id: number; username: string; password: string };
// One person per scenario: the clock (rightly) ignores a repeat punch within 45 s.
let emp2: { employee_no: string; id: number };
let emp3: { employee_no: string; id: number };

const ROTATE = 60;
/** The kiosk code for the window containing `at` (same HMAC as src/modules/hr/clock.ts). */
function codeAt(conn: import('node:sqlite').DatabaseSync, at: Date): string {
  const raw = (conn.prepare("SELECT value FROM settings WHERE key = 'clock_hmac_key'").get() as { value: string }).value;
  const key = JSON.parse(raw) as string;
  const win = Math.floor(at.getTime() / 1000 / ROTATE);
  return crypto.createHmac('sha256', key).update(String(win)).digest('base64url').slice(0, 10);
}
const localStamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const punchesOf = (conn: import('node:sqlite').DatabaseSync, employeeId: number) =>
  conn.prepare('SELECT id, ts, kind, source, device_flag FROM time_punches WHERE employee_id = ? ORDER BY id').all(employeeId) as
    Array<{ id: number; ts: string; kind: string; source: string; device_flag: string | null }>;
const jpeg = (marker: string) => Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.from(marker), Buffer.from('ffd9', 'hex')]);

beforeAll(async () => {
  T = await setupSiteTrio();
  // An employee with a login (for the phone punch), created on the cloud, then synced to the site.
  const username = 'clk' + Math.floor(Math.random() * 1e6);
  const u = await api().post('/api/users').set(T.cloudHdr()).send({ username, full_name: 'Clock Person', password: 'clockpw1', role: 'warehouse' });
  expect(u.status).toBe(201);
  const employee_no = 'E' + Math.floor(Math.random() * 1e6);
  const e = await api().post('/api/hr/employees').set(T.cloudHdr())
    .send({ employee_no, name: 'CLOCK PERSON', user_id: u.body.id, daily_rate: 500, rate_type: 'daily', status: 'regular' });
  expect(e.status).toBe(201);
  emp = { employee_no, id: e.body.id, username, password: 'clockpw1' };
  const no2 = 'E' + Math.floor(Math.random() * 1e6);
  const e2 = await api().post('/api/hr/employees').set(T.cloudHdr())
    .send({ employee_no: no2, name: 'SECOND PERSON', daily_rate: 500, rate_type: 'daily', status: 'regular' });
  expect(e2.status).toBe(201);
  emp2 = { employee_no: no2, id: e2.body.id };
  const no3 = 'E' + Math.floor(Math.random() * 1e6);
  const e3 = await api().post('/api/hr/employees').set(T.cloudHdr())
    .send({ employee_no: no3, name: 'THIRD PERSON', daily_rate: 500, rate_type: 'daily', status: 'regular' });
  expect(e3.status).toBe(201);
  emp3 = { employee_no: no3, id: e3.body.id };
  // The kiosk code key must be the same everywhere: make the cloud create it, then sync.
  await api().get('/api/hr/clock/code').set(T.cloudHdr());
  await T.hostRound();
  await T.lanRound();
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('a kiosk punch while the internet is down', () => {
  it('keeps the minute it happened, and its code is checked against that minute', async () => {
    T.cutOff('host');
    const code = (await api().get('/api/hr/clock/code').set(T.hostHdr())).body.code as string;
    const r = await api().post('/api/hr/clock/kiosk-punch').set(T.hostHdr()).send({ code, employee_no: emp.employee_no });
    expect(r.status).toBe(200);
    expect(r.headers['x-sync-state']).toBe('local');

    // Pretend it happened 2 hours ago (the PC was offline that long): the command's time and the
    // code shown on the kiosk then.
    const at = new Date(Date.now() - 2 * 3600_000);
    const cmdId = String(r.headers['x-sync-command']);
    const body = JSON.parse((T.hostDb().prepare('SELECT body FROM sync_commands WHERE id = ?').get(cmdId) as { body: string }).body);
    T.hostDb().prepare('UPDATE sync_commands SET occurred_at = ?, body = ? WHERE id = ?')
      .run(at.toISOString(), JSON.stringify({ ...body, code: codeAt(T.hostDb(), at) }), cmdId);

    T.reconnect('host');
    const sync = await T.hostRound();
    expect(sync.pushed).toMatchObject([{ id: cmdId, state: 'confirmed' }]);
    const cloud = punchesOf(T.cloudDb(), emp.id);
    expect(cloud).toHaveLength(1);
    expect(cloud[0]!.ts.slice(0, 16)).toBe(localStamp(at)); // stored at the punch's own time
    expect(cloud[0]!.source).toBe('kiosk');
    await T.lanRound();
    expect(punchesOf(T.hostDb(), emp.id)).toEqual(cloud);
    expect(punchesOf(T.lanDb(), emp.id)).toEqual(cloud);
  });
});

describe('a locked kiosk', () => {
  it('is re-checked on the cloud with the same approved kiosk', async () => {
    expect((await api().put('/api/hr/clock/kiosk-lock').set(T.cloudHdr()).send({ enabled: true })).status).toBe(200);
    const dev = await api().post('/api/hr/clock/kiosk-devices').set(T.cloudHdr()).send({ name: 'Gate kiosk' });
    expect(dev.status).toBe(201);
    await T.hostRound();
    const K = { ...T.hostHdr(), 'X-Kiosk-Token': dev.body.token as string };
    const code = (await api().get('/api/hr/clock/code').set(K)).body.code as string;
    const r = await api().post('/api/hr/clock/kiosk-punch').set(K).send({ code, employee_no: emp2.employee_no });
    expect(r.status).toBe(200);
    const sync = await T.hostRound();
    expect(sync.pushed).toMatchObject([{ state: 'confirmed' }]); // the approval travelled with the punch
    expect(punchesOf(T.cloudDb(), emp2.id)).toHaveLength(1);
  });

  it('a kiosk revoked on the cloud meanwhile has its offline punch rejected and undone', async () => {
    const dev2 = await api().post('/api/hr/clock/kiosk-devices').set(T.cloudHdr()).send({ name: 'Old kiosk' });
    await T.hostRound();
    T.cutOff('host');
    const K = { ...T.hostHdr(), 'X-Kiosk-Token': dev2.body.token as string };
    const code = (await api().get('/api/hr/clock/code').set(K)).body.code as string;
    expect((await api().post('/api/hr/clock/kiosk-punch').set(K).send({ code, employee_no: emp3.employee_no })).status).toBe(200);
    const before = punchesOf(T.hostDb(), emp3.id).length;
    expect(before).toBe(1);
    expect((await api().delete(`/api/hr/clock/kiosk-devices/${dev2.body.id}`).set(T.cloudHdr())).status).toBe(200);
    T.reconnect('host');
    const sync = await T.hostRound();
    expect(sync.pushed).toMatchObject([{ state: 'rejected', response_status: 403 }]);
    expect(punchesOf(T.hostDb(), emp3.id)).toHaveLength(0); // undone on the host too
    expect(punchesOf(T.cloudDb(), emp3.id)).toHaveLength(0);
    // Unlock again for the next tests.
    expect((await api().put('/api/hr/clock/kiosk-lock').set(T.cloudHdr()).send({ enabled: false })).status).toBe(200);
    await T.hostRound();
    await T.lanRound();
  });
});

describe('a phone punch on a borrowed phone, through the site host', () => {
  it('stays flagged "borrowed" once the cloud has it', async () => {
    const s = await api().post('/api/auth/login').set('X-Tenant', T.lanSlug).send({ username: emp.username, password: emp.password, shared: true });
    expect(s.status).toBe(200);
    const P = { Authorization: `Bearer ${s.body.token}`, 'X-Tenant': T.lanSlug };
    await T.lanRound();
    const code = (await api().get('/api/hr/clock/code').set(T.lanHdr())).body.code as string;
    const r = await phonePunch(api(), P, { code });
    expect(r.status).toBe(200);
    await T.lanRound();
    await T.hostRound();
    const last = punchesOf(T.cloudDb(), emp.id).at(-1)!;
    expect(last).toMatchObject({ source: 'phone', device_flag: 'borrowed' });
    // The selfie travelled with it, and the scan's hold is used up on every copy.
    const photo = T.cloudDb().prepare("SELECT file_name FROM punch_photos WHERE punch_kind = 'attendance' AND punch_id = ?").get(last.id) as { file_name: string } | undefined;
    expect(photo).toBeTruthy();
    expect(T.cloudDb().prepare('SELECT COUNT(*) AS n FROM time_punch_holds WHERE employee_id = ?').get(emp.id)).toEqual({ n: 0 });
  });
});

describe('punch photos', () => {
  it('a photo taken at the desk kiosk reaches the host and the cloud under the same name', async () => {
    await T.lanRound();
    const lastPunch = punchesOf(T.lanDb(), emp.id).at(-1)!;
    const r = await api().post(`/api/hr/clock/photo/${lastPunch.id}`).set(T.lanHdr())
      .attach('photo', jpeg('desk-photo'), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(201);
    await T.lanRound();
    await T.hostRound();
    const row = T.cloudDb().prepare("SELECT file_name FROM punch_photos WHERE punch_kind = 'attendance' AND punch_id = ?").get(lastPunch.id) as { file_name: string };
    expect(row.file_name).toBe(`p-attendance-${lastPunch.id}-${String(r.headers['x-sync-command']).toLowerCase()}.jpg`);
    const cloudFile = path.join(T.dbmod.uploadDir('default'), 'kiosk-punches', row.file_name);
    expect(fs.readFileSync(cloudFile)).toEqual(jpeg('desk-photo'));
    expect(fs.existsSync(path.join(T.dbmod.uploadDir(T.hostSlug), 'kiosk-punches', row.file_name))).toBe(true);
  });

  it('a photo added on the website reaches the site PCs', async () => {
    const punch = punchesOf(T.cloudDb(), emp.id)[0]!;
    const r = await api().post(`/api/hr/clock/photo/${punch.id}`).set(T.cloudHdr())
      .attach('photo', jpeg('web-photo'), { filename: 'w.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(201);
    await T.hostRound();
    await T.lanRound();
    const row = T.lanDb().prepare("SELECT file_name FROM punch_photos WHERE punch_kind = 'attendance' AND punch_id = ?").get(punch.id) as { file_name: string };
    expect(fs.readFileSync(path.join(T.dbmod.uploadDir(T.lanSlug), 'kiosk-punches', row.file_name))).toEqual(jpeg('web-photo'));
  });
});

