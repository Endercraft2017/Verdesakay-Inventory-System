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

## Workspace creation receipts (2026-10-19)

Control-plane platform_creation_receipts contains route/operator scope, hashed random UUID,
salted scrypt request verifier, original company/invoice or console creation response, tenant
slug and expiry. No raw request/password, session token or recovery bearer is added. Responses
and verifiers expire after 24 hours and are nulled by startup/hourly/keyed-request sweeps; they
can persist while the server is stopped and in retained backups. Nulling is logical cleanup,
not a forensic wipe of database pages, WAL or snapshots. Minimal scope/key-hash/slug/
expiry tombstones remain indefinitely to prevent a replay becoming another creation. This is
a security/duplicate-prevention implementation policy, not a legally approved retention period.
Approve lawful basis, access, backup expiry, holds and any future scoped tombstone erasure before
launch. Deleting receipts/tombstones or restoring an older catalog can remove duplicate evidence;
reconcile before allowing creation writes. See operations/workspace-onboarding.md.

## Signup alert delivery (2026-10-19)

Control-plane platform_owner_outbox holds event/tenant identifiers, recipient snapshot, message
subject/text with signup contact/invoice acknowledgement, an opaque mailbox-generation binding,
state/attempts/safe error codes and lifecycle times. It contains no raw mailbox secret or provider
body. Payloads are ordinary private catalog data, outside tenant replication; encrypted volume/
backup and provider access require separate acceptance. Worker maintenance nulls terminal
payloads after 24 hours and all payloads after seven days; a stopped/non-cloud worker retains
them until a sweep. Minimal event/tenant/state metadata remains indefinitely for operational/
duplicate prevention, pending approved retention. Existing platform_mail_log and provider logs
have separate unchanged retention; old diagnostics are not retroactively scrubbed here.

Approve access, lawful basis, payload/metadata/backup/provider periods and scoped erasure/holds.
Nulling is not a forensic wipe. Restoring an older catalog can resurrect a pending event without
later send evidence; reconcile provider records before starting the worker. See the outbox runbook.


## Inquiry/payment alerts and proofs (2026-10-19)

platform_business_outbox holds inquiry/payment source IDs, the same delivery fields/payload
policy as platform_owner_outbox, inquiry contact/message or payment reference/invoice text.
Inquiry tenant_slug is empty because no workspace exists yet. Status exposes kind/source_id
without queued message, recipient or credential binding. Both tables share logical terminal
24-hour/all-seven-day payload pruning and retained event metadata; approve the schedule/holds.
Mail settings/secret/key references are read in one memory snapshot; raw secrets are not API
fields. This does not add encryption to ordinary queued payloads.

New reported-payment proof and optional 2307 bytes commit in platform_durable_files with the
payment/audit/invoice/intent. Missing disk caches are rebuilt on download with private POSIX
creation modes; legacy cache permissions remain unchanged. Financial attachment retention is
separate from queued-email expiry: pruning messages does not delete proofs. Include catalog/WAL,
caches, backups and provider copies in scoped rights/hold review. No malware/signature assurance,
Windows ACL acceptance, legacy orphan cleanup or legal retention approval is inferred.
See operations/business-alerts.md for upgrade/restore/reconciliation rules.


## Payment-report receipts (2026-10-19)

platform_payment_report_receipts holds tenant slug, actor ID, hashed random UUID, salted scrypt
request verifier (normalized financial details plus attachment digests), original invoice response,
payment ID and expiry. It adds no raw request/key/proof/session token. Response/verifier are
logically nulled after 24h on startup/hourly/keyed-request sweeps; minimal tombstones remain.
Receipt responses are ordinary private catalog financial data and backups can retain older
payloads. The browser keeps FormData/key in modal memory only. Financial proof retention is
separate. Approve lawful basis, access, holds, metadata expiry and backup handling; no forensic
erasure/legal approval is implied. See operations/payment-report-retries.md for restore rules.


## Public inquiry receipts (2026-10-19)

platform_inquiry_receipts retains hashed random key, salted request verifier, inquiry ID and
expiry only; it does not add raw contact/message/key or a private response. Constant public
acknowledgement is reconstructed. Startup/hourly/keyed-request sweeps null verifiers after 24h;
minimal duplicate-prevention markers remain. Browser key stays in page memory, with no new
localStorage draft/key. Original inquiries, owner-alert payloads and provider/backup data have
separate retention. Approve lawful basis/access/marker expiry/holds/backup and scoped erasure;
nulling is not forensic wiping. Restore/rollback requires reconciliation. See inquiry-retries.md.


### Owner-alert observations — 19 October 2026

The platform catalog additionally stores one latest worker run ID, start/finish, outcome and
last-success timestamp. No payload/recipient or diagnostic text is stored in this heartbeat.
Authenticated history exposes existing event/source IDs, tenant slug, state, safe error code
and timestamps; bodies, recipient addresses and configuration stamps are omitted. No new
external telemetry destination or automatic event-metadata deletion is introduced. Retention
approval, historic log review and secure catalog backup/restore remain applicable. See
../operations/owner-alert-monitoring.md for limits and review procedure.


### Public signup availability (2026-10-19)

Asynchronous signup receipt/owner hashing preserves current signup:v1 scope, salted verifier,
response, expiry/tombstone and credential formats. No new raw request/password/key, persistent
queue or telemetry destination is added. One in-memory active signup gate and shared crypto
counters contain no account identity. Browser keys/password fields remain page-memory only;
a twenty-second abort does not imply server rollback. Fresh tenant seeding uses the chosen
owner hash instead of another global bootstrap hash. Existing retention/rights/backup review
remains unchanged. See ../operations/public-signup-budget.md.


### Manual accounting export checks (2026-10-20)

Current actor/order snapshot checks are memory-only. No new password, factor, session or raw
order snapshot is added to durable accounting receipts. Export-authorized roles may read the
company/environment/generation metadata needed to bind their request; provider credentials
remain private. Minimal known acceptance receipts/links survive actor revocation because a
sent provider write cannot be recalled. Unknown outcomes are not cleared or resent. Existing
accounting retention, confidentiality and reconciliation duties remain. See ../operations/manual-quickbooks-exports.md.

## BIR 2316 employee projection — 20 October 2026

The accounting detail endpoint now returns a bounded identity projection instead of the
whole employee row. Base pay rates, deduction overrides, leave balances, photos and future
unrelated columns are excluded. Statutory figures and the accounting permission remain.
See [field contract, regression scope and remaining work](../operations/accounting-tax-privacy.md).
Research: [OWASP API3:2023 property authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/),
retrieved 20 October 2026: explicitly select necessary response properties. This scoped fix
does not establish compliance or close broader export, retention or template-variable controls.

## Payslip disclosure identity — 20 October 2026

Self-service list/PDF/timekeeping and payroll email now share fail-closed ownership:
present invalid/missing employee references do not fall back to a name; a legacy
current/former name must identify one employee. Ambiguous self-service records are
withheld (direct routes 404); email returns 400 before sending. Stamped and unique
former-name records remain supported. No automatic legacy reassignment or stored
data deletion. Reviewed repair tooling and stable-ID statutory reconciliation remain.
See [contract, operations and evidence](../operations/payslip-identity-disclosure.md).
Research: [OWASP API1:2023](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/),
retrieved 20 October 2026; per-object authorization and regression testing.
