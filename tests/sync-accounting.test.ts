/**
 * Offline-first sync, phase 4h (docs/OFFLINE-FIRST.md §27): accounting offline. The books are kept
 * at the main site: with the internet down it enters and posts journal entries (JV numbers from
 * its block), records petty cash and closes a period, and all of it reaches the cloud identically.
 * Posting into a period the cloud closed meanwhile stays refused (an accounting control); posting
 * or closing what the cloud already posted / closed keeps the outcome, flagged (D6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let cash: number;
let sales: number;
const api = () => T.ctx.api;
type H = Record<string, string>;

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const entryOf = (conn: DatabaseSync, id: number) =>
  conn.prepare('SELECT number, status, entry_date FROM journal_entries WHERE id = ?').get(id);
const draft = async (hdr: H, date: string, amount: number) =>
  (await ok(api().post('/api/accounting/ledger/journal-entries').set(hdr).send({
    entry_date: date, memo: 'Cash sale',
    lines: [{ account_id: cash, debit: amount }, { account_id: sales, credit: amount }],
  }), 201)).body as { id: number; number: string };
const clashes = async () =>
  ((await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>).map((c) => c.summary);

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    await a.post('/api/accounting/ledger/setup').set(cloudHdr()).send({ fiscal_year_start: '2026-01-01' });
  });
  const accs = (await ok(api().get('/api/accounting/ledger/accounts').set(T.cloudHdr()))).body as Array<{ id: number; code: string }>;
  cash = accs.find((a) => a.code === '1110')!.id;
  sales = accs.find((a) => a.code === '4100')!.id;
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
  await draft(T.cloudHdr(), '2026-02-01', 100); // the JV series is now in use (and leasable)
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run();
  await T.hostRound();
}, 90_000);
afterAll(() => {
  T?.close();
  cleanup(T.ctx);
});

describe('the books while the internet is down', () => {
  let je: { id: number; number: string };
  let period: number;
  let fund: number;

  it('the main site enters and posts, records petty cash and closes a period', async () => {
    T.cutOff('host');
    const h = T.hostHdr();
    je = await draft(h, '2026-03-10', 2500);
    expect(je.number).toMatch(/^JV-\d{6}$/); // a real number from the host's block
    await ok(api().post(`/api/accounting/ledger/journal-entries/${je.id}/post`).set(h).send({}));
    fund = (await ok(api().post('/api/accounting/petty-cash/funds').set(h).send({ name: 'Site box', custodian: 'Lia', opening_balance: 3000 }), 201)).body.id;
    await ok(api().post(`/api/accounting/petty-cash/funds/${fund}/entries`).set(h)
      .send({ entry_date: '2026-03-11', direction: 'out', amount: 400, category: 'Transport' }), 201);
    period = (await ok(api().post('/api/accounting/ledger/periods').set(h).send({ name: 'Feb 2026', start_date: '2026-02-01', end_date: '2026-02-28' }), 201)).body.id;
    await ok(api().post(`/api/accounting/ledger/periods/${period}/close`).set(h).send({}));
  });

  it('reaches the cloud identically', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(entryOf(T.cloudDb(), je.id)).toEqual({ number: je.number, status: 'posted', entry_date: '2026-03-10' });
    const reg = await ok(api().get(`/api/accounting/petty-cash/funds/${fund}/entries`).set(T.cloudHdr()));
    expect(reg.body.closing_balance).toBe(2600);
    expect(T.cloudDb().prepare('SELECT status FROM accounting_periods WHERE id = ?').get(period)).toEqual({ status: 'closed' });
    const tb = await ok(api().get('/api/accounting/ledger/reports/trial-balance').set(T.cloudHdr()));
    expect(tb.body.balanced).toBe(true);
  });
});

describe('the cloud changed meanwhile', () => {
  it('posting into a period the cloud closed meanwhile is refused — an accounting control, not a clash', async () => {
    const e = await draft(T.cloudHdr(), '2026-04-15', 50);
    const p = (await ok(api().post('/api/accounting/ledger/periods').set(T.cloudHdr()).send({ name: 'Apr 2026', start_date: '2026-04-01', end_date: '2026-04-30' }), 201)).body.id;
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/accounting/ledger/journal-entries/${e.id}/post`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/accounting/ledger/periods/${p}/close`).set(T.cloudHdr()).send({}));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed).toMatchObject([{ state: 'rejected' }]);
    expect(entryOf(T.cloudDb(), e.id)).toMatchObject({ status: 'draft' });
    expect(entryOf(T.hostDb(), e.id)).toMatchObject({ status: 'draft' }); // the site's copy follows the cloud
  });

  it('an entry posted on both sides stays posted — flagged (D6)', async () => {
    const e = await draft(T.cloudHdr(), '2026-05-02', 75);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/accounting/ledger/journal-entries/${e.id}/post`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/accounting/ledger/journal-entries/${e.id}/post`).set(T.cloudHdr()).send({}));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect((await clashes()).some((c) => c.includes(`Journal entry ${e.number} was posted on the cloud and at the main site`))).toBe(true);
  });
});
