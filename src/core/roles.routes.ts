/**
 * Roles — the workspace's named permission bundles (src/shared/roles.ts), edited under
 * Admin → Accounts → Roles. Giving an account a role gives it that bundle; per-account overrides
 * (PUT /api/users/:id/permissions) still adjust one person on top. Editing a role changes every
 * account holding it from their next request.
 *
 *   GET    /api/roles          users.manage or hr.manage (HR's create-account picker reads it)
 *   POST   /api/roles          users.manage — new role { label, key?, description?, permissions[] }
 *   PUT    /api/roles/:key     users.manage — rename / re-describe / change its permissions
 *   DELETE /api/roles/:key     users.manage — only once no account holds it
 *
 * 'admin' is fixed: always every permission, never renamed or deleted. Changes are `online`
 * (account access is credentials — OFFLINE-FIRST D8), same as the users routes.
 */
import { Router } from 'express';
import { queryOne, run } from '../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../shared/auth';
import { parseBody, createRoleSchema, updateRoleSchema } from '../shared/validation';
import { ADMIN_ROLE, cleanPermissionList } from '../shared/permissions';
import { listRoles, getRole } from '../shared/roles';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);

router.get('/', requireAnyPermission(['users.manage', 'hr.manage']), (_req, res) => {
  res.json(listRoles());
});

/** "Line Supervisor" → "line_supervisor", made unique against existing keys. */
function keyFromLabel(label: string): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role')
    .replace(/^(\d)/, 'r_$1').slice(0, 36);
  let key = base.length >= 2 ? base : `role_${base}`;
  for (let n = 2; queryOne('SELECT 1 FROM roles WHERE key = ?', key); n++) key = `${base}_${n}`;
  return key;
}

router.post('/', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const input = parseBody(createRoleSchema, req.body);
  if (queryOne('SELECT 1 FROM roles WHERE label = ? COLLATE NOCASE', input.label)) {
    res.status(409).json({ error: `A role named "${input.label}" already exists` });
    return;
  }
  if (input.key && queryOne('SELECT 1 FROM roles WHERE key = ?', input.key)) {
    res.status(409).json({ error: `Role key "${input.key}" is already used` });
    return;
  }
  const key = input.key ?? keyFromLabel(input.label);
  const order = queryOne<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM roles')!.n;
  run('INSERT INTO roles (key, label, description, permissions, sort_order) VALUES (?, ?, ?, ?, ?)',
    key, input.label, input.description, JSON.stringify(cleanPermissionList(input.permissions)), order);
  res.status(201).json(getRole(key));
});

router.put('/:key', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const role = getRole(String(req.params.key));
  if (!role) {
    res.status(404).json({ error: 'Role not found' });
    return;
  }
  if (role.fixed) {
    res.status(400).json({ error: 'The Administrator role always has every permission and cannot be changed' });
    return;
  }
  const input = parseBody(updateRoleSchema, req.body);
  if (input.label !== undefined
    && queryOne('SELECT 1 FROM roles WHERE label = ? COLLATE NOCASE AND key != ?', input.label, role.key)) {
    res.status(409).json({ error: `A role named "${input.label}" already exists` });
    return;
  }
  run(`UPDATE roles SET label = ?, description = ?, permissions = ?, updated_at = datetime('now') WHERE key = ?`,
    input.label ?? role.label,
    input.description ?? role.description,
    JSON.stringify(input.permissions !== undefined ? cleanPermissionList(input.permissions) : role.permissions),
    role.key);
  res.json(getRole(role.key));
});

router.delete('/:key', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  const role = getRole(String(req.params.key));
  if (!role) {
    res.status(404).json({ error: 'Role not found' });
    return;
  }
  if (role.key === ADMIN_ROLE) {
    res.status(400).json({ error: 'The Administrator role cannot be deleted' });
    return;
  }
  if (role.user_count > 0) {
    res.status(409).json({
      error: `${role.user_count} account${role.user_count === 1 ? ' still has' : 's still have'} this role — move them to another role first`,
      user_count: role.user_count,
    });
    return;
  }
  run('DELETE FROM roles WHERE key = ?', role.key);
  res.json({ ok: true });
});

export default router;
