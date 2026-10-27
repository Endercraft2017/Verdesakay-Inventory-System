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

GitHub design references reviewed: Motion (motiondivision/motion, LICENSE.md MIT, vanilla JavaScript support) is the candidate for future multi-screen orchestration. Animate.css currently carries Hippocratic 2.1 terms; Hover.css documents separate commercial terms. Neither was vendored. W3C aria-practices dialog-modal examples informed keyboard review. Existing native CSS 150ms opacity feedback remains the single motion approach; reduced-motion disables transitions. No runtime package was added for effects that existing CSS already supplies. Genuine product-screen animation waits for verified, safe product capture.
