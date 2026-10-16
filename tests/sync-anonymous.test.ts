/**
 * Offline-first sync, phase 4f (docs/OFFLINE-FIRST.md §7.5, §25): confidential (anonymous) reports
 * offline. A report filed at a desk PC while the site has no internet keeps its anonymity through
 * sync: the command has no user, device, PC or time; the ticket and access code never leave the
 * PC (only the code's hash travels); photos travel metadata-stripped; it is held before being
 * sent; and it gets its real number on the cloud while the provisional one keeps working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';
import { jpegWithMetadata, SECRET } from './image-fixtures';

let T: SiteTrio;
let lanToken = '';
const api = () => T.ctx.api;
const R = '/api/anonymous-reports';

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const anonCommands = (conn: DatabaseSync) =>
  conn.prepare('SELECT * FROM sync_commands WHERE unattributed = 1 ORDER BY rowid').all() as Array<Record<string, unknown>>;
const reportByNumber = (conn: DatabaseSync, n: string) =>
  conn.prepare('SELECT r.* FROM anonymous_reports r WHERE r.number = ? OR r.id = (SELECT report_id FROM anonymous_report_aliases WHERE alias = ?)').get(n, n) as
    { id: number; number: string; created_on: string; description: string } | undefined;
/** Let every held anonymous command go on the next round. */
const releaseHeld = (conn: DatabaseSync) => conn.prepare("UPDATE sync_commands SET release_after = '2000-01-01T00:00:00.000Z' WHERE unattributed = 1").run();

beforeAll(async () => {
  T = await setupSiteTrio();
  lanToken = (await ok(api().post('/api/auth/login').set('X-Tenant', T.lanSlug).send({ username: 'admin', password: 'admin123-test-only' }))).body.token;
});
afterAll(() => {
  delete process.env.SYNC_ANON_DELAY_MIN_MIN;
  delete process.env.SYNC_ANON_DELAY_MAX_MIN;
  T.close();
  cleanup(T.ctx);
});

describe('a confidential report filed at a desk PC with no internet', () => {
  let filed: { number: string; access_code: string };
  let finalNumber: string;

  it('is accepted on the PC with a provisional number that gives nothing away', async () => {
    T.cutOff('host');
    const ticket = (await ok(api().post(`${R}/ticket`).set({ Authorization: `Bearer ${lanToken}`, 'X-Tenant': T.lanSlug }))).body.ticket;
    filed = (await ok(api().post(R).set('X-Tenant', T.lanSlug)
      .field('ticket', ticket).field('category', 'Harassment or misconduct').field('description', 'Something happened on the night shift.')
      .attach('photos', jpegWithMetadata(), { filename: 'IMG_2041.jpg', contentType: 'image/jpeg' }), 201)).body;
    expect(filed.number).toMatch(/^CR-X[0-9A-F]{8}$/);
    // The reporter can follow it up on the PC straight away.
    const look = await ok(api().post(`${R}/lookup`).set('X-Tenant', T.lanSlug).send({ number: filed.number, access_code: filed.access_code }));
    expect(look.body.photo_count).toBe(1);
  });

  it('records a command with no identity, no ticket, no access code and only the stripped photo', () => {
    const [cmd] = anonCommands(T.lanDb());
    expect(cmd).toMatchObject({ actor_user_id: null, device_id: null, node_no: null, node_seq: null, hlc: null, occurred_at: null, context: null });
    const body = String(cmd!.body);
    expect(body).not.toContain(filed.access_code);
    expect(body).not.toMatch(/"ticket"/);
    expect(body).toContain('access_hash');
    expect(body).not.toContain('IMG_2041'); // the original file name is gone too
    expect(String(cmd!.release_after) > new Date().toISOString()).toBe(true); // held for a while
  });

  it('is held back from the host on the next round', async () => {
    await T.lanRound();
    expect(anonCommands(T.hostDb())).toHaveLength(0);
  });

  it('once released, reaches the cloud with a real number; the provisional one keeps working', async () => {
    releaseHeld(T.lanDb());
    await T.lanRound();
    expect(reportByNumber(T.hostDb(), filed.number)).toBeTruthy(); // still provisional at the host
    T.reconnect('host');
    await T.hostRound();
    const onCloud = reportByNumber(T.cloudDb(), filed.number)!;
    expect(onCloud.number).toMatch(/^CR-\d{5}$/);
    expect(onCloud.created_on).toBe(new Date().toISOString().slice(0, 10)); // the day it was filed, no time
    finalNumber = onCloud.number;
    // The cloud's copy of the command carries no identity either.
    expect(anonCommands(T.cloudDb()).every((c) => c.actor_user_id == null && c.node_no == null)).toBe(true);
    // The stored photo is the stripped one.
    const photo = T.cloudDb().prepare('SELECT data FROM anonymous_report_attachments WHERE report_id = ?').get(onCloud.id) as { data: Uint8Array };
    expect(Buffer.from(photo.data).toString('latin1')).not.toContain(SECRET);
    // Either number opens the report, online.
    for (const number of [filed.number, finalNumber]) {
      const r = await ok(api().post(`${R}/lookup`).send({ number, access_code: filed.access_code }));
      expect(r.body.number).toBe(finalNumber);
    }
  });

  it('a follow-up from the PC with the provisional number reaches the case', async () => {
    await T.hostRound();
    await T.lanRound(); // the PC now holds the cloud's version of the report
    expect(reportByNumber(T.lanDb(), filed.number)!.number).toBe(finalNumber);
    await ok(api().post(`${R}/followup`).set('X-Tenant', T.lanSlug)
      .send({ number: filed.number, access_code: filed.access_code, body: 'One more detail.' }), 201);
    releaseHeld(T.lanDb());
    await T.lanRound();
    await T.hostRound();
    const msgs = T.cloudDb().prepare(
      "SELECT body FROM anonymous_report_messages WHERE author = 'reporter' AND report_id = ?"
    ).all(reportByNumber(T.cloudDb(), finalNumber)!.id);
    expect(msgs).toEqual([{ body: 'One more detail.' }]);
    for (const conn of [T.lanDb(), T.hostDb(), T.cloudDb()]) {
      for (const c of anonCommands(conn)) expect(String(c.body)).not.toContain(filed.access_code);
    }
  });

  it('a case handler at the main site replies offline; the reporter sees it', async () => {
    await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
    await T.hostRound();
    const id = reportByNumber(T.hostDb(), finalNumber)!.id;
    T.cutOff('host');
    await ok(api().post(`/api/confidential-reports/${id}/reply`).set(T.hostHdr()).send({ body: 'Thank you, we are looking into it.' }), 201);
    await ok(api().post(`/api/confidential-reports/${id}/status`).set(T.hostHdr()).send({ status: 'investigating' }));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    const look = await ok(api().post(`${R}/lookup`).send({ number: finalNumber, access_code: filed.access_code }));
    expect(look.body.status).toBe('investigating');
    expect(look.body.messages.map((m: { author: string }) => m.author)).toEqual(['reporter', 'handler']);
  });
});

describe('holding', () => {
  it('each anonymous command is held at least as long as the one before it', async () => {
    process.env.SYNC_ANON_DELAY_MIN_MIN = '30';
    process.env.SYNC_ANON_DELAY_MAX_MIN = '90';
    const hdr = { Authorization: `Bearer ${lanToken}`, 'X-Tenant': T.lanSlug };
    for (let i = 0; i < 3; i++) {
      const ticket = (await ok(api().post(`${R}/ticket`).set(hdr))).body.ticket;
      await ok(api().post(R).set('X-Tenant', T.lanSlug).field('ticket', ticket).field('category', 'Safety risk')
        .field('description', `Loose railing on stairwell ${i}.`), 201);
    }
    const held = (T.lanDb().prepare("SELECT release_after FROM sync_commands WHERE unattributed = 1 AND state = 'local' ORDER BY rowid").all() as Array<{ release_after: string }>)
      .map((r) => r.release_after);
    expect(held).toHaveLength(3);
    expect([...held].sort()).toEqual(held);
    expect(Date.parse(held[0]!) - Date.now()).toBeGreaterThan(29 * 60_000);
  });
});
