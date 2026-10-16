# Data inventory, retention and rights operations

DRAFT schedule; privacy owner/counsel must approve retention durations and lawful bases before launch. Do not run broad database DELETEs from this document.

| Category | Locations/processors to inventory | Decision needed |
|---|---|---|
| Accounts and security | tenant/platform DB, IP/device/session history, reset-attempt hashes, logs | Account lifecycle, security-log period, access/export scope |
| Assisted account recovery | tenant `account_recoveries`, control-plane `platform_recovery_approvals`, existing email processor, security/activity logs; actor IDs, email, reason/reference, nonce/verifier fingerprints and lifecycle times | Approve evidence/log retention, support authority, escalation and access scope; no identity-document copies or raw recovery bearers in these records |
| Employee/HR/payroll | employee tables, attendance/location/photos, IDs, forms, uploads, backups | Employment/tax retention, restricted roles, correction and legal holds |
| Sales/production/accounting | operational/financial tables, exports, QuickBooks, backups | Tax/warranty/audit retention and append-only adjustments |
| Messages/files/anonymous reports | DB, attachments, search indexes, mail, device caches | Confidential handling, distinct rights review, attachment expiry |
| AI and integrations | messages/retrievals, provider logs, SMTP/Web Push/S3 | Provider retention/training, regions, DPA, token caps |

Known application cleanup is not a complete legal schedule: ended session history is cleaned after 90 days; recovery attempt hashes after one day. Verify actual configured backup rotation and other housekeeping before making broader promises.

For each category record controller/purpose/lawful basis, data fields, source/recipients, country/transfer basis, retention trigger/period, hold rules, deletion method, accountable owner and evidence. Assess minors, employee monitoring/location and special/regulated data with counsel. Collect only necessary fields; document permission groups and consent/notice where applicable.

## Rights-request case record

Use a restricted case register: case ID, receipt, requester/workspace, request type, jurisdiction/deadline, proportionate verification result (not ID document copies), assigned owner, systems searched, third-party/confidential exclusions, legal holds, decision/reason, response date, processor/device/backup follow-up and approval evidence. Confirm authority before export. Redact credentials, other users and anonymous authorship. Encrypt exports, deliver via an authenticated expiring channel, and delete temporary packages. Track escalation before the applicable statutory deadline; deadlines require jurisdiction-specific approval.

For approved erasure, test a scoped plan on a disposable restore, preserve financial/audit duties, review foreign keys and attachment references, obtain independent review, execute against the correct tenant, verify every data location and retain a minimal suppression record. Reapply approved erasures after disaster restoration until backup expiry. Legal holds override routine cleanup with recorded justification. There is no universal automated erasure endpoint in this release.
