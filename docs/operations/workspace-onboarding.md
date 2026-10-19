# Workspace onboarding transaction and recovery

Updated 19 October 2026. This describes implemented local behavior; release acceptance is
tracked in the audit scorecard. See provisioning-recovery.md for database/file interruption.

## Boundaries and ordering

Both callers validate their input before provisioning. The core exclusively reserves and
prepares the tenant database, including chosen owner credentials. It then starts the catalog
publication savepoint in platform.db and inserts the tenant/company ID. A trusted synchronous
setup callback runs on the same catalog connection before the core creation audit and release.
No await, mail, provider call or tenant/file mutation belongs in that callback. Tenant database
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
| Successful setup, failed HTTP acknowledgement | Committed workspace remains; exact explicit slug conflicts on another create | No durable response-replay receipt implemented |
| Notification fails or process exits after commit | Local workspace remains ready; delivery may be lost | Notification delivery is still best effort |
| File cleanup fails or ownership is uncertain | Preserve artifacts and emit safe cleanup event | Core recovery tests and runbook |

Signup routes now expose only authored typed validation/conflict errors. Unexpected exceptions
become generic 500 with server request ID. Raw status/expose properties and provider/storage
messages do not determine public feedback at this boundary.

## Retry and operator procedure

A reported setup failure that rolled back is retryable through the normal form with the same
explicit slug after resolving its underlying cause. The browser retains the signup fields;
the test retries the same company, then verifies one first invoice and the payment lock through
the tenant billing API. Tests send no real owner email.

A timeout or lost response is an unknown acknowledgement, not proof of rollback. Check the
catalog/audit and existing invoice before creating another company. Console creation with an
automatically generated slug can still create another workspace on repeated submissions. Do
not delete or reissue an existing first invoice merely because the original request timed out.
Interrupted unregistered files require the stopped-writer review/quarantine procedure in
provisioning-recovery.md. No automatic adoption or destructive cleanup is provided.

## Remaining work

- Durable principal-bound idempotency/response receipts for create and signup, including the
  console's generated slugs, concurrent duplicate submissions and expiration policy.
- A transactional notification outbox and bounded worker with retry, delivery/unknown state,
  redaction and operational alerting. Current owner notification runs only after local commit
  and is best effort; it is not part of a database transaction or exactly-once delivery promise.
- Real provider, hosted filesystem, Windows, power-loss and multi-host acceptance, plus review
  of imported schema/credential state and legacy interrupted artifacts.
- Broader billing lifecycle acceptance, including commercial renewal/calendar rules; this fix
  does not change pricing policy, period calculation, payment settlement or external charging.

This increment adds no schema or dependency and deploys nothing. Prior release blockers stay
open. Research: SQLite's documented savepoint/nesting and writer transaction semantics:
https://www.sqlite.org/lang_savepoint.html and https://www.sqlite.org/lang_transaction.html .
See audit validation-results.md and catalog-setup-* evidence for exact completed tests.
