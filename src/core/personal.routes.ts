/** Personal tools: per-user notes, tasks (scheduler), and bookmarks.
    Every query is scoped to req.user!.id so users never see each other's data.
    Uses the typed query builder (src/shared/qb.ts): column names and row types are checked
    against the generated schema types. */
import { Router } from 'express';
import { requireAuth } from '../shared/auth';
import { qb, all, first, exec, sql } from '../shared/qb';
import { parseBody, noteSchema, taskSchema, updateTaskSchema, bookmarkSchema } from '../shared/validation';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);

/* ---------------- Notes ---------------- */
router.get('/notes', (req, res) => {
  res.json(all(
    qb.selectFrom('notes').selectAll().where('user_id', '=', req.user!.id).orderBy('updated_at', 'desc')
  ));
});

router.post('/notes', syncClass('merge'), (req, res) => {
  const input = parseBody(noteSchema, req.body);
  const info = exec(
    qb.insertInto('notes').values({ user_id: req.user!.id, title: input.title ?? null, body: input.body })
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/notes/:id', syncClass('merge'), (req, res) => {
  const input = parseBody(noteSchema, req.body);
  const info = exec(
    qb.updateTable('notes')
      .set({ title: input.title ?? null, body: input.body, updated_at: sql<string>`datetime('now')` })
      .where('id', '=', Number(req.params.id))
      .where('user_id', '=', req.user!.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json({ ok: true });
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
