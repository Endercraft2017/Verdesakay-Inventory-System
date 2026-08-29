/**
 * Express application factory. Builds the app with middleware, routes, and error handling
 * but does NOT start listening — so tests can import it via supertest.
 */
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import inventoryRoutes from './routes/inventory.routes';
import suppliersRoutes from './routes/suppliers.routes';
import locationsRoutes from './routes/locations.routes';
import bomRoutes from './routes/bom.routes';
import jobOrdersRoutes from './routes/job-orders.routes';
import qcRoutes from './routes/qc.routes';
import formsRoutes from './routes/forms.routes';
import messagesRoutes from './routes/messages.routes';
import personalRoutes from './routes/personal.routes';
import ordersRoutes from './routes/orders.routes';
import purchasingRoutes from './routes/purchasing.routes';
import templatesRoutes from './routes/templates.routes';
import formBuilderRoutes from './routes/form-builder.routes';
import aiRoutes from './routes/ai.routes';
import hrRoutes from './routes/hr.routes';
import activityRoutes from './routes/activity.routes';
import analyticsRoutes from './routes/analytics.routes';
import mailRoutes from './routes/mail.routes';
import pushRoutes from './routes/push.routes';
import clockRoutes from './routes/clock.routes';
import meRoutes from './routes/me.routes';
import announcementsRoutes from './routes/announcements.routes';
import signupRoutes from './routes/signup.routes';
import tenantRoutes from './routes/tenant.routes';
import quickbooksRoutes from './routes/quickbooks.routes';
import { recordActivity } from './activity';
import { idempotency } from './idempotency';
import { tenantStore, getDb, DEFAULT_TENANT } from './db';
import { resolveTenantSlug, getTenant } from './platform';

const ROOT = path.join(import.meta.dirname, '..');

export function createApp() {
  const app = express();

  // Security headers. Disable CSP defaults that would block our inline view scripts;
  // a tailored policy can be added later if the app is exposed beyond the LAN.
  // HSTS is off so a device can be pointed back at plain HTTP without getting stuck.
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Resolve the tenant from the request (sub-domain, or X-Tenant / ?tenant in non-prod)
  // and pin its DB connection for the rest of the request (see src/platform.ts + src/db.ts
  // + docs/SAAS-READINESS.md). Must run before anything that touches the DB — the request
  // logger's activity write, the idempotency store, and every route. The `default` tenant
  // resolves with no catalog row, so single-tenant / self-hosted installs are unaffected.
  app.use((req, res, next) => {
    const slug = resolveTenantSlug(
      req.headers.host,
      req.get('x-tenant'),
      typeof req.query.tenant === 'string' ? req.query.tenant : undefined
    );
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
    tenantStore.run({ db: getDb(slug), slug }, () => next());
  });

  // Throttle login attempts to slow brute-force guessing.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test', // keep auth tests deterministic
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
      recordActivity(req, res);
    });
    next();
  });

  // De-duplicate retried mutating requests that carry an Idempotency-Key header
  // (used by the mobile offline queue). No-op for requests without the header.
  app.use('/api', idempotency);

  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/signup', signupRoutes); // self-serve tenant sign-up (gated by SIGNUPS_OPEN)
  app.use('/api/tenant', tenantRoutes); // current workspace plan / status / usage
  // Mounted here (before the bare-'/api' routers below) so its public OAuth /callback
  // isn't shadowed by another router's top-level requireAuth.
  app.use('/api/quickbooks', quickbooksRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/suppliers', suppliersRoutes);
  app.use('/api/locations', locationsRoutes);
  app.use('/api/finished-products', bomRoutes);
  app.use('/api/job-orders', jobOrdersRoutes);
  app.use('/api/qc', qcRoutes);
  app.use('/api/forms', formsRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/api', personalRoutes); // /api/notes, /api/tasks, /api/bookmarks
  app.use('/api/orders', ordersRoutes);
  app.use('/api/purchasing', purchasingRoutes);
  app.use('/api/templates', templatesRoutes);
  app.use('/api', formBuilderRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/hr/clock', clockRoutes);
  app.use('/api/hr', hrRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/announcements', announcementsRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/mail', mailRoutes);
  app.use('/api/push', pushRoutes);
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // The mobile service worker lives under /mobile/ but must control /m — the
  // Service-Worker-Allowed header lets it claim that broader scope.
  app.get('/mobile/sw.js', (_req, res) => {
    res.set('Service-Worker-Allowed', '/m');
    res.set('Cache-Control', 'no-cache');
    res.type('text/javascript');
    res.sendFile(path.join(ROOT, 'public', 'mobile', 'sw.js'));
  });

  // Static assets (css/js/images and the mobile/* bundle). `index: false` so that
  // "/" falls through to the SPA fallback below, where device detection runs.
  app.use(express.static(path.join(ROOT, 'public'), { index: false }));

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
      if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
  }

  app.get(/^(?!\/api).*/, (req, res) => {
    const onMobilePath = req.path === '/m' || req.path.startsWith('/m/');

    // Explicit override -> persist in a cookie, then redirect to the matching root.
    const override = typeof req.query.view === 'string' ? req.query.view : undefined;
    if (override === 'desktop' || override === 'mobile') {
      res.cookie('vds_view', override, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        httpOnly: false,
      });
      res.redirect(override === 'mobile' ? '/m' : '/');
      return;
    }

    const pref = readCookie(req, 'vds_view');
    const wantsMobile = pref
      ? pref === 'mobile'
      : MOBILE_UA.test(req.headers['user-agent'] || '');

    // Only auto-redirect INTO the mobile app; never force a desktop browser out of /m.
    if (wantsMobile && !onMobilePath) {
      res.redirect('/m');
      return;
    }

    res.sendFile(path.join(ROOT, 'public', onMobilePath ? 'mobile/index.html' : 'index.html'));
  });

  // Central error handler: validation errors -> 400, anything with a numeric status is
  // honored, everything else -> 500.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    if (status >= 500) console.error('Unhandled error:', err);
    const message =
      status < 500 && err instanceof Error ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}
