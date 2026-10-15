# Verdesakay Mobile — Claude Code Implementation Handoff

**Prepared:** 2026-09-26  
**Target repository:** `Endercraft2017/Verdesakay-Inventory-System`  
**Audited branch/commit:** `main` at `61f41a63d576e1e2085241ef5cc16b6089428b2c`  
**Figma file:** https://www.figma.com/design/quipCMr7ChPNSYpzFQCM50  
**Functional design record:** `Verdesakay_Mobile_Design_Progress.md`  
**Supporting specifications:** `docs/guides/mobile-role-ux-spec.md` and `docs/guides/shop-floor-to-delivery-sop.md`

## Current-branch reconciliation (2026-10-13)

This handoff was prepared against `main` on 2026-09-26. Its "current" and "gap" tables below
are historical; check this branch's code and tests before treating an item as unbuilt. The
five-item dock, notification history, movable Quick Orbit, anonymous channel, profile editor,
paid-only payslip download, manager permission, separate QC/QA desks, RTS workflow and releasing
workflow now have implementations. Schedule change is a seeded employee request tied to a future
published roster date; approval updates that day's shift and rejects a stale or paid cutoff.
HR requests and attendance corrections can wait in the account-scoped mobile sync queue; approvals
remain online-only. Chat text is retained as an account-scoped draft on a failed send.

Remaining work from this handoff needs a separate acceptance pass: identified reports still use
Messages as their follow-up channel rather than a dedicated case lifecycle, and each shop-floor
exception path needs end-to-end checks on physical phones, including camera, GPS, poor connectivity,
reconnect, 390×844 layout, accessibility and the precise Figma frames. The planned-vs-built
details in sections 6–16 should be reconciled per screen during that pass.

## 1. What this handoff is for

Use this document as the implementation bridge between the approved mobile Figma design and the existing Verdesakay codebase. It tells Claude Code what to inspect, what already exists, what must change, which Figma nodes are canonical, how the permissions map to the product pipeline, and how to verify the result.

This is not permission to redesign the workflows. Preserve the approved information architecture, business rules, privacy rules, stage order, and audit behavior. If code and the older progress record disagree about what is already implemented, use the audited code as current-state evidence and this handoff as the target mapping.

## 2. Paste this bootstrap prompt into Claude Code

```text
Read these files before changing code:
1. claude_instruction.md
2. docs/modules/catalog.md
3. docs/modules/pipelines.md
4. docs/guides/mobile-role-ux-spec.md
5. docs/guides/shop-floor-to-delivery-sop.md
6. docs/guides/Verdesakay_Mobile_Claude_Code_Handoff.md
7. the linked Verdesakay mobile Figma file and the exact node IDs named in the handoff

Implement the mobile redesign incrementally in the existing vanilla JavaScript/CSS PWA. Do not introduce React, Tailwind, or a second mobile application. Reuse the current API client, hash router, permission checks, scanner, photo, offline queue, location, signature, push, and DOM helpers. Convert Figma output to project-native HTML/CSS/JavaScript.

Before each phase, inspect the existing implementation and tests listed in the handoff. State which existing routes and APIs are being reused, which are being extended, and which are genuinely new. Keep backend permission checks mandatory. Do not make a queued offline action appear server-confirmed. Add or update focused tests for every permission boundary, state transition, finalization rule, privacy rule, and route introduced.

Implement one phase at a time. At the end of each phase run npm run typecheck and the relevant focused Vitest files, then run npm test before declaring the phase complete. Provide screenshots at a 390×844 mobile viewport and compare them against the corresponding Figma nodes.
```

Recommended repository location for this file: `docs/guides/Verdesakay_Mobile_Claude_Code_Handoff.md`.

## 3. Current technical architecture

The application is not a React app. It is a Node/Express/TypeScript server with a standalone vanilla JavaScript mobile PWA.

| Concern | Existing implementation |
| --- | --- |
| Server | Express 4, TypeScript, `server.ts`, `src/app.ts` |
| Database access | Kysely plus shared database helpers under `src/shared/` |
| Validation | Zod schemas in `src/shared/validation.ts` |
| Mobile entry | `public/mobile/index.html`, served at `/m` |
| Mobile router/shell | `public/mobile/app.js`; views register with `MApp.route(name, render)` |
| Styling | Global project-native CSS in `public/mobile/mobile.css` |
| API client | Shared `/public/js/api.js` and mobile `mSubmit`/queue behavior |
| Reusable mobile helpers | `public/mobile/lib/` for DOM, scanner, photos, queue, push, locations, users, signatures, recent data, and print |
| Authentication | Bearer token and `/api/auth/me`; cached identity supports restricted offline reopen |
| Offline writes | Mobile queue with idempotency; action-specific eligibility must remain explicit |
| Tests | Vitest, Supertest, and jsdom; mobile route smoke tests in `tests/frontend-mobile.test.ts` |

Do not install Tailwind merely because Figma returns React/Tailwind reference code. Translate it into the existing DOM-builder and CSS conventions. Do not create a parallel framework shell.

## 4. Canonical product decisions

1. Every employee keeps mobile Clock access. Warehouse and production users do **not** lose Clock in exchange for Scan.
2. Bottom navigation is always Home, Work, Clock, Inbox, Profile. Role scanning is a Work tool or role-aware Quick Orbit action.
3. Work is the execution hub. Home is a short “what matters today” overview.
4. All configured request types are universal, subject to server validation and approval rules.
5. Identified and anonymous reports are separate entry points, storage/queues, and management views.
6. Employees can view their own draft payslips and current timekeeping as watermarked previews. Draft amounts and punches may change; PDF download is available only after HR marks the payslip Paid (updated 2026-10-14 per owner decision).
7. Operational directories and role screens do not expose personal phone numbers or unnecessary personal data.
8. Employees may directly edit only permitted profile/preferences fields. Legal name, birthdate, salary, position, department, employment classification, and other authoritative HR data require an approval request.
9. One employee may hold multiple permissions and sees the union of authorized queues. Completion does not automatically navigate into the next role’s screen unless the same user has that permission.
10. Final operational stage transitions are server-validated, online-only, atomic, auditable, and protected against duplicate/stale submissions.

## 5. Figma source of truth and visual rules

Only these five pages remain in the cleaned Figma project:

1. `00 — Mobile Audit & Foundations`
2. `02 — Components`
3. `03 — Employee & HR`
4. `04 — Warehouse & Inventory`
5. `05 — Production & QA`

The obsolete V1 core page, visual exploration page, captures, duplicate role sets, hidden obsolete frames, and empty placeholder pages were removed.

### Shared shell target

Use `Shared Employee Experience · V2` node `46:515` as the shared board and request individual child nodes for implementation. The high-fidelity Home reference is node `46:519`.

Visual characteristics observed from the approved node:

- 390×844 reference viewport with safe-area-aware content.
- Inter typography; strong 24px page headings, compact 12px support copy, restrained labels.
- Background around `#f7f9f7`; dark green primary text around `#13271b`.
- Rounded, flowing surfaces: approximately 20–28px for major containers, not rigid rectangular cards.
- Dark attendance/action hero with one dominant action.
- Liquid-glass bottom dock: translucent white, roughly 12px backdrop blur, white highlight border, soft elevation, 28px radius.
- Solid readable surfaces for forms, payroll, reports, tables, and confirmations. Glass is limited to persistent navigation and compact floating controls.
- Notification bell in the header with an unread indicator.
- Movable Quick Orbit with a visible drag grip; universal actions are New Request, Report Issue, and New Message.
- Role accents are restrained and do not replace the common shell: green Warehouse/RTS, blue Production/Releasing, teal QC, warm gold QA, orange Parts Clerk.

### Design extraction procedure

For every screen being implemented:

1. Request Figma design context for the exact node ID and include its screenshot.
2. If Figma returns sparse metadata, request the visible child frame rather than implementing from the sparse parent.
3. Treat generated React/Tailwind only as dimensional/reference output; convert it to vanilla JS and `mobile.css`.
4. Download every required static icon/asset to the repository. Never ship temporary Figma asset URLs.
5. Reuse existing code assets or open-source icons only when they are exact visual/semantic matches.
6. Render at 390×844 and compare spacing, hierarchy, states, icon geometry, and safe-area behavior to the screenshot.

## 6. Shared employee screen inventory

The V2 board contains 17 screens:

1. Home / Today
2. Work Hub
3. Clock / Select Action
4. Schedule
5. Request Center
6. New Request / Overtime
7. Request Detail
8. Reporting Hub
9. Identified Report
10. Anonymous Report
11. Inbox
12. Conversation
13. Notifications
14. Payslips
15. Payslip Detail
16. Profile & Settings
17. Quick Orbit / Expanded

### Existing shared functionality to preserve

| Feature | Existing mobile route/code | Existing backend |
| --- | --- | --- |
| Home | `#/home`, `modules/core/home.js` | `/api/me/today`, inventory/order/job-order summaries |
| Work | `#/work`, `modules/hr/work.js` | Existing orders, repairs, job orders, deliveries APIs |
| Clock | `#/clock`, `modules/hr/clock.js` | `/api/hr/clock/my-status`, `/api/hr/clock/punch` |
| Schedule | `#/schedule`, `modules/hr/schedule.js` | `/api/me/schedule` |
| Requests | `#/requests`, `modules/hr/requests.js` | `/api/me/request-types`, `/api/me/requests`, `/api/form-records` |
| Time correction | `#/time-fix` | `/api/me/time-corrections` |
| Inbox | `#/inbox`, `modules/core/inbox.js` | messages/conversations/read/reaction APIs |
| Payslip viewing | `#/payslips`, `modules/hr/payslips.js` | `/api/me/payslips` |
| Settings | `#/settings`, `modules/core/settings.js` | theme, push, password, logout |
| Identified operational report | `#/report-problem` | `/api/identified-reports`: private numbered cases, status, history, evidence and follow-up |
| Approvals | `#/approvals`, `modules/hr/approvals.js` | `/api/me/approvals` and decision endpoints |

### Shared gaps that require implementation

| Gap | Required treatment |
| --- | --- |
| Stable five-item navigation | Replace the current role-dependent action tab. Clock remains the center destination for warehouse users too. Production/Scan moves into Work and Quick Orbit. |
| Dedicated notifications screen | Add a mobile route and UI that consumes existing push/event data or a new scoped notifications endpoint. Inbox remains conversations/broadcasts. Deep-link each event. |
| Movable Quick Orbit | Add drag, snap-to-edge, safe docking, per-user/device persistence, keyboard collapse, focused-form suppression, labeled arc expansion, and role action prioritization. |
| Reporting Hub | Separate identified reporting from anonymous reporting. Do not implement anonymity as a checkbox. |
| Identified case tracking | Implemented as private numbered cases with reporter/recipient/assignee access, status, history, evidence and follow-up on mobile and web. Mobile keeps the unfinished report draft. Validate the complete handoff on a real phone and desktop. |
| Anonymous reporting | New isolated backend model and endpoints are required. Do not store `reported_by`; minimize request metadata; use separate numbering, queues, filters, management view, rate limits, and optional confidential code/passphrase. Warn that attachments can identify the reporter. |
| Profile editing | Current Settings has theme, notifications, password, and logout but no controlled profile editor. Add permitted direct-edit fields and a separate information-change request for authoritative fields. |
| Payslip finalization/download | `/api/me/payslips` currently returns payroll form records without enforcing a finalized-only download contract, and the mobile detail has no download action. Add explicit release/finalization state and an authenticated file endpoint. Never infer finalization from mere record existence. Log downloads. |
| Directory privacy | Audit `/api/users` and mobile directory serialization. Return only approved work identity fields; never send phone, personal email, address, salary, birthdate, or statutory data to the client. |
| Shared screen states | Every primary screen needs loading, empty, cached offline, pending sync, retry, conflict, permission revoked, validation, submitting, success, and expired-session behavior. |

## 7. Permission model: current code is ahead of the older record

The historical note in section 19 of `Verdesakay_Mobile_Design_Progress.md` says narrow roles were absent. That note is superseded by the audited `main` branch. Do not re-create this work.

`src/shared/permissions.ts` currently defines:

| Role | Narrow permission | Current mobile responsibility |
| --- | --- | --- |
| `parts_clerk` | `production.repairs` | Accept/reject repair-parts requests |
| `production_lead` | `production.record` | Accept job order, record units/progress/scrap |
| `qc_inspector` | `production.inspect_qc` | Technical first-pass inspection |
| `qa_inspector` | `production.inspect_qa` | Final QA pass |
| `receiving_clerk` | `production.receive` | Products In / RTS stock entry |
| `releasing_clerk` | `orders.release` | Release allocated sale-order units |

All narrow roles also receive `inventory.view`, `inventory.mobile`, and baseline messaging as appropriate. Broad `inventory.adjust` remains an override for authorized management/warehouse accounts. Preserve the stage-specific backend checks; hiding a button is not authorization.

## 8. Product pipeline and stage contract

Canonical success path:

`Parts Released → Production In Progress → QC Technical Check → QA Appearance Check → RTS Awaiting Record → Stock Ready to Sell → Warehouse-Out`

Branches include shortage/block, production scrap, QC repair/reinspection, QA rectification/recheck, RTS identity/location exceptions, and Releasing authorization/allocation blocks.

Each stage transition must create immutable audit evidence containing unit/job, source stage, destination stage, actor, timestamp, source record, and reason/evidence where applicable. Inventory effects and stage changes commit atomically. Corrections use compensating records, not deletion.

## 9. Role screen inventory and code mapping

### Warehouseman — `inventory.adjust`

Figma nodes: `62:14` Release Queue, `62:79` Verify Kit, `62:150` Confirm Release, `62:205` Short Stock, `62:264` Escalate Shortage, `62:317` Released Handoff, `62:372` Scan Shortcut.

Reuse `public/mobile/modules/manufacturing/job-orders.js` and `src/modules/manufacturing/job-orders.routes.ts`. Existing release is all-or-nothing and already records release provenance. Decompose the current detail into the guided queue → verify → confirm → result/shortage flow. Add a tracked escalation rather than a generic toast/message if the backend does not already retain it.

### Production Lead — `production.record`

Figma nodes: `66:14`, `66:79`, `66:133`, `66:185`, `66:240`, `66:294`, `66:356`, `66:408`, `66:462`.

Reuse job-order accept, progress, unit recording, scanner, and photo support. Recording remains blocked until kit acceptance. Serialized rows require identifier and finished-unit photo. A network interruption must distinguish server-saved units from unsent local rows and must never duplicate saved units. Scrap never enters QC.

### Production Manager — separate permission decision required

Figma nodes: `66:515`, `66:580`, `66:650`.

Current broad accounts use `inventory.adjust` for pause/resume/close and wider production visibility. The approved product decision says Production Manager should receive Lead capabilities plus controlled manager actions, while Parts Clerk stays separate. Prefer an explicit manager permission/role if the repository does not yet have one; do not silently grant broad inventory adjustment to ordinary leads. Pause/resume/close-early require reasons and audit history.

### QC Personnel — `production.inspect_qc`

Figma nodes: `69:16`, `69:68`, `69:104`, `69:145`, `69:197`, `69:247`, `69:286`, `69:323`, `69:364`, `69:397`, `69:436`, `69:478`.

Reuse `public/mobile/modules/manufacturing/qc.js`, `/api/job-orders/:id/units/inspect`, QC checklist APIs, production record lookup, repair requests, scanner, and photo helpers. The server already distinguishes QC from QA for two-stage jobs. QC owns technical/performance checks. Required checklist items block Pass. Repair preserves history and returns to targeted reinspection; terminal failure requires explicit disposition and evidence policy.

### QA Personnel — `production.inspect_qa`

Figma nodes: `72:16`, `72:68`, `72:104`, `72:145`, `72:197`, `72:246`, `72:285`, `72:322`, `72:363`, `72:396`, `72:435`, `72:477`.

The current UI shares the QC route, but the redesigned UX must present a distinct QA queue and QA-specific appearance/completeness workflow. Reuse the same backend inspection endpoint only where its data model cleanly preserves stage identity and separate checklists. QA must not overwrite or repeat QC. Passing QA routes to RTS; rectification preserves the original QA result and later creates a recheck.

### Parts Clerk — `production.repairs`

Figma nodes: `83:16`, `83:68`, `83:109`, `83:158`, `83:206`, `83:247`, `83:295`, `83:332`, `83:375`, `83:416`, `83:452`, `83:488`.

Reuse `public/mobile/modules/manufacturing/repairs.js` and `/api/production/repairs`. Existing endpoints support requested queue plus accept/reject and stock issue. Extend them only as needed for context verification, reservation/source constraints, shortage state, formal revision, exact SKU scan, and richer audit history. A Parts Clerk cannot release initial BOM kits, perform arbitrary adjustments, approve their own substitute, or issue more than approved.

### RTS Clerk — `production.receive`

Figma nodes: `74:16`, `74:68`, `74:104`, `74:145`, `74:186`, `74:234`, `74:280`, `74:316`, `74:356`, `74:399`, `74:442`, `74:483`.

Reuse `public/mobile/modules/manufacturing/receiving.js`, `/api/job-orders/:id/receivable`, `/api/job-orders/:id/products-in`, locations, and production record lookup. Rename user-facing “Products In” to the approved RTS language where appropriate, without breaking API compatibility. Add duplicate prevention, location capacity/integrity validation, read-only stock lookup, and a controlled mismatch report. Grouping is only an input convenience; each serial keeps its own transaction.

### Releasing Personnel — `orders.release`

Figma nodes: `78:16`, `78:68`, `78:109`, `78:147`, `78:188`, `78:240`, `78:281`, `78:317`, `78:365`, `78:401`, `78:438`, `78:481`.

Reuse `public/mobile/modules/inventory/so.js`, `/api/orders?type=sale`, order detail, release/unreserve endpoints, scanner, signatures/photos where policy allows, and delivery context. Add guided authorization, allocation-bound serial verification, package checklist, minimum-necessary recipient identity, token/QR validation, evidence, blocked states, and explicit partial-release authorization. Final warehouse-out is online-only and atomic. Wrong serial, incomplete allocation, revoked authorization, or missing package item must make zero inventory movement.

## 10. Existing backend and test evidence to inspect before edits

Read these files instead of guessing:

- `src/shared/permissions.ts`
- `src/modules/manufacturing/job-orders.routes.ts`
- `src/modules/manufacturing/production.routes.ts`
- `src/modules/manufacturing/qc.routes.ts`
- `src/modules/inventory/orders.routes.ts`
- `src/core/me.routes.ts`
- `src/modules/hr/clock.routes.ts`
- `src/modules/hr/hr.routes.ts`
- `src/core/messages.routes.ts`
- `src/core/push.routes.ts`
- `src/core/bug-reports.routes.ts` (software bug reporting is not the anonymous HR/operations channel)
- `src/shared/validation.ts`
- `src/shared/db-types.ts` and migrations in the database bootstrap path
- `tests/frontend-mobile.test.ts`
- `tests/production-roles.test.ts`
- `tests/job-order-accept.test.ts`
- `tests/job-orders-qc.test.ts`
- `tests/production-receiving.test.ts`
- `tests/order-release.test.ts`
- `tests/repairs.test.ts`
- `tests/clock.test.ts`
- `tests/me.test.ts`, `tests/me-approvals.test.ts`, and `tests/hr-pending-requests.test.ts`

## 11. Recommended implementation phases

### Phase 0 — baseline and contracts

- Create a feature branch.
- Run `npm run typecheck` and `npm test` before edits.
- Record current screenshots and route inventory.
- Update `docs/modules/catalog.md` and `docs/modules/pipelines.md` only for confirmed new interfaces/stages; mark planned work honestly.
- Define shared stage/status constants and a UI-label mapping. Do not scatter magic strings.

### Phase 1 — shell and design system

- Implement V2 tokens, typography, spacing, surface radii, role accents, icon wrappers, statuses, empty/error states, and safe areas in `mobile.css`.
- Refactor mobile chrome to the stable five destinations.
- Add notification bell/deep-link entry.
- Implement Quick Orbit behavior and accessibility.
- Keep the old routes working while the shell changes.

### Phase 2 — shared employee experience

- Home, Work, Clock, Schedule, Request Center/detail, Inbox/conversation, Notifications, Payslips/detail, Profile/Settings.
- Add finalized-only authenticated payslip download.
- Add controlled profile direct edits and approval-required information changes.
- Add Reporting Hub, identified case tracking, and isolated anonymous channel.
- Verify no private directory fields reach the client.

### Phase 3 — Warehouse and Parts Clerk

- Implement Warehouse nodes `62:*`.
- Implement Parts Clerk nodes `83:*`.
- Preserve separate permissions and all-or-nothing stock rules.
- Add shortage/escalation/revision states only with backend audit support.

### Phase 4 — Production Lead and Manager

- Implement Lead nodes `66:14` through `66:462`.
- Implement manager nodes `66:515`, `66:580`, `66:650` after the explicit manager permission is settled.
- Verify partial network recovery and photo/identifier requirements.

### Phase 5 — QC and QA

- Separate route presentation and queue language while reusing common inspection primitives.
- Implement all `69:*` and `72:*` screens.
- Keep technical QC and appearance/completeness QA records distinct.
- Test two-stage permission enforcement, reinspection, and rectification.

### Phase 6 — RTS and Releasing

- Implement all `74:*` and `78:*` screens.
- Add duplicate, location, allocation, authorization, package, and partial-release guards.
- Verify atomic stock/stage writes and concurrency behavior.

### Phase 7 — integration and rollout

- End-to-end tests from kit release through warehouse-out, including every exception branch.
- Offline/online transition tests and stale-submit tests.
- Accessibility, keyboard, touch target, reduced-motion, light/dark, and 390×844 visual checks.
- Service-worker/cache version update so old mobile assets do not mask the deployment.
- Update user guides and pipeline docs with only implemented behavior.

## 12. Component strategy

Build reusable project-native primitives rather than duplicating 79 role screens:

- `AppHeader`: title, role chip, notification indicator, sync state.
- `BottomDock`: stable five-item liquid-glass navigation.
- `QuickOrbit`: movable dock plus labeled action arc.
- `QueueSummary`, `QueueFilters`, `QueueItem`.
- `StatusPill`, `RoleChip`, `PriorityIndicator`.
- `StageHeader` and read-only `HandoffContext`.
- `ChecklistSection`, `ChecklistItem`, `EvidenceCapture`.
- `ScanOrSearch`, using the existing scanner helper.
- `ReviewEffect`: clearly states inventory/workflow consequence.
- `ConfirmBoundary`: online validation, acknowledgement, idempotency, stale-state handling.
- `CompletionReceipt`: reference/transaction, actor, time, next responsible role.
- `BlockedState`: what failed, confirmation that no stock/stage movement occurred, resolution owner.

In vanilla JS these may be DOM factory functions under `public/mobile/lib/` rather than framework components. Keep business API calls in route modules and presentation primitives free of hidden mutations.

## 13. Data, security, and concurrency requirements

- Authorize every read and write server-side using explicit permissions.
- Scope employee self-service records to the linked employee/user.
- Treat UI role chips as context, never security.
- Use request idempotency keys for retryable writes.
- Final stage writes must re-read current unit/order/request state inside the transaction.
- Return a structured `409` on stale state, including current stage and responsible role.
- Do not queue stock-changing final confirmations offline. Local drafts may be retained without changing business state.
- Store evidence under the same authorization boundary as its source record.
- Never put phone numbers or sensitive HR/payroll content in push-notification text.
- Anonymous reports must not join to identified reports by default and must not write the authenticated user ID into the report payload/model.
- Payslip files require authenticated, employee-scoped access and finalized status at request time.

## 14. Required acceptance tests

### Shell/shared

- Every employee sees Home, Work, Clock, Inbox, Profile.
- Warehouse users still see Clock; Scan is available through Work/Quick Orbit.
- Quick Orbit cannot cover bottom navigation, the keyboard, submit controls, or destructive confirmations.
- Notification deep links open the correct record and respect permission revocation.
- Direct profile edits cannot change authoritative HR fields.
- Information-change requests do not alter the profile before approval.
- Draft/in-progress payslips cannot be downloaded; finalized payslips can; access to another employee’s file is denied.
- Anonymous submissions have no reporter identity and do not appear mixed into the identified-report queue.
- Directory payloads contain no private contact/HR/payroll fields.

### Pipeline permissions

- Parts Clerk cannot release initial kits or perform broad adjustments.
- Production Lead cannot pause/cancel/close unless separately granted manager access.
- QC-only users cannot perform QA pass; QA-only users cannot perform QC first pass on two-stage work.
- RTS cannot change controlled production identity or repeat QA.
- Releasing cannot substitute a unit allocated to another order.
- Multi-permission employees see the union of queues without bypassing stage prerequisites.

### Pipeline integrity

- Kit release is all-or-nothing; shortage deducts nothing.
- Production recording is blocked until acceptance.
- Identifier/photo validation prevents incomplete serialized records.
- Saved units are not duplicated after partial network failure.
- QC repair and QA rectification preserve prior history.
- Parts issue stock deduction and request state update are atomic.
- RTS duplicate posting and invalid locations make zero stock change.
- Warehouse-out, allocation fulfillment, unit stage, and inventory movement are atomic.
- Duplicate, stale, or simultaneous final submissions produce one result and a clear conflict for the loser.

### Visual/accessibility

- Compare each implemented screen to its Figma screenshot at 390×844.
- Minimum 44×44 touch targets for primary interactive controls.
- Focus order, labels, status text, and errors work without color alone.
- Respect safe areas and keyboard resizing.
- Light/dark themes remain readable; glass surfaces retain contrast.
- Reduced-motion users can operate Quick Orbit and screen transitions.

## 15. Definition of done for each screen

A screen is complete only when:

1. Its exact Figma node was retrieved and visually compared.
2. It uses repository-native JS/CSS and shared primitives.
3. Loading, empty, error, offline/draft, conflict, submitting, and success states are handled where applicable.
4. Permission and ownership are enforced by the backend.
5. Every action has a defined API contract and audit result.
6. Relevant focused tests pass.
7. The route is included in the mobile bootstrap smoke test.
8. No temporary Figma URLs, mock-only production data, leaked personal information, or silent failures remain.
9. The service worker/cache manifest includes changed assets.
10. Documentation describes actual behavior, not planned behavior.

## 16. Known design-to-code cautions

- The shared board node `46:515` is too large for one high-fidelity extraction; request child screen nodes individually.
- Figma reference output may use absolute positioning. Translate it into responsive, content-safe layout except where fixed chrome is intentional.
- The existing mobile shell currently chooses Scan instead of Clock for warehouse users. This is intentionally changed by the approved design.
- The current QC mobile module combines QC and QA presentation. The backend permissions are already split; the target presentation and checklists are also split.
- Current “Products In” behavior is the backend foundation for RTS, but the approved UX adds a separate QA handoff, duplicate/location checks, and explicit Ready-to-Sell semantics.
- Current identified “Report a problem” is a staff message, not the full tracked report/case design.
- `src/core/bug-reports.routes.ts` is for software bug reports and is not an anonymous HR/operations reporting channel.
- Do not expose broad `inventory.adjust` simply to make a narrow role screen work. Extend the specific permission gate when the business responsibility is narrow.

## 17. Delivery format expected from Claude Code

For each phase, require:

- Files changed and why.
- Existing APIs reused, APIs extended, and migrations added.
- Permission matrix impact.
- Test commands and results.
- 390×844 screenshots labeled with the matching Figma node IDs.
- Remaining gaps, explicitly marked as planned rather than implemented.

Do not accept “looks close” as verification for the shell, role queue, primary task screen, confirmation boundary, blocked state, and completion state of each role.

## Follow-up: final release, delivery and mobile access (2026-10-16)

Final release now uses `inventory/release-handoff.js`: scoped persistent evidence,
keyed uploads before slip issuance, immutable final request and explicit unknown-result
recovery. Delivery uses `inventory/delivery-recovery.js` for the same persistence and
authority-state rules on start and POD. Its evidence remains optional and a linked
delivery may start before the slip, per owner decisions. The driver screen does not
offer a force-backorder completion action. PWA cache v104 includes both modules.

Operational route access is centralized through `MApp.canOpen`, combining effective
account permissions and module entitlements. Work/production tiles and Quick Orbit
use this policy; a basic employee retains personal tools and cannot open operational
screens by URL. Foreground/focus/reconnect refresh account permissions from the server.

The exact handoff at `6185481` was reconciled against code; see
`docs/reviews/mobile-handoff-6185481-review.md`. Legacy Pick retirement, semi-built
finishing intake, returns/disposition, allocation undo, build-state stock movement,
procurement context and other follow-ups there are separate unfinished work.
