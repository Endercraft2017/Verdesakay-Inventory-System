# SaaS / Multi-Tenancy Readiness — Schema Sweep

> **Status:** Phases 1–8 landed (§10). Connection registry + async context (2026-08-28);
> `platform.db` catalog + tenant-resolution middleware + provisioning CLI + `/api/signup`
> (2026-08-29); per-tenant uploads + BYO AI key + `users.email`/password reset + plan
> quotas & lifecycle (2026-08-29); **per-tenant feature modules + the `/_platform` owner
> console (2026-09-10)**. Single-tenant / self-hosted still behaves exactly as before (the
> `default` tenant needs no catalog row, has every module, and the console is off unless
> `PLATFORM_CONSOLE=true`). Backups job done 2026-09-24 (daily + pre-migration snapshots, see
> SAAS-OPERATIONS.md#backups). Remaining: custom domains / branding / billing, retention policies.
> **Last updated:** 2026-10-10 (billing, §12)
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

`src/shared/db.ts` used to open a **single process-wide connection at import time**
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

**Uploads.** [src/shared/db.ts:15](../src/shared/db.ts#L15) — one flat `UPLOAD_DIR` for everything:
`forms.stored_name`, `employee_documents.stored_name`, `inventory_items.image_path`,
`employees.photo`, AI report files (`ai-report-*`), mobile damage photos. Filenames are
random hex so they won't collide, but there's **no tenant boundary** for quota accounting,
bulk export, or "delete this customer". Move to `uploads/<tenant>/…` and derive the path
from request context. The download routes already auth-check + allowlist filenames; they'd
additionally scope to the caller's tenant folder.

**Encryption key.** [src/shared/secrets.ts:15](../src/shared/secrets.ts#L15) — falls back to an
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

**AI key.** [src/modules/ai/ai.routes.ts:171](../src/modules/ai/ai.routes.ts#L171) reads one
global `CEREBRAS_API_KEY`. You already decided each tenant brings their own (or you set it
for them) — so give it the **exact BYO treatment `mail` just got**: an encrypted
`settings.ai_config` per tenant (key + model + optional base URL), a small settings UI, and
a fallback to the platform env key when a tenant hasn't set one. See
[EMAIL-SETUP.md](EMAIL-SETUP.md) / `src/shared/mailer.ts` for the pattern to copy.

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
| `subscriptions` / billing | plan, seats, current period, invoices; manual GCash / bank transfer now, PayMongo later (§12) — drives §9 |
| `provisioning_log` | audit of create/migrate/suspend/delete per tenant |
| `tenant_secrets` (optional) | if you centralise SMTP/AI keys instead of per-tenant `settings` |

---

## 9. Plans, quotas, lifecycle, feature modules

All enforceable cheaply per-tenant because the data is one file:

- **Quotas:** users, inventory items, storage MB (`uploads/<slug>` size), AI calls/month,
  emails/day (you already log every send in `mail_log`). Check at the create endpoints;
  surface usage in an admin page. ✅ **done 2026-08-29** (`src/platform/quota.ts`).
- **Lifecycle states** gate the tenant-resolution middleware: `trial` (banner +
  countdown), `past_due` (read-only or lock), `suspended` (holding page), `purged`.
  ✅ **done 2026-08-29**.
- **Feature modules** — which capability *areas* a workspace has, not just how many rows.
  ✅ **done 2026-09-10** — `src/shared/modules.ts`: `MODULES` = inventory / manufacturing /
  purchasing / hr / accounting / ai / mobile / email / quickbooks; the rest (Home,
  Documents, Templates, Messages, user Admin, Activity) is un-gated "core". The enabled
  set = `PLAN_MODULES[plan]` (`src/platform/plans.ts`) overridden by a nullable `tenants.modules`
  JSON array, with `MODULE_DEPS` unioned in (`manufacturing`/`purchasing` → `inventory`).
  `requireModule(name)` wraps the route mounts in `src/app.ts` (402 when off, ahead of
  `requireAuth`); `GET /api/tenant`, `POST /auth/login` and `GET /auth/me` carry
  `modules[]`; `nav-config.js` leaves/subtabs take a `requiredModule` and `app.js` /
  mobile `app.js` expose `hasModule()`; the `/m` PWA serves a "not enabled" notice when
  `mobile` is off. CLI: `npm run tenant:modules`. `default` tenant = every module.
  Tests: `tests/modules.test.ts`.
- **Retention** by plan for `activity_log`, `mail_log`, `idempotency_keys`,
  soft-deleted rows. *(still TODO.)*

---

## 10. Suggested phasing

1. ~~**Connection registry + async context** (§2).~~ ✅ **done 2026-08-28.**
2. ~~**Tenant resolution middleware + `platform.db` with `tenants`** (§6, §8).~~ ✅ **done
   2026-08-29** — `src/platform/platform.ts` (`platform.db`: `tenants` + `provisioning_log`,
   `resolveTenantSlug`, catalog helpers), `src/platform/provisioning.ts` (`createTenant` /
   `suspend` / `resume` / `purge`), the resolver middleware in `src/app.ts` (sub-domain,
   or `X-Tenant`/`?tenant` in non-prod; `default` needs no row; unknown → 404, suspended
   → 403), `scripts/tenant.ts` (`npm run tenant:create|list|status|purge`), and
   `POST /api/signup` gated by `SIGNUPS_OPEN`. Tests: `tests/multitenancy.test.ts`.
3. Provisioning / de-provisioning (done with phase 2) + **per-tenant upload folders**
   (§5) ✅ 2026-08-29 — `db.uploadDir()` resolves `UPLOAD_DIR` for `default`,
   `UPLOAD_DIR/<slug>` otherwise; all item-image / form-file / 201-doc / AI-report
   read/write/delete goes through it; `purgeTenant` deletes the folder. Plus
   `SCHEMA_VERSION` + `settings.schema_version` short-circuit in `getDb()` and a
   `npm run migrate:all` deploy-time runner (`scripts/migrate-all.ts`, `db.forceMigrate`).
   Still to do: per-tenant upload *quota* accounting (§9).
4. ~~**BYO AI key** mirroring mail (§6).~~ ✅ 2026-08-29 — `src/modules/ai/ai-config.ts`
   (`settings.ai_config` + AES `ai_api_key`), `GET/PUT /api/ai/config` (`users.manage`),
   AI Assistant → AI settings modal; falls back to the `CEREBRAS_*` env key.
5. ~~**`users.email` + password reset** (§3).~~ ✅ 2026-08-29 — `users.email` column +
   admin-UI field; `password_resets` table; `POST /auth/forgot-password` (no
   account-existence leak, emails a 1 h link via the tenant mailbox) + `/auth/reset-password`;
   "Forgot password?" on the login screen + a `?reset=<token>` set-new-password flow.
6. ~~**Plans, quotas, lifecycle states** (§9).~~ ✅ 2026-08-29 — `src/platform/plans.ts` +
   `src/platform/quota.ts`: `enforceQuota()` (402) at `POST /users` / `/inventory` / file uploads /
   `/ai/chat`; `GET /api/tenant` + a frontend trial/past-due banner; a lapsed `trial` or
   `past_due` → writes blocked (reads + auth still work); `npm run tenant:plan|usage`.
   *Retention policies still TODO.*
7. ~~**Feature modules** — enable/disable whole capability areas per tenant (§9).~~ ✅
   2026-09-10 — `src/shared/modules.ts` (`requireModule()` gate + plan-bundle defaults + nullable
   `tenants.modules` override + dep union), `modules[]` on `/api/tenant` & the auth
   payloads, `requiredModule` in `nav-config.js` + `hasModule()` in desktop & mobile
   `app.js`, `npm run tenant:modules`. `tests/modules.test.ts`.
8. ~~**Owner console** — the `/_platform` control-plane UI + `platform_users` (§8, §11).~~
   ✅ 2026-09-10 — `src/platform/platform-users.ts` (operator accounts + sessions in `platform.db`,
   `requirePlatformAuth`, `PLATFORM_ADMIN_TOKEN` option), `src/platform/platform.routes.ts`
   (`/_platform/api/*`: login / tenants CRUD / plan+status+modules PATCH / purge / log;
   404s off the apex host), `web-console/` (dependency-free SPA), mounted in `src/app.ts`
   only when `PLATFORM_CONSOLE=true`. CLI: `npm run platform:user`. Tests:
   `tests/platform-console*.test.ts`.
   Owner recovery: open a workspace in `/_platform/` and use **Owner login recovery**.
   It displays the first administrator (lowest user ID with role `admin`) and lets an
   operator set and confirm a new password. `POST /_platform/api/tenants/:slug/reset-owner-password`
   accepts `{ owner_id, new_password }`; the account ID must match the displayed owner.
   Recovery revokes that account's sessions and password-reset links and records the
   operator and account in the provisioning log, without storing the password there.
   Account activation and workspace suspension remain separate controls.
   When operators create a workspace, **Sandbox account** permits company name and
   login details only; the slug can be generated automatically. Regular accounts require
   a valid owner recovery email, saved on the first admin. Existing tenants default to
   regular accounts; creation validation does not change their existing login details.
   Recovery emails include the username; operators can also use **Email owner username**.
   Regular owner password resets send a notification without the new password. Email
   uses the workspace's existing SMTP settings; the console reports delivery failures.
   Sandbox recovery sends no emails, even if an email address is added later.
   **Remove sandbox tenant** requires the slug confirmation and permanently deletes
   its database and uploads, removing it from the active tenant list. The provisioning
   audit record remains available.
   If recovery email fails, **Generate temporary password** displays a random password
   once in the operator's panel for direct sharing. It is never emailed or logged,
   expires after 24 hours, revokes existing sessions and recovery links, and requires
   the owner to choose a different password before desktop, mobile, or WebSocket access.
   Closing the panel removes the displayed password. Sandbox operators can use this
   action directly because sandbox recovery email is disabled.
9. **Custom domains, per-tenant branding, billing integration** (§8; billing phase a built 2026-10-10 — §12).
10. **Backups job, deploy-time migration runner** (§5, §7).
11. **Retention policies** by plan (`activity_log` / `mail_log` / soft-deletes) (§9).

Steps 1–3 are "multi-tenant at all". 4–8 are "a product you can sell".

---

## 11. Phase 2 — researched recommendation (2026-08-28)

Question: what's the industry standard for tenant identification, the control plane, and
provisioning? Findings and the pick for this codebase.

### Tenant identification → **subdomain, resolved in middleware, + a dev-only fallback**

Industry standard for B2B SaaS is **subdomain per tenant** (`acme.app.afkcube.com`),
resolved as early as possible in middleware, with the tenant then carried in the
session/JWT for the rest of the request. Path-based (`/acme/…`) is the fallback when
wildcard DNS/TLS isn't practical (e.g. Vercel); header-based (`X-Tenant`) is for pure
API products. ([zenn.dev SaaS 2025](https://zenn.dev/shineos/articles/saas-multi-tenant-architecture-2025?locale=en),
[hafiz.dev](https://hafiz.dev/blog/laravel-multi-tenancy-database-vs-subdomain-vs-path-routing-strategies),
[AWS tenant routing](https://aws.amazon.com/blogs/networking-and-content-delivery/tenant-routing-strategies-for-saas-applications-on-aws))

**Pick:** subdomain-primary. Extend the Phase-1 middleware in `src/app.ts` to derive
`slug` from `Host` (first label; reject reserved: `www app api admin static _platform`).
Also accept `X-Tenant` / `?tenant=` **when `NODE_ENV !== 'production'`** so tests and
`localhost` dev work with no DNS. Custom domains (`inventory.acme.com`) come in Phase 7
as a `tenant_domains` lookup feeding the *same* resolver. Wildcard TLS (`*.app.afkcube.com`)
is an ops task, not code.

### Control plane → **a dedicated `platform.db`, off the request path**

Standard practice: a **separate catalog/registry database** holding tenant metadata +
tenant→location mapping, with onboarding/provisioning logic deliberately unreachable from
tenant-facing code (it runs with provisioning privileges).
([Azure control planes](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/control-planes),
[Azure catalog/provisioning](https://learn.microsoft.com/en-us/azure/azure-sql/database/saas-dbpertenant-provision-and-catalog?view=azuresql))
Some pure per-file SQLite setups let the filesystem *be* the registry
([uradical](https://uradical.io/latest-news/how-we-build-multi-tenant-services-with-per-tenant-sqlite)) —
fine until you need status/plan/billing, which we do.

**Pick:** `platform.db` (its own SQLite file, its own connection — **not** via
`tenantStore`), wrapped by a new `src/platform/platform.ts`. Tables now: `tenants`
(`id, slug UNIQUE, name, status, plan, created_at, trial_ends_at`), `provisioning_log`.
Later: `platform_users`, `tenant_domains`, `subscriptions`. Control-plane routes live
under `/_platform` (later `admin.app.afkcube.com`), guarded separately. The tenant
resolver reads `tenants` on each request and fast-rejects unknown / `suspended` /
`purged` before opening any tenant DB.

### Provisioning → **explicit `createTenant()`, self-serve behind a flag**

Standard: **automate provisioning from day one** (manual becomes the bottleneck fast);
self-serve signup is the PLG norm, optionally with an approval/waitlist gate.
([Northflank 2026](https://northflank.com/blog/multi-tenant-saas-platform-deployment),
[Auth0 onboarding](https://auth0.com/blog/user-onboarding-strategies-b2b-saas/),
[Alibaba B2B auth guide](https://smartbuy.alibaba.com/b2b/how-to-build-a-scalable-multitenant-authentication-for-b2b-saas))

**Pick:** `createTenant({slug, name, adminEmail, adminPassword, plan})` — inserts the
`tenants` row, then `withTenant(slug, …)` to create + seed the file and the **first admin
from the signup payload** (not `ADMIN_PASSWORD`), then writes `provisioning_log`. Expose
it two ways: a `POST /signup` route **gated by a `SIGNUPS_OPEN` env flag** (off ⇒ you
provision via `/_platform` or a `npm run tenant:create` script), and the script itself.
De-provision = export (`VACUUM INTO` + zip `uploads/<slug>`) → `status=purged` → delete
after a grace period.

### Migrations → **keep lazy per-file + add a batch runner**

Standard for per-file SQLite: migrate per tenant, tracked per tenant, lazily on first
connect after a deploy — "no migration runner to schedule"
([uradical](https://uradical.io/latest-news/how-we-build-multi-tenant-services-with-per-tenant-sqlite)) —
while big table-rebuilds are better done proactively
([Azure](https://learn.microsoft.com/en-us/azure/azure-sql/database/saas-tenancy-app-design-patterns?view=azuresql)).

**Pick:** Phase 1 already migrates on first `getDb(slug)` — keep it. Add `settings.schema_version`
to skip the PRAGMA probes on warm opens, and a `npm run migrate:all` that walks
`tenants` and opens each once so a deploy pays the cost, not the first unlucky request.

### Not doing

Shared-schema `tenant_id` columns — research is explicit that it fights SQLite's single
writer ("all tenants fighting each other to get the single write lock")
([DEV: SQLite isolation](https://dev.to/helperx/multi-tenant-data-isolation-in-sqlite-per-user-database-files-vs-row-level-5glm),
[High Performance SQLite](https://highperformancesqlite.com/watch/multi-tenancy)).

### Open questions for the owner

- Root domain for tenant subdomains? (`*.app.afkcube.com`? something else?)
- Self-serve signup **open** at launch, or **flag-off** and you provision each tenant?
- Control-plane admin: a `/_platform` page in this same app now, or just the CLI script
  until it's needed?

---

## 12. Billing (decided + phase a built 2026-10-10)

**Decision:** collect fees by **manual GCash / bank transfer** first — the customer reports the
payment with its reference number and a receipt screenshot (and the BIR 2307 when they withhold),
and an operator confirms it against the GCash / bank history. **PayMongo** comes later, once the
business is registered (DTI/SEC + BIR 2303); an unregistered PayMongo "Individual" account is QR Ph
only with a ₱50k wallet cap. Personal GCash has no API, so there is no automatic detection.

**Why:** Stripe does not onboard Philippine companies; PayMongo is cheaper than Xendit and has no
dormant fee. Buyers with ≥₱12M (≥₱5M in smaller districts) gross sales are BIR Top Withholding
Agents and withhold 2% EWT (on the amount net of VAT) with a Form 2307, so an invoice paid by
transfer must stay possible. Under the EOPT Act (RR 7-2024) the BIR-registered invoice is the
primary sales document; this app records its number (`bir_invoice_no`) but does not print it.

**Who pays when:** a company that signs up on the public website (`/api/signup`) **pays before it
gets in** — its workspace is created with `tenants.awaiting_payment = 1`; only sign-in, Billing and
Support answer (`src/app.ts`, 402 otherwise; `/m` shows a "finish payment on a computer" page) until
an operator confirms the first payment. A workspace the operator creates in the console is never
locked. The operator can also open a waiting workspace by hand (console → tenant → Billing).

**Website = "Talk to us" (2026-10-10, same day):** the public site sells by conversation, not
self-serve checkout. Every call to action opens a **Talk to us** form (name, company, email,
mobile, employees, modules of interest, message; rate-limited + honeypot) stored in `platform.db`
`inquiries` (`src/platform/inquiries*.ts`, `POST /site/inquiry`). The owner works them in the
console's **Inquiries** view (status new/contacted/won/lost, notes) and **creates the workspace from
the inquiry** — prefilled, linked, and optionally **locked until the first payment**. The phone /
email / Messenger shown beside the form are set in the console. Self-serve sign-up (below) stays
built but off (`SIGNUPS_OPEN` unset); its buttons only appear if it is turned on.

**Owner email alerts (2026-10-12):** the platform has its own mailbox (`src/platform/platform-mail.ts`,
console → **Email alerts**), separate from each workspace's BYO-SMTP. It emails the owner on a new
website inquiry, a customer-reported payment and a self-serve sign-up (each switchable), with a
test-email button and a send log. Transport **Brevo** (HTTPS API) or **SMTP**: Railway blocks
outgoing SMTP below its Pro plan, so Brevo is the default recommendation. The API key / password
is encrypted in `platform.db` (with `MAIL_SECRET_KEY` / `APP_SECRET` when set) and never returned.

**First invoice:** the console's price list (per module per month + per login seat) prices the
sign-up's quote; when every chosen module and the seat price have a price, the first month's
invoice is issued automatically (due in 7 days) and the website shows the monthly total before
sign-up. Otherwise the workspace still waits and the operator issues the invoice.

**Built (`src/platform/billing.ts`, `billing.routes.ts`, `billing-console.routes.ts`):** invoices +
payments + settings in `platform.db` (centavos; VAT 12% when VAT-registered; EWT default 2%);
customer reporting with channel `gcash`/`bank`; operator confirm / reject / record / void / BIR
invoice no.; GCash name, number and QR image; bank details; price list. Paid → a waiting workspace
opens, a `trial`/`past_due` one becomes `active` (a `suspended` one is left alone). Console: header
**Billing** view + per-tenant **Billing** tab (`web-console/billing.js`). Desktop: Admin → Billing
(`public/js/modules/core/billing.js`), banner link, and the locked shell while awaiting payment.

**Not built:** PayMongo (checkout + webhook, then subscriptions); automatic overdue → `past_due`;
email/notification to the operator on a new sign-up or reported payment (the console badge counts
payments to review); recurring monthly invoices (the operator issues them).

**Not verified:** the EWT / invoicing rules should be confirmed by the company's accountant.

Sources: [PayMongo pricing](https://www.paymongo.com/en/pricing),
[PayMongo business types](https://docs.paymongo.com/docs/account-settings-business-types),
[Xendit pricing](https://www.xendit.co/en/pricing/),
[RR 31-2020](https://bir-cdn.bir.gov.ph/local/pdf/RR%20No.%2031-2020.pdf),
[PwC – EoPT invoicing](https://www.pwc.com/ph/en/tax/tax-publications/taxwise-or-otherwise/2024/eopt-invoicing-clarified.html).

---

## Appendix — files that bind to the singleton connection

`grep "from './db'\|from '../db'"` → 26 source files; ~159 `db.prepare`/`db.exec` sites.
All go through `queryOne` / `queryAll` / `run` / `getSetting` / `setSetting` /
`nextSequence`, so making those six context-aware covers almost everything; the direct
`db.*` sites (mostly in `db.ts` itself and a few transaction blocks) are the manual part.
