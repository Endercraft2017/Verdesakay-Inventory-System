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

## 2026-09-24: Typed query builder (Kysely), not an ORM
We use Kysely as a **SQL compiler only**, in `src/shared/qb.ts`. `qb.selectFrom(...)` checks table
and column names and result types against `src/shared/db-types.ts`. That file is generated from
the real, migrated schema by `npm run db:types`, and `tests/db-types.test.ts` fails when it's stale.
The compiled SQL runs through the existing sync `queryAll`/`queryOne`/`run` helpers (Kysely's
`DummyDriver` never opens a connection). Tenancy (`activeDb()`), `BEGIN/COMMIT` transactions and
`node:sqlite` stay exactly as before. We rejected a full ORM (Prisma/TypeORM): it would mean
rewriting every query and the hand-written migrations, it fits the database-per-tenant model
poorly, and the payroll and report SQL is easier to read raw. Migration is gradual: new code
may use `qb` or raw SQL, and modules move over when they're touched. First converted module:
`core/personal.routes.ts`. Schema changes stay in `db.ts` (createSchema/migrate). Kysely's
migrator is not used.
