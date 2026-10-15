# Release slip to delivery: browser and API audit

Date: 2026-10-16 (Asia/Manila). Branch: `restructure/module-architecture`.

The audit used a disposable local database and real Express APIs. Chromium exercised
the desktop releasing screen at 1440×900 and 390×844 and the phone delivery screen
at 390×844. No production stock or customer records were touched. The browser
script is in ignored `work/release-delivery-browser.mjs`.

## Findings fixed

| Boundary | Result |
| --- | --- |
| Physical sale completed without warehouse-out | Creation and later status/edit routes now refuse confirmed/completed/fulfilled/invoiced/paid physical sales without a numbered release slip, even before warehouse acceptance. Non-stock orders retain their existing path. |
| Driver departed or marked goods delivered before warehouse-out | Linked physical sale deliveries now return `409 code:'release_required'` until the slip exists. Delivery planning remains available before release. |
| Delivered outcome without evidence | The recipient's name and a delivery photo or a delivery-linked signature are required for a linked physical sale. Failed deliveries retain their required reason. |
| Lost desktop slip response | The desktop sends a stable `Idempotency-Key` for an unchanged slip request and reads the order's release context on an uncertain result. A committed slip opens its numbered record; an unconfirmed result stays in the form for a same-key retry. |
| Lost desktop photo-upload response | Each selected photo keeps a retry key. Retrying the same file recovers the one attachment before any warehouse-out. |
| Delivery evidence access and removal | Drivers can read, upload and remove draft evidence only for deliveries assigned to them. Completed delivery photos/signatures and issued release-slip photos cannot be deleted. A site's evidence captured before a conflicting cloud cancellation is retained for offline reconciliation. |

## Browser acceptance

1. The phone's Start delivery action is refused before the linked sale has a slip; delivery stays pending.
2. A desktop slip commits at the backend but its HTTP response is dropped. The screen finds the numbered slip; one record exists and stock is deducted once.
3. The phone starts after the slip. A Delivered attempt without proof is refused, preserving `out_for_delivery`. A delivery photo and named recipient complete it without another stock movement.
4. At 390px desktop width, a photo upload commits but its response is dropped. The form preserves the photo's key; retry yields one attached release photo and one stock-out.
5. A phone delivery-completion response is dropped after the backend commits. The current form has no idempotency key or in-place reconciliation; reloading finds the delivered record and its proof. This is a mobile-owner follow-up, not a duplicate stock movement.

Focused API regressions cover the status gates, proof, role scoping, immutable
evidence, lost-response replay, and an offline site's delivery proof arriving after
a conflicting cloud cancellation. TypeScript and all 2,780 tests across 271 files
passed before integrating the concurrent connected-form follow-up.

## Remaining mobile and physical acceptance

The phone delivery form still keeps its signature, photo draft, recipient and token
state in memory. A restart during capture needs recapture. It posts delivery
completion without a stable retry key, so a response lost after commit needs
read-after-timeout reconciliation and an explicit pending/confirmed result. The
mobile owner should update that screen and handle `release_required`,
`proof_required` and `recipient_required` with a clear path back to warehouse
handoff or evidence capture. The legacy Pick/Delivery shortcuts documented in
`MOBILE-INVENTORY-HANDOFF.md` must not bypass the canonical slip flow.

Physical acceptance still needs a real phone camera, printer, recipient handoff,
and an interrupted network on a staging site. Chromium tested browser behavior,
not physical device optics or paper labels.
