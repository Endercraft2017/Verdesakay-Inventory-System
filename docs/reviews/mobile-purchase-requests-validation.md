# Mobile internal purchase requests validation

Date: 2026-10-20. Branch: `restructure/module-architecture`.
Candidate mobile cache: v136. Local implementation, not a deployment claim.

## Scope

Work distinguishes supplier-order receiving from internal financial PRs. Make PR
uses `purchasing.request`; Review PRs is visible for approval, cash issuance or settlement authority. Decisions use
`purchasing.approve_requests`, cash uses `purchasing.issue_cash`, and closing/return
uses `purchasing.settle_requests`; supplier
management and inventory adjustment do not grant approval. Assigned purchases
are filtered by the current buyer, and upload/liquidation buttons and direct
screens require exact buyer ownership. A desktop button check was corrected to
use ownership too. Existing backend financial/ownership rules were preserved.

The route supports own, assigned and authority lists; arbitrary item names,
requested budgets and dates; positive budget approval, rejection and both buyer
arrangements; once-only physical cash issuance; receipt camera/file upload and
authenticated download; editable actual purchase lines and added/substituted
items; visible total-budget and missing-receipt guards; correction/resubmission;
and exact physical change/reimbursement before closure. Every screen states that
PR financial actions do not receive stock. No SKU/supplier is required.

Drafts and files are saved with account/server scope. Submitted requests,
financial decisions, liquidation and uploads use immutable keys/payloads and
explicit recovery, including after browser restart. Saved PR work is discoverable
even if it drops outside the server list's bounded history. Shared workflow
multipart support now accepts an explicit file-field name; other workflows
retain their existing `image` default. Site-local acknowledgements use the
existing pending/sync watcher rather than claiming final confirmation.

## Browser acceptance

`node scripts/test-mobile-purchase-requests.mjs` passed 13 cases using a real
isolated Express/SQLite backend, separate requester, approval-only, supplier-
manager and buyer accounts, and persistent Chromium at 390x844:

1. Renamed supplier delivery, staff PR entry and independent approval visibility;
   supplier-manager deep links cannot open the authority queue.
2. Freeform request/item draft survives a browser restart without SKU/supplier.
3. Committed create response loss recovers one request with original JSON/key.
4. Cash-to-requester approval leaves the request open and does not expose buyer
   evidence controls to an unrelated approver.
5. Cash above budget is blocked; physical issued cash is recorded; approver
   receipt deep link is refused when not the buyer.
6. Missing receipt and over-budget actual items visibly disable submission.
7. PDF draft survives restart; committed upload response loss retries the original
   upload key and yields one receipt.
8. Added actual items within budget submit; authority returns for correction;
   buyer corrects and resubmits the same purchase.
9. Original receipt PDF bytes download intact after recovery. Incorrect returned
   cash is refused. A committed close with a lost response retries unchanged and
   closes once with the exact change.
10. Separately assigned buyer sees its work; requester and approver do not gain
    that buyer's upload/liquidation controls.
11. Buyer camera upload and substituted actual purchase complete an assigned PR.
12. Rejection records a reason; requester never gains approve/close controls.
13. Oversized PDF and unsupported type are blocked; spending within budget but
    above the advance requires the exact reimbursement before closure.

A 14,124,467-byte camera-style PNG became a 1,719,563-byte JPEG at 1920x1600
before persistence/upload. The stock fixture remained exactly seven throughout
requests, approvals, cash, evidence, liquidation, correction and closure. All 13
cases checked absence of horizontal overflow and reported zero page errors.
No operational API results were replaced. Only committed-response loss was
injected. The final harness reuses one persistent tab and closes restored extras.

`node scripts/test-mobile-work-guide.mjs` passed four real-browser account/
permission cases and explained all 36 visible admin entries without mutations or
page errors. TypeScript and 192 focused tests including purchase-request financial rules,
mobile routing/rendering, personal/Work guides, route permissions and RTS recovery
passed. Syntax and whitespace checks passed. This is focused coverage, not a
full-suite or physical-phone acceptance claim.

Reports/screenshots: ignored `work/mobile-purchase-requests/` and the existing
Work-guide audit directory. No live tenant or customer stock was changed.
Physical receipt capture/file selection on installed phones and real installed-
site-PC financial command replay remain field acceptance; generic pending-state
support alone does not establish those outcomes.
