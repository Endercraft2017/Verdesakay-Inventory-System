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
  'accounting.view', 'accounting.manage',
  'audit.view',
  'mail.send',
  'announce',
  'qc.configure',
  'delivery.run', 'delivery.manage',
  'production.repairs', 'production.record', 'production.inspect_qc', 'production.inspect_qa',
  'production.receive',
  'orders.release',
];

/** Canonical role list — the single source of truth for iterating all roles. */
export const ROLES: Role[] = [
  'admin', 'admin_staff', 'accounting', 'warehouse', 'releasing', 'csr', 'hr', 'marketing',
  'parts_clerk', 'production_lead', 'qc_inspector', 'qa_inspector', 'receiving_clerk',
  'releasing_clerk',
];

const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  admin_staff: [
    'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload', 'forms.delete', 'forms.manage.admin',
    'messages.view', 'messages.send',
    'templates.view',
    'accounting.view',
    'mail.send',
    'announce',
    'delivery.manage',
  ],
  accounting: [
    'inventory.view',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload', 'forms.manage.accounting',
    'messages.view', 'messages.send',
    'templates.view',
    'accounting.view', 'accounting.manage',
  ],
  warehouse: [
    'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust', 'inventory.mobile',
    'orders.view',
    'forms.view', 'forms.upload', 'forms.manage.inventory',
    'messages.view', 'messages.send',
    'delivery.run',
  ],
  releasing: [
    'inventory.view', 'inventory.adjust',
    'orders.view', 'orders.create', 'orders.edit',
    'forms.view', 'forms.upload',
    'messages.view', 'messages.send',
    'templates.view',
    'delivery.run', 'delivery.manage',
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
  // ---- Narrow shop-floor roles (mobile-first) — see the Role type's doc comment. Each
  // gets inventory.view (browse) + inventory.mobile (reach the mobile Production tab) +
  // exactly the one production.* permission its task needs, plus baseline messaging.
  // 'warehouse'/'admin'/'admin_staff'/'releasing' already satisfy every production.*
  // requireAnyPermission check via their existing inventory.adjust, so granting these
  // to those roles isn't needed for anything to keep working.
  parts_clerk: [
    'inventory.view', 'inventory.mobile', 'production.repairs',
    'messages.view', 'messages.send',
  ],
  production_lead: [
    'inventory.view', 'inventory.mobile', 'production.record',
    'messages.view', 'messages.send',
  ],
  // QC (first pass, technical/performance) and QA (final pass, appearance) are separate
  // people in this permission model, matching the pipeline's own stage split — see
  // job-orders.routes.ts POST /:id/units/inspect, which checks the *specific* pass being
  // recorded against production.inspect_qc/qa (a single-stage job order's one combined
  // pass accepts either, since it runs both checklists together).
  qc_inspector: [
    'inventory.view', 'inventory.mobile', 'production.inspect_qc',
    'messages.view', 'messages.send',
  ],
  qa_inspector: [
    'inventory.view', 'inventory.mobile', 'production.inspect_qa',
    'messages.view', 'messages.send',
  ],
  receiving_clerk: [
    'inventory.view', 'inventory.mobile', 'production.receive',
    'messages.view', 'messages.send',
  ],
  // Same narrowing, orders module — see orders.routes.ts POST /:id/release[/unreserve].
  // Mobile-only account for scanning/entering goods out against an approved sale order,
  // without the broad inventory.adjust 'releasing' otherwise needs for that same action.
  releasing_clerk: [
    'inventory.view', 'inventory.mobile', 'orders.view', 'orders.release',
    'messages.view', 'messages.send',
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
