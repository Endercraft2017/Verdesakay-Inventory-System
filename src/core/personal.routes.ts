/** Personal tools: per-user notes, tasks (scheduler), and bookmarks.
    Every query is scoped to req.user!.id so users never see each other's data.
    Uses the typed query builder (src/shared/qb.ts): column names and row types are checked
    against the generated schema types. */
import { Router } from 'express';
import { requireAuth } from '../shared/auth';
import { qb, all, first, exec, sql } from '../shared/qb';
import { parseBody, noteSchema, taskSchema, updateTaskSchema, bookmarkSchema } from '../shared/validation';
import { syncClass } from '../sync';
import { db } from '../shared/db';
import { scheduleNoteSchema } from '../shared/validation';
import mobileQuickActions from './mobile-quick-actions.routes';
type CheckItem = { id: string; text: string; done: boolean };
function atomic<T>(fn: () => T): T {
  db.exec('SAVEPOINT personal_note');
  try { const result = fn(); db.exec('RELEASE personal_note'); return result; }
  catch (e) { db.exec('ROLLBACK TO personal_note; RELEASE personal_note'); throw e; }
}
function checklist(raw: string): CheckItem[] { try { return JSON.parse(raw); } catch { return []; } }
function linkedTask(note: { title: string | null; body: string; checklist: string }) {
  const items = checklist(note.checklist);
  return { title: (note.title || note.body.split('\n')[0] || 'Checklist').slice(0, 300), notes: (note.body + (items.length ? '\n' + items.map(i => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n') : '')).slice(0, 2000), ...(items.length ? { done: items.every(i => i.done) ? 1 : 0 } : {}) };
}

const router = Router();
router.use(requireAuth);
router.use('/mobile/quick-actions', mobileQuickActions);

/* ---------------- Notes ---------------- */
router.get('/notes', (req, res) => {
  const tasks = all(qb.selectFrom('tasks').selectAll().where('user_id', '=', req.user!.id));
  res.json(all(qb.selectFrom('notes').selectAll().where('user_id', '=', req.user!.id).orderBy('updated_at', 'desc'))
    .map(n => ({ ...n, checklist: checklist(n.checklist), scheduled_task: tasks.find(t => t.note_id === n.id) || null })));
});
router.post('/notes', syncClass('merge'), (req, res) => {
  const input = parseBody(noteSchema, req.body);
  const info = exec(qb.insertInto('notes').values({ user_id: req.user!.id, title: input.title ?? null, body: input.body, checklist: JSON.stringify(input.checklist || []) }));
  res.status(201).json({ id: info.lastInsertRowid });
});
router.put('/notes/:id', syncClass('merge'), (req, res) => {
  const existing = first(qb.selectFrom('notes').selectAll().where('id', '=', Number(req.params.id)).where('user_id', '=', req.user!.id));
  if (!existing) { res.status(404).json({ error: 'Note not found' }); return; }
  const input = parseBody(noteSchema, { ...req.body, checklist: req.body.checklist ?? checklist(existing.checklist) });
  atomic(() => {
    const next = { title: input.title ?? null, body: input.body, checklist: JSON.stringify(input.checklist || []) };
    exec(qb.updateTable('notes').set({ ...next, updated_at: sql<string>`datetime('now')` }).where('id', '=', existing.id).where('user_id', '=', req.user!.id));
    exec(qb.updateTable('tasks').set(linkedTask(next)).where('note_id', '=', existing.id).where('user_id', '=', req.user!.id));
  });
  res.json({ ok: true });
});
// Repeated scheduling updates the same task rather than creating duplicate reminders.
router.post('/notes/:id/schedule', syncClass('merge'), (req, res) => {
  const note = first(qb.selectFrom('notes').selectAll().where('id', '=', Number(req.params.id)).where('user_id', '=', req.user!.id));
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }
  const input = parseBody(scheduleNoteSchema, req.body);
  const id = atomic(() => {
    const task = first(qb.selectFrom('tasks').selectAll().where('note_id', '=', note.id).where('user_id', '=', req.user!.id));
    const fields = { ...linkedTask(note), due_date: input.due_date.replace('T', ' '), remind_at: input.remind_at ?? null, remind_sent: task && task.remind_at === (input.remind_at ?? null) ? task.remind_sent : 0 };
    if (task) { exec(qb.updateTable('tasks').set(fields).where('id', '=', task.id)); return task.id; }
    return exec(qb.insertInto('tasks').values({ ...fields, note_id: note.id, user_id: req.user!.id, title: fields.title })).lastInsertRowid;
  });
  res.json({ id });
});

router.delete('/notes/:id', syncClass('merge'), (req, res) => {
  const info = exec(
    qb.deleteFrom('notes').where('id', '=', Number(req.params.id)).where('user_id', '=', req.user!.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json({ ok: true });
});

/* ---------------- Tasks (scheduler) ---------------- */
router.get('/tasks', (req, res) => {
  res.json(all(
    qb.selectFrom('tasks').selectAll()
      .where('user_id', '=', req.user!.id)
      .orderBy('done', 'asc')
      .orderBy(sql`(due_date IS NULL)`, 'asc')
      .orderBy('due_date', 'asc')
      .orderBy('created_at', 'asc')
  ));
});

router.post('/tasks', syncClass('merge'), (req, res) => {
  const input = parseBody(taskSchema, req.body);
  const info = exec(qb.insertInto('tasks').values({
    user_id: req.user!.id,
    title: input.title,
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
    remind_at: input.remind_at ?? null,
    done: input.done ? 1 : 0,
  }));
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/tasks/:id', syncClass('merge'), (req, res) => {
  const id = Number(req.params.id);
  const task = first(qb.selectFrom('tasks').selectAll().where('id', '=', id).where('user_id', '=', req.user!.id));
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const input = parseBody(updateTaskSchema, req.body);
  const remindAt = input.remind_at !== undefined ? input.remind_at ?? null : task.remind_at;
  // A changed reminder time re-arms the one-shot push.
  const remindSent = remindAt === task.remind_at ? task.remind_sent : 0;
  atomic(() => {
  exec(
    qb.updateTable('tasks')
      .set({
        title: input.title ?? task.title,
        due_date: input.due_date !== undefined ? input.due_date : task.due_date,
        notes: input.notes !== undefined ? input.notes ?? null : task.notes,
        remind_at: remindAt,
        remind_sent: remindSent,
        done: input.done !== undefined ? (input.done ? 1 : 0) : task.done,
      })
      .where('id', '=', id)
      .where('user_id', '=', req.user!.id)
  );
  if (task.note_id && input.done !== undefined) {
    const note = first(qb.selectFrom('notes').selectAll().where('id', '=', task.note_id).where('user_id', '=', req.user!.id));
    if (note) {
      const items = checklist(note.checklist);
      if (input.done) items.forEach(i => i.done = true);
      else if (items.length && items.every(i => i.done)) items[items.length - 1]!.done = false;
      exec(qb.updateTable('notes').set({ checklist: JSON.stringify(items), updated_at: sql<string>`datetime('now')` }).where('id', '=', note.id));
    }
  }
  });
  res.json({ ok: true });
});

router.delete('/tasks/:id', syncClass('merge'), (req, res) => {
  const info = exec(
    qb.deleteFrom('tasks').where('id', '=', Number(req.params.id)).where('user_id', '=', req.user!.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
});

/* ---------------- Bookmarks ---------------- */
router.get('/bookmarks', (req, res) => {
  const rows = all(
    qb.selectFrom('bookmarks').selectAll().where('user_id', '=', req.user!.id).orderBy('created_at', 'desc')
  );
  res.json(
    rows.map((b) => ({
      ...b,
      params: b.params ? safeParse(b.params) : null,
    }))
  );
});

router.post('/bookmarks', syncClass('merge'), (req, res) => {
  const input = parseBody(bookmarkSchema, req.body);
  const info = exec(qb.insertInto('bookmarks').values({
    user_id: req.user!.id,
    label: input.label,
    route: input.route,
    params: input.params ? JSON.stringify(input.params) : null,
  }));
  res.status(201).json({ id: info.lastInsertRowid });
});

router.delete('/bookmarks/:id', syncClass('merge'), (req, res) => {
  const info = exec(
    qb.deleteFrom('bookmarks').where('id', '=', Number(req.params.id)).where('user_id', '=', req.user!.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Bookmark not found' });
    return;
  }
  res.json({ ok: true });
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default router;
