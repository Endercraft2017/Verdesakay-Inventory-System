# Durable inquiry and reported-payment alerts

Implemented 19 October 2026, following signup alert durability. See owner-alert-outbox.md for
shared provider deadlines, uncertainty/retry and maintenance rules. The complete release is
still on hold; this increment is not hosted/provider/accounting acceptance.

## Source transaction boundaries

The public website inquiry route keeps its host, schema, rate-limit and honeypot gates. It warms
mailbox schema before createInquiry. The helper initializes its own schema before a savepoint,
then inserts the inquiry and invokes a trusted synchronous catalog-only setup callback. The
HTTP caller enqueues enabled inquiry intent there. Any source/enqueue failure rolls both back;
only authored validation and a generic correlated storage failure reach the browser. A honeypot
submission produces no source or intent. Direct fixture/CLI calls without the callback retain
their no-email behavior; no provider I/O belongs in these callbacks.

Reported payments keep tenant admin/users.manage and online authority gates. submitPayment
prevalidates input, acquires the catalog writer, rechecks the invoice's tenant and terminal
state, then commits all of the following in one platform.db savepoint:

- proof and optional 2307 bytes in platform_durable_files;
- payment row, reporting audit and derived invoice state;
- prepared invoice response and eligible payment-alert intent from the HTTP callback.

An invalid second attachment, blob/payment/audit/invoice/alert write or callback error rolls the
whole operation back. Enabled intent failure deliberately refuses the report rather than
silently losing its alert. Mail disabled/off/without recipients does not block an otherwise
valid report and creates no historical alert backlog. Success means a report is recorded for
review, not that money was received or the invoice was confirmed paid. Confirm/reject/record,
refund, renewal and other financial lifecycle operations need their own acceptance; their full
transaction boundaries are not certified by this reporting fix.

## Proof storage and recovery

New payment proofs use random UUID filename components instead of a millisecond timestamp.
They are persisted only as catalog bytes inside the reporting transaction; no disk cache is
written before commit. This prevents caught failures or a pre-commit process exit from leaving
new unreferenced proof files/blobs, and avoids overwriting two reports made in one millisecond.
resolveBillingFile recreates a missing cache from durable bytes on download, with a private
0700 directory and 0600 temporary file on supported POSIX filesystems. Existing cached files,
legacy orphan artifacts and their permissions are not automatically changed or deleted.
Windows ACL, filesystem and actual power-loss acceptance remain separate.

Back up the catalog (including its WAL through supported backup operations) and financial
attachment records. Do not assume a disk cache is the sole copy of a new proof. Logical expiry
of an email's queued text does not delete the payment proof/2307 or financial record. Financial
retention/rights/legal holds, cache maintenance and backup expiry require their approved schedule.
MIME allowlisting/size limits and random names are not full content-signature, malware or safe
rendering assurance; see the existing upload/security release gates. This increment preserves
that acceptance gap rather than treating a client-supplied MIME type as proof of safe content.

## Separate business queue and source checks

platform_business_outbox is a new IF NOT EXISTS control-plane table/index with the same lifecycle
shape as the existing signup platform_owner_outbox. New inquiry/payment events never enter the
old signup table: an older signup-only worker cannot claim, misclassify or discard them. There
is no tenant schema version change or replication of these control-plane records.

Event keys inquiry:<positive inquiry ID> and payment:<positive payment ID> are unique per source.
An inquiry has empty tenant_slug because it precedes workspace creation. Payment jobs carry the
owning workspace slug. Signup keys/table remain unchanged. The current worker reads due candidates
from both tables and atomically claims one with state/due/attempt guards. A competing claim can
win; this pass then sends nothing and the next pass retries selection. No catalog transaction
spans provider I/O. Global ordering and a backlog delivery SLA are not promised.

Before sending, an inquiry must still exist. A payment must remain pending with an invoice in
its recorded, nonpurged workspace. Reviewed/missing/mismatched sources cancel as source_unavailable.
Signup still checks its workspace. These checks precede the send; later source changes cannot
recall mail already in flight. Mailbox/policy/credential generation changes cancel old unsent
information. All categories share conservative unknown handling, 429-only bounded retry, result/
attempt-log transaction and logical payload retention described in owner-alert-outbox.md.

The console's Owner alert delivery panel labels inquiries by source ID and payment jobs by
workspace/payment ID. The authenticated, no-store mail responses add kind and source_id without
exposing queued message, recipient snapshot or credential binding. The recent view remains
limited to 30 events across both tables, alongside queue-wide summary and filtered paginated
history described in owner-alert-monitoring.md. External escalation remains work.

## Mail configuration and credential pairing

Settings, encrypted secret and fallback key reference are captured by one SQLite SELECT. Sender,
host, recipient policy, binding and decrypted credential therefore come from one configuration
snapshot; a concurrent update cannot pair an old SMTP host with a new server's password. The
snapshot's secret is memory-only and is never returned by settings/binding/status APIs. A send
already authorized under a consistent old snapshot cannot be recalled when settings change.

savePlatformMail acquires the writer before merging and commits settings/key/secret together.
The console's validated change additionally nests that write with its provisioning audit and
response preparation. Secret-write or audit failure restores the complete previous configuration.
No transaction is kept open while sending. Existing secret encryption/master-key deployment and
backup acceptance remain; this is not a claim that catalog payloads are newly encrypted.

## Upgrade, rollback and unknown acknowledgements

Deploy/restore acceptance must include a compatible business-queue worker. An old app version
ignores new jobs in the separate table; it does not deliver, prune or show them. Keep compatible
processing/monitoring available or explicitly stop and reconcile before a downgrade. Do not
copy new jobs into the old table or rewrite their source/type to make an old worker accept them.
Older request-serving app versions retain their old immediate paths until replaced; the new
transaction guarantee applies to the updated routes. No rolling deployment was performed here.

Restoring an older catalog can remove later send/claim evidence. Reconcile source, provider and
financial records before reopening writes/worker processing. Never reset an unknown claim to
pending with SQL or infer nondelivery from a timeout. There is no new reviewed business-alert
resend/provider-reconciliation interface in this increment.

Source identity alone is not HTTP request idempotency: inquiry/payment POSTs outside their
covered same-key contracts can create distinct sources and alerts. Updated keyed requests use
inquiry-retries.md and payment-report-retries.md; a timeout outside those contracts requires checking
existing inquiry/payment records before resubmitting. This fix does not deduplicate bank charges,
references or user actions and does not establish exactly-once remote/inbox delivery. Wider
request receipts/admission and reviewed duplicate financial reconciliation remain engineering.

## Evidence and remaining gates

Real SQLite faults exercise inquiry enqueue plus payment blob/row/audit/invoice/intent failures,
invalid second upload and uncertain post-provider acknowledgement. Four child-process cases exit
before/after inquiry/payment commit: restart has no pre-commit records/bytes/event, or retains
one completed source/intent and sends once. A separate database connection changes mail generation
while a send captures its snapshot; host/password remain paired. Settings-secret and console-audit
faults restore the old configuration. Tests also cover source/tenant/auth, disabled policies,
legacy-worker isolation, same-millisecond names, lazy-cache reconstruction and proof privacy.

Chromium uses a real enquiry enqueue fault, retains the draft and verifies one corrected source/
alert plus redacted console status. Actual server startup/timer drains committed signup/inquiry/
payment intent once per category and leaves stale claims in both tables unknown without sending.
All provider traffic is synthetic/test-only; no real customer email or bank/provider action.

Remaining: retry receipts for inquiries and other endpoints, reconciliation of legacy, duplicate
and uncertain outcomes, and reviewed resend,
external backlog alerts/escalation, upload-content/security acceptance, financial lifecycle,
approved retention and live provider/restore/Windows/storage/capacity tests. Full scorecard
statuses remain unchanged. Exact results/failures are in audit business-alerts-* evidence.


Payment-request follow-up: payment-report-retries.md supersedes the no-HTTP-receipt limitation
above for updated keyed tenant payment reporting only. Distinct keys/actors and no-key clients
still create distinct reports. Website inquiries and broader reconciliation remain open.


Inquiry-request follow-up: inquiry-retries.md now covers updated keyed website submissions,
including constant acknowledgement and bounded public verifier work. No-key/new-page requests
and other API actions remain outside that contract; broader delivery reconciliation remains open.


## Delivery monitoring follow-up — 19 October 2026

Queue-wide counts, filtered keyset history and durable worker observations are implemented.
The latest-thirty view no longer defines the scope of review. See
[owner-alert monitoring](owner-alert-monitoring.md) for API parameters, thresholds, redaction, read failures,
triage and rollback. Unknown delivery remains no-resend; provider reconciliation, reviewed
recovery, external watchdog/escalation and real-host acceptance remain release gates.
Monitoring is scoped local evidence, not closure of a whole production control.
