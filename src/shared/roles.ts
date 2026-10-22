/**
 * The workspace's roles — named permission bundles kept in the `roles` table (schema + first-run
 * seed in db.ts). An account's effective permissions are its role's bundle with its own sparse
 * overrides applied (permissions.ts resolvePermissions). Every place that turns an account into a
 * permission list goes through userPermissions() here, so an edit to a role takes effect for
 * everyone holding it on their next request.
 *
 * Managed by src/core/roles.routes.ts (Admin → Accounts → Roles).
 */
import { queryOne, queryAll } from './db';
import {
  ADMIN_ROLE, ALL_PERMISSIONS, cleanPermissionList, isStaffRole, resolvePermissions,
} from './permissions';
import type { Permission, Role } from './types';

export interface RoleRecord {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
  sort_order: number;
  /** 'admin' only — its permissions are always everything and it can't be renamed or deleted. */
  fixed: boolean;
  /** HR (hr.manage without users.manage) may assign it: every permission in it is staff-level. */
  staff: boolean;
  user_count: number;
}

interface RoleRow { key: string; label: string; description: string; permissions: string; sort_order: number }

function parseList(json: string): Permission[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? cleanPermissionList(v.map(String)) : [];
  } catch { return []; }
}

function toRecord(r: RoleRow, userCount: number): RoleRecord {
  const fixed = r.key === ADMIN_ROLE;
  const permissions = fixed ? [...ALL_PERMISSIONS] : parseList(r.permissions);
  return {
    key: r.key, label: r.label, description: r.description, permissions, sort_order: r.sort_order,
    fixed, staff: isStaffRole(r.key, permissions), user_count: userCount,
  };
}

/** Every role, admin first then by sort order / label, with how many accounts hold each. */
export function listRoles(): RoleRecord[] {
  const counts = new Map(
    queryAll<{ role: string; c: number }>('SELECT role, COUNT(*) AS c FROM users GROUP BY role').map((r) => [r.role, r.c]));
  return queryAll<RoleRow>(
    `SELECT key, label, description, permissions, sort_order FROM roles
     ORDER BY key = ? DESC, sort_order, label COLLATE NOCASE`, ADMIN_ROLE)
    .map((r) => toRecord(r, counts.get(r.key) ?? 0));
}

export function getRole(key: string): RoleRecord | null {
  const r = queryOne<RoleRow>('SELECT key, label, description, permissions, sort_order FROM roles WHERE key = ?', key);
  if (!r) return null;
  const c = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE role = ?', key)!.c;
  return toRecord(r, c);
}

/** The role's permission bundle. A key with no row (shouldn't happen — seed adds one for every
    key an account holds) gets nothing beyond what its overrides grant. */
export function rolePermissions(role: Role): Permission[] {
  if (role === ADMIN_ROLE) return [...ALL_PERMISSIONS];
  const r = queryOne<{ permissions: string }>('SELECT permissions FROM roles WHERE key = ?', role);
  return r ? parseList(r.permissions) : [];
}

/** An account's effective permissions: its role's bundle with its own overrides applied. */
export function userPermissions(role: Role, overrides: Record<string, boolean> = {}): Permission[] {
  return resolvePermissions(role, overrides, rolePermissions(role));
}

/** Whether an HR-only caller may give an account this role (see permissions.ts isStaffRole). */
export function isHrAssignableRole(key: string): boolean {
  const r = getRole(key);
  return !!r && r.staff;
}
