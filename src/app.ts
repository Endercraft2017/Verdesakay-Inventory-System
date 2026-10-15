/**
 * Express application factory. Builds the app with middleware, routes, and error handling
 * but does NOT start listening — so tests can import it via supertest.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes from './core/auth.routes';
import usersRoutes from './core/users.routes';
import rolesRoutes from './core/roles.routes';
import inventoryRoutes from './modules/inventory/inventory.routes';
import suppliersRoutes from './modules/inventory/suppliers.routes';
import customersRoutes from './modules/inventory/customers.routes';
import locationsRoutes from './modules/inventory/locations.routes';
import bomRoutes from './modules/manufacturing/bom.routes';
import jobOrdersRoutes from './modules/manufacturing/job-orders.routes';
import qcRoutes from './modules/manufacturing/qc.routes';
import productionRoutes from './modules/manufacturing/production.routes';
import partsSlipsRoutes from './modules/manufacturing/parts-slips.routes';
import productionIssuesRoutes from './modules/manufacturing/production-issues.routes';
import rtsRoutes from './modules/manufacturing/rts.routes';
import attachmentsRoutes from './core/attachments.routes';
import bugReportsRoutes from './core/bug-reports.routes';
import employeeProfileRoutes from './modules/hr/employee-profile.routes';
import { reporterRouter as anonymousReportRoutes, staffRouter as confidentialReportRoutes, isAnonymousReportPath } from './core/confidential-reports.routes';
import deliveriesRoutes from './modules/inventory/deliveries.routes';
import releaseSlipsRoutes from './modules/inventory/release-slips.routes';
import formsRoutes from './core/forms.routes';
import messagesRoutes from './core/messages.routes';
import personalRoutes from './core/personal.routes';
import ordersRoutes from './modules/inventory/orders.routes';
import purchasingRoutes from './modules/purchasing/purchasing.routes';
import templatesRoutes from './core/templates.routes';
import formBuilderRoutes from './core/form-builder.routes';
import aiRoutes from './modules/ai/ai.routes';
import hrRoutes from './modules/hr/hr.routes';
import activityRoutes from './core/activity.routes';
import analyticsRoutes from './core/analytics.routes';
import accountingRoutes from './modules/accounting/accounting.routes';
import mailRoutes from './modules/email/mail.routes';
import pushRoutes from './core/push.routes';
import notificationsRoutes from './core/notifications.routes';
import clockRoutes from './modules/hr/clock.routes';
import fieldRoutes from './modules/hr/field.routes';
import meRoutes from './core/me.routes';
import announcementsRoutes from './core/announcements.routes';
import signupRoutes from './platform/signup.routes';
import tenantRoutes from './platform/tenant.routes';
import platformConsoleRoutes from './platform/platform.routes';
import quickbooksRoutes from './modules/quickbooks/quickbooks.routes';
import { recordActivity } from './shared/activity';
import { idempotency } from './shared/idempotency';
import { tenantStore, getDb, DEFAULT_TENANT } from './shared/db';
import { resolveTenantSlug, getTenant, PLATFORM_CONSOLE, platformHost, retiredDefaultTenant } from './platform/platform';
import { tenantPath, onTenantPathHost } from './platform/tenant-path';
import { requireModule, moduleEnabled } from './shared/modules';
import { BEHIND_PROXY } from './shared/hosting';
import { installSync, replayTenantOf, syncRequestMiddleware, syncRoutes } from './sync';
import desktopRoutes from './desktop/desktop.routes';

const ROOT = path.join(import.meta.dirname, '..');

/** Behind a TLS-terminating proxy (see src/shared/hosting.ts) the server speaks plain HTTP
 *  and trusts the proxy's X-Forwarded-* headers. Re-exported for server.ts. */
export { BEHIND_PROXY };

/** Where the installed phone app's pages come from (Capacitor: Android, then iPhone). */
const NATIVE_APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

export function createApp() {
  const app = express();
  // Strip a configured tenant prefix before the existing API, audit and sync machinery.
  // Keep the normalized originalUrl so anonymous reports remain anonymous and sync
  // commands stay portable to an installed PC's unprefixed local API.
  app.use((req, res, next) => {
    const route = tenantPath(req.headers.host, req.url);
    if (route) {
      if (route.url === '/_platform' || route.url.startsWith('/_platform/')) {
        res.status(404).json({ error: 'Not found' }); return;
      }
      res.locals.tenantSlug = route.slug;
      res.locals.tenantBase = route.base;
      req.url = route.url;
      req.originalUrl = route.url;
    } else if (onTenantPathHost(req.headers.host) || resolveTenantSlug(req.headers.host) === DEFAULT_TENANT) {
      const landing = retiredDefaultTenant();
      if (landing) {
        if (req.path === '/' || req.path === '/m' || req.path.startsWith('/m/')
          || req.path === '/index.html' || req.path === '/mobile/index.html') {
          const origin = onTenantPathHost(req.headers.host) ? '' : `https://${process.env.TENANT_PATH_HOST}`;
          res.redirect(307, `${origin}/${landing}${req.url}`); return;
        }
        // The retained original DB is a recovery source, never a second writable company.
        if (req.path === '/api' || (req.path.startsWith('/api/') && req.path !== '/api/health')) {
          res.status(410).json({ error: `This company has moved to /${landing}.` }); return;
        }
      }
    }
    next();
  });
  // Offline-first sync hooks (docs/OFFLINE-FIRST.md). Inert for any tenant DB without a sync
  // role, i.e. every tenant until enrolment exists.
  installSync(app);
  // Behind a proxy, req.ip / req.protocol must come from X-Forwarded-*, or the login rate
  // limiter would bucket every user under the proxy's single IP.
  if (BEHIND_PROXY) app.set('trust proxy', 1);

  // Security headers. Disable CSP defaults that would block our inline view scripts;
  // a tailored policy can be added later if the app is exposed beyond the LAN.
  // HSTS is off so a device can be pointed back at plain HTTP without getting stuck.
  app.use(helmet({
    contentSecurityPolicy: false,
    hsts: BEHIND_PROXY ? { maxAge: 31536000, includeSubDomains: false } : false,
    frameguard: { action: 'deny' },
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // The installed phone app (docs/OFFLINE-FIRST.md §29) serves its own pages from inside the app
  // (https://localhost on Android, capacitor://localhost on iPhone) and calls this server's API
  // cross-origin. Only those two origins, only /api, and no cookies: requests carry the bearer
  // token, which another site has no way to get.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (!origin || !NATIVE_APP_ORIGINS.has(origin)) { next(); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Sync-State, X-Sync-Command, Content-Disposition');
    if (req.method !== 'OPTIONS') { next(); return; }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Device-Id, X-Client, Idempotency-Key, X-Kiosk-Token, X-Tenant');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Dedicated owner-console host (PLATFORM_HOST): that host serves only the console, and
  // the console is served on no other host. Unset ⇒ the console stays on the apex/default host.
  app.use((req, res, next) => {
    const consoleHost = PLATFORM_CONSOLE ? platformHost() : '';
    if (!consoleHost) { next(); return; }
    const onConsoleHost = String(req.headers.host || '').toLowerCase().split(':')[0] === consoleHost;
    if (onConsoleHost && res.locals.tenantSlug) { next(); return; }
    const consolePath = req.path === '/_platform' || req.path.startsWith('/_platform/');
    if (onConsoleHost === consolePath || req.path === '/api/health') { next(); return; }
    if (onConsoleHost && !req.path.startsWith('/api/')) { res.redirect('/_platform/'); return; }
    res.status(404).json({ error: 'Not found' });
  });

  // Resolve the tenant from the request (sub-domain, or X-Tenant / ?tenant in non-prod)
  // and pin its DB connection for the rest of the request (see src/platform.ts + src/db.ts
  // + docs/SAAS-READINESS.md). Must run before anything that touches the DB — the request
  // logger's activity write, the idempotency store, and every route. The `default` tenant
  // resolves with no catalog row, so single-tenant / self-hosted installs are unaffected.
  app.use((req, res, next) => {
    // An internal sync replay names its tenant (authenticated by a per-process secret).
    const slug = replayTenantOf(req) ?? res.locals.tenantSlug ?? (onTenantPathHost(req.headers.host) ? DEFAULT_TENANT : resolveTenantSlug(
      req.headers.host,
      req.get('x-tenant'),
      typeof req.query.tenant === 'string' ? req.query.tenant : undefined
    ));
    if (slug !== DEFAULT_TENANT) {
      const tenant = getTenant(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Unknown workspace.' });
        return;
      }
      if (tenant.status === 'suspended' || tenant.status === 'purged') {
        res.status(403).json({ error: 'This workspace is not active. Please contact your administrator.' });
        return;
      }
      // A lapsed trial is treated as past_due: reads still work, writes are blocked
      // (except auth, so they can log in and see the billing banner).
      const lapsedTrial = tenant.status === 'trial' && !!tenant.trial_ends_at
        && tenant.trial_ends_at < new Date().toISOString();
      const readOnly = tenant.status === 'past_due' || lapsedTrial;
      if (readOnly && req.method !== 'GET' && req.method !== 'HEAD'
        && !req.path.startsWith('/api/auth') && req.path !== '/api/tenant') {
        res.status(402).json({ error: 'This workspace is past due — it is read-only until billing is resolved.' });
        return;
      }
    }
    // Shared assets, health checks and the owner console need no original-company DB.
    tenantStore.run({ db: getDb(slug === DEFAULT_TENANT ? retiredDefaultTenant() ?? slug : slug), slug }, () => next());
  });

  // Sync: replay context, the node write guard, and the cloud's effect stream (src/sync/capture.ts).
  app.use(syncRequestMiddleware);

  // Throttle login attempts to slow brute-force guessing.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test', // keep auth tests deterministic
    message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
  });

  const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20,
    keyGenerator: req => crypto.createHash('sha256').update(JSON.stringify([
      tenantStore.getStore()?.slug, String(req.body?.username || '').toLowerCase().trim().slice(0, 200),
    ])).digest('hex'),
    skipSuccessfulRequests: true,
    standardHeaders: true, legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
  });

  // Lightweight API request log + persistent activity log (mutations only; see activity.ts).
  app.use((req, res, next) => {
    const start = Date.now();
    // Capture a created record's id from the JSON response so the audit row can point at it.
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (body && typeof body === 'object' && 'id' in body) {
        res.locals.createdId = (body as { id: unknown }).id;
      }
      return sendJson(body);
    };
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
      // Anonymous-report requests leave no identity trail (user, IP, body) — see confidential-reports.ts.
      if (!isAnonymousReportPath((req.originalUrl || req.url).split('?')[0] ?? '')) recordActivity(req, res);
    });
    next();
  });

  // De-duplicate retried mutating requests that carry an Idempotency-Key header
  // (used by the mobile offline queue). No-op for requests without the header.
  app.use('/api', (req, res, next) => (isAnonymousReportPath(req.originalUrl.split('?')[0] ?? '') ? next() : idempotency(req, res, next)));

  // Unauthenticated liveness probe (Railway healthcheck). Must precede the routers mounted
  // on bare '/api' (personal, form builder), whose blanket auth would otherwise 401 it.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.use(['/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password'], loginLimiter);
  app.use('/api/auth/login', loginAccountLimiter);
  app.use('/api/auth', authRoutes);
  // Before the bare-'/api' routers below: their blanket requireAuth would otherwise 401 it.
  app.use('/api/anonymous-reports', anonymousReportRoutes);
  // Installed PCs enrol and sync here (node-token auth; src/sync/transport.ts). Before the
  // bare-'/api' routers, whose blanket requireAuth would 401 a node token.
  app.use('/api/sync', syncRoutes);
  // The desktop app's installer download (work in progress: nothing published yet).
  app.use('/api/desktop', desktopRoutes);
  app.use('/api/confidential-reports', confidentialReportRoutes);
  app.use('/api/signup', signupRoutes); // self-serve tenant sign-up (gated by SIGNUPS_OPEN)
  app.use('/api/tenant', tenantRoutes); // current workspace plan / status / usage
  // Mounted here (before the bare-'/api' routers below) so its public OAuth /callback
  // isn't shadowed by another router's top-level requireAuth.
  //
  // requireModule(...) gates whole feature areas per tenant (see src/modules.ts): 402 if
  // the workspace's plan / entitlements don't include that module. It runs before the
  // router's own requireAuth — the decision is tenant-level, not user-level. The `default`
  // tenant has every module, so self-hosted / single-tenant is unaffected. "Core" routers
  // (users, forms, messages, personal, templates, form-builder, me, announcements,
  // activity, analytics, attachments, push) are never gated — that's the baseline every
  // workspace keeps.
  app.use('/api/quickbooks', requireModule('quickbooks'), quickbooksRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/inventory', requireModule('inventory'), inventoryRoutes);
  app.use('/api/suppliers', requireModule('inventory'), suppliersRoutes);
  app.use('/api/customers', requireModule('inventory'), customersRoutes);
  app.use('/api/locations', requireModule('inventory'), locationsRoutes);
  app.use('/api/finished-products', requireModule('manufacturing'), bomRoutes);
  app.use('/api/job-orders', requireModule('manufacturing'), jobOrdersRoutes);
  app.use('/api/qc', requireModule('manufacturing'), qcRoutes);
  app.use('/api/production', requireModule('manufacturing'), productionRoutes);
  app.use('/api/parts-slips', requireModule('manufacturing'), partsSlipsRoutes);
  app.use('/api/production-issues', requireModule('manufacturing'), productionIssuesRoutes);
  app.use('/api/rts', requireModule('manufacturing'), rtsRoutes);
  app.use('/api/attachments', attachmentsRoutes);
  app.use('/api/bug-reports', bugReportsRoutes);
  app.use('/api/deliveries', requireModule('inventory'), deliveriesRoutes);
  app.use('/api/release-slips', requireModule('inventory'), releaseSlipsRoutes);
  app.use('/api/forms', formsRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/api', personalRoutes); // /api/notes, /api/tasks, /api/bookmarks
  app.use('/api/orders', requireModule('inventory'), ordersRoutes);
  app.use('/api/purchasing', requireModule('purchasing'), purchasingRoutes);
  app.use('/api/templates', templatesRoutes);
  app.use('/api', formBuilderRoutes);
  app.use('/api/ai', requireModule('ai'), aiRoutes);
  app.use('/api/hr/clock', requireModule('hr'), clockRoutes);
  app.use('/api/hr/field', requireModule('hr'), fieldRoutes);
  app.use('/api/hr/employee-profiles', requireModule('hr'), employeeProfileRoutes);
  app.use('/api/hr', requireModule('hr'), hrRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/announcements', announcementsRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/accounting', requireModule('accounting'), accountingRoutes);
  app.use('/api/mail', requireModule('email'), mailRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/notifications', notificationsRoutes);

  // Owner console — a separate mini-app under /_platform with its own operator auth
  // (src/platform-users.ts). Mounted only when PLATFORM_CONSOLE=true; the whole path 404s
  // otherwise, so single-tenant / self-hosted never exposes it. Its assets live outside
  // public/ so the generic static handler can't serve them when the console is off. The
  // API's own middleware also 404s any request that resolved to a tenant sub-domain.
  if (PLATFORM_CONSOLE) {
    app.use('/_platform/api', platformConsoleRoutes);
    app.use('/_platform', express.static(path.join(ROOT, 'web-console'), {
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }));
    app.get(/^\/_platform(?:\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(ROOT, 'web-console', 'index.html'));
    });
  } else {
    // Disabled: 404 the whole path so it can't fall through to the SPA shell.
    app.use('/_platform', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  }

  // The mobile service worker lives under /mobile/ but must control /m — the
  // Service-Worker-Allowed header lets it claim that broader scope.
  app.get('/mobile/sw.js', (_req, res) => {
    const base = String(res.locals.tenantBase || '');
    res.set('Service-Worker-Allowed', base + '/m');
    res.set('Cache-Control', 'no-cache');
    res.type('text/javascript');
    res.send(`var TENANT_BASE = ${JSON.stringify(base)};\n` + fs.readFileSync(path.join(ROOT, 'public', 'mobile', 'sw.js'), 'utf8'));
  });

  function sendAppShell(res: Response, mobile: boolean): void {
    const base = String(res.locals.tenantBase || '');
    const file = path.join(ROOT, 'public', mobile ? 'mobile/index.html' : 'index.html');
    const html = fs.readFileSync(file, 'utf8').replace(/<head>/i,
      `<head><script>window.VDS_BASE_PATH=${JSON.stringify(base)};</script>`)
      .replace(/\b(src|href)="\/(?!\/)/g, `$1="${base}/`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  }
  app.get('/index.html', (_req, res) => sendAppShell(res, false));
  app.get('/mobile/index.html', (_req, res) => sendAppShell(res, true));
  app.get('/mobile/manifest.webmanifest', (_req, res) => {
    const base = String(res.locals.tenantBase || '');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mobile/manifest.webmanifest'), 'utf8'));
    manifest.start_url = base + '/m';
    manifest.scope = base + '/m';
    manifest.id = base + '/m';
    manifest.icons.forEach((icon: { src: string }) => { icon.src = base + icon.src; });
    res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(manifest));
  });

  // Static assets (css/js/images and the mobile/* bundle). `index: false` so that
  // "/" falls through to the SPA fallback below, where device detection runs.
  // Cache-Control: no-cache (NOT no-store) — the browser still keeps the response and can
  // reuse it, but must always revalidate with the server first (a fast 304 via the ETag/
  // Last-Modified express.static already sends when nothing changed). Without this, some
  // browsers apply their own heuristic freshness window and serve a stale JS/CSS file for a
  // while after a real edit even on an ordinary reload — no build step here means every
  // change is meant to be live on the next request, so nothing should ever look "stuck" a
  // step behind what was actually just deployed.
  app.use(express.static(path.join(ROOT, 'public'), {
    index: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));

  // SPA fallback + mobile routing.
  //
  //   - Phones/tablets are auto-redirected from any desktop page to the mobile
  //     app at /m (a separate, stripped-down frontend sharing this same API).
  //   - `?view=desktop` (or `?view=mobile`) overrides detection and is remembered
  //     in the `vds_view` cookie, so a user can force either experience.
  //   - Desktop browsers can still open /m directly (handy for testing); only the
  //     mobile-first redirect is automatic.
  const MOBILE_UA =
    /Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile Safari/i;

  function readCookie(req: Request, name: string): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) {
        try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
      }
    }
    return undefined;
  }

  app.get(/^(?!\/api).*/, (req, res) => {
    const onMobilePath = req.path === '/m' || req.path.startsWith('/m/');

    // Explicit override -> persist in a cookie, then redirect to the matching root.
    const override = typeof req.query.view === 'string' ? req.query.view : undefined;
    if (override === 'desktop' || override === 'mobile') {
      res.cookie('vds_view', override, {
        path: String(res.locals.tenantBase || '/'),
        maxAge: 365 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        httpOnly: false,
      });
      res.redirect(String(res.locals.tenantBase || '') + (override === 'mobile' ? '/m' : '/'));
      return;
    }

    const pref = readCookie(req, 'vds_view');
    const wantsMobile = pref
      ? pref === 'mobile'
      : MOBILE_UA.test(req.headers['user-agent'] || '');

    // The mobile PWA is a per-tenant module. When it's off, serve a plain notice for any
    // /m URL and send phone users to the (still usable) desktop app instead of redirecting
    // them into an app that isn't there — a redirect loop otherwise.
    if (!moduleEnabled('mobile')) {
      if (onMobilePath) {
        res.status(200).type('html').send(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">`
          + `<title>Mobile app unavailable</title>`
          + `<div style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;text-align:center">`
          + `<h1 style="font-size:1.1rem">The mobile app isn't enabled for this workspace</h1>`
          + `<p style="color:#666">Open <a href="${String(res.locals.tenantBase || '')}/?view=desktop">the full app</a> instead, or ask your administrator to enable the mobile module.</p></div>`
        );
        return;
      }
      sendAppShell(res, false);
      return;
    }

    // Only auto-redirect INTO the mobile app; never force a desktop browser out of /m.
    if (wantsMobile && !onMobilePath) {
      res.redirect(String(res.locals.tenantBase || '') + '/m');
      return;
    }

    sendAppShell(res, onMobilePath);
  });

  // Central error handler: validation errors -> 400, anything with a numeric status is
  // honored, everything else -> 500. A 5xx's message is hidden unless the error marks itself
  // `expose` (http-errors convention), e.g. sync's "needs an internet connection" 503.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    const expose = err instanceof Error && (status < 500 || (err as { expose?: boolean }).expose === true);
    if (status >= 500 && !expose) console.error('Unhandled error:', err);
    const message = expose ? (err as Error).message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}
