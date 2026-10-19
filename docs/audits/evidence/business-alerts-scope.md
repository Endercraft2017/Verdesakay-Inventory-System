# Inquiry/payment alert durability — 19 October 2026

Base 2c868a5f9c335725ca481e2cedde1b3394d7dc6d, production.

High scoped gap: inquiry and reported-payment notification intent previously occurred after
source commit and could disappear on interruption. Enabled intent now commits with its source.
Payment proof/2307 durable bytes, payment row, reporting audit, invoice update and prepared
HTTP response share the catalog savepoint. A second attachment/write/enqueue fault rolls all
back. UUID names replace timestamp collisions; disk caches are created privately on download.

A separate platform_business_outbox prevents older signup-only workers from misclassifying
new kinds. Current worker guards one due claim across both queues, checks source/tenant/pending
payment state, preserves unknown outcomes and never automatically replays uncertain claims.
Console status adds kind/source_id without private payload. Disabled policies have no backlog.

High credential-safety gap: separate settings/secret reads could pair different configuration
generations. A single SELECT now captures settings, encrypted secret and key reference. A
second database connection changes settings/secret immediately after capture in a focused
test; SMTP receives the consistent old host/user/password. Settings/key/secret writes are
atomic and the console nests them with audit/response preparation. Faults restore old values.
No raw mailbox secrets are returned by settings/binding/status APIs.

Twenty-two new business cases cover actual SQLite HTTP faults, auth/tenant/disabled policy,
reviewed/missing/mismatched sources, legacy-worker isolation, durable proof/lazy private cache,
same-millisecond reports and uncertain post-provider acknowledgement. Four actual child exits
occur before/after inquiry/payment commit: pre-commit source/blob/intent rolls back; committed
source/event survives restart and sends once through synthetic transport. Three new mail
snapshot cases cover concurrent generation changes, secret-write failure and audit rollback.
The actual server startup/timer smoke accepts one queued synthetic signup/inquiry/payment
each and leaves stale claims in both tables unknown without another send.

Chromium injects a real inquiry enqueue fault, retains draft, accepts corrected retry, verifies
one source/event and reads redacted console status. Initial browser run had one locator failure
(Email matched both textbox and module checkbox), with 19 passing; the textbox role is explicit
now. Initial focused run had one nonexistent-company fixture error with 17 passing; it now uses
an actual other tenant. These are fixture corrections, not repaired product defects. Raw initial
text/browser JSON retained; failed screenshots/traces were overwritten by later browser runs.
An intermediate typecheck caught loss of state field inference in object-rest projection; an
explicit result-row type corrected it. That initial compiler output was overwritten, not retained.
Final focused run: six files/91 cases. Final runtime/tests were frozen before the completed
full regression; documentation/evidence followed. Exact final outcomes are in verification JSON.

Research: SQLite savepoints, atomic commit and WAL, AWS transactional outbox, OWASP File Upload
Cheat Sheet (standards-research.md). Rollback-journal discussion is not applied as WAL deployment
certification. Process exit is not power-loss/storage/Windows acceptance. Client MIME allowlisting
is not content-signature/malware validation. No provider/customer email or bank action occurred.

No HTTP request receipts for these routes: separate POSTs create separate sources/events.
Financial settlement/refund/renewal lifecycle, upload content/security, legacy/duplicate/provider
reconciliation and reviewed resend, backlog escalation, approved retention, compatible-worker
upgrade/restore and real provider/hosting/device/capacity acceptance remain open. New proof bytes
follow financial retention, not email expiry. Older app writers retain immediate behavior until
upgraded; old workers ignore the new queue. Logical pruning is not forensic backup/WAL erasure.
No dependency/advisory snapshot, tenant schema bump, deployment/CI-green/production-ready or
complete-control PASS claim. Totals remain 36 PASS/58 FAIL/126 UNVERIFIED/13 N/A; release hold stays.

Documentation: business-alerts/owner-alert-outbox runbooks, onboarding/API/release procedures,
module catalog/pipelines, governance/draft privacy, readiness, handoff, standards, scorecard,
validation-results and business-alerts-* evidence.
