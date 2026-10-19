# Role-based inventory and production acceptance — 2026-10-19

Branch: `restructure/module-architecture`. This run used a disposable local database and uploads, a real Express server, and Chromium. It changed no production records. The executable browser scenario is `work/role-pipeline-acceptance.mjs` (ignored by Git).

## Result

No blocker was confirmed on the tested common path. Separate warehouse, production lead, QC inspector, QA inspector, Products In clerk, and releasing clerk accounts completed the purchase → kit → production → QC/QA → RTS → sale release path. A second warehouse made the location boundaries observable. The dedicated phone app's QC, QA, RTS, and Sales release queues rendered at 390 px; the desktop warehouse and Products In views rendered at 1440 px, and desktop releasing rendered at 390 px. The checked pages had no JavaScript page errors or horizontal document overflow.

| Boundary | Observed result |
| --- | --- |
| Purchasing and warehouse receipt | A PO for two motors was received in two one-unit receipts at Warehouse B. The PO changed from partial to complete, and stock at that location rose to two. |
| Job approval and kit | Warehouse could not approve its own job order (`403`); admin approved it. Warehouse accepted the job, picked one of two components, and final kit release refused the incomplete pick (`409`). After the second receipt and completed pick, the numbered parts release deducted two motors once. |
| Production and inspection | Production lead accepted the kit and recorded a photographed, identified unit. A QA inspector could not act at the QC stage (`403`). QC then QA passed it in order; it entered the RTS queue without entering sellable stock early. |
| Products In and lost response | The Products In clerk saw the unit in both desktop and phone queues. Chromium dropped the desktop receipt response after the server committed. The unchanged form retained its `Idempotency-Key`; retry produced one receipt and one finished unit in stock. A new-key duplicate receipt returned `409`. |
| Location and sale | A sale shipping from Warehouse B could not be approved while the only finished unit was at Warehouse A (`409`). Warehouse moved that exact serial to B; approval and allocation then succeeded without a stock deduction. |
| Warehouse-out | Releasing saw the order on desktop and phone. The numbered release slip deducted the finished unit once. Repeating the same slip request with its original key returned the same slip and left stock at zero. |

The six focused suites for access, purchasing, job orders, QC, Products In, and release slips passed: **87 tests**. The browser scenario passed after the final checks were added.

## Conditional behavior to decide only if used

A draft job for two units with a manually changed component total of three resets that total to six when its order quantity changes to three (`PUT /job-orders/:id`). The API derives six from the original two-per-unit recipe. The tested desktop screen edits component totals but does not expose this job-quantity edit sequence. This is a potential surprise for an API/integration caller, not a demonstrated blocker for current operators. Before changing it, establish whether staff or integrations revise quantity after overriding totals and whether the intended rule is proportional scaling, fixed total, or explicit re-entry. Avoid changing the kit-cost/consumption contract without that decision.

## Coverage limits and mobile handoff

The API performed the handoff mutations; Playwright checked the real operator queues and selected desktop forms. This run did not make a worker complete every mutation through the phone UI. It did not test physical camera focus, printed labels, a disconnected site host, concurrency between two warehouse staff, customer delivery proof, or return inspection. Those are separate acceptance tasks rather than inferred backend defects. The mobile owner should use this scenario and the root `MOBILE-INVENTORY-HANDOFF.md` to test phone mutations and recovery on a device; no mobile source was changed here.
