import { securityLog } from '../shared/http-hardening';
import { browserMode, setBrowserSession, clearBrowserSession } from '../shared/browser-session';
import { approverDepartmentIds } from '../modules/hr/workflow';
/** Authentication routes: login, logout, current user, self password change, password reset,
 *  and the caller's own sessions ("Where you're signed in" — list / end one / end the others). */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { hashPassword, verifyPassword, passwordNeedsUpgrade } from '../shared/password-hash';
import rateLimit from 'express-rate-limit';
import { db, queryOne, queryAll, run, newToken, DEFAULT_TENANT } from '../shared/db';
import {
  createSession, destroySession, requireAuth, endUserSessions, endSessionBySid, listUserSessions,
} from '../shared/auth';
import { deviceIdOf } from '../shared/device';
import { userPermissions, getRole } from '../shared/roles';
import { enabledModules } from '../shared/modules';
import {
  parseBody, loginSchema, changePasswordSchema, changeUsernameSchema, updateProfileSchema,
  forgotPasswordSchema, selfResetPasswordSchema,
} from '../shared/validation';
import { sendMail, mailReady } from '../shared/mailer';
import { currentSlug } from '../platform/quota';
import { getTenant, platformDb, logProvisioning } from '../platform/platform';
import type { UserRow } from '../shared/types';
import { syncClass } from '../sync';
import { z } from 'zod';
import {
  mfaApplies, mfaEnabled, mfaSetupRequired, isPrivileged, securityPolicy, recoveryCodesLeft, startMfaSetup,
  enableMfa, checkMfaCode, disableMfa, regenerateRecoveryCodes, createMfaChallenge, completeMfaChallenge,
} from '../shared/mfa';

const router = Router();

const mfaLoginSchema = z.object({ mfa_token: z.string().min(16).max(200), code: z.string().trim().min(6).max(20) });

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const RESET_TTL_MIN = 15;

/** Where an emailed link points: the configured public host on the cloud (TENANT_PATH_HOST, not
 *  the request's Host header, which the caller controls), else this request's own address (an
 *  office server, or sub-domain tenancy where the host names the workspace). */
function appOrigin(req: Request): string {
  if (process.env.TENANT_PATH_HOST) return `https://${process.env.TENANT_PATH_HOST}`;
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_DOMAIN;
  if (!configured) throw new Error('Configure PUBLIC_APP_URL before enabling password reset email.');
  const url = new URL(configured.includes('://') ? configured : `https://${configured}`);
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('Password reset requires an HTTPS public URL.');
  return url.origin;
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password, shared } = parseBody(loginSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE username = ?', username.toLowerCase());

  if (!user || user.active !== 1 || (user.password_change_required === 1 && user.temporary_password_expires_at && Date.parse(user.temporary_password_expires_at) <= Date.now()) || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Upgrade only a verified password and only if the stored hash has not changed.
  if (process.env.DEPLOY_MODE !== 'node' && passwordNeedsUpgrade(user.password_hash)) {
    run('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?', hashPassword(password), user.id, user.password_hash);
  }

  // Two-step sign-in on: the password alone opens nothing — the app asks for the code next
  // (POST /login/mfa with this short-lived token). See shared/mfa.ts.
  if (mfaApplies() && mfaEnabled(user.id)) {
    res.json({ mfa_required: true, mfa_token: createMfaChallenge(user.id, !!shared) });
    return;
  }
  res.json({ ...signIn(user, req, !!shared, res), ...(res.locals.companyLogin ? { workspace_path: res.locals.tenantBase } : {}) });
});

// POST /api/auth/login/mfa — { mfa_token, code }: the second step (authenticator code or a
// recovery code). Same answer as /login on success.
router.post('/login/mfa', syncClass('online'), (req, res) => {
  const { mfa_token, code } = parseBody(mfaLoginSchema, req.body);
  const out = completeMfaChallenge(mfa_token, code);
  if ('error' in out) { res.status(401).json({ error: out.error }); return; }
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', out.userId);
  if (!user || user.active !== 1) { res.status(401).json({ error: 'Invalid username or password' }); return; }
  res.json({ ...signIn(user, req, out.shared, res), ...(res.locals.companyLogin ? { workspace_path: res.locals.tenantBase } : {}) });
});

/** Open a session and build the sign-in answer (token + the user as the app needs it). */
function signIn(user: UserRow, req: Request, shared: boolean, res: Response) {
  const token = createSession(user.id, { req, shared });
  if (browserMode(req)) setBrowserSession(req, res, token, shared);
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
  const permissions = user.password_change_required ? [] : userPermissions(user.role, overrides);
  return {
    ...(browserMode(req) ? { browser_session: true } : { token }),
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      role_label: getRole(user.role)?.label ?? user.role,
      department_id: user.department_id,
      department_name: dept ? dept.name : null,
      password_change_required: user.password_change_required,
      mfa_setup_required: mfaSetupRequired({ id: user.id, role: user.role, permissions }),
      permissions,
      modules: [...enabledModules()], // feature areas enabled for this workspace
    },
    session: { shared },
  };
}

// ── Two-step sign-in: the caller's own set-up (shared/mfa.ts) ──────────────────────────────
const passwordOnly = z.object({ password: z.string().min(1, 'Enter your password').max(256) });
const passwordAndCode = passwordOnly.extend({ code: z.string().trim().min(6, 'Enter the code from your app').max(20) });

// A session is not proof of a factor. Bound guesses across all self-service factor
// operations, devices and sessions for this account, independently of login challenges.
// Successful requests do not spend the failure budget. Keep this active in tests too.
const mfaChangeLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req => `${currentSlug()}:${req.user!.id}`,
  message: { error: 'Too many security verification attempts. Try again in fifteen minutes.' },
});

function passwordMatches(userId: number, password: string): boolean {
  const row = queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId);
  return !!row && verifyPassword(password, row.password_hash);
}

// GET /api/auth/mfa — whether it is on, required, and how many recovery codes are left.
router.get('/mfa', requireAuth, (req, res) => {
  const u = req.user!;
  res.json({
    available: mfaApplies(),
    enabled: mfaEnabled(u.id),
    required: securityPolicy().require_mfa_privileged && isPrivileged(u),
    recovery_codes_left: recoveryCodesLeft(u.id),
  });
});

// POST /api/auth/mfa/setup — { password }: a new secret + otpauth link to add to the app.
router.post('/mfa/setup', requireAuth, syncClass('online'), mfaChangeLimiter, (req, res) => {
  const { password } = parseBody(passwordOnly, req.body);
  if (!passwordMatches(req.user!.id, password)) { res.status(400).json({ error: 'Password is incorrect' }); return; }
  res.set('Cache-Control', 'no-store').json(startMfaSetup(req.user!.id, `${req.user!.username}@${currentSlug()}`, req.token!));
});

// POST /api/auth/mfa/enable — { code }: confirm the app works; returns the recovery codes once.
router.post('/mfa/enable', requireAuth, syncClass('online'), mfaChangeLimiter, (req, res) => {
  const { code } = parseBody(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
  const codes = enableMfa(req.user!.id, code, req.token!);
  if (!codes) { res.status(400).json({ error: 'That code is not right. Check the time on your phone and try the newest code.' }); return; }
  endUserSessions(req.user!.id, 'revoked', req.token);
  res.set('Cache-Control', 'no-store').json({ ok: true, recovery_codes: codes });
});

// POST /api/auth/mfa/disable — { password, code }
router.post('/mfa/disable', requireAuth, syncClass('online'), mfaChangeLimiter, (req, res) => {
  const { password, code } = parseBody(passwordAndCode, req.body);
  if (securityPolicy().require_mfa_privileged && isPrivileged(req.user!)) {
    res.status(403).json({ error: 'Your workspace requires two-step sign-in for your account. Ask an admin to reset it if you changed phones.' });
    return;
  }
  if (!passwordMatches(req.user!.id, password) || !checkMfaCode(req.user!.id, code)) {
    res.status(400).json({ error: 'Password or code is incorrect' });
    return;
  }
  disableMfa(req.user!.id);
  endUserSessions(req.user!.id, 'revoked', req.token);
  res.json({ ok: true });
});

// POST /api/auth/mfa/recovery-codes — { password, code }: replace the recovery codes.
router.post('/mfa/recovery-codes', requireAuth, syncClass('online'), mfaChangeLimiter, (req, res) => {
  const { password, code } = parseBody(passwordAndCode, req.body);
  if (!passwordMatches(req.user!.id, password) || !checkMfaCode(req.user!.id, code)) {
    res.status(400).json({ error: 'Password or code is incorrect' });
    return;
  }
  res.set('Cache-Control', 'no-store').json({ recovery_codes: regenerateRecoveryCodes(req.user!.id) });
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
  // registered head or appointed delegate of at least one department.
  const canApprove = req.user!.permissions.includes('hr.manage') || approverDepartmentIds(req.user!.id).length > 0;
  res.json({
    user: {
      ...req.user, role_label: getRole(req.user!.role)?.label ?? req.user!.role,
      employee: emp ?? null, can_approve: canApprove, modules: [...enabledModules()],
      mfa_enabled: mfaEnabled(req.user!.id), mfa_setup_required: mfaSetupRequired(req.user!),
    },
    session: { shared: !!req.authSession?.shared },
  });
});

// POST /api/auth/change-username — all roles may change only their own login name.
router.post('/change-username', requireAuth, syncClass('online'), (req, res) => {
  const { current_password, new_username } = parseBody(changeUsernameSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
  if (!verifyPassword(current_password, user.password_hash)) { res.status(400).json({ error: 'Current password is incorrect' }); return; }
  if (new_username === user.username.toLowerCase()) { res.status(400).json({ error: 'Choose a different username' }); return; }
  if (queryOne('SELECT id FROM users WHERE lower(username) = ? AND id <> ?', new_username, user.id)) {
    res.status(409).json({ error: 'That username is already in use in your company' }); return;
  }
  run('UPDATE users SET username = ? WHERE id = ?', new_username, user.id);
  endUserSessions(user.id, 'revoked', req.token);
  res.json({ ok: true, username: new_username });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, syncClass('online'), (req, res) => {
  const { current_password, new_password } = parseBody(changePasswordSchema, req.body);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', req.user!.id)!;
  if (!verifyPassword(current_password, user.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  if (user.password_change_required && verifyPassword(new_password, user.password_hash)) {
    res.status(400).json({ error: 'Choose a password different from the temporary password.' }); return;
  }
  const hash = hashPassword(new_password);
  run('UPDATE users SET password_hash = ?, password_change_required = 0, temporary_password_expires_at = NULL WHERE id = ?', hash, req.user!.id);
  // Password replacement invalidates every credential, including the caller's.
  endUserSessions(req.user!.id, 'password');
  run('DELETE FROM mfa_challenges WHERE user_id=?', req.user!.id);
  clearBrowserSession(res);
  res.json({ ok: true });
});

// POST /api/auth/forgot-password — { identifier }  (username or email).
// Always 200 (never reveal whether an account exists). Emails a one-hour reset link if
// the account has an email and this workspace has email configured.
router.post('/forgot-password', syncClass('online'), async (req, res, next) => {
  try {
    const { identifier } = parseBody(forgotPasswordSchema, req.body);
    const slug = currentSlug();
    if (slug !== DEFAULT_TENANT && getTenant(slug)?.is_sandbox === 1) {
      res.json({ ok: true, sent: false, reason: 'Sandbox account — ask your SaaS administrator to recover your login.' });
      return;
    }
    const id = identifier.toLowerCase();
    const user = queryAll<UserRow>(
      'SELECT * FROM users WHERE active = 1 AND (username = ? OR (email IS NOT NULL AND lower(email) = ?)) LIMIT 1',
      id, id
    )[0];

    // The same answer, at the same speed, whether or not the account exists or has an email:
    // anything else tells a stranger which usernames / addresses are real. The mail goes out in
    // the background; a failure is in the mail log for an admin.
    let resetOrigin: string | null = null;
    try { resetOrigin = appOrigin(req); } catch { securityLog({ event: 'password_reset_configuration_missing', request_id: res.locals.requestId }); }
    if (resetOrigin && user && user.email && mailReady()) {
      const raw = newToken();
      run(
        "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
        sha256(raw), user.id, `+${RESET_TTL_MIN} minutes`
      );
      const link = `${resetOrigin}${String(res.locals.tenantBase || '')}/?reset=${raw}`;
      void sendMail({
        to: user.email,
        subject: 'Password reset',
        text: `Hi ${user.full_name},\n\nYour username: ${user.username}\n\nUse this link within ${RESET_TTL_MIN} minutes to set a new password:\n${link}\n\nIf you didn't ask for this, ignore this email.`,
      }, user.id).catch(() => { /* recorded in mail_log by sendMail */ });
    }
    res.json({
      ok: true,
      message: 'If that account exists and has an email address on file, a reset link is on its way. Otherwise ask your administrator to reset your password.',
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/reset-password — { token, new_password }
router.post('/cancel-recovery', syncClass('online'), (req, res) => {
  const { token } = parseBody(z.object({ token: z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/) }).strict(), req.body);
  const [id, nonce] = token.split('.');
  const conn = platformDb();
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_recovery_approvals'").get();
  const changed = exists ? conn.prepare("UPDATE platform_recovery_approvals SET state='cancelled' WHERE id=? AND cancel_hash=? AND slug=? AND state IN ('pending','notifying') AND expires_at>datetime('now')").run(id!, sha256(nonce!), currentSlug()) : null;
  if (!changed || !Number(changed.changes)) { res.status(400).json({ error: 'This cancellation link is invalid, expired, or recovery was already issued. Contact your administrator if this was unexpected.' }); return; }
  logProvisioning(currentSlug(), 'account-recovery-cancelled', `owner email confirmation; request=${id}`);
  res.json({ ok: true });
});

router.post('/reset-password', syncClass('online'), (req, res) => {
  const { token, new_password } = parseBody(selfResetPasswordSchema, req.body);
  const digest = sha256(token);
  if (!queryOne("SELECT 1 FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>datetime('now')", digest)) {
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' }); return;
  }
  const replacementHash = hashPassword(new_password);
  db.exec('BEGIN IMMEDIATE');
  try {
  const row = queryOne<{ user_id: number }>(
    "SELECT user_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')",
    digest
  );
  const recovery = queryOne<{ state: string; contact_email: string; credential_hash: string }>('SELECT state,contact_email,credential_hash FROM account_recoveries WHERE token_hash=?', digest);
  const current = row ? queryOne<{ email: string | null; password_hash: string; active: number }>('SELECT email,password_hash,active FROM users WHERE id=?', row.user_id) : null;
  if (recovery && (recovery.state !== 'pending' || !current || current.active !== 1 || current.email !== recovery.contact_email || sha256(current.password_hash) !== recovery.credential_hash)) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: 'Recovery is no longer valid. Ask your administrator to verify the account again.' }); return;
  }
  // Claim the link in one statement, so two submissions racing with the same link can't both win.
  if (!row || Number(run('UPDATE password_resets SET used = 1 WHERE token_hash = ? AND used = 0', sha256(token)).changes) !== 1) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return;
  }
  run('UPDATE users SET password_hash = ?, password_change_required = 0, temporary_password_expires_at = NULL WHERE id = ?', replacementHash, row.user_id);
  if (recovery) {
    disableMfa(row.user_id);
    run('UPDATE users SET mfa_recovery_required=1 WHERE id=?', row.user_id);
    run('DELETE FROM mfa_challenges WHERE user_id=?', row.user_id);
    run("UPDATE account_recoveries SET state='redeemed',redeemed_at=datetime('now') WHERE token_hash=?", digest);
  }
  // Every other outstanding link for this account stops working too.
  run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', row.user_id);
  endUserSessions(row.user_id, 'password'); // force re-login everywhere
  run('DELETE FROM mfa_challenges WHERE user_id=?', row.user_id);
  db.exec('COMMIT');
  if (recovery) void sendMail({ to: recovery.contact_email, subject: 'Account recovery completed — authenticator enrollment required', text: 'Your password was replaced through assisted recovery, previous sessions were revoked and your old authenticator was removed. Sign in and enroll your authenticator before accessing the workspace. If you did not do this, contact your administrator immediately using your established contact details.' }, row.user_id).catch(() => {});
  res.json({ ok: true });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});

// PUT /api/auth/profile — update your own display name
router.put('/profile', requireAuth, syncClass('merge'), (req, res) => {
  const { full_name } = parseBody(updateProfileSchema, req.body);
  run('UPDATE users SET full_name = ? WHERE id = ?', full_name, req.user!.id);
  res.json({ ok: true, full_name });
});

export default router;
