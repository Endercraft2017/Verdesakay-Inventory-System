/** User-account and department management. Listing is open to all; mutations require users.manage. */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission, requireAnyPermission } from '../auth';
import {
  parseBody,
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  permissionOverridesSchema,
} from '../validation';
import { ALL_PERMISSIONS, allRoleDefaults } from '../permissions';
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
  permission_overrides: string;
}

// GET /api/users — everyone can see the directory; users.manage get full management fields.
router.get('/', (req, res) => {
  const rows = queryAll<UserListRow>(
    `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
            u.permission_overrides, d.name AS department_name
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     ORDER BY u.full_name COLLATE NOCASE`
  );

  if (!req.user!.permissions.includes('users.manage')) {
    // Directory view: enough to address a message (role lets the mobile app group
    // "supervisors" first in its report-a-problem picker). No sensitive fields.
    res.json(
      rows
        .filter((u) => u.active === 1)
        .map((u) => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          role: u.role,
          department_name: u.department_name,
        }))
    );
    return;
  }
  res.json(rows);
});

// POST /api/users — create an account
router.post('/', requirePermission('users.manage'), (req, res) => {
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

// PUT /api/users/:id — update account details
router.put('/:id', requirePermission('users.manage'), (req, res) => {
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

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', requirePermission('users.manage'), (req, res) => {
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

// GET /api/users/permissions/catalog — canonical permission keys + per-role defaults, for the
// Customize Permissions editor (avoids hand-duplicating src/permissions.ts on the frontend).
router.get('/permissions/catalog', requirePermission('users.manage'), (_req, res) => {
  res.json({ permissions: ALL_PERMISSIONS, roleDefaults: allRoleDefaults() });
});

// PUT /api/users/:id/permissions — save sparse permission overrides for a user
router.put('/:id/permissions', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const user = queryOne('SELECT id FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { overrides } = parseBody(permissionOverridesSchema, req.body);
  // Strip any keys that aren't real permission keys.
  const clean: Record<string, boolean> = {};
  for (const key of ALL_PERMISSIONS) {
    const v = overrides[key];
    if (v !== undefined) clean[key] = v;
  }
  run('UPDATE users SET permission_overrides = ? WHERE id = ?', JSON.stringify(clean), id);
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

// POST /api/users/departments — users.manage (full admin) or hr.manage (HR builds out its own
// department list without needing full account-management rights). Rename/delete stay
// users.manage-only below since they touch existing users/items/forms company-wide.
router.post('/departments', requireAnyPermission(['users.manage', 'hr.manage']), (req, res) => {
  const { name } = parseBody(createDepartmentSchema, req.body);
  const exists = queryOne('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', name);
  if (exists) {
    res.status(409).json({ error: 'Department already exists' });
    return;
  }
  const info = run('INSERT INTO departments (name) VALUES (?)', name);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

// GET /api/users/departments — with usage counts (for management)
router.get('/departments', requirePermission('users.manage'), (_req, res) => {
  const rows = queryAll(
    `SELECT d.id, d.name,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count,
            (SELECT COUNT(*) FROM inventory_items i WHERE i.department_id = d.id) AS item_count,
            (SELECT COUNT(*) FROM forms f WHERE f.department_id = d.id) AS form_count
     FROM departments d
     ORDER BY d.name COLLATE NOCASE`
  );
  res.json(rows);
});

// PUT /api/users/departments/:id
router.put('/departments/:id', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const dept = queryOne('SELECT id FROM departments WHERE id = ?', id);
  if (!dept) {
    res.status(404).json({ error: 'Department not found' });
    return;
  }
  const { name } = parseBody(updateDepartmentSchema, req.body);
  const clash = queryOne('SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND id != ?', name, id);
  if (clash) {
    res.status(409).json({ error: 'Another department already uses that name' });
    return;
  }
  run('UPDATE departments SET name = ? WHERE id = ?', name, id);
  res.json({ ok: true });
});

// DELETE /api/users/departments/:id — FK is ON DELETE SET NULL. users.manage can delete any
// department; hr.manage-only callers can delete one only if nothing outside HR's own domain
// (user accounts, inventory items, files) references it — employees are fine, since that's
// HR's own domain and just unassigns them, same as a users.manage delete would.
router.delete('/departments/:id', requireAnyPermission(['users.manage', 'hr.manage']), (req, res) => {
  const id = Number(req.params.id);
  if (!req.user!.permissions.includes('users.manage')) {
    const usage = queryOne<{ user_count: number; item_count: number; form_count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM users u WHERE u.department_id = ?) AS user_count,
         (SELECT COUNT(*) FROM inventory_items i WHERE i.department_id = ?) AS item_count,
         (SELECT COUNT(*) FROM forms f WHERE f.department_id = ?) AS form_count`,
      id, id, id
    )!;
    if (usage.user_count + usage.item_count + usage.form_count > 0) {
      res.status(409).json({ error: 'Department is in use outside HR (accounts, items, or files) — ask an admin to remove it' });
      return;
    }
  }
  const info = run('DELETE FROM departments WHERE id = ?', id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Department not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
