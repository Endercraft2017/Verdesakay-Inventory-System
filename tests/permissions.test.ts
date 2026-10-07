/** Permission catalog: the mobile-app gate key exists and lands in the right roles. */
import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, roleDefaults, resolvePermissions } from '../src/shared/permissions';

describe('inventory.mobile permission', () => {
  it('is part of the canonical catalog', () => {
    expect(ALL_PERMISSIONS).toContain('inventory.mobile');
  });

  it('is a default for warehouse and admin, not for hr', () => {
    expect(roleDefaults('warehouse')).toContain('inventory.mobile');
    expect(roleDefaults('admin')).toContain('inventory.mobile');
    expect(roleDefaults('hr')).not.toContain('inventory.mobile');
  });

  it('can be granted or revoked per user via overrides', () => {
    expect(resolvePermissions('hr', { 'inventory.mobile': true })).toContain('inventory.mobile');
    expect(resolvePermissions('warehouse', { 'inventory.mobile': false })).not.toContain('inventory.mobile');
  });
});

describe('announce permission', () => {
  it('is part of the canonical catalog', () => {
    expect(ALL_PERMISSIONS).toContain('announce');
  });

  it('defaults for admin, admin_staff, hr and marketing — not for warehouse', () => {
    expect(roleDefaults('admin')).toContain('announce');
    expect(roleDefaults('admin_staff')).toContain('announce');
    expect(roleDefaults('hr')).toContain('announce');
    expect(roleDefaults('marketing')).toContain('announce');
    expect(roleDefaults('warehouse')).not.toContain('announce');
  });
});

describe('mobile.access — the phone app is on for every new account', () => {
  it('is in every built-in role', async () => {
    const { BUILTIN_ROLES } = await import('../src/shared/permissions');
    for (const r of BUILTIN_ROLES) expect(r.permissions, r.key).toContain('mobile.access');
  });

  it('is staff-level, so HR can give it back to someone it was removed from', async () => {
    const { STAFF_PERMISSIONS } = await import('../src/shared/permissions');
    expect(STAFF_PERMISSIONS).toContain('mobile.access');
  });
});

describe('roles are permission bundles', () => {
  it('resolvePermissions applies overrides on top of the bundle it is given', () => {
    const p = resolvePermissions('custom_role', { 'orders.view': true, 'inventory.view': false }, ['inventory.view', 'mobile.access']);
    expect(p).toEqual(['mobile.access', 'orders.view']);
  });

  it('admin always has every permission, whatever bundle or overrides it is given', () => {
    expect(resolvePermissions('admin', { 'users.manage': false }, [])).toEqual(ALL_PERMISSIONS);
  });

  it('HR may assign a role only when every permission in it is staff-level', async () => {
    const { isStaffRole, HR_ASSIGNABLE_ROLES } = await import('../src/shared/permissions');
    expect(isStaffRole('packer', ['mobile.access', 'inventory.view'])).toBe(true);
    expect(isStaffRole('payroll_clerk', ['mobile.access', 'hr.view'])).toBe(false);
    expect(isStaffRole('admin', [])).toBe(false);
    // The built-in management roles stay admin-only.
    for (const r of ['admin', 'admin_staff', 'hr', 'accounting']) expect(HR_ASSIGNABLE_ROLES).not.toContain(r);
  });

  it("every account's permissions go through the tenant's roles (shared/roles.ts userPermissions)", async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts') && !/[\\/]shared[\\/]roles\.ts$/.test(f)
          && /import[^;]*\bresolvePermissions\b[^;]*from/.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
      }
    };
    walk(path.join(import.meta.dirname, '../src'));
    expect(offenders).toEqual([]);
  });
});

describe('floor roles see only their own desk (user decision 2026-10-06)', () => {
  it('no built-in floor role carries the broad inventory or production view', async () => {
    const { roleDefaults } = await import('../src/shared/permissions');
    for (const r of ['parts_clerk', 'production_lead', 'production_manager', 'qc_inspector', 'qa_inspector', 'receiving_clerk', 'releasing_clerk']) {
      expect(roleDefaults(r), r).not.toContain('inventory.view');
      expect(roleDefaults(r), r).not.toContain('production.view');
      expect(roleDefaults(r), r).not.toContain('inventory.mobile'); // warehouse phone tools
      expect(roleDefaults(r), r).toContain('mobile.access');
    }
  });
});
