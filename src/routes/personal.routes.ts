/** Personal tools: per-user notes, tasks (scheduler), and bookmarks.
    Every query is scoped to req.user!.id so users never see each other's data. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth } from '../auth';
import { parseBody, noteSchema, taskSchema, updateTaskSchema, bookmarkSchema } from '../validation';
import type { Note, Task, Bookmark } from '../types';

const router = Router();
router.use(requireAuth);

/* ---------------- Notes ---------------- */
router.get('/notes', (req, res) => {
  res.json(
    queryAll<Note>('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC', req.user!.id)
  );
});

router.post('/notes', (req, res) => {
  const input = parseBody(noteSchema, req.body);
  const info = run(
    'INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)',
    req.user!.id,
    input.title ?? null,
    input.body
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/notes/:id', (req, res) => {
  const input = parseBody(noteSchema, req.body);
  const info = run(
    "UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    input.title ?? null,
    input.body,
    Number(req.params.id),
    req.user!.id
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json({ ok: true });
});

router.delete('/notes/:id', (req, res) => {
  const info = run('DELETE FROM notes WHERE id = ? AND user_id = ?', Number(req.params.id), req.user!.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json({ ok: true });
});

/* ---------------- Tasks (scheduler) ---------------- */
router.get('/tasks', (req, res) => {
  res.json(
    queryAll<Task>(
      `SELECT * FROM tasks WHERE user_id = ?
       ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, created_at ASC`,
      req.user!.id
    )
  );
});

router.post('/tasks', (req, res) => {
  const input = parseBody(taskSchema, req.body);
  const info = run(
    'INSERT INTO tasks (user_id, title, due_date, done) VALUES (?, ?, ?, ?)',
    req.user!.id,
    input.title,
    input.due_date ?? null,
    input.done ? 1 : 0
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ? AND user_id = ?', id, req.user!.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const input = parseBody(updateTaskSchema, req.body);
  run(
    'UPDATE tasks SET title = ?, due_date = ?, done = ? WHERE id = ? AND user_id = ?',
    input.title ?? task.title,
    input.due_date !== undefined ? input.due_date : task.due_date,
    input.done !== undefined ? (input.done ? 1 : 0) : task.done,
    id,
    req.user!.id
  );
  res.json({ ok: true });
});

router.delete('/tasks/:id', (req, res) => {
  const info = run('DELETE FROM tasks WHERE id = ? AND user_id = ?', Number(req.params.id), req.user!.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
});

/* ---------------- Bookmarks ---------------- */
router.get('/bookmarks', (req, res) => {
  const rows = queryAll<Bookmark>(
    'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC',
    req.user!.id
  );
  res.json(
    rows.map((b) => ({
      ...b,
      params: b.params ? safeParse(b.params) : null,
    }))
  );
});

router.post('/bookmarks', (req, res) => {
  const input = parseBody(bookmarkSchema, req.body);
  const info = run(
    'INSERT INTO bookmarks (user_id, label, route, params) VALUES (?, ?, ?, ?)',
    req.user!.id,
    input.label,
    input.route,
    input.params ? JSON.stringify(input.params) : null
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

router.delete('/bookmarks/:id', (req, res) => {
  const info = run('DELETE FROM bookmarks WHERE id = ? AND user_id = ?', Number(req.params.id), req.user!.id);
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
