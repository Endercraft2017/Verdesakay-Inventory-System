# Mobile layout alignment review — 2026-10-26

The reported kit screen exposed missing internal padding in plain RoleUI cards.
The shared fix is in `public/mobile/layout.css`, loaded before the final action
geometry stylesheet. It supplies a 16px default card inset and page gutter,
block field panels, aligned section headings and shrinkable grid/form content.
Explicit full-bleed arrow/list variants retain their existing layouts.

## Evidence and changes

The baseline browser audit examined 57 registered destination entries and one
populated accepted-kit detail at 390px in dark mode. It found 16 issues:

- Production overflow from its generated, non-wrapping heading.
- Item-search overflow from a full-width select wrapper inside a filter row.
- Edge-touching text in New sale content cards, the nested semi-finishing field
  panel and the populated kit component card.
- Shifted section headings in returns and kit preparation.

Production now uses a real RoleUI heading and wrapping description. Shared
field panels have a block box and safe inset; the stock-kind selector can shrink
inside its row. The kit counter retains equal-sized minus/plus columns, a
shrinkable middle field and its original unsaved-count/stock safeguards.
Long unbroken product and component names wrap inside the card.

Taste Skill's app-screen guidance informed shared grid/form edges rather than
individual offsets. UI UX Pro Max's focused mobile spacing search reinforced
touch spacing and content-driven text reflow. Playwright measured rendered
text/box bounds and exercised the actual application handlers; axe supplemented
the populated-kit interaction checks. Neither token inspection nor axe alone
establishes visual usability.

## Verification

- All 57 registered destination entries at 320, 390 and 560px, light and dark:
  342 route samples, no measured page overflow, card text edge or section
  alignment findings.
- Populated accepted-kit detail at those six width/theme combinations, with
  normal and long record names: no alignment findings. Plus/minus and unsaved
  counts retain real handlers; controls meet the tested 44px target minimum.
- Four relevant mobile test suites: 242 tests passed. TypeScript passed.
- Final portable browser suite: 50 checks passed with 147 source hashes matched,
  no page errors and no external preview HTTP requests. This includes shared
  action geometry, workflow guides, global themes, tab widths/cache, navigation,
  refresh guards and Quick Actions with both scrollbar models.
- Scratch capture uses disposable records and verifies unchanged stock totals;
  business stock writes remain blocked in the portable review.

The route matrix records actual rendered aliases, access/selection/empty states.
It does not mean every populated detail, form state or employee workflow was
tested. This is Chromium evidence, not a physical-device or employee study.

## Sandbox discrepancy

The user supplied `https://otom.afkcube.com/sandbox/m#/guides`. Public static
asset inspection confirmed that server still serves mobile service-worker
version **v163** and the old Guides controller, without the current workflow
modal/library implementation. The reviewed working copy uses **v167**. Refreshing
or clearing browser cache cannot install code that is absent from the server.
The private scratch review and application deployment are separate; publishing
the review does not push or deploy the application.

Machine-readable browser evidence lives in ignored `work/ui-scratch/` and the
baseline matrix in `work/mobile-layout-audit/`. The interactive review includes
the tested source hashes, current results, limitations and route inspector.
