/**
 * Permission catalog, the built-in role seeds and the effective-permission resolver.
 * Routes call requirePermission('module.action') from auth.ts.
 *
 * Roles are tenant data: each workspace keeps its own in the `roles` table (src/shared/roles.ts,
 * edited under Admin → Accounts → Roles). A role is just a named bundle of permissions; an
 * account gets its role's bundle plus a sparse per-user diff (users.permission_overrides, saved
 * by PUT /users/:id/permissions). BUILTIN_ROLES below only seeds a new workspace's roles table —
 * after that the tenant edits them freely. Only `admin` is fixed: it always holds everything.
 *
 * This file is pure (no DB) so it can be unit-tested and imported by db.ts's seed.
 */
import type { Role, Permission } from './types';

export const ALL_PERMISSIONS: Permission[] = [
  'mobile.access',
  'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete',
  'inventory.adjust', 'inventory.configure', 'inventory.mobile',
  'orders.view', 'orders.create', 'orders.edit', 'orders.delete',
  'purchasing.view', 'purchasing.manage',
  'forms.view', 'forms.upload', 'forms.delete',
  'forms.manage.hr', 'forms.manage.inventory', 'forms.manage.admin', 'forms.manage.accounting',
  'messages.view', 'messages.send',
  'templates.view', 'templates.edit', 'templates.company',
  'users.manage',
  'hr.view', 'hr.manage',
  'payroll.view', 'payroll.manage',
  'accounting.view', 'accounting.manage',
  'audit.view',
  'reports.confidential',
  'mail.send',
  'announce',
  'qc.configure',
  'delivery.run', 'delivery.manage',
  'production.view',
  'production.approve', 'production.pause', 'production.manage', 'production.repairs', 'production.record', 'production.inspect_qc', 'production.inspect_qa',
  'production.qa_review', 'production.receive',
  'orders.release',
];

/** The one role whose permissions can't be edited or removed: it always holds every permission,
    so a workspace can never lock itself out of Admin → Accounts. */
export const ADMIN_ROLE = 'admin';

export interface RoleSeed {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
}

/** Every account starts with the phone app — Clock, Inbox, payslips and requests are for everyone.
    An administrator can still untick it on a role or one account. */
const BASELINE: Permission[] = ['mobile.access', 'messages.view', 'messages.send'];

/** Seeds for a workspace's roles table (inserted once, when the table is empty — see db.ts seed()).
    Order is the order roles are listed in. */
export const BUILTIN_ROLES: RoleSeed[] = [
  { key: 'admin', label: 'Administrator', description: 'Everything, including accounts and roles. Cannot be changed.',
    permissions: [...ALL_PERMISSIONS] },
  { key: 'admin_staff', label: 'Admin Staff', description: 'Office administration: items, orders, files, deliveries, announcements.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view', 'inventory.create', 'inventory.edit', 'inventory.adjust',
      'orders.view', 'orders.create', 'orders.edit', 'purchasing.view', 'purchasing.manage',
      'forms.view', 'forms.upload', 'forms.delete', 'forms.manage.admin',
      'templates.view',
      'accounting.view',
      'mail.send',
      'announce',
      'delivery.manage',
    ] },
  { key: 'accounting', label: 'Accounting', description: 'Books, tax filings, AP/AR, and the orders behind them.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view',
      'orders.view', 'orders.create', 'orders.edit', 'purchasing.view', 'purchasing.manage',
      'forms.view', 'forms.upload', 'forms.manage.accounting',
      'templates.view',
      'accounting.view', 'accounting.manage',
    ] },
  { key: 'warehouse', label: 'Warehouse', description: 'Stock in/out, adjustments and the phone warehouse tools.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view', 'inventory.create', 'inventory.edit', 'inventory.adjust', 'inventory.mobile',
      'orders.view', 'purchasing.view',
      'forms.view', 'forms.upload', 'forms.manage.inventory',
      'delivery.run',
    ] },
  { key: 'releasing', label: 'Releasing', description: 'Sale orders out the door and deliveries.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view', 'inventory.adjust',
      'orders.view', 'orders.create', 'orders.edit', 'purchasing.view', 'purchasing.manage',
      'forms.view', 'forms.upload',
      'templates.view',
      'delivery.run', 'delivery.manage',
    ] },
  { key: 'csr', label: 'Customer Service', description: 'Customers and sale orders.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view',
      'orders.view', 'orders.create', 'orders.edit', 'purchasing.view', 'purchasing.manage',
      'forms.view', 'forms.upload',
      'templates.view',
    ] },
  { key: 'hr', label: 'HR', description: 'Employees, timekeeping, payroll, memos and anonymous reports.',
    permissions: [
      ...BASELINE,
      'forms.view', 'forms.upload', 'forms.delete', 'forms.manage.hr',
      'templates.view',
      'hr.view', 'hr.manage',
      'payroll.view', 'payroll.manage',
      'announce',
      'reports.confidential',
    ] },
  { key: 'marketing', label: 'Marketing', description: 'Files, templates and announcements.',
    permissions: [
      ...BASELINE,
      'forms.view', 'forms.upload',
      'templates.view',
      'announce',
    ] },
  // ---- Narrow shop-floor roles (mobile-first): inventory.view (browse) + inventory.mobile (the
  // phone's Work tools) + exactly the production.* permission the task needs. 'warehouse',
  // 'admin_staff' and 'releasing' already pass every production.* requireAnyPermission check
  // through inventory.adjust.
  { key: 'parts_clerk', label: 'Parts Clerk', description: 'Accepts or rejects repair parts requests.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.repairs'] },
  { key: 'production_lead', label: 'Production Lead', description: 'Records finished units off the line.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.record'] },
  // Lead capabilities plus controlled line decisions — pause / resume / close early, each with a
  // required reason kept in job_order_events. Deliberately NOT inventory.adjust: no parts release,
  // cancel, delete or stock adjustment (see job-orders.routes.ts gates).
  { key: 'production_manager', label: 'Production Manager', description: 'Lead + pause / resume / close early + QA hold decisions.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.record', 'production.pause', 'production.manage', 'production.qa_review'] },
  // QC (first pass) and QA (final pass) are separate people, matching the pipeline's own stage
  // split — job-orders.routes.ts POST /:id/units/inspect checks the specific pass being recorded.
  { key: 'qc_inspector', label: 'QC Inspector', description: 'First-pass (technical) inspection.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.inspect_qc'] },
  { key: 'qa_inspector', label: 'QA Inspector', description: 'Final-pass (appearance) inspection.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.inspect_qa'] },
  { key: 'receiving_clerk', label: 'Products In Clerk', description: 'Receives QC/QA-passed units into stock.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'production.receive'] },
  // Same narrowing, orders module — orders.routes.ts POST /:id/release[/unreserve].
  { key: 'releasing_clerk', label: 'Releasing Clerk', description: 'Scans approved sale orders out.',
    permissions: [...BASELINE, 'inventory.view', 'production.view', 'inventory.mobile', 'orders.view', 'orders.release'] },
];

const SEED_BY_KEY = new Map(BUILTIN_ROLES.map((r) => [r.key, r]));

/** Built-in role keys, in listing order. */
export const ROLES: Role[] = BUILTIN_ROLES.map((r) => r.key);

/** Staff-level permissions: what an hr.manage user WITHOUT users.manage may hand out — on a
    per-account override, or by assigning a role made only of these. Nothing here manages
    accounts, HR, payroll or the books, so HR can onboard and widen floor staff but can never mint
    an admin, another HR user or accounting. (This is exactly what the built-in staff roles carried
    before roles became editable, plus the phone-app baseline.) */
export const STAFF_PERMISSIONS: Permission[] = [
  'mobile.access', 'messages.view', 'messages.send',
  'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust', 'inventory.mobile',
  'orders.view', 'orders.create', 'orders.edit', 'orders.release',
  'purchasing.view', 'purchasing.manage',
  'forms.view', 'forms.upload', 'forms.manage.inventory',
  'templates.view',
  'announce',
  'delivery.run', 'delivery.manage',
  'production.view', 'production.repairs', 'production.record', 'production.pause', 'production.manage',
  'production.qa_review', 'production.inspect_qc', 'production.inspect_qa', 'production.receive',
];
/** Same list as STAFF_PERMISSIONS, under the name existing callers use. */
export const HR_GRANTABLE_PERMISSIONS = STAFF_PERMISSIONS;

/** Whether HR (without users.manage) may assign a role with these permissions: never admin, and
    only when every permission in it is staff-level. Works the same for custom roles. */
export function isStaffRole(key: string, permissions: readonly string[]): boolean {
  if (key === ADMIN_ROLE) return false;
  const staff = new Set<string>(STAFF_PERMISSIONS);
  return permissions.every((p) => staff.has(p));
}

/** Built-in roles HR may assign (by the rule above). The live list comes from the roles table. */
export const HR_ASSIGNABLE_ROLES: Role[] = BUILTIN_ROLES
  .filter((r) => isStaffRole(r.key, r.permissions)).map((r) => r.key);

/** Drop unknown keys and duplicates, keeping catalog order. */
export function cleanPermissionList(list: readonly string[]): Permission[] {
  const want = new Set(list);
  return ALL_PERMISSIONS.filter((p) => want.has(p));
}

/**
 * Effective permissions: the role's bundle with per-user overrides applied.
 * overrides is a sparse map: true = explicitly grant, false = explicitly revoke; missing key =
 * the role's setting. `base` is the role's permission list — callers with a database pass the
 * tenant's (src/shared/roles.ts userPermissions does); omitted, the built-in seed is used.
 * Admin always gets everything.
 */
export function resolvePermissions(
  role: Role,
  overrides: Record<string, boolean> = {},
  base?: readonly string[]
): Permission[] {
  if (role === ADMIN_ROLE) return [...ALL_PERMISSIONS];
  const defaults = new Set<string>(base ?? SEED_BY_KEY.get(role)?.permissions ?? []);
  const result: Permission[] = [];
  for (const p of ALL_PERMISSIONS) {
    const ov = overrides[p];
    if (ov === true) result.push(p);
    else if (ov === false) { /* explicitly revoked */ }
    else if (defaults.has(p)) result.push(p);
  }
  return result;
}

/** Built-in seed permission list for a role (no overrides, not the tenant's edited version). */
export function roleDefaults(role: Role): Permission[] {
  return [...(SEED_BY_KEY.get(role)?.permissions ?? [])];
}
