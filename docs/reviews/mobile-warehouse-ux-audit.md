# Mobile warehouse UX audit

2026-10-23 · restructure/module-architecture · original browser assets:
45d0201 · initial candidate v143; task-measurement follow-up v144; kit workspace v145.

## Kit workspace follow-up — 2026-10-24

The kit prototype's reviewed behavior is now implemented in the actual mobile
workflow. Each component has bounded cumulative − / + controls and direct entry.
Its saved count and remaining requirement stay separate from source on-hand,
stock held elsewhere and availability to this kit. Unsaved edits are labelled.
Partial saves persist on the backend and restore on reload; the final kit release
remains all-or-nothing. The counter cannot step past a fractional available balance
into another whole component.

The workspace and shortage detail now display outstanding linked PO numbers,
components, quantities to receive and uncovered planning demand. An empty
outstanding-supply list does not claim no PO ever existed. Stock committed to
another kit/repair prompts commitment review; physically missing parts prompt
Planning/Purchasing follow-up. Sale-linked jobs identify the sale supply owner.
No purchase or goods-receipt action was added to the kit clerk's authority.

A fresh, authoritative complete-pick save opens the final release review directly.
It shows exact components, quantities, source and stock deductions. The separate
repeated count checkbox was replaced by that explicit review and **Release
complete kit** action. Acceptance remains explicit. Unknown, refused, local-site
and explicitly retried attempts keep recovery. The final action rechecks live
availability and the reviewed component/approval snapshot; stale responses cannot
replace Home after leaving the kit.

For the same one-component fixture, trusted Playwright interactions from Home
through Work to the confirmed slip measured **9 → 7 taps**. The saved pre-change
assets are under `work/kit-release-app/before/`; the paired baseline and candidate
ledgers/traces are under `work/kit-release-app/taps-before/` and
`kit-measured-final/`; `tasks-final/` retains the seven-workflow regression run.
The other six complete warehouse tasks retained their prior measured counts and
stock/status outcomes. Counts exclude typing, scrolling and physical work, as
defined below; they do not establish a universal minimum or human task duration.

Twelve dedicated real API/SQLite/Playwright cases pass under
`work/kit-release-app/accepted/`. They independently check partial holds, zero/corrected
picks, fractional/over-stock entry, persisted counts, effective purchasing/receiving
authority, repeat-safe PO coverage, receipts at identically named shelves in two
warehouses, source receipt without automatic picking, full-save review, fresh
stock loss, sale-owned procurement, lost-response replay using the original key,
and a late detail failure after Home navigation. Four targeted counter scans at
360px/390px in light/dark report no violations or incomplete results for the
tested contrast, field-label and button-name rules. Warehouse states pass 17/17;
Home previews and links pass 14/14 under `states/` and `home/`.
The focused run passes 208 tests in six frontend/backend files; TypeScript,
JavaScript syntax and whitespace checks pass. The final logs are
`work/kit-release-app/regression-accepted.log` and `typecheck-final.log`.

Reproduce from the repository root:

~~~sh
WAREHOUSE_KIT_UX=1 WAREHOUSE_UX_OUTPUT=work/kit-release-app/recheck node scripts/test-warehouse-ux.mjs
WAREHOUSE_UX_TASKS=1 WAREHOUSE_UX_TASK_FILTER='kit acceptance' WAREHOUSE_UX_OUTPUT=work/kit-release-app/task-recheck node scripts/test-warehouse-ux.mjs
~~~

The first dedicated browser attempt queried SQLite before the asynchronous save
had completed. Its later assertions consequently used the wrong starting state.
The harness now waits for authority-reloaded saved counts; those initial failures
are retained in `work/kit-release-app/browser/` and are not product failures. A
subsequent broad frontend run exposed an existing photo-recovery fixture reading
its form after a fixed 80ms. It now uses its existing bounded form-readiness helper.
No QC/photo product behavior was changed.

This follow-up changes local mobile code and tests, not backend stock/permission
policy or the deployed sandbox. Real employee usability sessions, phone cameras,
printers and disconnected site-PC confirmation still require their own acceptance.

## Complete-task tap and UI follow-up

The follow-up measures trusted Playwright pointer interactions from Home, through
Work and the assigned queue, to the server-confirmed result. These are full task
counts, beyond the earlier five-to-three navigation measurement.

| Task and fixture | Before follow-up | After follow-up | Independently checked result |
| --- | ---: | ---: | --- |
| Kit release: one BOM line, not yet accepted or picked | 12 | 9 | Separate acceptance and picked counts; one released parts slip; component stock −1 |
| Parts issue: one requested part without a SKU | 8 | 8 | Request accepted, exactly one part deducted |
| QC: one unit, two required checks in one group | 12 | 12 | One QC pass after the two-check checklist, stock unchanged |
| QA: same unit, two required checks in one group | 12 | 12 | One independent QA pass, stock unchanged |
| Unit RTS: one eligible unit of its product, default storage | 12 | 11 | Printable QR decoded by the actual scanner; unit in stock; stock +1 |
| Batch RTS: seven remaining pieces, default storage | 8 | 8 | Printable batch QR decoded; batch fully received; stock +7 |
| Warehouse-out: one serialized unit, one required package item, recipient token, photo and signature | 22 | 18 | Exact unit sold, one release slip, stock −1 |

Both warehouse-out runs also contain one signature stroke. These figures exclude
keystrokes, scrolling, physical inspection/counting, positioning a real camera,
printer dialogs, attaching stickers and external camera/file-picker choices.
Field-focus taps, in-app print/scan buttons and final acknowledgements are included.
Synthetic video frames feed the real scanner overlay and ZXing decoder; scan
callbacks, permission checks and stock APIs are not replaced. The photo-picker
result and signature stroke are simulated. These are reproducible fixture-specific
counts, not a universal count for every order, checklist or device.

Three additional changes follow directly from those task attempts:

- Fresh authoritative kit acceptance/pick/release success now reloads the current
  record directly, removing three recovery-screen interruptions. Unknown results,
  explicit retries and pending site-PC confirmations retain the original recovery.
- Fresh confirmed sales acceptance and allocation reload the stock-review context
  directly, removing four taps. Uncertain/refused/site-local actions and allocation
  correction retain recovery. The remaining checks still precede warehouse-out.
- RTS skips the optional grouping screen only when there is no other eligible unit
  of the same product/build state. Grouping remains available when it is useful.

UI inspection also reproduced insufficient contrast on confirmation and
intermediate queue/disposition surfaces, and an unnamed batch-quantity control.
Scoped warehouse text styles, readable labels, status/disposition text and the
quantity's accessible name were corrected using existing theme tokens. The final
run contains 62 targeted axe scans: 34 intermediate screen checks and seven
confirmation views in two themes at 360px/390px. The tested contrast, field-name
and button-name rules report zero violations. There are 56 incomplete contrast
rule results, mainly glyphs/icons and native controls; these are retained in the
report rather than suppressed. Screenshots were visually reviewed; this is not
an assertion of full accessibility conformance.

Evidence:

- work/warehouse-taps/paired-before/ records all seven completed tasks against the
  saved pre-follow-up assets. Snapshot source hashes are retained in report.json.
- work/warehouse-taps/verified/ contains seven passing complete tasks, tap-by-tap
  ledgers, 62 targeted scans, traces, network evidence and screenshots.
- work/warehouse-taps/regression/ passes the 17 warehouse state/edge scenarios.
- work/warehouse-taps/regression.log records 189 passing frontend/backend tests.
  TypeScript checking also passed. The final Home regression passed 14 scenarios
  under work/warehouse-taps/home/.

Reproduce the current task measurements:

~~~sh
WAREHOUSE_UX_TASKS=1 WAREHOUSE_UX_AUDIT_STEPS=1 WAREHOUSE_UX_REQUIRE_A11Y=1 \
  WAREHOUSE_UX_OUTPUT=work/warehouse-taps/recheck node scripts/test-warehouse-ux.mjs
~~~

The broader QR suite needed test-harness updates for the new fresh-success
navigation, bounded waits, headless print-dialog handling and a disposable driver
account using the actual Driver role. Its relevant receiving/releasing checks
passed, including wrong QR, unavailable camera, printing, repeated-response
recovery, photo/signature recovery and one-time warehouse-out. The broad run then
stopped at an existing delivery-policy discrepancy: a test expecting optional
delivery completion before a warehouse slip was refused by the backend. No
delivery policy was changed as part of this warehouse UX task; the whole broad
suite is not claimed to pass: 23 checks passed before that refusal. See
work/warehouse-taps/qr-final.log.

These checks support the listed improvements. They do not establish an optimal
design for every employee, physical-device ergonomics or actual time-on-task.

## Scope and task boundaries

This audit covers the mobile warehouse pipeline established in this conversation.
It follows existing records and routes; it does not introduce a new warehouse
workflow, change backend policy, or redesign desktop, supplier purchasing,
timekeeping, inventory counts, or delivery.

| Employee duty / effective grant | Existing screens and task | Consequential boundary retained |
| --- | --- | --- |
| Kit clerk — production.kit_release | Home/Work → Kit releases → JO review, warehouse acceptance, picking, release, handoff | Acceptance, picked holds and the parts slip remain distinct. The slip deducts components. |
| Parts clerk — production.repairs | Parts requests → request/repair review → source → physical pick → confirm → result; shortage, revision, rejection and history remain available | Exact item/quantity, approved source, stock holds and pending revision checks remain server-controlled. Issue deducts stock. |
| QC — production.inspect_qc | JO → unit identity → existing technical inspection or reinspection | Parts blockers and identity checks remain. A pass does not add stock. |
| QA / hold review — production.inspect_qa / production.qa_review | JO → unit → existing QA inspection or hold decision | QA remains independent of QC. Required passes and resolved holds precede receipt. |
| RTS clerk — production.receive | JO → serialized unit or nonserialized batch → existing identification, QR, location, review and Products In confirmation | Only the confirmed receipt adds stock. Batch remaining pieces, held units and duplicate receipts stay distinct. |
| Releasing clerk — orders.release | To accept → Allocating → Ready / Blocked → existing authority, allocation, handoff and warehouse-out confirmation | Commercial authorization, package/evidence checks, exact allocation, partial trips and stock-out remain unchanged. |

Browser actors use separate custom roles and actual /auth/me effective
permissions. A basic mobile account cannot open these operational actions. No new
permission fallback or inventory-adjustment authority was added.

## Baseline and changes

Fresh disposable jobs, units, failed inspections, requested repair parts, a
pending revision, a mismatch hold, a partially received ten-piece batch and an
authorized unaccepted sales order establish the task states. Records are created
through real authenticated APIs. SQLite is opened read-only for stock, request,
unit and receipt snapshots. The same backend serves both browser versions.

| Demonstrated friction | Adjustment and observed result |
| --- | --- |
| Kit, release, reinspection, held-RTS and shortage-only work sits behind an initially empty status. | With no explicit status requested, open an existing nonempty work status. Explicit filters remain respected, including empty ones. Headers describe pending work instead of suggesting all work is ready for handoff. |
| Opening a record and going Back or refreshing loses the selected status. | Update the current history entry with the filter, preserving role and JO parameters. No history entry or API write is added for a filter change. |
| RTS calls one serial plus a seven-piece batch “2 units”; held JO cards also say “eligible.” | Show “1 unit · 1 batch (7 pcs),” quantity remaining per batch, and “unit(s) on hold” for issues. Batch rows omit product IDs, so the header no longer claims a combined model count. |
| QC/QA grouped reinspection cards call parts-blocked work eligible. | Display unit count and “waiting for parts” in the JO card, then a warning on the unit. The existing inspection action still refuses the blocked pass. |
| Parts review requires five navigation transitions before final confirmation. | Move repair checks onto initial review and stock effects onto final confirmation. The same task takes three transitions: review → source → pick → confirm. Old context/review links still resolve. |
| Entering 1.5 for a request of 1 advances with 1 due to integer truncation. | Reject fractional, blank or mismatched input and preserve it for correction. An associated inline alert identifies the requested quantity. |
| A pending revision lets the clerk progress until a later refusal. | Explain pending approval and remove the issue path, including through an old confirmation link. Backend refusal remains independently checked. |
| A delayed parts context success or error paints over Home after navigation. | Check route, account and render instance before painting either outcome. |
| Status filters use small text and 24px targets; summaries become cramped beside long counts. | Use scoped 44px status targets, native button pressed states, keyboard activation and a stacked summary. Existing theme tokens, cards and actions are retained. |

The tap measurement is **five versus three navigation transitions from request
review to confirmation**. It excludes queue entry, physical scanning, the final
checkbox and the issue button. It is not a measured task-duration or employee
error-rate improvement.

## Verification and reproduction

The final run passed **17/17 warehouse Playwright scenarios**, with zero browser
JavaScript errors. The original assets failed **12 of those same 17 assertions**;
the five existing safety/recovery checks passed on both versions. The independent
Home suite passed **14/14 scenarios**. TypeScript passed and the final combined
frontend/backend run passed **189 tests in seven files**. The final evidence
contains 34 warehouse traces, 37 screenshots and 34 network JSON files; Home
regressions retain another 29 traces and 36 screenshots.

Initial harness issues (expected validation status, asynchronous button readiness,
and selectors that included bottom navigation) were corrected before the paired
acceptance runs. An initial backend test run could not bind sockets in the
restricted environment; the authorized local-server rerun passed. Those setup
failures are not counted as product defects.

Run from the repository root with dependencies and Chromium at /usr/bin/chromium.
Each browser run starts its own temporary Express/SQLite app, records evidence,
and deletes its fixture database at shutdown. No live sandbox records are changed.

~~~sh
WAREHOUSE_UX_OUTPUT=work/warehouse-ux/accepted node scripts/test-warehouse-ux.mjs

# Expected nonzero exit: same assertions against original browser assets.
WAREHOUSE_UX_BASELINE=1 WAREHOUSE_UX_BASELINE_REF=45d0201 \
  WAREHOUSE_UX_OUTPUT=work/warehouse-ux/before node scripts/test-warehouse-ux.mjs

HOME_AUDIT_OUTPUT=work/warehouse-ux/home-regression node scripts/test-mobile-home-audit.mjs

npm run typecheck
npx vitest run tests/frontend-mobile.test.ts tests/frontend-mobile-personal.test.ts \
  tests/repair-parts-v2.test.ts tests/rts.test.ts tests/job-orders-qc.test.ts \
  tests/qc-inspection-v2.test.ts tests/release-auth.test.ts
~~~

Baseline mode obtains the specified committed assets with git show and serves
them only to Playwright. It never checks out or overwrites working source. Both
versions use the same assertions and fresh equivalent workflow data. Checks
include API identities, read-only database snapshots, an actual browser-confirmed
stock issue, exact stock delta, duplicate refusal and forbidden-action refusal.

Evidence is local and ignored by Git:

- work/warehouse-ux/accepted/report.json: current results, source hashes,
  effective profiles, workflow snapshots and measured navigation sequence.
- work/warehouse-ux/before/report.json: original-screen failures. Earlier
  harness-development runs are not acceptance evidence.
- Each run directory contains separate employee traces (.zip), queue network
  logs (.network.json), API events and screenshots.
- release-landing.png, receiving-light-360.png and receiving-dark-360.png
  capture key queue views. Case screenshots include kit picking, inspection
  blockers, quantity errors and final confirmation.
- work/warehouse-ux/home-regression/: Home permission, stale-card,
  cross-employee completion, unavailable/delayed-response and receipt checks.
- work/warehouse-ux/vitest.log: final focused frontend/backend result.

Inspect an archive with npx playwright show-trace followed by its trace filename.
Traces can include disposable fixture session data and remain local.

## Tradeoffs and remaining uncertainty

Request review and confirmation contain more information on one screen; less
navigation can require more scrolling. Confirmation remains a deliberate stock
action. Larger status buttons may wrap onto another line. Initial selection uses
a deterministic queue priority rather than learning an employee's preference;
a URL filter takes precedence.

No actual employee observation sessions, physical phones, scanners, label printers,
installed-PWA updates, site-PC synchronization or OS notifications were available
for this audit. Evidence establishes reproducible browser behavior, keyboard
interaction, narrow layouts in both themes and backend invariants. It does not
establish employee comprehension, physical scan reliability, full WCAG conformance,
or the globally “best” UX. Employee testing should next check comprehension of the
consolidated repair review before issuing stock.

Changes remain local; no commit, push or deployment is part of this audit.
