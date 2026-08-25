/** Frontend nav-config sanity: every tree leaf points at a real registered route,
    admin-only is set only where intended, and the tree shape is well-formed.

    nav-config.js is a browser classic script (defines globals + a CommonJS export
    guard). The app is ESM ("type":"module"), so we load the real file into a tiny
    sandbox via `new Function` and read its CommonJS export — no transpile needed. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Leaf = { label: string; icon: string; route: string; filter?: Record<string, string> };
type Subtab = { id: string; label: string; requiredPermission?: string; tree: Leaf[] };
type Primary = { id: string; label: string; icon: string; adminOnly?: boolean; requiredPermission?: string; subtabs: Subtab[] };

function loadNavConfig(): { NAV: Primary[]; ROUTE_NAMES: string[] } {
  const file = path.join(import.meta.dirname, '../public/js/nav-config.js');
  const src = fs.readFileSync(file, 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as { NAV: Primary[]; ROUTE_NAMES: string[] };
}

// The routes actually registered by the view modules (public/js/views/*.js).
const REGISTERED_ROUTES = ['dashboard', 'inventory', 'forms', 'orders', 'templates', 'messages', 'admin', 'account', 'form-builder', 'form-records', 'hr', 'hr-employees', 'hr-timekeeping'];

const { NAV, ROUTE_NAMES } = loadNavConfig();

describe('nav-config: ROUTE_NAMES', () => {
  it('matches the routes registered by the view modules', () => {
    expect([...ROUTE_NAMES].sort()).toEqual([...REGISTERED_ROUTES].sort());
  });
});

describe('nav-config: structure', () => {
  it('every primary has at least one subtab with at least one leaf', () => {
    expect(NAV.length).toBeGreaterThan(0);
    for (const p of NAV) {
      expect(p.id, `primary ${p.label} needs an id`).toBeTruthy();
      expect(p.icon, `primary ${p.label} needs an icon`).toBeTruthy();
      expect(p.subtabs.length, `primary ${p.label} needs subtabs`).toBeGreaterThan(0);
      for (const s of p.subtabs) {
        expect(s.id, `subtab ${s.label} needs an id`).toBeTruthy();
        expect(s.tree.length, `subtab ${s.label} needs leaves`).toBeGreaterThan(0);
      }
    }
  });

  it('every leaf points at a registered route', () => {
    for (const p of NAV) {
      for (const s of p.subtabs) {
        for (const leaf of s.tree) {
          expect(leaf.label).toBeTruthy();
          expect(leaf.icon).toBeTruthy();
          expect(
            ROUTE_NAMES,
            `leaf "${leaf.label}" -> unknown route "${leaf.route}"`,
          ).toContain(leaf.route);
        }
      }
    }
  });

  it('every leaf filter is a flat string map', () => {
    for (const p of NAV) {
      for (const s of p.subtabs) {
        for (const leaf of s.tree) {
          if (leaf.filter === undefined) continue;
          expect(typeof leaf.filter).toBe('object');
          for (const v of Object.values(leaf.filter)) {
            expect(typeof v).toBe('string');
          }
        }
      }
    }
  });

  it('the Admin section requires users.manage permission', () => {
    const adminSection = NAV.find((p) => p.id === 'admin');
    expect(adminSection?.requiredPermission).toBe('users.manage');
  });

  it('primary and subtab ids are unique', () => {
    const pids = NAV.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    for (const p of NAV) {
      const sids = p.subtabs.map((s) => s.id);
      expect(new Set(sids).size, `duplicate subtab id in ${p.label}`).toBe(sids.length);
    }
  });
});
