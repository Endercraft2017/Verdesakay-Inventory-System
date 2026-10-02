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
      username: 'mara', full_name: 'Mara Santos', password: 'Mara-pass-77', role: 'admin_staff',
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
  let bug: number;
  let announcement: number;
  let dept: number;

  it('chat with a file, notes and bug reports work; the main site posts an announcement', async () => {
    T.cutOff('host');
    const lan = T.lanHdr();
    msg = (await ok(api().post('/api/messages').set(lan).field('recipient_id', String(colleague)).field('body', 'Shipment is in bay 3')
      .attach('files', Buffer.from('packing list'), 'packing.txt'), 201)).body.id;
    note = (await ok(api().post('/api/notes').set(lan).send({ title: 'Reminder', body: 'Count the pallets' }), 201)).body.id;
    bug = (await ok(api().post('/api/bug-reports').set(lan).field('title', 'Scanner beeps twice')
      .field('steps_to_reproduce', 'Scan any label').attach('screenshots', Buffer.from('\x89PNG\r\n\x1a\nfake'), { filename: 's.png', contentType: 'image/png' }), 201)).body.id;
    announcement = (await ok(api().post('/api/announcements').set(T.hostHdr()).send({ title: 'Fire drill', body: 'Friday 3 PM' }), 201)).body.id;
    dept = (await ok(api().post('/api/users/departments').set(T.hostHdr()).send({ name: 'Night shift' }), 201)).body.id;
    await T.lanRound();
  });

  it('account administration and password changes need the internet', async () => {
    const add = await api().post('/api/users').set(T.lanHdr()).send({ username: 'nope', full_name: 'Nope', password: 'xxxxxx1', role: 'admin_staff' });
    expect(add.status).toBe(503);
    expect(add.body.error).toMatch(/internet/i);
    const pw = await api().post('/api/auth/change-password').set(T.lanHdr()).send({ current_password: 'admin123', new_password: 'admin1234' });
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
    expect(c.prepare('SELECT title FROM bug_reports WHERE id = ?').get(bug)).toEqual({ title: 'Scanner beeps twice' });
    expect(c.prepare('SELECT title FROM announcements WHERE id = ?').get(announcement)).toEqual({ title: 'Fire drill' });
    expect(c.prepare('SELECT name FROM departments WHERE id = ?').get(dept)).toEqual({ name: 'Night shift' });
    // The colleague sees the message on the cloud.
    const token = (await ok(api().post('/api/auth/login').send({ username: 'mara', password: 'Mara-pass-77' }))).body.token;
    const inbox = await ok(api().get('/api/messages/conversations').set('Authorization', `Bearer ${token}`));
    expect(JSON.stringify(inbox.body)).toContain('Shipment is in bay 3');
  });
});
