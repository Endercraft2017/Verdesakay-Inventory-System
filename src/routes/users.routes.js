'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/users  — any authenticated user can list people (for messaging),
// but only admins see sensitive management fields.
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
              d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY u.full_name COLLATE NOCASE`
    )
    .all();
  if (req.user.role !== 'admin') {
    // Regular employees get a trimmed directory of active users only.
    return res.json(
      rows
        .filter((u) => u.active === 1)
        .map((u) => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          department_name: u.department_name,
        }))
    );
  }
  res.json(rows);
});

// POST /api/users  — admin creates a new account
router.post('/', requireRole('admin'), (req, res) => {
  let { username, full_name, password, role, department_id } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  full_name = String(full_name || '').trim();
  role = role === 'admin' ? 'admin' : 'employee';

  if (!username || !full_name || !password) {
    return res.status(400).json({ error: 'Username, full name and password are required' });
  }
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen',
    });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const deptId = department_id ? Number(department_id) : null;
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, password_hash, role, department_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(username, full_name, hash, role, deptId);

  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/users/:id  — admin updates account details
router.put('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let { full_name, role, department_id, active } = req.body || {};
  full_name = full_name != null ? String(full_name).trim() : user.full_name;
  role = role === 'admin' || role === 'employee' ? role : user.role;
  const deptId = department_id === undefined ? user.department_id : department_id ? Number(department_id) : null;
  const activeVal = active === undefined ? user.active : active ? 1 : 0;

  // Guard: never let the last active admin be demoted/disabled.
  if ((user.role === 'admin' && role !== 'admin') || (user.active === 1 && activeVal === 0 && user.role === 'admin')) {
    const otherAdmins = db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(id).c;
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'Cannot remove the last active administrator' });
    }
  }

  db.prepare(
    'UPDATE users SET full_name = ?, role = ?, department_id = ?, active = ? WHERE id = ?'
  ).run(full_name, role, deptId, activeVal, id);

  if (activeVal === 0) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // force logout disabled users
  }
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password  — admin sets a new password
router.post('/:id/reset-password', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const { new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hash = bcrypt.hashSync(String(new_password), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

// ---- Departments ----

// GET /api/users/departments/list
router.get('/departments/list', (req, res) => {
  const rows = db.prepare('SELECT id, name FROM departments ORDER BY name COLLATE NOCASE').all();
  res.json(rows);
});

// POST /api/users/departments  — admin adds a department
router.post('/departments', requireRole('admin'), (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  const exists = db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE').get(name);
  if (exists) return res.status(409).json({ error: 'Department already exists' });
  const info = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

module.exports = router;
