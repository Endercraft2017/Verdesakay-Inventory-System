# Durable creation receipts — 19 October 2026

Base cd34ba18f0aeae792f92fe60349c8271e17f5ea0, production.

High scoped finding: console creation can choose a fresh generated slug on another submission
when an earlier commit's response was lost, creating a duplicate workspace. Public signup can
report conflict despite having committed its local setup and first invoice. A client timeout
alone gives no reliable information about whether the catalog transaction committed.

Implemented: optional UUID-v4 Idempotency-Key on public signup and authenticated console create.
Updated browser forms keep one random key in memory per page/modal, including console passkey
retry. Only completed original 201 responses are stored, within catalog publication's savepoint.
Same scope/key/parsed request replays that original result without another tenant, invoice or
notification. Public signup uses a separate versioned scope; console scope includes operator ID,
and authentication/required setup/fresh proof still precedes lookup. No tenant session or recovery
bearer is returned by replay. Password-containing requests are bound with salted scrypt of a
canonical request digest, not a stored raw request or fast password verifier. Key hashes are not
password hashes. Object property order is immaterial; array order and explicit defaults matter.

New platform_creation_receipts table/index uses IF NOT EXISTS in control-plane initialization;
no tenant-schema version or generated tenant DB type change was needed. Responses and verifiers
expire after 24 hours and are nulled by startup/hourly/keyed-request sweeps. Minimal permanent
tombstones prevent expiry becoming another create. Governance approval, backups/WAL and restore
reconciliation remain necessary; this is not legally approved retention or forensic erasure.

Tests use real HTTP/SQLite, not fabricated success handlers: original invoice replay after prices
change/catalog reopen; body/password changes; route/operator isolation; missing auth and stale
passkey proof; invalid keys; legacy no-key compatibility; local publication/receipt write faults;
expiry and purged tenants; stale competing candidates; a separate reader connection; a real child
process exit after commit and replay in another process. The competing-candidate test is ordered,
not a simultaneous multi-process/host load test. Chromium deliberately discards actual committed
responses for both forms, retries with the same key, and checks one workspace/invoice. No live
customer information, owner email, provider call or hosting mutation is used.

Initial verification corrections: TypeScript caught the receipt helper returning void where the
trusted publication callback requires undefined; its return annotation now matches that contract.
The first db:types attempt failed because the filesystem-only sandbox blocks tsx IPC. The approved
local rerun completed and produced no generated-file diff. These are preserved as initial type/
environment outputs, not product outage or production migration failures. Initial focused cases
passed; final full results and exact counts are in the verification/results records.

Primary research reviewed 19 October 2026:
- https://docs.stripe.com/api/idempotent_requests — random keys, original replay and parameter checks.
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html — slow salted hashing;
  scrypt N=2^17,r=8,p=1 when Argon2id is unavailable.
- https://www.sqlite.org/lang_savepoint.html — nested publication/rollback boundary.

The local contract differs from Stripe API v1: only successful 201s, UUID-v4-only format and
permanent tombstones. No finalized Idempotency-Key RFC or third-party certification is asserted.
Runtime dependencies are unchanged; this research is not a new npm advisory snapshot.

Remaining engineering: reliable notification outbox/worker, signup async work admission, broader
create/import/API retry coverage, legacy/new-key uncertainty and imported-state reconciliation.
New/no keys (including reload/new modal) do not prevent duplicates. No in-flight promise queue,
exactly-once remote delivery, hosted/Windows/shared-filesystem/power-loss/capacity acceptance,
full API contract, all-233-control PASS or deployment is claimed. Current whole-control totals
and the release hold remain. Full documentation: workspace-onboarding.md, provisioning-recovery.md,
API contract, data governance/draft privacy notice, module catalog/pipelines and audit records.
