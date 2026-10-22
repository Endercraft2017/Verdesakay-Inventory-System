# Production walkthrough — gaps found

A step-by-step walk through the production pipeline (`docs/modules/pipelines.md` →
"Production / manufacturing run"), started 2026-09-27, to find missing steps. Each gap
is marked **done**, **open**, or **deferred (UI overhaul)**. The desktop UI is being
redesigned separately, so UI-only gaps are only recorded here.

## Step 1 — Create the job order

| # | Gap | Status |
|---|-----|--------|
| 1.1 | **No approval step.** A draft went straight to released, and whoever could create a job order could also release its parts. | **done**: `POST /job-orders/:id/approve` / `unapprove`, new permission `production.approve` (not implied by `inventory.adjust`), `/release` refuses until approved, and editing the draft clears the approval. SCHEMA_VERSION 49. |
| 1.2 | **No stock check before release.** Short components only showed up as a failed Release. | **done**: `GET /job-orders/:id/availability` returns need / have / short per component, plus `in_stock`, `approved`, `releasable`. The approve response also returns `shortfalls` as a warning. |
| 1.3 | **Roles are fixed in code.** Job-order creation needs `inventory.adjust`, and there is no production-manager role. | **open**: see "Custom tenant roles" below. |
| 1.4 | **A draft can't be fully edited in the UI.** `PUT /job-orders/:id` supports quantity, locations, QC stages and notes, but the job order screen only edits components and team/schedule. | **deferred (UI overhaul)** |
| 1.5 | **No stock preview in the UI** before pressing Release. | **deferred (UI overhaul)**: the endpoint from 1.2 is ready. |
| 1.6 | **Approval UI** is minimal (an Approve / Withdraw button on the draft, plus a mobile button). There is no approval-queue screen. | **deferred (UI overhaul)**: `GET /job-orders?stage=awaiting_approval` is ready. |

Possible follow-ups for 1.1, not built yet:
- Stop the creator from approving their own job order (four-eyes rule), probably as a tenant setting.
- Rejecting with a reason. Today the approver either approves or leaves the job order as a draft.
- Notifying the approver and the warehouse when a job order enters their queue.

## Step 2 — Warehouse sees the request, prepares the parts, releases them

| # | Gap | Status |
|---|-----|--------|
| 2.1 | **No warehouse "accept / preparing" state.** | **done**: `POST /job-orders/warehouse-accept` (one or many job orders). SCHEMA_VERSION 50. |
| 2.2 | **No pick list or picked quantities; no way to prepare several kits at once.** | **done**: `POST /job-orders/prepare` (bulk; partial picks are saved), `GET /job-orders/pick-list?ids=` combined across job orders (+ `&format=html` printable). Picks are checked so two kits can't claim the same stock. |
| 2.3 | **No parts release document.** | **done**: releasing issues a numbered **parts release slip** `PRS-#####`, kept in the app (paperless) with a printable version at `/api/parts-slips/:id/print` and kit photos (`parts_release` attachments). Stock is deducted when the slip is issued. |
| 2.4 | **No warehouse release-queue / picking screen.** | **deferred (UI overhaul)**: `?stage=awaiting_warehouse / preparing / ready_to_release` are ready. For now the app has plain buttons (Accept → Mark kit picked → Release & issue slip), full kits only. |
| 2.5 | **Picked parts aren't physically reserved.** A pick sets the parts aside from other kits' picks, but a stock adjustment or sale-order fulfilment can still use them before the slip is issued. | **open** (probably fine; revisit if it happens) |
| 2.6 | **Partial release** (sending part of a kit now and the rest later) isn't supported. One slip covers the whole kit. | **open**: decide if needed |
| 2.7 | **SO release slips** have their print view inside the desktop UI only; parts slips have a server print page. The two should share one printable style. | **deferred (UI overhaul)** |

## Step 3 — Production team lead runs the job order (mostly on the phone)

| # | What the lead does | Status |
|---|-----|--------|
| 3.1 | Accepts the kit and sees the job order's status | existed (`POST /:id/accept`, mobile job order screen) |
| 3.2 | Records units off the line: **photo + identifier required before a unit exists** | **done**: `POST /:id/units` is one multipart request with both required, so a unit can't reach QC without its photo. It used to be two calls, and the photo call could fail after the unit was already created. |
| 3.3 | **Bug:** a production lead's unit photo, and QC/QA inspectors' defect photos, were refused (the `qc_unit` attachment required `inventory.adjust`) | **fixed**: floor permissions can attach `qc_unit` photos |
| 3.4 | Pause for a higher-priority job order, then resume, "if I have authority" | **done**: new permission `production.pause` (assign per person or role); pause records who and why |
| 3.5 | Report issues per unit or for the whole job order, edit on the fly | **done**: `/api/production-issues` (create / edit while open / resolve / re-open, photos). It replaces the old mobile "Report a problem", which only sent a chat message. |
| 3.6 | Mobile screens for issue reports (list, file, edit) and a pause-reason field | **deferred (UI overhaul)**: endpoints ready. For now pause asks for the reason in a prompt, and issue reports have no screen yet. |
| 3.7 | Notify the supervisor when an issue is filed or a job order is paused | **open** |
| 3.8 | A line lead can't create the higher-priority job order themselves (needs `inventory.adjust`) | **open**: decide with custom roles (1.3) |

## Custom tenant roles (gap 1.3)

**Direction (user, 2026-09-27):** each tenant manages its own roles. The app ships a
few starter roles that the tenant can edit or delete, and the tenant can create new
roles with any set of permissions. Only **Admin** is fixed, and it always has every
permission.

Proposed starter roles: **Admin, Office Admin, Warehouse, HR, Accounting, Production
Team Lead.**

Current state: roles are a fixed union type (`src/shared/types.ts` `Role`) with
hard-coded defaults (`src/shared/permissions.ts` `ROLE_DEFAULTS`). Per-user changes
exist only as `users.permission_overrides`. Things to design before building:
- A per-tenant `roles` table (name, permissions JSON, `is_system` for Admin), seeded with the starter roles.
- Migrating existing `users.role` values (admin, admin_staff, warehouse, releasing, csr,
  hr, marketing, parts_clerk, production_lead, qc_inspector, qa_inspector, receiving_clerk,
  releasing_clerk) to rows in that table, without changing anyone's current access.
- `HR_ASSIGNABLE_ROLES`: HR's "create account" shortcut needs a rule that works with
  custom roles, for example "a role HR may assign must not include users.manage /
  hr.manage / accounting.*".
- The access editor (`public/js/lib/access-editor.js`) and the mobile `inventory.mobile`
  gate both read role names today.
