# `src/routes/auth.routes.ts`

## Purpose
Session lifecycle and self-service account endpoints: login (issues a bearer session token),
logout, "who am I", and a user's own password/display-name changes. Mounted at `/api/auth`.

## Routes / Exports

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `POST /login` | 🔓 none | `loginSchema` | `SELECT * FROM users WHERE username = ?` (lower-cased); on success `createSession(user.id)` inserts into `sessions`; conditionally `SELECT name FROM departments WHERE id = ?` | `200 {token, user:{id, username, full_name, role, department_id, department_name}}` | `401 {error:'Invalid username or password'}` if user missing, `active !== 1`, or `bcrypt.compareSync` fails |
| `POST /logout` | 🔑 `requireAuth` | — | `destroySession(req.token)` → `DELETE FROM sessions WHERE token = ?` (only if `req.token` is set) | `200 {ok: true}` | — (401 via `requireAuth` if unauthenticated) |
| `GET /me` | 🔑 `requireAuth` | — | none (reads `req.user`, already resolved by `requireAuth`/`userFromToken`) | `200 {user: req.user}` (the full `AuthUser`, including `.permissions`) | 401 if unauthenticated |
| `POST /change-password` | 🔑 `requireAuth` | `changePasswordSchema` | `SELECT * FROM users WHERE id = ?`; verifies `current_password` via `bcrypt.compareSync`; `UPDATE users SET password_hash = ?`; `DELETE FROM sessions WHERE user_id = ? AND token != ?` (drops every other session, keeps the current one) | `200 {ok: true}` | `400 {error:'Current password is incorrect'}` if the check fails; 401 if unauthenticated |
| `PUT /profile` | 🔑 `requireAuth` | `updateProfileSchema` | `UPDATE users SET full_name = ? WHERE id = ?` | `200 {ok: true, full_name}` | 401 if unauthenticated; 400 via zod if `full_name` invalid |

### Schemas (from `src/validation.ts`)
- `loginSchema = z.object({ username: trimmed.min(1), password: z.string().min(1) })`
- `changePasswordSchema = z.object({ current_password: z.string().min(1), new_password: z.string().min(6) })`
- `updateProfileSchema = z.object({ full_name: trimmed.min(1).max(120) })`

All parsed via `parseBody(schema, req.body)`, which throws a `ValidationError` (status 400) on
failure — caught by the central error handler in `app.ts`, not handled inline in this file.

## Dependencies
- `express` — `Router`.
- `bcryptjs` — `bcrypt.compareSync` (login, change-password) and `bcrypt.hashSync` (change-password).
- `../db` — `queryOne`, `run`.
- `../auth` — `createSession`, `destroySession`, `requireAuth`.
- `../validation` — `parseBody`, `loginSchema`, `changePasswordSchema`, `updateProfileSchema`.
- `../types` — `UserRow` (typing the row fetched from `users`).

## Used by
- `src/app.ts` — mounted as `app.use('/api/auth/login', loginLimiter)` (rate limiter applied only
  to the login sub-path) then `app.use('/api/auth', authRoutes)`.
- `tests/auth.test.ts` — covers login, `/me`, logout, change-password, and (indirectly, via
  `updateUserSchema`/RBAC in `users.routes.ts`) the last-admin guard.
- `tests/helpers.ts` — `login()` helper used by nearly every other test file calls
  `POST /api/auth/login` to obtain a session token.
- `public/js/app.js` — the frontend's `App` auth flow (login screen, session resume, logout) calls
  `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`.
- `public/js/views/account.js` — "My Account" view calls `/api/auth/change-password` and
  `/api/auth/profile`.

## Notes / gotchas
- Login intentionally returns the same generic `401 'Invalid username or password'` whether the
  username doesn't exist, the account is deactivated (`active !== 1`), or the password is wrong —
  avoids leaking which case applies.
- `change-password` revokes every *other* session for the user (`token != ?`) but deliberately
  keeps the current session alive, so the caller isn't logged out by changing their own password.
- Session tokens expire after 12 hours (`SESSION_HOURS` in `src/auth.ts`), enforced at the DB-query
  level in `userFromToken` (`s.expires_at >= datetime('now')`), not in this file.
- `PUT /profile` only updates `full_name` — there is no self-service username or role change here
  (those are `users.manage`-gated in `users.routes.ts`).
