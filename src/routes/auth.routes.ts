/** Authentication routes: login, logout, current user, self password change. */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, run } from '../db';
import { createSession, destroySession, requireAuth } from '../auth';
import { parseBody, loginSchema, changePasswordSchema } from '../validation';
import type { UserRow } from '../types';

const router = Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = parseBody(loginSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE username = ?', username.toLowerCase());

  if (!user || user.active !== 1 || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const token = createSession(user.id);
  const dept = user.department_id
    ? queryOne<{ name: string }>('SELECT name FROM departments WHERE id = ?', user.department_id)
    : null;

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      department_id: user.department_id,
      department_name: dept ? dept.name : null,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  if (req.token) destroySession(req.token);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = parseBody(changePasswordSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  const hash = bcrypt.hashSync(new_password, 10);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.user!.id);
  // Keep the current session, drop the rest.
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user!.id, req.token!);
  res.json({ ok: true });
});

export default router;
