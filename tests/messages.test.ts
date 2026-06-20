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
