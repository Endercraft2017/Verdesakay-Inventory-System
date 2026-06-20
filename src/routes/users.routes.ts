/** User-account and department management. Listing is open to all; mutations are admin-only. */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, queryAll, run } from '../db';
import { requireAuth, requireRole } from '../auth';
import {
  parseBody,
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  createDepartmentSchema,
} from '../validation';
import type { UserRow, Department } from '../types';

const router = Router();
router.use(requireAuth);

interface UserListRow {
  id: number;
  username: string;
  full_name: string;
  role: string;
  department_id: number | null;
  active: number;
  department_name: string | null;
}

// GET /api/users — everyone can see the directory; only admins get management fields.
router.get('/', (req, res) => {
  const rows = queryAll<UserListRow>(
    `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
            d.name AS department_name
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     ORDER BY u.full_name COLLATE NOCASE`
  );

  if (req.user!.role !== 'admin') {
    res.json(
      rows
        .filter((u) => u.active === 1)
        .map((u) => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          department_name: u.department_name,
        }))
    );
    return;
  }
  res.json(rows);
});

// POST /api/users — admin creates an account
router.post('/', requireRole('admin'), (req, res) => {
  const input = parseBody(createUserSchema, req.body);
  const exists = queryOne('SELECT id FROM users WHERE username = ?', input.username);
  if (exists) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }
  const hash = bcrypt.hashSync(input.password, 10);
  const info = run(
    `INSERT INTO users (username, full_name, password_hash, role, department_id)
     VALUES (?, ?, ?, ?, ?)`,
    input.username,
    input.full_name,
    hash,
    input.role,
    input.department_id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/users/:id — admin updates account details
router.put('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const input = parseBody(updateUserSchema, req.body);
  const full_name = input.full_name ?? user.full_name;
  const role = input.role ?? user.role;
  const department_id = input.department_id !== undefined ? input.department_id : user.department_id;
  const active = input.active !== undefined ? (input.active ? 1 : 0) : user.active;

  // Never strip the last active administrator.
  const demoting = user.role === 'admin' && role !== 'admin';
  const disabling = user.role === 'admin' && user.active === 1 && active === 0;
  if (demoting || disabling) {
    const otherAdmins = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
      id
    )!.c;
    if (otherAdmins === 0) {
      res.status(400).json({ error: 'Cannot remove the last active administrator' });
      return;
    }
  }

  run(
    'UPDATE users SET full_name = ?, role = ?, department_id = ?, active = ? WHERE id = ?',
    full_name,
    role,
    department_id,
    active,
    id
  );

  if (active === 0) run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password — admin sets a new password
router.post('/:id/reset-password', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const { new_password } = parseBody(resetPasswordSchema, req.body);
  const user = queryOne('SELECT id FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const hash = bcrypt.hashSync(new_password, 10);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hash, id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
});

// ---- Departments ----

// GET /api/users/departments/list
router.get('/departments/list', (_req, res) => {
  const rows = queryAll<Pick<Department, 'id' | 'name'>>(
    'SELECT id, name FROM departments ORDER BY name COLLATE NOCASE'
  );
  res.json(rows);
});

// POST /api/users/departments — admin adds a department
router.post('/departments', requireRole('admin'), (req, res) => {
  const { name } = parseBody(createDepartmentSchema, req.body);
  const exists = queryOne('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', name);
  if (exists) {
    res.status(409).json({ error: 'Department already exists' });
    return;
  }
  const info = run('INSERT INTO departments (name) VALUES (?)', name);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

export default router;
