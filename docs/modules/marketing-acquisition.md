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
external mail and buyer comprehension are still release gates. No screenshot qualifies
yet because the live authenticated sandbox task could not be completed.

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
