# SaaS / Multi-Tenancy Readiness — Schema Sweep

> **Status:** Phase 1 (§10 step 1) landed 2026-08-28 — connection registry + async
> context are in, single-tenant behaves exactly as before. Steps 2+ not started.
> **Last updated:** 2026-08-28
> **Question asked:** "Can this be a SaaS (many companies on one deployment)?"

**Short answer:** yes, and the current design is closer than it looks — *because* it's
SQLite. The right model is **one database file per tenant**, not a shared schema with a
`tenant_id` column on every row. That choice keeps ~95% of the schema untouched. The real
work is in the plumbing (one connection → a per-request connection), not the tables.

---

## 1. Two ways to be multi-tenant

| | **A. Database-per-tenant** (one `data.db` per company) | **B. Shared schema** (`tenant_id` on every table) |
|---|---|---|
| Schema changes | Almost none — see §3 | `tenant_id` column + composite UNIQUE on **every** table (§4) |
| Isolation | Physical. A missing `WHERE` can't leak another tenant's data. | Logical. One forgotten `AND tenant_id = ?` = data breach. |
| Backup / export / delete one tenant | `cp tenant.db` / `VACUUM INTO` / `rm` | Row-by-row `DELETE`, careful export queries |
| Per-tenant restore to a point in time | Trivial (it's a file) | Effectively impossible |
| Noisy neighbour | Contained to one file | Shared write lock, shared page cache |
| Move a big tenant to its own box | Copy one file | Data migration project |
| Cross-tenant admin reporting | Iterate files / attach DBs | One `GROUP BY tenant_id` |
| Connection / FD cost | One open handle per active tenant | One handle total |
| Migrations | Run per file (§7) | Run once |

For SQLite, **A is the standard SaaS pattern** and the one this codebase should take.
B fights SQLite's single-writer model and multiplies the blast radius of every bug.
The rest of this document assumes **A**.

---

## 2. The one hard blocker — ✅ done (Phase 1)

`src/db.ts` used to open a **single process-wide connection at import time**
(`export const db = new DatabaseSync(DB_PATH)`). Every module (**26 files**, **~159**
`db.prepare` / `db.exec` call sites) imported that singleton or the helpers bound to it.
Nothing carried a tenant.

**What was done (commit after this doc's Phase-1 update):**

1. **Connection registry** — `getDb(slug)` opens `<DATA_DIR>/<slug>.db` (or `DB_PATH`
   for `default`) on first use, runs `createSchema()` + `migrate()` + `seed()` against it,
   caches the handle in a `Map`.
2. **Request context** — `tenantStore = new AsyncLocalStorage<{db, slug}>()`. A
   middleware in `src/app.ts` (right after the body parsers, before the request logger
   and idempotency store) does `tenantStore.run({ db: getDb(slug), slug }, next)`. Today
   `slug` is always `default`; host/subdomain resolution slots in at §6.
3. **`db` is now a `Proxy`** onto `activeDb()` (`= tenantStore.getStore()?.db ?? getDb('default')`).
   The ~159 `db.prepare(...)` / `db.exec('BEGIN')` call sites are **unchanged** — they
   just resolve to the active connection. `queryOne`/`queryAll`/`run`/`getSetting`/
   `setSetting`/`nextSequence` go through the same proxy, so they're tenant-aware too.
4. **Background jobs** — `cleanupSessions()` now loops `registry.keys()` via
   `withTenant(slug, fn)`. RAG `maybeReindex` / mail retry still assume the default
   tenant — fine until step 2, revisit then.

Single-tenant behaviour is byte-for-byte the same: `DB_PATH` still points at `data.db`,
`init()` still works, all 452 tests green, live login + authed routes verified.

Everything below is small by comparison and **not yet started**.

---

## 3. Schema sweep — table by table

All of these live **inside each tenant's DB file**. "Action" is what (if anything) changes
under model A.

### Core / auth

| Table | Tenant-scoped? | Action for SaaS |
|---|---|---|
| `departments` | ✅ per-tenant | none |
| `users` | ✅ per-tenant | **Add `email`** (verification, password reset, billing contact — there is no email column today, username only). Add `must_change_password`, `last_login_at`. Password-reset flow doesn't exist yet. |
| `sessions` | ✅ per-tenant | none — but note a token is only meaningful once you know which tenant DB to look in, so tenant resolution must run **before** auth (§6). |
| `idempotency_keys` | ✅ per-tenant | none |
| `settings` (k/v) | ✅ per-tenant | Holds several singletons that become **per-tenant config**: `company_profile`, `payroll_policy`, `mail_settings` + `mail_smtp_pass`, `_secret_key`, all the `*_seq` counters, `rag_indexed_at`. All fine per-file. **But** `_secret_key` (§5) and the AI key (§6) need policy decisions. |

### Inventory / manufacturing

| Table | Action |
|---|---|
| `suppliers`, `locations`, `inventory_items`, `bom_components` | none |
| `inventory_transactions`, `inventory_stock` | none |
| `orders`, `order_items` | none — auto-number `SO-#####` etc. is per-file, so counters don't collide between tenants |
| `job_orders`, `job_order_components`, `job_order_units`, `qc_records` | none |

### Documents / forms / activity

| Table | Action |
|---|---|
| `doc_templates`, `doc_variables`, `global_variables` | none — seed defaults per tenant at provision time (already idempotent in `seedTemplates`) |
| `forms`, `form_definitions`, `form_records` | none — **but uploaded files need per-tenant folders (§5)** |
| `activity_log` | none. Add a **retention policy** (per plan) so it doesn't grow unbounded. |
| `mail_log` | none. Same retention note. Feeds per-tenant sending-quota checks. |
| `doc_chunks` (FTS5) | none — `reindex()` is wholesale `DELETE` + rebuild, cost scales with that tenant's corpus only. Fine. |

### HR / payroll

| Table | Action |
|---|---|
| `employees`, `employee_documents`, `shifts`, `attendance_periods`, `attendance_records` | none. `employee_documents` and `employees.photo` are uploads → per-tenant folders (§5). Statutory fields (`sss_no`, `philhealth_no`, `tin_no`) are PH-specific — fine, but a future non-PH tenant will want them optional/relabelled. |

### Personal tools

| Table | Action |
|---|---|
| `notes`, `tasks`, `bookmarks` | none |

**Net:** the only *table* changes are `users.email` (+ a couple of nullable columns) and
optional retention columns. Everything else is untouched under model A.

---

## 4. Why model B would hurt — the UNIQUE/sequence inventory

If you ever go shared-schema, every one of these needs `tenant_id` prepended, and every
query that touches them needs a tenant filter. Listed here as the concrete evidence for
choosing A:

- Single-column UNIQUE: `departments.name`, `users.username`, `inventory_items.sku`,
  `orders.number`, `job_orders.number`, `settings.key`, `form_definitions.slug`,
  `form_records.number`, `global_variables.key`, `employees.employee_no`.
- Composite UNIQUE: `bom_components(product_item_id, component_item_id)`,
  `inventory_stock(item_id, location_id)`,
  `job_order_components(job_order_id, component_item_id)`,
  `attendance_records(period_id, employee_id, work_date)`,
  `idx_doc_variables_key(scope, template_id, key)`,
  `idx_employees_user_id(user_id)`.
- Shared auto-number counters in `settings` via `nextSequence()` — order numbers,
  form-record numbers, `employee_seq`. Under B these collide across tenants; under A each
  file has its own.
- `doc_chunks` FTS5 has no tenant column and FTS5 can't cheaply add one — RAG would need
  a separate index per tenant anyway. Under A that's automatic.

---

## 5. Filesystem & secrets

**Uploads.** [src/db.ts:15](../src/db.ts#L15) — one flat `UPLOAD_DIR` for everything:
`forms.stored_name`, `employee_documents.stored_name`, `inventory_items.image_path`,
`employees.photo`, AI report files (`ai-report-*`), mobile damage photos. Filenames are
random hex so they won't collide, but there's **no tenant boundary** for quota accounting,
bulk export, or "delete this customer". Move to `uploads/<tenant>/…` and derive the path
from request context. The download routes already auth-check + allowlist filenames; they'd
additionally scope to the caller's tenant folder.

**Encryption key.** [src/secrets.ts:15](../src/secrets.ts#L15) — falls back to an
auto-generated key stored in each DB's `settings._secret_key`. Under SaaS that means every
tenant file is self-decrypting if someone copies it. **Decision needed:**
- *Simplest:* require `APP_SECRET` in the environment for SaaS mode, refuse the
  auto-generate path, so encrypted blobs (SMTP passwords, future AI keys) are only readable
  with the platform key.
- *Stronger:* per-tenant data key wrapped by the platform key (envelope encryption). More
  work; worth it only if tenant DB files leave your infrastructure.

**Backups.** Model A's payoff: `VACUUM INTO 'backups/<slug>-<ts>.db'` per tenant on a
schedule; restore = swap the file. Add this as a platform job.

---

## 6. Tenant resolution & auth order

Today: `requireAuth` reads a bearer token, looks it up in `sessions`, done. Under SaaS the
middleware chain becomes:

1. **Resolve tenant** from the request — subdomain (`acme.app.com`), custom domain
   (`inventory.acme.com` → lookup table), or an `X-Tenant` header for API clients.
2. **Open that tenant's DB** (registry, §2) and put it in the async store.
3. *Then* validate the session token against that DB's `sessions` table.
4. 404/holding page if the tenant is unknown, suspended, or past due.

Consequences:
- The same person at two companies has **two separate accounts** (one per tenant DB). Norm
  for SaaS; don't try to share a user row.
- `loginLimiter` in [src/app.ts:43](../src/app.ts#L43) is global — make it keyed by
  `tenant + IP` so one tenant can't rate-limit another.
- `helmet({ contentSecurityPolicy: false })` — acceptable for now; a shared apex domain
  with per-tenant subdomains eventually wants a real CSP.

**AI key.** [src/routes/ai.routes.ts:171](../src/routes/ai.routes.ts#L171) reads one
global `CEREBRAS_API_KEY`. You already decided each tenant brings their own (or you set it
for them) — so give it the **exact BYO treatment `mail` just got**: an encrypted
`settings.ai_config` per tenant (key + model + optional base URL), a small settings UI, and
a fallback to the platform env key when a tenant hasn't set one. See
[EMAIL-SETUP.md](EMAIL-SETUP.md) / `src/mailer.ts` for the pattern to copy.

---

## 7. Migrations & provisioning

`init()` + `migrate()` currently run once at boot. Under A they must run **per tenant DB**.

- `migrate()` is a long list of `PRAGMA table_info` probes — cheap but not free at N
  tenants on every cold open. Add `settings.schema_version` and short-circuit when current.
- Three migrations rebuild tables with `PRAGMA foreign_keys = OFF` (`users`, `orders`,
  `doc_templates`, `employees`). Running those lazily on first request under load is
  risky. Better: a **deploy-time migration runner** that walks every tenant file with the
  tenant briefly locked, and only *new* tenants get the schema inline at provision.
- **Provisioning** (`seed()`) needs to become an explicit `createTenant({slug, name,
  adminEmail, adminPassword, plan})` that creates the file, runs schema, seeds departments
  + templates + `hr_payroll`, and creates the **first admin from the signup form** — not
  from `process.env.ADMIN_PASSWORD`.
- **De-provisioning**: export (zip the DB + `uploads/<slug>/`), then delete both. Keep a
  grace-period tombstone.

---

## 8. What has no home today — the control plane

New, and it lives **outside** the tenant DBs (its own `platform.db` or Postgres):

| Concern | Sketch |
|---|---|
| `tenants` | `id, slug, name, status (trial/active/past_due/suspended/purged), plan, trial_ends_at, created_at` |
| `tenant_domains` | custom-domain → tenant mapping, verification state |
| `platform_users` | *your* staff who can see across tenants (support, billing) — separate from any tenant's `users` |
| `subscriptions` / billing | plan, seats, current period, Stripe (or manual) — drives §9 |
| `provisioning_log` | audit of create/migrate/suspend/delete per tenant |
| `tenant_secrets` (optional) | if you centralise SMTP/AI keys instead of per-tenant `settings` |

---

## 9. Plans, quotas, lifecycle

None of this exists yet; all enforceable cheaply per-tenant because the data is one file:

- **Quotas:** users, inventory items, storage MB (`uploads/<slug>` size), AI calls/month,
  emails/day (you already log every send in `mail_log`). Check at the create endpoints;
  surface usage in an admin page.
- **Lifecycle states** gate the tenant-resolution middleware: `trial` (banner +
  countdown), `past_due` (read-only or lock), `suspended` (holding page), `purged`.
- **Retention** by plan for `activity_log`, `mail_log`, `idempotency_keys`,
  soft-deleted rows.

---

## 10. Suggested phasing

1. ~~**Connection registry + async context** (§2). No behaviour change — single-tenant
   still works, it's just "tenant `default`".~~ ✅ **done 2026-08-28.**
2. **Tenant resolution middleware + `platform.db` with `tenants`** (§6, §8). Subdomain
   only to start. ← next
3. **Provisioning / de-provisioning commands** (§7) + per-tenant upload folders (§5).
4. **BYO AI key** mirroring mail (§6). Small, high value.
5. **`users.email` + password reset** (§3).
6. **Plans, quotas, lifecycle states, retention** (§9).
7. **Custom domains, per-tenant branding, billing integration** (§8).
8. **Backups job, deploy-time migration runner** (§5, §7).

Steps 1–3 are "multi-tenant at all". 4–8 are "a product you can sell".

---

## Appendix — files that bind to the singleton connection

`grep "from './db'\|from '../db'"` → 26 source files; ~159 `db.prepare`/`db.exec` sites.
All go through `queryOne` / `queryAll` / `run` / `getSetting` / `setSetting` /
`nextSequence`, so making those six context-aware covers almost everything; the direct
`db.*` sites (mostly in `db.ts` itself and a few transaction blocks) are the manual part.
