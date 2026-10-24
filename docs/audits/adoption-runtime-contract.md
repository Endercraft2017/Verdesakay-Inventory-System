# Offline adoption: current-Node copy compatibility

Started 24 October 2026 (Manila), baseline production
`b451ce66d522c249431b2df21fd95766b5bcfc13`. This increment investigates the
demonstrated original-company adoption failure on supported Node 24.22.1.
It does not certify a live cutover or change the historical release scorecard.

## Requirements and boundaries recorded before implementation

The existing offline-adoption requirements come from
`src/platform/adopt-default.ts`, its two existing test files and
[the cutover procedure](../VERDESAKAY-TENANT-CUTOVER.md). All server/worker writers
must already be stopped; `--server-stopped` asserts that prerequisite, it does not
enforce it. Only synthetic local data is used here. The historical cutover record
is a lead, not newly verified evidence about the current deployment.

States: preview/validation → recovery snapshots → verified recovery upload copy
→ exclusive destination-directory claim → destination copies → byte/hash verification
→ catalog transaction/registration. A failure before registration leaves the source
and recovery/partial destination for investigation; it is not a successful adoption.
Catalog/tenant databases and filesystem copies do not form one transaction.

Trust boundaries: operator assertion of stopped writers; source SQLite/WAL and
upload tree; private recovery directory; initially unoccupied destination; catalog
publication. Existing manifest exclusions for other tenants and symlink refusal
remain required. Uncooperative concurrent filesystem mutation is not made safe by
an offline migration flag.

Testable rules:

1. On every declared supported runtime, an ordinary quiescent adoption copies
   the existing users/password hashes/business rows and nested upload bytes, then
   registers exactly the intended tenant. Source bytes remain unchanged.
2. The destination directory is claimed exclusively. A preexisting or competing
   destination must be refused without overwriting or deleting its contents.
3. Individual destination files must not be overwritten, including a file which
   appears after directory claim. Copy/verification failure must not publish a
   catalog row or discard recovery material.
4. Other registered tenants' upload trees remain excluded. Existing symlink,
   integrity, manifest and destination verification must not be weakened.
5. Existing assertions, test budgets, runtime admission and offline payroll
   authority remain unchanged. Successful local experiments are distinguished
   from the next exact-commit CI results and real Windows/host acceptance.

## Demonstrated gap and proposed resolution

**High availability / cutover blocker:** current-commit CI's Node 24.22.1 job
reports `ERR_FS_CP_EEXIST` at `adopt-default.ts:82`. The unchanged two-file suite
locally reproduces **2 failed / 1 passed** on the actual 24.22.1 binary. The helper
first exclusively creates `targetUploads`, then calls recursive `cpSync` with
`errorOnExist: true, force: false` on that already existing directory. The tagged
Node 24.22.1 implementation now checks this combination for directories too;
24.19.0's implementation did not. This is demonstrated application dependence
on earlier directory-copy behavior, not evidence that the new runtime is unsupported.

Failure scenario: snapshots and backup uploads are created, the empty target
directory is claimed, copy throws before target DB copy/registration. Retrying
blindly is blocked by the retained directory. The original source is not shown
to be corrupted by this failure.

Proposed authorized fix: retain the exclusive root-directory claim and copy each
verified manifest file into it using `COPYFILE_EXCL`, with recursive parent creation.
Keep all existing source/destination checks and verification. Reproduce and retain
the failure first; add destination-claim/file-collision and interrupted-copy controls,
then run the original assertions on actual current/floor runtimes. Do not relax
`force`, collision refusal, expected assertions, timeouts or runtime policy.

Primary sources:

- [Node 24.22.1 filesystem API](https://nodejs.org/download/release/v24.22.1/docs/api/fs.html#fscpsyncsrc-dest-options): `errorOnExist` throws with `force: false` on an existing destination; `COPYFILE_EXCL` refuses an existing destination file.
- [Tagged current implementation](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/fs/cp/cp-sync.js#L135) and [24.19.0 comparison](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/fs/cp/cp-sync.js#L135).
- [Current CI run](https://github.com/Endercraft2017/Verdesakay-Inventory-System/actions/runs/40086250363): three Node jobs and secrets succeed; Node 24.22.1, browser and dependency jobs fail.

## Separate, unresolved CI evidence

The same commit's browser job fails at `npm run test:e2e` after about eleven seconds.
Its annotations only report exit 1. Public log/artifact API downloads redirect
to proxy-denied hosts (CONNECT 403); no bypass is attempted. Neither the Node
adoption error nor OS/action notices establish the browser failure's cause.
Browser checks are not removed, weakened or declared fixed by this adoption change.

Before any reporting change: a disposable Playwright web-server fixture exits 17
without running tests. The existing reporters retain a failing process result but
emit no `::error` GitHub annotation. Proposed diagnostic-only change: add Playwright's
documented built-in `github` reporter when `GITHUB_ACTIONS=true`, preserving existing
list/HTML/JSON reporters, assertions, retries and deadlines. The same deliberate
startup failure must still exit 1 and additionally expose its error annotation.
That is an observability improvement, not a fix for the inaccessible historical
browser error. [Primary reporter documentation](https://playwright.dev/docs/test-reporters#github-actions-annotations).
For a failed web-server process the annotation may only identify startup and its
exit code; detailed stderr can still require log access. It does not reconstruct
the original missing browser log.

## Implemented behavior and targeted results

The small copy loop retains the original exclusive directory claim, copies the
already verified recovery manifest into that directory with `COPYFILE_EXCL`, and
leaves database copy, byte/hash checks and catalog transaction untouched. Existing
registered companies do not run this adoption procedure during ordinary requests.
No business schema, dependency, runtime policy, payroll revision, HTTP endpoint or
offline authority rule changes. The separate reporter change only adds diagnostics
in GitHub Actions.

The original three test cases pass after the fix on actual Node **22.22.0,
22.23.4, 24.19.0 and 24.22.1**; three additional fault/collision tests also pass
on each version (**six cases per version**). Original test files and Vitest
configuration remain byte-identical. The new tests verify actual competing file
contents, source bytes, absence of tenant/target DB, intact recovery snapshots and
refusal of retry after partial output; accepting any unrelated error is not enough.

An unchanged disposable source/SQLite/filesystem probe separately shows 24.22.1
before: `ERR_FS_CP_EEXIST`, no tenant/target DB, empty claimed upload directory,
intact original and recovery. After: successful registration, target copy and
intact original. Actual 22.23.4 and 24.19.0 are successful controls before/after.
These are synthetic databases, not historical customer data.

Two independent process experiments on both current runtime families deepen the
copy boundary evidence:

- Both processes pause immediately before exclusive directory claim. Released
  together, one succeeds and one receives native `EEXIST` from `mkdir`. SQL reads
  find one active tenant; target integrity, existing user/hash/record and upload
  hashes match; both recovery snapshots remain. The barrier is a test-only worker
  around the real filesystem operation, not product locking or a new CLI mode.
- A process pauses before copying the second destination file and receives actual
  `SIGKILL`. SQL reads find no registered tenant/target DB, the first file remains,
  source hashes and recovery integrity/uploads match. A new CLI/helper process
  refuses the partial destination. This demonstrates one crash point, not all
  publication stages or power-loss durability.

An independent Python SQLite connection additionally keeps a committed, nonempty
WAL present with autocheckpoint disabled and no open transaction/writes during
adoption. On both current runtime families the target contains the existing
user/hash and history stored in that WAL, target integrity is `ok`, and recovery
snapshot/target DB bytes match. Source main-file and WAL hashes/length remain
unchanged. This checks one synthetic WAL fixture, not every historical WAL state;
SHM read-mark bytes and filesystem metadata are not claimed identical.

The unchanged Playwright startup-failure fixture still exits 1 for a child exit 17;
after the reporter addition it emits an explicit `::error` annotation. Retaining
a failing result is required; the fixture is never counted as a passing app case.

## Failed experiments and assertion integrity

- The first new collision-control run used shared synthetic partial destinations.
  Isolation cleanup was added before the final pre-fix red run; original product
  and existing tests were unchanged. Both runs retain two failures / one pass.
- Root typecheck initially rejects the new test's `added[0]` under
  `noUncheckedIndexedAccess`. Adding `!` after the unchanged `toHaveLength(1)`
  assertion fixes the type. TypeScript-emitted JavaScript is byte-identical before
  and after, recorded separately; no runtime assertion changes.
- Initial diagnostic config used `defineConfig(base, overrides)`, which appends
  web servers. It started the original command from the fixture directory and
  failed module resolution before the intended exit-17 control. Original config,
  log and receipt remain. A single spread-config override fixes only that fixture;
  the corrected before/after control is the evidence for annotation behavior.
- The first real claim experiment's checker wrongly excluded the words
  `already exists`, although native `mkdir`'s expected `EEXIST` includes them.
  Original script/results remain, classified as failed checks. The correction
  requires parsed `event=error`, `code=EEXIST` and `mkdir`, retaining one-winner
  and all database/hash requirements. Only the failed claim cases are repeated;
  the successful SIGKILL cases are retained from their original run.
- A separate command-line Playwright-config typecheck initially hits TypeScript 6's
  `TS5112` requirement to specify `--ignoreConfig` with explicit file inputs. The
  initial diagnostic is retained; ordinary root typecheck and the explicit config
  check are reported separately.

None of these fixture/checker corrections explains or closes the historical browser
CI failure. The completed regression and retained evidence are recorded below.

## Retained evidence and claim classification

| Evidence | Establishes | Limits |
| --- | --- | --- |
| [Pinned original CI](evidence/adoption-runtime-baseline-ci-run.json), [jobs](evidence/adoption-runtime-baseline-ci-jobs.json), [Node annotations](evidence/adoption-runtime-baseline-node24-annotations.json) | Independently executed **baseline** job outcomes and exact adoption error locations. | Does not establish candidate CI success or independent human review. |
| [Log/artifact retrievals](evidence/adoption-runtime-ci-download-attempts.json), [browser annotations](evidence/adoption-runtime-baseline-browser-annotations.json) | Download failures through the inherited proxy and the available public diagnostics. | No raw browser failure log/trace was obtained; exit 1 is not a cause. Signed redirect URLs are not retained. |
| [Official API selection](evidence/adoption-runtime-node-fs-selected.json), [24.19 source](evidence/adoption-runtime-node24-prior-cp-source.txt), [24.22 source](evidence/adoption-runtime-node24-current-cp-source.txt), [retrieval hashes](evidence/adoption-runtime-primary-retrievals.json) | Primary-source copy/collision semantics and the tagged directory-existence check difference. | Selected API entries retain their original fields; whole-page retrieval hashes are provenance, not signatures. |
| [Unchanged original tests before](evidence/adoption-runtime-original-tests-before.json), [process log](evidence/adoption-runtime-before-adoption.log.gz), [integrity](evidence/adoption-runtime-original-assertion-integrity.json) | Two real original failures / one pass before; original assertions/configuration remain unchanged. | Linux synthetic inputs; no production data-loss assertion. |
| [Controls before](evidence/adoption-runtime-controls-before.json), [focused commands/results](evidence/adoption-runtime-focused-commands.json), [new-test type correction](evidence/adoption-runtime-new-test-type-correction.json) | Six focused cases pass on four actual runtime versions; new test type correction emits identical JavaScript. | Fault injection covers chosen filesystem operations, not arbitrary faults. |
| [Original source](evidence/adoption-runtime-source-before.txt), [fixed source](evidence/adoption-runtime-source-after.txt), [probe source](evidence/adoption-runtime-probe-source.txt), [before observations](evidence/adoption-runtime-probe-before-24.22.1.json), [after observations](evidence/adoption-runtime-probe-after-24.22.1.json) | Implemented narrow fix and independently inspected SQLite/filesystem before/after effects. | Same local lab and synthetic fixtures, not independent human verification. |
| [24.22 process race](evidence/adoption-runtime-process-claim-24.22.1.json), [22.23 process race](evidence/adoption-runtime-process-claim-22.23.4.json), [worker](evidence/adoption-runtime-process-worker-source.txt), [controller](evidence/adoption-runtime-process-controller-source.txt) | One winner, native collision loser, one catalog row, matching target/source/recovery observations. | Cooperating process barrier at one boundary; source writers remain stopped. |
| [24.22 SIGKILL/restart](evidence/adoption-runtime-process-copy-24.22.1.json), [22.23 SIGKILL/restart](evidence/adoption-runtime-process-copy-22.23.4.json) | Actual process death leaves source/recovery intact and an unpublished partial destination; restart refuses it. | One crash point; no machine/power/storage-failure guarantee. |
| [24.22 WAL](evidence/adoption-runtime-wal-24.22.1.json), [22.23 WAL](evidence/adoption-runtime-wal-22.23.4.json), [controller](evidence/adoption-runtime-wal-controller-source.txt) | Target includes committed WAL history, snapshot bytes match, main/WAL bytes unchanged. | One committed WAL fixture per runtime; no SHM-byte/metadata preservation claim. |
| [Reporter before](evidence/adoption-runtime-reporter-before.json), [after](evidence/adoption-runtime-reporter-after.json), [after console](evidence/adoption-runtime-after-reporter.log.gz) | Implemented/local failure annotation improvement without changing exit status. | Future annotations are not the inaccessible historical error. |

Full current-Node `npm test` is complete: **329 files / 3,543 tests pass**, zero
failed/pending, Node **24.22.1**. Vitest reports **1,957.69 seconds**; the process
wrapper reports **1,958.518 seconds**. All **889 selected code/test/config/package
inputs stay unchanged**. No whole-suite retry, assertion relaxation, test budget
or CI timeout change is used. [Full JSON](evidence/adoption-runtime-full-tests.json),
[process receipt](evidence/adoption-runtime-full-run.json),
[complete console](evidence/adoption-runtime-full.log.gz),
[source freeze](evidence/adoption-runtime-source-freeze.json).

All **78 Playwright cases** pass on both installed Chromium builds: system
**151.0.7922.173** (**323.044 seconds**) and Playwright-managed **156.0.8078.4 /
revision 1248** (**280.209 seconds**). Both use actual Node 24.22.1, `CI=true` and
`GITHUB_ACTIONS=true`, zero unexpected/flaky/skipped cases and zero global errors.
The second run addresses a concrete difference from GitHub's configured browser
selection; it is not an automatic retry of a failing local test. These are **78
distinct cases exercised twice**, not 156 distinct cases. Managed build selection
matching does not reproduce or explain the original remote failure, and the remote
runner/OS still differs from this local Debian lab.

[System-browser JSON](evidence/adoption-runtime-playwright.json),
[process receipt](evidence/adoption-runtime-playwright-run.json),
[managed-browser JSON](evidence/adoption-runtime-bundled-playwright.json),
[process receipt](evidence/adoption-runtime-bundled-playwright-run.json) and
[actual binary/version observations](evidence/adoption-runtime-browser-builds.json)
retain the distinction. Both complete console logs are retained, including built-in
GitHub summary annotations. Both preserve the same 889 frozen inputs.

The seven payslip email scenarios pass in each run. Each fresh TLS SMTP capture
records three submissions, one each for the ordinary, lost-response and uncertain
outcome fixtures. The capture is **not** delivery confirmation or an exactly-once
guarantee. [System capture](evidence/adoption-runtime-system-browser-smtp-wire.json),
[managed capture](evidence/adoption-runtime-bundled-browser-smtp-wire.json),
[separation of previous-run files](evidence/adoption-runtime-preexisting-captures-quarantined.json)
and [machine verification](evidence/adoption-runtime-verification.json) retain source,
count and freshness checks. Previous traffic is preserved separately before fresh
runs; one run's capture is not presented as another's.

Root TypeScript and the separately explicit Playwright-config typecheck pass.
[Commands/results](evidence/adoption-runtime-typechecks.json) distinguish the
two checks and initial diagnostics. Publication requires final secret scans of
source/docs/evidence with compressed logs explicitly expanded, then the finished
index and mandatory commit hook. [Scan receipt](evidence/adoption-runtime-secret-scans.json)
and [artifact hashes](evidence/adoption-runtime-artifact-hashes.json) accompany the
bundle; these do not close historical findings or replace independent review.
The completed content scan returns zero findings across **102 then-current changed
files**, including **19 explicitly expanded compressed logs**, with unchanged
Gitleaks 8.24.3 defaults. Its receipt/log and final hash metadata are added afterward
and must be covered by the finished-index scan and mandatory hook too.

The fix is **implemented** and its targeted behavior **locally demonstrated**.
The baseline CI job outcomes are independently executed automation observed via
GitHub, not an independent review of the requirements or candidate implementation.
Actual-host/Windows behavior, candidate CI outcome at publication, historical
browser root cause and independent migration/security review remain **unverified**
unless a later exact-commit result explicitly establishes them. Failed experiment
artifacts remain named `initial-*` and are not counted as passing product evidence.

## Recovery and remaining limits

[Adoption copy recovery](../operations/adoption-copy-recovery.md) distinguishes
incomplete copy from registered tenant, preserves sources/backups/partial output,
and requires manual ownership/integrity review before any quarantine and fresh
attempt. Nothing automatically resumes, overwrites or deletes a partial migration.
The already completed historical cutover must not be repeated because of this patch.

Implemented/local demonstration does not establish Windows/native acceptance,
actual-host mount/ACL behavior, sufficient disk capacity, arbitrary crash-point or
power-loss durability, or safety with malicious/uncooperative filesystem writers.
Node explicitly does not guarantee atomic file copy. Empty directories and full
filesystem metadata are not represented by the existing file manifest. Real stopped
writers, preserved WAL/SHM/backups, known-record validation and independent migration
review remain necessary. The separately failing browser CI and dependency findings
remain release blockers; no whole-app production approval is claimed.
