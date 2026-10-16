/**
 * Offline-first sync, phase 4i (docs/OFFLINE-FIRST.md §28): the core leftovers. At a desk PC on the
 * site LAN with no internet, people chat (with a file), keep personal notes and file bug reports;
 * the main site posts an announcement and adds a department. All of it reaches the cloud. Account
 * administration and password changes are credentials (D8): refused offline, with a clear message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let colleague: number;
const api = () => T.ctx.api;

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    colleague = (await a.post('/api/users').set(cloudHdr()).send({
      username: 'mara', full_name: 'Mara Santos', password: 'Mara-pass-77-test-only', role: 'admin_staff',
    })).body.id;
  });
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
  await T.hostRound();
  await T.lanRound();
}, 90_000);
afterAll(() => {
  T?.close();
  cleanup(T.ctx);
});

describe('everyday work at a desk PC with no internet', () => {
  let msg: number;
  let note: number;
  let noteTask: number;
  let bug: number;
  let announcement: number;
  let dept: number;

  it('chat with a file, notes and bug reports work; the main site posts an announcement', async () => {
    T.cutOff('host');
    const lan = T.lanHdr();
    msg = (await ok(api().post('/api/messages').set(lan).field('recipient_id', String(colleague)).field('body', 'Shipment is in bay 3')
      .attach('files', Buffer.from('packing list'), 'packing.txt'), 201)).body.id;
    note = (await ok(api().post('/api/notes').set(lan).send({ title: 'Reminder', body: 'Count the pallets', checklist: [{ id: 'pallets', text: 'Count pallets', done: false }] }), 201)).body.id;
    noteTask = (await ok(api().post(`/api/notes/${note}/schedule`).set(lan).send({ due_date: '2026-12-01T10:00', remind_at: '2026-12-01T01:00:00.000Z' }))).body.id;
    await ok(api().put(`/api/tasks/${noteTask}`).set(lan).send({ done: true }));
    bug = (await ok(api().post('/api/bug-reports').set(lan).field('title', 'Scanner beeps twice')
      .field('steps_to_reproduce', 'Scan any label').attach('screenshots', Buffer.from('\x89PNG\r\n\x1a\nfake'), { filename: 's.png', contentType: 'image/png' }), 201)).body.id;
    announcement = (await ok(api().post('/api/announcements').set(T.hostHdr()).send({ title: 'Fire drill', body: 'Friday 3 PM' }), 201)).body.id;
    dept = (await ok(api().post('/api/users/departments').set(T.hostHdr()).send({ name: 'Night shift' }), 201)).body.id;
    await T.lanRound();
  });

  it('account administration and password changes need the internet', async () => {
    const add = await api().post('/api/users').set(T.lanHdr()).send({ username: 'nope', full_name: 'Nope', password: 'xxxxxx12-test-only', role: 'admin_staff' });
    expect(add.status).toBe(503);
    expect(add.body.error).toMatch(/internet/i);
    const pw = await api().post('/api/auth/change-password').set(T.lanHdr()).send({ current_password: 'admin123-test-only', new_password: 'admin1234-test-only' });
    expect(pw.status).toBe(503);
  });

  it('reaches the cloud', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    const c = T.cloudDb();
    expect(c.prepare('SELECT body FROM messages WHERE id = ?').get(msg)).toEqual({ body: 'Shipment is in bay 3' });
    const att = c.prepare('SELECT stored_name FROM message_attachments WHERE message_id = ?').get(msg) as { stored_name: string };
    expect(fs.readFileSync(path.join(T.dbmod.uploadDir('default'), att.stored_name), 'utf8')).toBe('packing list');
    expect(c.prepare('SELECT body FROM notes WHERE id = ?').get(note)).toEqual({ body: 'Count the pallets' });
    const linked = c.prepare('SELECT note_id, done FROM tasks WHERE id = ?').get(noteTask);
    expect(linked).toEqual({ note_id: note, done: 1 });
    const list = c.prepare('SELECT checklist FROM notes WHERE id = ?').get(note) as { checklist: string };
    expect(JSON.parse(list.checklist)[0].done).toBe(true);
    expect(c.prepare('SELECT title FROM bug_reports WHERE id = ?').get(bug)).toEqual({ title: 'Scanner beeps twice' });
    expect(c.prepare('SELECT title FROM announcements WHERE id = ?').get(announcement)).toEqual({ title: 'Fire drill' });
    expect(c.prepare('SELECT name FROM departments WHERE id = ?').get(dept)).toEqual({ name: 'Night shift' });
    // The colleague sees the message on the cloud.
    const token = (await ok(api().post('/api/auth/login').send({ username: 'mara', password: 'Mara-pass-77-test-only' }))).body.token;
    const inbox = await ok(api().get('/api/messages/conversations').set('Authorization', `Bearer ${token}`));
    expect(JSON.stringify(inbox.body)).toContain('Shipment is in bay 3');
  });
});

describe('a page load that changes data on a PC (§32)', () => {
  it('is recorded like a write and reaches the cloud — opening a case marks its photos seen', async () => {
    const { jpegWithMetadata } = await import('./image-fixtures');
    const ticket = (await ok(api().post('/api/anonymous-reports/ticket').set(T.cloudHdr()))).body.ticket;
    const filed = (await ok(api().post('/api/anonymous-reports').field('ticket', ticket).field('category', 'Safety risk')
      .field('description', 'Wet floor near the loading dock.')
      .attach('photos', jpegWithMetadata(), { filename: 'floor.jpg', contentType: 'image/jpeg' }), 201)).body;
    const id = (T.cloudDb().prepare('SELECT id FROM anonymous_reports WHERE number = ?').get(filed.number) as { id: number }).id;
    await T.hostRound();
    T.cutOff('host');
    const seen = (conn: import('node:sqlite').DatabaseSync) =>
      conn.prepare('SELECT last_photo_id FROM anonymous_report_handler_seen WHERE report_id = ?').get(id);
    // The handler opens the case at the site host: a GET that writes.
    await ok(api().get(`/api/confidential-reports/${id}`).set(T.hostHdr()));
    expect(seen(T.hostDb())).toBeTruthy();
    const recorded = T.hostDb().prepare("SELECT method, path FROM sync_commands WHERE method = 'GET' AND state = 'local'").all();
    expect(recorded).toEqual([{ method: 'GET', path: `/api/confidential-reports/${id}` }]);
    // A page load that changes nothing records nothing.
    await ok(api().get('/api/inventory').set(T.hostHdr()));
    expect((T.hostDb().prepare("SELECT COUNT(*) AS n FROM sync_commands WHERE method = 'GET'").get() as { n: number }).n).toBe(1);
    expect(seen(T.cloudDb())).toBeUndefined();
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(seen(T.cloudDb())).toEqual(seen(T.hostDb()));
  });
});
