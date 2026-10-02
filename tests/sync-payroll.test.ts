/**
 * Offline-first sync, phase 4g (docs/OFFLINE-FIRST.md §26): payroll offline. HR at the main site
 * runs a whole cutoff with the internet down — cutoff, roster, attendance grid, payslips, deduction
 * toggles, mark paid — and it reaches the cloud identically. Emailing a payslip needs the cloud's
 * mail server, so it is refused offline. Marking paid on both sides keeps the outcome, flagged (D6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let emp: number;
const api = () => T.ctx.api;

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const payslips = (conn: DatabaseSync, period: string) =>
  (conn.prepare(
    `SELECT fr.id, fr.number, fr.status, fr.data FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fd.slug = 'hr_payroll' AND fr.period = ? ORDER BY fr.id`
  ).all(period) as Array<{ id: number; number: string; status: string; data: string }>)
    .map((r) => ({ id: r.id, number: r.number, status: r.status, net: JSON.parse(r.data).net_pay }));

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    emp = (await a.post('/api/hr/employees').set(cloudHdr()).send({
      employee_no: 'P-001', name: 'Ben Cruz', position: 'Assembler', daily_rate: 700, rate_type: 'daily', status: 'regular',
    })).body.id;
  });
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
  // One cutoff on the cloud first, so the payslip number series is in use (and leasable).
  const p = (await ok(api().post('/api/hr/periods').set(T.cloudHdr()).send({ label: 'Sep 1-2, 2026', start_date: '2026-09-01', end_date: '2026-09-02' }), 201)).body.id;
  await ok(api().post(`/api/hr/periods/${p}/employees`).set(T.cloudHdr()).send({ employee_id: emp }), 201);
  await ok(api().post(`/api/hr/periods/${p}/generate-payslips`).set(T.cloudHdr()).send({ payroll_period: 'Sep 1-2, 2026' }), 201);
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run();
  await T.hostRound();
}, 90_000);
afterAll(() => {
  T?.close();
  cleanup(T.ctx);
});

describe('a payroll cutoff while the internet is down', () => {
  const LABEL = 'Sep 16-17, 2026';
  let slip: number;

  it('runs entirely at the main site', async () => {
    T.cutOff('host');
    const h = T.hostHdr();
    const period = (await ok(api().post('/api/hr/periods').set(h).send({ label: LABEL, start_date: '2026-09-16', end_date: '2026-09-17' }), 201)).body.id;
    await ok(api().post(`/api/hr/periods/${period}/employees`).set(h).send({ employee_id: emp }), 201);
    await ok(api().put(`/api/hr/periods/${period}/attendance`).set(h).send({
      employee_id: emp,
      days: [
        { work_date: '2026-09-16', time_in: '08:00', time_out: '17:00', notes: '' },
        { work_date: '2026-09-17', time_in: '08:00', time_out: '17:00', notes: '' },
      ],
    }));
    const gen = await ok(api().post(`/api/hr/periods/${period}/generate-payslips`).set(h).send({ payroll_period: LABEL, pay_date: '2026-09-18' }), 201);
    expect(gen.body.created).toBe(1);
    slip = payslips(T.hostDb(), LABEL)[0]!.id;
    expect(payslips(T.hostDb(), LABEL)[0]!.number).not.toMatch(/-P\d+-/); // a real number from the block
    await ok(api().put(`/api/hr/payroll/${slip}/deductions`).set(h).send({ sss_applied: false }));
    await ok(api().post(`/api/hr/payroll/${slip}/mark-paid`).set(h).send({}));
    // Emailing it needs the cloud's mail server.
    const mail = await api().post(`/api/hr/payroll/${slip}/email`).set(h).send({});
    expect(mail.status).toBe(503);
  });

  it('reaches the cloud identically', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(payslips(T.cloudDb(), LABEL)).toEqual(payslips(T.hostDb(), LABEL));
    expect(payslips(T.cloudDb(), LABEL)[0]!.status).toBe('paid');
    const attendance = (conn: DatabaseSync) => conn.prepare(
      "SELECT work_date, time_in, time_out FROM attendance_records WHERE employee_id = ? AND work_date LIKE '2026-09-1%' ORDER BY work_date"
    ).all(emp);
    expect(attendance(T.cloudDb())).toEqual(attendance(T.hostDb()));
  });
});

describe('the cloud decided meanwhile (D6)', () => {
  it('a payslip marked paid on both sides stays paid — flagged', async () => {
    const [first] = payslips(T.cloudDb(), 'Sep 1-2, 2026');
    T.cutOff('host');
    await ok(api().post(`/api/hr/payroll/${first!.id}/mark-paid`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/hr/payroll/${first!.id}/mark-paid`).set(T.cloudHdr()).send({}));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(payslips(T.cloudDb(), 'Sep 1-2, 2026')[0]!.status).toBe('paid');
    const clashes = (await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>;
    expect(clashes.some((c) => c.summary.includes(`Payslip #${first!.id} was marked paid on the cloud and at the main site`))).toBe(true);
  });
});
