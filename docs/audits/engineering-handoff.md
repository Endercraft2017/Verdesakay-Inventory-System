# Engineering handoff and release hold

Browser fixture startup follow-up, **25 October 2026**, baseline **873a820**:
the completed baseline CI now independently reports all four Node jobs and secrets
passing, with browser/dependency failures. A clean local baseline snapshot reproduces
the browser fixture's missing-output-directory crash: its SMTP timer writes into
ignored `work/` before that directory exists, and Playwright executes zero cases.
The fixture now prepares its own output before the timer. The new real-process
absent/existing/non-directory controls fail before and pass after on current Node
22/24 with unchanged assertions/configurations. The first full run passes
330 files/3,546 tests, but its cold browser run exposes one separate MFA input
focus defect (77 pass/one fail): the helper's redundant 50 ms focus reset appends
the code to the password; the backend correctly rejects the empty code. A real-DOM
regression fails before; removing that delayed refocus preserves shared initial
focus and passes thirteen focused UI/API cases. Backend source/schema, dependencies,
payroll authority, original browser assertions and budgets remain unchanged.
Final validation after that client change passes **331 files/3,547 tests** and
**all 78 Playwright cases**, zero failed/pending/skipped/flaky/global errors.
The browser starts from a new full source snapshot with no ignored output folder;
all 976 frozen code/config/runtime-asset inputs remain unchanged. The first failed
run and authenticated trace remain separate; public input diagnostics expose
lengths/status instead of credentials. See
[contract/evidence](browser-startup-contract.md) and
[startup recovery](../operations/browser-audit-startup.md). Original remote stderr
remains unavailable; the new exact-commit CI result must be observed separately.
Broader release holds remain open.

Current-Node adoption follow-up, 24 October 2026, baseline **b451ce6**:
the subsequent exact-commit CI has three passing Node jobs, but Node 24.22.1
reports original-company adoption failures; browser and dependency jobs also fail.
The adoption failure is reproduced with unchanged existing tests: a claimed
directory conflicts with current Node's `cpSync(errorOnExist)` behavior. The fix
keeps exclusive directory claim and per-file exclusive copies; all six focused
cases pass on each of the four CI runtimes. Actual competing processes and
SIGKILL/restart checks preserve sources/recovery and refuse partial destinations;
committed WAL-copy checks also pass on both current families. Complete Node 24.22.1
regression passes **329 files / 3,543 tests**. The same **78 distinct Playwright cases**
pass on both system Chromium 151 and Playwright-managed Chromium 156, zero
unexpected/flaky/skipped/global errors, with separate fresh TLS SMTP captures.
All 889 selected inputs remain unchanged. See [contract/evidence](adoption-runtime-contract.md)
and [recovery](../operations/adoption-copy-recovery.md). Existing registered companies
do not need another adoption. Browser cause remains unverified because log/artifact
downloads are proxy-denied; an independently exercised built-in GitHub reporter
now preserves failure while exposing future diagnostic annotations. Neither that
reporter nor this copy fix closes the browser gate, dependencies or native/host review.

Latest runtime admission follow-up: 24 October 2026, baseline e077a49. The old declared
22.13 minimum fails FTS5 setup; isolated transaction guards also misbehave with its missing
`isTransaction` API. The app now admits only `^22.22.0 || ^24.19.0` and checks required SQLite
behavior in private memory before application data access. Ordinary npm installs enforce that
policy. Standalone/CI current pins are 22.23.4/24.22.1 alongside the existing tested floors;
embedded Electron is unchanged. No transaction algorithm, business schema, authority rule or
existing assertion is changed. Ten reproduced admission failures become eleven passes;
real 22.13 refusal, kernel file-access tracing, npm's engine oracle and 41 focused tests on
each current patch are retained. Full minimum-runtime validation passes **328 files / 3,540 tests**
on Node 22.22.0; current-Node 24.22.1 Playwright passes **78 cases**, zero skipped/flaky/unexpected.
All 888 selected inputs stay unchanged. Final publication checks are recorded in the
[runtime contract](runtime-support-contract.md); [recovery](../operations/runtime-support.md)
requires upgrading the actual running host/build, not editing a pin alone. Native/host support,
historical financial consequences and independent review remain open.

Independent CI evidence now distinguishes the prior e077a49 run: both Node test jobs and
the secrets job succeed, dependency scan fails, browser fails at `npm run test:e2e`.
Detailed browser logs redirect to a proxy-denied destination; annotations do not establish a
cause. Read the contract's retained metadata before changing assertions or blaming its OS/action
notices. **Diagnosing that browser CI failure remains separate engineering work.** A local browser
pass does not close it. No new owner coding task or release approval is implied.

Latest dependency remediation: 24 October 2026 — body-parser 1.20.9, Multer 2.5.0,
Zod 4.6.6 and Nodemailer 10.1.4 replace four affected versions. The actual public app
compressed-body crash, attendance bound overwork, async-filter dependency crash and three
wrong-domain SMTP cases are reproduced before/fixed after. Multer's current app filters
are synchronous; no public compose/reviewed-mail validation bypass is claimed. The stronger
quoted-mailbox experiment **still fails** after the domain fix and remains executable;
the tested application validators already reject this syntax. No application runtime code,
schema, business authority or existing assertions change. Focused 121 tests and Node 22.22's
ten permanent regressions pass. Full serial validation passes **327 files / 3,529 tests**
with 879 selected inputs unchanged. Playwright passes **78 cases**, zero skipped/flaky/unexpected,
on those same inputs, including all seven payslip email scenarios. Final publication checks
are recorded in the [contract/evidence](dependency-remediation-2026-10-24.md). Runtime audit
remains exit 1: **one high** node-forge. Complete-root audit: **two high / one moderate**,
including separate Electron/fast-uri findings. These are not approved exceptions. Recovery
is in [runtime dependency updates](../operations/runtime-dependency-updates.md). Broader
release blockers, historical whole-control totals and independent review remain open.

Latest SQLite startup follow-up: 24 October 2026 — reproduced cold-start trigger contention
and a first-run administrator seed race at `0c2ed900239ce50db297ebd957d9f34b6ec0b0cc`.
Updated tenant/catalog initializers now coordinate through an adjacent technical SQLite
file, with bounded acquisition and initialization-only busy waiting. Returned business
connections retain the previous zero-wait policy. Existing business schemas, migrations,
backup ordering and offline payroll authority are preserved. Independent-process barriers,
SIGKILL/retry, persistent contention, failed catalog seed and actual paired server startups
are covered. Private in-memory connections create no lock file. See the
[contract/evidence](sqlite-startup-contract.md) and [recovery](../operations/sqlite-startup.md).
This supersedes the prior simultaneous cold-start availability limitation for cooperating
updated processes on the tested local file paths only. Mixed builds, arbitrary historical
migration interruption, other runtime writers, Windows/hosting/shared-storage acceptance
and independent review remain open; bounded waits do not establish a startup SLA.
At that earlier cutoff the check found a runtime-support mismatch: declared Node `>=22.13`, but
payroll/sync guards use `isTransaction` added in 22.16. An official 22.13 API probe demonstrates
the missing property during a real transaction; full financial impact is untested. Aligning
runtime declarations/admission is delivered by the subsequent runtime follow-up above; Node
22.22 and 24.19 are the tested app versions for the original startup increment. Historical
financial consequences and real host/native acceptance remain unverified.

Validation-only corrections are recorded separately: Vitest's default execution budgets
relax 20 → 60 seconds; the mobile fixture waits for its cached actor/local storage and closes each
window, with bounded state waits at demonstrated transitions. All 625 original mobile matcher
expressions remain identical/in order. Nine delayed-storage cases include 2 stuck-network
controls; an unhandled-storage control still fails even while its normal assertions pass.
These do not fix the observed 11.785/15.545 second authenticated requests or establish production
latency. Original failures and invalid candidate experiments remain evidence in the contract.
Final canonical validation passes 326 files / 3,519 tests with all 872 selected input hashes unchanged;
the retained 78-case Playwright run has identical runtime/e2e inputs. This is local scoped evidence,
not release approval or independent assurance.

Earlier dependency observation before the same-day remediation: a runtime npm scan reports
**four high / one moderate / zero critical vulnerable-package entries**, with seven active
primary advisory records. Manifests and lockfiles are unchanged. Earlier one-high results
below are historical snapshots. Compatible parser/upload/validator/mail package updates,
application-specific reproductions and final-graph regression are separate engineering
follow-up at that cutoff; the newer scoped remediation above supplies the delivered work and
remaining limits. No approved risk exception or owner implementation task is implied. See
[current findings](runtime-advisories-2026-10-24.md). The broader release hold and historical
whole-control totals remain unchanged.

Latest cloud payroll replay follow-up: 23 October 2026 — SQL faults and real process
interruptions demonstrated committed journals without complete effects/verdicts,
followed by unintended reversal/replacement on replay. The synchronous payroll GL
cloud route now commits its journal, command-linked effect and verdict together.
A server-owned inbox marker binds immutable command data and distinguishes safe
new-protocol retries from uncertain old received work, which holds for reconciliation.
Cloud command status now reads actual received/rejected/confirmed state with existing
ownership checks; unknown IDs return 404 instead of invented confirmation.
No transaction spans awaited loopback dispatch. Office/host/LAN claim authority remains;
normal LAN-origin host-confirmed→cloud-confirmed convergence is covered. See
[contract](payroll-replay-contract.md), [research](payroll-replay-research.md) and
[recovery](../operations/payroll-cloud-replay.md). This supersedes the prior cloud
payroll GL persistence limitation only. Other routes/site-host acceptance, direct-cloud
capture, node rebase interruption, reviewed approval, historical financial repair,
real deployment/device/restore acceptance and independent review remain open. There
is no new owner engineering task now; whole-control totals and release hold are unchanged.

Latest payroll GL retry follow-up: 23 October 2026 — demonstrated receipt-write and
originating-node command-write failures could acknowledge unsafely committed payroll
journals. Keyed posting/receipt writes are now atomic; this synchronous claim route
also commits local source/receipt/command before success. Concurrent or lost-response
same-key retries recover the original acknowledgement. Current access, tenant and
original-command checks hold unsafe replays. The desktop retains one attempt key and
enforces a response deadline and actual account/company/view guards. See
[contract/evidence](payroll-post-retry-contract.md) and [recovery](../operations/payroll-post-retries.md).
No owner engineering action is needed now. Reviewed source-version approval, offline
factor binding, global/cross-server retry protection and the existing authority dispatch/
effect-stream/verdict crash boundaries remain engineering work. Broader release holds,
including the existing node-forge advisory and independent/hosted/device acceptance,
stay open. Whole-control counts are unchanged.

Latest dependency follow-up: 23 October 2026 — the formatter advisory was withdrawn
upstream. Fresh runtime and explicit full-root npm scans return one high/zero moderate;
the reduction is not credited to a delivered package fix. An experimentally verified
parser override was dropped after its rationale changed. Manifests and application
source remain unchanged; a real Word-import recovery/preview/Apply/undo browser test
is retained. node-forge remains an open high finding with no offered upstream fix.
See [decision/research](dependency-parser-contract.md), [procedure](../operations/dependency-parser-upgrade.md)
and dated validation. Candidate evidence is separated from final restored-graph results.
No risk exception or complete release approval is implied.

Payslip email follow-up: 22 October 2026 — exact tenant/actor/session/recipient/saved-content
review now precedes durable confirmation and a separately claimed cloud send. Source/permission/
session changes invalidate stale approval. Accepted, not accepted and uncertain SMTP outcomes
are distinct; uncertain work is not automatically resent. Actual TLS capture, concurrent
requests/workers, process termination, offline correction and sanitized node exports are
covered. See [contract](payroll-email-contract.md), [verification](evidence/payroll-email-verification.json)
and [recovery](../operations/payroll-email-release.md). This supersedes the older statements
below that durable reviewed email remains unimplemented. Real-provider acceptance/mailbox
delivery, hosting, restore and mixed-build/device rollout still need separate external
acceptance. Local SMTP tests do not verify the real provider. Whole controls remain open.

Previous follow-up: 22 October 2026 — all staff payroll print/summary/Excel paths reload saved
payroll with current-source holds and bounded batches. Print rechecks saved preview state;
stale/held frames clear and Print remains disabled. Draft copies have visible labels; unsaved
deduction edits must be saved. Account/company/view guards reject late output. See
[contract](../operations/payroll-staff-copies.md), [six-source research](payroll-copy-research.md)
and [verification](evidence/payroll-copy-verification.json). Downloaded files cannot be recalled;
local replica convergence, signed/final issuance, payment/filing evidence and reviewed durable
email remain. Whole-control counts and release hold are unchanged.

Previous follow-up: 22 October 2026 — paid marking, email and employee list/PDF/timekeeping
now share current payroll source holds. Draft email is refused; malformed JSON cannot crash
the employee candidate read. Known duplicate/identity/cutoff conflicts hold, including custom
aliases. Previously accepted offline payment decisions remain under D6, with atomic source
clashes and current-replica issuance holds. See [contract](../operations/payroll-release.md),
[research](payroll-release-research.md) and [verification](evidence/payroll-release-verification.json).
True duplicate adjustments, unknown legacy linkage, recipient/fresh-proof/durable email design
and payment/filing evidence remain. Whole controls and release hold remain unchanged.

Previous follow-up: 20 October 2026 — missing/invalid payroll cutoff IDs can now be recovered
through a fresh, online reviewed correction when the existing labels uniquely agree. Only the
ID changes, with atomic attributed revision history. Paid/released, duplicate/unresolved,
posted, closed-period and known email cases remain held. Valid-ID transfers are refused to
avoid carrying old calculations into another cutoff. See [operator contract](../operations/payroll-cutoff-recovery.md),
[five-source research](payroll-cutoff-research.md) and [verification](evidence/payroll-cutoff-verification.json).
Actual cutoff transfers, duplicate disposition and the broader payroll/accounting gates remain.

Previous follow-up: 20 October 2026 — shared employee/cutoff source indexing now holds duplicates
across generation, rate recomputation, monthly history, GL and scoped reports. Payroll re-post
validates before an atomic reversal/replacement; closed/refused reversals, invalid/multiple live
journals and write/process failures preserve prior books. Read-only HR/accounting comparison
shows source/journal differences and explicitly unlinked bank/remittance/filing evidence.
See [operator contract](../operations/payroll-reconciliation.md), [research](payroll-reconcile-research.md)
and [verification](evidence/payroll-reconcile-verification.json). Reviewed source disposition,
accrual/settlement policy, version/retry-bound posting and full historical acceptance remain.

Previous follow-up: 20 October 2026 — payroll tax/agency/HR reports now group by stable employee
ID and read identifiers/settings by that ID. Same-name employees remain separate. Unresolved
identity, corrupt/unscopable data and ambiguous cutoff labels block reports rather than guess or
omit amounts; dialogs display the hold and disable exports. See [report operator contract](../operations/payroll-report-identity.md),
[seven-source research](payroll-reports-research.md) and [verification](evidence/payroll-reports-verification.json).
This supersedes earlier notes that stable-ID report grouping is unimplemented. Duplicate
payslips, draft/paid eligibility, historical settings and GL/payment/filing reconciliation remain.

Previous follow-up: 20 October 2026 — reviewed cloud-only repair of unresolved payroll identity
now requires payroll management, fresh proof, evidence reference and a five-minute actor/session/
company/record/employee-bound review. Identity-only correction preserves paid amounts, status and
finalization timestamp, with mandatory atomic revision history. Generic record editing cannot
change the resolved owner. See [operator contract](../operations/payroll-identity-repair.md) and
[seven-source research and decisions](payroll-repair-research.md). Name-grouped statutory
attribution, independent audit protection and operational/privacy acceptance remain open.

Previous follow-up: 20 October 2026 — employee payslip disclosure now fails closed for reused
or ambiguous names and invalid/missing stamped employee references. Self-service and payroll
email share the resolver. Generation refuses unresolved cutoff slips before payroll writes.
See [identity contract and reconciliation limits](../operations/payslip-identity-disclosure.md).
Audited legacy repair and stable-ID statutory aggregation remain engineering work.

Previous follow-up: 20 October 2026 — the BIR 2316 detail response now explicitly selects its
bounded tax-template identity, closing a reproduced accounting-only disclosure of unrelated
HR/pay settings. See [tax privacy](../operations/accounting-tax-privacy.md). Broader export,
retention and authorization controls remain open; whole-control counts are unchanged.

Previous follow-up: 20 October 2026 — manual QuickBooks exports now require recent identity
proof and reviewed destination/source-version preconditions, with live actor/order checks before further
provider calls. Known accepted receipts are preserved; CKD components are excluded from
commercial pricing. A new sensitive-action inventory documents offline financial/payroll,
department and export-minimization work still owed. See
[manual exports](../operations/manual-quickbooks-exports.md) and
[action inventory](sensitive-action-inventory.md). The complete release remains on hold.

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
| High | Complete remaining sensitive-business-action verification with the offline authority model | Action-family inventory and online manual-export checks added 20 October; offline local-factor/command binding and broader server/replay/role/race evidence remain; AUTHZ-15 stays open |
| High | Uniform API validation/error/redaction and privacy export/retention/erasure lifecycle | Route-by-route evidence; tenant-safe restore/copy/integration tests; approved retention scope |
| High | AI privacy/adversarial evaluation, interrupted audit outcomes and hard spend allocation | Isolation/leakage/abuse/cancellation tests and real provider budget acceptance |
| High | Reliable onboarding notification delivery and broader creation admission/reconciliation | Completed keyed HTTP receipts and signup outbox/worker implemented; other API/import retry receipts, provider reconciliation/reviewed resend, external backlog escalation, mixed signup capacity/storage acceptance, legacy/new-key recovery and imported-state acceptance remain. See operations/workspace-onboarding.md |
| High | Native/Electron distribution and supported-client acceptance | APK/installer builds, signed artifacts, actual Windows/Android vault/backup/logout/upgrade checks |
| High | Payroll source/ledger/payment/filing reconciliation | Stable-ID grouping, generation/reporting/issuance source holds, paid-only email, atomic journal replacement and bounded current-source comparison implemented. Reviewed duplicate/malformed/cutoff transfers (only consistent missing/invalid IDs recoverable), eligibility, historical snapshots, accrual/payment dates, retry-safe posting and bank/remittance/filing evidence remain. See operations/payroll-report-identity.md |
| High | Integration lifecycle and accounting reconciliation acceptance | Local generation/scoping, refresh admission, export exclusion and durable uncertain-write handling implemented 2026-10-18; actual Intuit sandbox, legacy adoption/repair tooling, interrupted-claim reconciliation, operational alerting and accountant acceptance remain. See operations/quickbooks-lifecycle.md |
| High | Resolve or explicitly disposition vulnerable dependencies and historical-secret gates | Current 24 October runtime snapshot:4 high / 1 moderate package findings,7 active records; reproduce affected app paths and verify compatible fixes or an approved expiring risk record. Verify historical revocation without exposing old bearers. See runtime-advisories-2026-10-24.md |
| High | Align minimum-runtime declarations/CI with actually required SQLite APIs | Existing `>=22.13` declaration conflicts with `isTransaction` added 22.16. API mismatch is demonstrated; verify affected transaction guards on supported patched runtimes and reproduce financial consequences before claiming disposition |
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


## Public inquiry retry follow-up — 2026-10-19

Medium scoped gap: an inquiry/owner alert could duplicate after a committed response was lost.
Updated website keeps one random key across edits/retries; normalized request details bind
source/alert/receipt publication. Matching retries return only {ok:true}. Mismatches, expiry or
missing source conflict without private data. Failure/competing uniqueness rolls back source.

Public verifier work is asynchronous and shares the existing one-active/eight-waiting bounded
login budget. Saturation returns safe 503; source/expiry/verifier are rechecked after awaiting.
The production five/hour limiter still counts replays. Browser tests lose a real committed
response, edit/conflict, restore/replay and verify one inquiry/alert; SQLite and two child exits
verify rollback/persistence. An intermediate fixture SQL type error is retained and corrected.

See operations/inquiry-retries.md and inquiry-receipts-* evidence. No-key/new-page/legacy
duplicates, other API/import retries, public signup admission, shared login/inquiry capacity,
queue/provider reconciliation/escalation and wider financial/security/device/hosted/governance
gates remain. No owner action is needed now. Whole-control totals/release hold stay unchanged.

The inquiry form also bounds each fetch/body read with a 20-second abort timer. A browser-clock
test withholds a real committed response, advances the timer and verifies same-key retry. Abort
does not imply server rollback. One preliminary full run was interrupted (130) to include this
fix; only the subsequent complete regression counts. Broader browser/request deadlines remain
outside this contact form's change.
