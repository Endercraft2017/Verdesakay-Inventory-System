/** Authentication routes: login, logout, current user, self password change, password reset. */
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, queryAll, run, newToken } from '../shared/db';
import { createSession, destroySession, requireAuth } from '../shared/auth';
import { resolvePermissions } from '../shared/permissions';
import { enabledModules } from '../shared/modules';
import {
  parseBody, loginSchema, changePasswordSchema, updateProfileSchema,
  forgotPasswordSchema, selfResetPasswordSchema,
} from '../shared/validation';
import { sendMail, mailReady } from '../shared/mailer';
import type { UserRow } from '../shared/types';

const router = Router();

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const RESET_TTL_MIN = 60;

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
  // Bug: this response never included `permissions` at all (unlike GET /auth/me, which
  // resolves them via requireAuth -> userFromToken) — every App.hasPermission(...) check on
  // the client silently failed right after a fresh login (permission-gated buttons/nav just
  // didn't render), until the user did something that re-fetched /auth/me (a page reload).
  // Resolved the same way userFromToken does, from the role + this user's own overrides.
  let overrides: Record<string, boolean> = {};
  try { overrides = JSON.parse(user.permission_overrides) as Record<string, boolean>; } catch { /* use empty */ }

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      department_id: user.department_id,
      department_name: dept ? dept.name : null,
      permissions: resolvePermissions(user.role, overrides),
      modules: [...enabledModules()], // feature areas enabled for this workspace
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
  // Which employee record (if any) this login is tied to — the mobile app uses it
  // to decide whether to show the self-service tiles (time clock, payslip, …).
  const emp = queryOne<{ id: number; name: string; employee_no: string | null }>(
    'SELECT id, name, employee_no FROM employees WHERE user_id = ?',
    req.user!.id
  );
  // Whether to show the mobile "To Approve" tile: any hr.manage holder, or the
  // registered head of at least one department.
  const headsDept = queryOne('SELECT 1 AS x FROM departments WHERE head_user_id = ?', req.user!.id);
  const canApprove = req.user!.permissions.includes('hr.manage') || !!headsDept;
  res.json({ user: { ...req.user, employee: emp ?? null, can_approve: canApprove, modules: [...enabledModules()] } });
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

// POST /api/auth/forgot-password — { identifier }  (username or email).
// Always 200 (never reveal whether an account exists). Emails a one-hour reset link if
// the account has an email and this workspace has email configured.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { identifier } = parseBody(forgotPasswordSchema, req.body);
    const id = identifier.toLowerCase();
    const user = queryAll<UserRow>(
      'SELECT * FROM users WHERE active = 1 AND (username = ? OR (email IS NOT NULL AND lower(email) = ?)) LIMIT 1',
      id, id
    )[0];

    const done = { ok: true, sent: false as boolean, reason: '' as string };
    if (user && user.email && mailReady()) {
      const raw = newToken();
      run(
        "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
        sha256(raw), user.id, `+${RESET_TTL_MIN} minutes`
      );
      const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
      const link = `${proto}://${req.get('host')}/?reset=${raw}`;
      const r = await sendMail({
        to: user.email,
        subject: 'Password reset',
        text: `Hi ${user.full_name},\n\nUse this link within ${RESET_TTL_MIN} minutes to set a new password:\n${link}\n\nIf you didn't ask for this, ignore this email.`,
      }, user.id);
      done.sent = r.ok;
      if (!r.ok) done.reason = r.error || 'send failed';
    } else if (user && !user.email) {
      done.reason = 'no email on file — ask an admin to reset it';
    } else if (!mailReady()) {
      done.reason = 'email is not configured — ask an admin to reset it';
    }
    res.json(done);
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/reset-password — { token, new_password }
router.post('/reset-password', (req, res) => {
  const { token, new_password } = parseBody(selfResetPasswordSchema, req.body);
  const row = queryOne<{ user_id: number }>(
    "SELECT user_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')",
    sha256(token)
  );
  if (!row) {
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return;
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(new_password, 10), row.user_id);
  run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', sha256(token));
  run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // force re-login everywhere
  res.json({ ok: true });
});

// PUT /api/auth/profile — update your own display name
router.put('/profile', requireAuth, (req, res) => {
  const { full_name } = parseBody(updateProfileSchema, req.body);
  run('UPDATE users SET full_name = ? WHERE id = ?', full_name, req.user!.id);
  res.json({ ok: true, full_name });
});

export default router;
