/** User-account and department management. Listing is open to all; mutations require users.manage. */
import { Router } from 'express';
import { hashPassword } from '../shared/password-hash';
import { db, queryOne, queryAll, run } from '../shared/db';
import {
  requireAuth, requirePermission, requireAnyPermission, endUserSessions, endSessionBySid, listUserSessions,
} from '../shared/auth';
import { enforceQuota } from '../platform/quota';
import {
  parseBody,
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  permissionOverridesSchema,
} from '../shared/validation';
import { ALL_PERMISSIONS, STAFF_PERMISSIONS } from '../shared/permissions';
import { listRoles, getRole } from '../shared/roles';
import type { UserRow, Department, Role } from '../shared/types';
import { syncClass } from '../sync';
import { z } from 'zod';
import { mfaApplies, mfaEnabled, mfaUserIds, securityPolicy, setSecurityPolicy, disableMfa } from '../shared/mfa';

const router = Router();
router.use(requireAuth);

interface UserListRow {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  role: string;
  department_id: number | null;
  active: number;
  department_name: string | null;
  permission_overrides: string;
}

// GET /api/users — everyone can see the directory; users.manage get full management fields.
router.get('/', (req, res) => {
  const rows = queryAll<UserListRow>(
    `SELECT u.id, u.username, u.full_name, u.email, u.role, u.department_id, u.active,
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
  const withMfa = mfaUserIds();
  res.json(rows.map((u) => ({ ...u, mfa_enabled: withMfa.has(u.id) })));
});

// GET /api/users/security-policy — workspace sign-in rules (shared/mfa.ts).
router.get('/security-policy', requirePermission('users.manage'), (req, res) => {
  res.json({ ...securityPolicy(), available: mfaApplies(), you_have_mfa: mfaEnabled(req.user!.id) });
});

// PUT /api/users/security-policy — { require_mfa_privileged }. Switching the requirement on is
// refused until the person doing it uses two-step sign-in themselves, so the workspace can't be
// locked out by its own admin.
router.put('/security-policy', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const { require_mfa_privileged } = parseBody(z.object({ require_mfa_privileged: z.boolean() }), req.body);
  if (require_mfa_privileged && !mfaEnabled(req.user!.id)) {
    res.status(409).json({ error: 'Turn on two-step sign-in for your own account first (Account → Two-step sign-in).' });
    return;
  }
  setSecurityPolicy({ require_mfa_privileged });
  res.json({ ok: true, require_mfa_privileged });
});

// POST /api/users/:id/mfa/reset — someone lost their phone: remove their two-step sign-in so
// they can set it up again (and sign them out everywhere).
router.post('/:id/mfa/reset', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT 1 AS x FROM users WHERE id = ?', id)) { res.status(404).json({ error: 'User not found' }); return; }
  disableMfa(id);
  endUserSessions(id, 'revoked');
  res.json({ ok: true });
});

// POST /api/users — create an account. hr.manage (without users.manage) may also create one —
// the employee form's "create account" shortcut — but only with a staff-level role (one whose
// permissions are all in STAFF_PERMISSIONS; see shared/roles.ts).
router.post('/', requireAnyPermission(['users.manage', 'hr.manage']), syncClass('online'), (req, res) => {
  const input = parseBody(createUserSchema, req.body);
  const role = getRole(input.role);
  if (!role) {
    res.status(400).json({ error: `Unknown role "${input.role}"` });
    return;
  }
  if (!req.user!.permissions.includes('users.manage') && !role.staff) {
    res.status(403).json({ error: 'HR can only create accounts with a staff role' });
    return;
  }
  const exists = queryOne('SELECT id FROM users WHERE username = ?', input.username);
  if (exists) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }
  if (input.employee_id) {
    if (!req.user!.permissions.includes('hr.manage')) { res.status(403).json({ error: 'HR authority is required to link an employee account.' }); return; }
    const employee = queryOne<{ user_id: number | null }>('SELECT user_id FROM employees WHERE id = ?', input.employee_id);
    if (!employee) { res.status(404).json({ error: 'Save the employee record before creating its account.' }); return; }
    if (employee.user_id != null) { res.status(409).json({ error: 'This employee already has an account. Unlink and save before creating another.' }); return; }
  }
  enforceQuota('users');
  const hash = hashPassword(input.password);
  db.exec('BEGIN');
  try {
    const info = run(
      `INSERT INTO users (username, full_name, email, password_hash, role, department_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.username,
      input.full_name,
      input.email || null,
      hash,
      input.role,
      input.department_id
    );
    if (input.employee_id) run("UPDATE employees SET user_id = ? WHERE id = ?", Number(info.lastInsertRowid), input.employee_id);
    db.exec('COMMIT');
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// PUT /api/users/:id — update account details
router.put('/:id', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const id = Number(req.params.id);
  const user = queryOne<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const input = parseBody(updateUserSchema, req.body);
  const full_name = input.full_name ?? user.full_name;
  const email = input.email !== undefined ? (input.email || null) : user.email;
  const role = input.role ?? user.role;
  if (input.role !== undefined && input.role !== user.role && !getRole(input.role)) {
    res.status(400).json({ error: `Unknown role "${input.role}"` });
    return;
  }
  const department_id = input.department_id !== undefined ? input.department_id : user.department_id;
  const active = input.active !== undefined ? (input.active ? 1 : 0) : user.active;

  if (user.active !== 1 && active === 1) enforceQuota('users');

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
    'UPDATE users SET full_name = ?, email = ?, role = ?, department_id = ?, active = ? WHERE id = ?',
    full_name,
    email,
    role,
    department_id,
    active,
    id
  );

  if (active === 0) endUserSessions(id, 'deactivated');
  else if (role !== user.role || department_id !== user.department_id) endUserSessions(id, 'revoked');
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const id = Number(req.params.id);
  const { new_password } = parseBody(resetPasswordSchema, req.body);
  const user = queryOne('SELECT id FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const hash = hashPassword(new_password);
  run('UPDATE users SET password_hash = ?, password_change_required = 0, temporary_password_expires_at = NULL WHERE id = ?', hash, id);
  endUserSessions(id, 'password');
  run('UPDATE password_resets SET used = 1 WHERE user_id = ?', id);
  res.json({ ok: true });
});

// GET /api/users/:id/sessions — where this account is / was signed in (live + history).
router.get('/:id/sessions', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM users WHERE id = ?', id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(listUserSessions(id, { currentToken: req.token, includeEnded: true }));
});

// POST /api/users/:id/sessions/revoke-all — sign this account out on every device.
router.post('/:id/sessions/revoke-all', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM users WHERE id = ?', id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // An admin ending their own sessions here keeps the one they're using.
  res.json({ ok: true, ended: endUserSessions(id, 'revoked', id === req.user!.id ? req.token : undefined) });
});

// POST /api/users/:id/sessions/:sid/revoke — sign this account out of one device.
router.post('/:id/sessions/:sid/revoke', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  if (!endSessionBySid(Number(req.params.id), String(req.params.sid), 'revoked')) {
    res.status(404).json({ error: 'Session not found or already ended' });
    return;
  }
  res.json({ ok: true });
});

// GET /api/users/permissions/catalog — canonical permission keys + the workspace's roles, for the
// account/role editors (public/js/lib/access-editor.js) so the frontend never hand-copies them.
// `grantable` / `assignableRoles` tell the editor what THIS caller may change: everything for
// users.manage, the staff-level subset for an HR-only caller.
router.get('/permissions/catalog', requireAnyPermission(['users.manage', 'hr.manage']), (req, res) => {
  const full = req.user!.permissions.includes('users.manage');
  const roles = listRoles();
  res.json({
    permissions: ALL_PERMISSIONS,
    staffPermissions: STAFF_PERMISSIONS,
    roles,
    roleDefaults: Object.fromEntries(roles.map((r) => [r.key, r.permissions])),
    grantable: full ? ALL_PERMISSIONS : STAFF_PERMISSIONS,
    assignableRoles: roles.filter((r) => full || r.staff).map((r) => r.key),
  });
});

// GET /api/users/:id/access — role + overrides for one account (the directory listing hides
// permission_overrides from non-users.manage callers; HR's Access editor needs them).
router.get('/:id/access', requireAnyPermission(['users.manage', 'hr.manage']), (req, res) => {
  const user = queryOne<Pick<UserRow, 'id' | 'username' | 'full_name' | 'role'> & { permission_overrides: string }>(
    'SELECT id, username, full_name, role, permission_overrides FROM users WHERE id = ?',
    Number(req.params.id)
  );
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// PUT /api/users/:id/permissions — save sparse permission overrides for a user. An HR-only
// caller may only edit staff-role accounts, and only change STAFF_PERMISSIONS keys.
router.put('/:id/permissions', requireAnyPermission(['users.manage', 'hr.manage']), syncClass('online'), (req, res) => {
  const id = Number(req.params.id);
  const user = queryOne<{ id: number; role: Role; permission_overrides: string }>(
    'SELECT id, role, permission_overrides FROM users WHERE id = ?', id);
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
  if (!req.user!.permissions.includes('users.manage')) {
    if (!getRole(user.role)?.staff) {
      res.status(403).json({ error: 'HR can only change access on staff-role accounts' });
      return;
    }
    let current: Record<string, boolean> = {};
    try { current = JSON.parse(user.permission_overrides || '{}'); } catch { /* treat as none */ }
    const grantable = new Set<string>(STAFF_PERMISSIONS);
    const blocked = ALL_PERMISSIONS.filter((k) => !grantable.has(k) && clean[k] !== current[k]);
    if (blocked.length) {
      res.status(403).json({ error: `HR can't change these permissions: ${blocked.join(', ')}` });
      return;
    }
  }
  run('UPDATE users SET permission_overrides = ? WHERE id = ?', JSON.stringify(clean), id);
  if (JSON.stringify(clean) !== user.permission_overrides) endUserSessions(id, 'revoked');
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
router.post('/departments', requireAnyPermission(['users.manage', 'hr.manage']), syncClass('claim'), (req, res) => {
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
    `SELECT d.id, d.name, d.head_user_id,
            h.full_name AS head_name,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count,
            (SELECT COUNT(*) FROM inventory_items i WHERE i.department_id = d.id) AS item_count,
            (SELECT COUNT(*) FROM forms f WHERE f.department_id = d.id) AS form_count
     FROM departments d
     LEFT JOIN users h ON h.id = d.head_user_id
     ORDER BY d.name COLLATE NOCASE`
  );
  res.json(rows);
});

// PUT /api/users/departments/:id
router.put('/departments/:id', requirePermission('users.manage'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const dept = queryOne('SELECT id FROM departments WHERE id = ?', id);
  if (!dept) {
    res.status(404).json({ error: 'Department not found' });
    return;
  }
  const { name, head_user_id } = parseBody(updateDepartmentSchema, req.body);
  const clash = queryOne('SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND id != ?', name, id);
  if (clash) {
    res.status(409).json({ error: 'Another department already uses that name' });
    return;
  }
  if (head_user_id !== undefined) {
    if (head_user_id !== null && !queryOne('SELECT id FROM users WHERE id = ? AND active = 1', head_user_id)) {
      res.status(400).json({ error: 'Department head must be an active user' });
      return;
    }
    run('UPDATE departments SET name = ?, head_user_id = ? WHERE id = ?', name, head_user_id, id);
  } else {
    run('UPDATE departments SET name = ? WHERE id = ?', name, id);
  }
  res.json({ ok: true });
});

// DELETE /api/users/departments/:id — FK is ON DELETE SET NULL. users.manage can delete any
// department; hr.manage-only callers can delete one only if nothing outside HR's own domain
// (user accounts, inventory items, files) references it — employees are fine, since that's
// HR's own domain and just unassigns them, same as a users.manage delete would.
router.delete('/departments/:id', requireAnyPermission(['users.manage', 'hr.manage']), syncClass('claim'), (req, res) => {
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
