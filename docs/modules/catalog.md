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
schema/migrations), `types.ts`, `validation.ts`, `permissions.ts`, `auth.ts`
(session/login middleware; SCHEMA_VERSION 55: every session records device ID / IP / user
agent at sign-in and last-seen, is addressed outside auth.ts only by its public `sid`, and is
ENDED on sign-out rather than deleted — `ended_at`/`end_reason`, swept after
`SESSION_HISTORY_DAYS` = 90 by `cleanupSessions()`; `shared` = borrowed-phone session, 4 h max
and 30 min idle; `endUserSessions` / `endSessionBySid` / `listUserSessions` /
`deviceUsualUserId`), `device.ts` (`X-Device-Id` — a random per-browser ID from
`public/js/api.js`, not a fingerprint — plus client IP and a readable user-agent label),
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
`migrate()` and blocks the migration if it fails), `modules.ts` (the `requireModule()` gate
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
**Owned files:** `inventory-stock.ts`, routes: `inventory.routes.ts`,
`suppliers.routes.ts`, `customers.routes.ts`, `locations.routes.ts`,
`deliveries.routes.ts`, `orders.routes.ts`, `release-slips.routes.ts`.
UI: desktop Inventory → Releasing (`public/js/modules/inventory/releasing.js`),
mobile `so` view (`public/mobile/modules/inventory/so.js`).
**Owned data (releasing):** `orders.warehouse_accepted_by/_at`, `release_slips`,
`release_slip_items` (snapshot of lines + unit serials); photos are core `attachments`
kind `release` (ref = slip id).
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
**QA hold + evidence:** a final-pass `fail` with disposition `hold` puts the unit in status `hold`
(`qc_records.result = 'hold'`; counts as unresolved — the job order can't complete, its batch can't
close, cancel scraps it). `GET /api/qc/holds` lists held units; `POST /job-orders/:id/units/:unitId/
hold-decision {outcome: pass|rectify|fail, remarks, disposition?, repair?}` decides one — any QA
inspector or a new grantable `production.qa_review` (Production Manager by default), or
`inventory.adjust`. Holding pushes every QA inspector / `qa_review` holder; the decision pushes the
inspector who held it. Evidence: a failing / held result carries `evidence_ids` (`qc_unit` photos
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
(`inventory.view`). `production.receive` may file production issues (the mismatch report).
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
`hr-employee-numbering.ts`, `punch-photos.ts`, routes: `hr.routes.ts` (also owns the
`asset_issuances`/`asset_issuance_items` tables and the seeded "Asset Issuance Form"
doc_template, SCHEMA_VERSION 43; company-wide register `GET /api/hr/assets` with still-out /
people-who-left filters + CSV, UI `public/js/modules/hr/hr-assets.js` at HR → Employees →
Company Assets, tests `tests/hr-assets.test.ts`), `clock.routes.ts`, `field.routes.ts`,
`employee-profile.ts` + `employee-profile.routes.ts` (self-service profile, below).
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
`ph-payroll-report-data.ts`, `ph-statutory.ts`, `ph-vat-ewt.ts`, `payslip-pdf.ts`
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
**Rate history rule:** generate-payslips pays each day at `effectiveDailyRateOn(employee, day)` —
the latest `employee_rate_history` row on or before it. Rows are written by Edit Employee (the
Pay tab's "Effective date", shown only while the rate is being changed, default today) and, since
2026-10-04, by the employee CSV import (effective today, note "Employee import"). A ₱0 rate means
"not set yet": entering the first real rate fills every ₱0 row ahead of it (`fillUnsetRate`), and
the SCHEMA_VERSION 56 step repaired existing ones — before that, an employee created at ₱0 and
given a rate later kept paying ₱0 for every day before the edit's effective date.
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
**Finalization rule:** a payslip is final only when HR marks it Paid
(`POST /api/hr/payroll/:id/mark-paid`, the lock generate/edit/delete all refuse). The employee
list (`GET /api/me/payslips`) returns `finalized`, `finalized_at`, and a `download_url` only for
those; the PDF route re-checks ownership (own `employee_name`, 404 otherwise) and Paid status
(409) at download time and logs `payslip-download` to the activity log.
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
**Status:** working.

## modules/ai

**Responsibility:** the AI Assistant widget — tool-calling agent, analytics queries,
report/docx generation, FTS5 RAG over documents, HR-form proposals, sending mail.
**Owned files:** `ai-analytics.ts`, `ai-config.ts`, `ai-hr-forms.ts`, `ai-mail.ts`,
`ai-rag.ts`, `ai-reporting.ts`, `ai-tools.ts`, `rag.ts`, `reporting.ts` (generic
markdown/docx rendering, used only by `ai-reporting.ts` today), routes: `ai.routes.ts`.
**Dependencies:** `shared/`, `modules/inventory` (`ai-tools.ts` calls stock-mutation
functions directly), `core/` (the `visibilityClause` wart noted above).
**Offline (phase 4i):** `online`: the assistant, its key, history and usage stay on the cloud (D8); an
installed PC says it needs the internet. The search-index rebuild is per copy (no class).
**Status:** working.

## modules/email

**Responsibility:** the BYO-SMTP outbound mail tool and its route surface.
**Owned files:** routes: `mail.routes.ts` (the transport itself, `mailer.ts`, lives in
`shared/` since `modules/ai` and `modules/quickbooks` also send mail through it).
**Offline (phase 4i):** `online`: the mail server and its password are cloud-only (D8).
**Status:** working.

## modules/quickbooks

**Responsibility:** one-way push of orders to QuickBooks Online (per-tenant OAuth).
**Owned files:** `quickbooks.ts`, routes: `quickbooks.routes.ts`.
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
Second: Production Lead + Manager, `modules/manufacturing/job-orders.js` (Figma 66:14–66:650) —
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
