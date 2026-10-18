# Data inventory, retention and rights operations

DRAFT schedule; privacy owner/counsel must approve retention durations and lawful bases before launch. Do not run broad database DELETEs from this document.

| Category | Locations/processors to inventory | Decision needed |
|---|---|---|
| Accounts and security | tenant/platform DB, IP/device/session history, reset-attempt hashes, logs | Account lifecycle, security-log period, access/export scope |
| Assisted account recovery | tenant `account_recoveries`, control-plane `platform_recovery_approvals`, existing email processor, security/activity logs; actor IDs, email, reason/reference, nonce/verifier fingerprints and lifecycle times | Approve evidence/log retention, support authority, escalation and access scope; no identity-document copies or raw recovery bearers in these records |
| Native credentials and local work | OS-vault session token bound to company origin; non-secret signed-out marker; local caches/drafts and account/company-bound IndexedDB queued work | Physical-device extraction/backup/transfer acceptance; review older unbound work. Vault protects credentials, not every cached business/HR file. See operations/native-credential-storage.md |
| Employee/HR/payroll | employee tables, attendance/location/photos, IDs, forms, uploads, backups | Employment/tax retention, restricted roles, correction and legal holds |
| Sales/production/accounting | operational/financial tables, exports, QuickBooks, backups | Tax/warranty/audit retention and append-only adjustments |
| Messages/files/anonymous reports | DB, attachments, search indexes, mail, device caches | Confidential handling, distinct rights review, attachment expiry |
| AI and integrations | messages/retrievals, provider logs, SMTP/Web Push/S3 | Provider retention/training, regions, DPA, token caps |

Known application cleanup is not a complete legal schedule: ended session history is cleaned after 90 days; recovery attempt hashes after one day. Verify actual configured backup rotation and other housekeeping before making broader promises.

For each category record controller/purpose/lawful basis, data fields, source/recipients, country/transfer basis, retention trigger/period, hold rules, deletion method, accountable owner and evidence. Assess minors, employee monitoring/location and special/regulated data with counsel. Collect only necessary fields; document permission groups and consent/notice where applicable.

## Rights-request case record

Use a restricted case register: case ID, receipt, requester/workspace, request type, jurisdiction/deadline, proportionate verification result (not ID document copies), assigned owner, systems searched, third-party/confidential exclusions, legal holds, decision/reason, response date, processor/device/backup follow-up and approval evidence. Confirm authority before export. Redact credentials, other users and anonymous authorship. Encrypt exports, deliver via an authenticated expiring channel, and delete temporary packages. Track escalation before the applicable statutory deadline; deadlines require jurisdiction-specific approval.

For approved erasure, test a scoped plan on a disposable restore, preserve financial/audit duties, review foreign keys and attachment references, obtain independent review, execute against the correct tenant, verify every data location and retain a minimal suppression record. Reapply approved erasures after disaster restoration until backup expiry. Legal holds override routine cleanup with recorded justification. There is no universal automated erasure endpoint in this release.

## Administrative verification metadata (2026-10-16)

Tenant `session_stepups` holds session-token digests, user IDs, credential fingerprints and server
verification times; no raw passwords, OTPs or recovery codes. Proof older than one day is pruned
when fresh proof is written; session deletion cascades its row. It is node-local and stripped
from sanitized node snapshots. QuickBooks pending OAuth state binds digested session + account
fingerprint for a ten-minute one-use connection transaction. Include these local security records
in retention/access reviews; they are not a new general legal retention promise.

## Company-bound integration metadata (2026-10-18)

QuickBooks `qbo_company_links`, `qbo_write_attempts`, `qbo_export_locks` and `qbo_refresh_locks`
are cloud-local, excluded from replicated effects and sanitized snapshots. They hold company/
environment scope, local/remote IDs, credential-generation references, request IDs, payload hashes,
minimal accepted receipts and lifecycle times; no raw provider body or token is added. Legacy
unscoped links remain quarantined for reconciliation. Retention/rights operations must preserve
financial reconciliation and duplicate-prevention duties; do not delete journals/locks as routine
cleanup without an approved scoped procedure. See the QuickBooks operations runbook.

`qbo_export_jobs` additionally retains non-secret connection/company and order IDs, desired/
completed versions, claim IDs, safe error codes and attempt/scheduling times. No raw payload or
provider error is stored. It is cloud-only and excluded from node snapshots/effects. Include it
in accounting retention and scoped rights/reconciliation procedures; do not blindly purge claims.
