# Payment-report receipts — 19 October 2026

Base e254ae4e7d8e9bdb25f68444d53dcc794f882ce0, production.

High scoped duplicate-report gap: a committed report whose HTTP response was lost could be
submitted again. Updated desktop captures exact FormData and UUID-v4 key; matching tenant/actor/
key/details replays original 201 without another payment/proof/audit/alert. A successful receipt
shares the source catalog savepoint; a competing insert or receipt fault rolls source writes
back. Binding includes normalized fields/invoice/MIME/proof and optional 2307 bytes. Filenames,
multipart boundaries and equivalent amounts do not change intent. Slow salted verifier protects
private references/notes; no raw request/key/proof is added to the receipt table.

Focused testing exposed a real middleware interaction: shared generic idempotency intercepted
this route before multipart parsing and users.manage. It returned cached 201s for changed bytes,
expired receipt and reassigned invoice tests. The route now bypasses it and performs receipt
lookup after current auth/permission/online gates and upload parsing. Known exact/common UUID
case variants of old tenant-cache keys conflict for review. Other generic-cache endpoints are
unchanged; legacy reports and arbitrary lost mixed-case keys are not fully migrated/deduplicated.

Initial four-file run: 59 passed/13 failed. Ten failures exposed generic middleware interception
(eight changed-field/file cases plus expiry and source reassignment). Three were fixtures:
permission override cleanup used NULL on a NOT NULL field, and two child processes omitted their
bootstrap ADMIN_PASSWORD. Intermediate five-file run: 84 passed/two failed; fixed-admin roles
ignore user permission overrides by design, so the test now downgrades the role; restart also
removes its deliberately persistent exit trigger before retry. These fixture corrections are
not claimed as product defects. First corrected focused run: five files/89 passed.

Final route review then identified the Express case-insensitive URL edge. A dedicated failing
case reproduced old generic replay of changed bytes on /Tenant/Billing/Invoices/:id/Payments/.
The payment-cache exemption is now case-insensitive and a new regression checks changed-byte
conflict plus matching replay on that trailing-slash alias. One preliminary full run was stopped
with exit 130 to include this fix; its output is retained and is not a completed pass. A fresh
focused/browser/full verification follows the correction.

Initial Chromium run: 20 passed/one failed. The new form completed lost-response replay and UI
assertions, but its final APIRequestContext GET omitted X-Tenant and returned 401. The test now
includes tenant scope. Initial text/JSON retained; trace/screenshot were overwritten by rerun.
Exact final browser/full/type/secret results are in verification JSON and validation-results.md.

Twenty-seven new receipt cases cover replay/reopen, field/invoice/proof/MIME/2307 binding, current
auth/role downgrade, actor/tenant scope, invalid keys, no-key compatibility, old cache quarantine,
validation retry, write rollback, stale competing candidate, reviewed/source ownership and expiry.
Two real child exits prove pre-commit rollback or committed receipt/source persistence. Two new
frontend cases verify frozen bytes/key after uncertainty and new attempt after explicit 400.
Chromium drops a real committed 201, retries same key, verifies one report and current Billing.
Actual server startup exercises expiry cleanup while retaining receipt tombstone and proof;
synthetic owner alerts still process once and stale claims remain unknown. No provider/bank/
customer email or deployment action. Runtime/tests frozen before completed full regression.

Research: Stripe application idempotency and SQLite savepoints, reviewed today (research doc).
Own contract differs from Stripe v1 error caching/key expiry: successful 201s only and retained
tombstones. Local process exits are not power-loss/hosted/shared-filesystem assurance. No bank
charging/confirmation or exactly-once inbox guarantee. No new dependency/advisory snapshot or
tenant schema bump. Complete-control totals 36 PASS/58 FAIL/126 UNVERIFIED/13 N/A stay unchanged.

Remaining: inquiry/other API receipts, no-key/new-modal/different-actor/legacy duplicates, broader
financial lifecycle, reconciliation/reviewed resend, backlog escalation, upload-content checks,
approved retention and real hosting/device/provider/restore/capacity acceptance. Downgrade needs
compatible request writers or stopped/reconciled reporting. Receipt response is original state;
GET Billing is current. No production-ready/CI-green/hosted acceptance or complete-control PASS.

The staged secret scanner also flagged ordinary runbook wording about API retry work as a
generic-api-key match. It contained no credential. The prose was reworded (no scanner suppression);
the redacted initial finding/output and subsequent scan are retained.
