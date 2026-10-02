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
| D5 | Phones trust the site host through a **company certificate installed once per phone** (a per-tenant local CA), so the LAN works with no internet at all | §5 |
| D6 | The cloud keeps a site host's decision on its own site's records by **re-running it with clash-checks relaxed and flagged** (option B — like D1), not by copying the host's result; permissions and other checks still apply | §15–16 |
| D7 | The desktop installer ships **per-user (no admin prompt), signed with a free self-signed company certificate** that each of the company's PCs trusts once; installed by copying, not downloading. **⚠ TODO before installing at customers:** get a real code-signing certificate (or publish through the Microsoft Store) — otherwise Windows shows "unknown publisher" / SmartScreen warnings on their PCs. See §17 | §17 |
| D8 | **Cloud-only = credentials and online-only features**, nothing else (2026-10-01, D2 reaffirmed): secrets, and AI / email / QuickBooks / web-push settings and tables, never reach an installed PC. All business data — payroll, government IDs, bank details, confidential reports included — does, protected by app permissions, disk encryption and the PC's DPAPI-protected credentials (§7.5, §19) | §7.5 |

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
- **Serving the LAN:** the site host serves the desktop UI and `/m` over LAN HTTPS (camera and
  service workers need a secure context). ✅ **decided (D5):** each tenant gets its own local
  certificate authority. The host's certificate is issued by it, and each phone installs the CA
  certificate once (a guided page on the host; iPhones also need "full trust" switched on). New
  or reset phones repeat the step. No internet is ever needed.
- **Install checks:** Windows disk encryption (BitLocker/Device Encryption) **required**, the
  clock synced, and a non-admin Windows account for daily use (§7.5, §7.7).

## 6. Work plan

Each phase leaves the system shippable. Cloud-only companies are unaffected throughout,
because every route defaults to the `online` class until it is reviewed.

| Phase | Scope |
|---|---|
| **0. Spikes** | ✅ Electron + `node:sqlite` sessions on Windows; ✅ changeset capture/invert/apply rebase; ✅ `datetime('now')` override; ✅ node-range ID allocation (§9). Still open: LAN discovery; LAN HTTPS for `/m` |
| **1. Command foundation** ✅ built 2026-09-30 (§10) | `src/sync/`: command log, HLC, ULID, `DEPLOY_MODE`, per-route `syncClass()` (undeclared routes refused on a node), allocation plan (node-partitioned IDs via renumber-after-insert + provisional/replayed document numbers), SQL request clock + `now()`, side-effect suppression on nodes (email/push/broadcast), cloud effect stream, replay through the real routes, changeset rebase, node-local tables, unattributed commands. CLAUDE.md rule reworded (D4). No behavior change for DBs without a sync role. **Moved:** sensitive-field encryption and the Node 24 test run → phase 3 (need the DPAPI spike / the Electron dependency); site-number block leasing → phase 3 (needs a host); converting handlers' `new Date()` to `now()` → per route as it is classed (phases 2, 4) |
| **2. Inventory** ✅ built 2026-09-30 (§11) | Every inventory-module route classed (items, stock, locations, suppliers, customers). D1: a stock-out beyond recorded stock is accepted inside a synced command and opens a `stock_discrepancies` row (list + resolve API); direct cloud requests keep refusing it. Rebase applies changesets with foreign-key actions off. **Moved:** home sites → phase 3 (they only matter once site hosts decide claims); orders / deliveries / release slips → phase 4 (sales-release pipeline) |
| **3. Desktop app + site host** (sub-phases 3a–3f below) | Home site on `locations` and main site on the tenant, installer, enrolment, full snapshot, sync protocol node ↔ host ↔ cloud (HTTP transport for phase 1's in-process `acceptCommand` / `pullFor` / `applyConfirmed`), badges, conflict inbox (first cut), one fixed host per site, `claim` via the host, site number blocks, blob lane + multipart commands, sensitive-field encryption, Node 24 test run |
| **4. Remaining pipelines** | Class routes pipeline by pipeline: time clock (4a ✅) → production run (4b ✅) → sales order release (4c ✅, §22) → purchasing receipt (4d ✅, §23) → HR requests and records (4e ✅, §24) → anonymous reports (4f ✅, §25) → payroll (4g ✅, §26) → accounting/tax (4h ✅, §27) |
| **5. Host election + failover** | **5a ✅ built 2026-10-02 (§30):** sites keep their number across hosts, terms with the cloud as referee, every site PC mirrors its host (commands it holds, the site's PCs, the cloud's address, the site's certificate authority), an admin's take-over, a returning host steps down, PCs find and follow a new host, full re-sync. **5b:** automatic election for sites with 3+ voting PCs — lease, heartbeat, votes (§4) |
| **6. Hardening** | Conflict inbox with resolve actions, version shims, compaction of old commands/effects, sync health dashboard |
| **7. Android app** (planned, §29) | An installable APK of the phone app: works with no connection at all (cached work lists + its own command queue), finds the site host on the LAN by itself, trusts the site's certificate without the per-phone install, and follows the host through a failover |

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
- The row ID and report number are assigned by the **cloud**, not from the submitting node's
  ID range (which would reveal the PC). *(As built, §25: the cloud, not the site host, because a
  host's number block would reveal the site.)*
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

**Routes classed in phase 1:** `POST /api/inventory/:id/adjust` (`physical`) — the pilot vehicle.
(Phase 2 classed the rest of inventory and added D1's accept-and-flag, §11.)

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

## 11. Phase 2 as built (2026-09-30)

Tests: `tests/sync-inventory.test.ts` (with `tests/sync-helpers.ts`, a cloud + node pair).

| Route | Class | Offline behaviour |
|---|---|---|
| `POST /api/inventory/:id/adjust`, `/damage`, `/transfer` | `physical` | Works. Beyond recorded stock (D1): accepted, location goes below zero, `stock_discrepancies` row opened (`discrepancy_id` in the adjust response) |
| `POST /api/inventory`, `/api/locations`, `/api/suppliers`, `/api/customers` | `merge` | Works. New rows keep the node-range ids; later offline commands may refer to them |
| edits, deletes, CSV imports, item form config, reorder-PO, set default location, resolve a discrepancy | `claim` | Refused ("needs a connection to the site host") until phase 3 |
| item photo upload / delete | `online` | Refused before the file is written (blob lane is phase 3) |

**D1 as built.** `overdrawAllowed()` (`modules/inventory/inventory-stock.ts`) is true only inside
a synced command (`inSyncedCommand()`): the node's optimistic run, its rebase, and the
authority's replay. A person using the cloud directly still gets "Not enough stock". The
discrepancy is opened by `applyStockChange` whenever a synced stock-out leaves a location below
zero, so the authority's replay decides the final flag. A node that had enough stock locally still
gets flagged after sync if the cloud's balance went short. `GET /api/inventory/discrepancies`
lists them (`inventory.view`); `POST …/:id/resolve {note}` closes one (`inventory.adjust`, moves no
stock: correct the count with a normal adjustment first). No screen yet: it becomes part of the
phase-3 conflict inbox.

**Bug found and fixed.** Undoing a command whose rows are linked by `ON DELETE SET NULL` /
`CASCADE` (a discrepancy → its stock transaction) re-fired the action and made the undo conflict.
A changeset already contains every cascaded row change, so `sync/rebase.ts` now applies changesets
with foreign-key enforcement off, around the synchronous transaction. The regression test is in
`tests/sync-primitives.test.ts`.

**Known limit.** A duplicate SKU made offline is `merge`, and is rejected (409) at sync if the cloud
already has that SKU; the node's copy is undone. That is correct, but the person only learns of it
through the command's `rejected` state until the phase-3 badges exist.

## 12. Phase 3 plan (2026-09-30)

| Sub-phase | Scope |
|---|---|
| **3a. Transport + enrolment** ✅ built 2026-09-30 (§13) | Cloud endpoints under `/api/sync` (enrol a PC, filtered snapshot, push commands, pull effects) authenticated by a per-node token. A node client that enrols and syncs over HTTP, a background sync loop when `DEPLOY_MODE=node`, and `npm run sync:enrol`. Secrets never leave the cloud, per row and in the snapshot |
| **3b. Badges + needs-attention inbox** ✅ desktop built 2026-10-01 (§14) | `GET /api/sync/status` on a node. Saved on this device / Synced / Needs attention on desktop and mobile. An inbox for rejected commands and stock discrepancies |
| **3c-i. Site host relay** ✅ built 2026-10-01 (§15) | One fixed host per site: LAN PCs enrol through it and sync with it; it accepts their commands in one site order ("confirmed on site"), relays them to the cloud, follows the cloud's corrections, and streams everything to its LAN |
| **3c-ii. Site decisions** ✅ built 2026-10-01 (§16) | Home sites (`location_sites`) + main site (`sync_main_host`); `claim` decided on the site's host, or a LAN PC with a fresh link to it; the cloud keeps a site's decision on its own records by re-running it with marked clash-checks relaxed and flagged (D6). **Moved:** site number blocks → phase 4 (no offline-capable route issues document numbers yet); GET-write check → phase 6 |
| **3d. Desktop app + LAN HTTPS** ✅ built 2026-10-01 (§17) | Electron shell (+ `npm run test:node24`), per-tenant local CA (D5), phone certificate install page, phones on the host |
| **3e. Blob lane** ✅ built 2026-10-01 (§18) | Content-addressed files; multipart routes (photos) become commands |
| **3f. PC credentials + disk check** ✅ built 2026-10-01 (§19) | The PC's own credentials sealed with a DPAPI-held secret; setup warns unless disk encryption is confirmed. Field-level encryption of business data: not built (D8, §19) |

## 13. Phase 3a as built (2026-09-30)

Code: `src/sync/transport.ts` (cloud endpoints), `src/sync/client.ts` (PC side),
`scripts/sync-enrol.ts` (`npm run sync:enrol`), loop started in `server.ts` when
`DEPLOY_MODE=node`. Tests: `tests/sync-transport.test.ts` (real HTTP listener).

**Enrolling a PC.** On the PC, `SYNC_ENROL_PASSWORD=… npm run sync:enrol -- --cloud <workspace URL>
--user <admin> --name "<PC name>"`, then start it with `DEPLOY_MODE=node`. It signs in as an admin
with `users.manage`, registers the PC (`POST /api/sync/nodes` → node number + token, shown once),
downloads the workspace into `DB_PATH`, and adopts it (node role + `sync_remote`). **The first
enrolment switches the cloud workspace into sync mode.** Node numbers are never reused.

**What a PC never receives.** The snapshot is the workspace as of the latest effect, with the
node-local tables emptied (sessions, idempotency keys, push subscriptions, anonymous-report tickets,
activity log, sync bookkeeping, the AI search index) and the secret `settings` rows deleted
(`_secret_key`, `mail_smtp_pass`, `qbo_tokens`, `ai_api_key`). It is then `VACUUM`ed with
`secure_delete` on, so the removed rows aren't left in free pages. The test checks the file's raw
bytes. After enrolment the same secrets are filtered **per row** out of every changeset
(`isReplicated()` + row-level `filterChangeset`), so a later change to them never streams out.

**Transport.** `POST /api/sync/commands` (batches of 100) and `GET /api/sync/pull?since=N`
(changesets base64 in JSON), both authenticated by `X-Sync-Node-Token`. A PC may submit only its
own commands (or unattributed ones); a forged node number is rejected with 403. Revoking a PC
(`POST /api/sync/nodes/:no/revoke`) stops its token at once.

**Offline.** An unreachable cloud raises `SyncOfflineError`: work stays pending and usable
locally, and the next round sends it. The loop logs only changes of state (connected / offline).
A divergence stops the loop. The PC must then be re-enrolled; the re-sync tool is phase 6.

**Trust model (known).** The cloud replays a command as the actor the PC names. An enrolled PC is
therefore trusted to vouch for who signed in on it, like a time-clock kiosk. The controls are
revoking the PC, the actor having to be active with the permission at replay, and the audit rows.
Per-user signing of commands can be added later if needed.

## 14. Phase 3b as built (2026-10-01)

**Marking.** Every response from an action recorded on a PC carries `X-Sync-State: local` and
`X-Sync-Command: <id>` (`sync/capture.ts`). The desktop API client (`public/js/api.js`) turns that
into a `vds:sync-local` event. `public/js/lib/sync-status.js` then shows a toast — "Saved on this
PC — it is not final until it syncs with the cloud" — on top of whatever the page itself says. So
the CLAUDE.md rule "a device's optimistic local result is never shown as final" holds for every
screen without each page having to know about sync.

**Status pill** (top bar, installed PCs only): Synced / Syncing · N waiting / Connecting… /
Offline · N saved on this PC, plus "· N need attention" (rejected actions + open stock
discrepancies). It polls `GET /api/sync/status` every 15 s and on every local save. On the cloud and
on normal installs the endpoint reports mode `cloud` / `off`, the pill stays hidden and polling stops.

**Sync page** (`#/sync`, `public/js/modules/core/sync.js`). On a PC: the connection and last sync,
a **Sync now** button (`POST /api/sync/now`), **Needs attention** (actions the cloud rejected,
with its reason, plus a link to open stock discrepancies) and **Waiting to sync**, each with
readable labels ("Stock out 3 — Truck 2"). People see their own actions; `users.manage` sees
everyone's on that PC; anonymous-channel actions are never listed. Dismissing hides a rejected
action once dealt with (`POST /api/sync/activity/:id/dismiss`, own only unless `users.manage`). On
the cloud (Admin → Installed PCs, `users.manage`): the enrolled PCs with last seen / revoke, and the
enrol command.

**Stock Discrepancies page** (Inventory → Stock Movements → Discrepancies,
`public/js/modules/inventory/stock-discrepancies.js`): open / resolved / all, with item, location,
amount, balance then and now, reason, who and when; **Resolve** asks what was found or done. On a
PC, resolving is refused until site hosts exist (`claim`).

**Not built here:** the mobile app. Phones reach a PC only once the site host exists (3c/3d), and
the project's mobile rules need a Figma design for the new states first. **Design dependency:**
mobile sync pill, "saved on this phone/PC" toast and inbox screens in the V2 Figma file.

Tests: `tests/sync-status.test.ts` (marking, status, per-person scope, attention + dismiss,
discrepancy count), `tests/frontend-sync-status.test.ts` (api.js event → toast, pill wording,
hidden on the cloud, labels), `tests/sync-transport.test.ts` (Sync now online / unreachable, live
connection state).

## 15. Phase 3c-i as built (2026-10-01): the site host relays for its LAN

Code: `src/sync/node.ts` (`isHost`, `isAuthority`), `authority.ts` (cloud *or* host),
`rebase.ts` (`host_confirmed`), `transport.ts` (`/whoami`, `/members`, host/LAN enrolment),
`client.ts` (`registerNode`, `downloadSnapshot`, `hostNodeNo`, members refresh), `status.ts`,
`scripts/sync-enrol.ts` (`--as-host`, `--host URL`). Tests: `tests/sync-site.test.ts` — cloud, host
and LAN PC on one real HTTP server.

**Roles.** A node may be its site's **host** (`sync_node.is_host`). Towards the cloud it is an
ordinary node. Towards the PCs on its LAN it is an **authority**, running the same endpoints and code
as the cloud (`isAuthority`). A LAN PC's `sync_remote` points at the host, not the cloud.

**Enrolment.** The host: `npm run sync:enrol -- … --as-host`. A LAN PC: `… --host <host URL>`. It
asks the host who it is (`GET /api/sync/whoami`), registers at the cloud as that host's PC
(`host_node_no`), then downloads its starting copy **from the host**. The host lets it in once it
has refreshed its list of LAN PCs from the cloud (`GET /api/sync/members`, each round; the script
waits up to 5 minutes). Token hashes travel; tokens never do. After that the host authenticates
its LAN PCs with no internet.

**How the site stays consistent.** The host records *every* change to its database (the same
continuous recorder the cloud has; checked that sessions also capture changes applied from a
changeset). That stream — the host's own work, the LAN commands it accepts, and the whole rebase
when it syncs with the cloud — is what LAN PCs pull, so they mirror the host exactly.
- A LAN PC's command accepted by the host becomes one of the host's own pending commands (kept with
  its changes, in **site order** = insertion order, since PCs' sequence counters differ). The LAN PC
  gets the verdict `host_confirmed`; it stops re-running it, and the pill says "On site · N not in the
  cloud yet".
- The host forwards its own and its LAN PCs' commands to the cloud. The cloud lets a host submit
  its LAN PCs' commands, and returns verdicts for all of them. When the cloud rejects one the host
  had accepted, the host's rebase undoes it, and that undo reaches the LAN PC through the same stream.
  The test covers a clerk disabled on the cloud while their offline work waited.
- A host's replay never sends email, push or live broadcasts (`suppressEffects`); only the cloud's
  does. It also never issues real document numbers: a LAN PC's provisional number stays provisional
  until the cloud.
- The pull response from a host says whether the host can reach the cloud (`upstream`). The LAN PC's
  status shows it.

**Bug fixed on the way.** Unattributed (anonymous-channel) commands carry no node number, so their
verdicts could never be returned. The PC would have re-run them at every rebase and duplicated them.
A PC now asks for those verdicts by command id (`/pull?ids=`), which reveals nothing it doesn't
already know.

**What 3c-i does *not* do yet.**
- The cloud still re-checks everything and has the final word. Host acceptance means "confirmed on
  site", which matters for the LAN while the internet is down, but it isn't final.
- `claim`s are still refused on every PC, the host included.
- There is no host failover (phase 5). With the host down, LAN PCs keep recording locally and sync
  when it returns.
- Phones still use the cloud (3d).

**3c-ii design questions (to settle before building).** D4 makes the host final *for its site's
records*. That needs:
1. **Home sites.** Which site owns each location, and through it each SO/JO/receipt. Company-wide
   records belong to the main site.
2. **Cloud deference.** When the host forwards a `claim` it accepted on a record its site owns, the
   cloud must keep the host's decision even if its own re-check would now fail. For example, the
   host approved an order against stock that another branch took in the meantime. The cloud then
   applies it and flags the clash (like a stock discrepancy) instead of rejecting it. The open part
   is *how*. One option is to apply the host's recorded effect with conflict handling. The other is
   to replay with business checks relaxed for that command, the way D1 relaxes stock checks.
3. **Number blocks** leased from the cloud to each site, so a host issues final numbers offline.
4. **A guard for GET requests that write** on nodes (§10 known limit).

## 16. Phase 3c-ii as built (2026-10-01): site decisions

Code: `src/sync/sites.ts` (homes, `deciderOf`, `siteOfThisPc`, `siteOfNode`, `recordSiteClash`,
`/api/sync/sites`, `/api/sync/clashes`), `capture.ts` (`claim` rules; `siteFinal` on the cloud's
replay), `shared/sync-context.ts` (`siteDecisionStands()`). Tables (replicated, `createSchema`):
`location_sites`, `site_decision_clashes`. UI: Admin → Installed PCs → **Sites** and **Site
decision clashes**. Tests: `tests/sync-site-decisions.test.ts` (with `setupSiteTrio` in
`tests/sync-helpers.ts`).

**Homes.** A location belongs to the site host it is assigned to. Everything that isn't a
location's record (items, suppliers, customers, settings, imports) is company-wide and belongs to
the **main site**. With no main site set, company-wide decisions need the internet. A route
declares its home with `syncClass('claim', { home: req => … })`; the default is company-wide. So
far: a location's edit/delete belongs to that location's site, and a discrepancy's resolution to
its location's site.

**Who may decide offline.** The site host may decide its own records. A LAN PC may too, but only if
it reached its host within the last 2 minutes; the host then replays it and its verdict is the
site's. A PC syncing with the cloud directly belongs to no site and decides nothing offline. **A
single-PC site should therefore enrol its PC as a host** (D3: one PC = always the host); the Sites
panel's setup text says so. Records of another site are refused ("belongs to another site").

**The cloud keeps it (D6, option B).** When the cloud replays a `claim` from a site on a record that
site owns, `siteDecisionStands()` is true for that run. A route lets *its marked clash-checks* pass and
records a `site_decision_clashes` row instead of refusing. Permissions, validation and every unmarked
check still apply. Marked so far: resolving a stock discrepancy that was already resolved elsewhere
(the first resolution is kept; the site's note goes into the clash). Phase 4 marks the clash-checks of
each approval-type route as its module goes offline: for example a sales-order approval whose stock was
taken by another branch.

**Also:** a site host now forwards to the cloud the row ids and numbers *it actually allocated* when
replaying a LAN PC's command (`effective` plan), so the cloud reproduces the host's rows instead of the
PC's guesses.

## 17. Phase 3d as built (2026-10-01): the installable app

**Shell** (`electron/`): `main.cjs` starts the real server, `server.ts`, as a child on Electron's
own Node: `ELECTRON_RUN_AS_NODE`, TypeScript through tsx, `DEPLOY_MODE=node`. It shows the server in
a window. Data lives in the per-user app-data folder (`%APPDATA%\Verdesakay\workspace`: database,
uploads, backups, `tls/`, logs). No admin rights are needed anywhere (D7).
- **First start** opens `setup.html`, which runs `scripts/sync-enrol.ts`:
  - **"The site's main PC"** enrols with `--as-host`. This is also the choice for a single-PC site.
  - **"Another PC at a site"** first downloads the main PC's site certificate over plain HTTP and shows
    its fingerprint. Once the person confirms it matches, the certificate is pinned
    (`host-ca.crt` → `NODE_EXTRA_CA_CERTS`), and the PC enrols with `--host https://<main PC>:3000`.
- `--smoke` boots the server on a scratch folder and exits once it answers. That was verified on the
  source tree *and* on the packaged `Verdesakay.exe`.

**How an installed PC serves** (`server.ts`, `DEPLOY_MODE=node`):
- **A site host** serves HTTPS on `0.0.0.0:3000` with its site certificate, for its LAN PCs and phones.
  It also serves plain HTTP on `:3001` for the **phone-setup page** (`src/desktop/phone-setup.ts`:
  Android / iPhone steps, the certificate, its fingerprint). Everything else on `:3001` redirects to
  HTTPS. Its own window trusts its certificate, on localhost only.
- **Any other installed PC** serves only itself, over HTTP on `127.0.0.1:3000`, which browsers treat as
  a secure origin.

**Site certificate (D5)** (`src/desktop/lan-tls.ts`, node-forge): each host creates its own certificate
authority once (10 years; its key never leaves that PC). It issues the server certificate for
`localhost`, its hostname, `127.0.0.1` and its LAN IPv4 addresses, valid 397 days (iPhones refuse more
than 825). The certificate is re-issued at start when the addresses change or it is within 30 days of
expiry. Phones keep trusting the authority, not the certificate.
**Change from the plan:** this is one authority **per site host**, not per tenant. A host must issue
certificates for its own (DHCP) addresses with no internet, so the authority lives on it. A phone
that works at two sites installs both sites' certificates.

**Installer:** `npm run desktop:build` (electron-builder → `dist-desktop/Verdesakay Setup <version>.exe`,
about 121 MB; one-click NSIS, per user, `asar` off so the child process can read the app's files).
`npm run desktop:cert` makes the free self-signed signing certificate; `scripts/desktop-trust.ps1`
makes a PC trust it. The build signs when `CSC_LINK` / `CSC_KEY_PASSWORD` are set. **⚠ D7 TODO:** a
real code-signing certificate (or the Microsoft Store) before installing at customers. The first build
is unsigned.

**Node 24:** `npm run test:node24` runs the whole test suite on the desktop app's runtime.

**Dev note:** editors built on Electron (VS Code) set `ELECTRON_RUN_AS_NODE` in their terminals, which
makes `electron` start as plain Node. `npm run desktop` removes it.

**Open when Windows starts** (`electron/autostart.cjs`): a checkbox on the Sync page, shown only
inside the desktop app (`window.desktopApp` from `preload.cjs`). It uses Windows' per-user startup
list, so no admin rights are needed. It is **on by default for the site's main PC** (its LAN depends
on it running) and off for other PCs. A start by Windows passes `--autostart` and opens the window
minimized.

### Desktop to-do (before rollout to customers)
- [ ] **Real code-signing certificate** (or Microsoft Store), D7. Until then, Windows warns
      "unknown publisher" on PCs that haven't trusted the company certificate.
- [ ] **App icon**: the build uses Electron's default icon (`build.win.icon` in `package.json`, plus
      the window icon in `electron/main.cjs`).
- [~] **Downloadable installer.** Two parts:
      - Built: `.github/workflows/desktop-release.yml` builds on a `desktop-v*` tag (or by hand) and
        attaches the installer to a **draft** GitHub Release. A private repo means only collaborators can
        download it, and nothing is published until someone publishes the draft.
      - Built as **work in progress**: Admin → Installed PCs → "Download the desktop app"
        (`GET /api/desktop/installer[/info]`, admin-only, `src/desktop/desktop.routes.ts`). It shows
        "coming soon" until an installer is placed in `DESKTOP_INSTALLER_DIR` on the server.
      - Not done: publishing. Per the user, nothing is uploaded until the app is finished.
- [ ] **Auto-update** (needs the release feed above; until then, run a newer installer over the old
      one: data is kept).
- [ ] **Mobile sync UI**: design dependency (Figma), §14.
- [x] Photos offline (3e, §18). - [x] PC credentials sealed with DPAPI + disk-encryption check (3f, §19).

## 18. Phase 3e as built (2026-10-01): files offline

Code: `src/sync/files.ts`; wired into `capture.ts` (command body), `replay.ts` (multipart replay),
`authority.ts` / `capture.ts` (immediate indexing), `transport.ts` (routes), `client.ts` (push blobs,
pull files). Node-local tables: `sync_files`, `sync_blobs`, `sync_node.last_file_seq`. Tests:
`tests/sync-files.test.ts` (site trio).

**Lane 1: a command carries its uploads.** A route opts in by wrapping its multer middleware in
`syncUpload()`. Inside a command:
- each uploaded file is copied into the copy's content-addressed blob store (`<uploads>/.sync-blobs/<sha256>`);
- the file is renamed after the command (`<prefix>-<commandId>-<n><ext>`), so the row stores the same
  name on every copy;
- the body records `{ __multipart: 1, fields, files: [{ field, name, type, hash }] }`.

Before pushing commands, a PC sends their blobs (`PUT /api/sync/blobs/:hash`, checked against the hash;
remembered in `sync_blobs`). The authority's replay rebuilds the multipart request from its own blob
store. A host passes its LAN PCs' blobs on to the cloud the same way. Outside a command, `syncUpload` is
plain multer: a direct upload to the cloud is unchanged.

**Lane 2: files made anywhere reach every copy.** An authority keeps a numbered list of the files in its
uploads folder (`sync_files`). The list comes from rescanning the folder (top level plus `kiosk-punches/`),
at most every 5 s, and immediately when a request or replayed command uploaded something. Every feature's
files are therefore covered, including ones from before sync existed, without changing their routes. After
each round a PC fetches what it lacks (`GET /api/sync/files?since=N`, `GET /api/sync/files/:seq`; paths are
confined to the uploads folder). A host lists what it fetched, for its LAN PCs. Deleted files are not
propagated: other copies keep an orphan file, which is harmless.

**Routes using lane 1 so far:** item photo upload and delete. They are now `claim` (company-wide master
data, so decided offline at the main site; they were `online` before). Release / delivery / QC evidence
photos join as their pipelines go offline in phase 4. Photos stored *inside* the database (anonymous-report
photos) already travel with the row.

## 19. Phase 3f as built (2026-10-01): an installed PC's credentials at rest

**What changed from the plan.** §7.5 planned field-level encryption of sensitive *business data* on PCs.
On 2026-10-01 the user narrowed what must be kept off PCs to **credentials and online-only features**
(decision D8; those are cloud-only, §7.5 / phase 3e commit). The business data itself stays on PCs (D2).
Field-level encryption of it would have to be done on the cloud as well, because sync compares exact
values between copies, and it would touch every HR / payroll / report feature. It is **not built**. The
protections for that data are app permissions, disk encryption (checked at setup) and the measures below.

**The PC's own secret** (`src/desktop/pc-secret.ts`, `electron/main.cjs`). The desktop shell creates a
random secret once, stores it **only DPAPI-encrypted** for the Windows user (`safeStorage` →
`pc-secret.bin`), and hands it to the server process as `VDS_PC_SECRET`. With it:
- the sync token in `sync_remote` is sealed (AES-256-GCM, `pc1:…`);
- a site host's certificate private keys are written as encrypted PKCS#8 (keys written earlier are
  re-encrypted on the next start).

A copied database or `tls/` folder is useless on another PC or Windows account. Opening a sealed token
without the secret fails loudly ("start it from the Verdesakay desktop app"); it is not mistaken for "not
enrolled". Without the shell (a developer running the server), values stay as before. **Consequence:**
re-installing Windows or switching the Windows user loses the secret, so that PC must be enrolled again.

**Disk-encryption check** (`electron/disk.cjs`). The setup screen asks Windows for the BitLocker /
Device Encryption state of the drive holding the data (no admin rights needed). Unless it is confirmed
**on**, the screen explains the risk and asks the person to tick "I understand" before continuing. This
includes "couldn't confirm", which is what Windows Home without active Device Encryption reports (as on the
dev PC).

Tests: `tests/desktop-pc-secret.test.ts` (seal/open, wrong or missing secret, sealed sync token, encrypted
TLS keys with a real handshake, upgrade of earlier plain keys, the BitLocker mapping). Smoke: the shell
with real DPAPI (`pc-secret.bin` holds only ciphertext).

## 20. Phase 4a as built (2026-10-01): the time clock offline

**Classes.**

| Route | Class | Offline behaviour |
|---|---|---|
| `POST /api/hr/clock/kiosk-punch`, `/correct`, `POST /api/hr/clock/punch` (phone), `POST /api/hr/field/kiosk-punch`, punch photos (`POST …/photo/:punchId`) | `physical` | Always work offline: a punch records something that happened |
| kiosk approval / revoke, kiosk lock, office location lock, punch import | `claim` | Company-wide: decided offline at the main site |

**A punch keeps its own time.** All time logic in `clock.ts` uses `now()`: the QR code's window, the
local date and time, the 45-second repeat guard, and the hours so far. That is the real time, or the
time the punch happened while it is recorded or replayed. A punch made at 07:58 with the internet down
is stored as 07:58 on every copy, and its kiosk code is checked against the window it was scanned in,
not the window it synced in. The SQL side (`datetime('now','localtime')`) was already on the
command's clock (§10).

**Request context** (`sync_commands.context`, the new optional `context` field of a command). This is an
allow-listed set of request facts a replay must reproduce, and nothing more:
- the kiosk's approval token (`X-Kiosk-Token`). A punch from a locked kiosk is re-checked against the
  same approved kiosk on the authority. A kiosk revoked on the cloud meanwhile has its offline punch
  rejected and undone everywhere;
- whether the sign-in was a borrowed phone (`session.shared`). A phone punch keeps its `borrowed`
  flag on the cloud.

Not carried: whether a phone is "usually someone else's". The authority judges that from its own sign-in
history, which for phones that only ever used a site host is empty.

**Punch photos** travel with their command (`syncUpload`). In a command they are named after it
(`p-attendance-<punch>-<command>.jpg`), so every copy agrees. Photos added on the website reach the PCs
through the file lane (§18), `kiosk-punches/` included.

**Per-copy bookkeeping is never written on a PC.** `kiosk_devices.last_seen_at` was stamped whenever a
kiosk's token was checked, including on plain page loads. On an installed PC that is a write outside any
command, which the guard refuses for actions; on a page load it would silently make the row drift. PCs now
skip it (`isInstalledCopy()` in `src/sync`); the cloud stamps it when it replays the kiosk's punches. This is
the first concrete case of the §10 "page loads that write" limit. The general check is still phase 6.

Tests: `tests/sync-clock.test.ts` (site trio):
- a punch backdated 2 h keeps its minute, and its code is validated for that window;
- a locked kiosk is re-checked on the cloud, and a kiosk revoked meanwhile is rejected and undone;
- a borrowed-phone punch keeps its flag through host and cloud;
- a desk punch photo reaches host and cloud under the same name, and a website punch photo reaches the
  PCs.

## 21. Phase 4b as built (2026-10-01): site number blocks + production offline

### Site number blocks (`src/sync/numberblocks.ts`, `sequences.ts`)
The cloud remembers every number series in use (`sync_seq_keys`, noted whenever `nextSequence` runs
on it). A site host asks for blocks on each round (`POST /api/sync/sequence-blocks`, host token only):
- for every series in use, the first time;
- afterwards, for series it needed and ran low on (fewer than 10 left).

The cloud leases 50 at a time per series, moves its own counter past the block, and records the lease
(`sync_seq_leases`). The host issues **real numbers** from its blocks (`sync_seq_blocks`) for its own work
and when it replays a LAN PC's command (the PC's provisional number becomes real there). With a block
used up it issues provisional ones, or keeps the PC's, and asks for more. The cloud keeps a host-issued
number only if it lies in a block it leased to *that* site (`decidingSite`). Otherwise it issues its own
and counts a plan miss. Numbers are unique but not in date order across sites; a retired host leaves gaps.

### Production (`modules/manufacturing`)

| Class | Routes |
|---|---|
| `physical` | job order release (parts out), kit accept, progress, units (photo travels via `syncUpload`), unit QC/QA inspection, products-in, batch inspection |
| `merge` | new job order, new batch, report a repair, report a production issue, RTS check (a dry run) |
| `claim` (a job order's decisions → the site of its source location, else the main site) | edit, schedule, components, approve / unapprove, purchase shortfall, pause / resume / cancel / close / delete, unit identifier; company-wide: warehouse accept, kit preparation (pick), BOM, checklists, teams, capacity, labels, unit allocation, repair accept / reject / cancel, issue edits |

**Checks relaxed under sync:**
- **D1**, parts release short on stock: accepted inside a synced command, with the location going below
  zero and a discrepancy opened.
- **D6 clash-checks** (kept + flagged in Site decision clashes):
  - picking a kit the cloud now has too little stock for;
  - approving a job order the cloud approved meanwhile.

Production cost postings use the action's own date (`today()` on `now()`).

**What the tests showed.** `tests/sync-production.test.ts` runs a whole production run on the host with the
internet down: real MO number from its block, approval, warehouse steps, release, kit, units with photos,
QC and products-in. It reaches the cloud identically, photos included. The first version of the D1 test also
exposed that a kit **picked** at the site was re-refused on the cloud when stock had been taken elsewhere
meanwhile, which also made the release fail. Marking the pick's stock check as a D6 clash-check fixed it. The
release then lands, the cloud's stock goes to −2, and a discrepancy is opened.

## 22. Phase 4c as built (2026-10-02): sales-order release offline

### Classes (`modules/inventory`: `orders.routes.ts`, `deliveries.routes.ts`; `core/attachments.routes.ts`)

| Class | Routes |
|---|---|
| `physical` | release (goods scanned/entered out), release slip (stock leaves), delivery status, proof of delivery, any photo attachment (travels via `syncUpload`) |
| `merge` | new order (sale or purchase), new delivery |
| `claim` (an order's decisions → the site of its stock location, else the main site; a delivery's → its order's) | approve / status, edit, delete, warehouse accept-release, unreserve, produce shortfall, purchase shortfall; delivery edit / delete; deleting a photo (company-wide) |

A `physical` route may now name a `home` too. On the cloud, replaying a site's physical action on
a record that site owns sets `siteFinal`, the same way a claim does. Its marked clash-checks are then
relaxed and flagged, while permissions and validation still apply. Deleting a photo keeps the file on an
installed PC (`sideEffectsSuppressed('unlink')`), so a refused delete can bring the row back.

### Checks relaxed under sync
- **D1:** a release slip's stock-out beyond recorded stock. `maybeFulfillSale` → `applyStockChange` never
  refused it; inside a synced command the negative location balance now opens a discrepancy.
- **D6 clash-checks** (kept + flagged in Site decision clashes):
  - the **availability gate** on approve/confirm (status or edit): the site saw enough stock;
  - **release** against an order the cloud re-opened, cancelled or un-accepted meanwhile, a unit the
    cloud reserved for another order (the site scanned it, so it moves here), or a line already
    covered;
  - **release slip** for an order the cloud moved out of `released`. A slip issued on both sides keeps
    the first one;
  - **delivery**: a proof of delivery stands over a cloud cancellation (delivered on both sides keeps
    the first proof). A status change after the cloud finished the delivery keeps the cloud's.
- Unchanged: a unit already **sold** on another slip is still refused (the conflict inbox), as are
  units or items that are not on the order.

QuickBooks auto-push stays cloud-side: the QBO connection is a cloud-only setting, so it fires once,
when the cloud replays.

**What the tests showed** (`tests/sync-sales.test.ts`). A whole sale ran on the host with the internet
down: SO, RS and DEL numbers came from its blocks, through approval, release, the slip with a photo
and the proof of delivery. It reached the cloud identically and passed to the LAN PC. A slip and photo
taken on a LAN desk PC got its real RS number at the host and reached the cloud. An approval the cloud
would now refuse stood, flagged. The release that followed took the cloud's stock to −3 with a
discrepancy. A proof of delivery stood over a cloud cancellation, flagged. **Not covered by a test
yet:** the serialized-unit clash (a unit reserved for another order).

## 23. Phase 4d as built (2026-10-02): purchasing offline

### Classes (`modules/purchasing/purchasing.routes.ts`; purchase orders themselves are `orders` rows, §22)

| Class | Routes |
|---|---|
| `physical` (home: the receiving location's site) | goods receipt: the goods arrived, and stock goes in |
| `merge` | enter a vendor bill |
| `claim` | reverse a goods receipt (the receipt location's site); bill edit / approve / dispute / delete and the match tolerance (company-wide: the main site) |

### Checks relaxed under sync (D6 clash-checks, kept + flagged)
- **Receipt against a PO line removed on the cloud meanwhile.** The goods arrived, so the line is kept
  but unlinked from the PO (`order_item_id` NULL). The 3-way match then shows it as unmatched.
- **Bill approval whose 3-way match fails only on the cloud**, for example because a receipt was reversed
  online. The approval stands, and its `match_json` records the cloud's exceptions.
- **Bill approved on both sides.** The first approval is kept.

Unchanged: a receipt for a PO deleted on the cloud, or into a location or item that no longer exists,
is still refused (the conflict inbox). Editing or deleting a bill approved on the cloud meanwhile is
refused too: it would change posted amounts. A goods-receipt posting with no received date uses the
action's own date (`now()`).

**What the tests showed** (`tests/sync-purchasing.test.ts`):
- With the internet down, the host raised a purchase order, received the goods, entered the bill and
  approved it on a clean match. The PR, GRN and BILL numbers came from its blocks. All of it reached
  the cloud and the LAN PC identically.
- A LAN desk PC's receipt got its real GRN number at the host.
- The three clash cases each landed confirmed and flagged.

## 24. Phase 4e as built (2026-10-02): HR requests and records offline

### Classes

| Class | Routes |
|---|---|
| `merge` (an employee's own) | file a request (`POST /api/form-records`: any form record, so staff records too), file a time fix, cancel your own request or time fix, update your own contact profile; upload a 201 document, upload a form to the forms library |
| `physical` | issue company property to an employee, take it back |
| `claim` (company-wide: the main site) | decide a request or time fix (`/api/me/approvals/*`); employees (create / edit / delete / import / number policy), profile verification, document delete, asset-issuance delete, shifts; the form designer (definitions, templates), form-record edit / delete, global variables; forms-library delete |

Payroll routes (periods, attendance grid, payslips, deductions, payroll tables and policy, GL post,
mark-paid, payslip email, the payroll CSV import) are not classed yet. They come in the payroll phase.

**Department heads decide at the main site.** Approvals are company-wide records. A department head
at another site can't decide while that site is offline; the decision waits for the connection.
Giving each department a home site would lift this. That is a proposal, not built.

### New sync pieces
- **`syncClass(cls, { redact })`.** The named body fields are left out of the stored command.
  `PUT /api/me/profile` re-checks the employee's password, and that check happens on the PC where the
  change is made. It is skipped when the command is re-run on the host or the cloud
  (`reRunOfRecordedCommand()`), so the password is never stored in `sync_commands` or sent anywhere.
- **`commandFileName(prefix, ext)`.** A file a route writes itself (not an upload) is named after its
  command, so the PC's file and the cloud's are the same file. It is used for the "file to 201" memo
  that form actions write.
- **Upload names.** `syncUpload` no longer takes a timestamp as the file-name prefix (HR documents and
  the forms library name their uploads `<timestamp>-…`). Such files are named `file-<command>-<n>`.
- Deleting a 201 document or a forms-library file keeps the file on an installed PC until the cloud
  confirms (`sideEffectsSuppressed('unlink')`), the same as photos (§22).

### Checks relaxed under sync (D6 clash-checks, kept + flagged)
- A request or time fix that was decided or withdrawn on the cloud meanwhile keeps the cloud's outcome.
  The main site's decision is dropped and the clash is flagged.
- A paid leave approval the cloud's leave bank no longer covers (other leave was approved online
  meanwhile) stands. The balance goes below zero.

**What the tests showed** (`tests/sync-hr.test.ts`):
- With the site offline, an employee at a LAN desk PC filed a leave request (its provisional
  `LV-P<pc>-…` became a real number at the host), a time fix and a contact change. A wrong password was
  still refused on the PC.
- HR approved both at the main site and added a new hire with a 201 document.
- Everything reached the cloud identically, the document file included. No stored command anywhere
  contains the password.
- Both clash cases landed confirmed and flagged.

## 25. Phase 4f as built (2026-10-02): confidential (anonymous) reports offline

### Classes (`core/confidential-reports.routes.ts`)

| Class | Routes |
|---|---|
| `merge`, **unattributed** | submit a report, follow up, remove your own photo |
| `merge` / `claim` (company-wide) | handler reply / status change (staff, attributed as usual) |
| (none: they write nothing replicated) | get a ticket (node-local table), look up a report, fetch a photo |

### What an anonymous command carries, and what it doesn't
- **No identity.** As §7.5 says, there is no user, device, PC number, node sequence, HLC or time,
  only the date. Its ULID is dated to midnight. On every replay it runs as at its own day's
  midnight (the replay clock), so `created_on` is the day it was filed, not the day it arrived.
- **No ticket.** The ticket is checked and used on the PC (tickets never leave a PC) and is
  `redact`ed from the command. A re-run skips the ticket check.
- **No access code.** Only its SHA-256 travels (`access_hash` in the body). The code is `redact`ed
  from follow-ups, and a re-run verifies with the hash (`findByHash`). No stored command anywhere
  contains the code.
- **Only stripped photos.** The route hands the command its metadata-stripped photos
  (`attachCommandFiles`, named `photo-<n>.<ext>`). The original upload, its name and its metadata
  are never stored in the blob store or sent.

### Numbers: provisional on a PC, real on the cloud
A report filed on an installed PC is numbered `CR-X<8 hex>` there. The suffix is derived from its
command id, so a rebase reproduces it and nothing about the PC or the time shows. The cloud gives it
the real `CR-#####` (still numbered from the table, never from `settings`) and keeps the provisional
number in **`anonymous_report_aliases`**, so the reporter's number and code keep working for follow-ups
everywhere, with either number.

### Held before sending
The PC holds an anonymous command for a random 10–120 minutes (`sync_commands.release_after`, local
only; `SYNC_ANON_DELAY_MIN_MIN` / `SYNC_ANON_DELAY_MAX_MIN`) and then sends it with whatever else is
going. Each one is held at least as long as the one before it, so a follow-up never overtakes its
report. Held commands still count as pending, and rebase still re-runs them.

### Limits
Removing a photo **offline** works only for photos that have already synced. A photo added offline
has a different id on the cloud, so the removal is refused there. The reporter can't see that in the
conflict inbox, because anonymous commands are never listed.

### Bug fixed on the way: uploads lost the workspace
The bug existed before sync. multer's **memory** storage finishes inside the request stream's events,
outside the request's async context, so the route then ran against the **default workspace**. A
multipart anonymous report from any other workspace was refused (its ticket was looked up in the
default workspace), and the HR payroll CSV import read and wrote the default workspace.
`shared/request-context.ts` `keepRequestContext()` now re-enters the request's workspace and sync
contexts after such a middleware. It wraps both memory uploads and `syncUpload`. Disk-storage uploads
were not affected. Regression test: `tests/upload-tenant-context.test.ts`.

**What the tests showed** (`tests/sync-anonymous.test.ts`):
- A report with a photo, filed at a LAN desk PC while the site was offline, got `CR-X…` and could be
  looked up there at once.
- Its command had no identity, no ticket, no code, and no original file name.
- It was held back on the next round. Once released, it reached the cloud as `CR-00001` with that
  day's date and the stripped photo. Both numbers opened it.
- A follow-up from the PC under the provisional number reached the case.
- A handler at the main site replied and changed the status offline, and the reporter saw both.

## 26. Phase 4g as built (2026-10-02): payroll offline

### Classes (`modules/hr/hr.routes.ts`, `core/form-builder.routes.ts`)

| Class | Routes |
|---|---|
| `claim` (company-wide: the main site) | cutoffs (create / edit / delete), roster (add / bulk / remove), the attendance grid, generate payslips, deduction toggles, mark / unmark paid, post payroll to the GL, payroll tables, payroll policy, the payroll CSV import (the file travels with its command) |
| `online` | email a payslip: it goes through the company's own mail server, which only the cloud has (D8) |
| (none: writes nothing) | preview deductions, and the reads |

Payroll is decided where HR works, at the main site, so a whole cutoff runs there with the internet
down. Payslip numbers come from the host's blocks.

**Checks relaxed under sync (D6):** marking a payslip paid that the cloud marked paid meanwhile, or
unmarking one the cloud unmarked, reaches the same outcome. It is kept and flagged. A regenerate
already skips payslips the cloud marked paid, so no clash-check is needed there. Editing a payslip
the cloud marked paid stays refused (the conflict inbox), because a paid payslip is final.

**What the tests showed** (`tests/sync-payroll.test.ts`): with the internet down, the main site created
a cutoff, added an employee, entered two days of attendance, generated the payslip (a real number from
its block), changed a deduction and marked it paid. Emailing it was refused with 503. Everything reached
the cloud identically. A payslip marked paid on both sides stayed paid, flagged.

## 27. Phase 4h as built (2026-10-02): accounting offline

### Classes (`modules/accounting/accounting.routes.ts`)

| Class | Routes |
|---|---|
| `physical` | a petty-cash entry: cash went into or out of the box |
| `merge` | a draft journal entry (its JV number comes from the host's block) |
| `claim` (company-wide: the main site) | everything else: GL setup, chart of accounts, accounting periods (create / close / reopen), posting rules, journal-entry edit / post / void / delete, customer payments and credit notes (record / void), tax codes, statutory-deduction switches, petty-cash funds, petty-cash entry delete |

Tax filings (2316, 1601-C, alphalist, 2550M and so on) and every report are reads, so they work on any
copy. Dates the routes stamp themselves (a reversal's entry date, a period's `closed_at`) use the
action's own time (`now()`).

**Checks relaxed under sync (D6)**, where the same outcome was reached on both sides, kept and flagged:
- a journal entry posted on the cloud and at the main site;
- a journal entry reversed on both (the first reversal is kept);
- a period closed on both;
- a payment or credit note voided on both.

**Not relaxed: closed periods.** Posting (or voiding) into a period the cloud closed meanwhile stays
refused and goes to the conflict inbox. A closed period is an accounting control; letting a site post
into it would defeat the close. The site's copy follows the cloud (the entry stays a draft there too).

**What the tests showed** (`tests/sync-accounting.test.ts`):
- With the internet down, the main site entered and posted a journal entry with a real `JV-` number,
  opened a petty-cash fund and paid from it, and closed a period. All of it reached the cloud identically,
  and the trial balance balanced.
- A post into a period the cloud closed meanwhile was rejected, and both copies kept the entry as a draft.
- An entry posted on both sides stayed posted, flagged.

**Phase 4 status:** with 4h, every business pipeline in the pipeline map runs offline. Still unclassed
(so refused on an installed PC):
- core leftovers: announcements, chat messages, personal notes / tasks, templates, bug reports, user
  and account administration;
- the online-only modules: AI, email, QuickBooks, the platform console, signup.
The online-only modules stay that way (D8). The core leftovers are a small follow-up.

## 28. Phase 4i as built (2026-10-02): the core leftovers, and a guard against drift

### Classes

| Class | Routes |
|---|---|
| `merge` | chat (send with files, edit, react, mark read, delete your own), personal notes / tasks / bookmarks, bug reports (with screenshots), your own display name |
| `claim` (company-wide: the main site) | announcements, document templates and variables, departments, bug-report triage |
| `online` | **credentials (D8):** user accounts and their access (create, edit, permissions, reset password, revoke sessions), change / forgot / reset password. **Online-only modules:** the AI assistant (chat, config, history, usage), email (settings, test, send), QuickBooks (disconnect, auto-push, push) |

Some routes need no class because they write only node-local tables or nothing:
- sign-in, sign-out and session revokes (sessions);
- push subscribe / unsubscribe / test;
- anonymous-report tickets, lookups and photo fetches;
- pruning the activity log (this copy's own);
- rebuilding the AI search index (per copy);
- previewing deductions.

The platform console and sign-up run only on the cloud.

Chat's live delivery and pushes fire once, from the cloud (`sideEffectsSuppressed` in `shared/ws.ts` and
`push.ts`). Deleting a chat message keeps its files on an installed PC until the cloud confirms.

### The guard: `tests/sync-route-classes.test.ts`
An installed PC refuses a write from a route with no sync class, so a new route that forgets one quietly
stops working offline. The test scans every route file. Each POST / PUT / PATCH / DELETE must carry
`syncClass(...)`, or appear in its `NO_CLASS_NEEDED` list with a reason. It also checks that every entry in
that list still names a real, unclassed route. It sees all 262 mutating routes.

**What the tests showed** (`tests/sync-core.test.ts`):
- At a LAN desk PC with no internet, a chat message with a file, a note and a bug report with a screenshot
  were saved. The main site posted an announcement and added a department.
- Creating a user and changing a password were refused (503, "needs an internet connection").
- Everything reached the cloud, the file included, and the colleague saw the message there.
- `tests/sync.test.ts`'s write-guard check now uses a throwaway unclassed route, since no real one is left.

**Phase 4 is complete:** every route is either classed or listed with its reason.

## 29. Phase 7 (planned, added 2026-10-02): an installable Android app

**Why.** Floor roles work on phones: QC and QA inspectors, the production line, warehouse releasing and
receiving. Today a phone works offline only partly:
- **It needs a connection to load anything.** That means the site host on the LAN, or the internet.
  With the site host on Wi-Fi a phone already works through an internet outage (§15).
- **It can queue writes.** A failed write waits in IndexedDB and is replayed later with an idempotency
  key (`public/mobile/lib/queue.js`).
- **It can't open screens it hasn't loaded.** With no Wi-Fi at all (a dead spot on the floor, a yard, a
  delivery truck) the inspector can't open the next unit's checklist. That delays the work this phase is
  meant to avoid.

**Proposal: wrap the existing `/m` app as an APK (Capacitor), not a rewrite.** The app stays the same
vanilla HTML/CSS/JS, and the APK adds what a browser tab can't do:
1. **Offline work lists.** The app keeps a local copy of what the signed-in person needs next, for
   example the QC / QA queue with each unit's checklist, the parts kit to release, or the deliveries
   assigned to them. Those screens open with no connection.
2. **Its own command queue.** Actions are recorded like a PC's commands (§2.1), with the same sync
   classes, an idempotency key, the action's own time, and photos as blobs. They are sent to the site
   host or the cloud, whichever it reaches first. Like today, a queued action is never shown as final
   (CLAUDE.md).
3. **Finds the host by itself.** It discovers the site host on the LAN (the same announcements PCs use,
   phase 5). It follows a failover to the new host with its queue and session intact. A browser tab
   can't do that: its storage is tied to the host's address.
4. **Trusts the site certificate without the manual install.** The APK can pin the site's CA when it is
   enrolled, which replaces D5's install-the-certificate step on each phone.
5. **Better camera and scanner access, and background sync** when the phone comes back in range.

**Not proposed:** a full replica on each phone, the way PCs have one (D2). Phones get lost, shared and
stolen, so they hold only what the signed-in person is working on, and that is cleared when they sign out.

**Decisions needed before building it:**
- **Distribution:** Google Play (private / managed app), or a sideloaded APK from the company's own site?
- **Who gets offline work lists:** QC/QA first, then line, releasing, receiving and delivery?
- **Shared phones:** the cache is per person and cleared at sign-out; is that acceptable for a phone that
  is handed over between shifts?
- **iPhone:** the same approach can build an iOS app; is it needed, or Android only?
- **Lost phone:** remote sign-out plus wiping the cache on its next connection; is anything stronger
  needed (device PIN required, a timeout)?

**Depends on:** phase 5, so the phone can follow the host. Today the PWA keeps working with the site host's
fixed address, or the cloud.

## 30. Phase 5a as built (2026-10-02): taking over a lost site host

### A site keeps its number; its host can change
A site is numbered after its first host. That number stays the site's, and it is what location homes,
the main site, number-block leases and clash records store. Which PC hosts the site can change. Each
change starts a new **term**, and the cloud is the referee (`sync_sites`: each site's host and term):
- **Claiming.** A PC claims a site by sending `POST /api/sync/site/host` a higher term.
- **Stepping down.** A host that hears of a higher term from the cloud steps down.
- **Two claims at once.** If two PCs claim at once, the first to reach the cloud wins and the other steps
  down. Anything both decided meanwhile is replayed, and checks that clash are flagged (D6).

### Every site PC can take over, because it mirrors its host
On each pull the host gives each of its PCs, besides effects:
- **The site log** (`sync_site_log`): every command the host holds that the cloud hasn't confirmed,
  its own and other PCs'. Whoever takes over forwards them, so work recorded through a dead host isn't lost.
- **The site's PCs**, with their token hashes and LAN addresses, so a new host lets them in with no internet.
- **The cloud's address**, which a site PC never needed before.
- **The site's certificate authority** (`GET /api/sync/site/ca`). Every PC of the site keeps a copy,
  encrypted with its own PC secret (§19). A new host's HTTPS certificate is then issued by the same
  authority, so other PCs and phones trust it with nothing to set up again. This changes D5 as built
  (§17): the authority was per host and is now **per site**.
- **The term and the stream epoch** (below).

### Taking over (an admin's decision, for now)
On a site PC, **Sync → Site → Take over as site host** (admin, `POST /api/sync/site/take-over`). The
dialog asks the admin to confirm the host is really off. The PC then:
1. puts the mirrored commands in its own queue;
2. starts term + 1 and a new stream;
3. switches to talking to the cloud;
4. restarts in host mode (HTTPS on the LAN; exit code 75, and `electron/main.cjs` restarts it).

Offline, it serves the site at once. When it next reaches the cloud it claims the site, sends everything
it holds, and **re-syncs** (below).

**Finding the new host.** A site PC whose host misses 3 rounds in a row asks the site's other PCs, at
their LAN addresses, who hosts the site now (`GET /api/sync/whoami`, which reports site, term and
epoch). It follows the newest one: it sends again what the old host had accepted (the new host
recognises what it already holds), then re-syncs from it.

**The old host coming back.** It hears from the cloud that another PC holds the site under a higher
term. It sends what it still holds to the cloud (as a site PC it may), gives up its unused number
blocks (gaps), then follows the new host and re-syncs from it.

### Full re-sync (also phase 6's "re-sync this PC")
A copy that followed the old host contains effects of commands the cloud hasn't seen, so an incremental
rebase can't continue from it. `resyncFromSnapshot` handles that:
1. after everything the PC could send has gone and the verdicts are recorded, it downloads a fresh copy
   from its authority;
2. inside one transaction, with foreign keys off, it replaces every replicated table with that copy;
   node-local tables (sign-ins, sync bookkeeping, credentials) are kept;
3. it re-runs what is still pending on top.

A host that re-syncs starts a new **stream epoch**, and its PCs re-sync when they see the change. The
same step is used:
- when a copy is found to have **diverged** (`SyncDivergenceError`): the sync loop now repairs it at the
  next round instead of stopping;
- on request: **Sync → Site → Re-sync this PC** (admin, `POST /api/sync/site/resync`).

### Number blocks
Leased to the **site** (the cloud checks the caller hosts the site now), so a new host keeps using the
site's numbers. A host that steps down gives up its unused block.

**What the tests showed** (`tests/sync-failover.test.ts`, a host and two desk PCs):
1. With no internet, the host recorded −3 and accepted desk 1's −2. Both desk PCs mirrored those two
   commands.
2. The host died. Desk 1 took over (refused until the admin confirmed) and recorded −1 as the new host.
3. Desk 2 missed its host for 3 rounds, found desk 1 hosting under term 2, switched to it and recorded −4.
4. Back online, desk 1 claimed the site, and all four commands, **the dead host's own −3 included**,
   reached the cloud once (90). Desk 2 re-synced onto desk 1's new stream.
5. The old host came back, stepped down, re-synced from desk 1 (90), and worked as an ordinary PC
   (−5 → 85 on the cloud). The cloud's records show desk 1 hosting site 1 under term 2.
6. A desk PC with a damaged copy and unsent work re-synced: the damage was gone and its unsent work
   went through.

### Limits / not built yet (phase 5b and later)
- **No automatic election.** Taking over is an admin's decision. Automatic election for sites with 3+
  voting PCs (heartbeats, majority vote, lease) is phase 5b. For 2-PC sites D3 already says the
  secondary doesn't take over by itself.
- **Phones keep the old host's address.** After a takeover they need the new host's address; the
  Android app (§29) is planned to follow the host automatically.
- **Duplicate decisions are possible while offline.** If the old host was alive but cut off (not dead),
  both sides decide claims until they reach the cloud. The cloud keeps both and flags clashes, which is
  why the dialog insists the host is off.
- **Desktop UI tests.** The Sync page's site panel is exercised through its API only, not rendered in a
  test.
