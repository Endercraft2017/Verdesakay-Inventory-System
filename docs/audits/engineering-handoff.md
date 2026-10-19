# Engineering handoff and release hold

Latest follow-up: 19 October 2026 — keyed payment reporting now replays its committed original
acknowledgement with parsed attachment binding and current permission checks. Desktop Billing
retains the exact uncertain request for retry. Other alert/proof/mail fixes remain documented.
Creation receipts, accounting and authentication follow-ups remain documented below. The
complete release is still on hold.

Work is on `production`, derived from `restructure/module-architecture`; no deployment command or hosted acceptance was performed for this increment.
The attached handbook is an audit reference. Current whole-control status remains 36 PASS,
58 FAIL, 126 UNVERIFIED and 13 N/A across 233 checks. A test pass is not release approval.
See the [scorecard](production-scorecard.md) for severity, scenarios and resolutions and
[validation results](validation-results.md) for exact completed checks.

## Delivered in the authentication follow-up

- Controlled assisted recovery suitable for a sole support operator: established-contact checks,
  advance notice and cancellation, enforced 24-hour wait, expiring one-use link, session revocation
  and mandatory factor re-enrollment. No master bypass or immediate support impersonation.
- Owner-console WebAuthn/passkeys and recent proof before console writes. Windows Hello provides
  a no-phone option; an independent backup authenticator and mandatory-policy rollout remain.
- Stronger new-password validation, versioned native scrypt and bounded asynchronous public login;
  stale credential/account results cannot issue sessions after a concurrent reset/deactivation.
- Native-only OS-vault bridge with fail-closed initialization and logout/server-change protection;
  company/actor-bound queue replay and no native bearer mirror in queue metadata. Legacy unbound
  credentials require sign-in and legacy unbound work stays for review. Android backup exclusions
  and reproducible web/plugin sync are included; an actual APK/device is not validated.
- Recent password + enabled-factor verification for tenant accounts/roles/permission/security-policy,
  office-PC trust and mail/AI/accounting configuration. Accessible confirmation cancels safely and
  retries once under the original company/session. Pending accounting authorization is bound to
  the initiating live session/account and generation across token exchange.
- Operational/security runbooks, data inventory and draft policy/contract pack. Drafts require
  approval; automated and selected browser coverage do not establish all-screen accessibility.

## Engineering work that remains engineering work

The owner is not being asked to implement these. Prioritize from the scorecard and reproduce each
applicable issue before changing behavior:

| Priority | Work | Completion evidence needed |
|---|---|---|
| High | Complete remaining sensitive-business-action verification with the offline authority model | Explicit action inventory, server enforcement and replay/role/race tests; AUTHZ-15 remains open |
| High | Uniform API validation/error/redaction and privacy export/retention/erasure lifecycle | Route-by-route evidence; tenant-safe restore/copy/integration tests; approved retention scope |
| High | AI privacy/adversarial evaluation, interrupted audit outcomes and hard spend allocation | Isolation/leakage/abuse/cancellation tests and real provider budget acceptance |
| High | Reliable onboarding notification delivery and broader creation admission/reconciliation | Completed keyed HTTP receipts and signup outbox/worker implemented; inquiry/other API retry receipts, provider reconciliation/reviewed resend, backlog monitoring, signup work budget, legacy/new-key recovery and imported-state acceptance remain. See operations/workspace-onboarding.md |
| High | Native/Electron distribution and supported-client acceptance | APK/installer builds, signed artifacts, actual Windows/Android vault/backup/logout/upgrade checks |
| High | Integration lifecycle and accounting reconciliation acceptance | Local generation/scoping, refresh admission, export exclusion and durable uncertain-write handling implemented 2026-10-18; actual Intuit sandbox, legacy adoption/repair tooling, interrupted-claim reconciliation, operational alerting and accountant acceptance remain. See operations/quickbooks-lifecycle.md |
| High | Resolve or explicitly disposition vulnerable dependencies and historical-secret gates | Upstream/compatible fix or approved expiring risk record; verified revocation without exposing the old bearer |
| Medium–High | Remaining resilience, concurrency, accessibility, observability and handbook requirements | Risk-ordered evidence for applicable controls; architectural/commercial choices agreed explicitly |

These are outstanding limitations, not assertions that all missing engineering is finished.
Read-only scans and the local test suite cannot prove production operation or independent assurance.

## Owner participation comes last

After engineering/staging preparation, the owner needs to:

1. Enroll Windows Hello plus an independent backup for the console, and the selected authenticator
   for the tenant administrator; save recovery codes privately and test sign-in before enforcement.
2. Approve support identity-verification rules, business/privacy/contract details and acceptable
   downtime/data-loss targets. Have the actual legal terms reviewed for the applicable jurisdiction.
3. Use the hosting/provider accounts for staging/production separation, credential rotation and
   verified historical-session revocation; establish branch checks, backup protection and alert access.
4. Participate in supported-device checks and witness the isolated full restore/rollback and real
   email/alert tests before a release decision. No passwords, keys or recovery codes belong in chat.

Detailed steps are in [OWNER-ACTIONS.md](../OWNER-ACTIONS.md). Hosting, DNS, live credentials,
production databases and customer messages were not changed by this code follow-up. Keep release
on hold until the applicable blockers have evidence or a properly approved, expiring exception.

## Accounting lifecycle follow-up — 2026-10-18

Confirmed refresh/disconnect and cross-company record-ID races are now guarded. Persistent
refresh/export admission and pre-send write receipts prevent blind retry of unknown financial
outcomes; scoped receipts recover known accepted links. Legacy unbound IDs remain preserved and
blocked for reconciliation. The HTTP retry cache also binds connection/company/environment and
does not retain temporary accounting conflicts. No owner action is requested during engineering. This addresses local
concurrency/data-integrity defects, not every integration release requirement or other audit gap.
See [the runbook](../operations/quickbooks-lifecycle.md) and latest validation record.

## Durable automatic-export follow-up — 2026-10-18

Transactional intent, version coalescing, a bounded cloud worker, durable retry state and admin
status are implemented. Fresh-proof safe resume excludes unknown writes and interrupted claims.
The previous statement that automatic export is only logged best effort is superseded for the
supported order save paths. Real provider acceptance, automatic reconciliation/legacy adoption,
alert delivery, capacity/rollout and other app gaps remain. No owner setup is required to run
local engineering checks. See [the runbook](../operations/quickbooks-auto-exports.md).

## Conversion error-disclosure follow-up — 2026-10-19

Moderate, authenticated editor scope: Word import/export previously concatenated arbitrary
converter exception messages into 400 responses, bypassing generic 500 redaction. Conversion
now distinguishes authored document-limit errors from dependency failures. Unreadable imports
receive generic 400 feedback; unexpected exports forward a sanitized exception to the central
500 handler. Request IDs correlate responses without logging raw converter messages.

This is a partial API-06 improvement. Platform/support/CSV catch blocks and the central
handler's trust in arbitrary numeric status properties still need classification and failure
injection. Do not mark app-wide error handling complete. Dependency advisories, historical
credential revocation and hosted/physical-device/owner acceptance gates remain open.
See the dated validation record for actual tests; no deployment is authorized by this change.


## Support/owner-detail error follow-up — 2026-10-19

Moderate scoped disclosure: tenant support and owner-console support/detail mutations previously
returned raw database and Zod exception messages as 400 responses. They now preserve authored
validation feedback and sanitize unexpected failures before generic 500 handling. Ticket IDs
also receive service-level positive safe-integer validation, including nonnumeric route IDs
not rejected by the existing numeric-resource middleware. No tenant/owner scope is broadened.
Real SQLite failure tests cover six mutation paths, unchanged stored records, safe correlated
responses and absence of injected private error markers from request logs. A browser check
proves failed support submission retains the draft and a corrected retry can succeed.

The earlier blanket platform/support review lead is partially resolved for these specific
routes only. Module/provisioning catches, CSV adapters, central arbitrary status/expose trust,
503 exceptions and legacy diagnostic logging remain engineering work. Rich protected error
diagnostics, support write/audit atomicity and duplicate submission semantics are not claimed
by this fix. API-06 stays FAIL; release totals and external acceptance gates are unchanged.


## Provisioning and settings follow-up — 2026-10-19

High scoped integrity gap: a rejected multi-field PATCH could persist earlier catalog changes;
creation checked explicit module names after creating the workspace. The patch now validates
the entire request before writes and commits settings/subscription changes with their audit
entry in one savepoint. Creation preflights modules; create/import reject unknown plans.
Moderate scoped disclosure: owner create/import/settings/subscription catches trusted arbitrary
status or message text. Only typed authored errors now retain 400/409 feedback; unexpected
errors become generic correlated 500s. Import integrity and migration log messages are generic.

See dated validation evidence for SQLite triggers, rollback, validation and actual browser
corrected-save behavior. This does not make provisioning crash-safe across catalog, tenant DB,
files and post-create setup/audit operations. Compensating cleanup/restart recovery for those
steps is still engineering work. CSV adapters, signup/other status/expose/503 trust and legacy
diagnostics remain open; API-06 and the complete release hold are unchanged. No owner setup or
live deployment is required for these local engineering checks.


## Core provisioning recovery follow-up — 2026-10-19

High scoped gaps: catalog publication preceded owner setup/migration; creation could adopt an
unregistered database; import rename could overwrite a raced destination; failed initialization
could remain cached. Core prepare-before-publish, exclusive reservations, atomic catalog/audit
publication, ownership-checked cleanup and failed-connection eviction are implemented. Real child
process exits prove no catalog registration and collision refusal on restart; orphan artifacts
are preserved for review. See the provisioning recovery runbook and dated validation evidence.

Post-core route setup/invoicing/notifications still needs durable reconciliation and idempotency.
This is fail-closed interruption handling, not automatic orphan recovery or power-loss/multi-host
certification. The initial Playwright run had an intermittent MFA input-validation failure;
its unmodified rerun passed. Root cause remains unconfirmed and is not claimed fixed here.
Other handbook, dependency/history and external acceptance gaps keep the release on hold.


## Atomic local onboarding follow-up — 2026-10-19

High scoped gap: signup previously published an active workspace before payment lock,
subscription/contact and first-invoice setup. Console modules/payment/inquiry setup followed
publication too. Both local setup paths now run synchronously inside catalog publication; any
setup/audit failure rolls back the local catalog and triggers owned-database cleanup. The
billing helper now nests with savepoints and commits invoice/audit together, including standalone
issuance. Cached billing/contact schema initializes before rollbackable publication.

Real SQLite faults cover payment lock, subscription, contacts, invoice insert, invoice audit,
final publication audit and console inquiry linkage. One child exits after local signup setup;
its restarted catalog has no tenant, invoice, contact or provisioning log. The website test
retries the same failed signup and verifies exactly one invoice plus the payment lock.

See operations/workspace-onboarding.md, the audit README and dated results. Durable HTTP
response receipts, generated-slug duplicate submission handling and reliable notification
outbox/worker delivery remain engineering work. Existing post-core setup limitations above are
superseded for the covered local catalog steps, not for acknowledgements or external delivery.
Other scorecard work and hosted/owner/legal acceptance gates remain; no deployment occurred.

## Durable creation receipt follow-up — 2026-10-19

High scoped gap: a successful but unacknowledged console create with a generated slug could
create another workspace on retry; signup could report conflict after successful invoicing.
Both covered HTTP routes now persist completed responses atomically with local publication.
Scope/key uniqueness rejects a competing candidate, and same details replay the original 201.
Anonymous signup binds the full parsed request including password with a salted scrypt verifier;
console replay requires the current authenticated operator and fresh passkey proof where enabled.
Expiry clears payload/verifier but retains a tombstone to prevent later reapplication.

The receipt tests cover independent catalog reopen, actual process exit after commit, stale
competing candidates, real SQLite rollback faults, changed credentials, operator/route isolation,
authentication/fresh-proof enforcement, legacy clients, purged tenants and expiry. Chromium drops
real successful responses for both forms, then retries with the same key and verifies one workspace/
invoice. This supersedes the earlier response-receipt engineering gap for these routes only.

No owner action is needed for this engineering increment. Read operations/workspace-onboarding.md
for exact behavior and remaining work. Notification outbox/delivery, signup admission, broader
API/import retry coverage and existing release gates remain open. Keys are in page/modal memory;
reopening/reloading does not recover them. Hosted/power-loss/shared-filesystem and actual device
acceptance are not inferred. Whole-control totals and release hold remain unchanged.

## Signup owner-alert follow-up — 2026-10-19

High scoped gap: best-effort signup notification could disappear after successful workspace
publication. Enabled signup alerts now enqueue inside that same publication savepoint; durable
intent survives restart. A cloud startup/15-second worker claims one job per pass, outside the
provider call, then commits guarded result and attempt log together. Explicit Brevo 429 rejects
retry with persisted backoff/Retry-After and a five-attempt budget. Stale claims, timeouts, partial
SMTP acceptance and uncertain storage acknowledgement require review, never automatic resend.
Changed mailbox/recipient/credential generation cancels old unsent private information.

The shared platform-mail adapter now requires SMTP TLS, bounds SMTP duration with an owned
socket that is destroyed at completion/deadline and stores authored
error codes instead of raw provider bodies/exceptions. Console test-mail async database failures
reach the generic correlated error boundary. Owner-console API responses now use no-store,
including unauthorized responses. No tenant SMTP policy is changed by this platform adapter work.

Email alerts shows redacted recent signup delivery states, with read-only refresh and no blind
retry. Payloads logically expire while event identities remain. The runbook documents backup/
provider reconciliation, privacy and disabled-alert behavior. Real SQLite/process faults and
actual server startup supplement the synthetic provider and Chromium checks. Initial restart
fixture collisions were corrected; two partial full runs were explicitly interrupted to include
the discovered async error/cache and active SMTP socket-cancellation fixes, then restarted. A real
local stalled SMTP connection verifies deadline socket teardown. Those runs are retained as non-final.

See operations/owner-alert-outbox.md and owner-outbox-* evidence. Inquiry/payment alerts still
send immediately. Reviewed resend/provider reconciliation, backlog aggregation/external alerts,
capacity, retention approval and live provider/restore/hosting/Windows acceptance remain. No
owner engineering action is requested now. Whole-control totals and release hold are unchanged.


## Inquiry/payment alert follow-up — 2026-10-19

The earlier immediate-alert limitation is superseded for the updated public inquiry and tenant
payment-report routes. Enabled intent commits with its source. Payment proof/2307 bytes, payment,
reporting audit, invoice state and prepared response share the catalog transaction. UUID proof
names and lazy private cache reconstruction replace pre-commit files and timestamp collisions.
A separate business queue prevents the old signup-only worker from claiming these new categories.

High credential-pairing gap addressed: mailbox settings, encrypted secret and key reference now
come from one SQLite snapshot. Atomic settings/secret writes nest with console audit/response
preparation. A separate database connection changes the generation during a test; the sender
retains the matching old host/password. Secret/audit fault tests restore the old configuration.

See operations/business-alerts.md and business-alerts-* evidence for exact checks and failures.
Two distinct POSTs still create distinct reports/inquiries; uncertain acknowledgements need
reconciliation. No automatic reviewed resend, external backlog escalation, upload-content
certification or broader settlement/refund lifecycle fix is claimed. Compatible worker/restore
acceptance, approved retention and the existing hosted/device/provider gates remain. No owner
engineering action is needed for this increment; whole-control totals/release hold are unchanged.


## Payment-report retry follow-up — 2026-10-19

High scoped duplication gap: a committed report with a lost response could be reported again.
Updated desktop/API keys now bind tenant/actor/invoice/details and proof/2307 bytes; successful
receipts commit with payment/proof/audit/invoice/alert and replay the original 201 after restart.
Current Billing GET supplies reviewed financial state. A stale competitor rolls back, while
expiry retains tombstones. No raw request/key/proof is added to receipt storage.

Testing also exposed the generic tenant cache intercepting multipart retries before parsing and
route permission checks. This payment POST now bypasses that cache; known legacy entries conflict
for reconciliation. The new flow respects current auth/users.manage and online authority before
replay. Role downgrade and byte/method/invoice changes are tested. Browser response loss checks
one committed report; process exits verify source/receipt rollback or persistence together.

See operations/payment-report-retries.md and payment-receipts-* evidence for failures/results.
No-key/different-actor/new-modal/legacy reports can still duplicate; other inquiry/API receipts,
reconciliation, queue escalation, upload-content and wider financial lifecycle/live acceptance
remain. No owner action is needed now. Complete-control totals and release hold stay unchanged.

The payment middleware exemption also covers Express case-insensitive/trailing-slash aliases.
A deliberately failing alias test confirmed old-cache interception; a preliminary full run was
interrupted (130) to include the correction, then verification restarted. See raw evidence.
