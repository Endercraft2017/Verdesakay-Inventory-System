# Runtime admission contract — 24 October 2026

Starting production/remote baseline: **e077a494547a35e0919711c8739bc46d874d03f4**.
This follows the dependency increment; its runtime node-forge, Electron/fast-uri,
quoted-mailbox and broader release holds remain open. Scope is runtime compatibility/admission,
not new payroll behavior or native deployment approval.

## Rules established before implementation

Process lifecycle: unqualified runtime → refused; version-qualified runtime → private in-memory
SQLite capability probe → refused or admitted → application database initialization → serving
requests/background/maintenance work. Refusal must happen before creating/opening user database,
backup, upload or startup-lock paths and before binding HTTP. It must identify an actionable
runtime error, not leave partially initialized files after an unrelated SQL error. No environment,
test-mode or CLI bypass is planned.

The runtime/SQLite boundary supplies transaction-state, full-text-search and session APIs that
business code trusts. Check actual behavior in private memory: transaction state false→true→false,
FTS5 query availability and the changeset session API. Never infer a closed transaction from an
absent property. The admission check must not operate on a tenant/catalog connection or alter its
recorder. Existing payroll/sync SQL, triggers, source authority, saved data and command recovery
semantics remain unchanged.

Supported compatibility floors will be Node **22.22.0 within 22.x** and **24.19.0 within 24.x**,
matching the already-tested minimum versions. These are compatibility floors, not a claim that
older patches remain secure indefinitely. Recommend/pin the official current maintained patches
observed today: **22.23.4** and **24.22.1**. CI should cover floors and current patches. EOL odd
majors and unqualified future majors/prereleases must not silently inherit support. The locked
Electron 44.5.1 release record identifies bundled Node **24.21.0**, above the proposed floor;
that metadata is not a test of an installed Windows binary or a disposition of its advisory.

Install metadata must agree with the executable guard. Ordinary npm installs must refuse an
unsupported runtime; an install-option override must not bypass executable startup checks.
Failures and positive controls must use the same production entry points. Check synthetic
existing-file hashes and directory inventories after refused startup, plus actual database,
payroll, synchronization and browser regression on admitted runtimes.

## Demonstrated gaps before fixes

| Finding | Severity / observed scenario | Proposed resolution / limit |
|---|---|---|
| `engines.node >=22.13` advertises an unusable minimum | High availability gap. The unchanged offline-payroll integration test on official Node 22.13 fails during setup: `no such module: fts5`; its payroll assertions are not executed. | Explicit tested ranges and capability admission before any application data paths. This failed setup is not evidence that payroll assertions passed/failed. |
| Transaction guards trust an unavailable property | High latent correctness gap on the declared runtime. An isolated call to actual `withoutReplicating` executes inside an open transaction on 22.13. After a real `preparePayrollReplay` marker trigger abort, that runtime leaves its transaction open with one uncommitted inbox row and zero markers; supported Node 24.19 rolls back to zero rows. | Refuse unsupported runtime before importing/using app DB services; retain the existing transaction algorithms. The old full app already fails earlier at FTS5. No reachable end-to-end committed financial corruption is claimed. |
| No explicit early runtime admission / broad future support | Medium. Manifest permits unsupported odd/future versions; startup currently reaches data initialization before a missing-capability error. | Tested major-specific ranges, normal strict npm engine enforcement and independent executable checks; retained file/HTTP-boundary experiments. |
| Current pins lag primary release records | Medium maintenance gap. Existing CI/pin uses 22.22.0/24.19.0; official index on 24 October lists 22.23.4/24.22.1. | Keep minimum checks and add current maintained patches; update recommended standalone pin after verification. No claim that changing a file updates a live host or embedded Electron. |

The first isolated marker-fault fixture used a null allocation plan, hitting its NOT NULL
constraint before the intended trigger. Both original outputs are retained as an invalid fixture
for that trigger scenario. After supplying the required `[]`, the intended marker trigger fires
on both runtimes and demonstrates the rollback difference. Explicit manual rollback clears the
uncommitted row in the disposable old-runtime fixture. No real company databases or external
services are used.

## Primary evidence / requirements

- [Node SQLite API](https://nodejs.org/api/sqlite.html#databaseistransaction): added v22.16.0 / v24.0.0; wraps SQLite autocommit state.
- [Node TLS API](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts): the existing SMTP test peer additionally needs the API introduced v22.19.0 / v24.5.0.
- [Official release index](https://nodejs.org/dist/index.json) and [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json): current maintained patches, EOL odd majors, Node 26 LTS qualification still future at this cutoff.
- [Official Electron release metadata](https://releases.electronjs.org/releases.json): exact locked embedded Node version; not installed-binary verification.

## Implemented admission, not a backport to the unsafe runtime

`shared/runtime-support.ts` reads the engine policy from the shipped package metadata, accepts
only its explicit caret ranges, and refuses missing/malformed policies or unqualified versions.
It then probes a private `:memory:` connection for transaction state false→true→false, an actual
FTS5 query and nonempty session changeset capture. It checks changeset application API availability;
this is not a comprehensive native-library certification. No application connection, sync recorder
or process-global TLS configuration is used by the probe.

Admission runs at the server entry and shared database/initialization module boundary. Tenant,
catalog and maintenance entry points therefore encounter it before business paths. `.npmrc`
enforces ordinary install engines independently; `npm run runtime:check` gives the operator a
data-free preflight. The engine ranges are `^22.22.0 || ^24.19.0`, and `.node-version` recommends
24.22.1. CI definitions retain both floors and add current 22.23.4/24.22.1; the Windows build-host
Node pin is updated too. Embedded Electron is unchanged and remains separately held. No payroll,
authority, command, ledger, trigger, schema, migration, password-work cost or existing assertion
changes are made. In particular, unsafe 22.13 is **refused**, not made financially compatible.

## Reproduction chain and evidence

| Evidence | What it establishes | Limit |
|---|---|---|
| [Official API/release summary](evidence/runtime-support-primary-summary.json), [new downloads/checksums](evidence/runtime-support-downloads.json), [embedded version metadata](evidence/runtime-support-electron-runtime-records.json) | API introduction, selected current/floor versions and exact Electron metadata. | Same-channel official checksum verification is not a maintainer-signature or installed-Windows-binary verification. |
| [Original payroll setup result](evidence/runtime-support-old-payroll-setup.json) | On real 22.13, setup fails `no such module: fts5`; no payroll assertions execute. | Eight pending tests are not eight assertion failures or passes. |
| [Original transaction observations](evidence/runtime-support-old-transaction.json), [supported control](evidence/runtime-support-transaction-control.json), [driver](evidence/runtime-support-transaction-driver.txt) | Actual production functions violate housekeeping refusal and leave an open transaction/uncommitted inbox after a marker abort on 22.13; control rolls back. | Isolated real SQLite technical schema/functions; old full-app setup fails earlier. No committed financial corruption demonstrated. Execute the driver against baseline source in a disposable checkout; current admission intentionally refuses 22.13. |
| [Real baseline process/file observations](evidence/runtime-support-real-before.json), [real post-fix observations](evidence/runtime-support-real-after.json) | Exact archived e077a49 source on 22.13 creates app files at all four entry points; fixed source refuses all four with zero files, and still refuses when an inconsistent version label claims support. | Existing locked library versions are linked into the archive; no installed customer data or remote host involved. Version-label intervention is explicit, not a spoofable HTTP option. |
| [Original admission suite](evidence/runtime-support-admission-before-tests.json), [first candidate](evidence/runtime-support-admission-first-after-tests.json), [unchanged driver hashes](evidence/runtime-support-permanent-test-hashes.json) | Ten failing version-policy/admission cases plus one positive control become eleven passes; refused cases preserve synthetic existing file inventories/hashes and never reach the HTTP tripwire. | These policy cases simulate version identities on a supported binary. The separate real 22.13 experiments establish native behavior. |
| [Syscall observations](evidence/runtime-support-syscalls.json), [before trace](evidence/runtime-support-old-before-syscalls.log.gz), [refused trace](evidence/runtime-support-old-after-syscalls.log.gz), [supported trace](evidence/runtime-support-supported-control-syscalls.log.gz) | `strace -f` independently observes 37 application-data path operations before, zero after unsupported refusal; the supported control exits 0 and observes 45 path operations. | Traced tenant entry on this Linux environment; not all filesystems, native launchers or installed binaries. |
| [npm oracle](evidence/runtime-support-npm-engine-comparison.json) | Ordinary offline install using actual original engine policy accepts 22.13; actual new policy/config refuses with EBADENGINE. | Minimal package fixture carries the exact engine/config fields; not a second full app install on unsafe Node. |
| [Positive runtime/install checks](evidence/runtime-support-runtime-positive-checks.json), [current 22 focused run](evidence/runtime-support-current22-focused.json), [current 24 focused run](evidence/runtime-support-current24-focused.json), [commands](evidence/runtime-support-current-focused-commands.json) | Required features and strict engine dry-runs pass at 22.22 and both maintained patches; 41 actual admission/payroll/replay/startup tests pass on each current patch. | These are targeted current-patch results; the complete local suite uses the 22.22 floor. |
| [TypeScript](evidence/runtime-support-typecheck.json), [888-input freeze](evidence/runtime-support-source-freeze.json) | Configured typecheck passes on 24.22.1; source/test/config/package inputs frozen for final regression. | Passing types alone did not detect the original native-API compatibility defect. |

The policy tests use throwaway SQLite files containing a sentinel, record content hashes and
directory inventories, and install an HTTP-listen tripwire only in the disposable child. The
guard's error code must be correct; an unrelated startup failure is not accepted as a pass.
The positive control must initialize normally. Original eleven-case test/worker bytes remain
unchanged through final verification. Real old-runtime tests additionally use unmodified version
identity, plus a separately labelled supported-version identity to exercise native capability
refusal. The source contains no test-mode admission bypass.

## Independent automation and contradictory browser evidence

[Baseline GitHub run](https://github.com/Endercraft2017/Verdesakay-Inventory-System/actions/runs/40078722255)
for **e077a49** is completed with an overall **failure**.
[Run metadata](evidence/runtime-support-baseline-ci.json) and
[job/step metadata](evidence/runtime-support-baseline-ci-jobs.json) show both Node 22.22 and
24.19 test jobs succeeded, secrets job succeeded, dependency scan failed and browser job failed
at `npm run test:e2e`. This independently confirms command outcomes on the **baseline**, not
this new runtime-admission candidate. Exact remote test counts/log content were not available.
The source's 30-minute CI test-job cap is unchanged; those observed baseline test jobs finish
within it. Local elapsed time is not used to infer a GitHub timeout or to change its budget.

The browser failure contradicts a blanket claim that local browser passes establish CI success.
Its detailed log redirects to a destination denied by the proxy (HTTP 403); no bypass is attempted.
[Available check annotations](evidence/runtime-support-baseline-browser-ci-annotations.json)
report only exit 1, action-runtime deprecation and Ubuntu-label migration notices. Those notices
are **not established causes**. Browser CI diagnosis is separate proposed engineering work;
do not change assertions, blame a runtime/OS notice or close the gate without the actual failure.
The updated current-Node pin is not claimed to repair that unknown failure. A new post-push CI
run, if observed, must be reported against its exact new commit separately.

## Failed experiments and evidence limits

- Initial marker fixture: null allocation plan hits a NOT NULL error before its intended trigger.
  [Original invalid driver](evidence/runtime-support-initial-invalid-command-driver.txt) and
  [old output](evidence/runtime-support-initial-transaction-node2213-before.json) /
  [control output](evidence/runtime-support-initial-transaction-node24-control.json) are retained;
  only the corrected `[]` fixture supplies the marker-trigger comparison.
- First syscall experiment's positive control exits 1. Its detailed trace is accidentally
  overwritten during diagnosis; its original exit/path-operation counts remain in the tool
  result and [explicit limitation record](evidence/runtime-support-failed-experiment-limits.json).
  That missing first trace is an evidence gap, not a successful control.
- A repeat with the same incomplete fixture [records](evidence/runtime-support-initial-trace-control.json)
  refusal for a missing synthetic bootstrap password; its
  [raw repeat trace](evidence/runtime-support-repeated-invalid-control-syscalls.log.gz) is retained.
  Adding the existing `VDS_TEST_ADMIN_PASSWORD` fixture to all three trace cases produces the
  final successful positive control. The original failures are not counted as passing evidence.
- GitHub browser log retrieval is denied at its redirect host. Metadata/annotations are retained,
  but the detailed reason is still unverified. No automatic approval rejection or owner action
  is inferred from this proxy error; local work continues.

## Verification, recovery and remaining uncertainty

The runtime/version declaration and executable admission are **implemented**. Results above are
**locally demonstrated**. `strace`, npm and native SQLite provide independent mechanisms within
the local lab; they are not an independent human review. External CI job outcomes are verified
only for baseline e077a49. No independent security/accounting/native-deployment approval is
claimed for the candidate.

Complete minimum-runtime `npm test` passes **328 files / 3,540 tests**, zero failed/pending, on
Node **22.22.0**: **2,036.83 seconds** Vitest / **2,037.652 seconds** wrapper. All **888 selected
source/test/config/package inputs remain unchanged**. Current Node **24.22.1** Playwright passes
**78 cases**, zero unexpected/flaky/skipped, **377.181 seconds** wrapper, with the same 888 inputs
unchanged. TypeScript passes on 24.22.1; each current Node patch's 41-case focused run also passes.
No full-suite retry, test timeout adjustment, assertion relaxation or hashing-cost reduction is
used. CI job budgets are unchanged.

Retained final runs: [full JSON](evidence/runtime-support-full-tests.json),
[full process/integrity receipt](evidence/runtime-support-full-run.json),
[complete full-suite console log](evidence/runtime-support-full-tests.log.gz),
[Playwright JSON](evidence/runtime-support-playwright.json),
[browser process/integrity receipt](evidence/runtime-support-playwright-run.json),
[actual browser-driven SMTP messages](evidence/runtime-support-browser-smtp-wire.json).
The old declarations/guard admission defect is resolved for the specified entry points and
qualified versions. Historical corruption is not claimed fixed or disproved.

Fresh dependency scans still exit **1**: runtime **1 high** (node-forge), complete root
**2 high / 1 moderate** (node-forge, Electron, fast-uri). No library package version changed;
only the lockfile's root engine metadata changes. This increment receives no package-advisory
remediation or withdrawal credit. [Runtime scan](evidence/runtime-support-npm-runtime.json),
[complete-root scan](evidence/runtime-support-npm-root.json).

Gitleaks **8.24.3**, unchanged default rules, passes staged and exact exported-content checks,
**zero findings**, with all **13 compressed logs expanded** for scanning. No allowlist or detection
suppression is added. The receipt identifies its exact index snapshot; final publication metadata
is also subject to the staged scan and mandatory commit hook. This does not close historical
secret findings. [Secret receipt](evidence/runtime-support-secret-scans.json),
[verification](evidence/runtime-support-verification.json),
[artifact SHA-256 manifest](evidence/runtime-support-artifact-hashes.json).
Remote commit verification is performed after push; a branch push does not establish deployment.
Recovery is in
[runtime support](../operations/runtime-support.md). No real legacy/company data were inspected
or repaired; committed historical effects of unsafe environments remain unproven. Native launcher
prework and actual Windows/Electron capabilities, host runtime selection, later Node release
support, production latency/capacity, independent review, the known dependency/quoted-mailbox
findings and the browser CI failure remain open. Historical whole-control totals stay unchanged.

Additional primary references read for this contract:
[npm engine-strict](https://docs.npmjs.com/cli/v11/using-npm/config#engine-strict),
[SQLite autocommit state](https://www.sqlite.org/c3ref/get_autocommit.html),
[SQLite FTS5](https://www.sqlite.org/fts5.html). Full raw retrieved pages/API records stay in
ignored local work; selected primary records and original process observations above are retained
with the code. No private DBs, bootstrap material, binaries or authenticated browser traces are
published.
