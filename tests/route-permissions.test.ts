/**
 * Every route checks what the signed-in person may do (user request 2026-10-06: "all functions and
 * screens tie to what the role permits"). This scans the route files: each route must carry a
 * permission gate — requirePermission / requireAnyPermission, a gate const built from them, or a
 * router-wide `.use(requirePermission(...))` — or be listed below with the reason it needs none:
 * it only touches the caller's own data, it checks inside the handler, or it is open by design.
 * Desk-level read rules live in src/shared/desk-access.ts and are exercised by
 * tests/access-matrix.test.ts; this test makes sure no new route ships with no check at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/** Whole files whose every route is the caller's own data or checks inside its handlers. */
const FILE_REASONS: Record<string, string> = {
  'src/core/me.routes.ts': "the caller's own profile, payslips, requests and schedule; approvals check the approver inside",
  'src/core/notifications.routes.ts': "the caller's own notification history",
  'src/core/personal.routes.ts': "the caller's own notes, tasks and bookmarks",
  'src/core/push.routes.ts': "the caller's own push subscriptions",
  'src/core/auth.routes.ts': 'sign-in / sign-out / own sessions, profile and password',
  'src/core/attachments.routes.ts': 'checks the photo kind\'s read / write permissions inside (READ_PERMS / WRITE_PERMS)',
  'src/core/form-builder.routes.ts': 'checks forms.manage.<scope> / payroll.view|manage per form inside',
};
/** Single routes: `file:method path` → why it has no gate in its definition. */
const ROUTE_REASONS: Record<string, string> = {
  'src/core/analytics.routes.ts:get /overview': 'returns only the sections the caller may see (checked per section inside)',
  'src/core/announcements.routes.ts:get /': 'company announcements are for every employee',
  'src/core/bug-reports.routes.ts:post /': 'anyone may report a bug',
  'src/core/forms.routes.ts:delete /:id': 'the uploader or forms.delete, checked inside',
  'src/core/templates.routes.ts:get /company': 'the company header printed on every document',
  'src/core/templates.routes.ts:get /variables/catalog': 'the list of placeholder names (no data)',
  'src/core/users.routes.ts:get /': 'the message directory: name / role / department only unless users.manage',
  'src/core/users.routes.ts:get /departments/list': 'department names for pickers',
  'src/modules/ai/ai.routes.ts:get /reports/:name': 'served only to the report\'s owner or users.manage, checked inside',
  'src/modules/ai/ai.routes.ts:get /messages': "the caller's own assistant chat",
  'src/modules/ai/ai.routes.ts:delete /messages': "the caller's own assistant chat",
  'src/modules/ai/ai.routes.ts:post /chat': 'each tool checks its own permission (ai-tools.ts TOOL_PERMISSION)',
  'src/modules/hr/clock.routes.ts:post /punch': 'Clock is for every employee (their own punch)',
  'src/modules/hr/clock.routes.ts:get /my-status': "the caller's own clock status",
  'src/modules/inventory/orders.routes.ts:get /': 'orders.view / purchasing.view per order type, checked inside (order-access.ts)',
  'src/modules/inventory/orders.routes.ts:get /:id': 'orders.view / purchasing.view per order type, checked inside (order-access.ts)',
  'src/modules/inventory/orders.routes.ts:get /:id/availability': 'orders.view / purchasing.view per order type, checked inside (order-access.ts)',
  'src/modules/quickbooks/quickbooks.routes.ts:get /callback': 'the QuickBooks sign-in redirect (state-checked)',
  // The anonymous-report channel (confidential-reports.routes.ts publicRouter): no account by design.
  'src/core/confidential-reports.routes.ts:get /categories': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /ticket': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /lookup': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /followup': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /photo': 'anonymous-report channel',
  'src/core/confidential-reports.routes.ts:post /photo/remove': 'anonymous-report channel',
};
/** The sync layer's transport and the cloud-only platform console have their own auth. */
const SKIP = /^src\/(sync|platform)\//;

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : /\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('route permissions', () => {
  it('every route checks a permission (or is listed with a reason)', () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const file of routeFiles('src')) {
      const rel = file.split(path.sep).join('/');
      if (SKIP.test(rel) || FILE_REASONS[rel]) continue;
      const src = fs.readFileSync(file, 'utf8');
      // Gate consts in this file, and routers gated as a whole (`x.use(requireAuth, requirePermission(...))`).
      const gates = new Set([...src.matchAll(/const (\w+) = require(?:Any)?Permission\(/g)].map((m) => m[1]));
      const gatedRouters = new Set([...src.matchAll(/\b(\w+)\.use\([^)]*?require(?:Any)?Permission\(/g)].map((m) => m[1]));
      const re = /\b(\w*[Rr]outer)\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)\((?:_?req|_req)\b/g;
      for (const m of src.matchAll(re)) {
        const [, routerName, method, route, mw] = m as unknown as [string, string, string, string, string];
        const gated = gatedRouters.has(routerName) || /require(?:Any)?Permission\(/.test(mw) ||
          [...mw.matchAll(/\b(\w+)\b/g)].some((t) => gates.has(t[1]!) || /^\w+(Gate|Read)$/.test(t[1]!));
        if (gated) continue;
        const key = `${rel}:${method} ${route}`;
        if (ROUTE_REASONS[key]) { seen.add(key); continue; }
        missing.push(key);
      }
    }
    expect(missing, 'gate these routes (requirePermission / requireAnyPermission, shared/desk-access.ts), or list them with a reason').toEqual([]);
    // The lists stay honest: every entry still names a real file / a real ungated route.
    expect(Object.keys(ROUTE_REASONS).filter((k) => !seen.has(k))).toEqual([]);
    expect(Object.keys(FILE_REASONS).filter((f) => !fs.existsSync(f))).toEqual([]);
  });
});
