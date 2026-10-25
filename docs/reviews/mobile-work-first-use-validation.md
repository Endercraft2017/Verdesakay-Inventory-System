# Work first-use UX correction — 2026-10-25

Scope: existing mobile Work overview, permissions, counts, and detail/action
links. Base: `f6b09c4`. Candidate cache: **v159**. No sandbox/production data was
changed. Changes are local until separately committed/deployed.

## Demonstrated problem and correction

The previous `allClear` calculation excluded sales follow-up and unread notices,
then hid sales follow-up in a collapsed tools directory. With two real open
orders and 43 unread notices, Playwright reproduced “No action needed” while
follow-up was hidden. “CLEAR” meant zero checked records; “GO” and “OPEN” merely
meant an available destination. The page also repeated a queue directory and an
inventory-tools directory, with inconsistent visual emphasis.

The candidate shows sales follow-up in Needs attention, uses qualified empty
wording, and keeps unread notices distinctly labelled. Green dots mean a checked
area has no pending work; red numbers count pending entries. Failed checks remain
amber/unknown. Tools without a pending-work source have a chevron, not an invented
green status. The former navigation lists are merged into compact Work & tools
rows. Personal utilities and all permission-backed destinations are retained.

The always-visible status key was removed at the user’s request. Indicator
accessible names and the on-demand Guide retain the explanations. Mixed
RTS counts retain entry versus physical-piece wording. Stock and consequential
action checks remain in their original workflows.

## Verification and evidence

| Check | Result |
| --- | --- |
| Same sales-only employee, 2 open orders, 43 unread notices | Previous layout reproduces contradictory empty message; candidate visibly shows 2 follow-ups and separately labels 43 unread notices |
| Sales-follow-up entry | 3 taps before, 2 after, to the same `sales?id=…` destination; no stock changes |
| Available work areas | One directory; no CLEAR/GO/OPEN status labels, no “My authorized queues” or second “Inventory tools” section |
| Status truth | Successful zero is green; pending records red; failures unknown; lookup tools have no task badge |
| Existing workflows | Independent QC/QA, blocked inspection, partial/full batch receipts, RTS holds, another employee's completion, saved handoff recovery all passed |
| Access and races | Separate employee contexts, custom permissions/revocation, stale/failed responses, leaving during a delayed read and return all passed |
| Accessibility/layout | Native keyboard disclosures, both themes, 320/390/768px widths, no horizontal overflow, no targeted axe violations in tested states |

The initial pass had **15 Work/browser/design scenarios**, including the original scenario
above and extraction of the actual rendered app styles. No JavaScript page errors
were recorded. **11 Home layout regressions**, **178 focused Vitest tests**, and
TypeScript passed. Preview cases assert unchanged stock; the batch case posts
authorized disposable receipts and verifies their exact stock effects.

## Independent full-brief recheck

The current uncommitted implementation was challenged again with fresh records,
database/API oracles and persisted browser drafts. Four targeted probes failed
before these follow-up fixes:

- A held RTS serial with a saved receipt appeared twice in its Work directory
  badge. Work now explicitly requests the union of live, held and saved identities
  from the receiving counter. Default receiving-counter behavior is preserved.
  A distinct saved batch gets its own saved-work count, rather than a repeated
  total resembling another queue.
- Cached “new update” badges remained on live cards during a pending or failed
  notice refresh. They are now suppressed until the notice check succeeds;
  stale notices remain available with their warning.
- A cached truncated window overwrote the checking/unknown marker with “200+”.
  That numeric suffix now appears only after a successful current check.
- A semantically malformed RTS response could create a numeric badge and a false
  saved-work entry. Source validation now takes precedence over the count helper;
  the directory stays unknown and no saved attempt is invented.

The initial legend explained shape as well as color; the user subsequently
requested its removal. It is no longer rendered.
The terminology pass also clarifies “Find a sale” and “New purchase request”,
removes the CSR acronym from navigation help, and describes release acceptance/
picking and required inspections without implying goods are already ready or
that QA alone always establishes receiving eligibility.
Final verification: **19 Work/browser/design scenarios**, **11 Home regressions**,
**196 focused tests** across four suites, TypeScript, and the extension's own tests
passed. Both themes had zero detected axe violations in the tested states. The
actual Work browser run recorded zero JavaScript page errors. Some unrelated
signature/courier tests in the jsdom bootstrap suite log missing canvas-context
warnings; that environment does not demonstrate signature rendering or hardware
behavior. All its assertions passed, and the app's signature code was not changed.

Raw follow-up evidence is in `work/work-full-brief/`: `before/regressions.json`
and `before/unavailable-counts.json` retain the four failing probes; the saved
pre-fix public sources are beside them. `after/regressions.json` is the fresh
196-test result. `after/report.json`, traces, network logs and screenshots cover
the real-backend browser checks. `prior-layout/report.json` independently
reproduces the published layout with new data: sales follow-up is three taps
before versus two after, to the same destination. Current source and license
classifications were rechecked against the pinned downloaded repositories.

Taste's inspector passed its failure checks after the static snapshot retained
the real `.m-view` gutters. Three advisory warnings remain: desktop whitespace
around the intentionally narrow mobile column, below-fold content for an admin
with all duties, and 12px secondary metadata. Primary labels and record sublines
were enlarged; these warnings are not proof of human usability or reasons to
broaden this into a desktop redesign. Both original and candidate closed sales
fixtures fit 390×844; the gain is visible work in that viewport, not a claimed
reduction in document height.

## Design resources verified

- Taste Skill and UI UX Pro Max were already installed and reused.
- `kylezantos/design-motion-principles` is added as a pinned project skill,
  with its license and references. Restraint/no badge animation applies here.
- `VoltAgent/awesome-claude-design` is preserved as a reference collection;
  that repository does not supply an executable skill.
- `bergside/design-md-chrome` is preserved as an unpacked Chrome extension,
  not activated in a browser profile. Its tests passed. The local browser test
  ran its DOM extractor through a test message shim and same-origin fixture asset,
  respecting the app CSP; its normalization/generation produced the captured
  design blueprint. No production security policy was changed.
- Plugin discovery verified connected MagicPath and Figma capabilities. No extra
  plugin was required or installed. Available does not mean used in validation;
  browser evidence comes from the app, not a prototype.

Repository URLs, exact commits, classifications and licenses are recorded in
`.agents/skill-sources/manifest.json`. The scoped design contract is
`docs/design/mobile-work.md`.

## Reproduce

```sh
WORK_LAYOUT_BASELINE=1 WORK_LAYOUT_BASELINE_REF=f6b09c4 \
  WORK_LAYOUT_OUTPUT=work/work-first-use/before node scripts/test-mobile-work-layout.mjs
WORK_DESIGN_RESOURCES=1 WORK_LAYOUT_OUTPUT=work/work-first-use/after \
  node scripts/test-mobile-work-layout.mjs
WORK_DESIGN_RESOURCES=1 WORK_LAYOUT_OUTPUT=work/work-full-brief/after \
  node scripts/test-mobile-work-layout.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_OUTPUT=work/work-first-use/home-regression \
  CHROMIUM_PATH=/usr/bin/chromium node scripts/test-mobile-home-audit.mjs
npm run typecheck
npx vitest run tests/frontend-mobile-work-navigation-ux.test.ts tests/frontend-mobile.test.ts
npx vitest run tests/frontend-mobile-work-navigation-ux.test.ts tests/frontend-mobile.test.ts \
  tests/rts-recovery.test.ts tests/production-drafts.test.ts
node .agents/design-tools/bergside--design-md-chrome/tests/run-tests.mjs
```

The fixture server/database are disposable and cleaned up on shutdown. Reports,
source hashes, screenshots, network evidence, and traces are under ignored
`work/work-first-use/{before,after}/`. `EXTRACTED-DESIGN.md` and
`extracted-design.json` contain the local style extraction; `taste-inspection/`
contains the static inspection. Open a trace with
`npx playwright show-trace work/work-first-use/after/02-0.zip` for the sales case.

This is Chromium automation, mobile/touch simulation and static design inspection.
Physical-device checks and representative first-time employee sessions were not
available. In a human walkthrough, ask someone unfamiliar with the app to identify
their next follow-up, explain a green dot and an unread count, locate stock lookup,
and distinguish an unavailable check from an empty work area without coaching.


## Scratch preview follow-up (2026-10-25)

The visible “Dot = nothing waiting / Numbers = pending items” strip is removed.
Checked-empty indicator names, contextual pending counts and the on-demand Guide
remain. The regression for green/unknown statuses also checks the strip is absent.

The user’s latest remote AGENTS.md requirement to actively use skills/tools was
preserved alongside the new project-local scratch-preview preference. Future
UI/UX explanations and iteration notes belong in that preview, with chat reserved
for architecture, necessary questions and minimal delivery/status.

`npm run ui:scratch` clears only the owned generated `work/ui-scratch/` directory.
It captures fresh disposable backend records/effective profiles and builds a
self-contained HTML entry from 118 current app HTML/CSS/JS sources. Runtime UI
handlers, routes, styles and motion are original app code; browser data transport
and storage are isolated simulations. Source hashes and fixture/database
summaries are available inside the preview. Its output is ignored by Git.

`UI_SCRATCH_REBUILD=1 npm run test:ui:scratch` verifies clean rebuilding, unchanged
source hashes, record/detail/action navigation, disclosures/Guide, accessible
counts, basic access, empty/delayed/failed states, light/dark and narrow layout,
actual quick-action exit timing, reduced-motion closing, no external HTTP, and
blocked business writes. Evidence and screenshots are generated in the scratch
folder and intentionally replaced by the next rebuild. The existing live
API/DB workflow audit above remains separate evidence.

Managed Chromium blocks `file://` navigation. Browser verification serves this
same standalone file over loopback; `npm run ui:scratch:serve` provides that
entry locally. Direct-file behavior in other browsers, physical hardware, actual
first-use comprehension and restart persistence are not established by the
preview. No production app/backend or MagicPath canvas is used by the file.


## Back navigation and three work shortcuts (2026-10-25)

Fixed the root-screen classification that hid Back on `#/work?task=…&record=…`
and notice detail routes. The button has a 44×44px target and a focus outline.
App-created attention entries retain their prior app hash; Back returns to that
permitted screen. Untagged direct links use Work as a safe fallback. The existing
bottom Back to Work button keeps its explicit destination.

Removed New message from Quick Orbit. Two common actions plus up to three work
shortcuts keep the existing five-action limit. Added the optional third picker
and frontend/backend bounds; existing one/two-slot preferences remain valid.
Sales follow-up requires order viewing, a sales workflow permission, and both
Sales/Inventory modules, matching the existing route. Revoked choices stay hidden
and no shortcut grants action permissions.

Checks completed: the four focused suites passed 213 tests; the final module
constraint passed a subsequent nine-case API recheck, and the Back refinement
passed its two targeted navigation regressions. TypeScript passed. The existing
jsdom signature/canvas warnings remain outside this change.

`MOBILE_ORBIT_OUTPUT=work/back-and-three-shortcuts/orbit node
scripts/test-mobile-quick-orbit.mjs` passed all 18 real-backend Playwright cases,
including three-choice persistence in another browser context, all fan corners,
small/landscape windows, keyboard, accessibility, interrupted dismissal and
reduced motion. `npm run test:ui:scratch` passed 14 artifact checks with 118
matching current app sources, no JS errors and no external HTTP requests. It
covers Back from Work/Home, untagged deep links, three-slot sample customization,
empty/basic/failed/slow states, actual motion and light/dark/narrow accessibility.
A clean scratch rebuild boundary was also verified.

The preview adapter now allows form events while CSP continues to block form
navigation. Only notification read markers and shortcut preferences mutate its
isolated memory; business writes stay blocked. Production-side account persistence
is covered by the separate API/browser checks, not implied by sample memory.
The exact tested artifact was privately published to the existing Site under
source commit `0be2194af0a1a0e3b907ef4c441ed7283a34e9a7`; the deployment succeeded.
Physical-device testing and uncoached employee usability remain unverified.


## Sales queue screenshot correction (2026-10-25)

The reported screen was the existing Sales pipeline destination. Playwright
reproduced two unloaded open-arrow SVGs in the scratch, a 0px card gap and two
redundant stage pills under the same CSR review heading. The targeted browser
regression failed before the fix. Evidence is retained in
`work/sales-queue-fix/before/` across scratch rebuilds.

The preview now bundles all 18 original mobile icon/image files and resolves
dynamic image paths locally, without changing RoleUI component markup or opening
live network access. Sales groups use the existing 12px `rk-list` gap, show their
stage once and label the first stage Sales review. Name/status text is larger.
A new light-theme check caught 9px filter labels at 4.14:1 contrast; the scoped
Sales labels now use the existing readable muted token at 12px.

The fresh clean-build scratch pass completed 16 checks with 136 matching app
source/image hashes, both SVGs loaded, measured 12px spacing, no duplicated stage
pills, light/dark Work and Sales accessibility, retained Back/shortcut/motion
behavior, no page JS errors and no external HTTP. This is browser simulation of
the generated preview, not a physical-phone or live-system usability claim.

## Sales dropdown and compact-card review — 2026-10-25

User requested a full-width rounded Stage menu with padded options and muted
selection, two-row order cards and a full-height colored arrow rail. They clarified
that Customer or order was correctly a search label and asked to remove the
redundant Sales pill and repeated Sales pipeline title.

Implemented in the canonical mobile inventory/sales.js list and scoped V2 CSS.
The custom select-only combobox preserves keyboard arrows, Home/End, Enter/Space,
typeahead, focus, option announcements and outside/Escape/Tab dismissal. Orders
retain their exact IDs, list/filter semantics, route permissions and backend
checks. Color reflects current returned facts, with non-color symbols and full
accessible labels. SQL inspection showed backordered means outstanding coverage,
not necessarily unavailable warehouse stock; the cue says outstanding goods.

The scratch builder now captures all sample Sales detail/availability reads,
not just the first Work preview record, and includes a separate four-order
snapshot created through the disposable backend: two open orders, one approved
service arrangement and one approved forced backorder for a zero-stock part.
The original two-order Work baseline remains unchanged. The wrapper adds a
View Sales pipeline review shortcut; no production API is connected.

Final command: `UI_SCRATCH_REBUILD=1 npm run test:ui:scratch`.
Result: 20 checks, 136 current app source/image hashes, no page errors or external
requests. Phone layouts at 320/390px and both themes pass open-popup axe scans.
Mouse/keyboard paths and actual Playwright touch taps pass. Field/menu widths are
360/360px, option text inset 23px, radius 18px, option minimum height 44px. Cards
measure 82px with an 80px rail inside their border and exactly two grid rows;
12px card separation remains. Tapping the rail opens the exact same existing
order details in one tap. Existing Work/Home Back, shortcuts, motion, empty,
permission-limited and failed/slow-read regression checks also pass.

Two in-development placement failures were caught before publication. The first
popup was anchored after the cards due to a missing closing wrapper tag; fixing
the markup restored field anchoring. The short-screen case then demonstrated
options extending behind the dock; fitting/flipping the popup and layering it
above floating shortcuts makes the same touch-selection case pass. Failing
traces/screenshots/reports are retained under ignored
`work/sales-filter-refinement/blocked-popup/` and `short-screen-before/`.
Final screenshots, trace, verification metrics and hashes are under
`work/ui-scratch/`. Syntax checks and `git diff --check` pass.

An exploratory 200% CSS page zoom inside an already 320px phone frame exposed
existing app-shell header/dock overlap at roughly 160 effective pixels. That is
outside this Sales-list edit, and is retained in `extreme-zoom/`; normal 320/390px
layout results do not imply that extreme zoom passed. No physical phone,
assistive-technology session or representative employee usability session was
performed. API/database observations come from disposable fixture capture;
interactive preview responses are replayed snapshots with business writes blocked.

## Shared mobile UX, Back and refresh — 2026-10-25

Implemented the eight screenshot corrections in shared mobile code. Work removes
its repeated title/role and healthy-state introduction, visible section refresh
buttons, Updates directory and View notification history action. Stored notices
remain in Notifications; the shell bell uses the existing employee-scoped unread
count endpoint and explicit unknown state. Reading a notice updates the count.
The Sales search says Customer or Order Number. Its status rail has no extra
mark. Global RoleUI cards use the same full-height rail; unspecified status stays
neutral. Shared field/button radius, spacing, colors and motion remain in V2 CSS.

The new screen-ux module enhances actual native selects with one rounded/inset
menu design. Native values, disabled options, required validation, input/change
events and FormData are verified. Menus float outside clipping containers and
respond to dynamic option replacement. Touch/keyboard, outside/Tab/Escape closure,
short-screen placement, both themes and targeted axe scans pass. A genuine nested
editor regression was caught: the enclosing dialog's capture listener consumed
Escape before the select. The shared handler now gives the first Escape to the
open dropdown. Its failing trace/screenshot/report is retained in
`work/shared-mobile-ux/nested-dropdown-before/`.

Back now tracks owned app entries and allowed predecessors, gives Notifications
Back, deduplicates popstate/hashchange and skips repeated same-screen entries.
An independently reproduced failure after replacing a filter query returned to
the same task screen; the corrected history ownership check returns to its real
parent. The failing unit report is in `work/shared-mobile-ux/back-filter-failing-before.log`.
Timestamp refreshes already used after workflow saves still reload the current
record, without adding another Back entry. Direct attention/Notifications/Sync
links have meaningful fallbacks; Inbox's existing Back delegates to MApp.

Pull-to-refresh is bounded to supported read-only overviews/lists at scroll top.
Chromium input-protocol touch events verify the threshold, cancelled short and
horizontal gestures, single-flight behavior and completion. A keyboard/screen-reader
control and Alt+R use the same read handler. Order details and an actual edited,
unsaved Sales note remain untouched. Sales search/stage survive a refresh without
adding history. Failed Work checks remain unknown, retaining scoped recovery.
No refresh handler posts stock or workflow actions. Preview business writes are
blocked; only sample notification-read and shortcut state changes are allowed.

Final reproducible commands:

- `UI_SCRATCH_REBUILD=1 npm run test:ui:scratch`
- `npx vitest run tests/frontend-mobile.test.ts tests/frontend-mobile-work-navigation-ux.test.ts tests/frontend-mobile-quick-orbit.test.ts tests/mobile-quick-actions.test.ts tests/rts-recovery.test.ts --reporter=dot`
- `MOBILE_ORBIT_OUTPUT=work/shared-mobile-ux/orbit-final node scripts/test-mobile-quick-orbit.mjs`
- `npm run typecheck`

The clean scratch run passes 28 checks and verifies 137 current source/image hashes,
with no page errors or external HTTP. The focused frontend/API run passes 226 tests;
The 18 real-backend quick-action browser cases also pass on the final integration.
TypeScript, syntax and diff checks pass. A recovery test's arbitrary 80ms wait was
replaced with waiting for its actual saved decision card, retaining all immutable
operation/restart assertions. Existing jsdom canvas/setTransform warnings remain
unrelated to the passing assertions and do not verify signature rendering.

Playwright evidence is in `work/ui-scratch/verification.json`, `trace.zip` and
screenshots. It covers 320/390px, both themes, short-screen menus, actual native
forms, Back/history variants and reduced motion/interruption. Native touch is
Chromium browser emulation, not a physical phone. No real screen-reader session
or first-time employee study was performed. Shared code applies across mobile;
the browser checks cover representative screens/components, not every legacy
route and device. Existing extreme effective-160px shell zoom limitations remain
outside the tested normal-width layouts. App code is uncommitted; the Sites
publication is a separate owner-private scratch artifact.

## Remaining Refresh controls — 2026-10-25 follow-up

The user's Approvals screenshot demonstrated an incomplete migration. The shared
helper existed, but Approvals and other HR/stock controllers still owned visible
refresh buttons. The screenshot's large retry/error also came from an uncaptured
Approvals endpoint in the standalone artifact, not a real authorization result.

A source-wide button/action-label audit found the remaining controllers, including
multiline Payslips markup missed by a same-line text search. Ordinary reloads now
bind their existing state-preserving readers and busy predicates to the shared
pattern. Healthy layout controls are explicitly hidden in their source; native
hidden semantics are enforced globally. Error retries and business stock/recount
checks retain their handlers and safeguards, with purpose-specific wording.
The shared helper supports an availability predicate and does not fall back to a
full rerender when a registered reader is unavailable. Location's nested registry
read explicitly updates availability after the outer read finishes. Work's own
running check also disables another refresh.

The builder now waits for each actual route and directly captures canonical HR
read responses under that employee's token. It creates a manager, linked employees
and a pending leave record through the disposable backend APIs. Sales receives
can_approve=false and shows No approval access; the manager sees its real pending
request. Both reflect actual endpoint responses. Manager read capture leaves
inventory item quantities unchanged. Stock detail contracts are also captured.
The preview offers View Approvals and an HR-manager sample without granting the
Sales sample fake permissions or using real employee data.

Final verification:

- `UI_SCRATCH_REBUILD=1 npm run test:ui:scratch`: 32 checks, 137 current source/image
  hashes, no page errors or external HTTP. New checks cover unauthorized Approvals,
  the real pending approval, note preservation, blocked refresh during Undo, failed
  reads/retry, and shared reads on Directory, Schedule, Requests, time corrections,
  Clock, Payslips, low stock, Location and Item detail. Each has zero ordinary
  visible Refresh controls. Existing Back, motion, roles, warehouse and form
  protection regressions remain included.
- 410 tests pass across 12 suites: frontend-mobile-refresh-contract,
  frontend-mobile-clock-ux, frontend-mobile-pay-schedule-ux,
  frontend-mobile-requests-ux, frontend-mobile-time-fix-ux,
  frontend-mobile-stock-lookup-ux, frontend-mobile-work-navigation-ux,
  frontend-mobile-personal, mobile-approval-balance, frontend-mobile,
  frontend-mobile-stock-actions and me-approvals. Run with
  `npx vitest run tests/<suite>.test.ts ... --reporter=dot`.
- `npm run typecheck`, changed-JS syntax checks and `git diff --check` pass.

The source guard initially caught the Payslips controls and a production-handoff
error action still named Refresh. The latter now says Retry production details.
Two old Guide expectations were updated for the current Work directory, retaining
all role/content checks. Releasing tests now wait for the correct rendered handoff
phase instead of a fixed delay or a stale prior-screen button; all original
payload, authorization and idempotency assertions remain.

An apparent stock-refresh failure was a QA-log measurement error: the visible
preview log keeps only its last 35 events, so counting that window stopped being
monotonic. Playwright now independently collects all API evidence per sample.
Tests start the gesture outside inputs; protected input gestures do not refresh.
These were harness corrections, not claims of stock or refresh bugs in the app.

Browser evidence: work/ui-scratch/verification.json, trace.zip,
approvals-sales-access.png and approvals-manager-pull.png. Read contracts and
no-stock-change proof are in source-manifest.json/fixture-responses.json. The
browser matrix covers ten representative screens; confidential/planned-check and
other detail registrations have source/unit coverage rather than a claim that
all legacy views were manually exercised. No physical phone, real screen reader
or representative employee session was used. Business writes stay blocked in
the private preview. App changes remain uncommitted.


## Approved mobile-wide release verification (2026-10-25)

Final current-source checks: 525 tests across 18 frontend/API suites, TypeScript,
36 scratch Playwright checks, and 137 exact app source/asset hashes. Source-wide
refresh coverage, shared native-select enhancement and RoleUI rails apply through
the bootstrap to existing routes. The last audit corrected legacy HR action pills
to use the same shared button radius/press tokens as other mobile actions; the
browser verifies real Requests primary and failed-read secondary buttons.

The final scratch run includes the cloud in eight width/theme/Back cases, classic
and overlay scrollbar matrices in 24 size/theme/motion combinations with zero
background drift, accessibility scans, authorization/failure states, navigation,
filter/draft preservation and workflow refresh guards. No page JS errors or external
HTTP requests were observed. The source bootstrap and v159 service-worker list
include the shared helper. This is representative automated coverage; not every
legacy task or physical device has been observed with a first-time employee.

The initial default sandbox run could not bind API test sockets; the subsequent
supported run passed all 525 tests. Existing jsdom canvas/teardown warnings remain
limited simulation behavior. No business API checks or assertions were weakened.
Generated scratch/evidence and Python caches are excluded from the commit. The
requested pinned design resources retain their source commits and licenses.
