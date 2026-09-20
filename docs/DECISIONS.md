# Architecture Decision Log

Short record of *why* the stack is what it is. Add an entry when a significant choice is made.

## 2026-06-20 — Backend language: TypeScript (not Python)
The frontend is already JavaScript. TypeScript keeps the whole stack in **one language**,
lets the backend reuse/share types, and made the migration a **low-risk port** of working
Express code rather than a full rewrite. Python/FastAPI would have meant a second language,
a new runtime to install, and rewriting every route and the DB layer — with no real benefit
for a small SQLite-backed LAN app. TypeScript's static typing also directly serves the goal
of preventing duplicate/spaghetti code.

## 2026-06-20 — Run with `tsx`, type-check with `tsc`, no build artifacts
`tsx` runs `.ts` directly, so there is no `dist/` to manage or keep in sync — simplest for a
local office deployment. Full type safety still comes from `tsc --noEmit` in `npm run check`.

## 2026-06-20 — Database: Node built-in `node:sqlite`
Zero native compilation (a real pain point on Windows), zero extra services, one-file
backups. A single connection is fine for office-scale concurrency. Note: `node:sqlite` has
no `.transaction()` helper — use explicit `BEGIN/COMMIT/ROLLBACK` via `db.exec`.

## 2026-06-20 — Validation with `zod`, centralized in `src/shared/validation.ts`
One place for all input rules; schemas double as TypeScript types via `z.infer`. Replaces
scattered hand-rolled checks, improving both security and readability.

## 2026-06-20 — Security: `helmet` + login rate-limiting
`helmet` sets safe HTTP headers; `express-rate-limit` throttles `/api/auth/login` to slow
brute-force guessing. Passwords are bcrypt-hashed; sessions are random 256-bit tokens with a
12-hour expiry. (CSP is currently relaxed because views use inline scripts — tighten if the
app is ever exposed beyond the LAN.)

## 2026-06-20 — Tests: `vitest` + `supertest`, isolated temp DB per file
`vitest` runs TypeScript natively; `supertest` drives the real Express app in-process.
Each test file gets its own throwaway SQLite DB + uploads dir (`DB_PATH`/`UPLOAD_DIR`), so
`npm test` is fully headless and needs no manual setup or a running server.
