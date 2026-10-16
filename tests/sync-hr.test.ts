/**
 * Offline-first sync, phase 4e (docs/OFFLINE-FIRST.md §24): HR requests and records offline. An
 * employee at a desk PC files a leave request, a time fix and a contact change while the site has
 * no internet; HR approves at the main site; an HR record (a new hire + a 201 document) is kept
 * there too. All of it reaches the cloud identically, and the re-authentication password never
 * leaves the PC. Decisions the cloud made meanwhile keep the first outcome, and a leave approval
 * the cloud's balance no longer covers stands — both flagged (D6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let leaveForm: number;
let worker: { userId: number; empId: number; username: string; password: string };
let lanWorkerToken = '';
const api = () => T.ctx.api;
const PASSWORD = 'Shift-secret-91'; // gitleaks:allow -- synthetic push fixture, not a credential

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const workerOnLan = () => ({ Authorization: `Bearer ${lanWorkerToken}`, 'X-Tenant': T.lanSlug });
const recordOf = (conn: DatabaseSync, id: number) =>
  conn.prepare('SELECT number, status FROM form_records WHERE id = ?').get(id) as { number: string; status: string } | undefined;
const leaveUsed = (conn: DatabaseSync) =>
  (conn.prepare('SELECT leave_days_used FROM employees WHERE id = ?').get(worker.empId) as { leave_days_used: number }).leave_days_used;
const clashes = async () =>
  ((await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>).map((c) => c.summary);
/** Leave filed by the worker (on the cloud unless `hdr` says otherwise). */
let leaveDateSequence = 0;
const fileLeave = async (days: number, hdr: Record<string, string> | null = null) => {
  const headers = hdr ?? { Authorization: `Bearer ${cloudWorkerToken}` };
  const first = new Date(Date.UTC(2026, 5, 1 + (++leaveDateSequence)*20));
  const last = new Date(first); last.setUTCDate(last.getUTCDate()+13);
  const preview = await ok(api().post('/api/me/leave-preview').set(headers).send({ date_from: first.toISOString().slice(0,10), date_to: last.toISOString().slice(0,10) }));
  const dates = preview.body.working_dates.slice(0, days);
  return (await ok(api().post('/api/form-records').set(headers)
    .send({ form_def_id: leaveForm, data: { employee_name: 'Rosa Diaz', with_pay: 'Yes', days, leave_dates: dates.join(','), reason: 'Reviewed leave' }, status: 'pending' }), 201)).body as { id: number; number: string };
};
let cloudWorkerToken = '';

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    leaveForm = (await a.post('/api/form-definitions').set(cloudHdr()).send({
      name: 'Leave Request', slug: 'leave_request', number_prefix: 'LV', icon: 'calendar', scope: 'hr',
      fields: [
        { key: 'employee_name', label: 'Employee Name', type: 'text', required: true, options: [], default: '' },
        { key: 'with_pay', label: 'With Pay?', type: 'select', required: true, options: ['Yes', 'No'], default: '' },
        { key: 'days', label: 'Days', type: 'number', required: false, options: [], default: '1' },
      ],
    })).body.id;
    const user = (await a.post('/api/users').set(cloudHdr()).send({
      username: 'rosa', full_name: 'Rosa Diaz', password: PASSWORD, role: 'admin_staff',
    })).body.id as number;
    const emp = (await a.post('/api/hr/employees').set(cloudHdr()).send({
      employee_no: 'E-100', name: 'Rosa Diaz', user_id: user, daily_rate: 600, rate_type: 'daily',
      status: 'regular', leave_days_per_year: 5,
    })).body.id as number;
    worker = { userId: user, empId: emp, username: 'rosa', password: PASSWORD };
    cloudWorkerToken = (await a.post('/api/auth/login').send({ username: 'rosa', password: PASSWORD })).body.token;
  });
  // HR decides at the main site: the host.
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
  await fileLeave(1); // the LV number series is now in use (and leasable)
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run();
  await T.hostRound();
  await T.lanRound();
  lanWorkerToken = (await ok(api().post('/api/auth/login').set('X-Tenant', T.lanSlug).send({ username: 'rosa', password: PASSWORD }))).body.token;
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('HR while the site has no internet', () => {
  let leave: { id: number; number: string };
  let fix: number;
  let hire: number;
  let docName: string;

  it('an employee files a leave request, a time fix and a contact change at a desk PC', async () => {
    T.cutOff('host'); // the site is offline; the desk PC still reaches its host
    leave = await fileLeave(2, workerOnLan());
    fix = (await ok(api().post('/api/me/time-corrections').set(workerOnLan())
      .send({ work_date: '2026-10-01', requested_in: '08:00', reason: 'Forgot to punch in' }), 201)).body.id;
    await ok(api().put('/api/me/profile').set(workerOnLan()).send({ current_password: PASSWORD, preferred_name: 'Ro' }));
    // A wrong password is still refused on the PC.
    expect((await api().put('/api/me/profile').set(workerOnLan()).send({ current_password: 'nope', preferred_name: 'X' })).status).toBe(400);
    await T.lanRound();
    expect(recordOf(T.hostDb(), leave.id)!.number).toMatch(/^LV-\d{5}$/); // a real number at the host
  });

  it('HR approves at the main site and keeps a new hire\'s 201 file there', async () => {
    await ok(api().post(`/api/me/approvals/requests/${leave.id}/decide`).set(T.hostHdr()).send({ decision: 'approved' }));
    await ok(api().post(`/api/me/approvals/time-corrections/${fix}/decide`).set(T.hostHdr()).send({ decision: 'approved' }));
    hire = (await ok(api().post('/api/hr/employees').set(T.hostHdr()).send({
      employee_no: 'E-200', name: 'New Hire', daily_rate: 550, rate_type: 'daily', status: 'probationary',
    }), 201)).body.id;
    const doc = await ok(api().post(`/api/hr/employees/${hire}/documents`).set(T.hostHdr())
      .field('title', 'Signed contract').attach('file', Buffer.from('contract-bytes'), 'contract.pdf'), 201);
    docName = (T.hostDb().prepare('SELECT stored_name FROM employee_documents WHERE id = ?').get(doc.body.id) as { stored_name: string }).stored_name;
  });

  it('reaches the cloud identically; the password never left the PC', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(leave.number).toMatch(new RegExp(`^LV-P${T.lanNo}-`)); // the desk PC's provisional number…
    expect(recordOf(T.cloudDb(), leave.id)).toEqual({ number: recordOf(T.hostDb(), leave.id)!.number, status: 'approved' }); // …replaced at the host
    expect(leaveUsed(T.cloudDb())).toBe(2);
    expect(T.cloudDb().prepare('SELECT status FROM time_corrections WHERE id = ?').get(fix)).toEqual({ status: 'approved' });
    expect(T.cloudDb().prepare('SELECT preferred_name FROM employee_profiles WHERE employee_id = ?').get(worker.empId)).toEqual({ preferred_name: 'Ro' });
    expect(T.cloudDb().prepare('SELECT name FROM employees WHERE id = ?').get(hire)).toEqual({ name: 'New Hire' });
    expect(fs.readFileSync(path.join(T.dbmod.uploadDir('default'), docName), 'utf8')).toBe('contract-bytes');
    for (const conn of [T.lanDb(), T.hostDb(), T.cloudDb()]) {
      const bodies = conn.prepare("SELECT body FROM sync_commands WHERE path LIKE '/api/me/profile%'").all() as Array<{ body: string }>;
      for (const b of bodies) expect(b.body).not.toContain(PASSWORD);
    }
    await T.lanRound();
    expect(recordOf(T.lanDb(), leave.id)).toEqual(recordOf(T.cloudDb(), leave.id));
    const history=(conn:ReturnType<typeof T.cloudDb>)=>conn.prepare('SELECT revision,data,status,changed_by,changed_by_name,reason,source,created_at FROM form_record_revisions WHERE record_id=? ORDER BY revision').all(leave.id);
    expect(history(T.cloudDb()).length).toBeGreaterThan(1);
    expect(history(T.hostDb())).toEqual(history(T.cloudDb()));
    expect(history(T.lanDb())).toEqual(history(T.cloudDb()));
  });
});

describe('the cloud decided meanwhile (D6)', () => {
  it('a request decided on both sides keeps the cloud\'s first outcome — flagged', async () => {
    const r1 = await fileLeave(1);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/me/approvals/requests/${r1.id}/decide`).set(T.hostHdr()).send({ decision: 'approved' }));
    await ok(api().post(`/api/me/approvals/requests/${r1.id}/decide`).set(T.cloudHdr()).send({ decision: 'rejected', note: 'Peak week' }));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(recordOf(T.cloudDb(), r1.id)!.status).toBe('rejected');
    expect(recordOf(T.hostDb(), r1.id)!.status).toBe('rejected');
    expect((await clashes()).some((c) => c.includes(`#${r1.id} was already rejected on the cloud`))).toBe(true);
  });

  it('a leave approval the cloud\'s balance no longer covers stands, below zero — flagged', async () => {
    // 5 a year, 2 used: 3 left. One 3-day request is approved at the site, another online.
    const atSite = await fileLeave(3);
    const online = await fileLeave(3);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/me/approvals/requests/${atSite.id}/decide`).set(T.hostHdr()).send({ decision: 'approved' }));
    await ok(api().post(`/api/me/approvals/requests/${online.id}/decide`).set(T.cloudHdr()).send({ decision: 'approved' }));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(recordOf(T.cloudDb(), atSite.id)!.status).toBe('approved');
    expect(leaveUsed(T.cloudDb())).toBe(8); // 2 + 3 + 3 of 5
    expect((await clashes()).some((c) => c.includes(`Leave request #${atSite.id} was approved at the main site`))).toBe(true);
  });
});
