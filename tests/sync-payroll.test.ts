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
    await ok(a.post('/api/accounting/ledger/setup').set(cloudHdr()).send({fiscal_year_start:'2026-01-01'}),201);
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

it('posts and re-posts payroll offline, then replays the same current journal on the cloud',async()=>{
  T.cutOff('host');const h=T.hostHdr(),label='Offline GL Oct 5-6, 2026';
  const period=(await ok(api().post('/api/hr/periods').set(h).send({label,start_date:'2026-10-05',end_date:'2026-10-06'}),201)).body.id;
  await ok(api().post(`/api/hr/periods/${period}/employees`).set(h).send({employee_id:emp}),201);
  await ok(api().put(`/api/hr/periods/${period}/attendance`).set(h).send({employee_id:emp,days:[{work_date:'2026-10-05',time_in:'08:00',time_out:'17:00',notes:''},{work_date:'2026-10-06',time_in:'08:00',time_out:'17:00',notes:''}]}));
  await ok(api().post(`/api/hr/periods/${period}/generate-payslips`).set(h).send({payroll_period:label,pay_date:'2026-10-07'}),201);
  for(let i=0;i<2;i++)await ok(api().post(`/api/hr/periods/${period}/post-payroll-gl`).set(h).send({payroll_period:label}),201);
  const local=await ok(api().get(`/api/hr/periods/${period}/payroll-reconciliation`).set(h));expect(local.body.ledger.state).toBe('matches');
  T.reconnect('host');const round=await T.hostRound();expect(round.pushed.filter(p=>p.state!=='confirmed')).toEqual([]);
  const cloudId=Number((T.cloudDb().prepare('SELECT id FROM attendance_periods WHERE label=?').get(label) as {id:number}).id);
  const cloud=await ok(api().get(`/api/hr/periods/${cloudId}/payroll-reconciliation`).set(T.cloudHdr()));
  expect(cloud.body.ledger.state).toBe('matches');expect(cloud.body.source).toEqual(local.body.source);
  expect(cloud.body.ledger.expected_debit).toBe(local.body.ledger.expected_debit);
  expect(cloud.body.ledger.actual_debit).toBe(local.body.ledger.actual_debit);
  const journals=(conn:DatabaseSync,id:number)=>conn.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='payroll_run' AND source_id=?").get(id) as {n:number};
  expect(journals(T.hostDb(),period).n).toBe(3);expect(journals(T.cloudDb(),cloudId).n).toBe(3);
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

it('refuses local duplicate release, then retains a valid accepted offline payment with a flagged cloud source clash',async()=>{
  const label='Release source clash 2031';
  const p=(await ok(api().post('/api/hr/periods').set(T.cloudHdr()).send({label,start_date:'2031-02-01',end_date:'2031-02-02'}),201)).body.id;
  await ok(api().post(`/api/hr/periods/${p}/employees`).set(T.cloudHdr()).send({employee_id:emp}),201);
  await ok(api().post(`/api/hr/periods/${p}/generate-payslips`).set(T.cloudHdr()).send({payroll_period:label}),201);
  const cloud=T.cloudDb(),original=cloud.prepare('SELECT * FROM form_records WHERE period=?').get(label) as {id:number;form_def_id:number;data:string};
  const duplicate=()=>Number(cloud.prepare("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,? ,?,'draft',?,1)").run(original.form_def_id,'RELEASE-DUP-'+Date.now(),original.data,label).lastInsertRowid);
  const first=duplicate();await T.hostRound();T.cutOff('host');
  const before=T.hostDb().prepare('SELECT COUNT(*) AS n FROM sync_commands').get()?.n;
  expect((await api().post(`/api/hr/payroll/${original.id}/mark-paid`).set(T.hostHdr()).send({})).status).toBe(409);
  expect(T.hostDb().prepare('SELECT COUNT(*) AS n FROM sync_commands').get()?.n).toBe(before);
  cloud.prepare('DELETE FROM form_records WHERE id=?').run(first);T.reconnect('host');await T.hostRound();T.cutOff('host');
  await ok(api().post(`/api/hr/payroll/${original.id}/mark-paid`).set(T.hostHdr()).send({}));duplicate();
  T.reconnect('host');const round=await T.hostRound();expect(round.pushed.filter(x=>x.state!=='confirmed')).toEqual([]);
  expect(cloud.prepare('SELECT status FROM form_records WHERE id=?').get(original.id)?.status).toBe('paid');
  const clashes=(await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{summary:string}>;
  expect(clashes.some(c=>c.summary.includes(`Payslip #${original.id} paid decision retained with source review required`))).toBe(true);
  expect((await api().post(`/api/hr/payroll/${original.id}/email`).set(T.cloudHdr()).send({})).status).toBe(409);
});
