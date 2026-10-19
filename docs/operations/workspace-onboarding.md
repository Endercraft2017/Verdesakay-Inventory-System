# Workspace onboarding transaction and recovery

Updated 19 October 2026. This describes implemented local behavior; release acceptance is
tracked in the audit scorecard. See provisioning-recovery.md for database/file interruption.

## Boundaries and ordering

Both callers validate their input before provisioning. The core exclusively reserves and
prepares the tenant database, including chosen owner credentials. It then starts the catalog
publication savepoint in platform.db and inserts the tenant/company ID. A trusted synchronous
setup callback runs on the same catalog connection before the core creation audit and release.
No await, external mail/provider call or tenant/file mutation belongs in that callback.
The signup alert intent is a synchronous catalog write inside it; delivery runs separately. Tenant database
reads used to prepare the console response use the already-prepared connection.

Public signup computes the price quote and initializes billing/owner-contact schema before
publication. Its callback sets the payment lock, persists the subscription/seat quote and owner
contact, and creates the first invoice when pricing is complete and positive. Invoice number,
invoice row and billing audit share a nested savepoint. Invoice issuance obtains the catalog
writer before reading the last reference; release of the inner savepoint does not commit the
outer signup transaction. The workspace becomes routable only after all local setup commits.
An incomplete/unpriced quote deliberately has no first invoice, preserving existing behavior.

Console creation preflights modules and inquiry lookup, initializes billing schema outside the
rollbackable transaction, then applies module/default-subscription choices, optional payment
lock, inquiry linkage and their audit entries inside publication. It also prepares the console
response before release. Existing owner authentication and recent-passkey enforcement remain.

Cached lazy schemas must initialize before entering a transaction that may roll back their DDL.
prepareOwnerAnalytics and billing/settings preflight prevent a cache from marking rolled-back
tables as ready. Stored-subscription parsing remains separate from public-input validation.

## Failure matrix

| Failure | Implemented outcome | Evidence |
|---|---|---|
| Invalid request or unsupported option | Safe validation/conflict response before publication | Existing signup/console/settings tests |
| Payment lock, subscription or owner-contact write fails | Catalog/setup/audits roll back; owned prepared DB is cleaned up | Real SQLite faults through public signup |
| First invoice insert or invoice audit fails | Invoice/sequence and outer setup roll back together | Signup and standalone invoice fault tests |
| Final creation audit fails | All prior local setup and console inquiry linkage roll back | Real SQLite signup/console faults |
| Process exits after local setup but before publication commits | Restarted catalog has no tenant, invoice, contact or core audit; prepared file stays blocked | Real child process exit test |
| Successful keyed setup, failed HTTP acknowledgement | Same scope/key/parsed details return the original 201 for 24 hours; no additional workspace, invoice or notification | Receipt tests and actual browser dropped-response tests |
| Receipt insertion or later publication audit fails | Receipt/workspace/local setup roll back together; same key can retry | Real SQLite faults |
| Expired key, changed request or missing/purged workspace | Conflict; never reapply an expired key | Receipt lifecycle tests |
| Signup notification fails or process exits after commit | Durable intent survives; interrupted/uncertain sends are not blindly retried | owner-alert-outbox.md and worker/process tests |
| File cleanup fails or ownership is uncertain | Preserve artifacts and emit safe cleanup event | Core recovery tests and runbook |

Signup routes now expose only authored typed validation/conflict errors. Unexpected exceptions
become generic 500 with server request ID. Raw status/expose properties and provider/storage
messages do not determine public feedback at this boundary.

## Retry and operator procedure

A reported setup failure that rolled back is retryable through the normal form with the same
explicit slug after resolving its underlying cause. The browser retains the signup fields;
the test retries the same company, then verifies one first invoice and the payment lock through
the tenant billing API. Tests send no real owner email.

A timeout or lost response is an unknown acknowledgement, not proof of rollback. The updated
website keeps a random creation key in page memory; the console keeps one per creation modal,
including its passkey retry. Retry from that same form with the same details. Successful replay
returns the original response, not a refreshed billing/subscription view. If details were changed
after success, the conflict tells the operator to check the existing workspace. Validation or
rolled-back failures do not consume a key, so correcting those inputs can retry normally.

A reload, closed/reopened console modal or older API client may send a new/no key and lacks this
protection. Check catalog/audit and invoices before starting a fresh request after uncertainty.
Do not delete or reissue an existing first invoice merely because a request timed out.
Interrupted unregistered files still require the stopped-writer review/quarantine procedure in
provisioning-recovery.md. Receipts never adopt or delete orphan artifacts.

## Durable creation receipt contract (19 October 2026)

Only POST /api/signup and POST /_platform/api/tenants accept this creation contract. Supply an
Idempotency-Key header formatted as a UUID v4; browser clients generate it with crypto.randomUUID
in a secure context. No key is permitted for compatibility, but then there is no replay promise.
Import, CLI provisioning, payment settlement and other routes are outside this contract.

Request validation happens before receipt lookup. Signup remains behind SIGNUPS_OPEN and its
existing rate limiter. Console lookup stays behind current session authentication, required
passkey setup and fresh passkey verification; each operator has a distinct scope. Anonymous
signup has its own versioned scope and requires both the random key and matching parsed request,
including the password. Possession of a receipt does not authenticate a tenant, reset a password,
bypass MFA or grant workspace access. Responses contain no session token or recovery bearer.

The platform_creation_receipts table is created with the control-plane schema, not a tenant
schema migration or replicated tenant table. Its primary key is (scope, SHA256(UUID)). Parsed
objects are canonicalized with sorted property names; array order and explicit defaults remain
significant. The canonical request digest is protected by salted scrypt at N=131072,r=8,p=1.
Neither raw password/request nor a cheap password fingerprint is persisted. Existing password
hashing helpers provide the work factor; this is not a separate encryption key in platform.db.
Console receipts contain the original company/subscription/usage response, signup receipts the
original company/invoice acknowledgement. Protect platform.db and its backups accordingly.

Only completed 201 responses are stored, inside the same publication savepoint as local setup
and audit. Failed validation/setup stores no receipt. A stale competing candidate cannot commit
another workspace under the same scope/key: the unique insert conflict rolls publication back
and cleans its owned prepared file. An in-flight duplicate can encounter a file/catalog conflict
or transient writer error; retry the same key/details after the first request finishes. This is
not an in-flight promise queue or a multi-host/shared-filesystem certification.

Responses/verifiers expire 24 hours after creation. Startup/hourly housekeeping and keyed
requests null expired payloads/verifiers; a stopped server can retain them until its next sweep.
A minimal scope/key-hash/tenant-slug/expiry tombstone remains and rejects reuse permanently.
Do not delete tombstones as ordinary cleanup: doing so removes duplicate prevention. Retention,
legal holds and backup expiry require approved governance; pruning does not erase older backups.
No response is replayed for a missing or purged workspace. A restored older catalog may also
restore older receipt state; reconcile acknowledged operations before reopening writes.

The new verifier adds synchronous scrypt work to keyed creation/replay; public signup already
used synchronous credential hashing. The per-IP signup limiter is not a distributed capacity or
bot defense. Broader signup admission/async work and hosted abuse/capacity acceptance remain open.

## Remaining work

- Broader create/import/API retry coverage, signup work admission and distributed abuse/capacity
  acceptance; current receipt protection requires the same key and covered route.
- Signup, inquiry and payment reports have transactional alert intent and a bounded worker
  (owner-alert-outbox.md, business-alerts.md). Reviewed resend/provider reconciliation, backlog monitoring and broader
  notification acceptance remain. Uncertain sends require review, not automatic replay.
- Real provider, hosted filesystem, Windows, power-loss and multi-host acceptance, plus review
  of imported schema/credential state and legacy interrupted artifacts.
- Broader billing lifecycle acceptance, including commercial renewal/calendar rules; this fix
  does not change pricing policy, period calculation, payment settlement or external charging.

The receipt follow-up adds one control-plane table/index and no dependencies. No deployment
command or hosted-rollout acceptance is part of this increment. Prior release blockers stay
open. Research: SQLite's documented savepoint/nesting and writer transaction semantics:
https://www.sqlite.org/lang_savepoint.html and https://www.sqlite.org/lang_transaction.html .
See audit validation-results.md and catalog-setup-* evidence for exact completed tests.

Receipt evidence: tests/onboarding-receipts.test.ts and tests/e2e/creation-receipts.spec.ts;
creation-receipts-* audit evidence. Research reviewed 19 October 2026: Stripe idempotency practice
https://docs.stripe.com/api/idempotent_requests and OWASP password storage
https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html .
Our contract differs from Stripe: completed successes only, UUID-v4-only keys and permanent
tombstones. This is an application contract, not a claim that an Idempotency-Key RFC is final.

Notification follow-up: owner-alert-outbox.md and business-alerts.md supersede earlier immediate
signup/inquiry/payment alert limitations for the updated HTTP routes. Inquiry/payment requests
outside their covered keyed contracts still need reconciliation after a lost response. Updated
keyed payment reporting has the separate receipt contract linked below.


Separate financial follow-up: payment-report-retries.md covers updated keyed tenant payment
reports, including parsed attachment binding and lost-response replay. This does not extend
workspace creation receipts to other APIs/imports or certify payment settlement policy.


Website inquiries now have their own keyed receipt contract in inquiry-retries.md. This covers
updated same-page retries/edits and does not expand workspace/import receipts or remove broader
creation admission, legacy recovery or financial lifecycle gates.
