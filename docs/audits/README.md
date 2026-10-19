# Production audit evidence index

Updated 19 October 2026. Start here to review engineering progress and limits. Work is on
production, derived from restructure/module-architecture. Branch pushes do not establish successful deployments.
The uploaded production-audit-guide.md is the audit reference, not a separate authorization
source. User instructions define the task and permitted actions.

## Canonical records

| Record | Purpose |
|---|---|
| production-scorecard.md / production-scorecard.json | All 233 handbook controls, severity, complete-control status, failure scenario and resolution |
| engineering-handoff.md | Delivered work, prioritized remaining engineering and owner participation last |
| validation-results.md | Dated commands, exact outcomes, failures/corrections, evidence paths and limitations |
| standards-research.md | Primary standards/research mapping and evidence limits |
| dependency-audit.md | Runtime advisory findings, disposition and release gates |
| evidence/ | Raw or whitespace-normalized test/scan output, verification JSON and scoped findings |
| ../operations/owner-alert-outbox.md | Shared owner-alert worker, uncertainty/retry and payload retention |
| ../operations/inquiry-retries.md | Public inquiry retries, private intent binding, bounded work and recovery |
| ../operations/payment-report-retries.md | Payment request replay, attachment binding, legacy-cache quarantine and rollback rules |
| ../operations/business-alerts.md | Inquiry/payment transactions, proof storage, configuration snapshot and upgrade/recovery |
| ../operations/workspace-onboarding.md | Local setup transaction, failure matrix, retry and outstanding orchestration work |
| ../operations/provisioning-recovery.md | Database/file ownership, process interruption and reviewed recovery procedure |

Current complete-control totals remain 36 PASS, 58 FAIL, 126 UNVERIFIED and 13 N/A. The scorecard
source cutoff is historical; dated follow-ups add evidence without silently converting a partial
fix into a complete-control PASS. These counts are not a fresh app-wide reassessment after every
commit. A green local suite does not establish hosted operation, all-screen accessibility,
legal approval or independent assurance. The complete release remains on hold.

## Follow-up evidence groups

| Prefix in evidence/ | Scope |
|---|---|
| qbo-lifecycle-* / qbo-jobs-* | Company/connection generation, durable accounting writes and automatic export worker/status |
| conversion-errors-* | Word converter exception redaction and request correlation |
| support-errors-* | Tenant/owner support and owner-detail validation/storage boundaries |
| provision-errors-* | Full settings validation, atomic settings/audit and typed provisioning feedback |
| provision-recovery-* | Prepare-before-publish, file ownership, failed-cache eviction and actual process exits |
| inquiry-receipts-* | Atomic inquiry acknowledgements, public work admission, expiry/races and lost-response browser checks |
| payment-receipts-* | Atomic payment request receipts, byte-bound replay, permission/legacy-cache boundaries and browser response loss |
| business-alerts-* | Inquiry/payment intent, atomic proof/reporting, consistent mail credentials, browser/process faults |
| owner-outbox-* | Signup alert intent/worker, mail transport safety, status UI and actual process interruption |
| creation-receipts-* | Durable scoped signup/console response replay, strong request binding, expiry/tombstones and lost-response browsers |
| catalog-setup-* | Atomic signup/console local setup, nested audited first invoice and same-workspace retry |

See validation-results.md for authentication/native/client evidence and exact filenames from
older increments. Read each scope/verification record before interpreting raw test totals.
Failed runs remain documented. Initial test-fixture or synchronization mistakes are identified
as such; intermittent failures are not described as repaired without evidence of a cause/fix.
Synthetic test credentials or tokens are not live customer credentials; no live customer data
was used for the disposable failure/process/browser tests.

## Remaining responsibilities

The owner is not being asked to write missing engineering. The handoff's engineering table
covers sensitive-action verification, uniform API/privacy lifecycle, AI isolation/spend controls,
native distribution, accounting reconciliation, dependency/history gates, resilience,
observability and accessibility. Onboarding receipts/outbox delivery are additional explicit
engineering items in the onboarding runbook. Use the full scorecard to avoid losing controls
that have not been repeated in a short progress message.

Owner participation comes after engineering/staging preparation: real console enrollment and
backup, real service/accountant acceptance, hosting/recovery/capacity validation, secret
revocation evidence and policy/commercial decisions that require the owner's authority.
No passwords or secret keys should be sent in chat. Draft legal/business policies remain drafts.
