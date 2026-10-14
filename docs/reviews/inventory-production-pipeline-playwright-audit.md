# Inventory and production pipeline: desktop browser audit

Date: 2026-10-14  
Branch: `restructure/module-architecture`  
Environment: disposable local database and uploads, local app server, Chromium via Playwright, 1440 × 1000 viewport. No production data changed.

## Result

**Remediation verified 2026-10-14:** The five confirmed gaps below have been fixed on this branch. A second Playwright run used the desktop QA form to create the hold, confirmed an incomplete hold could not pass, then submitted its required QA answer and received the unit. Products In now shows a load error instead of an empty queue when its request fails. The repair-parts issue dialog also requires a scanned/entered part code and counted quantity. The observations below describe the original audit run and are retained as regression context.

The main purchasing → component stock → job order → parts kit → production → QC/QA → Products In → sales shortage planning → warehouse release → release slip → return path completed in the desktop browser. The stock and status checks below passed. **The QA hold path contains a release-to-sellable-stock bypass**: a hold decision can pass a unit without any required QA checklist answers. This needs a server-side gate before relying on hold decisions for product release.

| Stage | Browser action and observed result |
| --- | --- |
| Purchasing | Created a PO for three spare bearings. Desktop goods receipt of two changed stock 0 → 2 and PO receipt status to `partial`; the last one changed stock to 3 and status to `complete`. |
| Job order and kit | Created a two-unit, two-stage job with one motor per unit. Approved it, accepted it for warehouse release, saved a partial pick of one, then a complete pick of two. Release slip deducted two motors (10 → 8); production accepted the counted kit. |
| Production | Entered two different serials and per-unit photos through the desktop form. Both units entered the QC queue. |
| QC and repair | A pass without the required Voltage reading was refused and did not advance the unit. A failed second unit went to rework; a repair part was requested and issued by the warehouse; reinspection then advanced it to QA. |
| QA and Products In | A normal QA pass advanced the repaired unit. A held unit was passed through the Hold queue without a QA checklist (gap 1), then received through Products In. Submitting an empty receipt did not move stock; the selected unit raised finished-goods stock 0 → 1. Repeating the receipt returned HTTP 409. |
| Sales planning | A sale for two with one on hand showed a shortage of one. “Draft missing production” created a linked draft MO and left the shortage visible. Explicit backorder approval did not pick stock. |
| Goods out | Warehouse accepted the sale, scanned one serialized unit, and stock stayed at one until the slip. An incorrect recipient token was refused with stock unchanged. A valid partial authorization enabled the partial slip, which changed stock 1 → 0, confirmed the original order, and made a one-unit backorder order. |
| Customer return | Recording the physical return left stock at zero. A separate inspection confirmation restocked the unit once, changing stock 0 → 1. |
| Request failure | Aborting `GET /api/job-orders` in Playwright made Products In show “Nothing waiting to be received” instead of an error (gap 4). |

## Gaps, ordered by impact

1. **Critical — QA hold pass bypasses required QA checks.** The product had a required “Finish clean” QA check. A held unit had no checklist answers; the desktop Hold queue’s default Pass decision succeeded anyway. `GET /job-orders/:id/qc` then showed both the hold and resulting pass records with `checklist: null`. Products In received that unit into sellable stock. The normal inspection pass correctly enforces required checklist answers and readings, but `POST /job-orders/:id/units/:unitId/hold-decision` copies the held checklist without validating it. Require a completed applicable checklist before a hold can become `passed`, and make the decision form collect or verify it. Add an integration regression from hold to receipt; include both missing answers and failed required answers. Source: `src/modules/manufacturing/job-orders.routes.ts` (inspection gate around line 1611; hold decision around line 1785).
2. **High — desktop QA cannot put a unit on hold.** The QA inspection form only offers scrap, dispose, recycle, and repair. The Hold tab can decide a hold created through the API or mobile, but the desktop inspector cannot create one. Add Hold only on final QA pass, with the existing reason and per-unit photo requirements. Source: `public/js/modules/manufacturing/production-qc.js` (`DISPOSITIONS` near line 64).
3. **Medium — unanswered checklist items appear as failed findings.** On a QC fail for repair, leaving “Wiring intact” and “Voltage” at “Choose result” produced inspection history showing `✗ Wiring intact, Voltage`. The form maps every unanswered item to `ok: false`, which downstream history treats as a failed check. Keep unanswered separate from explicit Issue, or require deliberate responses before filing a failure. This matters for repair diagnosis and audit history. Source: `public/js/modules/manufacturing/production-qc.js` (`wireInspectForm` near line 209).
4. **Medium — Products In hides API failures as empty work.** A Playwright route abort for the queue request showed the normal “Nothing waiting to be received” empty state. Receipt history uses the same `catch(() => [])` pattern, and location lookup in the receipt dialog does likewise. Show a clear load error with Retry; preserve the distinction between zero records and an unavailable service. Source: `public/js/modules/manufacturing/production-receiving.js` (lines 22, 57, 128).
5. **Low — sales shortage guidance asserts a transfer when none is available.** The stock review displayed “Stock at other locations needs a transfer” when the only stock was at the ship-from location and the shortage was one. Condition this sentence on nonzero available stock elsewhere. Source: `public/js/modules/inventory/orders.js` (around line 199).

The desktop repair-parts acceptance dialog also issues the requested quantity without asking for a scanned part label or counted quantity. The server can validate a submitted `scanned_code`, but the desktop form does not submit one. This is a physical-verification UX gap for review with warehouse staff; the browser run confirmed the one-click issue path, but did not test a wrong physical part.

## Coverage limits and next checks

This run used an administrator account and one default storage location. It did not exercise role-specific permission screens, concurrent operators, location capacity and transfer rules, offline sync, non-serialized production batches, multi-level BOMs, pause/cancel and unused-part return, shortage PO drafting, proof of delivery, or return rejection/repair. Automated API tests cover some of those rules, but they remain outside this Playwright run. The immediate next change should close gap 1 and regression-test the hold → Products In boundary; then close the desktop hold and false-empty UX gaps. Mobile code was not changed; cross-platform differences remain tracked in `MOBILE-INVENTORY-HANDOFF.md`.
