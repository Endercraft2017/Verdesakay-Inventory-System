# Customer service implementation and verification

Scope: customer identity → inquiry/next action → existing sale flow → complaint →
handover/resolution. Owner: Sales, implemented under `modules/inventory`; no Messenger integration,
new licensing module, shared task scheduler or financial workflow replacement.

## Evidence and limits

Baseline `bf703f4`, schema 47. Read-only inspection found zero customers, orders and
tasks; 16 form records were company holidays. The pre-change disposable API audit
reproduced empty-string sale autofill failure, silent invalid-customer unlinking,
deletion of customers with sales, exact duplicate customer creation, and private
personal tasks. No operational complaints were present to map or migrate.

Implemented behavior uses clearly labeled synthetic examples. Actual Messenger
conversation-to-record mapping, CSR terminology, and production data quality remain
unverified. Production was neither migrated nor deployed.

## Data rules and API

Schema 98 adds Facebook name/reference URL, normalized search keys and profile
version to `customers`; `creation_key`/`creation_hash` to orders; and
`customer_cases` + append-only `customer_case_events`. Original contact strings,
customer IDs, order IDs, amounts and snapshots are retained.

- `GET /api/customers/matches?name=&phone=&email=&facebook_name=&exclude=` returns
  suggestions including archived profiles, never performs automatic matching.
  Philippine `+639…` and `09…` mobile formats share a search key; this is not identity proof.
- Existing customer CRUD remains under orders permissions. Updates require the
  current numeric `version`; stale edits return 409. Deleting a customer referenced
  by orders, cases, payments, credit notes or journal lines is blocked; archive instead.
- `GET /api/customers/:id/sales?q=` searches sale numbers for linking older sales,
  independently of the recent-order preview.
- `GET /api/customers/:id/cases?offset=` returns shared cases for that customer;
  `GET /:id/history?offset=` combines existing sales with permitted case events.
  Without case access the history includes sales only. Responses use 51 rows as a
  lookahead; clients display 50 and increase offset by 50.
- `GET /api/customer-cases?scope=mine|team&before=<ISO timestamp>&offset=&closed=1`
  is the work queue. Default excludes resolved/cancelled. Team scope needs
  `cases.assign`; inactive owners are flagged. `/owners` supplies eligible active
  staff, `/:id` reads a case, `/:id/events?offset=` pages its history.
- `POST /api/customer-cases` requires customer_id, kind, summary, status, owner_id,
  next_action, due_at (ISO with time zone), sale_order_id, resolution and request_key.
  Nullable fields must be sent as null. `PUT /:id` sends the editable fields plus
  current version and optional note. Identity/type cannot be changed. A closed case
  requires a reason and clears its pending action. A linked sale must belong to the
  same customer. Existing inquiry-sale links cannot be removed/replaced.
- Case reads require `cases.view` AND `orders.view`, behind Sales entitlement.
  Writes also require `cases.edit` and current ownership or `cases.assign`.
  A CSR can hand over their own case; only supervisors can create cases for others
  or update another owner's case. Fresh role seeds: CSR view/edit; CSR Supervisor view/edit/assign; admin all.
  Existing tenant-edited roles require administrator grants; they are not overwritten. Server resolves current permissions.
- `POST /api/orders` accepts optional case_id, case_version, request_key. Case-driven
  creation requires an open inquiry, current owner/supervisor access, and
  `orders.create`. Order and case link/event commit together. Existing approval,
  stock, release, accounting and QuickBooks hooks remain in the original handler.
  Case-driven retries return the same linked order; ordinary client creations use
  a stable per-dialog request key (also accepts Idempotency-Key on creation).
  A key reused with changed input returns 409. Unkeyed ordinary API requests still
  mean separate intentional creations, preserving legacy clients.
- The general idempotency cache is bypassed for customer/case/attachment
  writes and order creation. Their current auth, versions and transaction-bound
  creation keys must run on every attempt. Other order actions retain their existing
  idempotency behavior. Case creation keys are scoped to the actor within the tenant;
  cases and orders store payload hashes for changed-retry detection.
- `attachments` gains kind `customer_case`. List/image reads require case access;
  upload/delete requires current owner/supervisor edit access and Sales
  entitlement. No public file URLs. Existing attachment kinds retain their rules.

Case changes and their actor-name/timestamp/snapshot events commit atomically.
A failed event insertion rolls back both the state change and an associated new
order. Version checks reject stale updates. Database checks require next actions
on open cases, while triggers prevent event-content rewriting (sync may allocate its row ID) and detaching a case's sale
from its customer. No case deletion endpoint exists.

## Migration rehearsal and rollback

The existing pre-migration snapshot mechanism runs before schema changes. Startup
must not be used as a production preview: it migrates its configured database.
Use a staging database copy with its own DB_PATH, DATA_DIR, UPLOAD_DIR and backup
location. Do not point test/browser instances at operational paths.

`tests/customer-cases-migration.test.ts` constructs a v97-shaped database copy with
synthetic customers, a confirmed sale and posted journal records. It compares every
legacy column in customers, orders, order_items, journal_entries, journal_lines,
payments, credit_notes, form_definitions and form_records before/after upgrade and
again after forceMigrate. It checks FK/integrity results, normalized values, and
that no cases/events were inferred. It also verifies a pre-migration backup exists.

For rollout, repeat that rehearsal with an authorized operational copy and approved
source mappings. Do not auto-link name-only legacy records. No operational record
import or customer merge is included. To roll back, stop the app, restore the
pre-migration snapshot plus corresponding uploads, and run the preceding application
release. Retain the upgraded snapshot for reconciling any post-upgrade work; restoring
an older database discards later writes unless separately reconciled.

## Verification

- API scenarios: full inquiry/sale/complaint/handover/resolution, simultaneous edits,
  normalized/archived matches and explicit separate customers, invalid IDs,
  creation retries/changed retries, injected save/link failures, permissions,
  authenticated images, private personal tasks and inactive-owner recovery.
- UI regressions: failed saves retain inputs; navigation keeps a hash URL and avoids
  duplicate modal creation. The latter fixes an existing immediate hashchange
  re-navigation exposed by this workflow; browser back/manual hash handling remains.
- Actual headless Chromium walkthrough: customer creation, inquiry with next action,
  prefilled normal sale form, sale save, related complaint, handover, sign-in as the
  receiving CSR, queue visibility, resolution, combined customer history. Completed
  with no client exceptions. All writes went to a fresh temporary database.
- Pre-sync repository validation completed: `npm run check` passed 118 files / 1,405 tests.
  Final focused checks passed 41 tests, with a final TypeScript and diff-whitespace check.
  CSR acceptance instructions are in
  `docs/guides/customer-service.md`; synthetic automation does not establish live CSR
  usability or production migration readiness.

## Origin sync integration

Synced with origin/restructure/module-architecture at a7560fd. The branch adds
Sales entitlement, tenant-editable roles, offline commands, and schema 97. CSR
additions now use schema 98, Sales gates and current tenant role resolution. Existing
order revision, release, permissions and idempotency behavior are retained. New case writes and case-linked sale creation
explicitly use syncClass(online): installed offline nodes cannot claim a final
save. Offline case creation/handover is not implemented. Original pre-sync test counts
above describe the preceding checkout; rerun current checks after this integration.

Post-sync verification completed: `npm run check` passed 301 test files / 3,069
tests. Focused retry/CSR/authority checks passed 24 tests, and the Python Playwright
walkthrough completed customer → inquiry → sale → complaint → handover → resolution
without client exceptions. That automation used a test-context CSP bypass for the
installed Python Playwright polling implementation; application CSP was unchanged.
All browser/API/migration writes used disposable databases. The operational checkout
database remains at schema 47. Optional Electron desktop binary and Graphify CLI
were unavailable; neither desktop execution nor Graphify execution was claimed.
