# Signup alert durability — 19 October 2026

Base fde2dd3d69c4fad2c894f86a1eae68219df419bd, production.

High scoped gap: best-effort owner notification occurred after committed signup/local setup,
so process interruption could lose the alert. Enabled signup intent now commits inside catalog
publication with setup/invoice/creation receipt/audit; enqueue failure rolls it all back. One
control-plane outbox table/index adds durable event identity, recipient/message snapshot,
opaque settings/encrypted-credential binding and delivery lifecycle. Disabled mail/no recipients
has no historical backlog; incomplete active mail can block safely at worker preflight.

The cloud worker claims one eligible event atomically at startup/every 15 seconds, with no
transaction spanning the provider call. Guarded result and attempt log share a short savepoint.
Brevo 429 alone is retryable: persisted exponential backoff, valid Retry-After and five total
attempts. HTTP 201/all-recipient SMTP acceptance is not inbox delivery. Unknown/timeouts/partial
acceptance/interrupted claims never automatically resend. Changed mailbox/credential generation
or unavailable tenant cancels old unsent work; already-inflight information cannot be recalled.
The shared platform adapter now requires SMTP TLS, bounds duration, refuses Brevo redirects and
stores authored error codes rather than raw provider bodies/exceptions. Tenant SMTP is separate.

A relevant secondary defect was found in review: async console test-mail logging/database errors
could reject outside Express 4's error boundary. The handler now forwards unexpected errors as a
generic correlated 500. Owner-console API responses now use no-store, including auth denial.
The mail screen uses the shared API client for test sends and adds read-only redacted signup
status/refresh with no blind resend action. Queued message/recipient/credential binding is not
exposed in the new outbox response field; existing authorized settings/log fields remain.

Tests use real isolated HTTP/SQLite, provider mocks and child processes. Faults cover enqueue
rollback and post-provider acknowledgement/log failure. Cases cover catalog reopen, concurrent
local claims, disabled/configuration/credential/tenant changes, rate rejection/budget/Retry-After,
generic provider uncertainty, partial SMTP acceptance/deadline, retention, auth/redaction/cache
and async console errors. Three process exits prove pending work survives a pre-commit claim
interruption, while committed claims after claim/provider acceptance become unknown on restart
without another send. The concurrent claim unit case uses the same process; no simultaneous
multi-host test or shared-volume certification is inferred. Actual server startup drains committed
synthetic intent and preserves stale-claim uncertainty. Chromium status refresh fails/retries
without sending or exposing the queued message. No real emails or provider/customer secrets used.

Initial verification: two process cases collided on the same temporary directory (EEXIST); each
now has its own directory. The initial 2-failure/56-pass report is retained as a fixture failure,
not a product defect. The corrected intermediate focused run passed 59 cases; final focused
cases include Retry-After, TLS/deadline, async error and private-cache checks. Two preliminary full runs were deliberately interrupted with exit 130: first to include the
console fixes, then to correct an actual SMTP resource-cancellation gap found in installed
Nodemailer source. Its transport close method does not abort active I/O; the adapter now owns/
destroys its socket, with a real local stalled-connection test. Neither run is a completed pass. First and final browser runs and the final full run are separately
identified in verification/results. Runtime/tests were frozen before the final completed full run; documentation/evidence followed.
An intermediate typecheck rejected unsupported address-object handling against the installed
string-list result type; it was removed before final verification. That compiler output is retained.

Primary research reviewed 19 October 2026: AWS outbox guidance, Brevo send/rate-limit docs,
Nodemailer SMTP options and RFC 5321 (links in standards-research.md and the runbook). AWS guidance
informs local intent atomicity, not a claim that a broker was provisioned. An inaccessible guessed
Brevo rate-limit-header URL was not used as proof. Retry-After is an explicit local generic HTTP
contract. No exactly-once provider/inbox guarantee or certification is claimed.

Retention is logical: terminal payload+recipient/configuration binding null after 24 hours,
any payload after seven days on worker maintenance. Event/tenant/state metadata remains;
backup/WAL/provider logs and legal approval are separate. Restored older pending state requires
reconciliation before worker restart. Inquiry/payment transactional intent, provider reconciliation/
reviewed resend, backlog monitoring/external alerts, capacity and live/hosted/device acceptance
remain engineering/release work. No new dependency/tenant schema version, advisory snapshot,
all-control PASS, CI-green or hosted rollout verification is claimed. Complete-control totals
remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release hold remains.

Documentation: operations/owner-alert-outbox.md, onboarding/API/release procedures, module catalog/
pipelines, governance/draft privacy, engineering handoff, research, scorecard metadata and results.
