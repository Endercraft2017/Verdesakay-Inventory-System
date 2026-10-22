# Mobile live attention and handoff integration validation

Date: 2026-10-20. Branch: `restructure/module-architecture`.
Base: upstream `0400314`; candidate cache v139. Committed source; deployment is separate.

Work now shows live attention records together with unread updates. Selecting a
record opens read-only current details, followed by its permitted workflow. Both
queue membership and effective access are rechecked before continuation. The
original permission-scoped queues remain available below the feed. Stored notices
have a history entry; push taps use the same current-detail gate for supported
operational destinations. Failed live sources display unknown counts.

The integration also includes independent QC/QA desk checklists and payloads,
Sales pipeline/customer follow-up, customer editing, explicit partial-release
authorization, warehouse read-only tracking with server commercial-field filtering,
subassembly draft acceptance and catalog kind filters. Existing PR work is aligned
with separate approval, cash-issuance and settlement permissions.

## Executed checks

- `npm run typecheck` — passed.
- Focused Vitest run — 192 passed across mobile bootstrap/personal behavior,
  sale commercial visibility, QC inspection, job orders/subassemblies, route
  permissions, RTS recovery and internal purchase requests.
- `node scripts/test-mobile-attention.mjs` — 16 passed against a disposable real
  Express/SQLite server in Chromium at 390×844. Covers mixed custom grants,
  task/detail/action navigation, task completion elsewhere, QA first, no RTS after
  one pass, duplicate desk refusal, server price filtering, CSR/customer changes,
  distinct financial grants, revocation, unavailable queues, linked child draft,
  explicit partial-trip authorization, Sales disabled, stale push, leaving a slow
  form and catalog filters. No JavaScript errors or horizontal overflow.
- `node scripts/test-mobile-purchase-requests.mjs` — 13 passed. Covers durable
  draft/photo/PDF recovery, lost create/upload/close responses with original keys,
  exact buyer ownership, actual spending, cash/change/reimbursement limits and no
  inventory changes. Uses combined financial grants for the complete lifecycle;
  the attention suite separately checks narrowly granted financial accounts.
- `node scripts/test-mobile-work-guide.mjs` — four account/permission checks
  passed; 40 administrator entries explained; no JavaScript errors.
- `node scripts/test-mobile-legacy-intake.mjs` — seven passed. Covers QC first,
  both inspections before RTS, restart/response-loss recovery, printable QR and
  virtual camera sticker scan, with exactly one stock receipt.
- JavaScript syntax checks and `git diff --check` — passed.

Evidence is generated in ignored local `work/mobile-attention/`,
`work/mobile-purchase-requests/`, `work/mobile-work-guide/` and
`work/mobile-legacy-intake/`, including report JSON and screenshots. These are
local test artifacts, not a deployment or a claim of physical-device acceptance.

## Scope and limits

The tests use disposable local data; they do not change operational sandbox
records. The Sales-disabled browser case supplies a restricted module profile to
exercise phone guards. Backend route permissions have separate regression checks.
The legacy camera test decodes actual generated QR artwork through a virtual
camera; it is not a physical printer/phone test. Site-PC synchronization and all
possible cross-device races are not exhaustively re-tested by this batch.

Sales order creation starts with the server's supported `open` status. Editing
an existing open sale here changes customer/notes and preserves its line items.
Creation, customer changes and authorization use durable original-attempt recovery.
Physical release continues through the existing scanning, allocation and trip-slip
workflow; approval or a partial-release report does not post stock-out.


## Push integration

Before pushing, integrated upstream `0813346` and its employee-request, authored
guide, financial-permission and Sales follow-up changes. The live attention
pipeline remains the canonical `sales` screen; upstream `sales-service`,
`sales-order` and `sales-new` routes remain available without registering a
second competing pipeline. Retained desk-scoped inspection drafts and explicit
inspection stages, added both desk results to unit cards, and bumped the merged
mobile shell cache to v139. Rechecked the merged code with TypeScript, focused
mobile/API regression tests and the 16-scenario attention Playwright suite.


## Home preview follow-up — candidate v140

The expanded Playwright suite passed 19 scenarios, including real pending parts
requests, kit release, independent QC and QA queues, and RTS eligibility after
both passes. Home shows only granted desks, works without an HR employee link,
opens the existing current-detail gate, removes revoked duties, and reports a
failed queue read as unknown. The suite also checks stale Home cards and 390px
layout. Screenshots are in the same ignored local evidence directory:
`home-pending-work.png`, `home-parts-release.png`, `home-rts-receiving.png`.
TypeScript and 152 mobile regression tests passed. No operational sandbox data
was changed.


The later candidate v141 focused audit supersedes the original generic count and
coupled-loading behavior described above. See `mobile-home-preview-audit.md` for
independent database/API/UI assertions, reproduced baseline defects and limits.
