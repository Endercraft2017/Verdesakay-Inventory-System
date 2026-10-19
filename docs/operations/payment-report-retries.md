# Payment-report retry receipts

Implemented 19 October 2026 on the tenant's online POST
/api/tenant/billing/invoices/:id/payments. This extends the atomic source/proof/alert transaction
in business-alerts.md. The complete production release remains on hold.

## Request and replay contract

Updated desktop Billing sends a random UUID-v4 Idempotency-Key on each report attempt. The key
is scoped to the current tenant, authenticated actor ID and payment-report route family. It is
not a bank reference or proof of payment. Same tenant/actor/key with matching details returns
the original successful 201 body and Idempotency-Replayed: true, without another payment,
proof BLOB, reporting audit or alert. Both original and replay responses use no-store.

Binding includes invoice ID, method, trimmed reference/note, canonical centavos, paid date,
attachment MIME type and SHA256 of proof/optional 2307 bytes. Different multipart boundaries,
field order, attachment filenames and equivalent amount formatting do not change the request.
Changed bound details conflict with 409. The request digest is protected by the existing slow,
salted scrypt verifier; raw request, proof bytes and raw key are not added to the receipt table.
The receipt's stored response is ordinary private catalog financial data, not newly encrypted.

The existing authentication, current users.manage permission and online authority gates run
before upload parsing/receipt lookup. No new bypass or recent-proof policy is introduced. A
matching receipt also requires the original payment/invoice in the same nonpurged workspace.
Review/confirmation may have happened since the original acknowledgement: replay deliberately
returns the original snapshot; GET Billing returns current financial state. Replay never confirms
a transfer or reapplies an operator review. A missing/reassigned source requires support review.

Only successful responses are saved, synchronously inside submitPayment after response/alert
preparation. Receipt persistence and source/proof/audit/invoice/intent commit together. A receipt
fault rolls them back. A stale competing candidate cannot insert the same receipt: its source
transaction rolls back with 409. Retry the exact request; it then reads the winner's receipt.
No transaction spans provider calls and no remote money movement is performed by reporting.

## Browser uncertainty and correction

The form snapshots its FormData and key on first validated submission. During an uncertain
network/500/conflict result, fields stay disabled and the retry button uses the same bytes/key.
It explains that the result is unconfirmed and offers retry or checking Billing before starting
another report. An explicit 400 has not created a successful receipt: inputs unlock for
correction and the next attempt gets a new key. Normal in-flight modal dismissal guards remain.
A successful acknowledgement closes the form and refreshes Billing from the server.

Keys and attachments remain in that modal's memory only; closing/reloading, session expiry,
opening a new modal or using a different administrator/key is outside this retry guarantee.
Check existing reports before starting again. Unsupported/insecure browsers cannot generate the
required random UUID and are asked to use a current browser on a secure connection. No financial
proof or pending submission is copied into browser localStorage for this feature.

## General cache and legacy requests

This POST bypasses shared/idempotency.ts in app.ts, including Express case-insensitive and
trailing-slash URL aliases. That generic middleware runs before multipart
parsing and route permission gates; it cannot safely bind this upload or atomically persist a
control-plane payment outcome. Its other endpoints are unchanged. New payment receipts do not
create a second tenant cache entry and are outside tenant sync/offline replication.

Known old generic raw/scoped key entries are refused with 409 instead of replayed or reapplied.
Lookup checks exact, lowercase and uppercase UUID forms. A legacy arbitrary mixed-case key whose
original spelling is lost cannot be exhaustively recovered from its stored hash. Pruned old
cache entries, old reports made without keys and already duplicated reports still require
reconciliation. No universal migration/deduplication of legacy reports is claimed.

No-key API clients retain their previous behavior and can create multiple reports. The same
bank reference can legitimately occur in separate sources/actors; there is no new global
reference uniqueness rule or guarantee that different keys/administrators represent one transfer.
Website inquiries, other API actions and financial confirm/reject/refund/renewal operations do
not gain request receipts from this increment.

## Storage, expiry, backup and rollback

platform_payment_report_receipts is a new IF NOT EXISTS control-plane table/index, without a
tenant schema bump. It stores tenant slug, actor ID, SHA256 of random key, salted request verifier,
original invoice response, payment ID and expiry. Startup/hourly/keyed-request housekeeping
nulls response/verifier after 24 hours. Minimal tenant/actor/key-hash/payment/expiry tombstones
remain so the same key cannot become a new report after expiry. An expired request returns 409:
check Billing and reconcile; do not delete the tombstone to retry. A stopped server may retain
payload longer. Legal retention/holds, encrypted backup and eventual scoped metadata erasure
still require approval. Logical nulling is not a forensic wipe of database pages/WAL/backups.

Back up the catalog through supported operations. Restoring an older catalog can lose receipts
and later report/provider/bank evidence; reconcile before reopening reporting/worker processing.
An older writer version ignores these receipts and may use the unsafe generic multipart cache.
Do not roll back request-serving versions while allowing uncertain report retries; stop writes
and reconcile or keep a compatible writer. Keeping only the newer email worker is insufficient
for this request-receipt guarantee. No rolling upgrade, hosted restore or power-loss test was
performed by local verification.

## Evidence and remaining work

Vitest covers replay/catalog reopen, changes to fields/invoice/proof/MIME/2307, current auth and
role downgrade, actor/tenant scope, invalid keys, disabled legacy behavior, old-cache quarantine,
validation correction, receipt fault rollback, competing candidates, reviewed/missing sources,
expiry and two real process exits before/after receipt commit. The child-exit recovery removes
its deliberately persistent crash trigger before retrying; no production recovery trigger exists.
Frontend tests cover retained bytes/key and correction after 400. Chromium drops a real committed
HTTP response and verifies one payment plus successful same-key replay and current Billing state.

Exact results and initial failures are in audits/evidence/payment-receipts-* and validation-results.md.
Initial testing exposed the middleware interception conflict; subsequent fixture corrections
respect the fixed admin permission model, NOT NULL overrides and required child bootstrap password.
A dedicated case reproduced generic-cache interception on an alternate-case URL; the exemption
now handles that alias. A preliminary full run was interrupted with exit 130 to include the fix
and is not counted as complete. No genuine failure is hidden as a passing run. Remaining engineering: inquiry/other API receipts,
legacy/duplicate/financial/provider reconciliation, reviewed resend, backlog escalation, upload
content/security, broader settlement lifecycle and existing device/hosting/capacity/governance
release gates. Complete-control totals and release hold remain unchanged.
