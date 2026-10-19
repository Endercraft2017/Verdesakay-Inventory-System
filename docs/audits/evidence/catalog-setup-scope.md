# Atomic local workspace setup — 19 October 2026

Base: a497c029079abe9b6b63386ebd757ae40a2e8e92, production.

High scoped findings: public signup registered an active workspace before applying payment lock,
subscription/contact data and a first invoice. Console module/payment/inquiry setup followed
registration too. Later local failures could leave partial setup. Standalone createInvoice
committed before its audit insertion, so an audit failure could report failure after issuance.

Implemented: core create accepts a trusted synchronous catalog-only setup callback inside its
publication savepoint. Public signup and console creation put all covered local setup there.
Billing/contact schemas initialize before the rollbackable transaction so lazy schema caches
cannot retain a ready flag for rolled-back tables. Invoice numbering, row and audit share a
nested savepoint, with a write statement acquiring the catalog writer before sequence reads.
Standalone issuance uses the same boundary. Public signup now preserves only authored typed
validation/conflict feedback; unexpected status/message properties become generic correlated
500s. External owner notification starts only after commit and remains best effort.

New tests inject real SQLite failures at payment-lock, subscription, owner-contact, invoice,
invoice audit and final publication audit steps. They assert no catalog/local setup/audit rows,
owned DB cleanup, no owner alert on failure and one successful same-slug retry. Console inquiry
linkage rollback and standalone invoice audit rollback/retry are covered. A child process exits
after local setup but before final publication: its restarted database has no tenant, invoice,
owner-contact or provisioning log, while its unregistered tenant file is preserved.

The real website browser test fails first-invoice creation once, preserves form fields, retries
the same workspace, then verifies the payment lock and exactly one invoice through tenant login
and billing. Its first draft tried to read a response body after navigation; the test now checks
persisted billing state after redirect. No production website behavior was changed for that
fixture error. Initial new unit tests imported an original mocked module before test environment
setup, leaving signup/console disabled; fixture imports were corrected. Initial reports remain
available and are not described as product defects.

Research: SQLite savepoints and transaction/writer semantics, accessed 19 October 2026:
https://www.sqlite.org/lang_savepoint.html
https://www.sqlite.org/lang_transaction.html
Nested BEGIN/COMMIT is unsuitable here; savepoint release does not commit an enclosing signup.
Fault and real process-exit tests supplement that design rationale; no power-loss or shared-host
capacity certification is inferred.

Remaining: durable response receipts/idempotency, concurrent/generated-slug duplicates, reliable
notification outbox/retry, broader billing/calendar/commercial acceptance, imported state review
and external release gates. Lost HTTP acknowledgements can follow a committed workspace; do
not infer rollback from a client timeout. No exactly-once delivery, automatic orphan adoption,
all-control PASS, schema/dependency change, live account mutation or deployment is claimed.

Documentation: docs/audits/README.md (evidence map), operations/workspace-onboarding.md (exact
flow/failure matrix/retry/remaining work), operations/provisioning-recovery.md (artifact recovery),
module catalog/pipelines, engineering handoff, scorecard metadata and dated validation results.
