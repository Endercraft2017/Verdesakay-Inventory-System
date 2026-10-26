# Mobile guide destinations, shared theme and native BOM editor

2026-10-26. Candidate working-tree changes; no application deployment or push.

The reported Production Overview step now opens mobile Production control.
Products & BOM opens a native mobile catalog/editor. Authorized employees can
choose an existing item, add/remove components, set whole quantities and notes,
retain a draft, review quantities per finished unit, and explicitly save. Empty
BOMs need a separate acknowledgment. Catalog readers get a read-only definition.
Component selection retains the inventory catalog permission boundary.

BOM saves use the existing API with an optional reviewed-component baseline.
The transaction refuses a different current definition with 409; an identical
already-applied definition can be confirmed after response loss. Concurrent
product removal cannot be mistaken for a saved empty definition. Stock, costs,
checklist assignments and existing job component plans are preserved. Existing
web clients remain compatible and do not gain concurrency protection unless they
supply the baseline. The guard compares content, not an immutable revision ID.

Other permitted web-only guide steps use tenant-relative links checked against
the canonical NAV configuration. Reference/access feedback appears beside the
pressed step; missing employee profiles cannot take a web fallback.

Legacy mobile and RoleUI palettes now alias the canonical v2 palette in both
themes. Departmental metadata no longer colors whole screens or the dock. Paused
states use amber; actual danger remains red. Primary controls share the brand,
foreground and radius. The audit also corrected dark-theme white-on-green text,
the remaining Batch primary override, and item creation field surfaces. Production
with no exceptions says Production status / On track rather than Action required.

## Completed evidence

- `npm run ui:scratch` rebuilt the owned scratch directory from current source.
  Fixture capture uses disposable API/SQLite records; forced document navigation
  prevents partially captured same-document route transitions.
- `npm run test:ui:scratch`: 48 checks passed, 145 source/image hashes verified,
  zero uncaught preview errors and zero external preview HTTP requests.
- Shared theme measurements: 40 route/theme combinations across production,
  QC/QA, receiving, releasing, inventory, notes and employee screens. Primary
  colors, legacy aliases, role tokens, hero surfaces and dock colors are checked.
- Guides: grouped catalog, native modal focus, actual destinations, adjacent
  access feedback, optional compact guidance, missing/failed targets, revoked
  access, draft protection and reduced motion passed.
- Native editor: real Chromium + disposable API/SQLite checks passed for draft
  reload, lost-response recovery across reload, transactional stale-save refusal,
  empty-BOM confirmation, component search and new product setup. Inventory
  quantities and existing job component rows match before/after. Costs remain.
- Browser replay checks passed for Work discoverability, native guide entry,
  decimal rejection, keep-editing guard, read-only access and explicit failed
  reads. Editor axe scans passed in both themes; separate actual-backend editor
  scan also returned zero violations. No physical phone or employee test claimed.
- BOM API suite: 17 tests passed, including write denial, invalid quantities,
  concurrent definition protection and removal. Follow-up mobile/guide/navigation/
  refresh/item suites: 64 tests passed. Bootstrap registry check and TypeScript
  passed. Earlier broader regression coverage is retained in working evidence.

Reproduce through the package commands above, `npx vitest run tests/bom.test.ts`,
`npx vitest run tests/frontend-mobile-work-navigation-ux.test.ts tests/frontend-mobile-workflow-guides.test.ts tests/frontend-mobile-refresh-contract.test.ts tests/frontend-mobile-item-setup.test.ts`,
and `npm run typecheck`.

Screenshots, trace, exact browser report and disposable-backend result are under
ignored `work/ui-scratch/`. Retained command logs are in
`work/global-mobile-theme/`. The preview's verification notes summarize them.
The private Site publishes the tested HTML; its business transport remains
isolated. Sample BOM saves change memory only; reset discards them. Other business
writes and uploads remain blocked. The live-backend browser check is separate.

## Design inputs and limits

Taste Skill app-screen guidance informed task hierarchy and meaningful color.
UI UX Pro Max's focused contrast guidance informed readable foregrounds.
Existing Design Motion Principles guidance informed optional, reduced-motion-safe
guidance. PostCSS traced/replaced competing theme definitions. Playwright, axe,
Vitest and TypeScript verified behavior and implementation. Sites delivers the
same owner-private real-code preview. No new plugin or skill was installed for
this continuation; repository source/license provenance is retained.

This verifies the named representative routes, not every mobile route or device.
No coached/uncoached employee study, real screen-reader session, physical phone,
camera, printer or disconnected site-PC acceptance was performed. Existing shell
limitations under extreme 200% CSS zoom inside an already narrow preview remain
recorded in the preview. Automated checks do not prove first-time comprehension.

## Preview delivery correction

The shared Site root was later republished with the preparation review (version
22), whose Work route intentionally shows an out-of-scope placeholder. That was
a review-delivery collision, not the actual mobile Work module. The tested Work
artifact now lives at `/reviews/work-guides/?screen=work` on the same owner-private
Site. Existing root content is preserved byte-for-byte. AGENTS.md and the Site's
REVIEW-PATHS.md require separate review paths and preservation of other topics.

`node scripts/test-ui-scratch-delivery.mjs` passed real Home → Work navigation
three times at each of 320/390-pixel app canvas widths, plus native BOM and
Production control entry. No uncaught browser errors occurred. The authenticated
HTTPS response at the dedicated path returned 200 and exactly matched the tested
artifact hash; the root still returned the existing preparation review. Evidence
is in `work/global-mobile-theme/work-topic-delivery.json` and
`work/global-mobile-theme/hosted-work-delivery.json`. No application code changed
for this delivery fix, and application changes remain uncommitted.

## Canonical main address correction

The user confirmed opening the main Site URL. The previous delivery change kept
the preparation review at that exact address, so its isolated Work placeholder
remained visible there. The main URL now launches the full Work review. The
preparation review is retained at `/reviews/preparation/`, and pressing its Work
tab hands off to the full Work review through the parent page's source-checked
message listener. The Work artifact and application code remain unchanged.

`scripts/prepare-ui-scratch-site.mjs` preserves topic files and licenses, checks
all 145 Work source hashes, and writes these entry points before Site packaging.
AGENTS.md records the canonical root contract. Delivery checks passed six cases:
main URL, dedicated topic URL and preparation Work tab, each at 320/390-pixel app
canvas widths. Every case completed three Home → Work cycles and opened native
BOM and Production control, with zero uncaught browser errors. The previous
48-check real-code Work validation still applies to its unchanged artifact.

Publication of the canonical-root fix succeeded. Authenticated HTTPS reads of
`/`, `/reviews/work-guides/?screen=work` and `/reviews/preparation/` all returned
200 and exactly matched their locally tested files. The root response contains
the automatic Work launch. Live response evidence is in
`work/global-mobile-theme/hosted-work-root-delivery.json`.
