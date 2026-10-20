# Explicit work-task permissions

The Work hub, mobile and desktop task screens, and API gates must use the task's named
permission. `inventory.adjust` permits stock operations and warehouse kit release, but does
not grant production recording, QC/QA inspection, QA-hold decisions, line pause/close,
repair-parts acceptance, RTS receipt, or sale-order release.

This affected any built-in or custom role with `inventory.adjust`, including Warehouse,
Admin Staff and Releasing. Administrator continues to hold every permission. Dedicated
floor roles retain their own tasks. QC and QA remain separate on two-stage job orders.

Existing role bundles and user overrides are unchanged. If a warehouse account also needs
RTS receipt or order release, explicitly grant `production.receive` or `orders.release`
in Admin → Accounts → Roles (or the individual account's permissions). Do not use stock
adjustment as a replacement. Revoking a task permission must block it even when stock
adjustment is still granted.

Read access remains governed by the existing broad view and desk permissions. Warehouse
issue reporting, stock configuration and documented supervisor checks retain their own
existing authorization rules.

Regression coverage: `task-permission-boundaries.test.ts` exercises every built-in role,
a custom stock role, live role edits and per-user revocation against task API gates.
`frontend-mobile.test.ts` covers Marvin's menu and direct task links. The phone cache
version is incremented so updated assets replace the cached menu on activation.
