# Module catalog

Written against the target structure of the `restructure/module-architecture` reorg
(see `docs/modules/pipelines.md` for how these modules connect end-to-end, and
`~/.claude/CLAUDE.md`'s "Module architecture and reuse workflow" for the rules this
catalog exists to satisfy). Status `working` means implemented with tests, in this
project, today — nothing here is aspirational.

Backend paths are `src/...` unless noted; frontend paths are `public/js/modules/...`
(desktop) and `public/mobile/modules/...` (mobile), both `working`.

## shared/ — infrastructure, not a business module

**Responsibility:** technical concerns with no business meaning of their own, used by
every module. Not gated by `requireModule()`, not licensed, never disabled.
**Owned files:** `db.ts` (SQLite connection registry, multi-tenant `tenantStore`,
schema/migrations), `types.ts`, `validation.ts`, `permissions.ts`, `auth.ts`
(session/login middleware), `activity.ts` (audit log writer), `idempotency.ts`,
`csv.ts`, `csv-import.ts`, `mailer.ts` (BYO-SMTP transport), `secrets.ts` (AES-GCM),
`push.ts` (task-reminder notifications), `qb.ts` (typed Kysely query builder used as a SQL
compiler over the sync db helpers; `qb`/`all`/`first`/`exec`), `db-types.ts` (GENERATED Kysely
schema types, via `npm run db:types` / `db-types-codegen.ts`; drift-checked by
`tests/db-types.test.ts`), `backup.ts` (`VACUUM INTO` snapshot +
retention primitives; `preMigrationSnapshot()` is called by `db.ts`'s `getDb()` before
`migrate()` and blocks the migration if it fails), `modules.ts` (the `requireModule()` gate
every business module below is mounted behind), `ws.ts` (WebSocket real-time push —
the app's one live channel; everything else is REST + polling. `attachWebSocket(server)`
is wired from `server.ts`; `broadcast(tenantSlug, userIds, event)` is exported for a
route to call after a mutation. First (and so far only) consumer:
`core/messages.routes.ts`'s chat feature).
**Public interface:** plain named function/class exports, imported directly — no HTTP
surface of its own except where `core/` exposes one (e.g. `core/push.routes.ts` wraps
`shared/push.ts`).
**Dependencies:** none on business modules. **Known wart:** `shared/db.ts` imports
`modules/payroll/ph-statutory.ts` (`SSS_2026`/`PHILHEALTH_2026`/etc.) and
`modules/accounting/ledger.ts` (`DEFAULT_COA`) for first-run seed data — a real,
pre-existing upward dependency from shared into two business modules. Not introduced
by this reorg; flagged for a future follow-up rather than fixed here.
**Status:** working.

## platform/ — SaaS control plane

**Responsibility:** tenant provisioning, plans, quotas, and the owner console — sits
above the tenant-facing app, not one of its features. Single-tenant/self-hosted
installs never touch this.
**Owned files:** `plans.ts`, `quota.ts`, `provisioning.ts`, `platform.ts` (tenant
catalog in `platform.db`), `platform-users.ts` (operator accounts, separate auth from
`shared/auth.ts`), `backups.ts` (daily backup job over every tenant DB + `platform.db` +
uploads, run from `server.ts`; manual backup/list/restore behind `npm run backup*` /
`scripts/backup.ts`. Also runs for single-tenant installs, covering only `default` + `platform.db`), `offsite.ts` (encrypted copies of daily snapshots + uploads to S3-compatible buckets, e.g. Backblaze B2 / Railway Buckets, via `shared/s3.ts`; CLI `scripts/offsite.ts`), routes: `signup.routes.ts`, `tenant.routes.ts`, `platform.routes.ts`.
Frontend: `web-console/` (its own mini-app, not under `public/`).
**Public interface:** `enabledModules()`/`requireModule()` (re-exported from
`shared/modules.ts`, which reads `platform/plans.ts` + `platform/platform.ts`),
`getTenant()`, `platformHost()` (the dedicated console host, `PLATFORM_HOST`; gated in
`src/app.ts`), and provisioning `createTenant()` / `importTenant()` (adopt an existing
workspace DB as a tenant; console route `POST /_platform/api/tenants/import`).
**Dependencies:** `shared/` only, downward. One reverse pull: `modules/hr/punch-photos.ts`
reads `platform/platform.ts` for per-tenant photo-retention settings.
**Status:** working.

## core/ — ungated baseline

**Responsibility:** the product features every workspace has regardless of plan —
login, user/department admin, documents & templates, forms engine, real-time 1:1 chat
messaging (conversations, reply, edit, reactions, sender-only soft delete, link/file
previews — see `messages.routes.ts` below and `shared/ws.ts`), attachments, bug reports,
personal notes/tasks, announcements, activity log, analytics, push-reminder routes.
**Owned files:** `doc-catalog.ts`, `form-actions.ts`, routes: `auth.routes.ts`,
`users.routes.ts`, `attachments.routes.ts`, `bug-reports.routes.ts`, `forms.routes.ts`,
`form-builder.routes.ts`, `messages.routes.ts`, `personal.routes.ts`,
`templates.routes.ts`, `me.routes.ts`, `announcements.routes.ts`, `activity.routes.ts`,
`analytics.routes.ts`, `push.routes.ts`.
**Public interface:** standard REST routes mounted with no `requireModule()` gate.
`messages.routes.ts` also calls `shared/ws.ts`'s `broadcast()` after each mutation for
live chat updates — VOIP/calling is explicitly out of scope for this feature (deferred as
its own future project; needs WebRTC + a STUN/TURN server, unrelated infra).
`POST /api/users` accepts `users.manage` **or** `hr.manage`: HR's employee form
(Linked user account → "+ Create new account") calls it directly, and a caller without
`users.manage` is limited to the staff roles in `shared/permissions.ts`
`HR_ASSIGNABLE_ROLES` (403 otherwise — never admin/admin_staff/hr/accounting).
Per-account access (base role + permission overrides) is edited in one shared drawer,
`public/js/lib/access-editor.js` (`AccessEditor.open`), used by Admin → Accounts and by the
employee form's **Access** button. `GET /users/permissions/catalog` reports what the caller
may change (`grantable`, `assignableRoles`); `GET /users/:id/access` returns one account's
role + overrides; `PUT /users/:id/permissions` lets an HR-only caller edit staff-role
accounts and only `HR_GRANTABLE_PERMISSIONS` keys (the union of the staff roles' defaults).
**Dependencies:** `shared/` only. **Known wart:** `modules/ai/ai-tools.ts` imports
`visibilityClause` out of `core/forms.routes.ts` — a routes file used as a library.
Pre-existing; not fixed by this reorg.
**Status:** working.

## modules/inventory

**Responsibility:** items, stock levels, suppliers, customers, locations, sale/purchase
orders (the order shell — 3-way-match purchase logic lives in `purchasing/`),
sale-order releasing (warehouse acceptance → pick → release slip), deliveries.
**Owned files:** `inventory-stock.ts`, routes: `inventory.routes.ts`,
`suppliers.routes.ts`, `customers.routes.ts`, `locations.routes.ts`,
`deliveries.routes.ts`, `orders.routes.ts`, `release-slips.routes.ts`.
UI: desktop Inventory → Releasing (`public/js/modules/inventory/releasing.js`),
mobile `so` view (`public/mobile/modules/inventory/so.js`).
**Owned data (releasing):** `orders.warehouse_accepted_by/_at`, `release_slips`,
`release_slip_items` (snapshot of lines + unit serials); photos are core `attachments`
kind `release` (ref = slip id).
**Public interface:** stock-mutation functions in `inventory-stock.ts` (called
directly by `manufacturing/`, `purchasing/`, and `modules/ai/ai-tools.ts`).
**Dependencies:** `shared/`.
**Status:** working.

## modules/manufacturing

**Responsibility:** BOM / finished products, job orders, QC dispositions, production
batches/teams/scheduling.
**Owned files:** `bom-explode.ts`, `bom-resolvers.ts`, `parts-slip-print.ts`, routes:
`bom.routes.ts`, `job-orders.routes.ts`, `qc.routes.ts`, `production.routes.ts`,
`parts-slips.routes.ts` (`/api/parts-slips`), `production-issues.routes.ts`
(`/api/production-issues`).
**Owned data (additions):** `parts_release_slips` / `parts_release_slip_items`,
`production_issues`, `job_order_components.qty_picked`.
**Dependencies:** `modules/inventory` (stock consumption/output),
`modules/accounting` (`accounting-autopost.ts`, to post job-order costs).
**Pre-release interface (job orders):** `POST /job-orders/:id/approve|unapprove`
(`production.approve`, not implied by `inventory.adjust`), `GET /job-orders/:id/availability`
(component need vs. on-hand at the source location + `releasable`), and
`GET /job-orders?stage=awaiting_approval|awaiting_release|awaiting_warehouse|preparing|ready_to_release`.
**Warehouse release interface:** `POST /job-orders/warehouse-accept`, `POST /job-orders/prepare`
(bulk), `GET /job-orders/pick-list?ids=[&format=html]`, `POST /job-orders/:id/release`
(issues the `PRS-#####` parts release slip, deducts stock). **Floor:** `POST /job-orders/:id/units`
is multipart and requires the photo; pause/resume accept `production.pause`; issue reports
live at `/api/production-issues`. Uses `core/attachments.routes.ts` (`imageUpload`,
`saveAttachment`) for photos sent together with the record they belong to.
**Status:** working. Open gaps from the 2026-09-27 walkthrough:
`docs/PRODUCTION-WALKTHROUGH-GAPS.md`.

## modules/purchasing

**Responsibility:** goods receipts, vendor bills, the PO ↔ receipts ↔ bill 3-way match.
**Owned files:** `purchasing-match.ts`, routes: `purchasing.routes.ts`.
**Dependencies:** `modules/inventory` (declared as a hard dependency in
`shared/modules.ts`'s `MODULE_DEPS`), `modules/accounting` (autopost).
**Status:** working.

## modules/hr

**Responsibility:** employee records, timekeeping/kiosk clock, field work log, daily
attendance reporting, punch photos, company-property issuance (laptops, tools, uniforms, …
issued/returned per employee, standalone register — not linked to Inventory stock). Pay
computation itself is `modules/payroll`.
**Owned files:** `clock.ts`, `clock-geofence.ts` (phone time-in office location lock:
`clock_geofence` setting + `employees.clock_anywhere` exemption + per-punch location,
SCHEMA_VERSION 46), `kiosk-devices.ts` (approved time-in kiosk PCs + the `kiosk_lock`
setting; locked by default when internet-facing, SCHEMA_VERSION 47), `field.ts`, `hr-daily-report.ts`,
`hr-employee-numbering.ts`, `punch-photos.ts`, routes: `hr.routes.ts` (also owns the
`asset_issuances`/`asset_issuance_items` tables and the seeded "Asset Issuance Form"
doc_template, SCHEMA_VERSION 43), `clock.routes.ts`, `field.routes.ts`.
**Dependencies:** `modules/payroll` (pay computation + statutory tables),
`modules/accounting` (`accounting-autopost.ts`, to post payroll to the ledger),
`platform/` (photo-retention settings).
**Status:** working.

## modules/payroll

**Responsibility:** pay computation and Philippine statutory/tax logic — split out
from `hr` and `accounting` specifically because both of those modules depended on it
*and on each other* through it (a two-way `hr` ↔ `accounting` coupling found during
the reorg's import-graph survey). Owning it as its own module resolves that: both `hr`
and `accounting` now depend one-directionally on `payroll`, not on each other.
**Owned files:** `hr-payroll-compute.ts`, `hr-payroll-import.ts`,
`employee-rate-history.ts`, `payroll-tables.ts`, `ph-2316.ts`, `ph-alphalist.ts`,
`ph-contributions.ts`, `ph-final-pay.ts`, `ph-income-tax.ts`,
`ph-payroll-report-data.ts`, `ph-statutory.ts`, `ph-vat-ewt.ts`.
**Public interface:** pure computation functions (no routes of its own — its
computations are exposed through `hr.routes.ts` and `accounting.routes.ts`).
**Dependencies:** `shared/` only.
**Licensing note:** not a separately-sold SaaS module — still bundled under the
existing `hr` entry in `shared/modules.ts`'s `MODULES` list. This is an internal
code-organization boundary only, invisible to tenant entitlements.
**Status:** working.

## modules/accounting

**Responsibility:** general ledger, AR/AP, petty cash, tax & compliance filings, and
the auto-posting hook other modules call into.
**Owned files:** `accounting-autopost.ts`, `accounting-posting.ts`, `ledger.ts`,
routes: `accounting.routes.ts`.
**Public interface:** `accounting-autopost.ts`'s exported posting functions — called
by `modules/hr`, `modules/manufacturing`, `modules/inventory` (orders), and
`modules/purchasing`. This is a legitimate one-directional fan-in (four modules →
accounting's public interface), not a circular dependency.
**Dependencies:** `modules/payroll` (tax computation for filings).
**Status:** working.

## modules/ai

**Responsibility:** the AI Assistant widget — tool-calling agent, analytics queries,
report/docx generation, FTS5 RAG over documents, HR-form proposals, sending mail.
**Owned files:** `ai-analytics.ts`, `ai-config.ts`, `ai-hr-forms.ts`, `ai-mail.ts`,
`ai-rag.ts`, `ai-reporting.ts`, `ai-tools.ts`, `rag.ts`, `reporting.ts` (generic
markdown/docx rendering, used only by `ai-reporting.ts` today), routes: `ai.routes.ts`.
**Dependencies:** `shared/`, `modules/inventory` (`ai-tools.ts` calls stock-mutation
functions directly), `core/` (the `visibilityClause` wart noted above).
**Status:** working.

## modules/email

**Responsibility:** the BYO-SMTP outbound mail tool and its route surface.
**Owned files:** routes: `mail.routes.ts` (the transport itself, `mailer.ts`, lives in
`shared/` since `modules/ai` and `modules/quickbooks` also send mail through it).
**Status:** working.

## modules/quickbooks

**Responsibility:** one-way push of orders to QuickBooks Online (per-tenant OAuth).
**Owned files:** `quickbooks.ts`, routes: `quickbooks.routes.ts`.
**Dependencies:** `shared/` (`mailer.ts`, `secrets.ts` for OAuth token storage).
**Status:** working.

## mobile (frontend-only surface)

**Responsibility:** not a backend code module — a licensing flag (`requireModule('mobile')`
gates nothing backend-side beyond serving `/m`) covering the entire `/m` employee PWA.
Its views live under `public/mobile/modules/<owning-module>/` mirroring the same
module names as the backend, since a mobile screen belongs to whichever business
module it serves (e.g. `public/mobile/modules/hr/clock.js`).
**Status:** working.
