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
import formsRoutes from './routes/forms.routes';
import messagesRoutes from './routes/messages.routes';
import personalRoutes from './routes/personal.routes';
import ordersRoutes from './routes/orders.routes';
import templatesRoutes from './routes/templates.routes';
import formBuilderRoutes from './routes/form-builder.routes';
import aiRoutes from './routes/ai.routes';
import hrRoutes from './routes/hr.routes';
import activityRoutes from './routes/activity.routes';
import mailRoutes from './routes/mail.routes';
import { recordActivity } from './activity';
import { idempotency } from './idempotency';

const ROOT = path.join(import.meta.dirname, '..');

export function createApp() {
  const app = express();

  // Security headers. Disable CSP defaults that would block our inline view scripts;
  // a tailored policy can be added later if the app is exposed beyond the LAN.
  // HSTS is off so a device can be pointed back at plain HTTP without getting stuck.
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

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
  app.use('/api/users', usersRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/suppliers', suppliersRoutes);
  app.use('/api/locations', locationsRoutes);
  app.use('/api/finished-products', bomRoutes);
  app.use('/api/job-orders', jobOrdersRoutes);
  app.use('/api/forms', formsRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/api', personalRoutes); // /api/notes, /api/tasks, /api/bookmarks
  app.use('/api/orders', ordersRoutes);
  app.use('/api/templates', templatesRoutes);
  app.use('/api', formBuilderRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/hr', hrRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/mail', mailRoutes);
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
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
