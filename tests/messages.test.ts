/** Integration tests: messaging — send, inbox/sent, unread count, mark read, delete. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
let adminId: number;
let alice: { id: number; token: string };

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
  adminId = (await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`)).body.user.id;
  alice = await createEmployee(ctx.api, adminToken, { username: 'alice' });
});
afterAll(() => cleanup(ctx));

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('messages', () => {
  it('sends a message that lands in the recipient inbox', async () => {
    const send = await ctx.api
      .post('/api/messages')
      .set(bearer(adminToken))
      .send({ recipient_id: alice.id, subject: 'Welcome', body: 'Welcome to the team!' });
    expect(send.status).toBe(201);

    const inbox = await ctx.api.get('/api/messages?box=inbox').set(bearer(alice.token));
    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].subject).toBe('Welcome');
    expect(inbox.body[0].other_name).toBe('System Administrator');
  });

  it('shows the message in the sender sent box', async () => {
    const sent = await ctx.api.get('/api/messages?box=sent').set(bearer(adminToken));
    expect(sent.body.some((m: { subject: string }) => m.subject === 'Welcome')).toBe(true);
  });

  it('counts unread and clears it after reading', async () => {
    const before = await ctx.api.get('/api/messages/unread-count').set(bearer(alice.token));
    expect(before.body.count).toBe(1);

    const inbox = await ctx.api.get('/api/messages?box=inbox').set(bearer(alice.token));
    const msgId = inbox.body[0].id;
    await ctx.api.post(`/api/messages/${msgId}/read`).set(bearer(alice.token));

    const after = await ctx.api.get('/api/messages/unread-count').set(bearer(alice.token));
    expect(after.body.count).toBe(0);
  });

  it('rejects messaging yourself', async () => {
    const res = await ctx.api
      .post('/api/messages')
      .set(bearer(adminToken))
      .send({ recipient_id: adminId, body: 'hi me' });
    expect(res.status).toBe(400);
  });

  it('requires a non-empty body (validation)', async () => {
    const res = await ctx.api
      .post('/api/messages')
      .set(bearer(adminToken))
      .send({ recipient_id: alice.id, body: '   ' });
    expect(res.status).toBe(400);
  });

  it('lets the recipient delete a message', async () => {
    await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: alice.id, body: 'to delete' });
    const inbox = await ctx.api.get('/api/messages?box=inbox').set(bearer(alice.token));
    const id = inbox.body[0].id;
    const del = await ctx.api.delete(`/api/messages/${id}`).set(bearer(alice.token));
    expect(del.status).toBe(200);
  });
});

describe('messages: attachments', () => {
  const FILE = Buffer.from('a'.repeat(1000));

  it('sends files with a message, lists and downloads them, and blocks a non-participant', async () => {
    const send = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .field('recipient_id', String(alice.id)).field('body', 'see attached')
      .attach('files', FILE, 'report.txt')
      .attach('files', FILE, 'photo.png');
    expect(send.status).toBe(201);
    expect(send.body.attachments).toBe(2);

    const inbox = await ctx.api.get('/api/messages?box=inbox').set(bearer(alice.token));
    const msg = inbox.body.find((m: { id: number }) => m.id === send.body.id);
    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments[0].name).toBe('report.txt');
    expect(msg.attachments[0].url).toBe(`/messages/${msg.id}/attachments/${msg.attachments[0].id}`);

    const dl = await ctx.api.get(`/api${msg.attachments[0].url}`).set(bearer(alice.token));
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(FILE.toString());

    const stranger = await createEmployee(ctx.api, adminToken, { username: 'dave_stranger' });
    const blocked = await ctx.api.get(`/api${msg.attachments[0].url}`).set(bearer(stranger.token));
    expect(blocked.status).toBe(403);
  });

  it('rejects a file over 10 MB', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    const res = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .field('recipient_id', String(alice.id)).field('body', 'too big')
      .attach('files', big, 'huge.bin');
    expect(res.status).toBe(400);
  });

  it('frees the sender quota when the message is deleted', async () => {
    const before = (await ctx.api.get('/api/messages/quota').set(bearer(adminToken))).body.used_bytes;
    const send = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .field('recipient_id', String(alice.id)).field('body', 'quota check')
      .attach('files', FILE, 'a.txt');
    const mid = send.body.id;
    const after = (await ctx.api.get('/api/messages/quota').set(bearer(adminToken))).body.used_bytes;
    expect(after).toBe(before + FILE.length);

    await ctx.api.delete(`/api/messages/${mid}`).set(bearer(alice.token));
    const final = (await ctx.api.get('/api/messages/quota').set(bearer(adminToken))).body.used_bytes;
    expect(final).toBe(before);
  });
});

describe('messages: RBAC honors per-user overrides', () => {
  it('revoking messages.send via override blocks sending, without touching messages.view', async () => {
    const bob = await createEmployee(ctx.api, adminToken, { username: 'bob_rbac' });
    await ctx.api.put(`/api/users/${bob.id}/permissions`).set(bearer(adminToken))
      .send({ overrides: { 'messages.send': false } });
    const send = await ctx.api.post('/api/messages').set(bearer(bob.token)).send({ recipient_id: alice.id, body: 'blocked' });
    expect(send.status).toBe(403);
    // view was never revoked — inbox should still be reachable
    expect((await ctx.api.get('/api/messages?box=inbox').set(bearer(bob.token))).status).toBe(200);
  });

  it('revoking messages.view via override blocks reading the inbox and unread count', async () => {
    const carol = await createEmployee(ctx.api, adminToken, { username: 'carol_rbac' });
    await ctx.api.put(`/api/users/${carol.id}/permissions`).set(bearer(adminToken))
      .send({ overrides: { 'messages.view': false } });
    expect((await ctx.api.get('/api/messages?box=inbox').set(bearer(carol.token))).status).toBe(403);
    expect((await ctx.api.get('/api/messages/unread-count').set(bearer(carol.token))).status).toBe(403);
  });
});
