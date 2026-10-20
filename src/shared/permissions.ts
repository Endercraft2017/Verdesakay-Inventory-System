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
  'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.review_counts', 'inventory.costs', 'production.work_all', 'production.plan', 'production.kit_release', 'production.configure', 'evidence.manage', 'orders.approve', 'orders.authorize', 'orders.configure', 'orders.override_release', 'orders.direct_sale', 'purchasing.approve_bills', 'purchasing.override_match', 'purchasing.issue_cash', 'purchasing.settle_requests', 'accounting.post', 'accounting.record_payments', 'accounting.configure', 'payroll.approve', 'payroll.pay', 'payroll.rates', 'payroll.configure', 'users.permissions', 'security.manage', 'workspace.manage', 'returns.receive', 'returns.inspect', 'returns.dispose', 'forms.variables', 'hr.timekeeping.view', 'hr.timekeeping.manage', 'hr.kiosk',
  'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete',
  'inventory.adjust', 'inventory.configure', 'inventory.mobile',
  'orders.view', 'orders.create', 'orders.edit', 'orders.delete',
  'purchasing.view', 'purchasing.manage', 'purchasing.request', 'purchasing.approve_requests',
  'forms.view', 'forms.upload', 'forms.delete',
  'forms.fill.inventory', 'forms.manage.hr', 'forms.manage.inventory', 'forms.manage.admin', 'forms.manage.accounting',
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
const BASELINE: Permission[] = ['mobile.access', 'messages.view', 'messages.send', 'purchasing.request'];

/** Seeds for a workspace's roles table (inserted once, when the table is empty — see db.ts seed()).
    Order is the order roles are listed in. */
export const BUILTIN_ROLES: RoleSeed[] = [
  { key: 'admin', label: 'Administrator', description: 'Everything, including accounts and roles. Cannot be changed.',
    permissions: [...ALL_PERMISSIONS] },
  { key: 'admin_staff', label: 'Admin Staff', description: 'Office documents, templates, messaging and announcements; operational duties are granted separately.',
    permissions: [...BASELINE, 'forms.view', 'forms.upload', 'forms.manage.admin', 'templates.view', 'announce'] },
  { key: 'accounting', label: 'Accounting', description: 'Books, tax filings, AP/AR, and the orders behind them.',
    permissions: [
      ...BASELINE,
      'inventory.view', 'production.view',
      'orders.view', 'purchasing.view',
      'forms.view', 'forms.upload', 'forms.manage.accounting',
      'templates.view',
      'accounting.view', 'accounting.manage', 'inventory.costs',
    ] },
  { key: 'warehouse', label: 'Warehouseman', description: 'Receives supplier stock, transfers stock, releases production kits, issues requested parts and submits counts. No unrestricted correction, direct sale, quality inspection or master-data design.',
    permissions: [...BASELINE, 'inventory.view', 'inventory.mobile', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'orders.view', 'purchasing.view', 'production.kit_release', 'production.repairs', 'returns.receive', 'forms.view', 'forms.fill.inventory'] },
  { key: 'releasing', label: 'Releasing', description: 'Physical fulfillment of approved sales. Commercial approval, purchasing and stock correction are separate.',
    permissions: [...BASELINE, 'orders.view', 'orders.release', 'inventory.view', 'returns.receive'] },
  { key: 'csr', label: 'CSR — Customer Service', description: 'Customers, sales-order preparation, tracking and customer follow-up. No purchasing, stock movement, approval or financial posting.',
    permissions: [...BASELINE, 'inventory.view', 'orders.view', 'orders.create', 'orders.edit', 'forms.view', 'forms.upload', 'templates.view'] },
  { key: 'hr', label: 'HR', description: 'Personnel, timekeeping, memos and anonymous reports. Payroll is a separate role.',
    permissions: [
      ...BASELINE,
      'forms.view', 'forms.upload', 'forms.manage.hr',
      'templates.view',
      'hr.view', 'hr.manage',
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
  // ---- Narrow shop-floor roles (mobile-first): each sees only its own desk — the phone app plus
  // exactly the permission the task needs, and the reads that desk needs open to that permission
  // (shared/desk-access.ts); the phone's Work row, Quick Orbit action and Production tab follow the
  // desk permission too. Deliberately no inventory.mobile (warehouse phone tools), inventory.view or
  // production.view: the item catalogue, suppliers, every job order and production issues only if
  // an admin ticks them in Roles (user decision 2026-10-06). Stock adjustment does not grant desk access.
  { key: 'parts_clerk', label: 'Parts Clerk', description: 'Accepts or rejects repair parts requests.',
    permissions: [...BASELINE, 'production.repairs'] },
  { key: 'production_lead', label: 'Production Lead', description: 'Records finished units off the line.',
    permissions: [...BASELINE, 'production.record'] },
  // Lead capabilities plus controlled line decisions — pause / resume / close early, each with a
  // required reason kept in job_order_events. Deliberately NOT inventory.adjust: no parts release,
  // cancel, delete or stock adjustment (see job-orders.routes.ts gates).
  { key: 'production_manager', label: 'Production Manager', description: 'Lead + pause / resume / close early + QA hold decisions.',
    permissions: [...BASELINE, 'production.work_all', 'production.record', 'production.pause', 'production.manage', 'production.qa_review'] },
  // QC (first pass) and QA (final pass) are separate people, matching the pipeline's own stage
  // split — job-orders.routes.ts POST /:id/units/inspect checks the specific pass being recorded.
  { key: 'qc_inspector', label: 'QC Inspector', description: 'First-pass (technical) inspection.',
    permissions: [...BASELINE, 'production.inspect_qc'] },
  { key: 'qa_inspector', label: 'QA Inspector', description: 'Final-pass (appearance) inspection.',
    permissions: [...BASELINE, 'production.inspect_qa'] },
  { key: 'receiving_clerk', label: 'Products In Clerk', description: 'Receives QC/QA-passed units into stock.',
    permissions: [...BASELINE, 'production.receive'] },
  // Same narrowing, orders module — orders.routes.ts POST /:id/release[/unreserve].
  { key: 'releasing_clerk', label: 'Releasing Clerk', description: 'Scans approved sale orders out.',
    permissions: [...BASELINE, 'orders.view', 'orders.release'] },
  { key: 'employee', label: 'Employee', description: 'Personal employee services and purchase requests.', permissions: [...BASELINE] },
  { key: 'csr_supervisor', label: 'CSR Supervisor', description: 'Reviews sales and authorizes customer release; does not release stock or run purchasing.', permissions: [...BASELINE, 'inventory.view', 'orders.view', 'orders.create', 'orders.edit', 'orders.approve', 'orders.authorize', 'forms.view', 'templates.view'] },
  { key: 'warehouse_supervisor', label: 'Warehouse Supervisor', description: 'Stock corrections and count review, with separate counter and reviewer.', permissions: [...BASELINE, 'inventory.view', 'inventory.mobile', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.review_counts', 'production.kit_release', 'production.repairs', 'orders.view', 'purchasing.view', 'returns.receive'] },
  { key: 'buyer', label: 'Buyer', description: 'Prepares supplier purchase orders and bills; approval and cash custody are separate.', permissions: [...BASELINE, 'purchasing.view', 'purchasing.manage', 'inventory.view', 'inventory.costs'] },
  { key: 'purchase_approver', label: 'Purchase Approver', description: 'Approves independent purchase requests and vendor bills; no purchasing preparation.', permissions: [...BASELINE, 'purchasing.view', 'purchasing.approve_requests', 'purchasing.approve_bills', 'inventory.costs'] },
  { key: 'cash_custodian', label: 'Cash Custodian', description: 'Records cash handoffs and independently reviews purchase settlements.', permissions: [...BASELINE, 'purchasing.view', 'purchasing.issue_cash', 'purchasing.settle_requests'] },
  { key: 'finance_approver', label: 'Finance Approver', description: 'Reviews and posts accounting entries; records financial payments.', permissions: [...BASELINE, 'accounting.view', 'inventory.costs', 'accounting.post', 'accounting.record_payments', 'payroll.view', 'payroll.approve', 'payroll.pay'] },
  { key: 'payroll_processor', label: 'Payroll Processor', description: 'Prepares payroll; approval, payment confirmation and pay-policy administration are separate.', permissions: [...BASELINE, 'payroll.view', 'payroll.manage', 'hr.timekeeping.view'] },
  { key: 'timekeeper', label: 'Timekeeper', description: 'Attendance and cutoff administration without private HR or payroll access.', permissions: [...BASELINE, 'hr.timekeeping.view', 'hr.timekeeping.manage'] },
  { key: 'kiosk_operator', label: 'Kiosk Operator', description: 'Records attendance and field punches on approved office devices.', permissions: [...BASELINE, 'hr.kiosk'] },
  { key: 'driver', label: 'Driver', description: 'Assigned delivery runs and proof of delivery.', permissions: [...BASELINE, 'delivery.run'] },
  { key: 'dispatcher', label: 'Dispatcher', description: 'Delivery scheduling and assignment.', permissions: [...BASELINE, 'delivery.manage', 'orders.view'] },
  { key: 'auditor', label: 'Auditor', description: 'Redacted audit metadata; business reports require their separate read permissions.', permissions: [...BASELINE, 'audit.view'] },
  { key: 'account_support', label: 'Account Support', description: 'Provisions and resets staff accounts; role grants and security administration are separate.', permissions: [...BASELINE, 'users.manage'] },
  { key: 'security_admin', label: 'Security Administrator', description: 'Manages account grants, security and workspace configuration.', permissions: [...BASELINE, 'users.manage', 'users.permissions', 'security.manage', 'workspace.manage', 'audit.view'] },
  { key: 'production_planner', label: 'Production Planner', description: 'Prepares production plans and schedules; approval and kit release remain separate.', permissions: [...BASELINE,'inventory.view','production.view','production.plan','production.configure'] },
  { key: 'quality_supervisor', label: 'Quality Supervisor', description: 'Quality configuration, returned-goods inspection and QA-hold review.', permissions: [...BASELINE,'inventory.view','production.view','qc.configure','production.qa_review', 'returns.inspect', 'returns.dispose'] },

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
  'inventory.receive','inventory.transfer','inventory.count','production.kit_release','returns.receive',
  'orders.view', 'orders.create', 'orders.edit', 'orders.release',
  'purchasing.view', 'purchasing.request',
  'forms.view', 'forms.upload', 'forms.fill.inventory', 'forms.manage.inventory',
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
