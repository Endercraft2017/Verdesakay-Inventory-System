# Second-pass validation — 16 October 2026

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
