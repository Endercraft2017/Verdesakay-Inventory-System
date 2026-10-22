/**
 * SaaS feature-module entitlements — which capability areas ("modules") a tenant's
 * workspace has switched on. Layered exactly like user permissions are:
 *
 *     plan's default bundle   (src/plans.ts PLAN_MODULES)
 *   → overridden per-tenant   (platform.db tenants.modules, a JSON array or null)
 *   ∪ CORE                    (always on — the "generic" baseline every workspace keeps)
 *
 * The `default` tenant (self-hosted / single-tenant) always has every module and is
 * never gated — mirrors src/quota.ts.
 *
 * Orthogonal to src/permissions.ts: a gated route checks BOTH requireModule() ("is
 * this area sold to / enabled for the workspace") AND requirePermission() ("is this
 * user within the workspace allowed to use it"). See docs/SAAS-READINESS.md §9.
 */
import type { Request, Response, NextFunction } from 'express';
import { tenantStore, DEFAULT_TENANT } from './db';
import { getTenant } from '../platform/platform';
import { planModules } from '../platform/plans';

/** Every toggleable module. NOT here — and never gated — is the "core" baseline:
 *  login / My Account, Home & dashboards, Documents & file storage, Templates,
 *  Messages, user Admin, and the Activity log. Those have no module gate anywhere. */
export const MODULES = [
  'inventory',      // items, stock, suppliers, locations and warehouse tracking
  'sales',          // customers, commercial orders and outbound release
  'manufacturing',  // production, job orders, BOM / finished products, QC, batches
  'purchasing',     // goods receipts, vendor bills, 3-way match
  'hr',             // employees, timekeeping / kiosk, payroll, HR memos & requests
  'accounting',     // tax & compliance, general ledger, AR/AP, petty cash
  'ai',             // the AI Assistant widget + /api/ai/*
  'mobile',         // the /m employee PWA
  'email',          // BYO-SMTP outbound mail (the Email tool + /api/mail/*)
  'quickbooks',     // one-way push of orders to QuickBooks Online
] as const;

export type ModuleName = typeof MODULES[number];

/** Module → modules it needs alongside it to be coherent. Enforced at config time
 *  (validateModuleList); the resolver also unions deps in so a stale/partial list
 *  can't half-enable an area. */
export const MODULE_DEPS: Partial<Record<ModuleName, ModuleName[]>> = {
  sales: ['inventory'],
  manufacturing: ['inventory'],
  purchasing: ['inventory'],
  quickbooks: ['inventory'],
};

export function isModuleName(x: string): x is ModuleName {
  return (MODULES as readonly string[]).includes(x);
}

function currentSlug(): string {
  return tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
}

/** Expand a list with any missing dependencies, returned in canonical order. */
export function withDeps(mods: Iterable<string>): ModuleName[] {
  const want = new Set<ModuleName>();
  for (const m of mods) {
    if (!isModuleName(m)) continue;
    want.add(m);
    for (const d of MODULE_DEPS[m] ?? []) want.add(d);
  }
  return MODULES.filter((m) => want.has(m));
}

/**
 * The modules switched on for a tenant: its explicit `tenants.modules` override if
 * set, otherwise its plan's default bundle — always with dependencies unioned in.
 * The `default` tenant (and any unknown slug, which the resolver 404s first) → all.
 */
export function enabledModules(slug = currentSlug()): Set<ModuleName> {
  if (slug === DEFAULT_TENANT) return new Set(MODULES);
  const t = getTenant(slug);
  if (!t) return new Set(MODULES);
  let explicit: string[] | null = null;
  if (t.modules) {
    try {
      const parsed = JSON.parse(t.modules);
      if (Array.isArray(parsed)) explicit = parsed.map(String);
    } catch { /* fall back to the plan bundle */ }
  }
  return new Set(withDeps(explicit ?? planModules(t.plan)));
}

export function moduleEnabled(mod: ModuleName, slug = currentSlug()): boolean {
  return enabledModules(slug).has(mod);
}

/**
 * Express guard: 402 unless the current workspace's plan / entitlements include `mod`.
 * Mount ahead of the router it protects (it needs no auth of its own — the decision is
 * tenant-level), e.g. `app.use('/api/hr', requireModule('hr'), hrRoutes)`.
 */
export function requireModule(mod: ModuleName) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (moduleEnabled(mod)) { next(); return; }
    res.status(402).json({ error: `The ${mod} module is not enabled for this workspace.` });
  };
}

/**
 * Validate a proposed explicit module list for a tenant. Throws on an unknown name or
 * a missing dependency; returns the list in canonical order on success.
 */
export function validateModuleList(mods: string[]): ModuleName[] {
  const unknown = mods.filter((m) => !isModuleName(m));
  if (unknown.length) throw new Error(`Unknown module(s): ${unknown.join(', ')}. Known: ${MODULES.join(', ')}`);
  for (const m of mods as ModuleName[]) {
    for (const dep of MODULE_DEPS[m] ?? []) {
      if (!mods.includes(dep)) throw new Error(`Module "${m}" requires "${dep}" to also be enabled.`);
    }
  }
  return MODULES.filter((m) => mods.includes(m));
}
