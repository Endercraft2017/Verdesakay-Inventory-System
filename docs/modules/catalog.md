# Module catalog

Written against the target structure of the `restructure/module-architecture` reorg
(see `docs/modules/pipelines.md` for how these modules connect end-to-end, and
`~/.claude/CLAUDE.md`'s "Module architecture and reuse workflow" for the rules this
catalog exists to satisfy). Status `working` means implemented with tests, in this
project, today. Entries marked `planned` are recorded designs with no code yet (currently only
`desktop/`, see `docs/OFFLINE-FIRST.md`).

Backend paths are `src/...` unless noted; frontend paths are `public/js/modules/...`
(desktop) and `public/mobile/modules/...` (mobile), both `working`.

## shared/ — infrastructure, not a business module

**Responsibility:** technical concerns with no business meaning of their own, used by
every module. Not gated by `requireModule()`, not licensed, never disabled.
**Owned files:** `db.ts` (SQLite connection registry, multi-tenant `tenantStore`,
schema/migrations), `types.ts`, `validation.ts`, `permissions.ts` (permission catalog + built-in
role seeds, pure), `roles.ts` (the tenant's `roles` table — every account's permissions resolve
through `userPermissions()` here), `auth.ts`
(session/login middleware; SCHEMA_VERSION 55: every session records device ID / IP / user
agent at sign-in and last-seen, is addressed outside auth.ts only by its public `sid`, and is
ENDED on sign-out rather than deleted — `ended_at`/`end_reason`, swept after
`SESSION_HISTORY_DAYS` = 90 by `cleanupSessions()`; `shared` = borrowed-phone session, 4 h max
and 30 min idle; `endUserSessions` / `endSessionBySid` / `listUserSessions` /
`deviceUsualUserId`), `device.ts` (`X-Device-Id` — a random per-browser ID from
`public/js/api.js`, not a fingerprint — plus client IP (`clientIpOf`: the edge's `X-Real-IP` on
Railway via `CLIENT_IP_HEADER` in `hosting.ts`) and `rateLimitKey` for every rate limiter, and a
readable user-agent label), `password-policy.ts` (`newPasswordSchema`: 15–128 Unicode code points, not on
the bundled common-password list — used by every password-setting schema in `validation.ts`),
`totp.ts` (RFC 6238 codes, no dependency) + `mfa.ts` (two-step sign-in: enrol / verify / recovery
codes / sign-in challenge, `security_policy.require_mfa_privileged` enforced in `requireAuth`; tables
`user_mfa`, `user_mfa_recovery`, `mfa_challenges`, cloud-only), `db.ts tokenDigest` (sessions and
owner-console sessions store `h1:`+SHA-256 of the bearer token, never the token),
`activity.ts` (audit log writer, now with `device_id` + `device` label per row; `logEvent()` for events the
mutation middleware can't see, e.g. a payslip download; a route may set
`res.locals.activity = { action, summary, snapshot }` to make its middleware row readable and
keep a copy of rows a DELETE erases), `idempotency.ts`, `pdf-lite.ts`
(dependency-free text PDF writer, Helvetica AFM metrics — used by `payroll/payslip-pdf.ts`),
`csv.ts`, `csv-import.ts`, `mailer.ts` (BYO-SMTP transport), `secrets.ts` (AES-GCM),
`push.ts` (task-reminder notifications), `qb.ts` (typed Kysely query builder used as a SQL
compiler over the sync db helpers; `qb`/`all`/`first`/`exec`), `db-types.ts` (GENERATED Kysely
schema types, via `npm run db:types` / `db-types-codegen.ts`; drift-checked by
`tests/db-types.test.ts`), `backup.ts` (`VACUUM INTO` snapshot +
retention primitives; `preMigrationSnapshot()` is called by `db.ts`'s `getDb()` before
`migrate()` and blocks the migration if it fails), `durable-uploads.ts` + `file-store.ts`
(recoverable upload copies — see "Upload copies" below), `modules.ts` (the `requireModule()` gate
every business module below is mounted behind), `ws.ts` (WebSocket real-time push —
the app's one live channel; everything else is REST + polling. `attachWebSocket(server)`
is wired from `server.ts`; `broadcast(tenantSlug, userIds, event)` is exported for a
route to call after a mutation. First (and so far only) consumer:
`core/messages.routes.ts`'s chat feature).
**Public interface:** plain named function/class exports, imported directly — no HTTP
surface of its own except where `core/` exposes one (e.g. `core/push.routes.ts` wraps
`shared/push.ts`).
**Notification history:** `shared/push.ts` `notifyUser` (and `notifyPermission` /
`notifyAnyPermission` / `notifyAll`, which call it) first writes the person's `notifications` row
(createSchema; only where the authority runs — never on a node's optimistic run — so a synced
replay notifies once), then pushes. A payload carries `url` (phone route to the record) and
optionally `link` ({route, params}, the desktop screen); with no phone screen the push opens the
notification itself (`#/notifications?id=`). `record: false` skips the row (chat: the inbox is its
history; test pushes). Rows older than 120 days are trimmed. `core/notifications.routes.ts` at
`/api/notifications`: `GET /` (own rows + unread), `GET /unread-count`, `POST /:id/read`,
`POST /read-all` (merge). UI: phone `#/notifications` leads with it; desktop rail bell (badge +
panel opening `link`). Tests: `tests/notifications.test.ts`.
**Upload copies (`shared/durable-uploads.ts`, `shared/file-store.ts`, `platform/upload-offload.ts`):**
every accepted upload keeps a recoverable copy — `storeDurableUpload` / `resolveDurableUpload`
(sync) / `resolveDurableUploadAsync` (routes) / `forgetDurableUpload`. Without a file bucket the
copy is in the tenant DB (`durable_uploads`, chat files in `message_attachments.data`, schema
65/66). With one (`FILES_S3_FROM` / `FILES_S3_*`, 2026-10-13) the bucket holds it instead: new
uploads are sent at once (AES-256-GCM, `FILES_KEY` → `BACKUP_KEY`, key `files/<path under
UPLOAD_DIR>`), `UPLOAD_DIR` is a cache trimmed after `FILES_CACHE_DAYS` (7) and refilled on
demand, a file gone from disk outside the app stays in the bucket (only `forgetDurableUpload` /
message unsend / tenant purge delete there), and `upload-offload.ts` moves the bytes a DB
already holds into the bucket after each minute sweep — deletes under `withoutReplicating`
(`sync/authority.ts`) so PCs keep their copies — then VACUUMs once. Never in the bucket:
`.sync-blobs/` (keep DB copies), and kept on disk: `kiosk-punches/`, plain-text files
(`TEXT_EXT`, the AI index reads them synchronously). Quota counts each file once wherever it is.
Chat attachments retain their database bytes until the bucket confirms storage; a failed upload
keeps the recoverable database copy. Tests: `tests/file-store.test.ts`,
`tests/upload-offload.test.ts` (fake S3), `tests/message-upload-durability.test.ts`.
**Desk-scoped reads (`shared/desk-access.ts`):** the one list of which shop-floor desks (LINE,
INSPECT, PARTS, RTS, RELEASE) may read which shared data — user decision 2026-10-06, "a floor role
sees only its own desk". The broad `inventory.view` / `production.view` still open everything; a
desk permission adds only its task's reads: the item picker and scan lookup (inspectors, parts clerk;
desk callers get id / name / SKU / unit / on hand only — `inventory.routes.ts pickerView`), the
location list (RTS), the job-order list (line) and one job order (every production desk), repairs
(inspectors, parts, line), the unit record (every desk), label templates (line, RTS), checklists
(inspectors), unit photos. Every other read checks a permission too: item detail / stats /
categories (`inventory.view`), templates (document printers: templates / orders / purchasing /
accounting / forms view; `/company` stays open), and an assistant report downloads only for whoever
generated it (`ai-report-u<id>-…`, or `users.manage`). Tests: `tests/access-matrix.test.ts` (one
desk-only role per desk against every area's read). `tests/route-permissions.test.ts` fails any route
with no permission check unless it is listed with its reason (own data, checked inside, open by design).
The phone shell refuses a screen the role doesn't permit (`public/mobile/app.js` ROUTE_NEEDS) before
it renders — warehouse screens need inventory.adjust / .create / .view, the unit record a desk.
**Dependencies:** none on business modules. **Known wart:** `shared/db.ts` imports
`modules/payroll/ph-statutory.ts` (`SSS_2026`/`PHILHEALTH_2026`/etc.) and
`modules/accounting/ledger.ts` (`DEFAULT_COA`) for first-run seed data — a real,
pre-existing upward dependency from shared into two business modules. Not introduced
by this reorg; flagged for a future follow-up rather than fixed here.
**Status:** working.

Credential storage uses `shared/password-hash.ts` across tenant and platform writers/verifiers:
versioned scrypt (N=131072, r=8, p=1), bounded legacy bcrypt verification and conditional upgrade
after a verified password at login. See `docs/operations/password-migration.md` for deployment,
rollback and availability limits. New-password rules and console passkeys now have separate
runbooks; staged enrollment, wider tenant step-up and native credential storage remain open.

## platform/ — SaaS control plane

**Responsibility:** tenant provisioning, plans, quotas, and the owner console — sits
above the tenant-facing app, not one of its features. Single-tenant/self-hosted
installs never touch this.
**Owned files:** `owner-alert-monitor.ts` (queue-wide read-only health/history and guarded persistent worker heartbeat), `inquiry-receipts.ts` (public inquiry binding, constant acknowledgement, expiry/tombstones), `payment-report-receipts.ts` (tenant/actor-scoped payment acknowledgement, attachment binding, expiry/tombstones), `owner-alert-outbox.ts` (signup and separate inquiry/payment intent, guarded claim/worker/status and logical payload expiry), `onboarding-receipts.ts` (durable scoped create/signup responses, async public signup verifier/live rechecks, expiry/tombstones), `plans.ts`, `quota.ts`, `provisioning.ts`, `adopt-default.ts` (offline,
verified adoption of the original company, preserving source DB/uploads; CLI
`scripts/adopt-default-tenant.ts`), `tenant-path.ts` (optional host-bound path routing), `platform.ts` (tenant
catalog in `platform.db`; permanent company login IDs with pair-scoped counters,
backfilled for existing tenants), `platform-users.ts` (operator accounts, separate auth from
`shared/auth.ts`; self-service password and username changes `POST /_platform/api/password` / `POST /_platform/api/username`), `backups.ts` (daily + hourly backup jobs over every tenant DB + `platform.db` +
uploads, run from `server.ts`; manual backup/list/restore behind `npm run backup*` /
`scripts/backup.ts`. Also runs for single-tenant installs, covering only `default` + `platform.db`;
skips the local uploads mirror when a file bucket and an off-site target are both set), `offsite.ts` (encrypted copies of daily snapshots + uploads to S3-compatible buckets, e.g. Backblaze B2 / Railway Buckets, via `shared/s3.ts`; CLI `scripts/offsite.ts`), `backup-health.ts` (hourly after the backup run:
restore drill every 30 days — newest off-site copy of every DB decrypted into a temp file and
integrity-checked — plus failed/stale-backup checks, alerts to `BACKUP_ALERT_WEBHOOK`, results in
`status.json` for the owner console; CLI `npm run backup:drill` / `backup:health`), routes: `signup.routes.ts`, `tenant.routes.ts`, `platform.routes.ts`.
Frontend: `web-console/` (its own mini-app, not under `public/`).
Support/owner-details mutation failures use `request-errors.ts`: authored `ValidationError`
feedback remains 400; unexpected storage errors are stripped of message/status/expose and
forwarded as generic 500 with request correlation. Support ticket identities are validated
before service-level database access. Tenant/company and owner-only ticket scope is retained.
Tests: `tests/tenant-support.test.ts`, `tests/owner-analytics.test.ts`,
`tests/e2e/support-errors.spec.ts` (actual SQLite fault, preserved draft, corrected retry).
Provisioning public errors use an explicit `ControlPlaneError` (400/409), not arbitrary
exception properties or module-message matching. Creation validates modules before creating
the account; create/import services reject unknown plans. Full tenant-settings validation runs
before writes; settings/subscription changes and their audit entries share a SQLite savepoint.
`tests/platform-settings-errors.test.ts` covers failures/rollback and
`tests/e2e/control-plane-settings.spec.ts` verifies actual settings draft/corrected-save behavior.
Core create/import now reserves files exclusively, prepares credentials/migration before
catalog publication, and commits registration/audit together. Caught failures close/evict
connections and remove only owned artifacts. Process interruption leaves an unregistered slot
blocked for review; no automatic adoption/deletion occurs. `tests/provisioning-recovery.test.ts`
covers process exits, retry refusal, collisions, owned cleanup and registry recovery. This is
not a transaction across catalog and tenant databases/files. Signup and console local setup
now runs synchronously inside catalog publication, including nested audited first invoices;
keyed completed responses now share that publication transaction. Signup alert intent now commits there too, with a bounded cloud worker and conservative unknown
state. Inquiry/payment rows and intent now commit together in a separate queue; payment proof
bytes/audit/invoice state share that transaction and download cache is created lazily. Mail settings/
credentials use atomic snapshots/writes and console-audit rollback. See `docs/operations/business-alerts.md`. See `docs/operations/owner-alert-outbox.md`. See `docs/operations/workspace-onboarding.md` for receipt/security/retention limits.
See `docs/operations/provisioning-recovery.md`.


**Public interface:** `enabledModules()`/`requireModule()` (re-exported from
`shared/modules.ts`, which reads `platform/plans.ts` + `platform/platform.ts`),
`getTenant()`, `platformHost()` (the dedicated console host, `PLATFORM_HOST`; gated in
`src/app.ts`), and provisioning `createTenant()` / `importTenant()` (adopt an existing
workspace DB as a tenant; console route `POST /_platform/api/tenants/import`).
**Dependencies:** `shared/` only, downward. One reverse pull: `modules/hr/punch-photos.ts`
reads `platform/platform.ts` for per-tenant photo-retention settings.
**Status:** working.

Billing (partial, 2026-10-10, `docs/SAAS-READINESS.md` §12): `billing.ts` (invoices / payments /
settings in `platform.db`, VAT + EWT-on-net-of-VAT, price list, GCash + bank details, status from
payments; paid → a website sign-up's `awaiting_payment` lock lifts, `trial`/`past_due` → `active`),
`billing.routes.ts` (customer `/api/tenant/billing`: invoices, how to pay, report a GCash / bank
payment with proof + optional 2307, GCash QR image; `syncClass('online')`), `billing-console.routes.ts`
(operator: issue, confirm / reject / record / void, BIR invoice no., settings, QR upload). Website
sign-up (`signup.routes.ts`) is pay-first: locked workspace + automatic first invoice when the price
list covers it. Frontend: `web-console/billing.js`, desktop `public/js/modules/core/billing.js` and
the locked shell in `public/js/app.js`. Website inquiries (2026-10-10): `inquiries.ts` (`inquiries` + `site_settings` contact details in
`platform.db`), `inquiries.routes.ts` (public `POST /site/inquiry`, site host only, rate-limited +
honeypot), `inquiries-console.routes.ts` (operator list / status / notes / contact details); console
`web-console/inquiries.js`; console tenant creation takes `awaiting_payment` + `inquiry_id`.
Tests: `tests/inquiries.test.ts`. Owner email alerts (2026-10-12): `platform-mail.ts` (Brevo API or
SMTP, encrypted secret, `platform_mail` + `platform_mail_log` in `platform.db`, delivery through
`owner-alert-outbox.ts` for inquiry / billing / signup routes), `platform-mail-console.routes.ts`, console `web-console/mail.js`.
Tenant-assisted SMTP: operator GET/PUT `/tenants/:slug/mail` and POST `/tenants/:slug/mail/test`
use the target tenant's existing mailer; console Settings links a locally served guide and
prefills the existing Billing form for a one-time implementation fee. No parallel invoice store.
Platform email keys have an explicit clear action; settings saves are operator-audited.
Tests: `tests/platform-mail.test.ts`, `tests/platform-tenant-mail.test.ts`,
`tests/platform-tenant-mail-ui.test.ts`. **Interface:** `tenantBillingSummary()`, `priceListQuote()`,
`setAwaitingPayment()` (platform.ts). **Not built:** PayMongo, overdue automation, notifications,
recurring invoices. Tests: `tests/billing.test.ts`, `tests/billing-signup.test.ts`, `tests/frontend-billing.test.ts`.

Path tenancy: `TENANT_PATH_HOST` enables `/<slug>` for desktop/mobile/API/chat;
`DEFAULT_TENANT_REDIRECT` retires the original company after verified adoption.
The owner console remains separate and shows tenant URLs. Browser storage, mobile
queues, service-worker caches/scopes and manifests are tenant-scoped. Server
maintenance, backups and `migrate:all` skip the retired source. Operational cutover
and recovery: `docs/VERDESAKAY-TENANT-CUTOVER.md`. Paths share a browser origin;
these namespaces do not replace authentication or sanitization.

App shell caching (`src/shared/asset-version.ts`, shared utility): the desktop shell names each
script/style `?v=<content hash>`; a matching request is `immutable` (browser + Cloudflare edge),
anything else `no-cache`. The phone shell keeps plain URLs for its service-worker precache.

## sync/ — offline-first replication (partial)

Design: `docs/OFFLINE-FIRST.md` (§10 = what is built). Infrastructure, not a business module: it
carries other modules' changes between copies of a tenant's data but owns no business rules.
**Responsibility:** record every write on an installed node as an immutable **command** (API call +
actor, device, occurred_at, HLC, allocation plan), run it optimistically, have the authority
**replay it through the same route handler** as its actor, stream the authority's changes as
SQLite changesets (**confirmed effects**) in `authority_seq` order, and rebase the node's pending
work on top. Also node-partitioned row ids, provisional/replayed document numbers, the SQL request
clock, suppression of side effects on nodes, the node write guard. Planned: site-host election,
HTTP transport, blob lane, sensitive-field encryption (phases 3–5).
**Owned files:** `src/sync/` — `index.ts` (`installSync`, `syncOnce`, `DEPLOY_MODE`, re-exports),
`node.ts` (roles, node-local tables, cloud change recorder), `ids.ts` (statement wrapper:
renumber-after-insert + write guard), `sequences.ts`, `clock.ts`, `capture.ts`
(`syncRequestMiddleware`, `syncClass`), `commands.ts` (command log, lock), `replay.ts` (loopback
replay as actor), `authority.ts` (effects, `acceptCommand`, `pullFor`, `snapshotForNode`),
`rebase.ts` (`applyConfirmed`; applies changesets with foreign-key actions off), `changeset.ts`
(invert, table + row filter), `ids-util.ts` (ULID, HLC), `transport.ts` (cloud endpoints
`/api/sync/*`, stripped snapshot), `client.ts` (enrol, adopt, `syncWithCloud`, `startSyncLoop`,
connection state, host/LAN enrolment, members refresh), `status.ts` (`/api/sync/status`, `/activity`,
`/now`), `sites.ts` (home sites, site decisions, `/api/sync/sites`, `/api/sync/clashes`), `files.ts`
(uploads offline: `syncUpload`, blob store, file list, `/api/sync/blobs`, `/api/sync/files`),
`numberblocks.ts` (site number blocks: `/api/sync/sequence-blocks`, leases to the site), `failover.ts`
(phase 5a, §30: site terms with the cloud as referee, the site log mirror, take over / step down /
follow a new host, full re-sync `resyncFromSnapshot`, `/api/sync/site*`), `election.ts` + `site-election.ts`
(phase 5b, §31: automatic host election at 3+ voting PCs — heartbeat, lease, one vote per term, majority,
signed UDP on the LAN), `maintenance.ts` (phase 6, §32: version skew, replay window, effect-stream and
command-log trimming); CLI
`scripts/sync-enrol.ts` (`npm run sync:enrol`). Frontend (desktop): `public/js/lib/sync-status.js`
(top-bar pill + "not final" toast, fed by the `X-Sync-State` hook in `public/js/api.js`),
`public/js/modules/core/sync.js` (route `sync`: PC status/inbox, or Installed PCs on the cloud).
Seam in `src/shared/sync-context.ts` (context store, `now()`, `inSyncedCommand`,
`sideEffectsSuppressed`, `syncHooks`).
**Owned data:** node-local `sync_node` (role, node number, seq, HLC, last authority seq,
provisional counter), `sync_id_counters`, `sync_commands`, `sync_effects`, `sync_nodes` (cloud:
enrolled PCs, token hashes), `sync_remote` (PC: cloud URL + token) — created only by
`enableSync()`, never replicated. Secret `settings` rows (`SECRET_SETTINGS`) never leave the cloud.
**Public interface:** `syncClass('merge' | 'physical' | 'claim' | 'online', { unattributed? })`
per mutating route (undeclared ⇒ refused on a node, 503); `now()` for business times;
`enableSync(conn, { role, nodeNo })`; `acceptCommand` / `pullFor` / `applyConfirmed` /
`pendingCommands` / `snapshotForNode` / `syncOnce` (in-process); HTTP: `POST /api/sync/nodes`,
`GET /api/sync/nodes`, `POST /api/sync/nodes/:no/revoke` (admin, `users.manage`),
`GET /api/sync/snapshot`, `POST /api/sync/commands`, `GET /api/sync/pull` (node token);
`GET /api/sync/status`, `GET /api/sync/activity?view=pending|attention`,
`POST /api/sync/activity/:id/dismiss`, `POST /api/sync/now` (signed-in user). Responses of recorded
actions carry `X-Sync-State: local` + `X-Sync-Command`. Site hosts (phase 3c-i): a node with
`isHost` serves the same `/api/sync/*` endpoints to its LAN PCs (`isAuthority`); plus
`GET /api/sync/whoami` (public) and `GET /api/sync/members` (cloud, host token); enrolment takes
`is_host` / `host_node_no`; `/pull?ids=` returns verdicts on unattributed commands by id. Site
decisions (3c-ii): `syncClass('claim', { home })`, `siteDecisionStands()` + `recordSiteClash()` for a
route's clash-checks; `GET|PUT /api/sync/sites`, `GET /api/sync/clashes`,
`POST /api/sync/clashes/:id/resolve` (admin). Replicated tables it owns: `location_sites`,
`site_decision_clashes` (in `createSchema`).
**Dependencies:** `shared/` (db Proxy via `syncHooks.prepare`, `nextSequence` via
`syncHooks.nextSequence`, `requireAuth` via `syncHooks.replayUser`, `authUserById`, device,
mailer/push/ws via `sideEffectsSuppressed`). Wired in `src/app.ts` (install, replay tenant,
middleware) and `server.ts` (task-reminder pushes only when `DEPLOY_MODE=cloud`). `sync/` never
imports a business module.
**Connections:** `modules/inventory` — all its item/stock/location/supplier/customer routes are
classed (phase 2); `applyStockChange` reads `inSyncedCommand()` to accept and flag offline
overdraws (D1).
**Tests:** `tests/sync-primitives.test.ts` (invert/filter, HLC, ULID, write-target parser, clock
override), `tests/sync.test.ts` (cloud + node tenants end to end: guard, command capture, node-range
ids, merge of concurrent offline/cloud stock changes to identical rows, preserved device time,
rebase before push, cloud rows reaching the node, rejection of a since-disabled actor's work,
idempotent accept, divergence refusal, provisional numbers, push sent once by the cloud,
unattributed commands), `tests/sync-inventory.test.ts` (phase 2: D1 overdraw + flags, merge / claim /
online per route), helper `tests/sync-helpers.ts`, `tests/sync-transport.test.ts` (phase 3a over a real
listener: enrolment, stripped snapshot, both-way sync, row-level secret filter, node auth, offline,
Sync now), `tests/sync-status.test.ts` + `tests/frontend-sync-status.test.ts` (phase 3b),
`tests/sync-site.test.ts` (phase 3c-i: cloud + host + LAN PC over HTTP),
`tests/sync-site-decisions.test.ts` (phase 3c-ii, helper `setupSiteTrio`), `tests/sync-files.test.ts`
(phase 3e).
**Status:** partial. Decisions D1–D5 taken 2026-09-30; phases 1, 2, 3a built 2026-09-30; 3b
(desktop), 3c-i (site host relay), 3c-ii (site decisions, D6) and 3e (files) 2026-10-01. Mobile sync UI waits on
a Figma design (design doc §14). Still open
spikes: LAN discovery, LAN HTTPS for `/m`, DPAPI-keyed field encryption.

## desktop/ — installable Windows app (partial)

Design: `docs/OFFLINE-FIRST.md` §5, §17 (phase 3d). Packaging, not a business module.
**Responsibility:** ship the existing server + `public/` UI as a per-user Windows app running in
`DEPLOY_MODE=node`: first-start setup (enrol as site host or as a site's PC), a window onto the local
server, the site host's LAN HTTPS (per-site certificate authority, D5) and the phone-setup page.
**Owned files:** `electron/main.cjs` (shell: child server on Electron's Node via tsx, setup IPC, cert
trust for localhost, start-with-Windows IPC), `electron/autostart.cjs`, `electron/preload.cjs`
(`desktopSetup`, `desktopApp`), `electron/setup.html`; `src/desktop/lan-tls.ts`
(`ensureLanTls`, `lanAddresses`), `src/desktop/phone-setup.ts` (`phoneSetupHandler`), `src/desktop/pc-secret.ts` (`sealForPc` /
`openForPc` / `keyPassphrase`, phase 3f), `electron/disk.cjs` (BitLocker check), `src/desktop/desktop.routes.ts`
(`/api/desktop/installer[/info]`, admin; WIP — unpublished until `DESKTOP_INSTALLER_DIR` holds an .exe);
`.github/workflows/desktop-release.yml` (draft GitHub Release on a `desktop-v*` tag); `server.ts`
`startInstalledPc()`; scripts `scripts/desktop.mjs` (`npm run desktop`, `desktop:smoke`),
`scripts/test-node24.mjs` (`npm run test:node24`), `scripts/desktop-cert.ps1` (`desktop:cert`),
`scripts/desktop-trust.ps1`; electron-builder config in `package.json` → `build`
(`npm run desktop:build` → `dist-desktop/`).
**Owned data:** per PC, in `%APPDATA%\Verdesakay\workspace`: the database, `desktop.json` (role),
`tls/` (a host's site CA + server cert; private keys stay on the PC, encrypted), `host-ca.crt` (a site
PC's pinned host certificate), `pc-secret.bin` (DPAPI-encrypted PC secret, phase 3f), logs.
**Dependencies:** `sync/` (enrolment, sync loop, `syncConfigOf`), `shared/`; packages `electron`,
`electron-builder` (dev), `node-forge`.
**Tests:** `tests/desktop-lan-tls.test.ts` (CA + server cert, re-issue on address change, a real TLS
handshake trusting only the site CA, phone-setup page), `tests/desktop-autostart.test.ts`, `tests/desktop-installer.test.ts`, `tests/desktop-pc-secret.test.ts`. Smoke: `npm run desktop:smoke` and the
packaged `Verdesakay.exe --smoke` (manual / CI).
**Status:** partial. Built 2026-10-01, with an "Open when Windows starts" toggle (Sync page; on by
default for a site host). To-do list in design doc §17: real code-signing certificate (D7), app icon,
downloadable installer (GitHub Release), auto-update, mobile sync UI.

## mobile-app/ — installable phone app (Android, iPhone later)

**Responsibility (docs/OFFLINE-FIRST.md §29):** an APK of the existing `/m` phone app (Capacitor
wrapper, same vanilla code) for floor roles: QC/QA, line, releasing, receiving and delivery. It adds:
- offline work lists for the signed-in person;
- its own command queue with sync classes;
- LAN discovery of the site host, following a failover;
- the site certificate pinned at enrolment.

**Owned files:**
- `mobile-app/`: `capacitor.config.json`; `build-web.mjs`, which bundles `public/mobile` and `public/js`
  into `www/`; `build-apk.mjs`, which runs Gradle; and the `android/` project.
- `public/mobile/native.js`: `window.VDS_NATIVE` and the Connect-to-your-company screen.

**Public interface and connections:**
- localStorage `vds_api_base` holds the server address. `API.base()` in `public/js/api.js` reads it, and
  so do `chat-ws.js` and `report-problem.js`.
- `src/app.ts` allows CORS on `/api` for `https://localhost` and `capacitor://localhost` only.
- Server-side permission checks are unchanged.

**Not:** a full replica (D2 is for PCs only). **Dependencies:** `sync/` (commands, discovery, phase 5).
**Status:** partial. 7a (the installable shell, debug APK) was built on 2026-10-03, tested in
`native-app-cors.test.ts` and `native-app-shell.test.ts`. Planned:
- 7b: QC/QA offline work lists;
- 7c: following the site host;
- 7d: pinning, updates, a signing key, native push, iPhone.

Decided (D9): sideloaded APK, QC/QA first, cache cleared at sign-out, an iPhone build too. Open: the iOS
distribution route, icon artwork.

## core/ — ungated baseline

Assisted authenticator recovery is owned by `shared/account-recovery.ts` and exposed through
`core/users.routes.ts` (fresh password + enrolled factor, no self-reset) and the platform owner
console (solo operator with advance email notice, a server-enforced 24-hour wait, cancellation and fresh password verification). `account_recoveries` is cloud-only and
records actor identities, reason/reference, contact/credential binding and completion state.
Schema 84 synchronizes `users.mfa_recovery_required` to updated office hosts.
The existing password-reset nonce/UI handles redemption transactionally; `shared/mfa.ts`
requires enrollment after recovery independently of the optional workspace policy. HTTP,
WebSocket and cloud replay-actor authorization enforce the incomplete-recovery restriction.
See `docs/operations/assisted-account-recovery.md` for interfaces, limits and operator procedure.

Authentication security changes share a per-account/tenant failure limiter across MFA setup,
enable, disable and recovery-code replacement. The existing-factor-verified disable flow
revokes other sessions via `shared/auth.endUserSessions`. The limiter is process-local;
multi-replica enforcement and privileged step-up remain incomplete. Research and limits:
`docs/audits/standards-research.md`.

**Responsibility:** the product features every workspace has regardless of plan —
login, user/department admin, documents & templates, forms engine, real-time 1:1 chat
messaging (conversations, reply, edit, reactions, sender-only soft delete, link/file
previews — see `messages.routes.ts` below and `shared/ws.ts`), attachments, bug reports,
personal notes/tasks, announcements, activity log, analytics, push-reminder routes.
**Owned files:** `doc-catalog.ts`, `form-actions.ts`, `file-visibility.ts`,
`data-forms/` (definition, record, and global-variable routers plus shared scope policy
and self-service request types; composed by `form-builder.routes.ts`), routes: `auth.routes.ts`,
`users.routes.ts`, `attachments.routes.ts`, `bug-reports.routes.ts`, `forms.routes.ts`,
`form-builder.routes.ts`, `messages.routes.ts`, `personal.routes.ts`,
`templates.routes.ts`, `doc-studio.routes.ts`, `doc-template-version.ts`,
`document-conversion.ts`, `doc-studio-merge.ts`, `me.routes.ts`, `announcements.routes.ts`, `activity.routes.ts`,
`analytics.routes.ts`, `push.routes.ts`.
**Offline (sync/, phase 4i, §28):** chat, personal notes / tasks / bookmarks and bug reports `merge` (files
travel with the command); announcements, templates, departments and bug triage `claim`s at the main site; user
accounts, access and passwords `online` (credentials, D8). Sign-in / sign-out / push / tickets / activity-log
pruning write only node-local tables and need no class. `tests/sync-route-classes.test.ts` fails any new
mutating route without a sync class.
**Offline (sync/, phase 4e, §24):** self-service (`me.routes.ts`: file a time fix, cancel your own
request or fix, contact profile, which re-checks the password on the PC and redacts it from the command) and
filing form records are `merge`; approval decisions, the form designer, record edits / deletes and global
variables are `claim`s at the main site (decided or withdrawn on the cloud meanwhile → the first outcome is
kept, flagged; a leave approval past the cloud's balance stands, flagged). The forms library: upload `merge`, delete `claim`.
**Offline (sync/, phase 4c):** `POST /api/attachments` is `physical`, and the photo travels with the
command via `syncUpload`. Deleting one is a company-wide `claim`; an installed PC keeps the file until
the cloud confirms. The other core routes are not classed yet.
**Form lifecycle (schema 76):** `shared/form-history-schema.ts` retains definition snapshots
(`form_definition_versions`) and record revisions (`form_record_revisions`). Records carry
`definition_version` and `revision`; corrections use the original schema and optional stale
revision guards. Archived definitions reject new records/imports but permit corrections with
required reasons, preserving layouts. Existing records are captured as legacy baselines.
`shared/form-history-context.ts` attributes trigger snapshots to the authenticated actor and
shared command clock. During changeset application, derived history triggers are suppressed:
the captured authoritative history is applied exactly once. History foreign keys cascade ID
renumbering used by offline allocation. `data-forms/preferences.routes.ts` owns per-user
favorites, recents, columns and saved filters (`form_user_preferences`, merge writes).
`payroll/deduction-history.ts` retains before/after employee deduction values and modes,
actor/name/time and optional reason in `payslip_deduction_history`; payroll.view gates reading.
Actual-app lifecycle/large-form coverage extends `npm run test:forms:ux`; the HR review
protocol is `docs/guides/data-forms-hr-acceptance.md`.

**Form validation (`public/js/lib/form-validation.js`):** shared by Data Forms, Form Builder,
desktop HR requests and mobile requests. Inline errors are linked through `aria-describedby`; a
summary focuses the affected control and reveals hidden setup panels. Required checkboxes mean
checked, not merely present. The mobile shell precaches the helper. Actual-app browser coverage:
`npm run test:forms:ux` (disposable database, reports/screenshots under `work/forms-ux`).
**Public interface:** standard REST routes mounted with no `requireModule()` gate.
`messages.routes.ts` also calls `shared/ws.ts`'s `broadcast()` after each mutation for
live chat updates — VOIP/calling is explicitly out of scope for this feature (deferred as
its own future project; needs WebRTC + a STUN/TURN server, unrelated infra).
**Roles & access (status: working, 2026-10-05):** a role is a tenant-defined, named permission
bundle in the `roles` table (`shared/roles.ts`; seeded once from `permissions.ts` `BUILTIN_ROLES`,
then freely edited). `core/roles.routes.ts`: `GET /api/roles` (users.manage or hr.manage),
`POST` / `PUT /:key` / `DELETE /:key` (users.manage, `online`). `admin` is fixed — always every
permission, never renamed or deleted; a role still held by an account can't be deleted (409).
An account = its role's bundle + its own sparse overrides (`users.permission_overrides`); editing a
role changes everyone holding it on their next request. Every built-in role carries
`mobile.access` (phone app) + messaging, and a new role starts with them, so new accounts can use
`/m` straight away. `GET /auth/me` and login return `role_label`.
The built-in floor roles (parts clerk, production lead / manager, QC / QA inspector, Products In
clerk, releasing clerk) see only their own desk: no `inventory.view` / `production.view` in their
seeds (2026-10-06); their screens' reads open to the desk permission (`shared/desk-access.ts`
above), and anything broader is an admin's tick in Roles.
`POST /api/users` accepts `users.manage` **or** `hr.manage`: HR's employee form
(Linked user account → "+ Create new account") calls it directly; a caller without
`users.manage` may only assign a *staff* role — one whose permissions are all in
`permissions.ts` `STAFF_PERMISSIONS` (`isStaffRole`; applies to custom roles too) — 403 otherwise.
UI: `public/js/lib/access-editor.js` — one permission picker (search, On/Changed filter,
per-section All/None, "opens" hints built from `nav-config.js` `requiredPermission`) used by the
role editor (`AccessEditor.editRole`, Admin → Accounts → **Roles** tab) and the per-account
**Access** drawer (`AccessEditor.open`, Admin → Accounts and the employee form). `GET
/users/permissions/catalog` returns `roles`, `staffPermissions`, and what the caller may change
(`grantable`, `assignableRoles`); `GET /users/:id/access` returns one account's role + overrides;
`PUT /users/:id/permissions` lets an HR-only caller edit staff-role accounts and only
`STAFF_PERMISSIONS` keys. Desktop menus are gated by the permission each screen's GET checks
(`nav-config.js`); a menu with no visible subtab is hidden.
**Permission splits (2026-10-06, SCHEMA_VERSION 59–61):** three areas got their own permissions,
each granted once by `migrate()` (`grantOnce`, flagged in settings so a later upgrade never re-adds
what an admin removed) to every role / per-account grant that had the old one, and seeded the same
way into the built-in roles — nobody loses access; trim it under Admin → Roles.
- **Pay** (`payroll.view` / `payroll.manage`, `modules/payroll/pay-access.ts`): rates and pay
  settings on the employee record (stripped from `GET /hr/employees`, the export and the cutoff
  roster without payroll.view; kept as stored on saves without payroll.manage), payslips (the
  `hr_payroll` form's records — `form-builder.routes.ts` `canAccessRecords`, instead of
  forms.manage.hr), 13th month, final pay, rate tables, rate history / change, payroll-policy
  save, generate / post-to-GL / mark paid / deductions / email. hr.view / hr.manage keep
  employees, timekeeping, memos. The AI search index now files each form record under its
  reader's permission (payslips payroll.view) instead of forms.view.
- **Production screens** (`production.view`): every manufacturing read (job orders, production,
  QC records, production issues); BOM explode / cost / where-used / package. The product catalog
  (`GET /finished-products`, `/:id`, `/:id/units`), the finished-goods lookup and parts slips accept
  inventory.view or production.view. The mobile Production tab ignores production.view (read-only).
- **Purchasing** (`purchasing.view` / `purchasing.manage`, `modules/inventory/order-access.ts`):
  purchase orders (per-type checks on `/api/orders` — the list is now gated, it used to be open
  to every account), goods-receipt reads, vendor bills, tolerance, reorder / shortfall POs, the
  QuickBooks push of a PO. Receiving still needs inventory.adjust. orders.* now means sale and job
  orders. Job-order purchase-shortfall keeps its production gate (inventory.adjust).
Tests: `tests/roles.test.ts`, `tests/permissions.test.ts`, `tests/users-hr-create.test.ts`,
`tests/payroll-permission.test.ts`, `tests/production-view-permission.test.ts`,
`tests/purchasing-permission.test.ts`.
**Sessions & devices:** `POST /api/auth/login` takes `shared: true` (borrowed phone / shared
computer); `GET /auth/me` reports `session.shared`. `GET /api/auth/sessions` (`?history=1`),
`POST /auth/sessions/:sid/revoke`, `POST /auth/sessions/revoke-others` — the caller's own;
`GET /api/users/:id/sessions`, `POST /users/:id/sessions/:sid/revoke`,
`POST /users/:id/sessions/revoke-all` — `users.manage`. Logout also drops the user's push
subscription registered from that device (`push_subscriptions.device_id`); `POST /push/subscribe`
is refused (403) on a borrowed-phone session; `GET /push/status?endpoint=` says whether this
browser's subscription is the caller's. `GET /api/activity` filters by `ip` / `device_id`.
UI: `public/js/lib/session-list.js` (My Account "Where you're signed in"; Admin → Accounts →
Edit → "Sign-ins & devices"), activity log Device column + "All from this device / IP", mobile
Account & security. Tests: `tests/sessions-devices.test.ts`.
**Dependencies:** `shared/` only. **Known wart:** `modules/ai/ai-tools.ts` imports
`visibilityClause` out of `core/forms.routes.ts` — a routes file used as a library.
Pre-existing; not fixed by this reorg.
**Status:** working.

### core — confidential reporting (anonymous channel)

**Responsibility:** an identity-free reporting channel for workplace, safety, misconduct and
operations concerns — separate from identified reports (Messages) and software bug reports.
**Owned data:** `anonymous_reports`, `anonymous_report_messages`, `anonymous_report_tickets`,
`anonymous_report_attachments`, `anonymous_report_handler_seen` (highest photo id a handler has
loaded, per report — no date) (all created in `createSchema()`, no SCHEMA_VERSION bump). No
reporter column of any kind; dates only (never times); the follow-up access code is stored as
SHA-256 only; numbering (`CR-00001`) comes from the table, not `settings` (whose `updated_at`
would timestamp it). Photos are BLOBs in the DB (no original filename, no UPLOAD_DIR file whose
name or mtime could date the submission), `message_id` NULL = sent with the report.
**Offline (phase 4f, docs/OFFLINE-FIRST.md §25):** submit / follow-up / photo removal are unattributed `merge`
commands, held on the PC for a random while before they're sent. The ticket stays on the PC, the access
code travels only as its hash, and photos travel only stripped. A PC numbers a report `CR-X…`
(from its command id); the cloud gives the real `CR-#####` and keeps the provisional one in
`anonymous_report_aliases` (lookups accept either). Handler reply `merge`, status `claim`.
**Owned files:** `core/confidential-reports.ts` (service), `core/confidential-reports.routes.ts`,
mobile `core/report-problem.js` (anonymous form, receipt, check/reply) and
`core/confidential-reports.js` (case-handler queue); desktop `public/js/modules/core/confidential-reports.js`
(HR → Anonymous Reports tab, shown only with `reports.confidential`).
**Public interface:** reporter — `/api/anonymous-reports` `POST /ticket` (signed in; single-use,
unlinkable, 10/day in-memory cap), `POST /` (no auth read), `POST /lookup`, `POST /followup`
(number + access code). `POST /` and `/followup` also take multipart `photos` (≤4 per post,
≤6 MB each, ≤12 per report). The reporter gets photo ids (+ `removable`) in `/lookup`, fetches
one with `POST /photo` and deletes one with `POST /photo/remove` — number + code always in the
POST body, never an image URL; removal only while no handler has loaded that photo (opening
the case detail marks all its photos seen) and the report isn't closed. Handlers —
`/api/confidential-reports` (`reports.confidential`, HR + admin by default, not HR-grantable):
list (`photo_count`), detail (`attachments` on the report and per message),
`GET /:id/attachments/:attId`, `POST /:id/status`, `POST /:id/reply`.
**Photo privacy (two layers):** the phone redraws every picked photo into a fresh JPEG
(`ImageCompress.reencode`, `public/js/lib/image-compress.js`; picker `mPhoto.picker` in
`public/mobile/lib/photo.js`), then the server strips again with
`shared/image-metadata.ts` (`stripImageMetadata`: JPEG/PNG/WebP allow-list walk — drops EXIF/GPS,
XMP, IPTC, ICC, comments, text chunks and anything after end-of-image; keeps only JPEG
orientation; rejects anything it can't parse, before the ticket is used). Originals are held in
memory only (multer memoryStorage). A picked PDF is never sent: `public/js/lib/pdf-pages.js`
(`PdfPages.toJpegs`) draws each page into a fresh JPEG with vendored pdf.js
(`public/js/vendor/pdfjs`, 6.3.289 legacy build, loaded on first PDF pick; scripting off; see its
`VERSION`), one photo slot per page — the server only ever receives JPEGs.
**Connections:** `shared/push` notifyPermission('reports.confidential') on new report / reporter
follow-up (number + category only). `app.ts` exempts `/api/anonymous-reports*` from the activity
log and idempotency store (`isAnonymousReportPath`); handler routes are audited normally.
In-memory rate limits only (15-min window).
**Known limits:** photos and PDFs only (Word/other documents aren't accepted); a PDF arrives as
page images (no selectable text), at most as many pages as there are free photo slots, and
CJK-only PDFs may render with fallback glyphs (cmaps not vendored); what a photo or page
*shows* (names, faces, badges, screens, reflections) isn't removed — the UI warns. HEIC/GIF are
only accepted after the phone re-encodes them to JPEG. Photo BLOBs don't count toward the tenant `storage_mb` quota (which measures
UPLOAD_DIR; deliberately not enforced so a plan limit can't block a report).
**Tests:** `tests/confidential-reports.test.ts`, `tests/image-metadata.test.ts` (fixtures in
`tests/image-fixtures.ts`), anonymous transport checks in `tests/frontend-mobile.test.ts`.
**Status:** working.

## modules/inventory

**Responsibility:** items, stock levels, suppliers, customers, locations, sale/purchase
orders (the order shell — 3-way-match purchase logic lives in `purchasing/`),
sale-order releasing (warehouse acceptance → pick → release slip), deliveries.
**Owned files:** `inventory-stock.ts`, `order-availability.ts`, routes: `inventory.routes.ts`,
`suppliers.routes.ts`, `customers.routes.ts`, `locations.routes.ts`,
`deliveries.routes.ts`, `orders.routes.ts`, `release-slips.routes.ts`,
`sales-returns.routes.ts`.
UI: desktop Inventory → Releasing (`public/js/modules/inventory/releasing.js`),
mobile `so` view (`public/mobile/modules/inventory/so.js`).
**Owned data (releasing):** `orders.warehouse_accepted_by/_at`, `release_slips`,
`release_slip_items` (snapshot of lines + unit serials); photos are core `attachments`
kind `release` (ref = slip id).
**After shipment:** `sales-returns.routes.ts` records photo-backed customer receipts against a
slip line, with a shipped-quantity cap and exact sold serial for serialized goods. Receipt
does not move stock. Inspection records restock (stock-in and an idempotent COGS reversal at
the slip's captured cost) or reject (no stock-in); the issued sale and slip stay intact.
Finance separately issues and links a customer credit note, with link history retained.
Desktop users work from the issued slip in Releasing; mobile implementation is assigned in
`MOBILE-INVENTORY-HANDOFF.md`. See `docs/reviews/sales-return-workflow.md` for the full contract.
**Warehouse-out rules (`release-auth.ts`, createSchema tables, no version bump):**
`release_authorizations` (Sales, `orders.edit`: pickup/delivery, approved recipient, only the last 4
of an ID reference, a `PICKUP-XXXX`/`DELIV-XXXX` token, validity, handoff area, partial allowed;
a new one revokes the previous), `product_package_items` (per finished product, set in the BOM
editor; `GET/PUT /finished-products/:id/package`), `release_slip_details` (token used, recipient,
confirmed package JSON, seal tag, acknowledgement, a partial release's backorder), and
`release_reports` (releaser → Sales). `POST /orders/:id/release-slip` refuses (409 `{blocked}`)
before any write: a missing / wrong / expired / used / revoked authorization or token (every
order needs one unless the company turns the `release_authorization_required` setting off — on
by default; an order that has one always enforces it), any unconfirmed required package item, an
incomplete order without partial authority, or — from either app (`X-Client: mobile|desktop`,
sent by `public/js/api.js`; `shared/device.ts isAppClient`; scripted callers and synced replays
carry no such header) — no handoff photo (`evidence_ids`: `attachments` kind
`release_proof` on the order, taken over by the slip as kind `release`). **Token override:**
`release_token_overrides` — the releaser asks (`POST /orders/:id/override-request`, merge; pushes
every `inventory.adjust` holder), a supervisor (`inventory.adjust`) approves or declines with a
reason, or overrides directly (`POST /orders/:id/override`, claim). An approved one stands in for
the token on one slip of a valid authorization and its reason is on the slip. Release reports
push the authorization's issuer and every `orders.edit` holder. With
partial authority the order is split at the slip (`splitUnreleased`: released quantities stay,
the rest becomes a new approved backorder SO). `release-slips.routes.ts` adds:
`GET /orders/:id/context` | `/unit?code=` | `/verify-token?token=` (releasers; the token is never
returned to them), `GET|POST /orders/:id/authorizations`, `POST .../authorizations/revoke`,
`POST /orders/:id/reports`, `GET /reports/list`, `POST /reports/:rid/resolve`, `GET|PUT /policy`.
Desktop: Sales Orders key icon (`release-authorization.js`, shows the override), slip modal token +
package fields, supervisor override and partial release when Sales allowed it (`releasing.js`),
BOM editor package list. Tests: `tests/release-auth.test.ts`.
**Public interface:** stock-mutation functions in `inventory-stock.ts` (called
directly by `manufacturing/`, `purchasing/`, and `modules/ai/ai-tools.ts`).
**Dependencies:** `shared/`; `sync/` (`syncClass`) for offline-capable routes.
**Offline (sync/, phases 2, 3c-ii):** every route in `inventory.routes.ts`, `locations.routes.ts`,
`suppliers.routes.ts`, `customers.routes.ts` declares a sync class: stock adjust / damage /
transfer `physical`; creating items, locations, suppliers, customers `merge`; edits, deletes,
imports, settings, reorder-PO, discrepancy resolve, item photos `claim` (photos travel with the
command via `syncUpload`, phase 3e). Orders, deliveries and release slips (phase 4c, §22):
release, release slip, delivery status and proof of delivery are `physical`; new orders and deliveries are `merge`;
approval/status, edits, deletes, accept-release, unreserve and the shortfall actions are `claim` at the order's
stock-location site. The availability gate, the release and slip status checks, and a proof of delivery over a
cancellation are D6 clash-checks; the slip's stock-out beyond stock is D1. Claims
run offline at the owning site: a location's edit/delete → its site; discrepancy resolve → its
location's site (a marked clash-check: already resolved elsewhere → kept + flagged); the rest →
the main site.
**Owned data (offline):** `stock_discrepancies` — opened by `applyStockChange` when a synced
stock-out takes a location below zero (decision D1); `GET /api/inventory/discrepancies`,
`POST /api/inventory/discrepancies/:id/resolve`. `overdrawAllowed()` in `inventory-stock.ts`.
UI: Inventory → Stock Movements → Discrepancies (`public/js/modules/inventory/stock-discrepancies.js`,
route `stock-discrepancies`).

Order intake is handled by `orders.routes.ts` and `public/js/modules/inventory/orders.js`:
explicit stock links, positive line quantities, date/reference validation, one stock
line per sale item, customer defaults, permission-aware controls, visible approved-line
locks, and a responsive editor with inline errors and keyboard dialog handling.
Validation/interaction coverage: `tests/orders.test.ts`, `tests/orders-ui.test.ts`;
availability/release compatibility: `tests/order-availability.test.ts`,
`tests/order-release.test.ts`. Existing records are not migrated; locked legacy lines
are retained when a header is saved.
Audit additions: `orders.view` read gates, preserved partial headers/line IDs,
content revision checks, warehouse-only released transitions, financial/location
locks, inactive reference preservation, unsaved-change protection, and retry-safe
editor saves. `src/app.ts` mounts order-save idempotency after mutation permissions;
`shared/idempotency.ts` scopes cached responses to authenticated users and endpoints. Local cached acknowledgements retain `X-Sync-State` and `X-Sync-Command` on replay so a retry cannot turn a pending site-PC action into final success.
**Status:** working.

**Sales stock approval refinement:** `order-availability.ts` is the shared warehouse ATP
and supply-planning calculation; `orders.routes.ts` re-exports it. Desktop saved orders have
an explicit stock review with local/elsewhere stock, commitments and kit/repair holds.
Approval and shortage actions use optional revision checks; drafting supply never clears ATP.
Existing job snapshots and unreceived output cover planned production. Purchase cover is tracked
by `sale_shortfall_purchases`, current PO lines and receipts; repeated actions draft incremental
requirements only, atomically across suppliers/jobs. Mobile implementation remains unchanged;
its prioritized gaps and contract checklist are in [MOBILE-INVENTORY-HANDOFF.md](../../MOBILE-INVENTORY-HANDOFF.md).
Coverage: `order-planning.test.ts`, `sync-order-planning.test.ts`, `orders-ui.test.ts` plus
existing availability, release, permissions and sync regressions.

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
(component need vs. on-hand/held/free at the source + `releasable`; also readable
by narrow approvers), and
`GET /job-orders?stage=awaiting_approval|awaiting_release|awaiting_warehouse|preparing|ready_to_release`.
Draft detail and availability expose `approval_revision`. Approval accepts optional
`expected_revision`; a changed plan returns `409 code: stale_job_order` before signing.
The hash covers draft/component/checklist contents, not live stock or timestamps.
Mobile approval is discoverable from Work, the Production hub and manager control,
with a full draft/stock review and explicit acknowledgement for shortage follow-up.
Persisted approval keys, notes and plan summaries survive restart; scoped saved
attempts stay in the queue even after an approved draft leaves the authority queue.
**Warehouse release interface:** `POST /job-orders/warehouse-accept`, `POST /job-orders/prepare`
(bulk), `GET /job-orders/pick-list?ids=[&format=html]`, `POST /job-orders/:id/release`
(issues the `PRS-#####` parts release slip, deducts stock). **Floor:** `POST /job-orders/:id/units`
is multipart and requires the photo; pause/resume accept `production.pause`; the
`production_manager` role (`production.manage`) adds pause/resume/close-early with a required
reason, logged append-only in `job_order_events` (`GET /api/job-orders/:id/events`); issue reports
live at `/api/production-issues`. Uses `core/attachments.routes.ts` (`imageUpload`,
`saveAttachment`) for photos sent together with the record they belong to.
**Inspection interface (mobile V2):** `GET /api/qc/queue?role=qc|qa` — the caller's own pass
across open job orders (same stage rules as `/units/inspect`), rework units with their last
failure + open parts requests, and the caller's results today. `/units/inspect` checklist items
take `status` (`pass|issue|na`; only `pass` satisfies a required check) and `value`; a repair
result takes `repair {category, station, priority}`, stored in `qc_repair_details` (createSchema,
no version bump). Checklist items take `group`, `measure`, `hint`.
Tests: `tests/qc-inspection-v2.test.ts`.
**Separate mobile unit findings:** `manufacturing/unit-issues.js` registers
`#/unit-issues?unit=&role=qc|qa`, opened from QC/QA verify/recheck/review, the unit
record and Work's saved-report tile. Each issue owns its category/severity/description
and compressed photos. Independent UUID drafts permit multiple unsent findings on
one unit and persist photo bytes with account/server scope. During an authority
outage, saved context allows draft editing/new findings while live issues stay
unknown; reconnect/reopen is required before sending a draft. Report creation and each
photo upload use immutable persisted retry keys, explicit unknown recovery, reviewed
refusal corrections and local-command pending states. Reporter/manager edits,
add-photos, resolve and reopen retain backend enforcement. Narrow floor readers
must specify a unit for the issue list and can read unit-linked reports/photos;
they do not receive the global feed. Reports are informational.
Own unused `production_issue` photos of the inspected unit can also satisfy
`evidence_ids`, without reuploading. Used evidence photos cannot be deleted.
Tests: `tests/unit-issue-reports.test.ts`, mobile frontend and draft storage tests.
**QA hold + evidence:** a final-pass `fail` with disposition `hold` puts the unit in status `hold`
(`qc_records.result = 'hold'`; counts as unresolved — the job order can't auto-complete, its batch can't
close, cancellation scraps it; early close preserves it for review and receiving).
`GET /api/qc/holds` lists held units; `POST /job-orders/:id/units/:unitId/
hold-decision {outcome: pass|rectify|fail, remarks, disposition?, repair?, expected_hold_record_id?}` decides one — any QA
inspector or a new grantable `production.qa_review` (Production Manager by default), or
`inventory.adjust`. The optional reviewed-hold ID rejects a newer hold episode with `409 code: stale_hold`.
Mobile hold decisions persist their immutable payload/key and reviewed context in
account/server-scoped IndexedDB; original-key retries survive restart. Saved decisions
remain discoverable after a unit leaves the live list. Definitive refusals require
fresh review/key; expired/key-conflict attempts require reconciliation. Holds lookup
errors/timeouts show unknown counts and retry instead of zero. Hold-only reviewers
get decision controls without inspection actions; local sync results remain pending.
A confirmed pass still waits for Products In before stock entry.
Holding pushes every QA inspector / `qa_review` holder; the decision pushes the
inspector who held it. Evidence: a failing / held result carries `evidence_ids` (`qc_unit` or unit-linked `production_issue` photos
of that unit by that inspector, each backing one record — `qc_evidence`, createSchema); from the
phone or desktop app (`isAppClient`) one per unit is required (409 `blocked: 'evidence'`); the desktop
QC form uploads the chosen photo(s) to each failed unit first (`production-qc.js`). Desktop job
order: held units with Decide…, and Pause / Resume / Close early for `production.pause|manage`
holders without `inventory.adjust` (reason required), plus the line-decision history
(`GET /:id/events`). Tests: `tests/qa-hold.test.ts`.
**RTS interface (mobile V2):** rules in `rts.ts` (`unitBlockers`, `locationError`, `openHolds`),
applied by `POST /job-orders/:id/products-in` before any write (409 `{blockers}` for a unit already
in finished goods, a serial already in stock on another unit of the same product, a unit not yet
passed, or an open `Product-data mismatch` production issue; 400 `{location_error}` for a missing
or truck location, or one without room for the posting under its capacity — `location_capacities`,
createSchema, set per location on `POST|PUT /api/locations {capacity}` and returned by `GET /api/locations`;
room = capacity − the sum of stock there). `rts.routes.ts` at `/api/rts`: `GET /queue` (passed units across job orders
with final-pass record and hold, receivable batches, the caller's postings today),
`POST /check` (same rules, no writes), `GET /lookup?q=&status=ready|allocated|hold`
(`inventory.view` or `production.view`). `production.receive` may file production issues (the mismatch report).
Mobile `manufacturing/rts-recovery.js` persists immutable receipt groups in scoped
IndexedDB (`rts-unit`/`rts-batch`), with one payload/key/status/receipt/sync command
per job order. Explicit original-key retry survives restart and skips confirmed
job orders; saved entries remain discoverable after live queue removal or failure.
Overlapping unit/batch routes recover existing attempts, and same-batch tab races
are refused by draft revisions. Refusals require live review and a fresh corrected
key; unknown/expired/conflicting and site-PC pending attempts cannot be replaced.
Local command confirmation gates continuation/final Ready-to-sell copy; failed
commands require reconciliation. Queue timeout/failure shows unknown counts and
preserves recovery access. Work merges unresolved saved candidates with the live
queue. Batch form rejects invalid/fractional counts. Receipt mutations remain
online-only; there is no background resubmission or schema change.
Tests: `tests/rts-recovery.test.ts`, mobile frontend, and bulk idempotency coverage
in `tests/production-receiving.test.ts`.
Tests: `tests/rts.test.ts`.
**Repair-parts interface (mobile Parts clerk, Figma 83:*):** `production.routes.ts` adds
`GET /repairs/:id/context` (unit, source inspection with station/priority, duplicate open
requests, stock per location with approved sources first, pending revision, events, live
shortage), `GET /repair-history?q=&state=issued|rejected|blocked` (counts), `POST
/repairs/:id/shortage` (merge; records an escalation), `POST /repairs/:id/revision` (merge; the
clerk proposes another part / quantity) and `POST /repairs/:id/revision/decide` (claim; the
requester or `production.approve` / `inventory.adjust`, never the proposer). Accept refuses,
before any write, a non-storage source (truck), a pending revision, a picked quantity other
than requested, or a scanned label that isn't the requested SKU. Tables `repair_revisions`,
`repair_request_events` (createSchema, no bump). Tests: `tests/repair-parts-v2.test.ts`.
**Stock holds (`stock-holds.ts`):** one answer for stock set aside but not yet issued — draft
job-order kit picks (`kitPickedAt`) and `repair_part_holds` (createSchema): an open request holds
its quantity at the first approved source with enough free stock when raised or when its revision
is approved, and drops it on issue, reject or cancel. `freeFor` (stock − kit picks − other holds)
gates repair issue (409 `blocked: 'held'`) and the shortage flag; kit picking (`/job-orders/prepare`)
and the sale-order availability gate count the holds too. Adjustments and transfers are not blocked.
Pushes to the requester: part issued, rejected, short (also every `inventory.adjust` holder) and a
revision to approve (opens `#/repairs?id=&step=decide`, the one step open to the requester / a
supervisor); the proposing clerk hears the decision.
**Offline (sync/, phase 4b):** every mutating route is classed — floor events (release, kit accept,
progress, units + photo, QC/QA inspection, products-in, batch inspection) `physical`; new job orders /
batches / repair and issue reports `merge`; decisions `claim` (a job order's → its source-location
site, else the main site). Release short on stock is accepted + flagged (D1); kit pick short on the
cloud and double approval are D6 clash-checks. Numbers (MO, BATCH, PRS, PI, RPR) come from the
site host's number blocks offline.
**Status:** working. Open gaps from the 2026-09-27 walkthrough:
`docs/PRODUCTION-WALKTHROUGH-GAPS.md`.

## modules/purchasing

**Responsibility:** goods receipts, vendor bills, the PO ↔ receipts ↔ bill 3-way match.
**Owned files:** `purchasing-match.ts`, routes: `purchasing.routes.ts`.
**Dependencies:** `modules/inventory` (declared as a hard dependency in
`shared/modules.ts`'s `MODULE_DEPS`), `modules/accounting` (autopost).
**Offline (sync/, phase 4d, docs/OFFLINE-FIRST.md §23):** goods receipt `physical` (home: the
receiving location's site); bill entry `merge`; receipt reversal `claim` at the receipt location's
site; bill edit / approve / dispute / delete and tolerance `claim` company-wide (the main site).
D6 clash-checks: a receipt line whose PO line the cloud removed (kept, unlinked); an approval
whose 3-way match fails only on the cloud; a bill approved on both sides (first kept).
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
`hr-employee-numbering.ts`, `punch-photos.ts`, `punch-holds.ts` (phone punch scan → selfie
holds), routes: `hr.routes.ts` (also owns the
`asset_issuances`/`asset_issuance_items` tables and the seeded "Asset Issuance Form"
doc_template, SCHEMA_VERSION 43; company-wide register `GET /api/hr/assets` with still-out /
people-who-left filters + CSV, UI `public/js/modules/hr/hr-assets.js` at HR → Employees →
Company Assets, tests `tests/hr-assets.test.ts`), `clock.routes.ts`, `field.routes.ts`,
`employee-profile.ts` + `employee-profile.routes.ts` (self-service profile, below).
**Employee photos (2026-10-13):** `GET /api/hr/employees` leaves `employees.photo` (a data URI)
out and sends `photo_rev` (12-hex fingerprint, null = none) instead; the image itself is
`GET /api/hr/employees/:id/photo?v=<rev>` (hr.view, `Cache-Control: private, max-age=31536000,
immutable` — the browser keeps it, Cloudflare doesn't). `PUT /hr/employees/:id` with `photo`
omitted keeps the stored photo; `''`/null removes it. The Employees screen draws its last list
at once via `API.peek` (memory-only, `public/js/api.js`). Tests: `tests/hr.test.ts`,
`tests/frontend-api-client.test.ts`.
**Self-service profile:** `employee_profiles` / `employee_profile_changes` (createSchema, no
version bump) hold the preferred name and personal contact/emergency details the employee edits
themselves via `GET/PUT /api/me/profile` (`core/me.routes.ts`) — re-authenticated with the
current password (400 on mismatch, never 401), strict schema (legal name, gov IDs, position,
department and pay keys are rejected), PH mobile numbers normalized to +63, one history row per
changed field. A contact change clears `verified_at` and pings `hr.manage`; HR re-verifies via
`/api/hr/employee-profiles` (`GET /` unverified worklist + `GET /:id` history: hr.view;
`POST /:id/verify`: hr.manage; desktop worklist HR → Employees → Contact Verification,
`public/js/modules/hr/hr-contact-verification.js`). The preferred name feeds the mobile greeting and Profile header
but never replaces `employees.name`. Tests: `tests/me-profile.test.ts`.
**Information-change requests:** `info-change.ts` owns the `information_change` request form
(seeded in `db.ts` `seedHrRequestForms`, listed in `core/me.routes.ts` `REQUEST_SLUGS`). Filing
goes through the universal `POST /api/form-records`, which for this slug always forces
`pending`, sets the subject to the caller's own employee and snapshots the current value
(`prepareInfoChange`, 400 on unknown field / bad gov-ID format / no-op). Only `hr.manage` sees
and decides it in `/api/me/approvals` (department heads and the generic `PUT /form-records`
are refused); approval runs `applyInfoChange` and the status update in one transaction —
legal name → `employees.name` (409 on a duplicate name), SSS/PhilHealth/Pag-IBIG/TIN, birth
date and civil status → their columns (`employees.birth_date` / `civil_status`, SCHEMA_VERSION
52; values checked by `birthDateError` / `CIVIL_STATUSES` in `shared/validation.ts`), each
logged to `employee_profile_changes` (source `info_change`); only "Other official record" is
approved without writing (`applied_note` tells HR to update by hand). HR can also set birth
date / civil status on the Edit Employee form (`PUT /api/hr/employees/:id`; omitted ⇒
unchanged, '' ⇒ cleared; changes logged with source `hr_edit`).
`GET /api/me/payslips` also matches legal names replaced this way (`previousNames`).
Tests: `tests/info-change.test.ts`.
**Daily Report** (`hr-daily-report.ts` + `GET /api/hr/daily-report`, UI HR → Time Keeping →
Daily Report and the HR Overview cards): Present / Late / **Half Day** / Absent / On Leave /
Reported / Not Scheduled / Not Yet In per employee and department. Half days come from
`payroll`'s exported half-day rule (see modules/payroll), with lateness against the half's own
start in the note; live, a lunch-out with no return reads as still at lunch until the lunch gap
+ 60 min has passed. Tests: `tests/hr-daily-report.test.ts` (includes a day-for-day match against
`computeAttendanceForEmployee`).
**Rest-day forms:** `rest-day.ts` owns rest-day resolution for payroll
(`attendanceDaysForEmployee`), the Daily Time grid (`GET /periods/:id/attendance` adds
`rest_day_swap` / `rest_day_swap_form_id`) and the Daily Report: per-day grid override, then an
APPROVED linked **Change of Rest Day** (`rest_day_change`: `original_rest_day` → working day,
`new_rest_day` → rest day, searched across all of the employee's attendance days), then the
weekly pattern. **Rest Day Work Request** (`rest_day_work_request`) authorizes working a rest
day; with `PayrollPolicy.require_rest_day_form` on (default off) the rest-day premium needs an
approved one linked. Both forms are seeded in `seedHrRequestForms`, self-fileable (`REQUEST_SLUGS`),
count only once approved, and are linkable/creatable from the grid's Linked Form column
(`public/js/modules/hr/hr-timekeeping.js`, which also shows "Rest Day (moved)" / "Rest Day Moved"
tags and a "Needs Rest Day form" nudge). Tests: `tests/rest-day-forms.test.ts`.
**Schedule-change requests:** `schedule_change` is seeded alongside HR request forms. The
employee selects a future published roster date and a configured shift; the department head
or HR decides it through the shared approval endpoint. Approval updates that attendance day's
`shift_id` in the decision transaction and refuses a changed roster, elapsed date or paid
cutoff. `GET /api/me/schedule` then shows the approved shift. Tests:
`tests/mobile-schedule-change.test.ts`.
**Employee status `suspended`** (SCHEMA_VERSION 53, table rebuilt to widen the CHECK): still
employed — stays on rosters, payroll and the HR lists — but `clock.ts`'s `punchBlockedReason`
refuses kiosk, phone and field punches, and production team pickers exclude them. HR lifts it by
setting probationary/regular. Not tied to the Notice of Disciplinary Action form (manual).
Tests: `tests/clock.test.ts`, `tests/employee-suspended-migration.test.ts`.
**Punch device flag** (SCHEMA_VERSION 55): a phone punch stores `time_punches.device_id` and,
for review only (never blocked), `device_flag` — `borrowed` (borrowed-phone sign-in) or
`other_user` (a device another account usually signs in on, per `shared/auth.ts`
`deviceUsualUserId`) — with `device_user_id` = that usual account. Shown in the Punch Log
(`GET /api/hr/clock/punches`). Tests: `tests/sessions-devices.test.ts`.
**Phone time-in selfie** (built 2026-10-10 on the v51 `time_punch_holds` table, no version bump):
a phone punch is two steps. `POST /api/hr/clock/punch/scan` runs every punch check (kiosk QR,
location lock, linked/active employee) and parks a hold stamped with the scan time;
`POST /api/hr/clock/punch/selfie` (multipart `hold_id` + `slot` + JPEG `photo`) records the
**slot the employee picked** — the kiosk's four: `in` / `lunchOut` (Afternoon out) / `lunchIn`
(Afternoon in) / `out` — **at the scan time**, via `clock.ts` `setSlotPunch` (shared with the
kiosk's click-to-fix `correctPunch`), and saves the photo through `punch-photos.ts` as an
`attendance` punch photo. **Re-doing a slot moves that slot's punch** (time, location, device)
and replaces its photo (same punch id → same `punch_photos` row, new file) instead of adding a
punch. The phone has no automatic in/out classification, 45 s de-dupe or "already timed out"
refusal — those stay on the kiosk's `POST /kiosk-punch` (`recordPunch`). `GET /my-status` adds
`slots` (each slot's HH:MM, HR-typed brackets filling gaps) and `next_slot` (what an automatic
punch would fill now; null once Out is recorded) for the phone's tiles. Holds: one per employee,
5-minute expiry, used once, someone else's refused. No selfie → no punch. The old one-step
`POST /punch` answers 410 ("update the app"). The selfie shows in the attendance grid's camera
badge and the Punch Log's Photo column (desktop `hr-timekeeping.js`).
**Phone Clock screen** (`public/mobile/modules/hr/clock.js`, reworked 2026-10-10 with Kyle's
approval — departs from Figma 46:577's dropdown + Review & confirm): four slot tiles (suggested
one marked Next); one tap starts the scan with GPS fetched meanwhile (clock_anywhere staff get an
"At the office / Outside the office" toggle, remembered per phone); a filled tile asks "Replace?"
first; the selfie auto-captures after a 2 s countdown (`public/mobile/lib/selfie.js` `auto`,
live front camera only, tap to take sooner); the result returns to Home after 2.5 s unless it
offers "Request OT". Tests: `tests/clock.test.ts` ("phone punch: scan, then selfie"),
`tests/sync-clock.test.ts`, `tests/frontend-mobile.test.ts`; helper `phonePunch()` in
`tests/helpers.ts` (defaults to `next_slot`).
**Dependencies:** `modules/payroll` (pay computation + statutory tables),
`modules/accounting` (`accounting-autopost.ts`, to post payroll to the ledger),
`platform/` (photo-retention settings).
**Offline (sync/, phase 4a):** time-clock punches, corrections, field kiosk punches and punch
photos are `physical`; kiosk approval / lock, location lock and punch import are `claim` (main
site). `clock.ts` runs on `now()` (the punch's own time under sync); `kiosk-devices.ts` never
stamps `last_seen_at` on an installed PC.
**Offline (phase 4e, docs/OFFLINE-FIRST.md §24):** employee records, 201 documents (upload `merge`, travels
with the command), shifts, number policy, import and profile verification are `claim`s at the main
site; issuing and returning company property is `physical`.
**Offline (phase 4g, §26):** payroll (cutoffs, roster, attendance grid, generate payslips, deductions, mark /
unmark paid, GL post, payroll tables and policy, the payroll CSV import) is `claim`s at the main site; emailing a
payslip is `online`. Paid on both sides → kept, flagged (D6).
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
`ph-payroll-report-data.ts`, `ph-statutory.ts`, `ph-vat-ewt.ts`, `statutory-month.ts`
(the contribution month a cutoff belongs to + each employee's earlier payslips in it), `payslip-pdf.ts`
(renders one finalized payslip as a PDF; captions from the live `hr_payroll` form),
`payslip-owner.ts` (maps a payslip to its employee by stamped `employee_id`, else current or
former name from `employee_profile_changes` field `name` — read-only use of hr tables, no hr
code import. Every aggregate — 2316, alphalist, 1601-C, agency schedules, 13th month — and
generate-payslips' "existing payslip" check go through it, so a renamed employee stays one
person and regenerating a cutoff never duplicates their payslip. Generation now stamps
`employee_id`; HR renames (`PUT /hr/employees/:id`) are logged with source `hr_edit`).
The BIR 2316 prints the employee's Date of Birth (`employees.birth_date` → `birth_date_mdy`,
MM/DD/YYYY, added by `GET /accounting/bir-2316/:employeeId`; template row seeded, and patched
into existing templates at SCHEMA_VERSION 54). The alphalist has no birth-date column in BIR's
Schedule 1 layout, so it's unchanged.
**Public interface:** pure computation/rendering functions (no routes of its own — exposed
through `hr.routes.ts`, `accounting.routes.ts`, and `core/me.routes.ts`'s
`GET /api/me/payslips/:id/pdf`).
**Half-day rule (one copy, shared with the HR Daily Report):** `hr-payroll-compute.ts` exports
`detectHalfDaySession` / `halfDayArrival` / `pastLunchReturn` ("HH:MM" in, no DB). A day is a
half day when a Half Day request is linked (its session), else HR's `half_day_override`, else —
only on a day with no form linked — from the times: **afternoon** = first time-in at/after the
lunch gap's start (12:00 on 08:00-17:00 with 60-min lunch; 11:59 is a late whole day), late
judged against the PM half's start (13:00) past grace; **morning** = left within 60 min of the
lunch gap having worked under 3/4 of the day, or left at lunch and never came back. Auto-detected
days are paid as half days and still flagged `possible_half_day` so HR files the request.
`hr/hr-daily-report.ts` calls these (connection `hr` → `payroll`, direct call), so the board
and the payslip always agree on who worked half a day. Changed 2026-10-03: the afternoon rule used
to start an hour before lunch and needed a time-out under 3/4 of the day.
**Contribution bases rule (2026-10-05, docs/PH-PAYROLL-COMPLIANCE.md §1):** each fund has its own
base — SSS on the month's actual remuneration (RA 11199), Pag-IBIG on actual basic pay (RA 9679),
both summed over the cutoffs *ending* in the month and trued up on the month's last deducting
cutoff (each cutoff deducts month-to-date due less what earlier cutoffs took); PhilHealth on the
fixed monthly basic (DOLE equivalent monthly rate: daily × (365 − 52 × rest days) / 12), never
reduced by absences. Pure rules in `ph-statutory.ts` (`sssCompensation`, `pagIbigCompensation`,
`philHealthMonthlyBasic`, `contributionBasis`, `monthRemainder`); month lookup in
`statutory-month.ts`; applied by `hr.routes.ts` `computeEmployeeStatutory` (generate-payslips +
the per-payslip deduction toggles), which stores the bases on the payslip as `statutory_basis`.
The agency schedule (`contributionBasesForMonth`) groups by cutoff end month, not pay date.
Per-employee opt-out: `employees.contribution_basis` ('actual' default | 'fixed', SCHEMA_VERSION 58),
set from HR → Employees → Edit → Statutory Deductions (`PUT /hr/employees/:id`, omitted = unchanged)
or in bulk by `accounting` in Statutory Deductions (`PUT /accounting/statutory-deductions`) for an employee
who agreed in writing — SSS / Pag-IBIG then use the fixed monthly rate, split evenly; recorded on the
payslip as `statutory_basis.basis` and honoured by the agency schedule.
Tests: `tests/ph-contribution-bases.test.ts`, `tests/hr.test.ts` ("SSS / Pag-IBIG on the month's
actual pay").
**Rate history rule:** generate-payslips pays each day at `effectiveDailyRateOn(employee, day)` —
the latest `employee_rate_history` row on or before it. Rows are written by the Pay tab's
**Change rate** dialog (2026-10-05; the rate fields themselves are read-only while editing) →
`POST /hr/employees/:id/rate-change` {rate_type, daily_rate | monthly_rate, effective_date ≤ today,
note}, which also sets `employees.daily_rate/rate_type/monthly_rate` to the rate in force today
(`rateInForceOn` — a backdated change can sit behind a later one) and recomputes the employee's
payslips for every cutoff ending on or after the earliest affected date (`recomputePayslipsFrom`, sharing
generate-payslips' `payslipRun`/`payslipData`): unpaid ones rewritten, Paid ones untouched and
returned as `paid[]` with `difference` (gross owed at the new rate), `recomputed[].gl_posted` when
the cutoff's GL entry needs re-posting. Payslips match a cutoff by label, like the detail view.
PhilHealth's fixed basic / the fixed SSS·Pag-IBIG basis use the rate in force at the cutoff's end,
not today's. `PUT /hr/employees/:id` still logs a rate change (`rate_effective_date`) for API
clients but recomputes nothing. Also written, since
2026-10-04, by the employee CSV import (effective today, note "Employee import"). A ₱0 rate means
"not set yet": entering the first real rate fills every ₱0 row ahead of it (`fillUnsetRate`), and
the SCHEMA_VERSION 56 step repaired existing ones — before that, an employee created at ₱0 and
given a rate later kept paying ₱0 for every day before the edit's effective date.
As of 2026-10-08, `recordRateChange` returns that earliest affected date, including repaired
unset-rate history, so Change rate also refreshes older unpaid slips and reports older Paid
shortfalls. Both rate-change and employee-edit effective dates reject impossible calendar dates.
**Next-day time-out rule (2026-10-04):** a time-out earlier than the time-in is the next morning
for any shift (`nextDayIfBefore` in `hr-payroll-compute.ts`, also in `rawPresentMinutes` and
`unrecordedOtMinutes`) — before, only an overnight *shift* did that, so a day-shift driver in at
08:00 and out at 06:00 the next day was docked ~11 h undertime. Hours past the shift end are OT
(paid only per the OT-form rule, else flagged as unrecorded OT). Night differential now covers
only paid time (up to the shift end, plus paid OT) — unpaid time past the end no longer earns it.
The punch side is `hr/clock.ts` `openShiftToClose` (see the Payroll run pipeline, stage 0).
Night differential defaults to **on** (`DEFAULT_POLICY` / `payrollPolicySchema`, 2026-10-04); a
company turns it off in Policy Settings, and a policy already saved keeps its own value.
**Early OT rule (2026-10-04):** time before the shift start is OT only when the day's Overtime
form has `early_ot` ticked and the time-in was ≥ `EARLY_OT_MIN_MINUTES` (60) early — never
automatic, even with `require_ot_form` off. Rounded by `ot_unit`; early and after-shift OT share
the day's cap, early first (2 h cap, 1 h early → ≤ 1 h after; `approved_hours` raises the cap).
Night differential covers paid early OT only; unpaid early time earns none. `unrecordedOtMinutes`
counts possible early OT too. The form field is seeded / touched up in `db.ts`; HR's Daily Time
grid offers the tick only on a day timed in 1 h+ early (`hr-timekeeping.js`). Fixed-basis pay
only — `per_hour` basis already pays all worked minutes past the normal span as OT.
**Late + undertime rule (2026-10-05):** on a whole day (fixed basis) late (time-in past the start)
and undertime (time-out before the end) are both charged — together they leave exactly the
working minutes present, so they never double-count. Neither charges the unpaid lunch gap
(arriving 13:30 on 08:00-17:00 is 270 min late, not 330; leaving 11:00 is 300 min undertime,
not 360) unless `count_lunch_as_worked`. Each day reports `undertime_minutes`, shown as the
payslip detail's Undertime column. The half-day guess (`possible_half_day`, "Half Day (unlinked)"
/ the grid's "Possible Half Day?") applies only to a day with **no** form linked — a day with an
unpaid Undertime Request (or OT/offset/leave) is what that form says, not flagged a half day.
**Always-whole-day rule (2026-10-05):** `employees.always_whole_day` (SCHEMA_VERSION 57; HR →
Employees → Edit → Rules, "Always paid a whole day") — any day with both a real time-in and
time-out pays the full daily basic whatever the times: no half day (guessed, HR-marked or a
filed Half Day request), late (incl. lunch lateness), undertime, Undertime Day, per-hour
proration or below-minimum denial. OT, night differential and holiday/rest-day premiums keep
their rules; a day missing a punch (absent, timed out only for lunch) is handled as usual.
Passed as `computeAttendanceForEmployee` / `computeAttendanceMultiRate`'s `alwaysWholeDay`
by generate-payslips, the payslip detail (which also returns it for a note) and the
timekeeping flags route; the Daily Time grid hides "Possible Half Day?" for these employees.
Not yet read by the HR Daily Report board, which may still show such a day as a half day.
**OT grace + "OT counts after" (2026-10-05):** Policy Settings `ot_grace_minutes` (0-59) and
`ot_min_minutes` (0-480), both 0 = off (the plain round-down to `ot_unit`). One rule,
`otCreditMinutes` in `hr-payroll-compute.ts`, used by after-shift OT, early OT and
`unrecordedOtMinutes`: no OT until the minimum is reached, then whole `ot_unit` steps; short of
the next step (the minimum or the next block) by no more than the grace counts as reaching it,
one step at most, never in per-minute steps past the minimum. 17:56 on a 17:00 end with hour
steps + 5 min grace = 1 h; a 60-min minimum + 30-min steps: 18:30 = 1.5 h, 17:30 = 0. Applied
before the daily cap and still gated by the OT form; grace-credited minutes past the time-out
earn no night differential. The Daily Time grid's OT hint mirrors it (`hr-timekeeping.js`).
The `per_hour` basis keeps its own `hours_basis_unit` rounding.
**Late grace rule (2026-10-05, per the customer):** `grace_minutes` is a threshold, never a later
start — late within it costs nothing; past it, the WHOLE lateness from the shift start counts,
rounded up to `late_unit` (6 min late with a 5 min grace = 6 min; 125 min with a 10 min grace
and hour blocks = 3 h). Same for lunch lateness, the HR Daily Report board and the AI
assistant's lateness report. Before, only the minutes past the grace counted.
**Finalization rule:** a payslip is final only when HR marks it Paid
(`POST /api/hr/payroll/:id/mark-paid`, the lock generate/edit/delete all refuse). The employee
list (`GET /api/me/payslips`) returns both draft and Paid records. Drafts have `finalized: false`,
no `download_url`, and a watermarked mobile preview with current timekeeping punches; Paid slips
have `finalized: true` and a `download_url`. The PDF route re-checks ownership and Paid status
(404 otherwise) at download time and logs `payslip-download` to the activity log.
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
**Offline (sync/, phase 4h, docs/OFFLINE-FIRST.md §27):** the books are kept at the main site. A draft
journal entry is `merge` (JV numbers from the host's block); a petty-cash entry is `physical`; everything
else is a company-wide `claim`. Posting, reversing, closing or voiding what the cloud already did keeps the
outcome, flagged (D6). Posting into a period the cloud closed stays refused (an accounting control).
**Tax privacy (20 October 2026):** BIR 2316 detail explicitly projects its tax-template employee
identity; no whole HR/pay row or automatic future-column exposure. `accounting.view` remains
the statutory-filing gate. See [contract and evidence](../operations/accounting-tax-privacy.md).
**Status:** working.

## modules/ai

**Responsibility:** the AI Assistant widget — tool-calling agent, analytics queries,
report/docx generation, FTS5 RAG over documents, HR-form proposals, sending mail.
**Owned files:** `ai-analytics.ts`, `ai-config.ts`, `ai-hr-forms.ts`, `ai-mail.ts`,
`ai-rag.ts`, `ai-reporting.ts`, `ai-tools.ts`, `rag.ts`, `reporting.ts` (generic
markdown/docx rendering, used only by `ai-reporting.ts` today), routes: `ai.routes.ts`.
**Dependencies:** `shared/`, `modules/inventory` (`ai-tools.ts` calls stock-mutation
functions directly), `core/` (`file-visibility.ts`).
**Confirm before run:** data-changing / sending tools (`CONFIRM_TOOLS` in `ai.routes.ts`) become
`ai_pending_actions` rows shown as Confirm / Cancel cards; `POST /ai/actions/:id/confirm` runs one once,
as the person, with their current permissions (prompt-injection guard).
**Offline (phase 4i):** `online`: the assistant, its key, history and usage stay on the cloud (D8); an
installed PC says it needs the internet. The search-index rebuild is per copy (no class).
**Status:** working.

## modules/email

**Responsibility:** the BYO-SMTP outbound mail tool and its route surface; tenant-visible setup guide at `/email-setup.html` linked from Email and settings.
**Owned files:** routes: `mail.routes.ts` (the transport itself, `mailer.ts`, lives in
`shared/` since `modules/ai` and `modules/quickbooks` also send mail through it).
**Offline (phase 4i):** `online`: the mail server and its password are cloud-only (D8).
**Status:** working.

## modules/quickbooks

**Responsibility:** one-way push of orders to QuickBooks Online (per-tenant OAuth).
**Lifecycle safety (2026-10-18):** connection generation + environment/realm scoping, atomic token/config
updates, per-process single-flight and durable refresh admission, per-order export locks and
durable write receipts. Unknown outcomes and unbound legacy links require reconciliation. Four
new cloud-only tables are excluded from node effects/snapshots. Shared idempotency fingerprints
also bind the accounting connection/company/environment and never cache accounting 409s.
See `operations/quickbooks-lifecycle.md`.
**Owned files:** `quickbooks.ts`, `export-jobs.ts`, routes: `quickbooks.routes.ts`.
Manual exports (2026-10-20) require recent session proof, reviewed connection generation/source version and
live actor/order checks before provider calls. Accepted receipt bookkeeping remains distinct
from authorization to send another request. Status target/generation is a single SQLite
snapshot; export roles may read metadata while configuration remains administrator-only.
The adapter filters CKD component pricing for every caller. See operations/manual-quickbooks-exports.md.
**Automatic exports (2026-10-18):** order-save transactions persist connection-bound versioned
intent; the cloud startup/timer worker claims one job per tenant per sequential pass. Later edits
coalesce; unknown writes stay blocked. Administrator status and fresh-verification safe retry
are in the desktop Orders view. See `operations/quickbooks-auto-exports.md`.
**Dependencies:** `shared/` (`mailer.ts`, `secrets.ts` for OAuth token storage).
**Offline (phase 4i):** `online`: QuickBooks is reached from the cloud only (D8).
**Status:** working.

## mobile (frontend-only surface)

**Responsibility:** not a backend code module — a licensing flag (`requireModule('mobile')`
gates nothing backend-side beyond serving `/m`) covering the entire `/m` employee PWA.
Its views live under `public/mobile/modules/<owning-module>/` mirroring the same
module names as the backend, since a mobile screen belongs to whichever business
module it serves (e.g. `public/mobile/modules/hr/clock.js`).
V2 role screens share one kit: `public/mobile/role-kit.css` (tokens from the Figma role
pages, light + dark) and `public/mobile/lib/role-ui.js` (chip/title, hero, tabs, job cards,
line lists, notices, acknowledgement check, success, actions). First role on it: warehouse
kit release, `modules/manufacturing/kit-release.js` (Figma 62:14–62:372). Every step is its own
URL so the header back arrow walks the flow; `app.js` clears `#m-view` data-* tags per route.
Warehouse acceptance, partial/full picked counts and release are separate operations.
Availability failures and saved attempts go to Review; Ready requires `releasable`.
Pick corrections stay available before the slip. Needed/picked and on-hand/held/free
stock are displayed; edited unsaved counts block release, and confirmation rechecks
availability. Each warehouse action persists an immutable retry key/payload using
`production-drafts.js` under its own kit namespace; interrupted attempts reload stages
and replay explicitly after restart. Local sync commands stay pending, including cached
backend replay; refusal shapes and cancelled deep links retain their actual state.
Second: Production Lead + Manager, `modules/manufacturing/job-orders.js` (Figma 66:14–66:650) —
serialized recording uses `lib/production-drafts.js`: IndexedDB retains photo bytes,
unit IDs and immutable retry attempts scoped to server/tenant and account. Unknown
uploads stay locked and replay their original key; completed rows are skipped. Stale
tabs cannot overwrite or delete a newer draft. Operator recovery is explicit, never
background submission; local site-PC results remain confirmation-pending.
Approval, kit acceptance, bulk output and scrap use a separate persisted JSON-action record
per job. Uncertain attempts lock input and reuse their original key after restart;
definitive refusals require review before a new corrected attempt. Recording quantities
must be whole and within remaining output, including unresolved units in that count.
role accents (`.rk-accent-lead` blue, `.rk-accent-manager` purple) also tint the Quick Orbit and
active dock tab via `html[data-role-accent]`, cleared per route. `lib/queue.js` background
flushes now swallow storage errors (no IndexedDB / blocked site data) instead of throwing.
Third: QC (teal) + QA (amber) inspection, `modules/manufacturing/qc.js` (Figma 69:16–69:478,
72:16–72:477) — one engine, two desks (`#/qc?role=qc|qa`; the Work hub opens the right one).
Checklist items are recorded Pass / Issue / N/A with readings and remarks, grouped into steps
by the item's `group`; a draft stays on the phone (localStorage) until the result is recorded.
Kept from the old screen: parts requests, checklist assignment (`qc.configure`), bulk pass.
Fourth: RTS clerk ready-to-sell intake, `modules/manufacturing/receiving.js` (Figma 74:16–74:483,
`#/receiving`) — queue (Ready / Issues / Recorded) → identify → verify → stock details → optional
group (same SKU + location) → review → final duplicate check → confirm (physical-verification
tick) → recorded; plus duplicate, location, mismatch-report and read-only lookup screens.
Posting is online-only with an idempotency key (never queued); non-serialized batches keep a
quantity screen; unit records still print from the result screen.
Fifth: Releasing personnel warehouse-out, `modules/inventory/so.js` (Figma 78:16–78:481, `#/so`,
blue `rel` accent) — queue (Ready / Blocked by authorization or open reports / Completed) → verify
release authority → scan units (allocate via `/release`, bulk quantities) → verify unit (or
release blocked for another order's / wrong / unknown serial) → package checklist + seal →
handoff (recipient's token verified, never displayed — or a supervisor's override, asked for or
approved on the `override` step) → proof (photo + signature; photos upload before the slip) → review →
confirm → recorded / receipt; incomplete allocation → partial release only with Sales'
authority; reports to Sales. Allocation and warehouse-out are online-only with idempotency keys.
`lib/signature.js` no longer clears a drawn signature on height-only resizes (keyboard/toolbar).
Sixth: Parts clerk repair-parts requests, `modules/manufacturing/repairs.js` (Figma 83:16–83:488,
`#/repairs`, orange `parts` accent) — queue (Pending / Shortage / Issued today) → review → verify
context → select an approved source → pick (scan must be the requested SKU, exact quantity) →
review issue → confirm (tick) → issued; reject (reason + review tick), shortage escalation,
revision proposal and a read-only history. Issue and reject are online-only with idempotency keys.
**Not final on a site PC:** when the phone is served by an installed PC, a result that PC saved but
the cloud hasn't confirmed (`X-Sync-State: local`) is tagged by `public/js/api.js`
(`API.syncLocal(result)` → command id; `mSubmit` passes it as `local`). The QC/QA, RTS,
Releasing and Parts result screens then read "… — on the site PC" and show `RoleUI.syncWatch`,
which follows that one action through `GET /api/sync/command/:id` (own actions; `users.manage`
sees all; the cloud always answers `confirmed`) to Confirmed or Needs attention. Any other phone
screen gets a toast. Tests: `tests/sync-status.test.ts`, `tests/frontend-mobile.test.ts`.
**Shared-phone safety:** `lib/queue.js` stamps each queued op with the account that queued it
and only lists/sends/discards the signed-in account's ops (the service worker's replay checks the
same, against the account stored with its token); another account's ops wait for that person.
`app.js` `MApp.signOut()` is the one sign-out path — flushes, warns about unsent actions,
`mPush.release()`s this browser's subscription if it is the user's, `POST /auth/logout`. Every
non-device `vds_*` localStorage key (cached profile, recents, all drafts incl. the anonymous-report
draft) belongs to `vds_m_owner`; a different person signing in clears them first, and a
borrowed-phone sign-out clears them too. Borrowed-phone sign-in ("I'm using someone else's
phone") keeps token + profile in sessionStorage, shows `#m-shared-banner`, and keeps push off.
Tests: `tests/mobile-shared-phone.test.ts`.
**Status:** working.


### Document studio and form print layouts (core)

The document studio stores structured HTML in `doc_templates.body`: design pages, named
styles, sections, notes, revisions and field bindings. Form-template links and built-in
defaults support alternative/default layouts without depending on their display names.
SQLite schema 63 adds layout link/default tables, studio recovery/history tables and grid
gap columns while preserving migrations through production schema 62. Published layout and
company-library writes use the existing claim workflow. Private drafts, shared working
rooms, presence/comments and conversion operations require the cloud; their working
state/history is excluded from replication. Browser recovery and normal editor undo
remain local. Studio library assets/styles replicate as company data.

Word conversion exposes only authored document-limit errors; parser failures receive a generic
400, unexpected export failures a generic 500. Both carry request IDs; dependency exception
messages are never concatenated into these conversion responses.

Tests cover template revisions/permissions, form links, premade mappings, conversion,
pagination/grid guards, private recovery/shared conflicts and editor workflows. See
`DOCUMENT-STUDIO-CAPABILITIES.md` for delivered tools and remaining fidelity limits.

The incremental Wordcraft port is tracked in `WORDCRAFT-PORT-PLAN.md`. Phase 1 keeps the
HTML storage contract and adds direction-preserving browser selection bookmarks to undo,
input transaction boundaries, browser history-event routing and composition-safe updates.
Shared polling defers document replacement during composition and reconciles afterward.
These are browser-side changes, not a replacement of the Rust document/layout engine.

Phase-1 command dispatch centralizes browser formatting, insertion and history commands.
Toolbar shortcuts share the same enabled/active state; selection memory spans font/color
controls and insert dialogs, and commands respect locked content and editable float islands.
The native browser adapter remains behind this registry until the document-model phase.

Clipboard copy/paste round-trips field tokens instead of editor markup; normal cut is a
command transaction and tracked cut/paste retains the review handler. Table/list Tab and
atomic-token navigation extend the same keyboard editing pipeline without schema changes.

`public/js/doc-model.js` belongs to the core document studio: typed node categories,
canonical HTML adapters and immutable paragraph-alignment changes. It preserves unknown
content and keeps live DOM/path maps ephemeral. The editor patches alignment attributes
in place; existing HTML snapshots, field rendering and API publication remain authoritative.
Tests: doc-model, doc-model-templates and the model-backed doc-editor-commands fixtures.

The model now owns selected text-range formatting for bold/italic, font/size/color and
highlight. Temporary bookmarks restore selection and are removed before snapshots.
Immutable run operations preserve annotations/atomic nodes; owned runs are reused.
Word conversion shares run-format inheritance and exports explicit resets/highlights and
formatted revision text. No persistence-schema change is introduced.

Phase-2 caret marks now own bold/italic/font/size/color/highlight state without writing
empty formatting runs or creating undo entries. Marked text insertion and committed IME
formatting use the model helpers; tracked typing keeps revision attribution. Whole-field
marks preserve actual chip nodes and raw bindings. Selected underline/strike removal
splits inline paint wrappers while preserving other marks, links and atoms; block/caret
decorations and general typing/deletion remain on the native adapter. Word export and
sanitized paste retain text-decoration-line. No database or mobile-shell change is needed.

Phase-2 paragraph text transactions now own ordinary untracked insertion/replacement,
within-paragraph grapheme deletion and selected plain-text/Cut commands. They preserve
unaffected bindings/markup and refuse protected islands. Caret underline/strike, super/sub
and Clear Formatting apply to the next inserted/committed text without empty undo entries.
Selected scripts and paragraph-scoped character resets isolate wrappers; normalization
handles matching span/sup/sub runs. Structural transitions and multi-paragraph clearing
retain existing handlers; HTML remains authoritative. Word export prevents conflicting
script flags and preserves baseline resets. No schema or mobile-loader changes are added.

The studio UI now separates primary editing from secondary configuration: editable title
and Save in the header, metadata under Settings, source/tools under Advanced, and Text /
Insert / Page & print ribbon tabs. A labelled rail opens a closed-by-default inspector;
font/style/size readouts reflect the selection and inspector sizes use points. Initial
fit-to-width/footer zoom and wrapped phone controls preserve usable page space. Find mounts
above the workspace, and keyboard tab/menu behavior is covered alongside the editor tests.
Compact header/ribbon spacing and reduced canvas padding reserve room for the document.
The ribbon can be hidden while retaining its tabs; the tool rail collapses to labelled
icons and the inspector has an explicit Collapse action. Workspace changes recalculate fit.
Inspector colors use native swatch pickers and an explicit No fill background action.
Typography/spacing use presets plus a custom-value dialog, preserving nonpreset values.
Variables opens the searchable/category-filtered variable bank with Copy and Insert.
Whole-chip click selection enables Delete/Backspace for optional starter fields, with
existing atomic commands, lock checks, undo and HTML serialization.
Floating-object toolbars use compact SVG buttons with tooltips and accessible labels for
move, stacking, inline placement, fill/border and delete; action selectors are unchanged.
Print tiling fixes each source page's paper dimensions/margins before applying a uniform
fit scale. Text wrapping, table layout and percentage floats stay in their original space;
configured cell gaps remain physical sheet spacing. Preview and browser PDFs share this path.
Page dimensions are always exposed; corner resize handles edit custom mm dimensions with
zoom-aware pointer math, Shift aspect locking and keyboard increments. Cancel restores the
previous page; completed drags enter the existing history/save path once. Chrome stays outside
the serialized surface, and shared polling defers replacement until the drag ends.
Expanded sidebar tooltips explain each tool; collapsed tooltips show its name. Both use
the shared hover/focus tooltip controller and retain accessible button labels.
Editor settings use compact 16px checkboxes with inline labels, including tracking, grid
continuous mode, layer visibility/locking and table dialogs. Inputs, actions and selected
rail tools follow app theme tokens; compact ribbon tiles size to their labels without overlap.
The Playwright audit (reviews/document-editor-playwright-audit-2026-10-13.md) covers the real
app route and responsive themes. Single variable insertion stays inside paragraph boundaries,
Undo/Redo remain available across ribbon tabs, and phone text controls wrap at full width.

The editor exposes Linked forms for saved document and form templates.
The linking dialog lists only forms the user can manage, reusing scoped link/default/
unlink APIs; several layouts remain available while one is the default. Unsaved templates
offer Save template and continue. Workspace isolation keeps resize/guide chrome beneath header menus.
Page & print wraps whole control groups, keeps empty-cell/zoom labels readable, and uses
compact themed checkboxes. Global desktop native select options follow shared theme tokens;
printed paper keeps its independent light appearance.

Page dimensions keep Width → Swap → Height together, with a theme divider before Margin.

The editor UX audit covers ribbon tabs, all ten tool panels and primary dialogs across
1440/1024/768/390px viewports and both themes. Compact header actions retain accessible
names; Save/Close stay inside the viewport. Ribbon groups wrap at tablet widths, and phone
ribbons have bounded scroll height plus a visible overflow action to preserve canvas space.
Paper dimension inputs have explicit accessible names. Variable bank field management
reuses the existing callback and refreshes the bank after catalog changes; linked forms
supports local search within the existing permission-filtered form list.

Table and named-style dialog color pickers use full swatches with explicit height/padding,
matching the existing inspector pickers rather than generic text-input padding.

The project-specific editor UX skill lives in `.agents/skills/editor-ux/SKILL.md` and is
routed from CLAUDE.md. It records the evaluated UI UX Pro Max revision and adapts NN/g,
Fluent and W3C guidance to the existing stack. `npm run test:editor:ux` starts a disposable
loopback app/database, performs Playwright task checks and axe A/AA scans, and fails on
violations, task failures or runtime errors. JSON/screenshots/trace remain in ignored work/.
Shared modal Close controls have explicit names; Insert table labels are associated with
inputs. Resize handles retain their small visual square with larger hit areas, phone zoom
controls meet minimum target sizing, and the enabled assistant moves into the editor rail
rather than obscuring the paper. Mode buttons expose selection; word-count semantics avoid
announcing every keystroke. None of these changes alter stored document content.

Shared-save operations, polling and Shared-panel actions now share one queue. Successful
room writes received during text composition/page resizing retain their acknowledgment
until DOM reconciliation is safe. Room versions cannot regress; genuine overlapping peer
edits still require review. Save holds background writes through publication/draft cleanup.
Advanced dialog scans include image-upload labels, variable/formula search, picture settings,
paragraph/styles/sections and Find in both themes at desktop/phone widths. Formula code
examples and section color swatches reuse app tokens/picker sizing.
Save validation releases the shared-sync pause; initializing Picture settings updates its
preview directly and does not create a dirty dialog. Real picture edits retain discard protection.
Transient promotion chrome dismisses when focus leaves the canvas, preserving its own
action while preventing stale overlays after tool/viewport changes.

The 14 October layout pass uses Wordcraft's actual Home/Insert/Layout grouping as a reference.
Home separates Font, Paragraph, Styles and Editing; Insert groups ordinary document elements.
Layout contains page setup and a route to printing. Labeled sidebar sections organize Document,
Design, Template and Review tools. Variables/formulas/field management, Form links with template
metadata, and Print grid are sidebar tools; grid controls remain available in measured preview.
Zoom is in the footer, and More groups preferences/help/source editing. Live control nodes are
moved rather than cloned, preserving selection handlers, undo, draft/shared and save state.
The browser fixture sets an explicit test-only admin bootstrap for the current secure seed.

The common Word ribbon pass adds Clipboard (Paste, Cut, Copy, Paste text), font-size
steps, direct Clear formatting, Replace and Select all to Home. Insert exposes existing
Header/Footer/Page number tools through the Pages sidebar. Ribbon groups use compact rows;
custom select arrows avoid white native arrow areas while keeping native keyboard behavior.
Clipboard text/HTML passes through existing canonical field serialization and sanitized paste.
Denied access leaves content intact and offers keyboard fallback; delayed Cut/Paste aborts if
the document or selection changes. Ribbon Cut is disabled while tracking text changes.
Header/footer creation preserves selected body text, reuses existing elements and is undoable.

Wide desktop Home now uses one command row with stroke icons for Clipboard and Editing, keeping labeled group dividers. The paragraph selector is labeled Paragraph type; Text styles explains body text, heading levels and shared formatting. Editor select arrow image/repeat/position/size are protected from later background shorthands, including sidebar Empty cells.

Heading controls now say Body text, Main heading (H1), Subheading (H2), with deeper levels grouped separately. Headings & styles opens a Style gallery: preview cards explain paragraph roles and show font/size metadata; separate named pencil controls edit reusable formatting. Existing command/style keys and saved markup are unchanged.

Insert symbol uses a scoped responsive grid with centered glyphs, consistent 48px-high buttons, descriptive names/tooltips and themed hover/focus. Narrow screens use five columns. Symbol insertion keeps the existing selection/history path.

Company header divider controls appear in Inspect for the header or text inside it. Clicking the bottom 12px of a .doc-head opens Inspect without moving the caret. Users can remove the border or change thickness, style and color while preserving company fields. Locked header controls are disabled and handlers reject edits.

Insert includes a quick Variable button in a Fields group. It and the persistent Variables sidebar action share the same picker/insert command; the shortcut remembers the caret and does not clone sidebar controls.

Variable chips with trailing whitespace now insert as a DOM fragment through the existing atomic command adapter, keeping them inside the selected paragraph at its end. The shared fix applies to both picker launchers and preserves Undo.

### Mobile release acceptance/allocation recovery (2026-10-15)

`inventory/release-actions.js` uses scoped IndexedDB action records for exact
warehouse acceptance and serialized/bulk allocation payloads and keys. Explicit
restart retries, refusal review, expired/conflict retention, local-command pending
states and saved-action discovery are integrated into `so.js`. Queue stages split
unaccepted/incomplete/fully allocated/blocked orders; ship-from context and preview
unit location IDs prevent misleading readiness. Bulk inputs preserve decimals and
use `free_to_allocate`. Existing backend permissions, reservation and release-slip
stock semantics remain in force; no schema changes. Tests: mobile frontend,
`order-release.test.ts`, `release-slips.test.ts`, `release-auth.test.ts` and draft/PWA
checks. Final slip/proof recovery, mobile allocation undo and delivery remain open.

### Mobile compatibility after branch integration (2026-10-15)

QA holds expose frozen final-pass checks alongside prior answers for narrow hold
reviewers. Mobile prefills status/readings, blocks incomplete Pass decisions and
persists reviewed answers with the original hold episode/key. CKD release screens
show parent manifests/child demand, allocate only physical child lines and prevent
assembled-parent substitution or partial kit handoff. Retained RTS payloads remain
compatible with the remote atomic Products In endpoint. Both histories' PWA assets
are included under v97. Tests cover hold-check retry, CKD guards and backend contracts.

Mobile build-state integration (2026-10-15): approval review and revision include job-order build state; RTS shows it and groups only matching states; releasing uses fulfillment-specific availability and blocks cross-state serial scans. PWA cache v98. Mobile transfer/adjustment variant selection and shortfall creation remain follow-ups.

QR receiving/releasing integration (2026-10-15): immutable `VDS:UNIT:<id>` and
`VDS:BATCH:<id>` printed identities resolve to read-only dossiers or role-specific
workflows. Mobile RTS and allocation confirmations require attached-label scans;
manual lookup and printing do not verify labels. Exact batch/location balances and
sale reservations (`batch-stock.ts`, schema v77) persist through receipt, allocation,
undo, handoff, transfer and inspected return. Batch count reconciliation partitions
existing stock with a reason/current-balance check and audit, without creating stock.
Legacy batch balances need a physical count; old ambiguous labels need reprinting.
Quantity-only API clients reserve tracked lots FIFO; scanned mobile picks name the
exact batch. Shared recovery retains original batch IDs, quantities and request keys.
PWA cache v99; final proof/delivery recovery remains open.

Mobile QR acceptance audit: `npm run test:mobile:qr` uses a disposable real backend,
actual print-sheet QR images through Chromium's virtual camera, narrow floor roles,
proof/signature uploads and exact allocation retry after a lost committed response.
Explicit non-serialized batches can coexist with serialized runs of the same SKU;
CKD physical component previews map to standard build stock; failed unit-template
reads cannot open blank sheets. See `docs/reviews/mobile-qr-playwright-audit.md`.
Handoff photos/signature/token state still require recapture after page restart;
physical phone/printer acceptance and final-slip/delivery recovery remain open.
### Connected staff Data Forms

`core/data-forms/sources.ts` owns the explicit source registry, module/read gates,
whitelisted snapshots and field binding validation. `sources.routes.ts` exposes the
catalog and bounded searches under `/api/data-forms/sources`. Product sale prices use
`attributes.sale_price`, matching Sales Orders; cost is not offered by that source.
`calculations.ts` normalizes product rows and uses the same `public/js/lib/form-math.js`
arithmetic as browser previews. `form-connections.js` and `form-items.js` render the shared
lookup/retry, binding and repeating-row controls. Definitions retain this configuration in
the existing versioned fields JSON. Saved references use stable IDs and historical values.

`sales-workflow.ts` validates configured submission mappings and atomically creates one open
sales order using `orders.routes.ts#createDraftSaleForForm` and the existing sales validators,
item writer and totals. `form_sales_links` is the durable per-record idempotency/link boundary;
linked record values and status are immutable and deletion is refused. Existing create-key
middleware protects response-loss retries. Schema 80 repairs the template-history foreign key
to cascade offline ID allocation without losing snapshots. Template and layout derived triggers
are suppressed during changeset application because their authoritative effects are captured.
Employee self-service request schemas reject unsupported connected types; staff forms support
all new types. Print catalogs expose nested references and repeating product rows.
Connected item validation joins ordinary required fields in one linked summary, including
all invalid row controls; correcting or removing rows refreshes that group without clearing
unrelated errors. Print frames have descriptive titles. Shared document interpolation prints
boolean values as Yes/No without changing stored data, conditions or numeric formulas.
New generated layouts use neutral Issued by / Received by signatures; saved layouts remain
versioned and are not overwritten automatically.

`form-print.js` shares generated field/table markup between the server and browser. Numeric
fields can declare `format: currency` and a three-letter currency code; calculated fields use
the same metadata. `money(value, "PHP")` renders two decimals and the code without changing
numeric values. Catalog products expose their currency; mixed-currency bindings/rows and
workflow mappings are rejected rather than converted. Invoice date, optional due date and
payment terms map into the draft order date/notes. The opt-in Inventory invoice starter uses
PHP and zero tax for review, with company/customer snapshots and a dedicated printable layout.
Starter template saves include the revision of the automatically created layout.

`nextFormRecordNumber` owns the shared per-prefix record series, skipping existing legacy
numbers without renumbering them. Form routes, payroll and holiday seed writers use it.
`sync-snapshots.ts` captures canonical connected values in server-owned command context and
uses them on authenticated replay/rebase, with current source permissions and form-version
checks. Ordinary request bodies cannot provide these snapshots. Older recorded commands
without this context retain their previous replay behavior; update installed nodes before
relying on the new snapshot guarantee.

Guide: `docs/guides/connected-data-forms.md`. Browser gates: `npm run test:forms:connected:ux`
and `npm run test:invoice:ux`. Permission/fulfillment gates remain the existing sales routes.

### Mobile final handoff and delivery recovery (2026-10-16)

`inventory/release-handoff.js` and `inventory/delivery-recovery.js` reuse scoped
`lib/production-drafts.js`, `mPhoto`, `mSignature`, API idempotency and `RoleUI.syncWatch`.
They retain Blob bytes and immutable submissions, block replacement of uncertain
attempts and expose saved records independently of live queues. Release photos and
signature upload as order evidence before the atomic slip. Delivery start and POD
have explicit recovery; evidence stays optional and pre-slip starts stay allowed.
Driver results do not offer force-backorder stock completion.

`MApp.canOpen` combines effective account permissions with workspace modules for
operational routes; Work/production queues and Quick Orbit filter using it. Account
permissions refresh on focus, foreground and reconnect, guarded against account/server
changes. Personal employee tools stay available without operational permissions.
Backend delivery guards accept `delivery.run` or `delivery.manage`, retaining
assignment checks. See `docs/reviews/mobile-handoff-6185481-review.md` for remaining work.

### Mobile legacy Pick retirement (2026-10-16)

The obsolete `#/pick` route now returns to permission-filtered Work (`46:548`).
Sales use Release orders (`#/so`); production uses Kit releases (`#/kit-release`).
The old order list, per-line negative adjustments and false batch-success result
are removed. Commercial order IDs are never reused as manufacturing job IDs.
Purchase-order receiving and intentional stock-adjustment tools remain available.
Old bookmarks perform no stock action; canonical queues retain their own gates.
Inventory form entry uses forms.fill.inventory plus per-form role/account grants (form_definitions.entry_access, access_revision; schema 82). Entry users read all assigned-form records and create/edit/submit active drafts; design, delete and approvals retain their existing manager gates. Current grants are rechecked during sync replay. See tests/form-entry-access.test.ts and the invoice Playwright gate.

### Courier pickup on mobile (2026-10-16)

Assigned staff or a delivery manager opens Work → Deliveries → a courier booking
→ Record courier pickup. Check carrier/tracking, optionally enter collector, note,
photos, signature and location, then Confirm courier pickup after physical
collection. Tracking and evidence drafts survive restart; unresolved submissions
reuse the exact request and upload keys. Warehouse-out is required before closing
courier custody; pickup does not deduct stock again. The server stores compatible
`status:delivered`, while the phone explicitly says Picked up by courier. This
records collection rather than customer receipt. Evidence stays optional by owner
policy for both own-driver and courier flows. Supplied signatures must belong to
the booking; assignment checks and terminal evidence locks remain. PWA cache v106.

## Production security boundaries (second audit, 2026-10-16)

- `src/shared/browser-session.ts`, `http-hardening.ts`, `request-validation.ts`: tenant-scoped
  HttpOnly web sessions, CSRF verification, request IDs, malformed-resource rejection.
- `src/shared/public-fetch.ts`, `push-endpoint.ts`, `file-response.ts`: pinned public-network
  requests, vendor push endpoint validation and non-executable untrusted downloads.
- `src/shared/mfa.ts`, `totp.ts`: the source branch's two-step challenge workflow and privileged
  enrollment policy. Pending setup is session-bound, expires in ten minutes and allows five attempts.
- `src/modules/ai/ai-audit.ts`: append-only tenant-local hash evidence for executed tool calls;
  separate from erasable conversations, excluded from installed-node replication.
- `src/core/policies.routes.ts`: allowlisted public draft documents. Draft availability does not
  imply legal approval; see `docs/OWNER-ACTIONS.md` and the audit scorecard.

### Mobile exact sale-line allocation (2026-10-16)

`#/so` now shows physical sale-line IDs, build states, prices and remaining counts.
A scanned item/batch/unit matching multiple open lines requires an explicit line
choice before verification and quantity entry. Completed lines are excluded, and
stale or mismatched line links return to selection. QR verification remains
mandatory. Bulk payloads carry `bulk[].order_item_id`; serialized requests carry
top-level `order_item_id`. The original line, quantity, batch/serial and retry key
are saved together by the existing scoped recovery module. No automatic line
substitution occurs on retry. Same-product/build rows share stock; displayed free
counts must not be summed. Reservations remain separate from physical stock-out.
The release context now includes line price and order currency for disambiguation.
PWA cache v107; CKD partial-kit release and pre-slip undo remain separate work.


### Owner-console passkeys (2026-10-16)

`platform/platform-passkeys.ts` owns WebAuthn public-key/challenge/session-proof storage in
platform.db, separate from tenant MFA and sync. `platform-users.ts` applies mandatory enrollment
and five-minute verification to console writes; `platform.routes.ts` exposes bounded enrollment,
login and key management. `web-console/vendor/webauthn.js` is reproducibly bundled with
`scripts/vendor-console-passkeys.mjs`. See `operations/console-passkeys.md` for rollout, backups
and evidence limits. Unenrolled accounts are password-only until policy enforcement is enabled.


### New-password writer consistency (2026-10-16)

`shared/password-policy.ts` supplies the 15–128 Unicode-code-point validator and
`passwordPolicyError` for non-HTTP writers. Operator CLI/environment bootstrap, default-admin
bootstrap and direct tenant provisioning use the same bounds/blocklist as account schemas.
Existing-password verification is unchanged. See `operations/new-password-policy.md`.


### Native credential vault and queue scope (2026-10-16)

`mobile-app/native-credentials.mjs` serializes native-only OS-vault/session operations;
`native-entry.mjs` registers the reviewed plugin and passes raw browser storage (never the
web client's in-memory storage fallback). `build-web.mjs` bundles the bridge and licenses
before API startup. `public/js/api.js` waits for initialization, accepts only freshly issued
same-server sessions and cancels sign-in results after logout/server changes. Native tokens
are memory-only at request time. Old plaintext tokens are removed and require fresh sign-in.

`mobile/lib/queue.js` binds actor + original company to new operations, removes native bearer
metadata, and quarantines old unbound work. `mobile/sw.js` enforces the same scope with cookie
CSRF/actor headers; cache v110. Queue UI distinguishes separate/review work and storage failure.
Android disables backup/transfer for app data. See `operations/native-credential-storage.md`:
web bundle/plugin sync and local tests are complete; APK/Keystore/device acceptance is not.


### Public credential-work budget (2026-10-16)

`shared/password-work.ts` bounds public password work to one active/eight waiting jobs per
process with ten-second queue expiry. `password-hash.ts.verifyPasswordForLogin` uses async
native scrypt and cooperative legacy bcrypt, with conditional upgrade support. Tenant/console
public login re-read credential/account state after awaiting and return 503/Retry-After when
busy. Synchronous internal/authenticated writers remain; see `operations/password-work-budget.md`.

### Tenant administrative verification (2026-10-16)

`shared/step-up.ts` owns live-session proof, five-minute freshness and credential/factor/permission
fingerprints. `auth.routes.ts` issues proof after completed login or bounded async password +
enabled-factor verification. Accounts/roles, node trust and mail/AI/QuickBooks configuration use
the middleware after permission/online checks. `public/js/lib/step-up.js` owns the shared accessible
confirmation; the API retries once only under the original server/session. The node-local
`session_stepups` table is excluded from sync/sanitized snapshots; mobile shell cache is v111.
QuickBooks callbacks bind the original live actor/session and a one-use generation before saving
exchanged credentials. See `operations/tenant-step-up.md` for exact scope and remaining limitations.


Payment-report retry follow-up (2026-10-19): the online tenant reporting POST bypasses the generic
pre-multipart cache and checks auth/users.manage before parsed attachment binding. A successful
response receipt shares the atomic catalog source/proof/audit/intent transaction. Desktop Billing
retains exact FormData/key after uncertainty, unlocks only on explicit 400 and refreshes current
state after acknowledgement. Old cache entries are quarantined; no-key/new-modal/different-actor
legacy duplication remains outside coverage. See operations/payment-report-retries.md and
payment-report-receipts/frontend-billing/e2e payment-receipts tests.


Inquiry retry follow-up (2026-10-19): the public site form retains one UUID key across retries
and edits; parsed normalized contact/message intent binds a successful source/alert/receipt
transaction. Replay returns only {ok:true}, not private inquiry data. Public bindings use
password-hash.ts.hashPasswordForPublicRequest and verifyPasswordForLogin(false) through the
shared bounded async work queue. Live receipt/source/expiry are rechecked after waiting; busy
queues return authored 503. Existing production rate limit counts retries. See
operations/inquiry-retries.md and inquiry-receipts/e2e inquiry-receipts/password-work tests.

Contact attempts also use a 20-second abort timer for fetch/body consumption; uncertainty retains
key/draft and enables retry. E2E clock advancement follows a committed response withheld by
Playwright; it does not certify hosted network latency or server rollback on abort.


Public signup availability (2026-10-19): signup.routes admits one active request/no backlog;
receipt and owner hashing use shared/password-work native async jobs. provisioning snapshots/
revalidates after awaits and shares synchronous publication/recovery with CLI creation.
shared/db.initializeFreshTenant reuses the prepared hash only for empty, uncached non-default
reservations; password-hash owns format checks. Default bootstrap remains unchanged. Website
signup uses an abortable twenty-second read and stable same-page key. See
`docs/operations/public-signup-budget.md`; schema setup/capacity/distributed controls remain.
