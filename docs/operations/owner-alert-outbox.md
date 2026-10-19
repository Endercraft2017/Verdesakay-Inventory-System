# Owner-alert outbox

Implemented 19 October 2026, initially for POST /api/signup. Inquiry and reported-payment
alerts now use the same worker through a separate compatible queue; see business-alerts.md for
their source/proof/configuration transaction and upgrade rules. Customer recovery/tenant SMTP
and other application notifications remain outside this outbox.
See workspace-onboarding.md for creation receipts and provisioning-recovery.md for file recovery.
The complete release remains on hold; local tests are not hosted/provider acceptance.

## Transaction and worker

Signup warms mailbox schema before publication. When signup alerts are enabled, transport is
not off and recipients are present, its local setup callback inserts one platform_owner_outbox
row, keyed signup:<tenant slug>, inside the same platform.db savepoint as workspace setup,
applicable invoice, response receipt and core audit. Failure to persist enabled alert intent
fails/rolls back publication; no email is sent inside that transaction. Same-key response replay
does not enqueue another event. Disabled alerts, transport off or absent recipients enqueue
nothing and are not retroactively emailed when enabled. Incomplete active configuration can
queue an event that becomes blocked at send preflight; it never transmits without credentials.

The outbox snapshots authorized recipients, subject/text and an opaque SHA256 binding to mailbox
settings plus the encrypted credential generation. It contains no raw mailbox credential. A
settings/credential change cancels unsent old work instead of redirecting private information to
new recipients. That includes sender/alert-policy changes. In-flight mail cannot be recalled;
the adapter uses its original settings snapshot. Purged/missing workspaces are cancelled.

Cloud server.ts runs a nonoverlapping pass at startup and every 15 seconds, one job per pass.
A guarded UPDATE RETURNING claims a selected due candidate across processes using the same
SQLite catalog; selection and source checks are described in business-alerts.md.
No transaction spans network I/O. Provider result and the existing attempt log commit in a short
savepoint, guarded by job ID/claim time/attempt count. A failed acknowledgement/log write leaves
the durable claim uncertain; it does not silently return the job to the queue. This is bounded
polling, not a delivery SLA, distributed broker or hosted/shared-filesystem certification.

## States and retry rules

| State | Meaning and automatic action |
|---|---|
| pending | Committed intent awaiting its first claim |
| inflight | Durable claim; provider acceptance may become possible. No other worker resends it |
| retry | Explicit Brevo HTTP 429 rejection; persisted exponential backoff, at most five total attempts |
| accepted | Brevo HTTP 201, or SMTP accepted every intended recipient with no rejected recipients. Not inbox delivery |
| blocked | Preflight configuration/credential issue, explicit provider 4xx rejection, or exhausted retry budget; no automatic resend |
| unknown | Network/timeout/unexpected status, partial SMTP acceptance, interrupted claim or uncertain acknowledgement; no automatic resend |
| cancelled | Configuration changed, workspace unavailable or event expired; no automatic resend |

Brevo uses a 15-second AbortSignal deadline and refuses redirects. Only 201 is classified as
accepted; other 2xx/3xx/5xx outcomes are conservatively unknown. Error bodies and raw exception
messages are not persisted or exposed by new sends. HTTP 429 waits at least 1/2/4/8 minutes
between the first four retries; valid Retry-After seconds/date can extend that wait. A delay
beyond seven days cannot send early because the event expires. The fifth rejection blocks.
Other 4xx responses block for review rather than being retried automatically.

SMTP requires implicit TLS or STARTTLS, retains default certificate validation, uses 15-second
DNS/connection/greeting/idle timeouts and a 45-second overall adapter deadline. SMTP exceptions, including server-side authentication/connection rejection, are conservatively
unknown rather than inferred safe retries. Partial acceptance
is unknown, so already-accepted recipients are not automatically mailed again. The adapter owns the TCP socket and destroys it on completion/deadline, then closes the
transport. This matters because the installed non-pooled Nodemailer close method alone does
not abort an active send. A real stalled local SMTP connection verifies socket teardown. A close failure or lost response remains unknown.
These changes also apply to the shared platform immediate/test-mail adapter; tenant SMTP is
separate. Previously stored legacy provider diagnostics are not retroactively scrubbed here.

A claim older than two minutes becomes unknown. It is never stolen/requeued: the dead or paused
worker may already have sent. A later acknowledgement cannot overwrite a state whose claim
changed. Pending/retry events older than seven days are cancelled. Other events can progress
while a prior event waits or requires attention; global delivery ordering is not guaranteed.

## Console and incident procedure

Owner console → Email alerts → Owner alert delivery shows the latest 30 event states and
attempt counts. Refresh preserves the current status if loading fails. GET /_platform/api/mail
adds an outbox field with ID, kind/source ID, tenant slug, state, attempts, safe code and lifecycle times only;
queued message, recipients, credential/configuration binding and raw provider diagnostics are
not exposed there. Existing console authentication/read policy applies; owner-console API responses, including
authentication denial, carry Cache-Control: no-store. There is no blind retry
button or new route that bypasses recent-proof requirements. Unexpected async test-mail database/log failures reach a generic correlated 500; they are not
left as unhandled promise rejections. Test mail uses the shared console
API client, including cookie/CSRF/fresh-proof handling; it is separate from queued owner alerts.

For blocked/unknown work, correlate the company and event time with the existing attempt log and
the configured provider's restricted delivery records. Accepted does not prove inbox receipt;
check bounces/spam/provider records as appropriate. Do not reset unknown/inflight state with SQL,
resend a customer alert as a test email, or assume timeout proves failure. There is no automatic
provider reconciliation or reviewed business-alert resend interface in this increment. Escalate
uncertain delivery and record the decision before any separately authorized manual notification.
The source workspace/invoice remains authoritative even if its alert needs attention.

After restoring a catalog backup, keep the worker stopped until previously acknowledged/pending
operations are reconciled against provider records. An old restored pending row can lose later
claim/acceptance evidence; the local outbox cannot prove whether it was sent after that backup.
Monitor worker failures/queue age and review older-than-30 events through the authenticated
filtered history (owner-alert-monitoring.md). External monitoring and escalation still need acceptance.

## Storage and retention

platform_owner_outbox (signup) and platform_business_outbox (inquiry/payment) are control-plane
IF NOT EXISTS tables/indexes, outside tenant schema,
replication and offline queues. Payloads contain company/contact/invoice acknowledgement data.
They are ordinary private catalog data, not newly encrypted application fields; protect the
catalog, volume, logs, snapshots and provider access. No mailbox bearer/password is copied into
an event. The configuration binding includes encrypted credential bytes, not a cheap password
verifier. Exact provider message IDs/full responses are not stored or exposed by this adapter.

Worker maintenance logically nulls recipients, subject, body and configuration binding for
terminal states after 24 hours, and any remaining payload after seven days. A stopped/non-cloud
worker can retain payload until its next sweep. IDs/event key/tenant slug/state/attempts/times/
safe codes remain as duplicate-prevention/operational metadata; legal retention is not approved
by this implementation. Existing platform_mail_log retention is unchanged. Nulling is not a
forensic wipe of SQLite pages, WAL or backups. Do not delete event identities as routine cleanup
without an approved scoped reconciliation/retention procedure.

## Verification and remaining work

Real SQLite faults cover enqueue rollback and acceptance/log-write failure. Tests cover durable
catalog reopen, one local claim, disabled/configuration/credential changes, purged workspace,
rate rejection/budget/Retry-After, generic provider failure, partial SMTP acceptance/deadline,
retention and console authorization/redaction. Separate child processes exit before claim commit,
after claim and after simulated provider acceptance; restart sends only the safe pending event,
while durable claims become unknown without replay. Actual server startup drains committed test
intent and preserves an interrupted claim. Chromium verifies uncertainty/status refresh failure
without a retry action. No real emails/provider credentials/customer data are used.

Remaining: wider HTTP retry receipts/notification coverage, provider reconciliation/reviewed resend, external backlog
alerting/escalation, queue capacity/load, approved retention, restore/hosting/Windows acceptance
and real Brevo/SMTP acceptance. This increment does not establish exactly-once remote delivery,
all-notification durability, CI-green, complete-control PASS or production rollout verification.

Primary sources reviewed 19 October 2026:
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- https://developers.brevo.com/reference/send-transac-email
- https://developers.brevo.com/docs/api-limits
- https://nodemailer.com/smtp
- https://www.rfc-editor.org/rfc/rfc5321.html

See docs/audits/validation-results.md and owner-outbox-* evidence for exact results and failures.


## Delivery monitoring follow-up — 19 October 2026

Queue-wide counts, filtered keyset history and durable worker observations are implemented.
The latest-thirty view no longer defines the scope of review. See
[owner-alert monitoring](owner-alert-monitoring.md) for API parameters, thresholds, redaction, read failures,
triage and rollback. Unknown delivery remains no-resend; provider reconciliation, reviewed
recovery, external watchdog/escalation and real-host acceptance remain release gates.
Monitoring is scoped local evidence, not closure of a whole production control.
