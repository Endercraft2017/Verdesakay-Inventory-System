import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext, token: string, other: string;
const hdr = (t = token) => ({ Authorization: `Bearer ${t}` });
beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); other = (await createEmployee(ctx.api, token)).token; });
afterAll(() => cleanup(ctx));
const items = [{ id: 'one', text: 'Review attendance', done: false }, { id: 'two', text: 'Prepare payroll', done: false }];
async function make() { const r = await ctx.api.post('/api/notes').set(hdr()).send({ title: 'Payroll checklist', body: '', checklist: items }); expect(r.status).toBe(201); return r.body.id; }
it('persists checklist-only notes and rejects empty or duplicate checklist items', async () => {
  const id = await make(); const n = (await ctx.api.get('/api/notes').set(hdr())).body.find((n: any) => n.id === id);
  expect(n.checklist).toEqual(items);
  expect((await ctx.api.post('/api/notes').set(hdr()).send({ body: '', checklist: [] })).status).toBe(400);
  expect((await ctx.api.post('/api/notes').set(hdr()).send({ checklist: [items[0], items[0]] })).status).toBe(400);
});
it('reschedules one linked task, mirrors note edits, and synchronizes checklist completion both ways', async () => {
  const id = await make(); const schedule = { due_date: '2026-11-04T09:00', remind_at: '2026-11-04T00:30:00.000Z' };
  const task = await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send(schedule); expect(task.status).toBe(200);
  const again = await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send({ ...schedule, due_date: '2026-11-05T10:00' }); expect(again.body.id).toBe(task.body.id);
  let tasks = (await ctx.api.get('/api/tasks').set(hdr())).body.filter((t: any) => t.note_id === id); expect(tasks).toHaveLength(1); expect(tasks[0].due_date).toBe('2026-11-05 10:00');
  expect((await ctx.api.put(`/api/notes/${id}`).set(hdr()).send({ title: 'Updated payroll', body: 'Some context', checklist: items.map(i => ({ ...i, done: true })) })).status).toBe(200);
  let t = (await ctx.api.get('/api/tasks').set(hdr())).body.find((t: any) => t.id === task.body.id); expect(t.done).toBe(1); expect(t.title).toBe('Updated payroll'); expect(t.notes).toContain('[x] Prepare payroll');
  await ctx.api.put(`/api/tasks/${t.id}`).set(hdr()).send({ done: false });
  let n = (await ctx.api.get('/api/notes').set(hdr())).body.find((n: any) => n.id === id); expect(n.checklist.filter((i: any) => i.done)).toHaveLength(1);
  await ctx.api.put(`/api/tasks/${t.id}`).set(hdr()).send({ done: true });
  n = (await ctx.api.get('/api/notes').set(hdr())).body.find((n: any) => n.id === id); expect(n.checklist.every((i: any) => i.done)).toBe(true);
  // Removing a note preserves the independent scheduled task and its captured context.
  await ctx.api.delete(`/api/notes/${id}`).set(hdr());
  t = (await ctx.api.get('/api/tasks').set(hdr())).body.find((t: any) => t.id === task.body.id); expect(t.note_id).toBeNull(); expect(t.title).toBe('Updated payroll');
});
it('scopes notes and scheduling to their owner and validates calendar/time values', async () => {
  const id = await make();
  expect((await ctx.api.get('/api/notes').set(hdr(other))).body.some((n: any) => n.id === id)).toBe(false);
  for (const action of [ctx.api.post(`/api/notes/${id}/schedule`).send({ due_date: '2026-11-01' }), ctx.api.put(`/api/notes/${id}`).send({ body: 'changed' }), ctx.api.delete(`/api/notes/${id}`)]) expect((await action.set(hdr(other))).status).toBe(404);
  for (const due_date of ['2026-02-30', '2026-11-01T99:99', 'tomorrow']) expect((await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send({ due_date })).status).toBe(400);
  expect((await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send({ due_date: '2026-11-01', remind_at: 'banana' })).status).toBe(400);
});
it('old note edits preserve checklist progress and scheduled reminders fire once using UTC instants', async () => {
  const id = await make(); await ctx.api.put(`/api/notes/${id}`).set(hdr()).send({ body: 'Legacy editor' });
  expect((await ctx.api.get('/api/notes').set(hdr())).body.find((n: any) => n.id === id).checklist).toEqual(items);
  const r = await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send({ due_date: '2026-11-01', remind_at: new Date(Date.now() - 60000).toISOString() });
  const { sendDueTaskReminders } = await import('../src/shared/push'); const { queryOne } = await import('../src/shared/db');
  await sendDueTaskReminders(); expect(queryOne<any>('SELECT remind_sent FROM tasks WHERE id = ?', r.body.id).remind_sent).toBe(1);
  await ctx.api.post(`/api/notes/${id}/schedule`).set(hdr()).send({ due_date: '2026-11-01', remind_at: (await ctx.api.get('/api/tasks').set(hdr())).body.find((t: any) => t.id === r.body.id).remind_at });
  expect(queryOne<any>('SELECT remind_sent FROM tasks WHERE id = ?', r.body.id).remind_sent).toBe(1);
  const count = queryOne<any>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Reminder'").n;
  await sendDueTaskReminders(); expect(queryOne<any>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Reminder'").n).toBe(count);
});
