import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

let ctx: TestContext;
let reporter: { id: number; token: string };
let recipient: { id: number; token: string };
let stranger: { id: number; token: string };
let handler: { id: number; token: string };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
  ctx = await setupApp();
  const admin = await login(ctx.api);
  reporter = await createEmployee(ctx.api, admin);
  recipient = await createEmployee(ctx.api, admin);
  stranger = await createEmployee(ctx.api, admin);
  handler = await createEmployee(ctx.api, admin);
});
afterAll(() => cleanup(ctx));

describe('identified report lifecycle', () => {
  let id: number;
  it('creates a numbered case with evidence and scopes its list and detail', async () => {
    const created = await ctx.api.post('/api/identified-reports').set(auth(reporter.token))
      .field('recipient_id', String(recipient.id)).field('category', 'Safety risk').field('subject', 'Exposed cable')
      .field('description', 'Cable beside packing station').field('incident_date', '2026-10-14')
      .attach('files', Buffer.from('%PDF-1.4\ntest'), { filename: 'proof.pdf', contentType: 'application/pdf' });
    expect(created.status).toBe(201);
    id = created.body.id;
    expect(created.body.number).toMatch(/^IR-\d{6}$/);
    expect(created.body.events).toHaveLength(1);
    expect(created.body.attachments).toHaveLength(1);
    expect((await ctx.api.get('/api/identified-reports').set(auth(reporter.token))).body).toHaveLength(1);
    expect((await ctx.api.get('/api/identified-reports').set(auth(recipient.token))).body).toHaveLength(1);
    expect((await ctx.api.get('/api/identified-reports').set(auth(stranger.token))).body).toHaveLength(0);
    expect((await ctx.api.get(`/api/identified-reports/${id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await ctx.api.get(`/api/identified-reports/${id}/attachments/${created.body.attachments[0].id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await ctx.api.get(`/api/identified-reports/${id}/attachments/${created.body.attachments[0].id}`).set(auth(recipient.token))).status).toBe(200);
    const { queryOne } = await import('../src/shared/db');
    const attachment = queryOne<{ stored_name: string }>('SELECT stored_name FROM identified_report_attachments WHERE report_id = ?', id)!;
    expect(queryOne<{ data: Uint8Array }>('SELECT data FROM durable_uploads WHERE name = ?', attachment.stored_name)?.data).toBeTruthy();
    fs.unlinkSync(path.join(process.env.UPLOAD_DIR!, attachment.stored_name));
    expect((await ctx.api.get(`/api/identified-reports/${id}/attachments/${created.body.attachments[0].id}`).set(auth(recipient.token))).status).toBe(200);
  });
  it('allows the handler to update status and reassign, preserving history', async () => {
    expect((await ctx.api.post(`/api/identified-reports/${id}/status`).set(auth(reporter.token)).send({ status: 'triaged' })).status).toBe(403);
    expect((await ctx.api.post(`/api/identified-reports/${id}/status`).set(auth(recipient.token)).send({ status: 'triaged' })).body.status).toBe('triaged');
    expect((await ctx.api.post(`/api/identified-reports/${id}/assign`).set(auth(recipient.token)).send({ user_id: handler.id })).status).toBe(200);
    expect((await ctx.api.get(`/api/identified-reports/${id}`).set(auth(handler.token))).status).toBe(200);
    expect((await ctx.api.post(`/api/identified-reports/${id}/reply`).set(auth(handler.token)).send({ body: 'We have isolated the area.' })).status).toBe(200);
    const detail = await ctx.api.get(`/api/identified-reports/${id}`).set(auth(reporter.token));
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(['submitted', 'status', 'assigned', 'reply']);
    expect(detail.body.can_handle).toBe(false);
    expect((await ctx.api.get(`/api/identified-reports/${id}`).set(auth(handler.token))).body.can_handle).toBe(true);
    expect((await ctx.api.post(`/api/identified-reports/${id}/status`).set(auth(handler.token)).send({ status: 'closed' })).status).toBe(200);
    expect((await ctx.api.post(`/api/identified-reports/${id}/reply`).set(auth(reporter.token)).send({ body: 'More details' })).status).toBe(409);
  });
});
