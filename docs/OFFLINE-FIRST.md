# Offline-first operation — design

**Status: planned.** Nothing in this document is implemented yet. It records the target design
(first drafted 2026-09-30, concerns resolved and business decisions taken the same day) so the
work can be placed module-by-module and pipeline-by-pipeline. Business decisions are marked
**✅ decided**. Technical choices that still need a spike before they are relied on are marked
**🔬 spike**.

### Decisions (2026-09-30)

| # | Decision | Section |
|---|---|---|
| D1 | A stock-out while recorded stock is short is **accepted and flagged**, never blocked | §7.1 |
| D2 | **Nothing is cloud-only.** Every screen works offline, and every installed PC holds a full copy | §7.5 |
| D3 | A site needs **at least 1** installed PC. Failover behavior follows how many it has | §7.6 |
| D4 | The CLAUDE.md stock/stage rule is **reworded** to let the site host confirm (applied when phase 1 starts) | §7.4 |

Catalog entries: `sync/` and `desktop/` in `docs/modules/catalog.md`. Pipelines: "Offline
operation & sync" and "Site host failover" in `docs/modules/pipelines.md`.

## 1. Goal

The same system has to work **both online and offline**:

- **Online (web):** the Railway-hosted app at `<slug>.app.afkcube.com`, as today.
- **Installed (desktop .exe):** a Windows app that carries its own copy of the company's data
  and keeps working when the internet is down. Installed copies on the same network keep each
  other up to date over the LAN. When the internet comes back, they sync with the cloud.

A company can use either one or both. An internet outage at the site must not stop warehouse,
production or time-keeping work. Phones (`/m`) keep working during an outage by talking to the
site host over the LAN.

## 2. Core idea: sync what people did, not rows (the git model)

Today a write changes rows in place (`UPDATE inventory_stock SET quantity = …`). If two copies
of the database each changed the same row while apart, copying one over the other would lose
the other's change. So we never copy rows as the source of truth. We sync **what people did**,
and let the authority decide the result.

### 2.1 Commands (the git commits)

Every write a person makes is recorded as a **command**: the API call they made
(`POST /api/inventory/items/42/adjust {change:-5, reason:"Released to JO-00042"}`), who made it,
on which device, and when. Commands are appended and never edited.

The app has 243 mutating route handlers, and each one already contains its module's
validation, permission checks and business rules. A command is **replayed through the same
handler** on the authority, so every rule re-runs against the authority's data without being
rewritten per module. This generalises what the mobile offline queue (`lib/queue.js` +
`shared/idempotency.ts`) already does for phones.

| Field | Purpose |
|---|---|
| `id` | ULID, globally unique, generated where the command was made |
| `node_id`, `node_seq` | which install made it + that node's own counter (gap detection) |
| `hlc` | hybrid logical clock timestamp, which orders commands even when PC clocks are wrong |
| `occurred_at` | when it happened on the device: the business time (punch time, movement time) |
| `actor_user_id`, `device_id` | who did it and on which device (same as the activity log) |
| `method`, `path`, `body` | the API call; files are referenced by content hash (§7.9) |
| `allocation_plan` | row IDs and document numbers the command was given where it was made (§7.2) |
| `sync_class` | `merge` / `physical` / `claim` / `online` (§7.1) |
| `app_version` | for replay compatibility (§7.10) |
| `idempotency_key` | the existing `Idempotency-Key` contract, so a replay is never applied twice |
| `state` | `local` → `host_confirmed` → `cloud_confirmed`, or `rejected` / `conflict` |
| `authority_seq` | the final global order, assigned when the authority accepts it |
| `unattributed` | anonymous-channel command: no actor, device, node, time or node-range ID (§7.5) |

### 2.2 Confirmed effects (what everyone applies)

When the authority replays a command, the handler's row changes are captured as a **SQLite
changeset** (`node:sqlite` `createSession()` / `applyChangeset()`, available on our Node 22.21).
That changeset, stamped with `authority_seq`, is the **confirmed effect**. Every other copy
applies confirmed effects in `authority_seq` order, so every copy ends in the same state.

### 2.3 Optimistic local run + rebase

A node doesn't wait for the authority. It runs the command locally at once, capturing its
changeset, so the person sees the result immediately. When confirmed effects arrive, it:

1. rolls back its own unconfirmed local changes by applying the inverse of their changesets.
   `node:sqlite` has no invert API, so `sync/` carries a small inverter over SQLite's documented
   changeset format (proven in §9),
2. applies the confirmed effects in order,
3. re-runs its still-pending commands on top.

This is `git pull --rebase`. Usually the re-run gives the same result. When it doesn't, the
command's badge says so (§2.4).

### 2.4 What people see

Every action shows how far it has gotten. This extends the existing rule "never show an
offline-queued action as server-confirmed":

- **Saved on this device.** Recorded locally and not yet seen by anyone else.
- **Confirmed on site.** The site host accepted it, and every device on the LAN sees it.
- **Synced.** The cloud accepted it, and it is final.
- **Needs attention.** It was rejected or flagged, with a reason and a link to the conflict inbox.

## 3. Topology

```
             ┌────────────────────────────┐
             │  Cloud (Railway tenant DB) │  final authority + archive
             └─────────────┬──────────────┘
                   WAN sync│(when internet is up)
        ┌──────────────────┴──────────────────┐
        │      Site host (elected node)       │  authority for its site's records
        └───┬──────────────┬──────────────┬───┘
       LAN  │              │              │
   ┌────────┴───┐  ┌───────┴────┐  ┌──────┴──────────┐
   │ Desktop    │  │ Desktop    │  │ Phones (PWA /m) │  use the site host on LAN,
   │ node (.exe)│  │ node (.exe)│  │                 │  the cloud otherwise
   └────────────┘  └────────────┘  └─────────────────┘
```

- **Node:** any installed desktop app. It runs the same Express server and SQLite code as the
  cloud in `DEPLOY_MODE=node`, holding a **full copy** of the tenant's data (D2), its command
  log and its unconfirmed local changes.
- **Site:** a physical place with its own LAN (e.g. main plant, branch warehouse). Each stock
  location, and each record that belongs to a location, has a **home site** (§7.1).
  Company-wide records (items, customers, users/roles, settings, payroll, accounting) have the
  company's **main site** as their home, so the main office can run payroll during an outage.
- **Site host:** the one node per site elected to be the authority for **its site's
  records** while the cloud is unreachable. It serves the LAN UI and `/m`, and relays commands
  and effects between the LAN and the cloud.
- **Cloud:** the final authority. It replays every command again against the combined data of
  all sites, and it alone runs external side effects (§7.8).

One codebase, two modes: `DEPLOY_MODE=cloud` (today's server, the default) and
`DEPLOY_MODE=node`. Mode-specific behavior lives in `sync/`, not in business modules.
Modules take part only by giving each mutating route a sync class (§7.1).

## 4. Site host election (the game-lobby model)

1. **Discovery.** Nodes announce themselves on the LAN (UDP broadcast / mDNS 🔬) with node ID,
   tenant, site, app version, `authority_seq` reached and a configured priority.
2. **Voters.** Each installed PC at a site is a **voting node**, unless an admin sets it as
   non-voting (e.g. a laptop that comes and goes). A site needs at least 1 (D3, §7.6).
3. **Election.** A candidate becomes host only with votes from a **majority of the site's
   voting nodes**, except at 1- and 2-PC sites (§7.6). Voters prefer the most caught-up node
   (then newest version, priority, node ID). Each election starts a new **term**.
4. **Lease + heartbeat.** The host renews a short lease. If followers miss heartbeats for the
   lease period, they hold a new election.
5. **Fencing.** Commands are accepted only under the current term. A returning former host
   sees a higher term, steps down, and hands its unconfirmed commands to the new host.
6. **Followers replicate continuously**, so any voter is ready to take over.

## 5. Desktop app

- **Shell:** Electron, which runs the existing Express + `node:sqlite` server in its Node
  runtime and shows `public/` in a window. ✅ Proven (§9): Electron 44.5 ships Node 24.21 /
  SQLite 3.53.4 with sessions, changesets and function overrides, and our full schema + seed
  builds under it unchanged. **Note:** that SQLite rejects double-quoted string literals
  (`WHERE x = "open"`), which our Node 22 accepts. None were found in `src/`, and a Node 24
  test-suite run is added to phase 1 to keep it that way.
- **Enrolment:** an admin signs the install in to the tenant once and assigns its site. The
  cloud issues a **node number** (§7.2) and the node pulls a full snapshot plus the effect
  stream. The platform console (`/_platform`) is the SaaS operator's, not the company's, and
  stays cloud-only.
- **Updates:** auto-update, never newer than the cloud (§7.10).
- **Serving the LAN:** the site host serves the desktop UI and `/m` over LAN HTTPS 🔬 (camera
  and service workers need a secure context).
- **Install checks:** Windows disk encryption (BitLocker/Device Encryption) **required**, the
  clock synced, and a non-admin Windows account for daily use (§7.5, §7.7).

## 6. Work plan

Each phase leaves the system shippable. Cloud-only companies are unaffected throughout,
because every route defaults to the `online` class until it is reviewed.

| Phase | Scope |
|---|---|
| **0. Spikes** | ✅ Electron + `node:sqlite` sessions on Windows; ✅ changeset capture/invert/apply rebase; ✅ `datetime('now')` override; ✅ node-range ID allocation (§9). Still open: LAN discovery; LAN HTTPS for `/m` |
| **1. Command foundation** ✅ built 2026-09-30 (§10) | `src/sync/`: command log, HLC, ULID, `DEPLOY_MODE`, per-route `syncClass()` (undeclared routes refused on a node), allocation plan (node-partitioned IDs via renumber-after-insert + provisional/replayed document numbers), SQL request clock + `now()`, side-effect suppression on nodes (email/push/broadcast), cloud effect stream, replay through the real routes, changeset rebase, node-local tables, unattributed commands. CLAUDE.md rule reworded (D4). No behavior change for DBs without a sync role. **Moved:** sensitive-field encryption and the Node 24 test run → phase 3 (need the DPAPI spike / the Electron dependency); site-number block leasing → phase 3 (needs a host); converting handlers' `new Date()` to `now()` → per route as it is classed (phases 2, 4) |
| **2. Inventory pilot** | Stock adjust/transfer/receipt routes classed. All stock writes already go through `applyStockChange` / `transferStock`. Negative-stock flagging (D1). Home site on `locations`, main site on the tenant |
| **3. Desktop app + site host** | Installer, enrolment, full snapshot, sync protocol node ↔ host ↔ cloud (HTTP transport for phase 1's in-process `acceptCommand` / `pullFor` / `applyConfirmed`), badges, conflict inbox (first cut), one fixed host per site, `claim` via the host, site number blocks, blob lane + multipart commands, sensitive-field encryption, Node 24 test run |
| **4. Remaining pipelines** | Class routes pipeline by pipeline: time clock → production run → sales order release → purchasing receipt → HR requests and records → anonymous reports → payroll → accounting/tax |
| **5. Host election + failover** | Voting nodes, election, lease, terms, fencing (§4) |
| **6. Hardening** | Conflict inbox with resolve actions, version shims, compaction of old commands/effects, sync health dashboard |

## 7. Concerns and resolutions

### 7.1 Events stop overwrites, not conflicts → sync classes + home sites

Most conflicts disappear because each **site host is the single authority for its site's
records**. Two people in the same building are serialized by the host, just as the cloud
serializes them today. Real conflicts only remain in two cases:

- **between sites** while the cloud is unreachable. This is prevented by **home sites**: stock
  at a location, and the SOs, JOs, releases and receipts of that location, can be decided only
  by their home site's authority. A move between sites is two commands: out at the source
  (in transit) and in at the destination.
- **on a node cut off from its site host.** This is limited by the sync class.

Every mutating route gets a **sync class**:

| Class | Meaning | While disconnected | Examples |
|---|---|---|---|
| `merge` | additive, no shared invariant | allowed anywhere | damage/problem report, QC result, note, attachment, request submitted, new master record |
| `physical` | records something that **physically happened** | allowed anywhere; **never rejected for state reasons**; an invariant it breaks is flagged, not refused | stock out, goods receipt, release slip, punch, unit progress |
| `claim` | exclusive decision on a record | needs the record's home authority (its site host or the cloud); blocked with "needs site connection" otherwise | approve SO against ATP, reserve a serialized unit, accept a JO kit, edit master data, finalize payroll, post a journal, change users/roles/settings |
| `online` | needs an outside service | blocked with "needs internet" | QuickBooks sync, sending email / SMS, AI assistant, SaaS plan/billing |

The `physical` rule matters because the system cannot refuse reality. If 5 units really left
the warehouse, rejecting the record makes the database lie. The authority accepts the command,
and the broken invariant (stock below zero, a unit already sold) goes to the **conflict inbox**
for a count or correction. Validation and permission failures are still rejected.

**✅ decided (D1):** a stock-out while the recorded stock is short is `physical`: accepted and
flagged, not blocked. Blocking it would stop the warehouse whenever the records are behind
reality.

Company-wide `claim`s (payroll, journals, users/roles, settings, master data) go to the main
site's host while the cloud is unreachable. Other sites need the cloud for them. Payroll
*computation* is a read and works on any node; *finalizing* (Paid / locking) is the `claim`.

### 7.2 IDs will collide → node-partitioned integer IDs + allocation plan

Row IDs stay `INTEGER` (no migration of existing data, no frontend changes). In node mode, a
new row gets `id = node_no × 2^37 + counter`:

- `node_no` 0 is the cloud, and **every existing row already fits** (all IDs < 2^37 ≈ 137 billion).
- The cloud assigns node numbers 1–65535 at enrolment. Every ID stays below 2^53, so it is still
  a safe JavaScript number.
- AUTOINCREMENT can't be trusted once any node exists, **in the cloud too**. It continues after
  the table's highest ID, which may belong to another node's range (confirmed in §9).
- ✅ **Renumber-after-insert** (proven in §9). The `db` export in `shared/db.ts` is already a
  Proxy, so its statements are wrapped: an `INSERT` into a replicated table runs normally, then
  any new rows (id above the pre-insert maximum) are renumbered into the allocator's range in the
  same transaction, and the returned `lastInsertRowid` is patched. This handles every INSERT
  shape in the code without parsing SQL: multi-line (161 INSERTs), `OR IGNORE` (8),
  `ON CONFLICT` upserts (13), multi-row / `INSERT…SELECT`. The 87 `lastInsertRowid` readers and
  Kysely work unchanged. The schema has no triggers, and the one virtual table (`doc_chunks`,
  FTS5) is a node-local derived index. The one `RETURNING` path (`qb.ts`) must be wrapped too.
- The IDs a command was given locally are recorded in its **allocation plan**. When the
  authority replays it, the same plan is consumed in the same insert order, so the row keeps
  the ID the device already showed and later commands referring to it stay valid.

**Document numbers** (`SO-00042`, `RS-00001`, `CR-00003`…) all come from
`nextSequence()` in `shared/db.ts`, so there is a single place to control them:

- The cloud **leases each site a block** of numbers per prefix (e.g. 200). The site host issues
  numbers from its block, and the format doesn't change.
- A node cut off from its site host shows a **provisional** number (`SO-P7-0001`) until the
  host confirms. Printing a final document (release slip, invoice) waits for confirmation.
- Numbers issued by a site are carried in the allocation plan. The cloud keeps them (after
  checking they belong to that site's block) instead of issuing new ones. Numbering stays
  unique, but may not be chronological across sites.
- BIR-regulated series (if we issue official invoices/ORs) stay `online` unless each site has
  its own registered series.

### 7.3 Most writes mutate state → replay the handlers, don't rewrite them

This is solved by the command model (§2). The 243 handlers stay as they are. What they need:

- **A request clock.** `occurred_at` is the business time. During replay, SQL
  `datetime('now')` (261 uses) / `date('now')` (22), and the handlers' `new Date()` (≈40 sites in
  routes), read the command's clock, not the server's. Implementation:
  - ✅ Proven (§9): an override of SQLite's `datetime`/`date`/`time`/`julianday` on each
    connection. It maps `'now'` to the command clock and delegates everything else to an
    un-overridden helper connection, and it works inside column `DEFAULT`s.
  - A request-scoped `now()` in `shared/` for the JS side.
  - `recorded_at` (the authority's own time) is kept separately for audit.
- **Deterministic handlers.** No random values or external calls inside a handler. Randomness
  comes from the allocation plan, and side effects go to the outbox (§7.8).
- **Balance-after columns** such as `inventory_transactions.balance_after` are recomputed when
  effects are applied in final order. They are derived values, not facts.

### 7.4 The "online-only transitions" project rule → reworded

The proposed CLAUDE.md wording:

> Final stock and stage transitions are accepted only by the current authority (the cloud, or
> the site's elected host for that site's records), and are atomic, auditable and idempotent.
> A device's optimistic local result is never shown as final.

**✅ decided (D4):** rewording approved. It goes into CLAUDE.md when phase 1 starts, not
before, because until then the current rule still describes the code.

### 7.5 Private data on local copies → full replicas, protected

**✅ decided (D2): nothing is cloud-only.** Every installed PC holds a full copy, so any
employee can sign in at any PC and every screen works offline. Payroll, government IDs, bank
details and confidential reports therefore sit on shop-floor PCs. The protections are:

1. **Permissions stay enforced by the app.** A node runs the same permission checks as the
   cloud, so a warehouse account still can't open payroll on a warehouse PC.
2. **The file is protected at rest.** Windows disk encryption is required at install (§5).
   **Sensitive fields** (government IDs, bank accounts, pay rates, confidential/anonymous report
   bodies and photos) are additionally encrypted in the replica with a tenant data key. On each
   node, that key is protected by Windows DPAPI (machine-bound), so a copied `.db` file is
   unreadable off that PC. 🔬 (`node:sqlite` has no whole-file encryption such as SQLCipher,
   hence field-level.)
3. **Node-local tables never replicate.** These are credentials rather than data screens, and
   nodes have no use for them because external calls run only on the cloud (§7.8):
   - session tokens (session *records* replicate; the tokens don't),
   - anonymous-report submission tickets,
   - integration secrets (SMTP password, QuickBooks tokens, AI keys).
4. **Lost or stolen PC:** an admin revokes the node from any other PC or the cloud. Its sync
   credentials stop working at once. Its sign-ins stop after the offline grace period (§7.7).
   Because of the field encryption, a copy of the disk alone doesn't expose sensitive fields.

**Anonymous reports keep their anonymity.** Today the report stores no reporter identity: no
user, IP, device or times (dates only). Its requests are kept out of the activity log and the
idempotency store. Replicating the report's contents doesn't change that, but the sync layer
must not add identity back. So anonymous-channel commands (`isAnonymousReportPath`) are
**unattributed**:
- no actor, device, node ID, node sequence, HLC or time. The date only is carried.
- The row ID and report number are assigned by the **site host**, not from the submitting node's
  ID range (which would reveal the PC).
- The node forwards them **after a random delay, mixed into a later batch**, so arrival order
  can't be matched against clock punches or logins.
- When the site host can't be reached, the reporter gets a provisional number that remains a
  permanent alias of the final one for follow-up lookups.
- The access code's randomness is kept in the command only as its hash.

### 7.6 Split brain → majority vote among voting nodes

**✅ decided (D3): a site needs at least 1 installed PC.** Behavior follows how many voting
PCs it has, and the enrolment screen explains the tradeoff:

| Voting PCs | Host | If the host PC dies during an internet outage |
|---|---|---|
| **1** | always that PC | phones and web on the LAN stop until it's back (same as a single server today) |
| **2** | the one set as **primary** at enrolment | the other PC keeps recording `merge` / `physical` work; `claim`s wait for the primary |
| **3+** | elected by **majority** (§4) | a new host is elected automatically; nothing waits |

With 3+ voters, a LAN split can produce at most one host, because only one side can have a
majority. The minority side keeps working with `merge` and `physical` commands (nothing it
records is lost) and blocks `claim`s until it rejoins. With 2, the fixed primary rule gives
the same guarantee. A site with no installed PC is a pure web site and uses the cloud.

### 7.7 Offline sign-in and permissions

- `users`, roles and permissions replicate to every node (password hashes included, tokens
  not), so a node can check a password (bcrypt) and permissions locally.
- **Offline grace:** a node that hasn't synced with its site host or the cloud for **7 days**
  (configurable) stops accepting sign-ins, so a stolen PC can't be used indefinitely.
- **Revocation:** deactivation, permission loss, password change and session revocation are
  commands that propagate like any other. At replay, the authority checks the actor's
  permission as it stands then:
  - If the node **had already received** the revocation when the command was made, the command
    is rejected.
  - If it **hadn't**, the person had no way to know, so the command is accepted and flagged
    for review.
- **Clock trust:** each sync measures the device's clock against the authority's. Punches and
  movements from a device drifting more than 2 minutes are flagged. Punches are online-only
  today (the mobile clock says "connect to record timekeeping"); they become `physical` with
  `occurred_at` from the device.

### 7.8 Background jobs and side effects → outbox, authority-only

- Emails, web push, QuickBooks pushes, AI calls and WebSocket broadcasts go through an
  **outbox** attached to the command, instead of being called inline.
  - A node's optimistic run **discards** its outbox.
  - The **cloud** executes external effects (email, push, QuickBooks, AI) when it accepts the
    command.
  - The **site host** executes LAN effects (live updates to LAN screens).
- Accounting auto-posts are ordinary database writes inside the handler, so they are simply
  part of the replay and its confirmed effect. They are not outbox items.
- Scheduled jobs in `server.ts` (housekeeping, task reminders, daily backups) run in cloud mode
  only. Nodes run only their own sync loop, a local snapshot of their replica, and compaction.

### 7.9 Photos and files → content-addressed blobs

Files under `UPLOAD_DIR` and BLOB columns (anonymous-report photos) move as **blobs keyed by
SHA-256**. A command references `blob:<hash>`. The device pushes the blob before the command;
hosts and the cloud fetch missing blobs lazily, and every node eventually holds all of them
(D2). Identical photos are stored once. Sensitive blobs (confidential/anonymous report photos)
are field-encrypted like their rows (§7.5).

### 7.10 Version skew

- **The cloud is always the newest version.** A node never auto-updates past the cloud's
  version, and a site host is elected newest-first.
- The cloud replays commands from the **last N minor versions** (N to be set in phase 6).
  Request schemas change **additively**. A breaking change ships a replay shim keyed by
  `app_version`.
- A node offline long enough to fall outside N sends its commands to the conflict inbox for
  re-entry. Nothing is lost silently.
- Confirmed effects are replicated only once the receiving node is on a version that has the
  tables they touch. Otherwise it updates first.

## 8. What already exists to build on

- `shared/idempotency.ts` + `public/mobile/lib/queue.js`: exactly-once replay of a queued HTTP
  operation, keyed by `Idempotency-Key`, scoped to the account that queued it. This is the
  command model in miniature.
- `shared/db.ts`: the `db` Proxy (hook point for ID allocation and the request clock), and
  `nextSequence()` (the single source of document numbers).
- `modules/inventory/inventory-stock.ts`: `applyStockChange` / `transferStock`, the only stock
  write path.
- `inventory_transactions`: an append-only stock ledger already.
- `shared/activity.ts` / `shared/device.ts`: per-mutation audit with user, IP and stable
  device ID.
- `shared/ws.ts`: the live channel, which can carry "new effects available" pings on the LAN.
- `shared/backup.ts`: `VACUUM INTO` snapshots, the basis for a new node's initial snapshot.
- `node:sqlite` sessions/changesets (`createSession`, `applyChangeset`): confirmed on our
  Node 22.21.

## 9. Phase-0 spike results (2026-09-30)

The scripts are in `docs/spikes/offline-first/` (runnable with plain `node`, see its README).
All passed on Node 22.21 (current runtime). The Electron check ran on Electron 44.5 / Node 24.21.

| Question | Result |
|---|---|
| Can a node roll back its optimistic work? | ✅ `node:sqlite` exposes `createSession` / `changeset` / `applyChangeset` but **no invert**. A ~40-line inverter over the documented format restores the exact prior state (ints, text, NULL, blob, real), and `invert(invert(c))` is byte-identical |
| Does rebase converge? | ✅ Stock 10, confirmed +10 from another site, pending −5 re-run → 15 on the node, byte-identical to the cloud replaying the same command |
| Are stale effects caught? | ✅ Applying an effect whose old values no longer match fires `onConflict` (type 1 = DATA), so nothing is silently overwritten |
| Can replay use the command's time? | ✅ Overriding `datetime`/`date` per connection makes `DEFAULT (datetime('now'))` and `date('now')` return the command clock; modifiers and non-`now` calls behave as built-in; with no clock set it falls back to real time |
| Can IDs be node-partitioned without schema changes? | ✅ Renumber-after-insert covers multi-line, multi-row, `INSERT…SELECT`, `OR IGNORE`, `ON CONFLICT DO UPDATE`; children written with the patched `lastInsertRowid` point at the final ID; the changeset carries only final IDs. Plain AUTOINCREMENT was shown to jump into another node's range |
| Does the server run inside Electron? | ✅ Our real `db.ts` builds all 100 tables + first-run seed under Electron's Node 24 exactly as under Node 22 (throwaway DB, live `db/data.db` untouched). Sessions, changesets and function overrides work there |
| Surprises | Electron's SQLite rejects double-quoted string literals (none found in `src/`, guarded by a Node 24 test run from phase 1). node:sqlite still prints an "experimental" warning on both runtimes |

**Still open for phase 0:** LAN discovery (UDP broadcast vs mDNS on Windows firewall defaults)
and LAN HTTPS for `/m` (phones need a trusted certificate for the camera and the service
worker; candidates are a per-tenant local CA installed on phones, or a public-DNS name such as
`<site>.<slug>.lan.afkcube.com` resolving to the host's LAN IP with a real certificate).

## 10. Phase 1 as built (2026-09-30)

Code: `src/sync/` (+ the seam `src/shared/sync-context.ts`). Tests: `tests/sync-primitives.test.ts`,
`tests/sync.test.ts` — the second runs a real cloud (the `default` tenant) and a real node (a
snapshot imported as tenant `plant-a`, node 7) in one process and syncs them in-process.

| Piece | Where | Notes |
|---|---|---|
| Hook seam | `shared/sync-context.ts` | `syncStore` context, `now()`, `sideEffectsSuppressed()`, `syncHooks` (`prepare`, `nextSequence`, `replayUser`). Shared code never imports `src/sync/` |
| Roles | `sync/node.ts` | `enableSync(conn, {role, nodeNo})` creates the node-local `sync_*` tables; a DB with no `sync_node` row is untouched. Cloud DBs get a continuous change recorder from the moment they're first seen |
| IDs | `sync/ids.ts` | renumber-after-insert into `node_no × 2^37 + n`; plan record/consume; explicit-`id` inserts kept; node write guard (`SyncBlockedError`, 503) |
| Numbers | `sync/sequences.ts` | node: `SO-P7-0001` provisional (planned); rebase: same number; cloud replay: real next number, or keeps a non-provisional planned one and moves the counter |
| Clock | `sync/clock.ts` | `datetime/date/time/julianday/unixepoch/strftime` override per sync connection |
| Capture | `sync/capture.ts` | `syncRequestMiddleware` (replay context · node guard · cloud flush) and `syncClass()`; one lock-serialized SQLite session per command |
| Replay | `sync/replay.ts` | loopback dispatch with a per-process secret; runs as the command's actor via `authUserById` (a disabled actor fails auth → rejected) |
| Authority | `sync/authority.ts` | `flushEffects`, `acceptCommand` (idempotent), `pullFor`, `snapshotForNode` |
| Rebase | `sync/rebase.ts` | undo pending → apply effects → verdicts (one transaction, strict: any conflict ⇒ `SyncDivergenceError`, nothing applied) → re-run pending; a failed re-run is undone and marked `conflict` |

**Routes classed so far:** `POST /api/inventory/:id/adjust` (`physical`) — the pilot vehicle.
Until phase 2 it still refuses a stock-out beyond recorded stock (D1's accept-and-flag is phase 2).

**Known limits (tracked for later phases):**
- A node's writes outside a request (background jobs) are not captured. Nodes should run none that
  touch replicated tables (phase 3 checks this at startup).
- Schema migrations run independently on the cloud and on each node; the cloud's migration writes
  also enter its effect stream. Version-skew handling is phase 6.
- Only JSON request bodies can be commands. Multipart routes (photos) need the blob lane (phase 3).
- The node guard covers mutating methods only. A GET that writes a replicated table on a node would
  be swept into whichever command is being captured at that moment. Phase 3 adds a check that fails
  any such GET in node mode.
- Replays write the authority's own activity-log row with the original device ID; the IP is
  loopback.
- Anonymous-report numbers are `MAX(id) + 1` (`core/confidential-reports.ts`). This must move to
  `nextSequence()` before that route is classed (phase 4), because node-range ids would make them jump.

