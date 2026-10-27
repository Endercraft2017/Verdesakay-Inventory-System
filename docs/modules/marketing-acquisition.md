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
