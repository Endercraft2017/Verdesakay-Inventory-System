# Reviewed correction of unresolved payroll identity

20 October 2026. New cloud-only exception workflow; no live records were repaired
by this engineering increment. Research and tradeoffs:
[research record](../audits/payroll-repair-research.md).

## Operator procedure

1. Open the cloud workspace's HR Payroll records as an authorized payroll manager.
   Use **Review owner of payslip** on the affected row. An already-resolved owner
   cannot be transferred through this workflow.
2. Check original employment/cutoff records and any previous name history. Search
   by employee number or name, then explicitly select the employee. The picker
   returns at most 50 matches; narrow the search when necessary. No name is guessed.
3. Enter a reason (10–200 characters) and evidence reference (3–120 characters).
   Use an internal case/record reference; do not paste IDs, bank/medical details,
   passwords or evidence-document contents. Affirm that employment records were checked.
4. Select **Review correction**. Complete the existing identity-verification prompt
   if requested. Check the returned record number, recorded employee, period,
   selected stable employee ID/number, linked account/email, paid status, reason
   and reference. The selected account may gain access to the historical payslip.
5. Select **Confirm identity repair**, or Cancel and accept the existing discard
   prompt. The review expires after five minutes. Changed record, account/company,
   employee/account link or authorization state requires a fresh review.
6. Check **Change history** for the attributed payroll-identity-repair revision.
   Confirm the correct employee's self-service access, review duplicate cutoff
   records/totals and reconcile statutory filings/ledger attribution separately.
   No automatic email, payment, journal rebuild or filing amendment occurs.

Amounts, status, calculation snapshot, original finalization/updated timestamp and
record/definition identity are preserved. The revision increments and its audit
entry records actual correction time, operator, reason/reference and old/new data.
The generic form editor cannot change an existing payroll record's resolved owner.
This is not a general paid-payslip editor, bulk repair, or resolved-owner transfer.

Use the cloud web workspace: an installed office endpoint refuses the new workflow
(503, online) and does not queue it, even if the office app itself is available.
Existing payroll operations retain their existing classes. Confirm cloud receipt
and supported synchronization/reconciliation before relying on an office copy.
No claim of exhaustive stale-office replay/restore acceptance is made here.

If the connection fails during confirmation, inspect current identity and history
before retrying. An already-consumed review returns conflict; it cannot reapply.
An audit-persistence failure rolls back the identity change. A database administrator
can still tamper with ordinary database history; independent protected audit storage
and restore/session-revocation acceptance remain broader requirements.

## API contract

All paths are under `/api/hr/payroll/:recordId/identity` and require authentication
and `payroll.manage` on the current tenant. API responses use existing no-store policy.

| Method/path | Contract |
|---|---|
| GET `/` with optional `q` | Current bounded record summary, resolved owner ID (or null) and up to 50 employee ID/number/name/status matches. No rates, photos, balances or government identifiers. |
| POST `/review` | Fresh proof; strict body: employee_id, expected_revision, reason, evidence_reference, verified_records:true. Returns authoritative review details and an encrypted review_token. Rejects resolved owners or stale revisions. |
| POST `/confirm` | Fresh proof; strict body containing only review_token. Validates purpose, company, actor/session/credentials, expiry, record state and selected employee/account state. Atomic conditional data update and attributed revision are required together. |

Success is 200. Validation is 400, missing record 404, authorization/fresh-proof
refusal 401/403, changed/expired/consumed review or unsupported transfer 409, and
an installed-node request 503. Unexpected storage errors remain redacted 500.
The token belongs in the request body only, never a URL or persistent client queue.
Request logging redacts review_token. Existing revision history remains payroll data
subject to restricted access, approved retention and backup/legal-hold policy.

No schema/dependency change. The feature uses the existing authenticated-encryption
key mechanism; configure the production external APP_SECRET/MAIL_SECRET_KEY as
already required. It is an application-bound review credential, not an independently
signed or phishing-resistant financial transaction. Insider/compromised-client risk
is reduced but not eliminated. Owner/counsel must approve actual rights, recipient
notification and retention procedures; this feature does not implement them all.

Validation evidence: [validation-results](../audits/validation-results.md).

## Credential-cache and legacy serialization safeguards

The new identity routes bypass general HTTP idempotency response storage. Each
request still reaches fresh-proof validation; encrypted review credentials are not
stored in response receipts, even if a caller supplies an Idempotency-Key. The
record's conditional revision update supplies single-use execution instead.

Ordinary payroll editing retains the original employee_id representation, including
invalid legacy values. Ownership comparison uses the JSON representation actually
written, preventing a numeric coercion from turning an invalid ID into null and
reviving name fallback. A regression reproduced that conversion before correction.
