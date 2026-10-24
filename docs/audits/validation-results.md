# Second-pass validation — 16 October 2026

Latest runtime support evidence: [24 October runtime admission](runtime-support-contract.md),
with the dated entry at the end. Latest dependency evidence: [24 October runtime remediation](dependency-remediation-2026-10-24.md)
and the dated entry at the end of this record. Earlier 23 October candidate/original-dependency
runs remain distinguished at their original cutoff.
The subsequent 23 October payroll GL retry follow-up records the newer application
tree and complete regression; broader release holds are unchanged. The latest cloud
payroll replay/status follow-up at the end records the final transaction/retention tree.

Source cutoff: `restructure/module-architecture` at
`495db101c3efbe4e4546221fed2db3af233b00aa`, merged into `production` with the audit fixes.
Current delivery scope and remaining work: [engineering-handoff.md](engineering-handoff.md). Earlier reports describe older trees. The verification summary in
`evidence/second-pass-verification.json` describes the original second-pass run.

## Assisted recovery follow-up

Final schema-84 implementation supports a solo provider operator: fresh password and documented
verification, advance notice/cancellation to the existing owner email, a server-enforced
24-hour wait, then fresh verification and a fifteen-minute single-use recovery link. Requests
expire after 48 hours. A different operator cannot bypass the waiting period. Verified tenant
peer recovery instead requires the assisting administrator's password and existing factor.
Ordinary password resets preserve MFA and invalidate pending MFA login challenges.

- **Full regression: 286 files / 2,881 tests passed**, 527.39 seconds
  ([log](evidence/recovery-regression.txt)). This is the completed run after the solo-support,
  cancellation and final synchronized restriction changes.
- **Focused: 8 files / 54 tests passed**, 43.42 seconds
  ([log](evidence/recovery-focused.txt)): fresh proof, early approval denial, later solo approval,
  cross-tenant denial, cancellation/reuse, expiry, changed contact, failed send, stale challenges,
  mandatory re-enrollment, site-mode restriction and schema-83 migration column order.
- **Playwright: 10 scenarios passed**, 36.8 seconds
  ([log](evidence/recovery-playwright.txt)). New scenarios cover actual reset-link UI and forced
  enrollment, plus inert cancellation GET previews and explicit single-use confirmation. The
  browser recovery cases use disposable preapproved/cancellation fixtures; the request/approval
  API tests use mocked email, not a real provider or a wall-clock 24-hour wait.
- Typecheck and delivered JS syntax checks passed ([TypeScript log](evidence/recovery-typecheck.txt)).
  Database types regenerated successfully ([generator log](evidence/recovery-dbtypes.txt)).
- Staged Gitleaks passed ([log](evidence/recovery-secrets.txt)); the commit hook scans final staged
  content again. This does not close historical-secret findings or dependency advisories.

Earlier runs were interrupted to incorporate review findings and the user's solo-support
constraint. One broad run exposed an existing mobile handoff test's fixed-delay assumption;
that test now waits for the actual package control before checking the required-item behavior.
The complete final run includes that correction. No application handoff behavior was changed.

The [operational runbook](../operations/assisted-account-recovery.md) covers manual identity
verification, notices, cancellation, expiry, legal/process approval, and release limits.
The non-secret recovery restriction synchronizes to updated office hosts; a disconnected host
cannot receive a cloud revocation until reconnection. Real email delivery, device acceptance,
console Windows Hello/passkeys, multi-replica limits and externally immutable/retention-complete
audit storage remain unverified or unfinished. No live account, email or hosting settings
were changed. These results establish this increment's tests, not a full production sign-off.

## Earlier password storage follow-up

Versioned scrypt storage replaces all application bcrypt writers; bounded bcrypt verification
remains for legacy credentials. No dependency or database-schema change was needed.

- Full regression: **285 files / 2,872 tests passed**, 498.47 seconds
  ([log](evidence/password-regression.txt)). This run started before the final installed-site
  migration guard/test was added and is broad regression evidence, not an exact-final-tree run.
- Final focused regression: **2 files / 9 tests passed**, 45.19 seconds
  ([log](evidence/password-focused.txt)), including that site credential-ownership guard,
  both account stores, long Unicode input, legacy truncation rejection, malformed hashes,
  failed-login non-migration and every configured role's credential-change workflow.
- Final Playwright: **8 scenarios passed**, 27.1 seconds
  ([log](evidence/password-playwright.txt)). The MFA scenario now creates and signs into the
  account with a 100-character password through both desktop and mobile UIs.
- Final TypeScript check passed ([log](evidence/password-typecheck.txt)).
- Staged secret scan passed ([log](evidence/password-secrets.txt)); commit hook scans the
  final staged content again. No historical-secret or advisory finding is closed by this.

The initial focused all-role workflow exceeded its 20-second test timeout under the stronger
derivation cost. Only that test's timeout was extended to 60 seconds; no test-only hash cost
or production policy bypass was introduced. The final focused run passes at real parameters.

The [migration runbook](../operations/password-migration.md) describes old-site compatibility,
rollback restrictions, recovery for legacy long passwords, and synchronous CPU/memory limits.
Password minimum policy, console MFA, fresh privileged verification and native vault storage
remain open. Live rollout, real-device/installed-host acceptance and representative sign-in
load were not performed. This is a tested password-storage increment, not release sign-off.

## Earlier standards follow-up

The [standards research increment](standards-research.md) adds account-scoped MFA failure
limits and revocation of other sessions when disabling MFA. Validation after these changes:

- Full regression: **284 files / 2,867 tests passed**, 277.78 seconds, using
  `npm test -- --fileParallelism --maxWorkers=2` ([log](evidence/standards-regression.txt)).
- Playwright: **8 scenarios passed**, 17.6 seconds, including the expanded desktop factor-disable
  flow and revoked mobile browser session ([log](evidence/standards-playwright.txt)).
- `npm run typecheck` passed; MFA and route-class focused run: 9 tests passed.
  After replacing the two new tests' fixed passwords with runtime-generated values,
  the MFA file was rechecked: 8 tests passed. Application behavior was unchanged.
- Staged Gitleaks scan passed with no findings ([log](evidence/standards-staged-secrets.txt)).
  A first scan used multiple positional paths incorrectly and scanned wider local artifacts;
  it is not the staged-source result. Reviewed fixed synthetic passwords in the new tests were
  replaced rather than added to the secret scanner's ignore list.
- The sandbox initially prevented temporary HTTP listeners; API/browser tests were rerun
  successfully with local-server execution permitted. No live target was tested.

No new ZAP, capacity or dependency scan was performed for this bounded authentication change;
their earlier scopes and unresolved findings below still apply. Research identifies additional
open gaps; these results are not a production sign-off or standards certification.

## Earlier second-pass results

| Check | Scope and result |
|---|---|
| TypeScript | `npm run typecheck` passed after latest source merge |
| Database types | Regenerated from a disposable database; no live migration/data changes |
| JavaScript parse | 171 delivered JS files across public, website and owner console passed syntax checks |
| Full regression | **284 files / 2865 tests passed**; `npm test -- --fileParallelism --maxWorkers=2`, isolated fixture paths |
| Latest source delta | 4 files, 153 tests passed: mobile frontend, order release, QA hold and registered-route boundary |
| Playwright + axe | 8 scenarios passed on final merged source, 17.1 seconds; no Serious/Critical axe findings on the two tested login pages |
| ZAP 2.17.0 | Disposable local unauthenticated scan: 0 High, 2 Medium, 0 Low, 2 Informational; 109 discovered endpoints, all GET |
| Local capacity probe | 450 synthetic read requests, 5/15/30 clients, zero failures; p95 approximately 17/54/124 ms |
| npm | Root 0 Critical/1 High/10 Moderate; launcher 0/0/8; mobile 0/0/0. Runtime reachability and unresolved gate described in dependency-audit.md |
| Gitleaks | Current src/public/tests/website/console and staged changes scanned with redaction; reviewed synthetic fixtures only. Historical credential finding remains |
| Connected service | Read-only Railway/GitHub metadata inspected; no production scan/load/deployment or data mutation |

The 8 browser scenarios exercise wrong-password/keyboard login, idempotent stock adjustment,
server logout revocation, 360/390 px mobile navigation, offline failure, cookie WebSockets, null
PWA bearer metadata, hostile CORS/oversized inputs, cross-user notes/access revocation, policy
links, inert uploaded scripts/message HTML, desktop authenticator enrollment and one-use recovery
codes across desktop/mobile sign-in. Browser screenshots/traces use synthetic data and are
retained as CI artifacts. These are selected workflows, not complete cross-browser or all-screen
accessibility certification. Native Android/iOS, Windows installer/signing and physical devices
were not validated by Playwright.

The first combined regression run was invalidated by dependency changes. Subsequent runs found
actual merge issues and stale expectations around stricter session revocation, OAuth state and
generic server errors; those were corrected and focused tests rerun. One mobile recovery test
used an 80 ms IndexedDB timing assumption; it now awaits the actual saved/retry/confirmed state.
Tests do not permit old sessions to remain valid merely to retain previous assertions.

The tenant-prefixed policy links, public website cookie handoff, Billing and preview route wiring also passed a 28-test focused run after their final changes.

The initial ZAP High metadata alert was a 200 SPA fallback at `/metadata/instance`, not an observed
metadata proxy. Unknown paths now return 404, with a direct regression test. Missing headers on
public policy pages were real and fixed. Remaining Medium findings are the deliberate inline
style policy and HTTPS image sources. No authenticated ZAP crawl or live-edge test is claimed;
ZAP reported add-on age/warnings. Its scanner snapshot preceded the last small sale-line allocation merge and final policy-link/preview wiring changes; the later changes have direct API/browser regression coverage. This scan supplements those tests and does not replace an exact-release authenticated scan or a current independent penetration test.

The local load probe uses 100 items, read-only traffic and test-mode rate limits. It does not test
large payroll/exports, sustained writes, failover, production hardware, representative datasets
or a promised user ceiling. A complete live-size restore with keys/files, actual alert delivery,
WAF/email DNS/private-object policies and legal approvals remain release evidence gaps.

## Console passkeys — 2026-10-16

Full regression: **287 files / 2,887 tests passed** (525.80 seconds). Playwright: **11 scenarios
passed** (37.4 seconds), including real WebAuthn enrollment/login, replay rejection, mandatory
policy activation, last-key protection and rejection of a signed assertion without user
verification. TypeScript, frontend/script syntax, schema-type generation and staged Gitleaks
checks passed. The pinned browser bundle reproduced without a diff. Evidence:
`evidence/console-passkeys-{full,playwright,typecheck,staged-secrets}.txt`.

Runtime npm audit remains nonzero (0 Critical / 1 High / 3 Moderate); see the dependency report.
Physical Windows Hello/security-key behavior, production origin/proxy/cookie enforcement,
external access restrictions and mandatory enrollment are unverified rollout checks. This
increment does not close broader tenant step-up, password-policy or native-vault findings.

## New-password policy — 2026-10-16

Focused authentication/provisioning regression: 8 files / 88 tests passed. Final policy/default
bootstrap boundary checks: 2 files / 11 tests passed. All 11 Playwright scenarios passed
(35.6 seconds). Typecheck/schema generation and changed frontend/script syntax checks passed.

The initial full run had **287 passing files / 2,891 passing tests**, with one setup failure
skipping six tenant-path tests: its second tenant still used a 14-character password. That
synthetic fixture now uses a compliant password; its isolated rerun passed all six tests.
This is not described as an uninterrupted green full run. Evidence is retained in
`evidence/password-policy-{focused,boundaries,regression-initial,tenant-check,typecheck,playwright}.txt`.
A fresh complete regression is required after the native-storage follow-up before final release
review. No security rule was relaxed to accommodate a fixture.

## Native vault and replay isolation — 2026-10-16

Final focused client/storage run: **8 files / 171 tests passed**. All **11 Playwright scenarios
passed** (35.9 seconds). TypeScript, changed JavaScript syntax, Android extraction-rule XML,
mobile web bundling and Capacitor Android plugin sync passed. The updated mobile dependency
audit reports zero advisory entries. Evidence is in `evidence/native-vault-*`.

The first full run passed **290 files / 2,918 tests** and found one upload-progress test failure:
an unconditional await delayed browser XHR initialization. The API now waits for the vault only
in native mode; the original upload assertion is retained and passes in the focused rerun.
That initial full log is retained, not described as a green run. A fresh complete regression
is required before final review. Java 21 is available; no Android SDK/build tools or physical
device are configured, so APK compilation, actual Keystore/extraction and backup/transfer
acceptance remain unverified. The bridge tests use a test OS provider; worker/queue tests run
the actual source with IndexedDB transactions.

## Consolidated authentication regression — 2026-10-16

A fresh complete run after the password policy, native upload-timing fix and bounded async
public-login work passed **293 files / 2,932 tests** (565.56 seconds), with no failed or skipped
tests. The exact final code also passed **11 Playwright scenarios** (37.3 seconds). This run
supersedes the initial password/native fixture/timing failures recorded above. Evidence:
`evidence/auth-hardening-full.txt` and `evidence/auth-hardening-playwright.txt`.

Async-login focused checks passed 6 files / 63 tests; final queue/race/temporary-expiry boundaries
passed 2 files / 13 tests. Typecheck and diff/syntax checks passed. Native asset/plugin sync and
mobile npm audit results remain as documented above; no live deployment, physical-device,
production-capacity or full-history credential-revocation claim follows from these local passes.
Tenant-wide administrative step-up and the remaining audit controls still need separate evidence.

## Tenant administrative verification — 2026-10-16

A fresh complete regression passed **295 files / 2,950 tests**, with no failures or skips
(539.75 seconds). All **12 Playwright scenarios passed** (40.5 seconds), including the actual
security dialog at 390×844, keyboard focus/Escape, cancellation without mutation, failed password
without recovery-code consumption, successful retry and one-use-code replay rejection. The dialog
axe scan included WCAG 2.2 AA tags; this does not establish all-screen accessibility.

The final focused account/role/security/integration/OAuth/client boundaries passed **3 files /
24 tests**. TypeScript, generated schema types, JavaScript syntax, diff checks and staged Gitleaks
passed. Native web bundling and Capacitor Android plugin sync passed; no APK build or real-device
Keystore/Windows Hello acceptance was performed. The only source cleanup after the full run began
was whitespace-only formatting of parameterized SQL, resolving a secret-scanner false positive
without an ignore rule; final focused checks and TypeScript cover that exact formatting.

Evidence: `evidence/tenant-step-up-{full,playwright,focused,baseline,typecheck,dbtypes,mobile-sync,secrets}.txt`.
The baseline account/MFA/recovery/role/session suite passed 6 files / 56 tests. OAuth tests use the
mock provider; they prove actor/session invalidation, disconnect/new-generation cancellation and
no credential save after authorization changes during exchange, not real Intuit operation or all
refresh/export concurrency. No new ZAP, live load or dependency scan was needed for this dependency-
unchanged increment; earlier findings remain open. The [runbook](../operations/tenant-step-up.md)
and [handoff](engineering-handoff.md) state protected scope and remaining engineering/owner work.
AUTHZ-15 remains open; passing application tests does not clear release/security gates.

## Accounting lifecycle follow-up — 18 October 2026

A clean final complete regression passed **296 files / 2,974 tests**,
with no failures or skips (509.60s), after the date-sensitive schedule fixture
correction. This supersedes the initial failure recorded below.

Focused accounting/idempotency/admin/snapshot regression passed **5 files / 66 tests** (23.91s).
All **12 final Playwright scenarios passed** (40.7s). TypeScript, generated DB types, diff checks
and staged Gitleaks passed. New lifecycle tests exercise delayed responses, company and tenant
scope, refresh admission/CAS, atomic connection rollback, durable write outcomes and export locks,
legacy quarantine, receipt recovery, malformed upstream data and the shared HTTP retry cache.
Provider responses are simulated; no actual Intuit account, hardware or live host was tested.

A first broad run was deliberately interrupted to address the HTTP-cache interaction and is not
a completed pass. The next complete run passed **295 files / 2,973 tests** but failed one test
in `mobile-schedule-change.test.ts` (519.20s). Its +14-day date fell on the default weekend rest
pattern. The fixture now explicitly publishes a working day and a separate rest day; it retains
the original approval/stale-approval assertions and adds rest-day rejection. Both isolated tests
passed (4.27s); no application scheduling/payroll rule was weakened. The initial full and isolated
failure logs are retained separately, not relabeled as passing evidence.

Evidence is `evidence/qbo-lifecycle-{full,initial-full,focused,playwright,typecheck,dbtypes,secrets}.txt`
and `evidence/qbo-schedule-{initial,fixed}.txt`. A new runtime npm audit still returns nonzero:
**0 Critical / 1 High / 3 Moderate**; see the dependency audit and raw dated JSON. No dependency
was changed, downgraded or suppressed. Staged scanning does not clear historical-secret findings.

The [lifecycle runbook](../operations/quickbooks-lifecycle.md) documents exact guarantees and the
remaining live-provider, legacy-adoption/repair, durable auto-push and operational acceptance work.
Whole-control statuses remain unchanged; this is a guarded accounting increment, not app-wide
production approval or provider-side exactly-once certification. No live deployment was performed.

## Durable automatic exports — 18 October 2026

The complete final regression passed **297 files / 2,987 tests**, with no failures or
skips (549.70s). Focused accounting/queue/admin checks passed **4 files / 56 tests**.
All **13 Playwright scenarios passed** (47.9s), including the actual export-status screen,
loading/error/refresh recovery, guarded safe resume, unknown-outcome retry refusal and axe checks.
The screen was visually inspected. A separate `node scripts/test-qbo-worker.mjs` smoke passed: the
actual disposable server consumed previously committed intent on startup using the test provider.

TypeScript, generated database types, JavaScript syntax, diff checks and staged Gitleaks passed.
Evidence is `evidence/qbo-jobs-{full,focused,types,dbtypes,playwright,secrets}.txt`,
`evidence/qbo-worker-startup.txt` and `evidence/qbo-export-status.png`. The added browser-fixture
positive-retry coverage was verified by its separate final Playwright run; runtime application
code remained frozen during the full Vitest run.

Transactional queue-failure injection proves the order does not commit without its intent.
A real edit during a delayed export leaves the later version queued. Tests retain persisted
backoff/limits, original-company binding, unknown-write blocks, offline-node exclusion, status
permissions, safe retry and sanitized-snapshot exclusion. No lease stealing, automatic unknown-
outcome recovery or live Intuit acceptance is claimed. Capacity/alerts, reconciliation/legacy
adoption tooling and other handbook controls remain open. No dependency was changed; existing
advisory/history gates are not cleared by application test passes. Nothing was deployed.

See [the automatic-export runbook](../operations/quickbooks-auto-exports.md). Whole-control
scorecard statuses remain unchanged; these are local engineering results, not release approval.

## Document conversion error boundary — 19 October 2026

The full regression completed: **297 files passed / 1 failed; 2,990 tests passed / 1 failed**
(522.55s). Its sole failure was an existing mobile recovery test accessing a description element
before rendering completed. The unchanged recovery subset passed on recheck (8 passed,
122 excluded); the test then replaced short rendering delays with existing bounded DOM waits.
The complete corrected mobile file passed **130 tests** (27.60s). This is full-run evidence plus
a verified targeted correction, not a second uninterrupted green full run. Runtime code was
frozen during the full run; only the mobile test waits were subsequently adjusted.

Focused conversion/studio checks passed **3 files / 33 tests**, including real malformed ZIP input,
injected dependency exceptions with synthetic sensitive paths, forged status/expose properties,
request-ID correlation and authored document-limit feedback. **13 Playwright scenarios passed**
(44.0s). Final TypeScript and diff checks passed. Staged Gitleaks passed with no findings; its redacted report is included.
No schema, dependencies, mobile assets or live services changed.

Evidence: `evidence/conversion-errors-{full,focused,playwright,mobile-recheck,mobile-fixed,types-final}.txt`,
`evidence/conversion-errors-verification.json` and `evidence/conversion-errors-scope.md`.
Research: [OWASP Error Handling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html),
accessed 19 October 2026. Generic client failures and correlated safe diagnostics are applied to
this converter boundary. API-06 remains FAIL; other raw exception paths require individual
classification and injection tests. Whole-control totals and release hold remain unchanged.

## Support and owner-details errors — 19 October 2026

Full regression completed: **297 files passed / 1 failed; 3,006 tests passed / 2 failed**
(551.15s). Both failures were existing mobile tests observing an incomplete screen after short
fixed rendering delays (production-manager early close and supervisor release request). Those
tests now wait for bounded expected screen/request states. The complete corrected mobile file
passed **130 tests** (27.74s). This is full-run evidence plus verified targeted corrections;
no second uninterrupted green full run is claimed. Runtime application code remained frozen
during the full run; the mobile test waits were changed after that file had run.

Focused support and owner analytics passed **2 files / 27 tests** (12.46s). Real SQLite trigger
failures cover six mutations: tenant/owner ticket creation, tenant/owner reply, owner status
update and owner details. They verify generic 500 responses, request correlation, unaffected
stored records and omission of a synthetic private marker from captured logs. Validation and
bad-ID checks retain useful 400 feedback; existing cross-tenant/private-note cases still pass.

**14 Playwright scenarios passed** (55.1s), including actual support form submission against a
real disposable SQLite failure: generic response, retained description, enabled retry, then a
successful corrected report. A separate focused browser run passed (6.4s). Final TypeScript
and diff checks passed. Staged Gitleaks passed with no findings; its redacted report is included.

Evidence: `evidence/support-errors-{full,focused,mobile,playwright,browser-focused,types,before}.txt`,
`evidence/support-errors-verification.json` and `evidence/support-errors-scope.md`. Baseline
fault probes intentionally failed against the old catch behavior; fixture corrections are
explained in the scope record. No production/customer data or live support messages were used.

Primary references: [OWASP Error Handling](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html)
and [MITRE CWE-209](https://cwe.mitre.org/data/definitions/209.html), accessed 19 October 2026.
The fix separates useful public validation from internal failures; it does not certify all
error paths or rich private diagnostics. API-06 remains FAIL, whole-control totals stay
36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A, and the release hold remains. No deployment occurred.

## Provisioning and atomic owner settings — 19 October 2026

The final uninterrupted full regression passed **299 files / 3,025 tests**, with zero failures
(533.42s). Runtime code and tests were frozen throughout that run. It includes the mobile wait
corrections delivered in earlier increments. No initial full-suite failure or targeted-only
correction is being substituted for this green final run.

Focused provisioning, console/import and billing-signup coverage passed **4 files / 53 tests**
(41.75s). Real SQLite faults cover create, settings update, subscription update and audit
failures in both settings flows. Tests prove generic correlated 500s without synthetic private
markers in captured logs, unchanged catalog/audit state after failures, whole-patch validation,
no catalog creation for invalid options, typed duplicate conflict/import feedback and normal
multi-field save/module dependencies. The initial focused run had six null/undefined assertion
errors in the new tests; these were corrected to the existing getTenant contract, not reported
as product defects. The raw initial report is retained.

All **15 Playwright scenarios passed** (44.9s), including the actual owner settings screen
against a disposable SQLite trigger: generic failure, retained edits, enabled save and successful
corrected save. Its separate focused run passed (7.1s). Final TypeScript and diff checks passed.
Staged Gitleaks passed with no findings; its redacted report is included. No live tenant, hosting,
dependency, schema or mobile runtime changes were made.

Evidence: `evidence/provision-errors-{full,focused,initial-focused,playwright,browser-focused,types}.txt`,
`evidence/provision-errors-verification.json` and `evidence/provision-errors-scope.md`.
Primary research: [SQLite savepoints](https://www.sqlite.org/lang_savepoint.html), accessed
19 October 2026, alongside the prior same-day OWASP error-handling and MITRE CWE-209 references.
The catalog transaction includes settings/audit writes; it does not cover workspace creation
or import across catalog, tenant DB and files. Compensating cleanup/restart recovery and other
API/diagnostic reviews remain. API-06 stays FAIL, whole-control totals are unchanged, and the
complete release remains on hold. Tests passing is not live deployment or release approval.

## Core provisioning failure recovery — 19 October 2026

The final uninterrupted full regression passed **300 files / 3,037 tests**, with no failures
(542.03s). Code and tests were frozen during that run. Earlier focused checks passed **5 files /
64 tests** (64.32s); after additional artifact-safety coverage, the recovery file passed all
**12 tests** (25.99s). The final full suite covers the final bigint file-identity refinement.

Two real child processes exit during catalog publication, one for creation and one for import.
On restart there is no tenant catalog row; an existing prepared database blocks a new attempt
and its bytes remain unchanged. Other cases cover existing-file preservation, rollback of
catalog/audit registration, cleanup and successful retry, owner credentials before publication,
failed initialization registry eviction, incompatible import/source preservation, replacement
file preservation, staging cleanup failure and dangling recovery-file symlinks.

The first Playwright run had **14 passed / 1 failed** (50.9s): the existing MFA-disable scenario
received public code-length validation feedback instead of disabling MFA. The unmodified full
browser suite rerun passed **15 scenarios** (44.4s). The cause was not reproduced or established;
no MFA product fix or deterministic reliability is claimed. Both text reports are retained.
Final TypeScript and diff checks passed. Staged Gitleaks passed with no findings; its redacted report is included.

Evidence: `evidence/provision-recovery-{full,focused,initial-focused,safety,crashes,initial-playwright,playwright,types}.txt`,
`evidence/provision-recovery-verification.json` and `evidence/provision-recovery-scope.md`.
See [the recovery runbook](../operations/provisioning-recovery.md). Research used Node's official
filesystem flags and SQLite savepoint documentation (accessed 19 October 2026).

This implements core prepare-before-publish and caught-failure cleanup. Real process exits do
not prove power-loss/fsync, Windows or shared-volume behavior. Interrupted files stay blocked
for reviewed quarantine; no automatic adoption or deletion is implemented. Later route setup,
invoicing/notifications and imported schema/credential acceptance need broader reconciliation
and review. Whole-control totals and release hold remain unchanged. No live deployment,
customer workspace mutation, dependency or schema change occurred.

## Atomic local signup/console setup — 19 October 2026

Final uninterrupted regression passed **301 files / 3,046 tests**, with zero failures (556.19s).
Runtime code and tests were frozen throughout. Existing focused billing/signup/console/inquiry/
core-recovery coverage passed **5 files / 70 tests** (66.41s). The new fault/process file passed
**9 tests** (15.75s). It covers real SQLite faults in payment lock, subscription, owner contact,
invoice insert/audit, final publication audit, console inquiry rollback and standalone invoice
audit rollback/retry. Failures leave no catalog/setup/audit rows, remove only the prepared owned
DB and send no owner alert; successful same-slug retry has one first invoice.

A real child process exits after subscription, payment lock, owner contact and first-invoice
setup but before publication commits. Its restarted catalog has no tenant, invoice, contact
or provisioning log. Its unregistered prepared DB remains for reviewed recovery. This proves
the tested process-exit boundary, not power-loss/fsync or multi-host deployment behavior.

All **16 Playwright scenarios passed** (47.3s). The new website scenario forces an invoice
failure, preserves signup fields, retries the same company, follows the successful redirect,
and verifies payment lock plus exactly one invoice through tenant login/billing. TypeScript
and diff checks passed. Staged Gitleaks passed with no findings; its redacted report is included.

Initial new unit fixtures imported a mocked module before environment setup and got 404s;
the fixture ordering was corrected. The first browser draft read response JSON after the app
navigated, causing a protocol failure after a successful 201; it now verifies persisted billing
state after navigation. Those are test-fixture/synchronization errors, not claimed product
fixes. Initial text reports remain in evidence. No trace secrets/customer data are included.

Evidence: `evidence/catalog-setup-{full,focused,initial-failures,failures,initial-browser,playwright,types}.txt`,
`evidence/catalog-setup-verification.json` and `evidence/catalog-setup-scope.md`.
Documentation: [audit index](README.md), [onboarding runbook](../operations/workspace-onboarding.md),
updated core recovery runbook, module catalog/pipelines, handoff and standards research.
SQLite transaction/savepoint primary references were reviewed 19 October 2026.

Covered local setup is now part of catalog publication. External notification remains best
effort after commit; durable response receipts, concurrent/generated-slug duplicate submission
handling and reliable outbox delivery remain engineering work. Pricing/calendar/commercial
policy, imported-state review and external release gates are not certified by these checks.
Whole-control statuses remain unchanged and the complete release stays on hold. No schema,
dependency, live customer workspace or hosting change was made. Nothing was deployed.


## Durable creation receipts — 19 October 2026

Base cd34ba18f0aeae792f92fe60349c8271e17f5ea0. High scoped lost-acknowledgement/duplicate-workspace
gap addressed for keyed public signup and authenticated console create. Completed responses
commit with local setup; same scoped key/details replay the original 201. Strong salted request
binding includes the password without persisting the request or a cheap password verifier.
Authentication/fresh proof runs before console replay. Expiry clears payload/verifier and retains
a tombstone that prevents reapplication. Whole-control statuses and release hold are unchanged.

| Check | Completed result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | 302 files / 3062 tests passed, 573.24s |
| Initial receipt + existing atomic-setup focused run | 2 files / 23 tests passed, 37.62s |
| Receipt process-focused run before final fresh-proof case | 1 file / 15 tests passed, 29.60s; final full run includes all 16 receipt cases |
| `npm run test:e2e` | 18 passed, 57.9s; includes real committed responses discarded for both forms |
| `npm run typecheck` | Passed |
| `npm run db:types` | Passed; no generated tenant-type change |
| Actual `server.ts` startup smoke | HTTP health passed; expired receipt payload/verifier pruned and tombstone preserved |
| Gitleaks | Source tree and staged increment clean; commit hook scans staged changes again |
| Whitespace/diff check | Passed |

Receipt cases cover changed pricing/catalog reopen, original invoice replay, no second alert,
changed password/details, route/operator isolation, auth/fresh-proof enforcement, invalid keys,
legacy clients, real SQLite receipt/publication faults, expiry, purged tenants, ordered stale
competing candidates and an independent reader. A child exits after commit; a second process
replays the durable response. The competing-candidate test is not simultaneous multi-host load.
Browser tests retry the same preserved form/key after an actual committed response is lost and
verify one workspace/invoice. No real emails, customers or provider calls were used.

Initial corrections: typecheck found the helper's void annotation incompatible with the trusted
publication callback's undefined contract; the annotation was corrected. The first schema-type
generator was denied tsx IPC by the filesystem-only sandbox; the authorized local rerun passed.
Initial outputs are retained. No product production outage or live migration failure is inferred.

Evidence: `evidence/creation-receipts-*`, including scope and verification JSON, full/focused/
Playwright outputs, initial/final type/generator outputs, startup and secret scans. Runtime
code/tests were frozen before the full regression run; later edits were documentation/evidence.
The complete browser run preceded the full suite. Documentation covers module catalog/pipelines,
API/recovery contract, governance/draft privacy, handoff, scorecard metadata and primary research.

Remaining: notification outbox/worker, signup admission, broader API/import retry coverage and
new/no-key reconciliation. A reload/new modal loses the in-memory key; old/no-key clients retain
legacy behavior. Logical pruning is not forensic or backup erasure. No distributed exactly-once,
real Windows/Android/Intuit/hosting/capacity acceptance, advisory refresh, complete-control PASS,
CI-green or deployment claim is made.


## Signup owner-alert durability — 19 October 2026

Base fde2dd3d69c4fad2c894f86a1eae68219df419bd. High scoped lost-alert gap addressed for signup:
enabled alert intent now commits with workspace/local setup/invoice/creation receipt/core audit.
A bounded cloud worker claims before sending and records guarded acceptance/log together. Brevo
429 alone retries automatically, with persisted backoff/Retry-After and five total attempts.
Uncertain/partial/interrupted sends require review; changed configuration cancels old unsent data.

The shared platform adapter now requires SMTP TLS, bounds send duration, refuses Brevo redirects
and stores authored failure codes. The console test-mail async database/log rejection is caught
and forwarded to the correlated generic error boundary. Console APIs use no-store even on auth
denial. A redacted recent signup-status panel refreshes without a blind resend action. These
changes do not extend transactional durability to inquiry/payment/recovery/tenant-mail paths.

| Check | Completed result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | 303 files / 3094 tests passed, 590.48s |
| Corrected intermediate focused run | 4 files / 59 passed, 56.59s |
| Final focused outbox + platform mail | 2 files / 39 passed, 17.15s; includes 32 new outbox cases |
| First complete Playwright run | 19 passed, 53.8s |
| Final `npm run test:e2e` | 19 passed, 52.8s |
| `npm run typecheck` | Passed |
| `npm run db:types` | Passed; no generated tenant-type diff |
| Actual server startup smoke | Committed synthetic signup alert accepted once; stale claim unknown without resend |
| Gitleaks staged increment | Clean; final commit hook reruns scan |
| Diff/whitespace | Passed |

Focused cases cover catalog reopen, one local claim, disabled/configuration/credential/workspace
changes, retry budget/delay, provider status/exception redaction, SMTP partial acceptance and
absolute deadline, including real stalled TCP teardown, retention and authenticated/redacted/no-store status. SQLite faults verify
enqueue rollback plus post-provider acknowledgement/log failure. Three real process exits occur
before claim commit, after claim and after simulated provider acceptance. Restart processes safe
pending work once, while durable interrupted claims become unknown without sending again. The
local concurrency case is not simultaneous multi-process/host load or a hosting certification.

Chromium reads a synthetic unknown event from the real status API, preserves it on refresh 500,
recovers refresh and performs no send/resend. The actual startup script is retained in evidence;
run from repository root with work/ present and dependencies installed. It uses a private temp
catalog, local HTTP health and NODE_ENV=test transport; no real email/provider/customer secrets.

Initial focused run: two failures/56 passes from repeated process-fixture mkdir paths (EEXIST),
corrected to separate directories. That is a test-fixture correction, not a product failure.
Two preliminary full runs were deliberately interrupted (exit 130): first to include the console
error/cache fixes; second after installed Nodemailer source showed that transport.close alone
does not abort active I/O. The adapter now owns/destroys its socket, verified against a real
stalled local SMTP connection. Both partial outputs remain and are not completed passes. An
intermediate typecheck rejected unsupported address-object handling against the installed
string-list result type; it was removed and the initial compiler output retained. Final runtime/
tests were frozen before the fresh full run; only documentation/evidence followed.
The final full/browser results describe the corrected code; no interrupted run is reported green.

See owner-outbox-* scope/verification/logs/browser metadata/startup script and
operations/owner-alert-outbox.md. Documentation includes exact disabled-alert, mailbox generation,
retention, backup reconciliation, API/status and failure/incident rules, plus catalog/pipelines,
governance/draft privacy, release checklist, research, handoff and scorecard metadata.

Remaining: inquiry/payment transactional intent, provider reconciliation/reviewed resend, queue
backlog monitoring/external alerts, capacity, approved retention and live Brevo/SMTP/restore/
hosting/Windows acceptance. Payload pruning is logical, not backup/WAL forensic erasure. Minimal
event metadata remains pending governance approval. No new dependency/advisory snapshot, tenant
schema version, full notification durability, exactly-once/inbox delivery, CI-green, hosted-rollout
verification or complete-control PASS is claimed. Whole-control totals and release hold remain.


## Inquiry/payment alerts and consistent mail credentials — 19 October 2026

Base 2c868a5f9c335725ca481e2cedde1b3394d7dc6d. High scoped lost-alert gap addressed for
updated public inquiry and tenant payment-report routes. Enabled event intent commits with its
source; payment proof/2307 bytes, payment row, reporting audit, derived invoice and prepared
response share one catalog savepoint. UUID names and lazy private proof caches avoid pre-commit
orphan files and same-millisecond collisions. A separate business queue protects against old
signup-only workers; current worker checks sources and retains conservative unknown handling.

A second high scoped credential-pairing gap was found: independent settings/secret reads could
mix generations. One SQLite SELECT now captures settings/secret/key reference; writes commit
settings/key/secret together and console changes additionally include audit/response preparation.
A second database connection changes generation during capture; SMTP retains the consistent old
host/user/password. Secret-write and console-audit faults restore the whole prior configuration.

| Check | Completed result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | 305 files / 3119 tests passed, 598.73s |
| Final focused Vitest | 6 files / 91 cases passed, 42.32s; includes 22 new business and 3 configuration cases |
| First corrected Playwright | 20 passed, 55.5s |
| Final `npm run test:e2e` | 20 passed, 54.7s |
| `npm run typecheck` | Passed |
| `npm run db:types` | Passed; generated tenant types unchanged |
| Actual server startup/timer | All three synthetic categories accepted once; stale claims unknown without resend; proof BLOB retained |
| Gitleaks staged increment | Clean; final commit hook scans again |
| Diff/whitespace | Passed |

Focused tests use real isolated SQLite/HTTP faults across inquiry intent and payment blob/row/
audit/invoice/intent boundaries, invalid second attachment, auth/tenant isolation, disabled and
reviewed/missing source behavior, legacy-worker isolation and uncertain acknowledgement. Four
real child exits occur before/after inquiry/payment commit: restart rolls back pre-commit data,
or retains one source/intent for synthetic acceptance. This is local process-exit evidence,
not power-loss, simultaneous multi-host, filesystem or financial-policy certification.

Chromium exercises a real inquiry enqueue fault, retains draft, accepts corrected retry and
checks one source/intent plus redacted console status. Initial focused run had 17 passing and
one failure from a nonexistent-company fixture, corrected to a real other tenant. Initial
browser run had 19 passing and one ambiguous Email locator failure, corrected to textbox role.
Those fixture failures are retained as text/browser JSON; failed traces/screenshots were
subsequently overwritten. An intermediate compiler error in result-row projection inference
was corrected with an explicit row type; initial compiler text was overwritten, not retained.
No partial run is counted as a final pass. Final runtime/tests were frozen before the full run.

Raw or whitespace-normalized output, browser metadata, startup script, scoped findings and
verification JSON are business-alerts-* under evidence/. Run startup script from repo root with
work/ and dependencies installed. Synthetic credentials/data and test transport only; no real
email/provider/bank/customer/deployment action. No dependency/advisory snapshot or tenant schema
version change. Research and upgrade/rollback/restore/data rules are in standards-research.md,
operations/business-alerts.md and the updated API/onboarding/release/governance/draft privacy docs.

Remaining: HTTP retry receipts (distinct POSTs still create distinct sources), legacy/duplicate/
provider reconciliation and reviewed resend, queue escalation, upload-content and broader
financial lifecycle acceptance, approved retention and real provider/hosting/restore/device/
capacity gates. Email payload expiry does not delete financial proofs. Old workers ignore the
new table; older request servers keep immediate behavior until upgraded. No exactly-once inbox,
CI-green, hosted rollout, production-ready or complete-control PASS claim. Whole-control totals
remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release hold unchanged.


## Payment-report retry receipts — 19 October 2026

Base e254ae4e7d8e9bdb25f68444d53dcc794f882ce0. High scoped duplicate-report gap addressed:
updated keyed tenant payment reports replay the original 201 after response loss instead of
creating another payment/proof/audit/alert. Normalized invoice/financial fields and attachment
MIME/bytes bind tenant/actor/key. Slow salted verifier and successful response commit with the
source catalog savepoint; failure or competing receipt insertion rolls source writes back.

Testing exposed generic idempotency intercepting multipart requests before parsing and route
users.manage checks. This POST now bypasses it; current auth/permission/online gates precede
new receipt lookup. Known old generic keys conflict for reconciliation. Other generic middleware
routes are unchanged. Desktop freezes exact FormData/key after uncertain results, permits a new
corrected attempt after explicit 400 and GETs current Billing after acknowledgement.

| Check | Completed result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | 306 files / 3148 tests passed, 627.70s |
| Final focused Vitest | 5 files / 90 passed, 46.99s; 27 new receipt cases and 2 new frontend cases |
| Final `npm run test:e2e` | 21 passed, 58.9s |
| `npm run typecheck` | Passed |
| `npm run db:types` | Passed; generated tenant types unchanged |
| Actual server startup | Expired receipt payload/verifier cleared; tombstone/proof retained; synthetic alert safety unchanged |
| Gitleaks staged increment | Clean; final commit hook scans again |
| Diff/whitespace | Passed |

Focused cases cover replay/catalog reopen, normalized/mismatched financial fields and invoice,
proof/MIME/2307, current authentication/role downgrade, actor/tenant separation, malformed keys,
no-key compatibility, old-cache quarantine, validation correction, receipt-write rollback,
stale competing candidate, reviewed/source ownership and expiry. Two actual child exits verify
pre-commit source/receipt rollback or committed persistence. Browser drops a real committed 201,
retries the same request and verifies one report plus current Billing state. Startup script uses
a private catalog and test transport; no real provider/bank/customer email/deployment action.

Initial four-file run: 59 passed/13 failed. Ten exposed the middleware interception conflict
(eight changed-input cases plus expiry/source reassignment); three were fixture errors (NOT NULL
override cleanup and two missing child bootstrap passwords). Intermediate five-file run: 84
passed/two fixture failures: fixed admin permissions ignore overrides by design, so the test now
downgrades the role; restart removes its deliberately persistent fault trigger before retry.
Initial browser run: 20 passed/one failure after successful lost-response UI replay, because the
final APIRequestContext GET omitted tenant scope. X-Tenant is now explicit. Initial raw text/JSON
remain; browser traces/screenshots were overwritten. A separate deliberately failing case confirmed alternate-case/trailing-slash URLs
could still reach generic caching. The exemption now matches Express case-insensitive routing.
One preliminary full run was deliberately interrupted with exit 130 to include that fix; its
partial output is retained and is not a completed pass. First corrected focused/browser results
(89 tests / 21 browser checks) preceded the alias fix; final focused/browser/full results include it.
A staged scan flagged ordinary runbook wording as a generic-api-key false positive; no
credential was present. Prose was reworded without scanner suppression and the redacted initial
finding retained. No failed or interrupted run is counted as a final pass. Runtime/tests were frozen before the full run; documentation/evidence followed.

See payment-receipts-* scope/verification/logs/browser metadata/startup script and
operations/payment-report-retries.md. Primary research: Stripe application idempotency and
SQLite savepoints reviewed today, with own-contract differences and local evidence limits in
standards-research.md. Data governance/draft privacy, release/restore/rollback, API contract,
module catalog/pipelines, readiness, handoff and scorecard metadata were updated.

Remaining: no-key/new-form/different-actor/legacy duplicates, inquiry/other API receipts, broader
financial lifecycle and reconciliation, reviewed resend/backlog escalation, upload-content and
real provider/hosting/restore/Windows/capacity acceptance, approved retention. Same bank reference
is not globally unique; replay returns original snapshot and GET returns current review state.
Receipt expiry logically removes payload but keeps minimal tombstone; financial proof retention
is separate. Older writers need stopped/reconciled reporting or compatible versions. No new
dependency/advisory snapshot/tenant schema bump, exactly-once remote outcome, CI-green, hosted
rollout, production-ready or complete-control PASS claim. Complete-control totals remain
36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release hold stays.


## Public inquiry retry receipts and bounded verifier work — 19 October 2026

Base a2a92cc6e49aab8752a923449aaf1a1c5b302d21. Medium scoped duplicate-inquiry/alert gap
addressed for updated keyed website submissions. The form retains one UUID-v4 key across edits/
errors; matching committed details replay only 201 {ok:true}. Changed details conflict, while
failed pre-commit work can be corrected with that same key. Source, eligible alert and receipt
share one catalog savepoint; competing/receipt/alert failure rolls local source writes back.
No raw contact/message/key or private response is added to receipt storage.

Review added bounded asynchronous native verifier work through the existing shared login budget,
avoiding a new public synchronous hashing path. One active/eight waiting jobs and ten-second wait
return safe 503/Retry-After on saturation. Live source/verifier/expiry are rechecked after await.
The existing production five/hour per-IP limiter counts replays. Other synchronous signup and
authenticated helpers are unchanged; distributed abuse/shared capacity acceptance remains open.

| Check | Completed result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | 307 files / 3176 tests passed, 645.45s |
| First focused | 4 files / 53 passed, 32.70s |
| Intermediate focused after async admission | 6 files / 67 passed, 45.39s |
| Final focused | 6 files / 70 passed, 44.28s; 27 new inquiry cases plus 1 shared helper case |
| First Playwright | 22 passed, 64.49819s |
| Final `npm run test:e2e` | 24 passed, 63.991s |
| `npm run typecheck` | Passed after fixture SQL parameter typing correction |
| `npm run db:types` | Passed; generated tenant types unchanged |
| Actual server startup/timer | Expired inquiry verifier cleared; marker/source retained; synthetic alert/financial proof safety preserved |
| Gitleaks staged increment | Clean; final commit hook scans again |
| Diff/whitespace | Passed |

Focused coverage includes normalization/seven changed fields, host/schema/honeypot gates,
malformed keys, no-key/new-key behavior, URL aliases, receipt/alert faults, stale and actual
concurrent HTTP candidates, expiry/source deletion and validation correction. Two child exits
verify pre-commit rollback or committed source/receipt persistence. Saturated shared work returns
503 without source; source/expiry change during queued verification rejects stale replay. Real
native crypto yields to the event loop. A dedicated NODE_ENV=production case gets five matching
201s then 429 with one source; no worker/provider I/O runs in that test.

Chromium loses a real committed response, edits the same request/gets 409, restores original
message/replays and verifies one source/alert through restricted owner APIs. Another case refuses
null JSON/HTML fallback successes, retains draft/key and confirms only a real acknowledgement.
Existing browser source-enqueue fault still accepts corrected retry. All completed focused/browser runs
passed; no failed run is silently green. An intermediate typecheck rejected possibly-undefined
SQLite result fields in fixtures; explicit String/Number SQL parameters corrected them. Initial
compiler output is retained. Final runtime/tests were frozen before the final completed full regression; only
documentation/evidence followed. One preliminary full run was deliberately interrupted with exit 130 to include the missing
client deadline. The form now uses a 20-second AbortController timer for fetch/body reading,
clears it on completion and preserves key/draft for uncertain retry. A targeted browser case
commits on the real server, withholds response, advances the controlled clock and replays. That
targeted case passed (6.7s). Earlier 22-/23-case browser outputs and the 70-case pre-deadline
focused output are retained separately. The 23-case browser JSON was overwritten by the targeted
timer run; final browser metadata is retained. The partial full output is not a completed pass.
Browser suspension can delay timers; no network/hosting latency SLA or server rollback on abort
is claimed. The final complete regression includes the deadline correction.

See inquiry-receipts-* scope/verification/raw or whitespace-normalized output/browser metadata/
startup script. Run startup script from repository root with work/ and dependencies available;
private synthetic catalogs and test transport only. No real inquiry/provider/customer email/bank/
deployment action. Research reviewed today: Stripe idempotency, SQLite savepoints and OWASP DoS
Cheat Sheet; own-contract and local-evidence limits are in standards-research.md and
operations/inquiry-retries.md. API/queue-work/onboarding/release/governance/draft privacy,
module catalog/pipelines, readiness, handoff and scorecard metadata were updated.

Remaining: no-key/new-page/legacy duplicates, other API/import receipts, public signup admission,
shared login/inquiry capacity, provider/financial reconciliation/reviewed resend/queue escalation,
upload and wider financial/security/device/hosting/restore/governance gates. Logical verifier
expiry retains marker; backups/WAL/source/provider copies have separate policies. Old writers
or restored catalogs need reconciliation. No new dependency/advisory snapshot/tenant schema
bump, exactly-once inbox/provider outcome, CI-green, hosted rollout, production-ready or complete
control PASS claim. Totals 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A and release hold unchanged.


## Owner-alert monitoring and history — 19 October 2026

Base 488d413d780b4b6d754fb9998b784d4d9c47787c. Medium scoped visibility gap addressed:
queue-wide counts and filtered history find old failures outside recent thirty; durable guarded
worker observations distinguish idle/running/stale/failure/unobserved. Existing outbox policy
still forbids blind resend. Health/history are read-only, redacted and authenticated/no-store.

| Check | Completed result |
|---|---|
| Full regression | 308 files / 3212 tests passed, 647.88s |
| Initial focused | 4 files / 77 tests passed, 22.05s |
| Final focused | 4 files / 78 tests passed, 24.08s; 36 new monitor cases |
| Initial browser | 25 passed / 1 failed (new assertion label mismatch) |
| Final Playwright | 26 passed, 70.221s |
| TypeScript / db:types | Passed; no generated tenant-type diff |
| Actual server startup/timer | Passed; completed heartbeat and synthetic delivery/receipt safety |
| Staged secret scan | Clean; final commit hook scans again |

Browser coverage includes old-history traversal, failed filter/refresh retaining evidence and
selection, held-read twenty-second AbortController deadline and retry. Worker tests cover
cross-queue equal IDs/timestamps, bounded malformed cursors/queries, auth/redaction, SQLite
start/finish faults, overlap, reopen and actual synthetic acceptance before failed heartbeat
finish with no second send. Exact scope and logs are in alert-monitor-* evidence. The initial
browser test expected raw 'Unobserved', but the screen authored 'Not yet observed'; only the
assertion changed, and initial output/JSON remain. Transient trace/screenshots named in raw
logs were not archived. Runtime/tests were frozen before the completed full regression.

No real provider, customer message, bank, deployment or hosted configuration was changed.
Research: Google SRE monitoring and SQLite scrolling-window queries (primary sources retrieved
19 October). Updated operations/API/release/privacy documentation, catalog/pipelines, readiness,
handoff and scorecard metadata retain the distinction between observation and remote delivery.
External watchdog/escalation, provider reconciliation/reviewed resend, capacity/retention,
Windows/native/hosting/restore acceptance and the wider scorecard remain open. Totals unchanged:
36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release hold remains.

The first final commit scan flagged two SHA-256 file checksums stored under artifact names
containing “secrets”. Separating names/digests in the manifest removed the false positives;
no credential or scan allowlist changed. Evidence trailing blank lines were normalized.


## Public signup work admission and async credentials — 19 October 2026

Base e28a9217082dcc44d96121011262511e3475bd0f. High scoped main-thread hashing gap addressed:
public receipt/owner hashing uses bounded shared native crypto, with one-active/no-backlog
signup admission. Trusted fresh initialization reuses the prepared owner hash instead of a
second global bootstrap hash. Default bootstrap policy, current stored formats and existing
synchronous CLI/console compatibility remain. Post-await replay/current-catalog checks prevent
stale acknowledgement/publication. Browser timeout/invalid responses retain fields and key.

| Check | Completed result |
|---|---|
| Full regression | 309 files / 3227 tests passed, 638.74s |
| Initial focused | 5 files / 53 passed, 71.35s |
| Intermediate focused | 5 files / 55 passed, 79.06s |
| Final focused | 8 files / 75 passed, 97.85s; 15 new signup cases |
| Initial Playwright | 29 passed, 74.402s |
| Final Playwright | 29 passed, 72.992s; 3 new signup cases |
| TypeScript | Passed |
| Actual server startup/timer | Signup/replay/owner login; one workspace/receipt/invoice/alert and synthetic acceptance |
| Schema / db:types | No schema or stored-format change; regeneration not required/run |
| Secret/diff checks | Staged scan clean; final commit hook scans again; whitespace check passed |

Focused cases exercise real async KDF yielding, correct keyed/no-key owner credentials without
synchronous hashing, competing/saturated work while health responds, publication/native faults
and admission release, live replay expiry/verifier/response/source invalidation, catalog races,
input snapshots, fresh DB guards, production ten/hour replay counting and real process exit/
old synchronous receipt compatibility. Existing provisioning/receipts/billing/hash/policy/login
races supplement the new coverage. Initial/intermediate runs passed; central hash-format
validation was then reused from password-hash rather than duplicated in db.ts. Final checks
include that runtime. No failed/partial run is counted as a completed pass.

Chromium holds an actual committed HTTP response, advances the twenty-second browser clock,
retries the same key and verifies one invoice. Busy and null/HTML/wrong-status responses retain
form identity. Existing passkey/MFA/recovery/mail/payment/accounting/signup journeys also pass.
All fixture requests use disposable data; actual mail transport remains NODE_ENV=test and sends
no real email. Native process fixtures use production mode only with private synthetic files.
No deployment command, hosted mutation, customer/bank/provider action or new dependency.

Exact evidence: signup-budget-* scope/verification/raw or whitespace-normalized logs/browser
metadata/startup script. Runtime/tests frozen before full regression; subsequent changes are
documentation/evidence only. Updated operations/API/password-work/onboarding/release/privacy,
catalog/pipelines, readiness, handoff and scorecard evidence. Primary sources retrieved today:
Node 24 scrypt, Node event-loop/worker-pool guidance and OWASP DoS guidance; own-contract limits
are documented in standards-research.md and operations/public-signup-budget.md.

Remaining: synchronous tenant setup, hosted mixed workload/memory/disk acceptance, distributed
abuse/edge/storage controls, other synchronous writers/retry receipts, provider reconciliation/
external escalation and wider financial/authz/privacy/AI/native/dependency/hosting/governance
controls. Whole-control totals remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release held.


## Manual accounting export verification — 20 October 2026

Base affa182adba8ea3b66cd63b484fca7d21a68ae2a. High scoped product gaps reproduced before
fixes: stale-session export returned success, and a CKD component added a second priced line.
The final manual contract requires order-type authority, recent identity proof and the current
preview's destination generation/source hash. Client confirmation binds original actor/server/
view; provider requests recheck live actor/order state after waits. Known acceptance is kept;
shared adapter excludes component pricing. Export users gain target metadata without settings
administration. Scope/action inventory and recovery/rollout limits are documented separately.

| Check | Completed result |
|---|---|
| Final full regression | 310 files / 3255 passed, 612.71s |
| Final focused | 7 files / 93 passed, 37.59s; 28 new manual cases |
| Final Playwright | 34 passed, 82.781s; 5 manual review/context cases |
| TypeScript | Passed after malformed-body fixture typing correction |
| Actual server.ts | Proof/scope refusal, current preview, accepted export/replay and commercial-only payload hash |
| Schema | No migration/storage-format change; db:types not required/run |
| Staged secret / whitespace checks | Clean; final commit hook scans again |

Focused coverage uses actual HTTP/SQLite and held synthetic provider responses for session,
freshness, account/role/password, source/line, refresh/401, tenant and destination races. Valid
party/invoice acknowledgements after revocation retain minimal receipts and stop subsequent
calls. Reviewed source/line changes fail before send; a status-read interleaving keeps displayed
company and generation together. Existing automatic export/cache/MFA/client/offline-accounting
regressions pass. The action inventory explicitly retains offline local-authority design work.

Evidence distinguishes genuine reproduction failures (2), later changed-contract fixture
failures (2) and successful stages. The initial compiler rejected a null supertest argument;
explicit malformed JSON corrected the fixture. Initial complete browser stages passed 30,
30 and 31 cases. A later run had 33 passed/1 failed: navigation had already cancelled its modal,
but the test tried to click the removed button. That assertion was corrected. One overlapping
rerun failed to start because the preceding browser server was still running; it is not a test
pass. Its shared output was combined with the earlier finishing process and had NUL padding;
the archived combined text is marked non-standalone. The first failed browser JSON, partial
original text and overlap output are retained. Transient failure traces/screenshots named in
raw logs are not archived; a successful synthetic screenshot is retained.

One preliminary full run was deliberately interrupted with exit 130 to add original UI-context
and current-preview/source guards. A browser startup was also interrupted with exit 130 while
adding those guards; it has no completed-case claim. The final complete run above is the sole
final regression result; runtime/tests stayed frozen before it. Only docs/evidence followed.

Actual server smoke uses private catalogs and NODE_ENV=test Intuit transport, and compares the
stored financial payload hash to one commercial parent without its priced fulfillment component.
No real provider financial/customer/bank action, deployment or hosted setting changed. Browser
checks exercise cancellation, reauthentication, stale destination and account/company/view change.
No native/Windows device or one-use transaction-signing certification is inferred.

Research retrieved OWASP Authentication/Transaction Authorization and HTTP RFC 9110. Intuit
search/direct pages were unavailable, so provider deduplication promises were not broadened.
Updated API/step-up/accounting/release/privacy runbooks, action inventory, module catalog/
pipelines, readiness, handoff and AUTHZ-15 evidence. Whole-control statuses remain unchanged:
36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A, release held. Remaining work includes offline
approval design, controlled reconciliation, field minimization, real provider/currency/tax/
accountant acceptance, native/hosting/restore/capacity/alerts and the wider security/privacy/AI
and dependency/governance gates. Owner participation remains last.


## BIR 2316 employee privacy — 20 October 2026

Base 7250cbb07092d5594b680b11f3835e3e61952fb5. Reproduced excessive employee
fields with an accounting-only user, including automatic disclosure of a new
unrelated column. Explicit SQL projection preserves the template's identity fields
and tax figures, while excluding the unrelated HR/pay record.

| Check | Completed result |
|---|---|
| Full regression | 311 files / 3260 tests passed, 635.33s |
| Focused | 4 files / 184 tests passed, 24.97s; 5 new API cases |
| Playwright | 35 passed, 88.338s; 1 new accounting-only response/template case |
| TypeScript | Passed |
| Actual server.ts | Bounded tax response, no-store, formatted DOB, HR/anonymous denial |
| Schema/dependencies | Unchanged; db:types not required/run |
| Staged secrets and whitespace | Clean; commit hook rechecks final staged files |

The initial sandbox test could not bind an HTTP server (EPERM) and executed no
cases. With local-server permission, the pre-fix product reproduction completed
with 2 failing/3 passing cases; all focused cases passed after the fix. The browser
focused case and complete browser run both completed successfully.

[Verification manifest](evidence/tax-privacy-verification.json),
[full log](evidence/tax-privacy-full.txt),
[focused log](evidence/tax-privacy-focused.txt),
[reproduction](evidence/tax-privacy-repro.txt),
[browser JSON](evidence/tax-privacy-browser.json),
[startup](evidence/tax-privacy-startup.txt), and
[contract/limits](../operations/accounting-tax-privacy.md).
Broader privacy/export/retention work remains; scorecard statuses and release hold
are unchanged. No deployment/provider/customer data changes were made.


## Payroll disclosure ownership — 20 October 2026

Base 6097973776c521c20d4cbc9d69985481e3b6c85b. Reproduced self-service
legacy-name reuse disclosure, incorrect email recipient selection, invalid stamped
identity fallback and ambiguous-name/coercion cases (6 failed / 3 passed). The
resolver and self-service now fail closed for known ambiguity/invalid references,
while preserving stamped ownership and unique former names.

| Check | Completed final result |
|---|---|
| Full regression | 312 files / 3272 tests passed, 643.71s |
| Focused | 6 files / 154 tests passed, 39.54s; 12 new API/resolver/generation cases |
| Playwright | 37 passed, 101.456s; 2 new separate employee browser sessions |
| Mobile regression after fixture correction | 130 tests passed; state-based readiness and rejected-save completion |
| TypeScript | Passed |
| Actual server.ts | Numeric/text identity, ambiguity/dangling denial, unresolved email without mail-log effects and generation refusal before writes |
| Schema/dependencies | Unchanged; db:types not required/run |
| Staged secret/whitespace checks | Clean; final commit hook scans again |

A later test reproduced a compatibility gap: a valid decimal-string employee ID
returned 404 in self-service (1 failed / 9 passed). The preliminary full run was
interrupted with exit 130 to correct SQL candidate matching, then final focused,
browser and full runs completed on the corrected implementation. The earlier
37-case browser run passed but did not yet cover text IDs; final browser fixtures
cover both ID representations. No interrupted run is counted as a full pass.

The first completed full run had 3,269 passes and one failure in the existing
mobile storage-failure test: its fixed 40 ms navigation delay clicked a null
Continue button. The same test passed in isolation. The fixture now waits for
control readiness, observes the rejected save and waits for the control to be
re-enabled while retaining the zero-upload assertion. The entire 130-case mobile
file and the final full run passed after correction. No mobile product code or
UI design changed; the failed full log and isolated diagnostic are retained.

A further caller review reproduced two duplicate-generation risks: existing
ambiguous or dangling cutoff slips did not prevent creation of new records. A
further preliminary full run was stopped (exit 130), both cases reproduced, and
generation now returns 409 before opening its write transaction. Final focused
cases prove no new records and no change to the existing paid slip on refusal.
The final full run is on this guarded implementation. The first expanded startup
request omitted the required payroll-period label; a later fixture assertion also assumed a fixed record count despite seeded data.
Corrected input and a before/after record-count comparison passed.

A further full attempt reported one existing mobile location-capacity case
failing under concurrent browser/full-suite load and was interrupted (exit 130).
The isolated case passed. Its fixed 80 ms navigation delay now waits for the
actual full-location label, retaining all capacity and selectable/full-location
assertions. The final mobile file passed, and the final full run started after
all browser checks finished. The interrupted attempt is not a completed pass.

The first startup fixture failed because its separate Python SQLite connection
lacked `form_history_enabled`; the corrected connection enables existing revision
triggers and the actual-server smoke passed, then passed again with text-ID cases.
The prior rename test's current-name-holder precedence was intentionally replaced
with ambiguity refusal. This is a security contract correction, not removal of the
negative scenario. Mocked email and disposable catalogs only; no real sends.

[Manifest](evidence/payslip-identity-verification.json),
[full regression](evidence/payslip-identity-full.txt),
[focused](evidence/payslip-identity-focused.txt),
[reproduction](evidence/payslip-identity-repro.txt),
[text-ID reproduction](evidence/payslip-identity-text-id-repro.txt),
[browser JSON](evidence/payslip-identity-browser.json),
[startup](evidence/payslip-identity-startup.txt), and
[contract/reconciliation limits](../operations/payslip-identity-disclosure.md).
Broader ownership/repair, aggregation, export/retention and operational controls
remain open. Whole-control statuses and release hold are unchanged.


## Reviewed payroll identity repair — 20 October 2026

Base 937ef3835386ddf044267152b17ff584ae9fb017. New exceptional cloud-only
repair binds an unresolved payslip to a verified employee after fresh proof, a
reason/reference and a five-minute actor/session/company/record/employee-bound
review. Conditional employee_id-only update and attributed revision succeed
together; paid financial state/finalization time remain. The ordinary editor
cannot change ownership or coerce invalid IDs into legacy fallback. Review
credentials bypass general HTTP receipt storage, even with retry keys.

| Check | Completed result |
|---|---|
| Full regression | 313 files / 3288 tests passed, 629.15s |
| Final focused | 7 files / 219 tests passed, 40.59s; 16 new API cases |
| Final Playwright | 40 passed, 98.376s; 3 new repair/cancel/stale cases and dialog axe scan |
| Actual server.ts | Fresh proof, no credential receipts, one repair, paid-state/time preservation, revision audit and employee access |
| TypeScript | Passed |
| Schema/dependencies | Unchanged; db:types not required/run |
| Staged secrets / whitespace | Clean; final commit hook scans full evidence again |

A final caller review found normal-editor numeric coercion could store a malformed
employee ID as null and revive name fallback. The preliminary full run was stopped
(exit 130), a regression reproduced 1 failure / 14 passes, and the final edit path
now preserves the original stamp and checks serialized ownership. The interrupted
run is not counted as a full pass. Initial typecheck inference errors were fixed
before successful validation; the original compiler log was not retained.

The first browser run had 2 passes and 1 fixture failure: cancellation encountered
the shared native discard-changes prompt, which Playwright dismisses by default.
The fixture now accepts it; no confirmation request is sent. Failed log/JSON and
screenshot are retained; the transient trace ZIP was not archived. Final browser
runs completed before the standalone final full regression.

[Verification and source manifest](evidence/payroll-repair-verification.json),
[seven-source research](payroll-repair-research.md),
[operator/API contract](../operations/payroll-identity-repair.md),
[full log](evidence/payroll-repair-full.txt),
[focused log](evidence/payroll-repair-focused.txt),
[browser JSON](evidence/payroll-repair-browser.json),
[confirmation screenshot](evidence/payroll-repair-review.png), and
[actual startup](evidence/payroll-repair-startup.txt).
The 233-control counts and release hold are unchanged; no real employee records,
provider messages or hosted settings were changed.


## Stable-ID statutory and HR report attribution — 20 October 2026

Base `1b394dd2768d1dd58b9b63338ff7f9a6c6cab2e3`. High scoped duplicate-name attribution
and uncertain-source output gaps, plus medium silent-error/stale-export handling, addressed.
See [operator contract](../operations/payroll-report-identity.md),
[seven-source primary research](payroll-reports-research.md) and
[verification manifest](evidence/payroll-reports-verification.json).

- Final full suite: **314 files / 3302 tests passed**, 632.74 seconds
  ([log](evidence/payroll-reports-full.txt)). Implementation/test SHA-256 values were frozen
  before the final run and checked afterward. No browser/full-suite overlap.
- Focused API/frontend: **8 files / 255 tests passed**, 36.91 seconds
  ([log](evidence/payroll-reports-focused.txt)), including **14 new API cases** for duplicate
  names/stamps, identifiers/brackets/headcount, legacy rename, all affected reports/CSV,
  cutoff/pay-year scope, corruption/non-string names, duplicate labels, fund bases/settings,
  permission failures and reviewed repair restoring reports without changing money.
- Complete Playwright: **43 passed**, 107.3014 seconds;
  **3 new report journeys** cover actual certificate print detail, downloadable CSV, all
  six blocked report dialogs, disabled/pending exports, late-year responses and scoped axe.
  The final reader version also passed **4 scoped browser checks**,
  16.5215 seconds, before the final full application run.
- Typecheck and delivered JavaScript syntax passed. Actual `server.ts` smoke passed using
  temporary synthetic cloud catalogs: separate IDs/amounts/counts, 409/no-store holds, another
  year still usable, unauthorized denial and no source-history/mail mutation
  ([script](evidence/payroll-reports-startup-smoke.py), [result](evidence/payroll-reports-startup-smoke.txt)).
- Original API reproduction: **8 failed / 3 passed**. Initial browser selectors caused two
  timeouts (div cards, not buttons). A subsequent axe scan found an empty table action header;
  it was fixed and the final scan passed. Logs/JSON/failure screenshots are retained.
- A later malformed-name reproduction returned 500 instead of 409 (**1 failed / 13 passed**).
  The reader now rejects non-string legacy names. Preliminary full run was stopped (exit130)
  for this fix and is not counted as completed. The final suite above replaced it.
- Initial sandbox listener denial executed no tests; local-listener re-run succeeded.
  Initial browser tuple typing was corrected before final typecheck. Those original logs were
  overwritten; this limitation is explicit. Transient browser trace ZIPs are not published.
- Schema/dependencies unchanged; db:types not required/run. No deployment command, real
  customer correction, provider write, bank reconciliation or filing was performed.

Old projection browser evidence now uses clean fixture pay year 2025: the 2026 fixture
intentionally contains unresolved legacy slips and correctly blocks filing. This preserves
its bounded-identity assertions; the new report cases assert the integrity hold itself.
Whole controls remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release remains on hold.
Source/GL/payment/filing reconciliation, duplicate/eligibility/historical settings,
reviewed reconstruction and wider scorecard responsibilities are not declared complete.

Final commit hygiene: generated text evidence was normalized for trailing whitespace/blank
EOF lines, with pre-normalization and retained-artifact hashes in the manifest. Gitleaks
initially mistook a scan-log SHA-256 under a filename containing “secrets” for an API key.
The exact log digest was verified and its evidence file renamed `payroll-reports-gitleaks.txt`;
no scanner rule was disabled or allowlist added. The complete staged scan/hook was rerun.


## Payroll source, journal replacement and bounded comparison — 20 October 2026

Base `91a66680f659ae3ef940e1de8287528d02ba4e69`. See [operator contract](../operations/payroll-reconciliation.md),
[seven-source research](payroll-reconcile-research.md) and [manifest](evidence/payroll-reconcile-verification.json).

- Final full suite: **315 files / 3325 tests passed**, 644.99 seconds
  ([log](evidence/payroll-reconcile-full.txt)). Frozen runtime/test hashes verified afterward.
- Focused: **11 files / 309 tests passed**, 44.46 seconds
  ([log](evidence/payroll-reconcile-focused-final.txt)); **22 new API cases** include duplicate/cross-year/custom
  alias scope, earlier/unlinked monthly history, rate-change rollback, raw cutoff stamp preservation,
  journal balance/SQL/partial-line failures, sequence rollback, closed original/new/reversal dates,
  reversal exclusion, invalid/multiple live journals, account/date mismatch, private projections and roles.
- Explicit installed-office GL regression: offline main-host generate, post/repost, current comparison,
  confirmed cloud replay, same money and exactly three journal rows. Existing paid D6 checks remain.
  Separate focused sync run: **4 passed** ([log](evidence/payroll-reconcile-offline-focused.txt)).
- Complete Playwright: **46 passed**, 115.9924 seconds. Three new actual-app journeys
  cover read-only comparison, explicit posting, duplicate rejection, error/retry, older response rejection
  and scoped axe. Existing reviewed-repair tests now search their exact record in the payroll bundle view.
- Typecheck and delivered JS syntax passed. Actual `server.ts` plus SIGKILL/restart smoke passed
  ([result](evidence/payroll-reconcile-startup-smoke.txt), [driver](evidence/payroll-reconcile-startup-smoke.py),
  [fault child](evidence/payroll-reconcile-crash-child.ts)): crash after the inner reversal release
  preserves the prior entries/lines/counter, restart detects changed source, deliberate repost commits
  one pair, and duplicate generation/posting holds leave the ledger unchanged. No mail/provider write.
- Original reproduction: **5 failed / 1 passed**. Initial refactor syntax error prevented four files'
  setup (137 skipped); compiler/transform evidence retained. Initial full browser: **43 passed / 3 failed**
  from older repair selectors assuming expanded target rows after new cutoff fixtures. Searching the
  target fixed those tests; no product grouping was changed. Failure screenshots/contexts/JSON retained.
- Preliminary full run stopped (exit130) to add the explicit offline GL replay case. It is not counted
  as completed; the final run above includes it. No browser/full-Vitest overlap in completed verification.
- Text logs normalize ANSI colors/trailing whitespace with original and retained hashes recorded.
  Transient authenticated trace ZIPs are not published. Schema/dependencies unchanged; db:types not
  required/run. Staged secret scanning and mandatory commit hook run before push.

This proves current source/journal integrity within the tested cases, not wage settlement,
entity-specific accrual/filing policy, historical completeness, retry-safe one-use authorization,
large-history capacity or actual native/physical-office/provider/hosted restore acceptance.
Whole controls remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release remains on hold.

Final scan hygiene: four generic-key detections were verified original/retained artifact
SHA-256 values under filenames containing “access.” Both original and saved file digests
were checked, artifact filenames shortened, and the unchanged scanner rerun. No actual
credential, scanner-rule relaxation or allowlist was involved.


## Reviewed payroll cutoff ID recovery — 20 October 2026

Base `42e332041569c192dfb9496e3c3b84e0b8103b6f`. See [operator contract](../operations/payroll-cutoff-recovery.md),
[five primary sources](payroll-cutoff-research.md) and [manifest](evidence/payroll-cutoff-verification.json).

- Full suite: **316 files / 3347 tests passed**, 686.17 seconds
  ([log](evidence/payroll-cutoff-full.txt)). Runtime/test SHA256 values were frozen and rechecked.
- Final focused: **6 files / 90 tests passed**, 32.05 seconds.
  **22 new API cases** cover report recovery, identical financial/timestamp fields, current and historical
  label/cutoff consistency, paid/duplicate/journal/closed/mail holds, roles/tenants/sessions, purpose/expiry,
  stale state, concurrent/repeated confirmation, history-write rollback and HTTP receipt exclusion.
  Installed-node requests refuse online-only and enqueue no repair; existing payroll/offline tests pass.
- Complete Playwright: **52 passed**, 133.3681 seconds. Six new cases cover
  actual-app authoritative review, original data/history, cancel, late paid state, navigation discard,
  changed account/company and scoped axe. Typecheck and delivered JS syntax passed.
- Initial focused: **69 passed / 2 failed**. Both new fixtures used `mark_paid` where the existing database
  enum is `paid`; corrected fixture values. A preliminary six-file run passed 89 tests; final 90 includes
  the added purpose/stale-revision case and stronger retry-cache checks. Failed logs are retained.
- Initial browser: **49 passed / 1 failed** because the navigation test did not accept the existing native
  discard prompt. Corrected the test and added independent account/company guard cases; no product
  navigation/dismissal behavior changed. Initial JSON, screenshot and context are retained. No flakiness
  allowance/retries were used. Full Vitest did not overlap the browser run.
- No schema/dependency change; db:types and a fresh advisory scan were not run. Text evidence normalizes
  colors/whitespace with raw/retained hashes. Transient authenticated trace ZIPs are not published.
  Final staged secret scanning passed; the mandatory commit hook repeats the scan at commit.

This recovers only a consistent missing/invalid stamp. It does not implement actual transfers,
duplicate disposition, released/posted adjustments, unrecorded issued-copy/filing verification,
independent audit protection, large-history/native/physical-office/hosted acceptance or a complete
production certification. No live customer/provider mutation or deployment occurred. The global
referenced ~/.claude/CLAUDE.md resolves to /home/agent/.claude/CLAUDE.md and is absent; repository workflow
instructions, catalog and pipelines were followed. Whole controls remain 36 PASS / 58 FAIL /
126 UNVERIFIED / 13 N/A; release hold remains.


## Payroll paid marking and employee issuance — 22 October 2026

Base `6667c52235cabcc6937b01949bde2d0c16053427`. See [contract](../operations/payroll-release.md),
[four-source research](payroll-release-research.md) and [manifest](evidence/payroll-release-verification.json).

- Full suite: **317 files / 3364 passed**, 606.19 seconds.
  Final runtime/test SHA256 values frozen and rechecked. Final focused: **9 files /
  212 passed**, 64.92 seconds.
- **16 new API cases** cover duplicate/unresolved/invalid-stamp/shape/date/status holds, same-shape
  employee projection, private no-store, foreign tenant/owner isolation, unknown legacy compatibility,
  unrelated corrupt JSON, late source changes, concurrent paid marking and audit-write rollback.
- One new in-process offline case: local duplicate refusal creates no command; subsequent valid
  accepted offline payment survives a later cloud duplicate, confirms replay, records a source clash
  and holds cloud email. Existing paid D6 and offline GL regressions also pass.
- Final complete Playwright: **55 passed**, 130.6881 seconds. Three new journeys cover
  persistent duplicate hold and scoped axe, disabled draft email/valid paid transition, and employee
  withholding of paid duplicates. Earlier full browser runs each passed 55 before alias and dialog
  refinements; retained separately. Final full Vitest does not overlap browser execution.
- Before implementation: **10 failed / 3 passed**; nine behavior failures and one unrelated fixture
  expectation. Initial focused: **208 passed / 1 failed** because the other user lacked a linked
  employee (correctly 403). Linked that synthetic fixture, preserving production 403 behavior.
  Preliminary focused then passed 210; final 212 adds alias and concurrent-transition cases.
- Existing unresolved email assertions now expect 409. The missing-recipient email test first marks
  the generated valid slip Paid. The old cutoff-recovery stale browser case now edits payroll normally,
  since new Mark Paid correctly refuses its invalid-stamp fixture; API paid-history coverage stays.
- Typecheck, delivered JS syntax and final screenshot inspection passed. No schema/dependency change;
  db:types and a fresh advisory scan not run. Linux environment/tool versions retained. API mail is
  mocked; browser cases do not send mail. No live customer/provider write or deployment command was performed.
  Text logs normalize ANSI/whitespace with raw and retained hashes. Final staged secret scanning passed;
  the mandatory commit hook repeats the scan at commit.

Current source checks preserve unknown legacy cutoff compatibility and the existing raw employee
data projection. They do not certify arithmetic, actual settlement/filings, true duplicate adjustment,
instant replica convergence, independent audit, staff print/Excel final-release controls, reviewed/durable email or native/hosted/office
acceptance. The referenced global workflow file is absent; repository instructions were followed.
Whole controls remain 36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A; release hold remains.


## Staff payroll saved print and Excel copies — 22 October 2026

Base `0c8954ab2e606b5d3ce01b7e4756196b506dc214`. See [contract](../operations/payroll-staff-copies.md),
[six-source research](payroll-copy-research.md) and [manifest](evidence/payroll-copy-verification.json).

- Full regression: **319 files / 3380 passed**, 648.5 seconds.
  Source/test hashes frozen and verified; full Vitest starts after browser/editor gates finish.
  Focused: **17 files / 319 passed**, 63.92 seconds.
- **14 new API cases** check read permissions, tenant/form/missing-ID isolation, strict bounded
  batches, whole-batch hidden-sibling holds, invalid source/status/money, saved projection,
  private no-store, ordered snapshots, late conflicts and money/status/revision/form/cutoff preconditions.
- **Two new workbook cases** exercise the actual vendored XLSX writer/reader and printable
  summary escaping. Spreadsheet-looking text stays string cells with no formulas. The browser
  downloads a real XLSX with refreshed money and the draft notice.
- Final complete Playwright: **64 passed**, 157.3683 seconds, no flaky/skipped cases.
  Nine new journeys cover row/visible/selected/bundle print, summary and Excel holds, saved-value
  reload, stale print refusal, valid Paid print dispatch, unsaved deduction preservation, late
  view/account/company refusal, resize fit, keyboard recovery and scoped axe.
- Complete editor UX gate: **94 scans, 15 checks**,
  zero automated violations, failed checks or runtime errors. Incomplete rules are retained and
  manually reviewed within the stated limits. Both-theme 1440/1024/768/390px preview screenshots
  and the blocked frame were inspected; no physical paper or assistive-technology acceptance inferred.
- Failed/preliminary runs remain archived: 10/11 initial cases failed before the endpoint;
  CommonJS XLSX fixture error corrected; real contrast/landmark and heading-order findings fixed;
  keyboard focus recovery fixed; successful pre-resize browsers followed by a visual clipping fix.
  A separately reproduced staff-search 500 (13 passed / 1 failed) is corrected by guarding JSON extraction.
  Editor setup re-logins after password revocation and uses the real cookie login/current URL.
  Editor label-in-name failures (52 initial scans, then 37 File-only scans) were corrected without exclusions;
  final incomplete checks are described in payroll-copy-review-notes.md. These findings are retained separately in this evidence family.
- Typecheck and delivered-JS/script syntax passed. No schema/dependency change; no db:types or
  fresh advisory scan. No deployment command, real payroll/mail/bank/provider transaction or
  customer data was used. Staged Gitleaks and mandatory commit hook run before push.

Copies use the current server replica and preserve explicit legacy compatibility. A digest is an
output equality precondition, not payment evidence, a factor or signed approval. Existing template/
global previews are frozen separately; old copies cannot be recalled. Reviewed durable email,
actual duplicate adjustments, historic payroll correctness, settlement/filing, dependency and
native/hosted/privacy/operational acceptance remain. All 233 controls retain their whole-control
statuses (36 PASS / 58 FAIL / 126 UNVERIFIED / 13 N/A); the release remains on hold.

## Reviewed payslip email release — 22 October 2026

Narrow scope: exact saved recipient/content review, confirmation, durable queue/claim, SMTP
acceptance/rejection/uncertainty and controlled recovery. Baseline production commit:
e7cf902f2c225fe8bd1a7964d403c8647483eb37. See [contract/findings](payroll-email-contract.md),
[verification notes](payroll-email-verification-notes.md), [runbook](../operations/payroll-email-release.md)
and [checksummed manifest](evidence/payroll-email-verification.json).

| Check | Final result |
|---|---|
| Typecheck; browser JavaScript syntax; generated SQLite types | Passed / generated |
| Focused HTTP/SMTP/state/authority/snapshot/recovery tests | 9 files, 252 tests passed; 80.12 seconds |
| Complete Vitest regression | 321 files, 3467 tests passed; 672.20 seconds |
| Complete Playwright regression | 71 passed; zero failures/flaky/skipped; 183.22662 seconds |
| Real server process experiments | Six passed: queued restart, accepted restart, three SIGKILL windows, lost committed HTTP response and competing process workers; some cases combine these observations |
| Actual node export reproductions | Both pass: zero cloud email rows/markers; source queue/history intact; proof/ciphertext absent from VACUUMed file; original intent still submits once |
| Email dialog/content accessibility | Eight viewport/theme combinations and eight isolated content scans; zero violations; retained dialog color-contrast/frame-tested incompletes |
| Shared editor UX gate | 94 scans, 15 workflow checks, zero automated violations/failures/errors; same UI/editor bytes as final source |
| Runtime npm audit | Exit 1: one high and three moderate broader findings, retained open |

The first complete Vitest run is retained: 318 files/3462 tests passed, three failed. Corrected
an old fixed schema-number expectation, retained former-name recipient checking through
preflight instead of direct sending, and declared online classification on every email route
rather than adding an exemption. Additional direct snapshot experiments found restrictive
child/parent deletion order and marker re-creation after settings scrub; actual export/file
assertions now cover both. A second frozen-source full run passed. No source/test edits were
made while either full run was active.

Five deliberately failing original-code reproductions, all intermediate failures and the
before/after SMTP/snapshot observations are retained. The notes distinguish fixture/harness
errors from product defects. The tests use real Nodemailer and verified local TLS; no live
provider or real payroll email was sent. SMTP acceptance is not mailbox delivery. Unknown is
not failed, and an interrupted intent is not automatically resent. No exactly-once guarantee.

The final manifest records source hashes and scan evidence. Authentication trace ZIPs, private
TLS keys and temporary databases are excluded. Git's required staged Gitleaks hook remains
active; its actual outcome is reported with the commit. Historical-secret revocation and all
other broader release blockers remain open. Real-provider/hosting/restore, mixed-build/native
rollout, independent review and legal/retention/payroll acceptance are not established here.

## 23 October 2026 — runtime dependency review and Word import

Final decision: **retain original dependencies**. The formatter advisory was
withdrawn upstream at 2026-10-22T19:21:04Z (23 October, 03:21 Manila). Primary
GitHub API/page evidence and fresh-cache npm scans explain the changed counts.
See [contract/decision](dependency-parser-contract.md),
[verification manifest](evidence/dependency-parser-verification.json) and
[installation/re-evaluation](../operations/dependency-parser-upgrade.md).

The scoped parser candidate was tested, then removed after withdrawal invalidated
its original justification. No major override, advisory suppression, application
source change or schema migration is delivered. Manifests match baseline 212ff016
byte for byte. The final addition is a real Word-import browser regression: a bad
archive preserves the draft, a real DOCX previews before Apply, Apply stays local,
and Undo restores the draft while the saved template remains unchanged.

| Final restored-graph verification | Result |
|---|---|
| Clean npm ci, scripts disabled | Original Mammoth 1.13.0 / argparse 1.0.10 / sprintf-js 1.0.3 runtime graph restored; no overrides |
| Existing focused application regression | 4 files / 86 tests passed, exit 0; 27.01 seconds |
| Full Playwright regression | 72 expected passes; zero failures/flaky/skipped, exit 0; 183.865728 seconds |
| TypeScript | Passed, exit 0 |
| Full Vitest regression | 321 files / 3467 tests passed, exit 0; 642.90 seconds |
| Final runtime and explicit full-root npm scans | Both exit 1: one high / zero moderate; node-forge remains open |

Discarded-candidate results are retained separately: 5 files/96 focused tests,
72 Playwright scenarios, 94 editor scans/15 workflows and 322 files/3477 full Vitest
tests. The candidate full run lasted 630.44 seconds and has complete pass totals;
its tool session handle was unavailable afterward, so no independently retained
process exit is asserted. A prior attempt was interrupted by the environment restart
before totals. Neither attempt is substituted for final restored-graph verification.

Before-change tests demonstrate the then-flagged dependency's presence and a clean
probe reproduces its RangeError. They do not establish an application HTTP exploit.
The record preserves npm's rejected/misleading-success install experiments and
corrected fixture assumptions about CLI wording, valid Markdown and ambient dev
module resolution. The proposed patch/test/source hashes remain experiment artifacts.

The candidate editor gate retained contrast incompletes in 90 scans/512 nodes and
label-name incompletes in 55 scans/358 nodes. Eight viewport/theme screenshots were
reviewed at 1440/1024/768/390px; Save/Close bounds passed and narrow controls wrapped.
Gradient/custom-select backgrounds and symbolic formatting labels still require
independent manual accessibility checks. UI/editor bytes are unchanged in the final
result; these candidate scans are not presented as a rerun on original dependencies.
No complete WCAG or assistive-technology acceptance is claimed.

The high Forge finding, independent review, historical secrets and broader release
hold remain. The old moderate build-chain entries disappeared through upstream
withdrawal, not an implementation fix. Launcher/mobile were not rescanned here.
No live-provider, hosted restore/capacity, native/mixed-build or legal/payroll acceptance
is established. Historical 233-control totals remain unchanged. Authenticated trace
ZIPs, temporary databases, private TLS keys and real customer files are excluded.

Gitleaks 8.24.3 passed a directory scan of 78 exported staged files and a subsequent
staged pre-commit scan, both exit 0. Actual logs and checksums are retained. The
mandatory commit hook remains active and scans the final staged revision again;
its actual outcome is reported after committing. These scoped checks do not attest
clean historical secrets or verified revocation.

## Payroll GL retry and originating-command follow-up — 23 October 2026

Baseline `0de7c12021c16b17499a03d6535c4269d299a4aa`. Scope: keyed acknowledgements
and originating-node source/receipt/command commit, with browser retry/context guards.
See [contract and findings](payroll-post-retry-contract.md),
[six-source research and reproduction](payroll-post-research.md),
[recovery procedure](../operations/payroll-post-retries.md) and
[verification manifest](evidence/payroll-post-verification.json).

Before fixing, SQL faults demonstrated 201 after missing receipt persistence,
same-key original/reversal/replacement after that failure, and local 201/command header
without a durable sync command. Three required correctness assertions fail on an
isolated unchanged baseline checkout. Before/after observations, drivers and failing
logs are retained. These are synthetic test records, not real financial incidents.

| Final check | Result |
|---|---|
| Full `npm test -- --fileParallelism --maxWorkers=2` | **323 files / 3,491 tests passed**, 662.78s, exit 0 |
| Focused posting/reconciliation/idempotency/offline/route-class regression | **6 files / 65 tests passed**, 21.93s, exit 0 |
| Complete Playwright suite | **78 passed**, 201.66s; zero skipped, unexpected or flaky |
| New posting browser scenarios | Six passed: committed response loss, deadline, changed actor/company/view, responsive/theme accessibility |
| Real process/concurrency comparison | Baseline violates four of five cases; fixed source satisfies all five; already-committed receipt case passes on both |
| TypeScript / delivered JS syntax | Passed; final source/test hashes unchanged |
| Runtime dependency audit | Exit 1, **one high node-forge**, no moderate; manifests unchanged; remains a release blocker |

Database assertions cover same-key concurrency, intentional different-key/keyless re-post,
changed body/cutoff, revoked session/permission, identical IDs/key across tenant databases,
known legacy/corrupt receipts, retained financial references and raw-key/bearer absence.
Node tests cover command-write rollback, same-command retries, missing/conflicting commands,
permission changes during capture-lock wait and normal offline post/re-post/cloud replay.

The actual server-process drill kills before/after receipt insertion, after commit before
HTTP emission and at node command insertion, and coordinates two processes after both
receipt misses. It inspects rows/commands after restart on the same local database.
Node 24.19.0 / SQLite 3.53.3, WAL and synchronous=2 were observed. This establishes the
scoped process-interruption behavior on this Linux filesystem; it is not physical
power-loss, real Windows/LAN, backup-restore or independent hosted acceptance.

Earlier failed runs remain visible: the production crash harness initially omitted the
required Manila TZ; test-only TypeScript header bindings were corrected; browser testing
found the incorrect account accessor and two test assumptions (toast selector/navigation
closes modal). A theme-transition contrast observation was resolved by waiting for actual
transition completion before scanning, without disabling axe rules. Eight final dialog
scans at 1440/1024/768/390 in light/dark show no violations, with incomplete contrast checks
retained for manual review. The narrow dark and wide light screenshots were visually
inspected. No complete accessibility certification is claimed.

Evidence text removes ANSI/trailing whitespace with raw/retained SHA-256 values recorded.
Authenticated traces, private databases and keys are excluded. Staged content and an
export of staged files passed Gitleaks (exit 0, no leaks); the mandatory commit hook runs
again. An initial scan flagged 36 source-checksum map entries. Every flagged value
matched its file's computed SHA-256; the manifest now separates path/hash fields,
without scanner exceptions. Raw/retained hashes preserve that representation change.
These checks do not close historical secrets or the node-forge advisory.

The fix retains claim/main-host and D6 authority. Source-version-bound one-use approval,
offline factor/origin binding and cloud authority dispatch/effect-stream/verdict/rebase
interruption recovery remain engineering work. The demonstrated access tests do not
establish full multi-process authorization-revocation linearization. Lost-page/key,
older/keyless clients, different actors/servers and uncertain command recovery require
reconciliation. Financial policy/retention and real runtime/device/restore acceptance
need independent review or external verification. No new owner engineering task is
required now; whole-control totals and the complete release hold remain unchanged.

## Cloud payroll replay and honest status — 23 October 2026

Baseline `a92de92c173c41280a52ed734bad913f441f68a5`. This follow-up covers cloud
confirmation of an office's payroll GL command, its status read and retention metadata.
See [contract/states](payroll-replay-contract.md),
[primary-source research and failed experiments](payroll-replay-research.md),
[recovery](../operations/payroll-cloud-replay.md) and the
[verification/hash manifest](evidence/payroll-replay-verification.json).

Two unchanged-source SQL fault assertions failed: journal rows survived effect/verdict
persistence failure, leaving received commands with incomplete durable decisions. The
fix creates a server-owned immutable inbox marker and commits payroll writes, its
changeset and final verdict in one synchronous cloud transaction. Infrastructure faults
stay pending/retryable; genuine authorization/validation refusals keep no new posting.
Old received rows without protocol proof hold for reviewed reconciliation. Two additional
real HTTP assertions showed received/unknown cloud IDs falsely returned confirmed;
status now uses the stored row with ownership/management checks and unknown IDs return 404.

| Final verification | Actual result |
|---|---|
| Standard full `npm test -- --fileParallelism --maxWorkers=2` | **325 files / 3,511 tests passed**, 675.76s, exit 0 |
| Complete Playwright regression | **78 passed**, 203.03s; zero skipped/unexpected/flaky |
| Final clock/maintenance/status/offline focused set | **5 files / 37 tests passed**, 20.50s |
| Earlier boundary sets | 4 files / 45 tests and 7 files / 53 tests passed; final full run covers their delivered source |
| Actual cloud process interruption/concurrency | **Six of six satisfy the contract**, including office replica convergence |
| TypeScript including crash drill | Passed using the full project context plus the drill; no compiler flags weakened |
| Schema generation | Passed, no ordinary business-schema type change; optional sync table added with IF NOT EXISTS |
| Runtime dependency audit | Exit 1: **one high node-forge**, no moderate; manifests unchanged, release blocker remains |

The process cases kill before effect insert, before/after confirmed-verdict update, at
internal response emission and at outer response emission, then restart and retry. The
sixth pauses two real processes after both observe the same received command. The old
server creates original/reversal/replacement in five cases; final code leaves one journal,
one effect and its confirmed verdict. The baseline's complete-decision/lost-response
control preserves its source correctly; it passes including replica convergence when run
on fresh data. Earlier deliberately broken baseline effects contaminate later sequence
pulls, so aggregate six-case failure is not six independent defects.

Normal office→cloud→LAN and LAN-origin local→host-confirmed→cloud-confirmed flows pass.
Tests cover immutable body/method/path/actor/plan/context binding, pending and decided
retries, missing/legacy protocol proof, trimmed-command tombstones, real snapshot scrubbing,
permission refusal, source validation and recorder isolation. Real HTTP/cloud status checks
cover received/rejected/confirmed, unknown IDs, authentication and another actor's privacy.
Node 24.19.0, SQLite 3.53.3, WAL and synchronous=2 were observed on this Linux filesystem.

The first complete run failed only the real tenant-migration integration test at its
20-second timeout (323 files/3,503 tests passed). Isolated updated/baseline runs pass near
that limit. Only that test's explicit budget is now 60 seconds; every assertion and body
statement is byte-for-byte preserved after removing that argument/comment, with proof
retained. No production performance fix or global timeout increase is claimed.

An intermediate 325-file/3,510-test green run preceded the delayed-clock check. That check
then demonstrated a high implementation defect: replay's original clock backdated new
technical effect/verdict metadata to 2010, and cleanup immediately deleted the newly
confirmed command. The final correction binds server confirmation time for retention
while preserving payroll business time. Exact failing/passing timestamps, the intermediate
run and final reruns remain evidence. A green earlier suite is not credited to this fix.

Other failed experiments are retained: wrong helper argument before any crash request,
wrong original/router-relative response hook, changed-method policy escape, and initial
script-only typing without the full project context. One concurrent server startup exited
on a schema/seed database lock after five cases passed. The final race starts each server
first, then still submits concurrent barrier-controlled requests. Simultaneous cold-start
availability remains open. The initial sandbox tsx IPC denial survives in the tool transcript;
its overwritten first stderr is not represented as an independently retained raw file.

Final regression metadata binds its exit-zero run to all **869 unchanged input hashes**.
Text artifacts remove ANSI/trailing whitespace/extra EOF blank lines with raw/retained
SHA-256 values. Private databases, keys, node/session tokens and authenticated browser
traces are excluded. Staged and exported-directory Gitleaks scans passed with no leaks (exit 0); the mandatory
commit hook also scans final staged content. See the final logs/manifest. Historical-secret
findings stay open.

These results establish the scoped cloud payroll transaction, retry, retention and honest
status behavior under the tested faults. They do not establish one-use reviewed source
approval, offline factor/origin proof, full cross-process revocation linearization, other
route/site-host replay or node rebase crash recovery. Historical financial repair,
simultaneous startup, physical power-loss, Windows/hosting/storage/restore/mixed-build
acceptance and independent accounting/security/accessibility review remain. Complete
control totals and the broader release hold are unchanged; no new owner engineering task
is required for this increment.

## 24 October 2026 — bounded cross-process SQLite startup

Increment baseline `production`: `0c2ed900239ce50db297ebd957d9f34b6ec0b0cc`, matched to the live
remote before edits. See the [contract](sqlite-startup-contract.md),
[recovery](../operations/sqlite-startup.md) and [verification/hash manifest](evidence/sqlite-startup-verification.json).
Final complete-run commands/results belong to that manifest; failed/intermediate attempts remain below.

Two local availability defects were reproduced before runtime edits. Real trigger initialization
exits with SQLite error 5 under a controlled short writer. First-run seed read-before-insert
exits with extended error 2067 when both processes see zero users. Identical driver bytes then
show both processes completing after serialization, with the synthetic paid payslip/revision and sentinel setting
unchanged, integrity `ok`, empty foreign-key checks, no open transaction and runtime timeout 0.
The originals did not demonstrate duplicate administrators or lost payroll.

The adjacent technical SQLite gate covers cold tenant/catalog schema, migration, history and
seed work. Existing backup/legacy migration transactions and offline payroll authority remain.
Private memory skips filesystem coordination. Final actual-server schema equals baseline at
413 tenant/33 catalog objects; the technical gate contains zero objects/bytes. No package,
business schema version or general runtime write policy changed. An additional old-source
catalog fault check performed after the candidate demonstrates zero operators on retry from
an incomplete cached handle; the updated initializer closes/evicts it and retries to one operator.
That check is retrospective, not a pre-edit reproduction.

| Completed scoped check | Observed result |
|---|---|
| Final canonical `npm test` | **326 files / 3,519 tests passed**, exit 0; 1,910.00s Vitest / 1,910.66s wrapper. All 872 selected frozen input hashes unchanged. |
| Original-race permanent tests against old app source | Both intended state assertions fail with original 20 s and updated 60 s harness defaults; test/worker bytes identical. Six cases deliberately deselected only in the small detector runs. |
| Startup + unchanged restore, Node 24 before harness changes | 2 files /9 tests passed,23.86 s. |
| Same subset on official checksum-verified Node 22.22.0 | 2 files /9 tests passed,30.14 s Vitest /30.78 s wrapper, original stricter default budget. |
| Actual `server.ts`,3 paired cold starts | Baseline loses 1 process per pair; final 6 processes healthy, one administrator/operator per DB, integrity `ok`. |
| Complete Playwright | 78 passed,0 skipped/unexpected/flaky;298.74 s reporter /299.81 s wrapper. Runtime/e 2 e/config bytes unchanged by later fixture changes; retained input delta establishes reuse. |
| Final mobile file + project typecheck | All 130 mobile tests pass,46.35 s wrapper; normal typecheck passes,21.59 s. |
| Delayed-storage shared-fixture controls | 9 selected cases pass with real storage API acknowledgements delayed 250 ms, including 2 intentionally stuck-network cases. |
| Unhandled-storage negative control | Normal courier assertions pass;1 unhandled synthetic rejection yields exit 1, as required. First invalid-input attempt is not credited. |
| Assertion/config integrity | 625 original mobile matcher/helper expressions match in order. Of 363 existing test/config files,361 remain byte-identical. Vitest budgets and the mobile fixture are the changed files. |
| Declared-minimum Node 22.13 API probe | New gate callback succeeds, but pre-existing payroll/sync `isTransaction` dependency is absent during an actual open transaction.22.22/24.19 expose it. End-to-end financial impact not reproduced. |
| Runtime dependency audit | Exit 1:4 high/1 moderate/0 critical vulnerable-package entries;7 active primary records. Installed selected runtime versions match; manifests/lockfiles unchanged. |

### Validation changes and their meaning

The default Vitest test/hook execution budgets are relaxed 20 → 60 seconds. That relaxes a test
execution limit; it does not fix product latency or establish acceptable response time. Real
password cost, application deadlines, existing explicit `it` budgets and business elapsed-time
assertions remain. One authenticated user creation took 11.785 s and one MFA setup 15.545 s on this
host. Their cause/production relevance remain open. Official Vitest timeout semantics are
retained;60 seconds is our harness choice, not a framework/industry production SLA.

Fixed 40–120 ms mobile fixture sleeps sometimes resume before local storage and route rendering.
Real-storage 250 ms acknowledgement delays reproduce these failures on unchanged baseline mobile
source. The final fixture checks its supplied cached actor, forwards draft-storage promise
values/errors, polls only storage quiescence with a 5 s bound, and closes each window after the
case. It does not await network requests or consume promise rejections. Explicit positive-state
waits remain at demonstrated transitions. The 9 positive controls and expected unhandled-error
control check these distinctions. No production mobile behavior or global error handler changed.

A typed Blob object-URL mock fills a required native-browser primitive missing in JSDOM.
Chromium 156.0.8078.4 exposes both functions and completes a Blob round trip; JSDOM exposes neither.
This is fixture completeness, not real-device/photo acceptance. A TypeScript parser/printer proves
all 625 original matcher expressions/expected values remain, in the same order. Temporal fixture
semantics changed; expression identity is not a claim that all timing behavior is identical.

### Retained failed and intermediate attempts

1. First two new-worker typechecks failed; explicit typing/fixture checks corrected them.
2. The first runtime candidate created `:memory:.startup-lock`. Baseline/candidate/final probes
   and the eighth permanent startup test cover this patch-introduced compatibility regression.
3. First complete parallel run:325 files/3,517 tests passed,1 restore test failed at 20 s, before
   the eighth startup test. Baseline/candidate isolated restore passes in 9.96/8.48 wrapper seconds
   with original 20 s budget. No root cause or restore performance fix established.
4. Second parallel attempt: signup 20 s timeout, stopped after failure, exit 143,198.88 s. Incomplete.
5. Standard serial run:325 files/3,512 tests passed,7 QA cases skipped after its 20 s setup failure;
   exit 1,1,922.65 s wrapper. Parallelism alone does not explain the timing failures.
6. Unchanged QA/signup checks: baseline and candidate both pass original 20 s budgets,
  43.41/38.53 s wrapper. A 22 s heartbeat during protected staging found no > 200 ms scheduling gap;
   it did not support the tooling-pause hypothesis.
7. A further initially hands-off run hit MFA's 20 s limit at 22.449 s and was stopped incomplete,
   exit 143,428.92 s. Removing concurrent audit work did not eliminate the timing failures.
8. With 60 s defaults, a complete run passed 325 files/3,517 tests and failed 2 mobile null-field
   accesses; exit 1,1,035.68 s wrapper. Input hashes remained unchanged. After its first failure,
   bounded diagnostics ran alongside it: its metadata's isolation wording describes the initial
   intention, not the entire observed interval.
9. Local state-wait candidates passed controlled cases but subsequent 6-file focused runs exposed
  4 release renders (165 passed) and then 1 RTS render (168 passed). The shared fixture addresses
   the demonstrated class. Application mobile files remained unchanged throughout.
10. First shared candidate duplicated `html`/`srcs`:0 tests ran, including its first rejection
    control. Retained as invalid input, not successful error detection. Corrected candidate
    passes 9 delayed cases; corrected negative control produces the required unhandled error.
11. First assertion-comparator child Git call failed `EPERM` with partial output in the session
    transcript. The later pure parser from an explicitly saved pinned Git blob supplies the
   625-expression proof; no success is inferred from the failed command.

The final full run uses canonical serial `npm test` with the final fixture/budgets and no more
experiments or Git operations during execution. Final input freeze contains 872 selected
code/assets/test/script/config files. An initial 822-file extension filter omitted 50 unchanged
inputs; that earlier supplemental comparison remains. Later snapshots/delta distinguish
harness variants and reuse only byte-identical runtime/browser evidence.

Text evidence removes ANSI, trailing whitespace and extra EOF blank lines, with raw/retained
hashes. Diagnostic patches use JSON line arrays to retain exact context whitespace; reconstruct
and verify their raw SHA-256 before applying to a disposable checkout. Actual databases,
private/session material, binaries and authenticated traces are excluded. Read final staged/export
scan results in the manifest; historical-secret findings remain open.

The observations locally demonstrate the scoped ownership/recovery and validation contracts.
They are not independent assurance. Physical power loss, arbitrary historical migration crashes,
long migrations, filesystem aliases/mixed builds, Windows/real hosting/storage/restore, production
latency/capacity, minimum-runtime consequences and independent review remain open. The
[fresh dependency findings](runtime-advisories-2026-10-24.md) remain separate engineering work.
No new owner implementation task or whole-control PASS is claimed; the broader release hold
and historical control totals remain unchanged.

## Runtime dependency remediation — 24 October 2026

Source baseline and starting remote production: **06179a8fb022ef54bd45c1b9d88d140c1afdcf63**.
Read the [contract, primary research, raw evidence and failed experiments](dependency-remediation-2026-10-24.md)
and [recovery procedure](../operations/runtime-dependency-updates.md). This follows, rather than
relabels, the earlier same-day dependency observation. Only four runtime package entries change:
body-parser 1.20.8→1.20.9, Multer 2.4.0→2.5.0, Zod 4.4.3→4.6.6, Nodemailer 10.1.1→10.1.4.
No application runtime source/schema/trigger/authority or existing `.test.ts` assertions change.

| Check | Observed result |
|---|---|
| Original exploratory suite | 7 failures / 4 passes, then same result with retained captures before package changes |
| First superseded candidate (10.2.1 / 4.6.7) | 10/11 pass; strict quoted-mailbox preservation still fails; not final-graph validation |
| Final permanent drivers on exact original lockfile, clean npm ci | 6 failures / 4 passes; actual app process crash, schema overwork, async-filter dependency crash, three wrong-domain SMTP destinations |
| Final fixed clean graph, focused functional/adversarial run | 8 files / 121 tests pass; same permanent drivers/assertions; actual reviewed/platform transport and upload checks included |
| Checksum-verified Node 22.22 run | 10 permanent regressions pass; default full-suite runtime is Node 24.19.0 |
| TypeScript | npm run typecheck exits 0 |
| Full serial npm test | 327 files / 3,529 tests pass, zero failed/pending; 1,933.64s Vitest / 1,934.388s wrapper; all 879 selected inputs unchanged |
| Playwright | 78 pass, zero unexpected/flaky/skipped; 294.812s wrapper; same 879 inputs unchanged; all seven payslip email scenarios pass with actual local TLS SMTP wire evidence |
| Strict quoted-mailbox experiment | **Exit 1 on original and fixed graphs**, retained separately and not counted as a passed regression: patched library restores domain but replaces local-part `>` with a space. Tested public compose/reviewed payroll validators already refuse this syntax. |
| Runtime npm audit | 4 high / 1 moderate → 1 high / 0 moderate; final exit 1, node-forge remains |
| Complete-root npm audit | 5 high / 2 moderate → 2 high / 1 moderate; final exit 1, node-forge plus separate Electron/fast-uri findings |

All seven reviewed runtime advisory records remain active. This increment's advisory reduction
is credited to package changes, not an upstream withdrawal. Earlier formatter-advisory withdrawal
credit stays in its own dated record. The initial stronger quoted-angle failure remains visible
in the original 11-case source/report and in an executable standalone experiment; the green
permanent gate does not establish exactness for arbitrary RFC mailboxes. The temporary no-save
graph comparison changed unrelated installed packages and is not used as the exact-baseline proof;
both exact graphs were subsequently installed from their own unchanged lockfiles.

Gitleaks 8.24.3 staged and exported-content gates pass, zero findings, default rules, with all
seven compressed logs expanded for scanning. Initial 36 flags on each gate are verified file
digests in source-freeze metadata; lossless digest/path records resolve the format ambiguity,
without new allowlists or detection suppression. Initial findings, classification, round-trip
proof, final receipts and artifact hashes are retained in the linked verification record.
The final staged index and mandatory commit hook also cover publication metadata. Local results
are not independent review, hosted/native acceptance,
real inbox delivery or release approval. Existing Node minimum mismatch, auth latency, historical
secret findings and broader release blockers stay open. Historical whole-control totals do not
change in this scoped increment.

## Runtime admission and actual supported versions — 24 October 2026

Baseline/starting remote production: **e077a494547a35e0919711c8739bc46d874d03f4**.
[Contract and raw evidence](runtime-support-contract.md), [operator recovery](../operations/runtime-support.md).
The inaccurate `>=22.13` support declaration is replaced by `^22.22.0 || ^24.19.0`;
normal installs enforce engines and actual entry points probe native SQLite in private memory
before application data access. Current maintained pins are 22.23.4/24.22.1, with floor versions
retained in CI. This does not change an installed host/Electron binary automatically.

| Check | Observed result |
|---|---|
| Official Node 22.13 on unchanged payroll integration fixture | Setup fails `no such module: fts5`; eight pending tests, no payroll assertions executed |
| Isolated actual production transaction functions | Old runtime executes forbidden housekeeping inside a transaction and leaves one uncommitted inbox row after marker abort; supported 24.19 control refuses/rolls back; no committed financial corruption demonstrated |
| Real baseline versus fixed 22.13 entry points | Baseline tenant/catalog/server/maintenance all touch app paths; fixed runtime refusal creates zero app files; eight fixed cases include deliberately inconsistent supported version identity |
| Unchanged admission test/worker | 10 failures / 1 positive control before → 11 passes afterward; synthetic existing-file hashes and HTTP tripwire are mandatory |
| OS file-access witness | Corrected `strace` comparison: 37 data-path operations before → zero after refusal; supported control exits 0 and sees 45 operations |
| npm engine oracle | Ordinary old-policy offline install accepts 22.13; actual new engine/config fields refuse with EBADENGINE |
| Current runtimes | 41 focused tests each on checksum-verified 22.23.4 and 24.22.1; real capability and strict engine dry-runs pass at 22.22 and both current patches |
| TypeScript | Exits 0 on Node 24.22.1 |
| Full serial npm test | Node 22.22.0, 328 files / 3,540 passed, zero failed/pending; 2,036.83s Vitest / 2,037.652s wrapper; all 888 selected inputs unchanged |
| Full local Playwright | Node 24.22.1, 78 passed, zero unexpected/flaky/skipped; 377.181s wrapper; same 888 inputs unchanged, actual SMTP capture retained |
| Independent baseline CI | e077a49's two Node test jobs and secrets job succeed; dependency and browser jobs fail. Browser fails at npm run test:e2e, detailed log destination denied by proxy; annotations do not establish cause. Candidate CI is not inferred from baseline results. |
| Current advisory gates | Runtime 1 high; complete root 2 high / 1 moderate, both exit 1; no dependency version changes or remediation credit |

No existing `.test.ts` assertion, test timeout, CI job budget, password cost, business schema,
ledger/authority/retry logic changes. Initial invalid marker input is retained separately from
the corrected trigger experiment. The first failed positive tracing control's raw detail was
overwritten during diagnosis: its original result/counts, repeat failure for the missing synthetic
bootstrap fixture, and corrected successful comparison are documented explicitly. It is not
counted as passing evidence. Browser CI failure remains open as separate engineering work; OS
migration/action deprecation notices alone are not blamed as causes.

Gitleaks 8.24.3 default staged/exported-content scans pass with zero findings; all 13 compressed
logs are expanded for scanning. Final metadata is covered by the staged scan and mandatory commit
hook. Verification/secret receipts and artifact SHA-256 hashes are linked in the contract.
Runtime declaration and
admission are implemented/locally demonstrated, not independent human assurance. Actual host,
Windows/Electron build/capabilities, historical financial consequences, browser CI diagnosis,
dependency/quoted-mailbox findings and broader release holds remain open. No owner coding task,
whole-control PASS, production deployment or release approval is implied.
