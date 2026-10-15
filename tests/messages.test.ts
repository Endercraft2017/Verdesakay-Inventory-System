/** Integration tests: messaging — send, inbox/sent, unread count, mark read, delete. */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// NOTE: intentionally NOT a top-level `import ... from '../src/shared/ws'` — that
// module imports src/shared/db.ts, and a static import runs at file-collection time,
// before beforeAll()/setupApp() gets to set DB_PATH. That ordering bug once pointed
// this file's "isolated" test run at the real db/data.db (see tests/helpers.ts's own
// dynamic-import comment) — attachWebSocket is imported dynamically inside each test
// instead, after setupApp() has already pinned DB_PATH to a throwaway tmp DB.

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

  it('blocks the recipient from unsending a message, but the sender can', async () => {
    const send = await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: alice.id, body: 'to delete' });
    const id = send.body.id;

    const blocked = await ctx.api.delete(`/api/messages/${id}`).set(bearer(alice.token));
    expect(blocked.status).toBe(403);

    const del = await ctx.api.delete(`/api/messages/${id}`).set(bearer(adminToken));
    expect(del.status).toBe(200);

    const thread = await ctx.api.get(`/api/messages/with/${adminId}`).set(bearer(alice.token));
    const removed = thread.body.find((m: { id: number }) => m.id === id);
    expect(removed.deleted_at).toBeTruthy();
    expect(removed.body).toBe('');

    // deleting an already-removed message is a no-op, not a 404
    const again = await ctx.api.delete(`/api/messages/${id}`).set(bearer(adminToken));
    expect(again.status).toBe(200);
  });
});

describe('messages: reply, edit, reactions', () => {
  it('replies nest a preview of the original message', async () => {
    const original = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .send({ recipient_id: alice.id, body: 'original text' });
    const reply = await ctx.api.post('/api/messages').set(bearer(alice.token))
      .send({ recipient_id: adminId, body: 'replying', reply_to_id: original.body.id });
    expect(reply.status).toBe(201);

    const thread = await ctx.api.get(`/api/messages/with/${alice.id}`).set(bearer(adminToken));
    const replyRow = thread.body.find((m: { id: number }) => m.id === reply.body.id);
    expect(replyRow.reply_to).toMatchObject({ id: original.body.id, preview: 'original text' });
  });

  it('rejects a reply_to_id from a different conversation', async () => {
    const dave = await createEmployee(ctx.api, adminToken, { username: 'dave_reply' });
    const foreign = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .send({ recipient_id: dave.id, body: 'not yours' });
    const res = await ctx.api.post('/api/messages').set(bearer(adminToken))
      .send({ recipient_id: alice.id, body: 'bad reply', reply_to_id: foreign.body.id });
    expect(res.status).toBe(400);
  });

  it('lets the sender edit a message but not the recipient', async () => {
    const send = await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: alice.id, body: 'typo' });
    const id = send.body.id;

    const blocked = await ctx.api.patch(`/api/messages/${id}`).set(bearer(alice.token)).send({ body: 'fixed' });
    expect(blocked.status).toBe(403);

    const edit = await ctx.api.patch(`/api/messages/${id}`).set(bearer(adminToken)).send({ body: 'fixed' });
    expect(edit.status).toBe(200);
    expect(edit.body.edited_at).toBeTruthy();

    const thread = await ctx.api.get(`/api/messages/with/${adminId}`).set(bearer(alice.token));
    const row = thread.body.find((m: { id: number }) => m.id === id);
    expect(row.body).toBe('fixed');
    expect(row.edited_at).toBeTruthy();
  });

  it('toggles a reaction off when the same emoji is sent twice, and switches emoji otherwise', async () => {
    const send = await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: alice.id, body: 'react to me' });
    const id = send.body.id;

    const react1 = await ctx.api.post(`/api/messages/${id}/react`).set(bearer(alice.token)).send({ emoji: '👍' });
    expect(react1.status).toBe(200);
    expect(react1.body.reactions).toEqual([{ emoji: '👍', user_id: alice.id }]);

    const react2 = await ctx.api.post(`/api/messages/${id}/react`).set(bearer(alice.token)).send({ emoji: '👍' });
    expect(react2.body.reactions).toEqual([]); // toggled off

    await ctx.api.post(`/api/messages/${id}/react`).set(bearer(alice.token)).send({ emoji: '❤️' });
    const react3 = await ctx.api.post(`/api/messages/${id}/react`).set(bearer(alice.token)).send({ emoji: '😮' });
    expect(react3.body.reactions).toEqual([{ emoji: '😮', user_id: alice.id }]); // still just one row for alice

    const thread = await ctx.api.get(`/api/messages/with/${alice.id}`).set(bearer(adminToken));
    const row = thread.body.find((m: { id: number }) => m.id === id);
    expect(row.reactions).toEqual([{ emoji: '😮', count: 1, mine: false }]);
  });
});

describe('messages: conversations + thread pagination', () => {
  it('lists one row per counterpart with an unread count and last-message preview', async () => {
    const bob = await createEmployee(ctx.api, adminToken, { username: 'bob_convo' });
    await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: bob.id, body: 'hey bob' });

    const convos = await ctx.api.get('/api/messages/conversations').set(bearer(bob.token));
    expect(convos.status).toBe(200);
    const row = convos.body.find((c: { other_id: number }) => c.other_id === adminId);
    expect(row.last_message).toBe('hey bob');
    expect(row.unread_count).toBe(1);
  });

  it('paginates a thread with ?before= and marks it read in bulk', async () => {
    const carol = await createEmployee(ctx.api, adminToken, { username: 'carol_thread' });
    for (let i = 0; i < 5; i++) {
      await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: carol.id, body: `msg ${i}` });
    }
    const page1 = await ctx.api.get(`/api/messages/with/${adminId}?limit=2`).set(bearer(carol.token));
    expect(page1.body).toHaveLength(2);
    const cursor = page1.body[page1.body.length - 1].id;
    const page2 = await ctx.api.get(`/api/messages/with/${adminId}?limit=2&before=${cursor}`).set(bearer(carol.token));
    expect(page2.body.every((m: { id: number }) => m.id < cursor)).toBe(true);

    const readAll = await ctx.api.post(`/api/messages/with/${adminId}/read`).set(bearer(carol.token));
    expect(readAll.body.updated).toBeGreaterThan(0);
    const unread = await ctx.api.get('/api/messages/unread-count').set(bearer(carol.token));
    expect(unread.body.count).toBe(0);
  });
});

describe('messages: link preview SSRF guard', () => {
  it('rejects a loopback/private URL without attempting a fetch', async () => {
    const res = await ctx.api.get('/api/messages/link-preview')
      .query({ url: 'http://127.0.0.1:9/definitely-not-fetched' })
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  it('rejects a non-http(s) scheme', async () => {
    const res = await ctx.api.get('/api/messages/link-preview')
      .query({ url: 'file:///etc/passwd' })
      .set(bearer(adminToken));
    expect(res.status).toBe(400);
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

    await ctx.api.delete(`/api/messages/${mid}`).set(bearer(adminToken));
    const final = (await ctx.api.get('/api/messages/quota').set(bearer(adminToken))).body.used_bytes;
    expect(final).toBe(before);
  });
});

describe('messages: RBAC honors per-user overrides', () => {
  it('revoking messages.send via override blocks sending, without touching messages.view', async () => {
    const bob = await createEmployee(ctx.api, adminToken, { username: 'bob_rbac' });
    await ctx.api.put(`/api/users/${bob.id}/permissions`).set(bearer(adminToken))
      .send({ overrides: { 'messages.send': false } });
    bob.token = await login(ctx.api, bob.username, bob.password);
    const send = await ctx.api.post('/api/messages').set(bearer(bob.token)).send({ recipient_id: alice.id, body: 'blocked' });
    expect(send.status).toBe(403);
    // view was never revoked — inbox should still be reachable
    expect((await ctx.api.get('/api/messages?box=inbox').set(bearer(bob.token))).status).toBe(200);
  });

  it('revoking messages.view via override blocks reading the inbox and unread count', async () => {
    const carol = await createEmployee(ctx.api, adminToken, { username: 'carol_rbac' });
    await ctx.api.put(`/api/users/${carol.id}/permissions`).set(bearer(adminToken))
      .send({ overrides: { 'messages.view': false } });
    carol.token = await login(ctx.api, carol.username, carol.password);
    expect((await ctx.api.get('/api/messages?box=inbox').set(bearer(carol.token))).status).toBe(403);
    expect((await ctx.api.get('/api/messages/unread-count').set(bearer(carol.token))).status).toBe(403);
  });
});

describe('messages: real-time via WebSocket', () => {
  it('pushes message:new to the recipient the moment a message is sent', async () => {
    const { attachWebSocket } = await import('../src/shared/ws');
    const server = http.createServer(ctx.app).listen(0);
    attachWebSocket(server);
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${alice.token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const eventPromise = new Promise<{ type: string; data: { body: string } }>((resolve, reject) => {
        ws.once('message', (raw) => {
          try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
        });
      });

      await ctx.api.post('/api/messages').set(bearer(adminToken)).send({ recipient_id: alice.id, body: 'live push' });

      const event = await eventPromise;
      expect(event.type).toBe('message:new');
      expect(event.data.body).toBe('live push');
    } finally {
      ws.close();
      server.close();
    }
  });

  it('rejects the upgrade for an invalid token', async () => {
    const { attachWebSocket } = await import('../src/shared/ws');
    const server = http.createServer(ctx.app).listen(0);
    attachWebSocket(server);
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws?token=not-a-real-token`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => reject(new Error('should not have connected')));
        ws.once('error', () => resolve()); // a rejected upgrade surfaces as a client error
        ws.once('unexpected-response', () => resolve());
      });
    } finally {
      ws.close();
      server.close();
    }
  });
});
