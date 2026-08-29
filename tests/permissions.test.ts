/** Permission catalog: the mobile-app gate key exists and lands in the right roles. */
import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, roleDefaults, resolvePermissions } from '../src/permissions';

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
