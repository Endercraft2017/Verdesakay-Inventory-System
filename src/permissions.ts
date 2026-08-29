/**
 * Role defaults and effective-permission resolver.
 * Routes call requirePermission('module.action') from auth.ts.
 * Admins can override individual permissions per user via PUT /users/:id/permissions
 * (stored as a sparse JSON diff in users.permission_overrides).
 */
import type { Role, Permission } from './types';

export const ALL_PERMISSIONS: Permission[] = [
  'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete',
  'inventory.adjust', 'inventory.configure', 'inventory.mobile',
  'orders.view', 'orders.create', 'orders.edit', 'orders.delete',
  'forms.view', 'forms.upload', 'forms.delete',
  'forms.manage.hr', 'forms.manage.inventory', 'forms.manage.admin', 'forms.manage.accounting',
  'messages.view', 'messages.send',
  'templates.view', 'templates.edit', 'templates.company',
  'users.manage',
  'hr.view', 'hr.manage',
  'audit.view',
  'mail.send',
  'announce',
  'qc.configure',
];

/** Canonical role list — the single source of truth for iterating all roles. */
export const ROLES: Role[] = [
  'admin', 'admin_staff', 'accounting', 'warehouse', 'releasing', 'csr', 'hr', 'marketing',
];

const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  admin_staff: [
    'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload', 'forms.delete', 'forms.manage.admin',
    'messages.view', 'messages.send',
    'templates.view',
    'mail.send',
    'announce',
  ],
  accounting: [
    'inventory.view',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload', 'forms.manage.accounting',
    'messages.view', 'messages.send',
    'templates.view',
  ],
  warehouse: [
    'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust', 'inventory.mobile',
    'orders.view',
    'forms.view', 'forms.upload', 'forms.manage.inventory',
    'messages.view', 'messages.send',
  ],
  releasing: [
    'inventory.view', 'inventory.adjust',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload',
    'messages.view', 'messages.send',
    'templates.view',
  ],
  csr: [
    'inventory.view',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload',
    'messages.view', 'messages.send',
    'templates.view',
  ],
  hr: [
    'forms.view', 'forms.upload', 'forms.delete', 'forms.manage.hr',
    'messages.view', 'messages.send',
    'templates.view',
    'hr.view', 'hr.manage',
    'announce',
  ],
  marketing: [
    'forms.view', 'forms.upload',
    'messages.view', 'messages.send',
    'templates.view',
    'announce',
  ],
};

/**
 * Compute effective permissions by merging role defaults with per-user overrides.
 * overrides is a sparse map: true = explicitly grant, false = explicitly revoke.
 * Missing key = use role default.
 */
export function resolvePermissions(
  role: Role,
  overrides: Record<string, boolean> = {}
): Permission[] {
  const defaults = new Set<string>(ROLE_DEFAULTS[role] ?? []);
  const result: Permission[] = [];
  for (const p of ALL_PERMISSIONS) {
    const ov = overrides[p];
    if (ov === true) result.push(p);
    else if (ov === false) { /* explicitly revoked */ }
    else if (defaults.has(p)) result.push(p);
  }
  return result;
}

/** Default permission list for a role with no overrides applied. */
export function roleDefaults(role: Role): Permission[] {
  return [...(ROLE_DEFAULTS[role] ?? [])];
}

/** Default permissions for every role, keyed by role — for admin UI display. */
export function allRoleDefaults(): Record<Role, Permission[]> {
  const out = {} as Record<Role, Permission[]>;
  for (const role of ROLES) out[role] = roleDefaults(role);
  return out;
}
