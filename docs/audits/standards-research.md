# Standards research and implementation record

Reviewed 16 October 2026. Supplements the uploaded audit guide and the second-pass audit;
it does not replace their findings or imply certification. The guide is reference material;
the user's request determines the authorized work. Recommendations below are engineering
decisions unless identified as a requirement of a particular standard. No production access,
deployment or destructive data operation is implied by a standard's recommendation.

## Authoritative baseline

| Source checked | Application to this app | Verification and outstanding evidence |
|---|---|---|
| [OWASP ASVS 5.0.0](https://owasp.org/projects/asvs) | Use versioned verification requirements for authentication, authorization, validation, files, sessions and communications. Target applicable Level 2 controls for business and employee data; this is a target, not achieved assurance. | The existing handbook scorecard is not a complete ASVS crosswalk. Requirement-by-requirement applicability, evidence and independent review remain necessary before making an ASVS claim. |
| [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), final 2025 | Password-only accounts need a stronger password policy; AAL2 requires offering phishing-resistant authentication. TOTP is useful but is not phishing-resistant. | Current eight-character minimum and optional tenant MFA do not establish AAL2. Hash storage migration is implemented as described below; password policy, passkeys/security keys, console MFA and sensitive-action reauthentication remain engineering work. Existing credentials require a deliberate migration, not a login-breaking global validator change. |
| [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) | Factor replacement needs existing-factor verification; session possession alone is insufficient. Rate limits and session termination constrain account takeover. | Self-service disable/recovery already verify password and an existing code. This change adds a shared account failure budget and revokes other sessions when disabling MFA. Assisted resets now require fresh proof, bound emailed links, notifications and re-enrollment; solo provider support includes cancellation and a 24-hour wait. Policy changes, broader privileged step-up and console passkeys still need work. See the assisted-recovery runbook. |
| [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | Prefer Argon2id for new password storage; bcrypt is a legacy choice with an input byte limit. | New password writes now use versioned scrypt at the documented OWASP baseline. Verified cloud/console bcrypt logins migrate conditionally; legacy inputs over 72 UTF-8 bytes require recovery. Long Unicode and suffix verification have regression coverage. Password minimum, deployment compatibility and synchronous resource use remain open; see the migration runbook. |
| [OWASP MASVS-STORAGE-1](https://mas.owasp.org/MASVS/controls/MASVS-STORAGE-1/) and [Android Keystore](https://developer.android.com/privacy-and-security/keystore) | Native persistent credentials need OS-backed protection, with backup, logout and device-lock behavior tested. | Native bearer compatibility is not secure storage. Audit localStorage, IndexedDB and queued credentials together; integrate a maintained native adapter and fail closed if unavailable. Hardware backing depends on the device and must be checked rather than assumed. Physical Android evidence and an actual iOS implementation remain missing. |
| [NIST SSDF 1.1 final](https://csrc.nist.gov/pubs/sp/800/218/final) | Secure development, artifact integrity, dependency response and reviewable release evidence. | Existing tests/scans contribute evidence, but branch protections, unresolved advisories, historical-secret response and release provenance remain open. [SSDF 1.2](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd) is listed as an initial public draft; do not present it as the final baseline. |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Target applicable AA criteria across complete workflows, including keyboard operation, focus, accessible authentication and errors. | Login axe checks and selected Playwright workflows are limited evidence. All-screen AA conformance and assistive-technology testing have not been established. |
| [OWASP GenAI project](https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/) | Treat retrieved text and model output as untrusted; enforce authorization outside the model, constrain tools and resource consumption. | The project now advertises a 2026 edition; older 2025 risk identifiers must retain their edition. Existing read-only production tools and bounded network access reduce risk; adversarial disclosure/output tests, privacy filtering and external audit integrity remain incomplete. A complete 2026 crosswalk has not been performed. |

Apple's [Keychain services](https://developer.apple.com/documentation/security/keychain-services)
was also checked as the intended iOS API. The research tool could not extract its detailed
JavaScript-rendered documentation; no specific accessibility/backup configuration is asserted
as verified from that page.

## Concrete change in this increment

`core/auth.routes.ts` now applies one shared account-and-tenant limiter to setup, enable,
disable and recovery-code replacement, after authentication and the existing online gate.
Ten failed verifications in fifteen minutes block further attempts, including attempts from
another session or another factor endpoint. Successful operations do not spend the failure
budget. A blocked request receives 429 and Retry-After before a factor is consumed or changed.
Disabling MFA with the current password and an existing single-use factor ends other sessions.
The verified current session remains active.

The limiter uses the existing express-rate-limit library rather than custom cryptography.
Its in-memory store is per server process: horizontal replicas need a shared limiter store
before claiming a deployment-wide ten-attempt ceiling. Restarting the process clears the
budget. Existing enrollment expiry/session binding and five-attempt login challenges remain.

Regression tests exercise cross-session/cross-endpoint blocking, non-consumption of a valid
recovery code when blocked, required factor proof, other-session revocation and retention of
the current session. The source-only route-class check and typecheck also pass. Full-suite
and Playwright outcomes are recorded in the validation results after completion.

## Priority and resolution

| Priority | Gap | Resolution and acceptance evidence |
|---|---|---|
| High | Console password-only authentication and sensitive administrator actions | Implement MFA/passkeys and server-bound fresh verification, protect recovery, test hijacked/old sessions and privilege boundaries. |
| High | Password-only minimum and migration rollout | Versioned hashing and bounded legacy verification are implemented. Enforce the researched minimum on new credentials, coordinate installed-host compatibility and verify resource limits on deployment hardware. |
| High | Native persisted bearer tokens | OS-backed vault plus startup migration and removal from queue/storage copies; test unavailable vault, logout, backup/restore and real-device extraction. |
| High | Historical credential and dependency gate failures | Revoke/rotate exposed credentials, investigate exposure, resolve or explicitly assess each advisory; never hide failures to obtain a green release. |
| Medium–High | API/error contracts, data lifecycle and AI disclosure controls | Extend strict schemas and safe errors; implement scoped export/deletion/retention with legal holds and auditable dry runs; adversarially test AI data access/output. Severity depends on affected route/data. |
| Medium | Accessibility coverage and release evidence | Expand complete keyboard/assistive workflows and signed release/restore evidence; selected browser scans cannot close these controls. |

These are open engineering tasks, not instructions for the owner to implement code. Account
access, legal/business retention choices, physical-device observation and live infrastructure
evidence may require owner participation. No claim that every standard or every app feature
has been audited follows from this research increment. Handbook scorecard totals remain the
previous snapshot; new findings above must be reconciled before final release sign-off.

## Password storage follow-up

All password writers/verifiers now share versioned scrypt storage and bounded bcrypt compatibility.
The [migration runbook](../operations/password-migration.md) records implemented paths, legacy
recovery, coordinated cloud/site deployment, rollback constraints, resource costs and remaining
policy work. This does not close the other authentication findings or authorize live rollout.

## Assisted recovery follow-up

Schema 84 and the [assisted recovery runbook](../operations/assisted-account-recovery.md)
replace the old immediate MFA-reset bypass. Provider recovery supports a solo operator with
advance email notice, owner cancellation, a server-enforced 24-hour wait, fresh password and
renewed case verification. Tenant peer assistance requires an enrolled factor and password.
Redemption binds the existing contact/credential, revokes sessions and challenges, and requires
MFA enrollment. The synchronized non-secret restriction reaches updated office hosts; a
disconnected host cannot receive a cloud state change until it reconnects. Console passkeys,
real email delivery, operational identity checks and broader release findings remain open.


## Console passkey follow-up

Owner-console WebAuthn now verifies required user verification, exact configured origin/RP,
single-use challenges and fresh proofs for console mutations. Passwords alone cannot open an
enrolled account. The [runbook](../operations/console-passkeys.md) explains opt-in rollout,
Windows Hello, independent backup keys and the unverified physical-device/deployment boundary.
This implements the console portion of the high-priority authentication finding; tenant-wide
step-up, stronger new-password minimum and native secure storage remain engineering tasks.


## New-password policy follow-up

The 15–128 Unicode-code-point policy now covers HTTP and direct writers, including both
bootstrap paths and operator CLI. Existing short credentials continue to verify.
The [policy runbook](../operations/new-password-policy.md) records blocklist, normalization,
installed-host compatibility and test limits. This resolves the new-password minimum/writer
consistency increment; synchronous scrypt availability and the other open controls remain.


## Native persistence and replay follow-up

A reviewed, pinned Capacitor OS-vault provider is now integrated with fail-closed startup,
server-bound session acceptance, signed-out tombstones and no native plaintext queue mirror.
Both replay paths bind actor/company, and web workers now carry cookie CSRF/actor headers.
The [runbook](../operations/native-credential-storage.md) distinguishes local test/build evidence
from unperformed APK/Keystore/device/backup validation. It also identifies plaintext personal
caches outside the credential vault, old draft migration and still-open TLS pinning decisions.


## Public sign-in availability follow-up

Public tenant/console verification now uses async native scrypt with a bounded shared work
queue, stale-credential rechecks and explicit 503/Retry-After backpressure. Existing bcrypt
compatibility yields cooperatively. See [the work-budget runbook](../operations/password-work-budget.md)
for tests and limits: authenticated/CLI synchronous writers, per-process request limits and
real hardware capacity are not declared resolved by this increment.

## Administrative reauthentication follow-up — 2026-10-16

Rechecked OWASP Authentication (Require Re-authentication for Sensitive Features) and MFA guidance.
Implemented session-bound recent password + existing-factor verification for account/role/policy,
node-trust and integration-configuration writes, with a shared accessible confirmation and no
credential persistence. Five minutes is a local risk decision, not a universal standards interval.
OAuth state additionally binds the live initiating authorization across token exchange. See
`operations/tenant-step-up.md` for exact scope. Earlier baseline observations above are historical:
password bounds, console passkeys, native vault adapter and this administrative scope now have
code/tests. Deployment enforcement, hardware acceptance, remaining business actions and complete
ASVS/NIST assurance are still unverified; no certification or complete conformance is claimed.

## QuickBooks lifecycle research — 2026-10-18

[Intuit's official OAuth client](https://github.com/intuit/oauth-jsclient#refresh-access_token)
confirms that callers must persist/use the most recently returned refresh token. Local changes
add shared refresh admission, SQLite ownership/CAS checks and connection generations so delayed
work cannot overwrite newer credentials or attach records across companies. Export exclusion and
durable outcomes block blind duplicates after uncertain remote acceptance. These are local design
controls; they do not certify provider-side exactly-once behavior. The Intuit developer OAuth/REST
pages returned only JavaScript loading content to the research tool. Confirm request-ID semantics,
actual remote failures and reconciliation in sandbox before release. See the dated lifecycle
runbook for evidence, upgrade restrictions and remaining acceptance work.

## Durable automatic-export follow-up — 2026-10-18

Reviewed [AWS transactional-outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).
Applied same-transaction business intent plus a separate idempotent consumer, rather than sending
a financial write after the save had already committed. The SQLite queue coalesces desired
versions, persists bounded retries and preserves unknown outcomes for reconciliation. A local
outbox is not an exactly-once remote guarantee. Real provider and operational acceptance remain;
see operations/quickbooks-auto-exports.md. No AWS messaging service was provisioned.


### Local onboarding transactions — 19 October 2026

Primary SQLite documentation: https://www.sqlite.org/lang_transaction.html and
https://www.sqlite.org/lang_savepoint.html (reviewed 19 October 2026). BEGIN/COMMIT does not nest;
inner savepoint release remains subject to outer rollback. A write statement obtains the
single catalog writer before invoice reference reads. The implementation uses these properties
for signup payment/subscription/contact/first-invoice setup and console inquiry/module setup,
with invoice/audit nested inside publication. Real SQLite faults and a child process exit test
prove the tested rollback boundaries. Browser tests verify corrected retry and one invoice.
This is not a distributed transaction, durable HTTP response replay, reliable mail delivery,
power-loss/hosting certification or a substitute for broader billing policy acceptance. See
operations/workspace-onboarding.md, catalog-setup evidence and validation-results.md.

### Durable creation retries — 19 October 2026

Primary sources accessed today: Stripe's application idempotency guidance
https://docs.stripe.com/api/idempotent_requests (random v4 keys, parameter mismatch protection,
original response replay) and OWASP Password Storage Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html (slow salted
password protection, scrypt N=2^17,r=8,p=1). The creation payload includes a password, so a fast
unkeyed body hash stored in platform.db would introduce a cheap offline password verifier.
The implementation persists salted scrypt of the canonical request digest, never that digest
or the raw payload. SQLite savepoints/unique constraints bind the receipt to local publication.

The application contract deliberately differs from Stripe's API-v1 error caching and pruned-key
reuse: only completed 201s are stored; expired payloads are cleared but tombstones block reuse.
The documented header is an application API contract; no finalized IETF idempotency standard,
provider certification, exactly-once notification delivery or complete-control PASS is claimed.
Real browser response loss and process exit evidence establish only the tested local boundaries.

### Signup alert outbox and provider uncertainty — 19 October 2026

Primary sources reviewed: AWS Prescriptive Guidance transactional outbox
https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
(same-transaction event intent; duplicate/message-consumer and rollback concerns), Brevo
https://developers.brevo.com/reference/send-transac-email (HTTP 201 acceptance) and
https://developers.brevo.com/docs/api-limits (HTTP 429 throttling), Nodemailer
https://nodemailer.com/smtp (TLS and connection/greeting/idle timeout options), and SMTP RFC 5321
https://www.rfc-editor.org/rfc/rfc5321.html (acceptance/responsibility, timeouts and duplicate risk).
No AWS broker or other infrastructure was provisioned. The inaccessible candidate Brevo rate-limit
headers page was not treated as evidence; generic Retry-After seconds/date is an explicit local
contract, not a claim that every Brevo response includes it.

The local implementation commits signup intent with catalog setup, claims before network I/O
and preserves unknown outcomes instead of assuming rejection or exactly-once mail. Explicit 429
alone has automatic bounded retry. SMTP TLS, deadlines, partial-recipient uncertainty and provider
diagnostic redaction apply to the shared platform adapter, not all tenant mail. Console privacy/
async error boundary checks supplement transport tests. Local SQLite faults, actual child exits/
server startup and Chromium status-failure tests do not establish real inbox delivery, hosted
operation, supported-device acceptance or complete-control PASS. Other notification paths remain
outside transactional coverage. See owner-alert-outbox.md and owner-outbox-* evidence.

Installed Nodemailer 10.1.1 source was also reviewed for cancellation: the non-pooled transport's
close emits a close event/releases auth resources without closing its active SMTP connection.
The adapter therefore owns the supported caller-supplied socket, explicitly destroys it on
completion/deadline and bounds DNS/connection/greeting/idle waits. A real stalled local SMTP
connection verifies teardown rather than relying solely on a mocked close method. No private
Nodemailer connection fields or dependency fork were introduced.


### Inquiry/payment atomic intent and upload storage — 19 October 2026

Primary sources reviewed today: SQLite savepoints https://www.sqlite.org/lang_savepoint.html ,
atomic commit https://www.sqlite.org/atomiccommit.html , WAL https://www.sqlite.org/wal.html ,
AWS transactional outbox guidance
https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
and OWASP File Upload Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html .

The atomic-commit article describes rollback journaling; this app uses WAL, whose separate
constraints apply. Tests establish one-catalog local rollback/process-exit behavior, not power-loss
or network-filesystem/multi-host certification. Savepoints bind source, proof BLOBs, audit and
event intent; provider I/O is outside the transaction. Source-key uniqueness is not HTTP retry
idempotency or exactly-once remote delivery. No AWS infrastructure was provisioned.

Random names/private lazy caches and existing MIME/size checks reduce specific storage risks;
OWASP's layered signature/content/malware/serving controls remain separate acceptance work.
A client MIME type is not a trusted content verdict. Consistent settings/secret snapshots and
atomic console configuration/audit updates additionally prevent cross-generation host/password
pairing and partial settings commits. Tests use a separate SQLite connection and injected faults,
not a live SMTP/provider configuration change. See business-alerts-* evidence and runbook.


### Payment-report request receipts — 19 October 2026

Primary sources reviewed today: Stripe https://docs.stripe.com/api/idempotent_requests and SQLite
https://www.sqlite.org/lang_savepoint.html . Stripe describes random request keys, matching
parameters and successful retry without another object; SQLite documents nested/outer commit
boundaries. This application uses its own contract: completed 201 only, parsed attachment-byte
binding, tenant/actor scope, current permission checks and retained expired tombstones. It does
not cache all errors or reuse pruned keys like Stripe API v1, and does not introduce Stripe
charging. Receipt/source share one catalog transaction, not a distributed transaction. Local
process-exit/browser evidence is not power-loss/provider/hosting acceptance or complete-control
PASS. See operations/payment-report-retries.md and payment-receipts-* evidence.

Express 4 API application settings https://expressjs.com/en/4x/api/application/#app.set
documents case-sensitive and strict routing behavior; both settings are undefined by default.
The local app test confirms its case-insensitive/non-strict behavior. A local regression reproduced
changed-proof replay through the old generic cache on a case-variant/trailing-slash payment URL;
the route exemption now uses matching case-insensitive semantics. This is tested behavior, not
a claim that every route alias in the app has been audited.


### Public inquiry receipts and verifier admission — 19 October 2026

Primary sources reviewed today: Stripe https://docs.stripe.com/api/idempotent_requests , SQLite
https://www.sqlite.org/lang_savepoint.html and OWASP DoS Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html . Random stable
request keys/parameter binding inform retries; nested savepoints bind source/event/receipt.
Own contract stores only successful intent verification and reconstructs a constant public
acknowledgement, retaining expired markers instead of allowing pruned-key reuse. No Stripe
provider/charging integration is added.

The new public path uses the existing salted verifier format through bounded asynchronous
native crypto, outside catalog transactions. Existing per-IP controls count replays; one-active/
eight-waiting work bounds memory/backlog and returns authored busy responses. This follows
resource-budget/backpressure principles without claiming distributed DoS prevention, measured
login/inquiry SLA or hosting certification. After waiting, source/verifier/expiry are rechecked.
Tests use isolated HTTP/SQLite faults, process exits and Chromium response loss; power-loss/
real-host/provider/device acceptance remains separate. See inquiry-retries.md and evidence.

MDN AbortController.abort https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort
was also reviewed today: abort covers fetch and response-body consumption. The contact form
uses a 20-second application timer, clears it on completion and retains uncertain request
identity. It does not infer server rollback or claim timer accuracy across browser suspension.
Controlled Playwright clock advancement follows a real withheld committed HTTP response.


### Owner-alert observation — 19 October 2026

Primary sources retrieved today: Google SRE, Monitoring Distributed Systems,
https://sre.google/sre-book/monitoring-distributed-systems/ and SQLite Row Values,
https://www.sqlite.org/rowvalue.html . SRE distinguishes internal observations from externally
visible outcomes and advocates understandable, actionable alerting. This increment displays
queue symptoms/worker freshness without equating a worker pass with inbox acceptance. A
manual dashboard does not fulfill paging: external watchdog, routing and escalation remain.

SQLite's scrolling-window discussion informs cursor pagination rather than growing offsets.
This app uses an explicit comparison predicate to support mixed directions and a queue tie-break
across two tables. Tests traverse equal timestamps/IDs without loss or duplication. Cursors
validate navigation values and filter but do not replace authentication or promise snapshots.
No claim of universal standards compliance or hosted capacity follows from these references.
The initial search tool request returned an error; direct retrieval of both primary pages succeeded.


### Public signup availability — 19 October 2026

Primary sources retrieved today: Node 24 crypto.scrypt,
https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback ,
Node event-loop/worker-pool guidance,
https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop , and OWASP DoS Cheat Sheet,
https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html . The generic
Node API page also resolved to current v26 documentation; the version-24 source matches the
supported application API contract. Async crypto alone does not eliminate pool/resource
exhaustion: public signup reuses bounded native jobs and adds one-active/no-backlog request
admission rather than creating an unbounded signup queue. Stored scrypt parameters remain.

Receipt and current catalog state are rechecked after awaited work; source/receipt publication
stays synchronous/atomic. Native jobs are not cancellable and database setup remains on the
main thread. Local event-loop, saturation, process/replay/fault and browser uncertainty tests
support this scoped change, not a hosted SLA, distributed abuse defense or standards certification.
No edge/provider/host policy was provisioned. Existing browser abort/key-retry principles apply;
abort is not proof of rollback. See public-signup-budget.md and signup-budget-* evidence.


### Manual financial export verification — 20 October 2026

Primary sources retrieved today: OWASP Authentication,
https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html ; OWASP Transaction
Authorization, https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html ;
and HTTP RFC 9110 section 9.2.2, https://httpwg.org/specs/rfc9110.html#idempotent.methods .
The design uses server-side live checks, recent session proof and significant-data review with
an explicit destination generation. It is not unique, signed transaction approval. Order/item
and actor state is rechecked before further sends, while accepted provider receipts are kept.
HTTP retry guidance supports refusing blind replays of uncertain non-idempotent operations.

Intuit search and direct retrieval of request-ID/error-handling pages failed in this session;
no new provider deduplication duration or reconciliation guarantee is asserted. Existing
unknown/no-resend behavior remains. Offline financial claims retain their existing authority:
cloud-only reauthentication would break accepted site replay, and copying cloud factors would
create a different risk. Dedicated local-factor/command-binding design remains engineering work.
See sensitive-action-inventory.md and manual-quickbooks-exports.md for scope and open acceptance.


Review strengthened the final manual contract with a current-order/destination preview under
one SQLite read transaction. The displayed total is refreshed and its non-secret source hash
is checked before execution; the client captures actor/server/view across confirmation. A
source-version precondition and short-lived session reauthentication still do not constitute
a unique one-use transaction credential. Known sent acceptance remains evidence even if the
actor/source changes afterward. Interrupted runs are retained and replaced by final verification.

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


## Reviewed unresolved payroll identity repair — 20 October 2026

New cloud-only payroll-manager review/confirmation changes only employee_id with fresh
identity proof and an expiring actor/session/company/record/employee-bound review.
Existing paid amounts/status/finalization time are preserved and revision history is
mandatory; ordinary record editing cannot change a resolved owner. Evidence references
are metadata, not uploaded identity documents. No automatic email, payment or deletion.
See [operator contract](../operations/payroll-identity-repair.md) and [seven-source research](../audits/payroll-repair-research.md).
Statutory name aggregation, recipient/rights procedures, approved retention, independent
audit protection, office replay/restore and supported-operator acceptance remain open.
This scoped implementation does not promote whole handbook controls or release approval.


## Stable payroll report identity — 20 October 2026

[Seven-source review and decisions](payroll-reports-research.md) covers official BIR
2316/Alphalist, SSS member-attribution instructions plus current e-CS guidance, NPC
accuracy/proportionality, OWASP server authority/safe failure and RFC 9110 conflicts.
Reports group by ID and block uncertain attribution; no formula/filing certification,
automatic reconstruction or universal historical-data acceptance is inferred. Sources
are separated from project policy and remaining reconciliation work in that document.


## Payroll source and journal reconciliation — 20 October 2026

[Seven-source review](payroll-reconcile-research.md) distinguishes SQLite transaction/snapshot
rules, OWASP execution checks, NPC accuracy/proportionality, RFC conflicts, actual wage-payment
obligations and IAS 19 recognition versus settlement. Applied source/atomicity/privacy checks
are distinguished from unfinished accrual-date policy, unique transaction authorization,
retry-safe commands and real bank/remittance/filing evidence. No accounting/labor compliance
certificate or entity-specific IFRS applicability is inferred.


## Reviewed payroll cutoff ID recovery — 20 October 2026

[Five primary sources](payroll-cutoff-research.md) cover ordered, state-bound transaction
review, per-request authority, attributed credential-safe history, proportionate correction
and SQLite rollback. [Implementation scope](../operations/payroll-cutoff-recovery.md) preserves
financial/calculation data and refuses transfers, paid/posted/closed history and duplicates.
Label consistency and evidence attestation do not independently establish historical truth,
issued-copy/filing status, accounting/legal compliance or malicious-insider resistance.
