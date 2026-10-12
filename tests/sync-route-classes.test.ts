/**
 * Every mutating route declares how it behaves offline (docs/OFFLINE-FIRST.md §28). An installed
 * PC refuses a write from a route with no sync class, so a new route that forgets one silently
 * stops working offline. This scans the route files: each POST / PUT / PATCH / DELETE must carry
 * syncClass(...) — or be listed below with the reason it needs none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/** `file:method path` → why it has no sync class. */
const NO_CLASS_NEEDED: Record<string, string> = {
  // Writes only node-local tables (sessions, push subscriptions, tickets, the activity log, the AI
  // search index), which never sync, or writes nothing at all.
  'src/core/auth.routes.ts:post /login': 'sessions are node-local',
  'src/modules/hr/clock.routes.ts:post /punch': 'retired one-step phone punch: always 410, writes nothing (punch-holds.ts)',
  'src/core/auth.routes.ts:post /logout': 'sessions / push subscriptions are node-local',
  'src/core/auth.routes.ts:post /sessions/revoke-others': 'sessions are node-local',
  'src/core/auth.routes.ts:post /sessions/:sid/revoke': 'sessions are node-local',
  'src/core/confidential-reports.routes.ts:post /ticket': 'tickets are node-local',
  'src/core/confidential-reports.routes.ts:post /lookup': 'a read (number + code in the body)',
  'src/core/confidential-reports.routes.ts:post /photo': 'a read (number + code in the body)',
  'src/core/push.routes.ts:post /subscribe': 'push subscriptions are node-local',
  'src/core/push.routes.ts:post /unsubscribe': 'push subscriptions are node-local',
  'src/core/push.routes.ts:post /test': 'writes nothing',
  'src/modules/ai/ai.routes.ts:post /reindex': 'the AI search index is rebuilt per copy (node-local)',
  'src/core/me.routes.ts:post /leave-preview': 'read-only leave coverage preview',
  'src/modules/hr/hr.routes.ts:post /leave-preview': 'read-only leave coverage preview',
  'src/modules/hr/hr.routes.ts:post /payroll/:recordId/preview-deductions': 'a read',
  // The platform console and sign-up run only on the cloud, outside any workspace.
  'src/platform/platform.routes.ts:post /login': 'cloud console',
  'src/platform/platform.routes.ts:post /logout': 'cloud console',
  'src/platform/platform.routes.ts:post /password': 'cloud-only owner-console password in platform.db, outside workspace sync',
  'src/platform/platform.routes.ts:post /tenants': 'cloud console',
  'src/platform/platform.routes.ts:post /tenants/import': 'cloud console',
  'src/platform/platform.routes.ts:patch /tenants/:slug': 'cloud console',
  'src/platform/platform.routes.ts:post /tenants/:slug/purge': 'cloud console',
  'src/platform/platform.routes.ts:put /tenants/:slug/subscription': 'cloud-only subscription pricing and entitlements in platform.db',
  'src/platform/platform.routes.ts:put /tenants/:slug/owner-details': 'cloud-only owner notes and alert thresholds in platform.db',
  'src/platform/platform.routes.ts:post /tenants/:slug/support': 'cloud-only owner support records in platform.db',
  'src/platform/platform.routes.ts:patch /tenants/:slug/support/:id': 'cloud-only owner support records in platform.db',
  'src/platform/platform.routes.ts:post /tenants/:slug/support/:id/replies': 'cloud-only owner ticket replies in platform.db',
  'src/platform/signup.routes.ts:post /': 'cloud sign-up',
  'src/platform/inquiries.routes.ts:post /': 'cloud website form, stored in platform.db',
  'src/platform/inquiries-console.routes.ts:patch /inquiries/:id': 'cloud console',
  'src/platform/inquiries-console.routes.ts:put /site/contact': 'cloud console',
  'src/platform/platform-mail-console.routes.ts:put /mail': 'cloud console',
  'src/platform/platform-mail-console.routes.ts:post /mail/test': 'cloud console',
  'src/platform/platform.routes.ts:post /tenants/:slug/reset-owner-password': 'cloud console',
  'src/platform/platform.routes.ts:post /tenants/:slug/recover-owner-username': 'cloud console',
  'src/platform/billing-console.routes.ts:put /billing/settings': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /billing/settings/gcash-qr': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:delete /billing/settings/gcash-qr': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /tenants/:slug/invoices': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /billing/invoices/:id/void': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /billing/invoices/:id/record-payment': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:patch /billing/invoices/:id': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /billing/payments/:id/confirm': 'cloud-only billing in platform.db',
  'src/platform/billing-console.routes.ts:post /billing/payments/:id/reject': 'cloud-only billing in platform.db',
};
/** The sync layer's own endpoints: they are the transport, not business writes. */
const SYNC_LAYER = /^src\/sync\//;

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : /\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('sync classes', () => {
  it('every mutating route declares one (or is listed with a reason)', () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const file of routeFiles('src')) {
      const rel = file.split(path.sep).join('/');
      if (SYNC_LAYER.test(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      // A route definition up to its handler: `router.post('/x', gate, mw, (req, res`.
      const re = /\b\w*[Rr]outer\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)\((?:_?req|_req)\b/g;
      for (const m of src.matchAll(re)) {
        const key = `${rel}:${m[1]} ${m[2]}`;
        if (/syncClass\(/.test(m[3]!)) continue;
        if (NO_CLASS_NEEDED[key]) { seen.add(key); continue; }
        missing.push(key);
      }
    }
    expect(missing, 'add syncClass(...) to these routes (docs/OFFLINE-FIRST.md §1), or list them with a reason').toEqual([]);
    // The list stays honest: every entry still names a real, unclassed route.
    expect(Object.keys(NO_CLASS_NEEDED).filter((k) => !seen.has(k))).toEqual([]);
  });
});
