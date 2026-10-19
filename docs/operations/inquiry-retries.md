# Website inquiry retries

Implemented 19 October 2026 for the public POST /site/inquiry. This closes the scoped duplicate
inquiry/owner-alert gap after a lost HTTP response. The complete release remains on hold.

## Public contract and atomicity

Updated website/app.js creates one random UUID-v4 Idempotency-Key for the contact form on its
page. The route retains its site-host, schema, honeypot and per-IP rate-limit gates before receipt
work. No-key clients retain their old behavior. A bot honeypot still returns harmless 201 without
source, receipt or alert, even if its key is malformed. Case-insensitive/trailing-slash site URL
aliases use the same receipt implementation; this route is outside the generic /api retry cache.

A covered successful inquiry commits source row, eligible owner-alert intent and a successful
receipt in one catalog savepoint. Receipt or enabled-alert failure rolls the whole operation
back. Matching key/details returns only 201 {ok:true} plus Idempotency-Replayed: true, without
another inquiry or alert. Original/replayed acknowledgements use no-store. The public response
contains no contact/message/source ID or owner data. A key is not authentication or a way to
read inquiry records. The source must still exist; deleted/expired/mismatched requests conflict.

Binding covers parsed/trimmed name, company, lowercased email, phone, employee band, ordered module
list and message. Missing/empty optional phone/employee/message values normalize together;
unknown schema-stripped fields and empty honeypot do not affect intent. Changed meaningful
fields return generic 409 without echoing the original. Module ordering remains significant.
A stale competing candidate cannot insert another receipt: its source transaction rolls back,
and an exact later retry reads the winner. Only successful completions are recorded; validation,
busy and rolled-back failures do not consume a successful key.

## Browser edits and uncertainty

One form/page retains its key across retries, edits and HTTP failures. A failed pre-commit attempt
can be corrected with that key; if an earlier uncertain attempt actually committed, changed
fields conflict instead of silently becoming a new inquiry. Restore the original message and
retry, or contact support before starting another form. The key is never automatically rotated
on an error. The send button guards concurrent submissions; drafts remain when sending fails.
The thank-you state requires an actual 201 JSON acknowledgement with ok:true; an unrelated
successful HTML/empty response does not falsely confirm the inquiry.

The key lives only in page memory. Reloading, opening a new page or using another/no key is outside
this duplicate protection. It does not deduplicate every email/company/message across customers.
A new page can create another inquiry. No private draft or key is newly copied into localStorage.
A current browser on a secure connection is needed for cryptographic UUID generation.
Each attempt has a 20-second application timer using AbortController, including response-body
reading, cleared on completion. On abort, the form reports uncertainty and enables retry with
its existing key/draft. Browser scheduling/suspension can delay timers; this is not a hosted
latency SLA. Aborting does not roll back a server commit. Reload starts a new unprotected request.

## Work budget and rate limiting

The request digest is protected by the existing salted scrypt format, using bounded asynchronous
work outside any catalog savepoint. Native crypto yields to the event loop. New bindings and
verification share password-work.ts with public sign-in: one active job, eight waiting jobs,
ten-second queue wait. Saturation returns authored 503 with Retry-After: 5 and no source/receipt.
This bounds concurrency/memory; it is not an independent inquiry worker or guaranteed login SLA.
Distributed abuse can still compete for that shared budget and requires edge/hosting acceptance.

After awaited verification, live receipt/verifier/source/expiry are checked again before replay.
New-candidate work may race a winner, but receipt uniqueness rolls its writes back. No network
or asynchronous work runs inside createInquiry's trusted synchronous callback. Existing signup
and authenticated payment helpers are not converted to asynchronous hashing by this increment.

The existing five-per-hour per-IP limiter counts all attempts, including matching replays. It
runs before verifier work; clients cannot skip abuse controls by supplying a key. A genuine user
may need to wait/contact support after several failures. Test mode normally skips this limiter;
a dedicated case enables its production behavior and checks five responses then a 429 with one
source. No distributed load, multi-host limiter or production capacity certification is claimed.

## Storage, cleanup and recovery

platform_inquiry_receipts is an additive IF NOT EXISTS platform table/index, outside tenant
replication and without a tenant schema bump. It holds only hashed random key, salted verifier,
inquiry ID and expiry. No raw key/request/contact/message or private response is added. The
inquiry source, queued owner message and provider copies retain their separate data policies.
Startup/hourly/keyed-request housekeeping nulls expired verifiers after 24 hours. Minimal hashed
key/source/expiry tombstones remain to prevent an old key from becoming another submission.
Expired requests return 409. A stopped server may retain verifiers longer. Legal retention,
scoped erasure/holds, encrypted backups and eventual marker expiry still require approval.
Logical nulling is not forensic removal from SQLite pages/WAL/backups.

Back up the catalog through supported operations. An older backup can lose later inquiry/receipt/
send evidence; reconcile before reopening submissions/workers. An older request-serving version
ignores inquiry receipts and can create duplicates. Use compatible writers or stop/reconcile
before rollback; a compatible email worker alone does not provide request replay. No rolling
upgrade, power-loss, hosted restore or real provider/Windows acceptance was performed here.
Do not delete a tombstone or resend an unknown alert to force a successful retry.

## Verification and remaining gaps

Tests cover field changes, normalization, host/schema/honeypot gates, key validation, legacy/new
keys, URL aliases, receipt/alert faults, stale and actual concurrent HTTP candidates, catalog
reopen, expiry/source deletion, two process exits, queue saturation, event-loop responsiveness,
changes during awaited verification and actual production rate-limit behavior. Chromium loses
a real committed response, rejects changed details on the same key, restores the original and
replays; owner APIs then show one source and one alert. Another browser case retains the draft
and corrects a real pre-commit enqueue failure using its existing form. A controlled browser
clock advances the deadline after the server commits but withholds its response, then verifies
same-key replay. The timer is not tested as a real hosting/network SLA.

Exact results and compiler corrections are in audit inquiry-receipts-* evidence and
validation-results.md. Synthetic data/test transports only; no live inquiry/provider/customer
email action. Remaining: other API/import retry coverage, no-key/new-page/legacy duplicates,
backlog monitoring/provider reconciliation/reviewed resend, upload and broader financial/security
work, shared-work admission/capacity and real hosted/device/restore/governance release gates.
Whole-control totals and release hold stay unchanged; this is not full app readiness approval.
