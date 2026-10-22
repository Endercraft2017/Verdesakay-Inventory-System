# Production planning and parts-kit handoff audit

**Branch:** `restructure/module-architecture`. **Scope:** job-order draft and component snapshot → approval → warehouse acceptance → partial/full pick → parts release slip → production kit acceptance. Mobile code is owned separately; see `MOBILE-INVENTORY-HANDOFF.md`.

## Stock and handoff boundaries

Creating or approving a job order plans demand; neither moves stock. Warehouse acceptance records responsibility. Picking sets quantities aside on the draft and can be partial; it does not deduct stock. Issuing the parts release slip deducts components at the source location in the same transaction as the slip and job-order transition. The production lead counts and accepts that released kit before recording output. A failed acceptance needs an issue report or correction, not a second stock deduction.

## Findings fixed in this step

| Risk | Change |
|---|---|
| A prepared kit could be released after physical stock fell, taking parts another picked kit or repair request still held. | Final release and its read-only availability now use source-location on-hand minus other kit picks and repair holds. The normal request returns a component-level shortfall and creates no slip or stock movement. Owning-site offline physical decisions retain their documented discrepancy behavior. |
| Warehouse acceptance of several approved jobs claimed to be all-or-nothing but ran one update at a time. | The batch updates in one transaction; a failed update rolls every acceptance back. |
| The desktop offered only “Mark kit picked,” which silently picked every component and could not record a partial count or correct a completed pick. | A count dialog shows planned, on-hand and held quantities; staff enter whole picked quantities per component, save partial work, and can adjust the kit before slip issuance. |
| The shortage dialog treated held stock as physically missing and offered procurement for a commitment clash. | It distinguishes on-hand, held elsewhere, free and short; it offers draft purchase orders only when stock is physically short. |
| The consolidated pick list showed only on-hand stock, and job-order/plan inputs truncated fractional typing. | The list now shows held and free stock. Desktop quantity entry rejects non-whole values instead of silently rounding down. |

## Remaining work in this segment

- Mobile is the primary operator surface for this handoff, and its follow-up is open. The code audit found false **Ready** on an availability-fetch failure, held stock displayed as usable, no partial-pick/correction UI, no retry key or read-after-timeout for release, mismatched final-shortfall parsing, an undiscoverable manager draft-approval queue, and acceptance/issue copy that promises a block the backend does not enforce. The root `MOBILE-INVENTORY-HANDOFF.md` records the affected screens, API contracts and acceptance cases. No `public/mobile/` code changed here.
- A draft component's manually overridden `qty_planned` and its `qty_per_unit` can diverge when job quantity is edited later. Before changing that planning contract, decide whether custom totals scale proportionally, stay fixed, or require re-entry on a quantity change.
- Production issue handling after a kit-count mismatch and the later production-recording/QC/Products In stages need their own connected audit.

## Verification

Focused integration tests cover approval and role gates, partial and multi-job picks, stock held by another kit at final release, no slip or stock change on a blocked release, correction and retry, multi-job acceptance rollback, failed parts-slip posting rollback, and production acceptance. `npm run check` passed with 230 files and 2,442 tests. A desktop UI test added after that run passed separately: it exercises a partial pick followed by completion and verifies the correction action remains available. TypeScript and desktop JavaScript syntax checks passed after the UI test was added. Browser-level responsive review of the new pick dialog remains open.
