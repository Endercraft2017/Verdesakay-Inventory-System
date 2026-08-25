# `src/auth.ts`

## Purpose
Session-token authentication and role/permission-based access control. Owns the session lifecycle (create/destroy/resolve a bearer token to a user) and exposes the Express middleware factories every protected route uses to gate access: `requireAuth`, `requirePermission`, `requireAnyPermission`, and the now-unused-but-still-exported `requireRole`.

## Exports / Public API

### Session lifecycle
```ts
export function createSession(userId: number): string
```
Generates a new token (`newToken()` from `src/db.ts`), inserts a row into `sessions` with `expires_at = datetime('now', '+12 hours')` (`SESSION_HOURS = 12`, a module-level constant), returns the token. Called by `auth.routes.ts` on successful login.

```ts
export function destroySession(token: string): void
```
`DELETE FROM sessions WHERE token = ?`. Called by `auth.routes.ts` on logout. No-op (no error) if the token doesn't exist.

```ts
export function userFromToken(token: string | null): AuthUser | null
```
The core session-resolution query. Returns `null` immediately if `token` is falsy. Otherwise joins `sessions` → `users` → `departments` (LEFT JOIN, since `department_id` can be null) filtered to `s.token = ? AND s.expires_at >= datetime('now')` — an expired session simply returns no row, so expiry is enforced at read time (no separate "is expired" check needed; combined with hourly `cleanupSessions()` this keeps the `sessions` table from growing unbounded). Returns `null` if no row is found or the user's `active` flag is not `1` (disabled accounts fail auth even with a technically-valid, non-expired token). On a hit: parses `permission_overrides` (stored as a JSON string on the `users` row) into `Record<string, boolean>`, swallowing parse errors to an empty object; strips `permission_overrides` off the returned object; calls `resolvePermissions(row.role, overrides)` (from `src/permissions.ts`) to compute the final `permissions: Permission[]` array attached to the returned `AuthUser`.

```ts
export function getToken(req: Request): string | null
```
Reads the `Authorization` header; if it starts with `'Bearer '`, returns the trimmed remainder; otherwise `null`. No cookie/query-string fallback — bearer header only.

### Middleware
```ts
export function requireAuth(req: Request, res: Response, next: NextFunction): void
```
Reads the token via `getToken`, resolves it via `userFromToken`. If no valid user, responds `401 { error: 'Not authenticated' }` and stops. On success, sets `req.user` (typed `AuthUser`, augmented onto Express's `Request` in `src/types.ts`) and `req.token`, then calls `next()`. Every feature router calls `router.use(requireAuth)` near the top so all its routes require a session, per `docs/ARCHITECTURE.md` §5 conventions.

```ts
export function requireRole(role: Role): (req, res, next) => void
```
Returns middleware that 403s (`{ error: 'Forbidden: insufficient permissions' }`) unless `req.user.role === role`. Must run after `requireAuth` (relies on `req.user` already being set). **Currently unused by any route** — every route file uses `requirePermission`/`requireAnyPermission` instead; kept exported as the older, coarser mechanism (still referenced conceptually in `docs/ARCHITECTURE.md` as the thing `requirePermission` is "preferred over").

```ts
export function requirePermission(permission: Permission): (req, res, next) => void
```
Returns middleware that 403s unless `req.user.permissions.includes(permission)`. This is the standard per-route guard used throughout `src/routes/*.ts` (e.g. `requirePermission('hr.manage')`, `requirePermission('users.manage')`). Must run after `requireAuth`.

```ts
export function requireAnyPermission(permissions: Permission[]): (req, res, next) => void
```
Returns middleware that 403s unless `req.user.permissions` includes **at least one** of the given keys (`.some(...)`). Used where two independent feature areas are each legitimately allowed to perform the same action — concretely, `POST /users/departments` and `DELETE /users/departments/:id` in `src/routes/users.routes.ts` accept either `users.manage` or `hr.manage` (see that route's own extra in-handler logic for the additional "only if unused" restriction on `hr.manage`'s delete).

## Internal / non-exported helpers
- `SESSION_HOURS = 12` — module-level constant controlling session lifetime; interpolated directly into the SQL string in `createSession` (`datetime('now', '+${SESSION_HOURS} hours')`) — not a bound parameter, but the value is a hardcoded number, not user input, so this is safe from injection.
- `UserSessionRow` interface — the shape of the raw joined SQL row inside `userFromToken`, including the still-JSON-string `permission_overrides` and the joined `department_name`; not exported, purely a local typing aid.

## Dependencies
- `express` (types only: `Request`, `Response`, `NextFunction`).
- `./db` — `db` (direct `db.prepare(...)` calls for session CRUD — this file bypasses the `queryOne`/`queryAll`/`run` helpers and uses `db.prepare()` directly, unlike route files), `newToken`.
- `./types` — `AuthUser`, `Role` (and `Permission`, imported inline via `import('./types').Permission` in the `requirePermission`/`requireAnyPermission` signatures rather than a top-level import).
- `./permissions` — `resolvePermissions`.

## Used by
Every route module: `src/routes/users.routes.ts`, `src/routes/hr.routes.ts`, `src/routes/templates.routes.ts`, `src/routes/personal.routes.ts`, `src/routes/messages.routes.ts`, `src/routes/orders.routes.ts`, `src/routes/forms.routes.ts`, `src/routes/inventory.routes.ts`, `src/routes/auth.routes.ts`, `src/routes/form-builder.routes.ts`, `src/routes/ai.routes.ts` — typically for `requireAuth` plus one or more of `requirePermission`/`requireAnyPermission`; `auth.routes.ts` additionally calls `createSession`/`destroySession`/`getToken` directly for login/logout/me.

## Notes / gotchas
- `requirePermission`/`requireAnyPermission` type their `permission`/`permissions` parameter via an inline `import('./types').Permission` rather than a top-of-file `import type { Permission }` — purely a stylistic choice in this file, has no runtime effect, but means a reader searching for "where is `Permission` imported" in this file needs to look at the function signatures, not the top import block.
- All three guard middlewares (`requireRole`, `requirePermission`, `requireAnyPermission`) assume `requireAuth` already ran and populated `req.user` — calling one of them on a route that skipped `requireAuth` will always 403 (since `!req.user` short-circuits to the forbidden branch), not throw, so a misconfigured route fails closed rather than crashing.
- Session expiry is enforced purely by the `WHERE ... expires_at >= datetime('now')` clause in `userFromToken` — an expired-but-not-yet-cleaned-up row in `sessions` is simply invisible to this query; `cleanupSessions()` (hourly, from `server.ts`) only exists to keep the table small, not to enforce the actual auth boundary.
- A disabled account (`active != 1`) with an otherwise valid, unexpired session token is rejected in application code (`if (!row || row.active !== 1) return null;`) — not by a DB-level constraint — so disabling a user takes effect on their very next request without needing to touch `sessions`.
