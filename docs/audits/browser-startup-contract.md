# Clean browser verification: startup and MFA input focus — 25 October 2026

Production baseline: **873a820ec4839e52030b0d1411bdcda9b12d8566**.
Scope: the actual-app Playwright fixture's capture-output initialization, plus
the small MFA client focus defect demonstrated once the browser gate could run.
The startup failure is a verification-infrastructure defect, not a demonstrated production-server crash.
The prior audit documents are leads; the source and experiments below establish
this increment's claims.

## Contract recorded before implementation

States: resolve fixture modules → initialize capture output → create disposable
databases/users/SMTP peer → start capture timer → complete remaining fixtures →
listen/healthy → browser scenarios/captured traffic → stop/cleanup.
The original source omits capture-output initialization. No browser report or
earlier local run may be assumed to have created an ignored directory for it.

Trust boundaries: checkout/current working directory, ignored diagnostic output,
isolated temporary tenant/catalog/upload data, localhost HTTP/TLS SMTP and the
test runner. Test bootstrap passwords and peer traffic are synthetic. No live
website/provider/account is exercised. Business data authority remains unchanged.

Correctness requirements:

1. An otherwise usable checkout without `work/` must start the real fixture,
   write parseable SMTP capture output and remain healthy across timer passes.
2. Existing output directories and unrelated files must be preserved. An occupied
   non-directory output path must fail visibly without deleting/replacing it.
3. Preparation must precede the timer's first write. The failure must not be
   suppressed, reclassified as a successful run or avoided by lowering test coverage.
4. Existing browser assertions, retries, startup/test/CI budgets, password cost,
   backend source/schema and offline payroll authority must remain unchanged.
   Application client changes require a demonstrated defect, as recorded below.
5. A clean source snapshot must run the unchanged full Playwright suite and produce
   fresh captured traffic. A prior workspace's output is not fresh-run evidence.

### Additional demonstrated input-focus defect, before its fix

The first cold candidate reaches all 78 browser cases: **77 pass / one fails**.
Its original MFA-disable request returns **400**, with **111 password characters
instead of 100** and an **empty code instead of 11 characters**. The UI snapshot
shows the recovery code appended to the password field. The backend correctly
refuses this malformed input; no factor bypass is demonstrated.

**Medium input-integrity/availability gap:** `public/js/lib/mfa.js` queues another
first-input focus 50 ms after `UI.modal` has synchronously set initial focus. That
timer can override a user who has moved to the code field. A deterministic test
using the real shared modal and MFA helper fails before the fix: after moving
focus to the code and advancing 60 ms, the password field has focus again.

Before changing that helper, add these rules: initial focus must remain inside
the modal, user focus movement must survive a later timer turn, and the submitted
password/code must retain their distinct intended values. Existing authentication,
session revocation and all browser assertions stay unchanged. Proposed minimal
resolution: remove the redundant deferred focus and reuse the shared modal's
existing initial-focus implementation. This is connected follow-up discovered by
the restored browser gate; no MFA authentication or recovery policy is redesigned.
[W3C modal focus guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

Retain the first complete unit run, failed cold browser run, screenshots and
authenticated trace. Publish only a length/status diagnostic extract of credential
input; keep the complete synthetic authenticated trace in the local work evidence.
Repeat full validation after this client change. Do not retry the unchanged suite
until it happens to pass or add a delay to hide focus movement.

## Demonstrated gap and resolution proposed before changes

**High verification/release-gate gap:** `tests/e2e/server.ts` starts an async
100 ms timer that writes `work/payroll-email-browser-wire.json`, but neither the
fixture nor its caller initializes that parent directory before startup. `work/`
is ignored and absent in a fresh checkout. The unchanged source, run from an
archived baseline snapshot with that directory absent, exits **1** with **ENOENT**
at the timer's `writeFileSync`, before any successful health observation. The
existing working directory had hidden this precondition during earlier passes.

The actual unchanged Playwright command is also run from that clean snapshot;
its original startup failure/results are retained separately from a direct-server
probe. This is a demonstrated local explanation of the startup failure class,
not yet proof of the missing remote stderr contents.

Proposed narrow fix: create the fixture's existing output directory recursively
before any timer/fixture work. Preserve existing contents and native failure on
a non-directory collision. Add actual-process startup controls for absent,
existing and non-directory output paths, retaining the pre-fix failures before
applying the fix. Do not pre-create the directory only in CI or change assertions.

## Primary sources and independent evidence

- [Node 24.22.1 filesystem API](https://nodejs.org/download/release/v24.22.1/docs/api/fs.html): `writeFileSync` does not create missing parent directories; recursive `mkdirSync` supports an existing directory and reports errors for an occupied non-directory path.
- [Node process errors](https://nodejs.org/download/release/v24.22.1/docs/api/process.html#event-unhandledrejection): the timer's uncaught rejected promise remains a failure; no rejection-suppression handler is proposed.
- [Playwright web server lifecycle](https://playwright.dev/docs/test-webserver): the server must become available before scenarios execute. A failed startup does not establish browser coverage.
- Baseline [GitHub run](https://github.com/Endercraft2017/Verdesakay-Inventory-System/actions/runs/40097014338): now complete. All **four Node jobs** and the secrets job pass; browser and dependency jobs fail. This independently verifies the previous adoption/runtime regression jobs' outcomes, not this new candidate.

The public browser log still redirects to a proxy-denied host (CONNECT 403).
The built-in reporter identifies web-server exit 1, but its annotations do not
contain the underlying filesystem error. No network-policy bypass is attempted.
The local clean snapshot links the unchanged installed dependency graph; this is
not represented as a fresh dependency installation or a matching remote OS.

## Implemented fix and demonstrated controls

The fixture now creates its existing `work` directory recursively before creating
temporary data or scheduling the SMTP recorder. That fixture's only change is the
statement and its explanatory comment. The later client fix removes the redundant
MFA focus timer and its unused modal-return binding. Neither changes backend
source, schema, dependencies, payroll permissions/authority, browser assertions,
retries or any existing test/CI budget. The shared modal still sets initial focus.

The real-process regression is **1 failed / 2 passed before**, then **3 passed** on
each actual current runtime, **22.23.4** and **24.22.1**. Its assertions and the
Playwright/Vitest configurations remain byte-identical after the pre-fix red run.
Controls observe real health JSON, continued process liveness, parseable capture
output and preservation of unrelated/occupied files. They do not assert that a
particular filesystem method was called. The occupied-file control remains an
explicit process failure, not a swallowed recording error.

The unchanged original Playwright command from the cold baseline snapshot exits 1,
with zero expected/passed browser cases and a global web-server startup error.
The retained stderr additionally contains native `ENOENT` for the capture path.
Those zero cases are not reclassified as 78 passing scenarios. There is no
whole-suite retry or pre-creation of output to obtain the candidate result.

The baseline reproduction snapshot contains the selected source/test/public paths
listed in its receipt. Because its failure precedes application serving, it does
not establish later static-asset behavior. The final candidate snapshot instead
archives **all tracked baseline files**, including website, console and legal
assets, then overlays only the fixture fix and new regression source. Its ignored
output directory is absent before the final browser command. Both snapshots link
the same unchanged installed dependencies; neither is called a fresh npm install.

## Retained evidence and classification

| Evidence | Establishes | Limits |
| --- | --- | --- |
| [Baseline CI run](evidence/browser-startup-baseline-ci-run.json), [jobs](evidence/browser-startup-baseline-ci-jobs.json) | Four Node jobs and secrets succeed; browser/dependencies fail on exact **873a820**. | Independent automation outcomes, not human review or candidate success. |
| [Retrieval attempts](evidence/browser-startup-ci-retrievals.json), [current network observation](evidence/browser-startup-network-status.json) | The actual log download redirects to a CONNECT-403 destination despite the current enforced policy snapshot. | Policy readiness is not a guarantee of access to every host. No signed redirect or secret values are published. |
| [Original fixture](evidence/browser-startup-fixture-before.txt), [direct process observation](evidence/browser-startup-direct-before.json), [stderr](evidence/browser-startup-before-direct-server.log.gz) | Source-level missing parent and real pre-health ENOENT failure in the archived baseline. | Synthetic local Linux data; no production-server availability claim. |
| [Original Playwright result](evidence/browser-startup-playwright-before.json), [command](evidence/browser-startup-playwright-before-run.json), [console](evidence/browser-startup-before-playwright.log.gz) | Actual configured browser command stops at startup with zero browser coverage. | Does not recover the inaccessible historical remote stderr. |
| [Pre-fix regression](evidence/browser-startup-startup-before.json), [frozen inputs](evidence/browser-startup-pre-fix-test-freeze.json), [after commands](evidence/browser-startup-focused-commands.json) | Absent-path regression fails before; three cases pass on each current runtime after. | Selected synthetic startup boundaries, not all possible disk/OS errors. |
| [Fixed fixture](evidence/browser-startup-fixture-after.txt), [regression source](evidence/browser-startup-regression-source.txt), [assertion integrity](evidence/browser-startup-assertion-integrity.json) | Implemented minimal fix and unchanged pre-fix assertions/configurations. | Code review still needs independent judgement. |
| [Baseline snapshot](evidence/browser-startup-baseline-snapshot.json), [candidate snapshot](evidence/browser-startup-candidate-snapshot.json), [input freeze](evidence/browser-startup-source-freeze.json) | Archive provenance, exact overlays and selected runtime/code/asset identity. | Linked dependency graph; no fresh install or matching CI OS claimed. |
| [Official FS API selection](evidence/browser-startup-node-fs-selected.json), [research provenance](evidence/browser-startup-primary-sources.json), [checkout clean default](evidence/browser-startup-checkout-clean-primary.json) | Parent-creation/collision rules and the documented clean-checkout expectation. | Current checkout-v4 documentation is not a recovered exact action-execution SHA. |
| [First cold browser JSON](evidence/browser-startup-first-cold-playwright.json), [console](evidence/browser-startup-first-cold-playwright.log.gz), [delivered input](evidence/browser-startup-mfa-delivered-inputs.json), [trace hash/local location](evidence/browser-startup-mfa-focus-evidence.json) | 77 pass/one failure; the exact entered code is appended to the password, the code is empty and the server returns 400. | Authenticated trace/screenshots remain local; public diagnostic contains lengths/status/comparison, not complete credential payloads. |
| [MFA helper before](evidence/browser-startup-mfa-before-source.txt), [after](evidence/browser-startup-mfa-after-source.txt), [deterministic red test](evidence/browser-startup-mfa-focus-before.json), [focused after](evidence/browser-startup-mfa-focus-after.json), [unchanged-test freeze](evidence/browser-startup-mfa-pre-fix-freeze.json) | Native DOM focus is stolen after a timer turn before; focus and separate password/code values remain correct after. Thirteen focused UI/API cases pass. | DOM timer test complements the real HTTP/browser evidence; it is not an independent human accessibility/security review. |

Both directory preparation and preservation of MFA input focus are **implemented**;
failure/recovery, the deterministic focus test and current-Node
startup controls are **locally demonstrated**. The previous commit's completed
unit job outcomes are **independently executed CI**, distinct from candidate
verification. Historical remote stderr, actual Windows/host/provider behavior and
independent human review remain **unverified**. Candidate CI is reported separately
against its new exact commit after publication.

## Recovery, failures and limits

[Browser audit startup recovery](../operations/browser-audit-startup.md) explains
the ignored output directory, collision preservation, clean-run checks and why a
second attempt can mask this defect after reporting creates the directory.
The pre-fix direct-server, real Playwright and permanent-regression failures are
all retained. They are expected failing reproductions, not successful coverage.
No assertion relaxation, rejection suppression, unrelated application repair,
schema change or dependency override is used to obtain a pass.

This is synthetic Linux verification. It does not test every write failure,
filesystem race, Windows installation or native Electron build; a broken output
path must still fail instead of manufacturing captured evidence. Captured SMTP
traffic does not establish provider delivery or exactly-once email behavior.
Manual keyboard/assistive-technology acceptance of the focus behavior remains
external; programmatic checks and W3C guidance do not establish conformance.
Broader dependency, native/host/restore/capacity, independent security/accounting
and historical release-control limitations remain open. Whole-control totals and
production release approval are unchanged.

## First fixture-only regression, superseded after the client focus fix

The first full `npm test` passes **330 files / 3,546 cases**, zero failed/pending, on actual
Node **24.22.1**: **2,155.86 seconds** Vitest / **2,157.674 seconds** process wrapper.
All **975 then-selected code/config/runtime-asset inputs** remain unchanged during
that run in both the working tree and initial full source snapshot. This selection additionally includes
website, console, native/launcher and public-policy assets consumed by the tests.
The subsequent cold browser run exposes the separate focus defect (77 pass/1 fail).
Its discovery requires another regression after changing the client; the first
passing unit result is not presented as validation of that later client code.

[First full JSON](evidence/browser-startup-first-full-tests.json),
[process receipt](evidence/browser-startup-first-full-run.json),
[complete console](evidence/browser-startup-first-full.log.gz) and
[input identities](evidence/browser-startup-first-source-freeze.json) retain the scope.
The root TypeScript check also passes; its command/runtime/exit result is recorded
with the [source/assertion comparison](evidence/browser-startup-assertion-integrity.json).

The first cold browser run is retained as **77 pass / one MFA failure**, not as a
passing release gate. The deterministic focus regression fails before the client
fix; after it, **four focused files / thirteen cases pass**, covering the actual
shared modal and existing MFA API policy. All original browser specs and both
runner configurations remain byte-identical. Final validation repeats against the
new client source and separately frozen **976 inputs**, using a new full snapshot
with no ignored output. The first snapshot/run remain intact. This repeat is
required by the demonstrated defect and changed source, not a retry of an unchanged
failing candidate.

## Final regression after both fixes

The final `npm test` passes **331 files / 3,547 cases**, zero failed/pending, on
actual Node **24.22.1**: **2,115.86 seconds** Vitest / **2,116.750 seconds** wrapper.
All **976 selected inputs** remain unchanged in the working tree and the new
full source snapshot. The original failed-run artifacts remain separate.

[Final full JSON](evidence/browser-startup-full-tests.json),
[process receipt](evidence/browser-startup-full-run.json),
[complete console](evidence/browser-startup-full.log.gz),
[input freeze](evidence/browser-startup-source-freeze.json),
[final snapshot overlays](evidence/browser-startup-final-candidate-snapshot.json)
and [explicit final TypeScript result](evidence/browser-startup-typecheck-final.json)
identify the final source, not the earlier fixture-only candidate.

The final fresh-snapshot Playwright run passes **all 78 cases**, with **zero
unexpected, flaky, skipped or global errors**, in **274.275 seconds**. It starts
without `work/`, uses actual Node 24.22.1 and the installed Playwright-managed browser
with CI/GitHub flags and no browser override. Both fixes are present in that new
snapshot, with all 976 frozen inputs unchanged. The original MFA disable/revocation
assertions pass; they were not rewritten to accept the malformed request.

[Final browser JSON](evidence/browser-startup-clean-playwright.json),
[process/fresh-directory receipt](evidence/browser-startup-clean-playwright-run.json),
[complete console](evidence/browser-startup-clean-playwright.log.gz),
[fresh TLS SMTP capture](evidence/browser-startup-clean-smtp-wire.json) and
[machine verification](evidence/browser-startup-verification.json) retain the result.
All seven payslip email scenarios pass. Three captured submissions include one
each for ordinary release, lost response and uncertain SMTP outcome; these do not
establish real provider delivery or exactly-once guarantees.

Publication requires a changed-content secret scan with compressed logs explicitly
expanded, a finished-index scan covering final metadata and the mandatory hook.
[Scan receipt](evidence/browser-startup-secret-scans.json) and
[artifact hashes](evidence/browser-startup-artifact-hashes.json) retain the bundle
scope. These scans do not close historical-secret findings. The candidate's exact
remote CI/browser outcome is observed after publication and kept separately from
the local proof; no local pass is called independent CI success.

The completed content scan reports **zero findings across 83 then-current changed
files**, including **13 explicitly expanded compressed logs**, with unchanged
Gitleaks 8.24.3 defaults. Its receipt/log and final hashes are subsequently covered
by the finished-index scan and mandatory hook too.
