# Public marketing and acquisition

This change extends only the public website sourced from deployed commit 5b742ca.
Desktop/mobile app behavior and login/MFA APIs are unchanged. The website now leads
with a proposed HR review, module readiness, assisted setup and a static AFK3 contact
fallback. Dynamic Accounting choices are labeled WIP and initially unselected; signup
availability remains server-controlled. No new runtime dependency was added.

`website/lead-context.js` retains the first valid bounded campaign/referral codes in a
session and decorates allowlisted marketing links. With storage unavailable it keeps
this page's codes in links and the submitted message. Contact appends workflow and
source blocks to the existing server-supported message with a 2000-character total
limit; buyer text is retained on validation/provider errors. Public provenance is an
unverified claim, not authority to pay a commission.

Pipeline: prospect/referral → public page/readiness → existing contact dialog or static
AFK3 fallback → existing /site/inquiry → owner qualification → task demonstration →
separately accepted scope and payment. A success acknowledgement proves neither owner
inbox receipt nor an attended demo. Proposed referral terms stay with AFK3.

Validation: tests/website-acquisition.node.mjs exercises DOM and mocked API behavior.
Run with `node --test tests/website-acquisition.node.mjs` after installing existing dev
dependencies. These are not browser layout, payroll or live production acceptance tests.
Real screenshots, hosted mobile/keyboard/reduced-motion checks, owner queue receipt,
external mail and buyer comprehension are still release gates. Authenticated read-only
inspection succeeded on 27 October 2026. Genuine local-source product captures now
provide the manual screen gallery described below.

Copy refinement: the homepage now describes the buyer’s HR demo and pilot checks in plain language instead of exposing internal source-inspection terminology. End-to-end validation remains explicitly pending; the demo agenda remains labeled as an agenda, not screenshots. No product readiness status or API contract changes.

Local browser verification (27 October 2026): Chromium at 1440/390 passed homepage and open contact/login axe checks after CSS contrast fixes. Native modal keyboard/return focus, invalid-input and aborted-network recovery, reduced motion, config failure and no-JS static contact were checked. Only /site/config was synthetic; inquiry delivery and ERP workflows were not tested. Ten isolated DOM/API tests pass. Hosted and target-user validation remain pending.

GitHub design references reviewed: Motion (motiondivision/motion, LICENSE.md MIT, vanilla JavaScript support) is the candidate for future multi-screen orchestration. Animate.css currently carries Hippocratic 2.1 terms; Hover.css documents separate commercial terms. Neither was vendored. W3C aria-practices dialog-modal examples informed keyboard review. The first copy pass kept 150ms CSS feedback only; the visual refinement below adds explicit one-shot browser-native motion. No runtime package was added for effects that existing CSS already supplies. Genuine product-screen animation waits for verified, safe product capture.

## Visual and interaction refinement

`website/experience.js` progressively enhances the clearly labeled public demo planner. Visitors choose Attendance, Kiosk or Payslips, review a checklist, and explicitly transfer that topic into the existing contact form. It preserves a visitor-edited workflow field, has no network or tracking code, and reads no product/auth data. Existing login and contact API behavior is unchanged. Native details groups optional modules; it is expanded without the enhancement script. The existing readiness table keeps explicit semantic roles and becomes stacked cards at mobile widths.

Motion uses the native Web Animations API plus IntersectionObserver (same composition pattern as Motion's inView example), not a new package: 420ms one-shot entrances, 220ms user-selected panel changes, transform/opacity only. Initial content is visible, and runtime reduced-motion changes cancel running animations. No autoplay carousel, scroll hijack or fabricated app screens.

Research: https://motion.dev/examples/js-scroll-triggered ; https://motion.dev/docs/inview ; https://web.dev/articles/animations-guide ; https://web.dev/learn/accessibility/motion . These sources inform original code; no preset source was vendored.

Verification: the existing ten isolated DOM/API tests pass. `tests/website-experience.browser.mjs` adds real Chromium checks for selection, keyboard interaction, brief prefill and edit retention, optional scope, mobile readiness visibility, zero axe violations/overflow/page errors, no-JS/script-failure fallback and runtime reduced-motion cancellation at 1440/390. Local /site/config is synthetic and inquiry requests are aborted; this is not ERP or inbox validation. Run with `node tests/website-experience.browser.mjs`; set CHROMIUM_EXECUTABLE if using a non-default browser and OTOM_VISUAL_OUT to choose the evidence directory. Existing Playwright and axe-core dev dependencies are reused. Full ERP suite and hosted measurements remain pending.

## Secondary operations positioning

Owner direction retains HR as the lead and explicitly highlights Warehouse/inventory, Production and Sales as visible secondary evaluation areas. These cards are outside the optional disclosure and each prepares a scoped demo topic in the existing contact form without replacing an edited brief. Sales is a source-defined separate entitlement sharing Inventory stock data (catalog Sales section); it is not treated as Accounting or assumed production-ready. Inventory and Production are no longer duplicated in the optional list; Purchasing remains separate. Live workflow verification is pending across all three secondary areas.

## Authenticated sandbox evidence — 27 October 2026

The owner confirmed the sandbox contains only testing data and authorized its inspection
and capture. TinyFish successfully reused the owner's saved browser session. Its bounded
read-only run completed in 22 steps; no business records or settings were changed.
Private run links and browser-session identifiers are intentionally excluded.
These are browser-agent observations, not a payroll correctness test or independently
reviewed screenshot artifacts. A completed automation does not establish every reported
control works or that a viewport is responsive.

| Area | Observed in this run | Claim limit / next evidence |
| --- | --- | --- |
| Dashboard | Authenticated application navigation and synthetic inventory/restock summaries loaded. | Shows the dashboard exists; no uptime or business outcome claim. |
| Timekeeping | Cutoff list loaded; an existing synthetic HR-UAT cutoff was opened. | Read-only navigation verified; no new correction or approval was performed. |
| Kiosk | Device-approval screen loaded. Current browser is not an approved kiosk. | No attendance punch performed; do not imply a completed kiosk workflow. |
| Payroll | Synthetic payroll period and two-payslip summary loaded, including a negative-net warning. | Review screen observed; no calculation reconciliation, payment, export or statutory check. |
| Warehouse / inventory | Synthetic item list and location/category/department/supplier filters loaded. | No receiving, stock movement or quantity validation performed. |
| Production | Job-order table loaded with draft, cancelled and released synthetic jobs. | Existing status display observed; no production-stage transition or kit release completed. |
| Sales | Pipeline board loaded with two synthetic orders in CSR review. | No order-to-release or stock-reservation workflow completed. |
| Mobile web | `/sandbox/m` home, work queues and bottom navigation loaded. | Administrator account lacks a linked employee record; employee time clock/payslip tasks and physical-device behavior remain unverified. |

The live-browser connector returned no downloadable image files. The owner's requested
local source rebuild resolved this export blocker, as described below. Do not publish
credentials, browser state, tokens or private run access links.

Historical source evidence is also available in `docs/reviews/hr-sandbox-acceptance.md`
(10 October 2026): it records earlier API/browser checks of synthetic HR workflows and
states their limits. Those are prior repository results, not rerun by this marketing
inspection. They do not replace a current guided buyer demonstration or pilot checks.

## Local source screenshots and manual gallery

The real application was reconstructed from deployed source `5b742ca1930f1a7061afb27d1ff61a4837c16419`, verifying retrieved files against their Git blob hashes. The existing disposable editor server runs the actual `createApp()` handlers with fresh temporary SQLite databases and upload/tenant directories. Production configuration, live credentials and live data were absent.

Eleven real API checks covered four fictional employees, a five-day cutoff with one missing time-out, four unpaid draft payslips, employee linkage, a three-component BOM, nonnegative and exact stock after kit release, production progress of two of four units, an open sales order, and a normal employee's access to only their own draft payslip. No stock overrides, payment marks or production calls were used.

Playwright captured the actual source-rendered desktop app at 1440×960 and a normal employee mobile view at a 390×844 viewport / 780×1688 pixels. All nine captured screens loaded without page exceptions, HTTP errors or external requests. Six WebP files are format conversions of these screenshots, without UI repainting: attendance, draft payroll, warehouse inventory, production job detail, sales pipeline and employee mobile home. The kiosk's unavailable physical camera view is excluded from the gallery.

`Inside OTOM` keeps HR first and presents Warehouse, Production and Sales as secondary manual choices. Each selection updates the real static screenshot, caption, full-image link and inquiry-topic prefill while preserving visitor edits. Pointer selection uses a 220ms opacity transition; keyboard and reduced-motion selection are instant. There is no autoplay. The first image and direct image links remain without JavaScript; preload failures retain the previous accurate image and caption. Images are labeled `Local demonstration · synthetic data` and do not establish production payroll correctness, real camera behavior or live operational readiness.

