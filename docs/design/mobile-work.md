# Mobile Work: first-use design rules

Applies to the existing mobile Work overview and its current destinations. It
does not redefine business stages, access, stock actions, or the desktop layout.

The screen answers: **What needs my attention, and where can I do my work?**
Employees may have a narrow role, a custom combination of duties, or only basic
employee tools. Use their effective permissions, not their role's name alone.

## Content and layout

- **Needs attention** contains live work, sales follow-up, blockers, failed
  checks, and saved attempts that still need review. Sort active areas by their
  oldest outstanding record. Show two previews and the full count per area.
- Sales follow-up is visible when its existing endpoint returns relevant open
  orders. Do not hide it in a tools folder while claiming no work needs attention.
- **Updates / Unread notices** counts stored unread notifications separately from
  pending workflow records. An unread event can refer to already-completed work.
  Group by record identity, never by title alone. Only explicit opening marks read.
- **Work & tools** is one compact directory of the employee's available work
  areas and tools. Merge the former authorized-queue and inventory-tool lists.
  Do not repeat their administrative permission explanations in the UI.
- Lookup/create/report tools have a destination chevron. Do not label them
  `GO` or `OPEN`, or invent an empty-task status for a tool with no task count.
- Personal utilities remain available at the bottom of that directory.
- Use task language for navigation: “Find a sale” for lookup and “New purchase
  request” for the budget request, with plain descriptions of releasing and
  required inspection stages. Avoid role acronyms and imply only the permissions
  and prerequisites the existing workflow actually grants or requires.

## Status contract

| Indicator | Meaning | Requirements |
| --- | --- | --- |
| Small green dot | A successful check found zero pending records | Accessible name “No pending work”; explanation available in the on-demand Guide |
| Larger red number | Pending records in this area | Count from the area's own data; name the noun alongside previews |
| Red number on Updates | Unread notices, not pending workflow records | Label it “Unread notices”; do not add it to task totals |
| Amber `!` | A check failed; count unknown | Explain/retry; never replace an unknown count with zero |
| Neutral `…` | Check in progress | Never imply that an unfinished check found nothing |
| Chevron only | An available tool/destination without a task count | No green empty status without evidence |

Do not show an always-visible status legend. Keep meanings in accessible indicator
names and the on-demand Guide. No fake numeric example badge, pulsing dot,
bouncing counter or decorative entrance animation.

Zero work and unread notices may coexist. Say that the **checked** areas have no
pending tasks and acknowledge unread updates below. Never claim all the person's
work is finished or all tools were checked when the data cannot establish that.

## Records, counts and safety

Orders are orders, kits/production are jobs, inspections are units, and personal
tasks are tasks. An RTS batch is one receiving entry with its own remaining-piece
quantity. For mixed RTS work, show the entry count and the separate unit/batch/
piece breakdown. Holds stay visible and cannot make the area look empty.

Directory badges and previews share queue reads. Saved-approval/hold/RTS counts
retain their local recovery semantics. Saved release and handoff work stays
visible even when the live record leaves its original queue.

Work's receiving count uses the union of ready entries, held serials and saved
receipt identities. A saved attempt for the same held serial counts once. The
receiving helper's default count keeps its existing behavior; Work explicitly
includes holds. An additional saved-work card counts only identities outside the
known live queue, and says “Saved work” instead of resembling a second live queue.

Unread badges on individual work cards require a successful current notice check.
Keep last-loaded notices available with a stale warning when their refresh fails,
but suppress their “new” badges on live cards. A cached truncated window such as
“200+” must never replace the checking or unknown marker after a new read starts.
Semantic validation failures override a directory count even when HTTP returned
200. A malformed response is not evidence of either new work or a saved attempt.

Keep permission checks, current membership checks, route ownership, bounded
reads and stale-response handling. Preview reads never change stock. All
consequential confirmations remain in the existing workflow screens.

## Visual system

Preserve the app's existing `--v2-*` light/dark tokens and system font stack.
Use flat surfaces and compact rows, with color concentrated on actual status.
The scoped red badge uses `#b5473c` with white text in both themes for contrast;
the existing green token supplies empty-status dots. Primary row labels are
14px, record sublines 13px, and secondary metadata 12px. Maintain wrapping,
visible focus and at least 44px action targets. Badges have accessible names;
color is never the only way their meaning is conveyed.

Taste's app-screen guidance informs hierarchy and density. UI UX Pro Max informs
semantic status, contrast, touch and failure states. Motion Principles informs
restraint: these frequently scanned indicators do not need animation. Reference
collections do not override real data, existing brand constraints, or workflow
safety. See `.agents/skill-sources/README.md` for the installed resources.

Automated evidence and its limits are in
`docs/reviews/mobile-work-first-use-validation.md`. A real first-time employee
walkthrough remains necessary before claiming the terminology is understood.

## Attention Back and quick actions

Work attention details have a visible top-bar Back target of at least 44×44px
with keyboard focus. In-app navigation records the previous hash on the detail
history entry; Back returns to that preceding permitted app screen. A direct
link without that provenance falls back to Work rather than leaving the app.
The separate bottom “Back to Work” action keeps its explicitly named destination.

Quick actions contain New request, Report issue and up to three distinct
permission-backed work shortcuts. Inbox remains in the dock, so New message is
removed from the fan. Employees with fewer eligible duties get fewer buttons.
Defaults recommend up to three available duties; saved one- and two-slot choices
are retained. Optional second/third slots may be omitted. Revoked choices are
hidden and action permissions are rechecked; no filler desk replaces them.

Sales follow-up is an available work shortcut only when the employee has order
viewing and a sales creation/editing/approval duty, matching the existing Sales
route. Frontend and account preference endpoints accept at most three distinct
allowed IDs, with no change to business action permissions or stock effects.

The updated review uses the same private scratch Site. Its preference save is
in-memory simulation; independent API tests and the real-backend Playwright
shortcut test verify actual account persistence, access and validation.

## Sales follow-up list fidelity

The existing Sales pipeline destination groups orders under one stage heading.
Use its existing `rk-list` spacing (12px) between cards and do not repeat the
group's stage as a pill on every row. Use “Sales review” instead of the CSR
acronym. Keep stage calculation, ordering, filters and action permissions intact.
Filter labels and order metadata must remain readable in both light and dark.

The scratch builder must include original app image assets, not only scripts and
styles. Dynamic RoleUI icon paths are resolved to their exact bundled image bytes
inside the isolated preview. Verify rendered images have nonzero natural width;
a successful page load or a screenshot without inspection does not prove assets
loaded. Keep asset hashes with the other source hashes.

## Sales list refinement — 2026-10-25

Keep the existing Customer or order search label. Use the shell's single visible
Sales pipeline/Order tracking title; remove the list's role chip and repeated
visible heading, retaining its semantic h1 for assistive technology. This change
is scoped to the list, not Sales detail/action frames.

Order cards show number and customer on two grid rows. The entire card remains
one button to the same exact order, including the full-height bordered arrow rail.
Green/circle denotes open, yellow/clock pending, red/exclamation outstanding goods;
complete/cancelled are neutral. Button accessible names retain state and full
customer names. Long visual customer names truncate with an ellipsis and retain a
title. Do not treat the backend backordered flag as proof of inventory shortage:
its SQL checks outstanding quantity/serial coverage on approved/released orders.

Use the app's existing palette/type. The Stage combobox popup matches the field
width, with an 18px radius, 8px menu padding and at least 44px option targets. Muted
selection, a checkmark, visible focus and restrained glow replace the operating
system's unstyleable bright-blue native menu. Preserve keyboard arrows, Home/End,
Enter/Space, typeahead, Escape, Tab and outside dismissal. Keep focus on the
combobox and announce the active option. Fit/flip the popup to avoid the dock on
short screens; layer it above floating shortcuts while open. No new animation.

Taste's app-screen guidance informed two-line rows, quiet hierarchy and color on
actual data. UI UX Pro Max's dropdown/focus search informed unobscured, visible
focus. This bounded edit does not adopt a new design system or alter workflows.

## Shared mobile interaction revision — current (2026-10-25)

This revision supersedes the earlier Work Updates disclosure and Sales-only menu.
Use `public/mobile/lib/screen-ux.js` for standard single-choice selects, read-view
refresh and disclosure motion. It enhances native controls rather than replacing
their field values, events, required validation or form serialization. Multiple
selection lists stay native. Menus share an 18px radius, 8px outer padding, 44px
hit targets, 3px inset painted areas and 6px row gaps. Selected/hover backgrounds
are distinct muted fills. Do not add ticks or per-screen dropdown implementations.
Render popups in the shared floating layer to avoid clipping inside editors;
Escape closes the popup before its parent dialog. Handle disabled/async options,
focus, typeahead, outside dismissal, keyboard navigation and reduced motion.

Use mobile V2 spacing/radius/color/motion tokens. The existing RoleUI card helper
shares full-height navigation rails; known warning facts can color those rails,
while unspecified state stays neutral. Sales uses green/open, yellow/pending and
red/outstanding goods without extra marks. Keep exact accessible status names and
record details; the API's backordered flag does not prove a stock shortage.

Keep one visible page title in the shell. Meaningful workflow instructions,
blockers and record identifiers remain. Work contains live tasks and recovery;
stored notices/history belong in Notifications, reached from the existing bell.
Its count is employee-scoped, and a failed badge read is unknown rather than zero.
Do not restore the duplicate Work Updates/history directory or healthy-state
Needs attention/Oldest first/Checked just now introduction.

Use pull-to-refresh for supported read-only lists/overviews, at the scroll boundary
with a threshold and horizontal/short/multi-touch cancellation. Never apply it to
forms, evidence, inspection actions or open dialogs. Keep the keyboard/screen-reader
refresh action and Alt+R without adding per-section visual buttons. Preserve list
filters, single-flight reads, unknown states, existing polling and recovery.

Use shared MApp Back. Owned history identifies a permitted predecessor; a filter
URL replacement must not discard it. Duplicate entries are skipped. An existing
workflow timestamp refresh reloads in place rather than pushing another same-screen
entry. Direct links have permitted, meaningful parent fallbacks. Never infer an
app predecessor from browser history length alone.

Motion: Emil's productivity restraint primary, Jakub's subtle polish secondary.
Menu entry/exit 150/95ms, disclosure 140/90ms and press feedback 110ms, using the
shared custom easing. Only opacity/transform animate. Keyboard and reduced-motion
interactions complete immediately. No new decorative page entrance or pulsing
status effects. The refresh spinner is functional and stops when the read ends.

## Ordinary refresh coverage contract — 2026-10-25 follow-up

The prior shared helper was not a complete migration. Register every ordinary
screen reader explicitly before removing its layout control. The contract is
`mScreenUX.bindRefresh(root, readPromise, availablePredicate)`: root must belong to
the current screen; read must preserve the screen's drafts/selection and resolve
only when its work settles; available must reject active write/capture/decision
phases. An unavailable registered reader must not fall back to a full rerender.
When a nested reader changes availability without another DOM update, call
`mScreenUX.sync()` after its final state change (location registry is an example).

The audited controllers are Approvals, Directory, Clock, Requests, Schedule,
Payslips, time corrections, confidential case detail, low stock, location contents,
item detail and planned-check detail. Work/Home were already on the shared path.
Healthy ordinary Refresh buttons are absent from layout. Native hidden states
must not be overridden by a component's display rule. Keep explicit error Retry
and consequential stock/recount/credential checks; label those checks by their
purpose rather than calling them a general Refresh.

`tests/frontend-mobile-refresh-contract.test.ts` scans all mobile JS button/action
sources for reintroduced ordinary Refresh controls and checks the migrated reader
registrations. Browser verification must check each screen's real state, available
predicate, read endpoint and draft/operation protection. Do not substitute a CSS
text-hiding rule or test only the Work page and call the migration global.


## Overlay layout stability — 2026-10-25

The mobile root reserves its classic scrollbar lane with `scrollbar-gutter: stable`.
Opening/closing a body-scroll-locking overlay must not change card, content,
header or dock geometry. Keep Quick Actions' existing fan/blur/exit motion; do not
animate width to mask a scrollbar-induced shift. Overlay-scrollbar devices reserve
no extra width. A classic scrollbar lane remains on short pages, which prevents
layout differences between short/long or unlocked/locked states.

Verify the whole animation interval with real visible scrollbars. Playwright's
default hidden scrollbars and identical settled before/after screenshots cannot
establish this invariant. Keep the review wrapper's viewport/grid independent of
the app iframe sizes so harness overflow cannot masquerade as an app defect.


## Shared mobile release contract — 2026-10-25

These approved interaction decisions apply to every existing and future mobile
route through shared primitives, rather than copies scoped to Work or Sales.
Bootstrap loads screen-ux.js once and caches it in the v159 mobile shell. Its
observer enhances single-choice selects and disclosures inserted by any route;
multiple-selection lists retain native behavior. The shared CSS token set covers
RoleUI, m-btn and the older m-v2-primary/m-v2-secondary HR button classes, including
keyboard and reduced-motion press behavior. No page-local action radius should
override the shared control radius. Queue/list cards that use RoleUI share the
full-height navigation rail; forms keep their necessary field/action structure.

Standard read refresh uses the shared gesture and accessible alternative, with
explicit screen-state guards; forms and consequential workflow checks are not
converted into automatic reloads. The source-wide regression guards emitted
ordinary Refresh controls across all mobile JS. Shared Back is permission-aware;
status cues retain meaningful units and accessible labels. The shell cloud and
root scrollbar reservation are shared across every mobile route.

The final audit found legacy HR button pills outside the shared action selectors;
those classes now use the same radius, feedback duration and keyboard/reduced-
motion treatment. The approved visual design is retained. Automated coverage is
representative across HR, sales, inventory and production, not a claim that every
screen, physical device or employee task has been observed.


## Stable initial loading and disclosure state — 2026-10-25

Do not mount full Work desk sections until they contain known rows, held work or
an actual error. Use one aggregate loading status for unchecked queues, including
rechecks of a known-empty queue. This prevents empty categories from expanding
and disappearing at tab entry. Keep known records during refresh and continue to
expose errors/unknown states; never substitute a false empty message.

Shared disclosures must read their actual open state when idle because authorized
queue responses can set it programmatically after enhancement. During an active
transition, use its intended target to support rapid reversal. Data arrival and
route entry must not perform decorative disclosure animations. Preserve automatic
opening for genuinely pending Home work and first-tap manual collapse.


## Overview snapshots and warm navigation — 2026-10-25

Use the existing API memory preview cache only for opted-in, validated overview
reads. Home/Work snapshots may render for at most 60 seconds while fresh requests
run; they are not HTTP/service-worker API caching or workflow action authority.
Scope previews to server, token/shared session and mReadScope's full employee/grant
identity. Keep data out of persistent storage, preserve a bounded cache, and fence
late responses against writes, sign-in changes and endpoint access denial.

A denied endpoint loses its own snapshot. Do not discard unrelated permitted
queues for a legitimate denied Inbox badge read. Current permissions must filter
restored sources. Never restore cached zero as a current successfully checked
empty queue. Keep known records and counts visible during checks; reconcile fresh
completion/error states. Details and actions continue to read/check live state.
Measure cold and warm readiness independently from network response completion;
label injected-delay browser timings accurately and retain physical-device limits.


## Guide visibility, card rails and tab canvas — 2026-10-25

The shared guide may open ancestor native details sections to reveal a permitted
control. It must never click a workflow action or reveal a conditional hidden
field. A nonzero bounding box is insufficient: closed details descendants can
have geometry without being painted. Check connection, explicit/CSS visibility,
paint visibility when supported, and viewport intersection before drawing a ring.
Hidden or removed targets lose the ring immediately. Center newly entered targets
without animated scrolling; on narrow viewports keep the coach scrollable above
or below the target so the coach and dock do not hide the actual control. Keep
normal modeless navigation and explicit business actions.

Shared RoleUI cards own their three-column layout and zero outer padding through
selectors more specific than the later role-kit defaults. Do not rely on equal
specificity rules in an earlier stylesheet. The arrow rail spans the full card
height and reaches its right inner border; shared cards and Sales order cards use
--m-ux-rail-width (52px). Unknown workflow status stays neutral. Customer and
Recent sales collections use rk-list's existing 12px gap.

The five primary tab overview roots share the shell's --m-ux-page-max (560px)
canvas and its normal gutters. Avoid nested narrower maximum widths or doubled
horizontal padding on Profile. This is consistent usable content width, not only
matching outer wrappers. The floating dock keeps its separate stable width;
workflow capture forms and active message threads retain their specific layouts.
Verify all five tab content bounds at 320, 390, 768 and 1280px. Tests exercise
ordinary UI navigation, current real components and disposable captured records;
they do not establish physical-device or first-time employee usability.
