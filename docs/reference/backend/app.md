# `src/app.ts`

## Purpose
The Express application factory. Assembles all middleware, mounts every route module, serves the static frontend with an SPA fallback, and installs the central error handler — but deliberately does **not** call `.listen()`, so both `server.ts` (real runs) and the test suite (via `supertest`) can obtain a ready-to-use `app` instance without opening a network port.

## Exports / Public API

```ts
export function createApp(): express.Express
```
Builds and returns a fully configured Express app. Call order inside:

1. **Security headers**: `app.use(helmet({ contentSecurityPolicy: false }))`. CSP is explicitly disabled because the frontend uses inline `<script>`/event handlers that a default CSP would block; the comment notes a tailored policy could be added later if the app is ever exposed beyond the LAN.
2. **Body parsing**: `express.json({ limit: '10mb' })` (raised from Express's default to accommodate base64 photo/logo data URIs and large template bodies) and `express.urlencoded({ extended: true })`.
3. **Login rate limiting**: an `express-rate-limit` instance (`loginLimiter`) — 20 requests per 15-minute window per client, standard `RateLimit-*` headers, legacy headers off, `skip: () => process.env.NODE_ENV === 'test'` (so the auth test suite isn't throttled), custom 429 body `{ error: 'Too many login attempts...' }`. Mounted only on `/api/auth/login`.
4. **Request log**: an anonymous middleware that times each request and, on `res.on('finish')`, logs `METHOD path -> status (Nms)` to the console for any path starting with `/api`. Non-API (static) requests are not logged.
5. **Route mounts** (all under `/api`, each router internally calls `router.use(requireAuth)` except where a route is explicitly public):
   - `/api/auth/login` → `loginLimiter` then `authRoutes`
   - `/api/auth` → `authRoutes`
   - `/api/users` → `usersRoutes`
   - `/api/inventory` → `inventoryRoutes`
   - `/api/forms` → `formsRoutes`
   - `/api/messages` → `messagesRoutes`
   - `/api` → `personalRoutes` (exposes `/api/notes`, `/api/tasks`, `/api/bookmarks`)
   - `/api/orders` → `ordersRoutes`
   - `/api/templates` → `templatesRoutes`
   - `/api` → `formBuilderRoutes` (exposes `/api/form-definitions`, `/api/form-records`, `/api/global-variables`)
   - `/api/ai` → `aiRoutes`
   - `/api/hr` → `hrRoutes`
   - `GET /api/health` → inline handler, `res.json({ ok: true, time: <ISO> })`, no auth — liveness probe.
6. **Static + SPA fallback**: `express.static(path.join(ROOT, 'public'))` serves the frontend as-is; a catch-all `app.get(/^(?!\/api).*/, ...)` sends `public/index.html` for any non-`/api` path that wasn't matched by a static file, so client-side hash routing works on refresh/deep-link.
7. **Central error handler** (4-arg Express middleware, must be registered last):
   ```ts
   app.use((err, _req, res, next) => { ... })
   ```
   - If headers are already sent, delegates to `next(err)` (Express default behavior) instead of trying to send a second response.
   - Reads `err.status` if present and numeric (this is how `ValidationError` from `src/shared/validation.ts`, and any other thrown object with a numeric `.status`, gets its intended HTTP code); otherwise defaults to `500`.
   - Logs to `console.error` only for `status >= 500` (keeps expected 4xx validation/permission errors out of the error log).
   - Response body message: the real `err.message` for `status < 500` when `err instanceof Error`; otherwise the generic `'Internal server error'` (so 5xx responses never leak internal error detail to the client).

`ROOT` (module-level constant, not exported): `path.join(import.meta.dirname, '..')` — resolves to the project root (one level up from `src/`), used to locate `public/`.

## Internal / non-exported helpers
None beyond the inline middleware closures described above (request logger, SPA fallback handler, error handler) — none are factored into named functions.

## Dependencies
- `node:path` — resolving `ROOT` and static file paths.
- `express`, `helmet`, `express-rate-limit` — npm middleware.
- `./routes/auth.routes`, `./routes/users.routes`, `./routes/inventory.routes`, `./routes/forms.routes`, `./routes/messages.routes`, `./routes/personal.routes`, `./routes/orders.routes`, `./routes/templates.routes`, `./routes/form-builder.routes`, `./routes/ai.routes`, `./routes/hr.routes` — every feature router.

Note: `app.ts` does **not** import `src/shared/db.ts` directly — DB initialization is the caller's responsibility (`server.ts` calls `init()` before `createApp()`; `tests/helpers.ts` does the same against a throwaway DB).

## Used by
- `server.ts` — calls `createApp()` after `init()`, then `.listen()`.
- `tests/helpers.ts` — `setupApp()` calls `createApp()` to get an app instance for `supertest`, after pointing `DB_PATH`/`UPLOAD_DIR` env vars at a temp location and calling `init()`.
- Referenced descriptively in `docs/ARCHITECTURE.md` (§2 directory map, §7 running/testing).

## Notes / gotchas
- **Mount order matters** for the two routers mounted at bare `/api` (`personalRoutes`, `formBuilderRoutes`) relative to more specific mounts like `/api/orders` — Express matches routers in registration order, so as long as `personalRoutes`/`formBuilderRoutes` only define paths like `/notes`, `/form-definitions`, etc. (not overlapping prefixes), order is safe, but adding a new bare-`/api` router requires checking for path collisions.
- The error handler **must stay the last `app.use()` call** — Express identifies error-handling middleware by arity (4 params) and by position; moving it earlier would prevent it from catching errors thrown by routes registered after it.
- `contentSecurityPolicy: false` is a deliberate, LAN-only-deployment tradeoff — re-enabling CSP would require auditing every inline script/style in `public/` first.
- The SPA fallback regex `/^(?!\/api).*/` means **any** unmatched non-`/api` GET (typos in asset paths, etc.) silently returns `index.html` with a 200, not a 404 — expected for SPA routing but worth knowing when debugging "why did my missing file return HTML".
