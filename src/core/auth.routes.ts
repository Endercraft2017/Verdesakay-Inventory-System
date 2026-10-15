/** Authentication routes: login, logout, current user, self password change, password reset,
 *  and the caller's own sessions ("Where you're signed in" — list / end one / end the others). */
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne, queryAll, run, newToken, db } from '../shared/db';
import {
  createSession, destroySession, requireAuth, endUserSessions, endSessionBySid, listUserSessions,
} from '../shared/auth';
import { deviceIdOf } from '../shared/device';
import { userPermissions, getRole } from '../shared/roles';
import { enabledModules } from '../shared/modules';
import {
  parseBody, loginSchema, changePasswordSchema, updateProfileSchema,
  forgotPasswordSchema, selfResetPasswordSchema,
} from '../shared/validation';
import { sendMail, mailReady } from '../shared/mailer';
import type { UserRow } from '../shared/types';
import { syncClass } from '../sync';
import { tenantPublicUrl } from '../platform/platform';
import { browserMode, setBrowserSession, clearBrowserSession } from '../shared/browser-session';
import { tenantStore } from '../shared/db';

const router = Router();

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const RESET_TTL_MIN = 15;

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password, shared } = parseBody(loginSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE username = ?', username.toLowerCase());

  if (!user || user.active !== 1 || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  req.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, department_id: user.department_id, active: user.active, department_name: null, permissions: [] };
  const token = createSession(user.id, { req, shared: !!shared });
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

  if (browserMode(req)) setBrowserSession(req, res, token, !!shared);
  res.json({
    ...(browserMode(req) ? { browser_session: true } : { token }),
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      role_label: getRole(user.role)?.label ?? user.role,
      department_id: user.department_id,
      department_name: dept ? dept.name : null,
      permissions: userPermissions(user.role, overrides),
      modules: [...enabledModules()], // feature areas enabled for this workspace
    },
    session: { shared: !!shared },
  });
});

// POST /api/auth/logout
// Also drops this user's push subscription registered from this device, so their
// notifications stop arriving on a phone they've signed out of (e.g. a coworker's).
router.post('/logout', requireAuth, (req, res) => {
  if (req.token) destroySession(req.token);
  clearBrowserSession(res);
  const deviceId = deviceIdOf(req);
  if (deviceId) run('DELETE FROM push_subscriptions WHERE user_id = ? AND device_id = ?', req.user!.id, deviceId);
  res.json({ ok: true });
});

// GET /api/auth/sessions — the caller's live sessions; ?history=1 adds ended/expired ones
// (kept SESSION_HISTORY_DAYS). Tokens are never returned — `id` is the public sid.
router.get('/sessions', requireAuth, (req, res) => {
  res.json(listUserSessions(req.user!.id, { currentToken: req.token, includeEnded: req.query.history === '1' }));
});

// POST /api/auth/sessions/revoke-others — sign out everywhere except here.
router.post('/sessions/revoke-others', requireAuth, (req, res) => {
  res.json({ ok: true, ended: endUserSessions(req.user!.id, 'revoked', req.token) });
});

// POST /api/auth/sessions/:sid/revoke — sign out one of your own sessions (not this one — use logout).
router.post('/sessions/:sid/revoke', requireAuth, (req, res) => {
  const sid = String(req.params.sid);
  if (sid === req.authSession?.sid) {
    res.status(400).json({ error: 'That is this session — use Sign out instead.' });
    return;
  }
  if (!endSessionBySid(req.user!.id, sid, 'revoked')) {
    res.status(404).json({ error: 'Session not found or already ended' });
    return;
  }
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
  res.json({
    user: {
      ...req.user, role_label: getRole(req.user!.role)?.label ?? req.user!.role,
      employee: emp ?? null, can_approve: canApprove, modules: [...enabledModules()],
    },
    session: { shared: !!req.authSession?.shared },
  });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, syncClass('online'), (req, res) => {
  const { current_password, new_password } = parseBody(changePasswordSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  const hash = bcrypt.hashSync(new_password, 10);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.user!.id);
  endUserSessions(req.user!.id, 'password');
  clearBrowserSession(res);
  run('UPDATE password_resets SET used = 1 WHERE user_id = ?', req.user!.id);
  res.json({ ok: true });
});

// POST /api/auth/forgot-password — { identifier }  (username or email).
// Always 200 (never reveal whether an account exists). Emails a one-hour reset link if
// the account has an email and this workspace has email configured.
router.post('/forgot-password', syncClass('online'), async (req, res, next) => {
  try {
    const { identifier } = parseBody(forgotPasswordSchema, req.body);
    const id = identifier.toLowerCase();
    const user = queryAll<UserRow>(
      'SELECT * FROM users WHERE active = 1 AND (username = ? OR (email IS NOT NULL AND lower(email) = ?)) LIMIT 1',
      id, id
    )[0];

    const done = { ok: true, message: 'If the account is eligible, a reset link will be emailed. Otherwise contact your administrator.' };
    if (user && user.email && mailReady()) {
      // Do not let changing an IP or switching between username/email flood one mailbox.
      const recent = queryOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')", user.id
      )!.c;
      if (recent >= 3) { res.json(done); return; }
      const slug = tenantStore.getStore()?.slug ?? 'default';
      const tenantUrl = slug === 'default' ? '' : tenantPublicUrl(slug);
      const origin = tenantUrl.startsWith('https://') ? tenantUrl : process.env.PUBLIC_APP_URL;
      if (!origin || !/^https?:\/\//.test(origin)) { res.json(done); return; }
      const raw = newToken();
      run('UPDATE password_resets SET used = 1 WHERE user_id = ?', user.id);
      run(
        "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
        sha256(raw), user.id, `+${RESET_TTL_MIN} minutes`
      );
      // Never construct email links from attacker-controlled Host/forwarded headers.
      const link = `${origin.replace(/\/+$/, '')}/?reset=${raw}`;
      await sendMail({
        to: user.email,
        subject: 'Password reset',
        text: `Hi ${user.full_name},\n\nUse this link within ${RESET_TTL_MIN} minutes to set a new password:\n${link}\n\nIf you didn't ask for this, ignore this email.`,
      }, user.id);
    }
    res.json(done);
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/reset-password — { token, new_password }
router.post('/reset-password', syncClass('online'), (req, res) => {
  const { token, new_password } = parseBody(selfResetPasswordSchema, req.body);
  const row = queryOne<{ user_id: number }>(
    "SELECT user_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')",
    sha256(token)
  );
  if (!row) {
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return;
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.exec('BEGIN IMMEDIATE');
  try {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
    run('UPDATE password_resets SET used = 1 WHERE user_id = ?', row.user_id);
    endUserSessions(row.user_id, 'password');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// PUT /api/auth/profile — update your own display name
router.put('/profile', requireAuth, syncClass('merge'), (req, res) => {
  const { full_name } = parseBody(updateProfileSchema, req.body);
  run('UPDATE users SET full_name = ? WHERE id = ?', full_name, req.user!.id);
  res.json({ ok: true, full_name });
});

export default router;
