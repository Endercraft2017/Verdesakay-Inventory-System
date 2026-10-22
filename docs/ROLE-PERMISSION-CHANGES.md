# Role and permission changes — 20 October 2026

These changes implement the authorization audit and add a dedicated Customer Service (CSR) split. They change code and built-in role definitions. They do not edit any account's role, permission overrides, employee link, MFA enrollment, or department authority. The individual accounts flagged for owner review remain for that review. No uploaded or live database was modified during development.

## CSR

The concurrent Sales module and its Customer Service desk are preserved. Customer, sales-order and release operations also respect the workspace Sales entitlement; purchase orders retain their Purchasing entitlement. QC and QA can operate independently, with both required checks still needed before finished-stock receipt.

| Profile | Allowed work | Separate authority required |
| --- | --- | --- |
| CSR — Customer Service | Maintain customers; prepare and edit open sales; track orders; use personal employee services and documents | Sales approval, release authorization, stock release, supplier purchasing, finance posting, payroll, account administration |
| CSR Supervisor | CSR sales preparation, sales approval, and release authorization | Physical releasing, stock correction, purchasing, finance posting, release-policy configuration |

Like other employees, a CSR can submit their own internal purchase request. This does not grant supplier purchasing or purchase-request approval.

## Operational boundaries

| Area | Separate permissions / profiles |
| --- | --- |
| Warehouse | Supplier receiving, transfers, physical counting, count review, and unrestricted correction are distinct. Warehouseman receives, transfers, submits counts, releases approved production kits, issues requested repair parts, and receives returns. Warehouse Supervisor adds corrections and count review. |
| Production | Planning, kit release, output recording, line management, configuration, QC, QA, hold review, and Products In remain separate. Production Planner and Quality Supervisor profiles are available. |
| Assigned production | A production recorder must be explicitly assigned to the job or be a linked member of its assigned crew. The desktop job dialog has “Assign recorders”. `production.work_all` lets a recorder work across teams; the Production Manager has this authority. This setting grants no approval or quality-inspection authority. |
| Customer returns | Physical receipt, quality inspection/restock, and rejected-goods disposition have different permissions. Warehouse receipt does not authorize restock. |
| Sales | Preparation, approval, commercial release authorization, physical release, policy configuration, and exception approval are distinct. Direct stock-out requires explicit direct-sale and physical-release authority, an approved sale, and an owner-configured policy that permits this exceptional flow. Normal stock-out uses Release orders. |
| Purchasing | Buyer prepares supplier orders and bills; Purchase Approver reviews budgets and bills; Cash Custodian records cash handoffs and settlements. Matching-tolerance overrides are separate. |
| Finance | Accounting prepares entries; Finance Approver posts entries and records payments. Ledger and petty-cash fund configuration are separate. Actual petty-cash movements need payment authority; issuing credit notes needs posting authority. Employee tax and contribution schedules additionally require payroll visibility, and deduction switches require pay-rate authority. |
| HR/payroll | HR personnel management, timekeeping, kiosk operation, payroll preparation, payroll approval, payment confirmation, pay rates, and payroll configuration are distinct. Payroll Processor, Timekeeper, and Kiosk Operator profiles are available. |
| Delivery | Driver handles assigned deliveries. Dispatcher schedules deliveries. These duties are no longer automatically bundled into warehouse or releasing roles. |
| Administration | Account Support handles ordinary account support. Role/permission administration, privileged-account recovery, workspace configuration, and audit viewing use distinct permissions. Security Administrator carries the full administration duties. |
| Forms | A form designer's scope does not grant authority to change shared global variables. |

A person can hold a custom role combining needed duties. Giving a person both preparation and approval permissions does not authorize the self-approval cases below.

## Approval policy

Ordinary staff cannot approve their own purchase request, approve their own vendor bill, settle their own purchase, post their own journal, approve their own prepared payroll, confirm payment of their own prepared payslip, or approve their own requested release exception. Physical count self-approval remains blocked even when the counter also holds count-review permission.

The fixed Administrator role remains the explicit owner/emergency exception for the newly enforced independent-approval cases. Each use records an `approval-exception / owner-override` audit event. This is not an exception to the existing physical-count prohibition.

## Information and evidence

- Arbitrary SQL is removed from the assistant's advertised tools and rejected for old callers, including Administrator callers. Reporting uses the permission-scoped tools.
- Assistant retrieval checks the current underlying record, its order type, enabled module, department and applicable duty; line-only job notes also respect assignments.
- Assistant order edits/deletion are limited to unapproved drafts without physical activity. Approved or physically active orders must use the normal review screen. Assistant item creation cannot bypass starting-stock authority.
- Audit metadata omits private HR, payroll, personal-note, message and report content. Retained metadata is scrubbed once; event rows, actors and outcomes remain. The pre-migration database backup retains the old state and must be protected as a backup.
- Inventory costs and purchase-document prices are hidden without cost authority. Catalog edits cannot overwrite costs, including hidden cost attributes. Buyer, Purchase Approver, Accounting and Finance Approver have cost visibility.
- Problem photos are private to their uploader and designated evidence custodians. Removing another uploader's editable evidence requires custody authority. Signed inspection and completed-unit evidence remain locked. Unit evidence must reference an existing unit.
- CSV item creation does not grant permission to edit existing items or introduce stock.
- Saved mutation responses recheck authentication and bind replay to the current role, permissions, department, enabled modules and production assignments. A changed access context returns `saved_access_changed` without executing the mutation again. Legacy cached responses also require record review; do not blindly resubmit a physical action with a new key.
- Ordinary account support cannot recover a privileged account by password reset, including an ordinary role made privileged by individual overrides.

## Upgrade and owner review

Schema version **96** takes the existing pre-migration backup before upgrading. On the first startup of this release:

1. The reviewed built-in role bundles replace the previous built-in bundles, and the additional profiles are inserted. The previous bundles are retained in `role_audit_profiles_before_v1` for comparison. Custom role keys are preserved.
2. The one-time `role_audit_profiles_v1` marker prevents subsequent startups from overwriting the owner's later role edits or restoring profiles the owner deletes.
3. Account rows and sparse permission overrides are preserved. Consequently, an existing explicit account exception can still add authority beyond the new role. The flagged accounts are **not cleared by this migration**.
4. Existing production crews and explicit job assignments control recording. Unlinked/unassigned production accounts need owner review or a job assignment before recording; no identity link is guessed.
5. New specialist profiles are available but are not assigned to named people automatically. The owner must decide who approves purchases, posts finance entries, pays payroll, supervises quality, dispatches deliveries, and administers security. Administrator can perform these duties while assignments are reviewed.
6. MFA applicability includes the new privileged duties when the workspace requirement is enabled. This change does not switch on that policy or enroll/reset any account.
7. Mobile shell cache version 134 delivers the updated permission-based task and action controls.

The role changes take effect when this version starts against a workspace; pushing the code does not deploy or migrate a running installation. Update installed PCs and host services to the same release, refresh signed-in clients after upgrading, then verify the review accounts and actual duty assignments before treating access cleanup as complete.

## Validation

The regression suite covers the audit reproductions, CSR preparation versus supervisor approval, assigned production access, cost visibility and write protection, preservation of accounts during the one-time migration, support recovery of privileged accounts, independent count review, and assistant workflow safeguards. Existing workflow fixtures now request their actual specialist duties rather than relying on old broad role defaults. Validation includes TypeScript, the complete repository suite with targeted reruns of updated duty-specific fixtures, 24 audit regressions, and six browser acceptance checks covering desktop grants and mobile access revocation.

A disposable-copy upgrade of the uploaded schema-93 snapshot to schema 96 also succeeded. All 31 account rows, including role assignments and permission overrides, were identical before and after the upgrade; the original uploaded file checksum was unchanged.

## Focused follow-up — existing roles and workflows

Schema **97** keeps the existing 32 profiles. Production Manager gains production approval; CSR Supervisor retains file upload; Warehouse Supervisor retains file viewing and assigned inventory-form entry. A one-time update adjusts only bundles still equal to their previous defaults. Customized or deleted roles and all account assignments/overrides are preserved.

Supplier prices are hidden consistently in the receiving/billing summary and purchasing dashboard, including embedded matching details. Operational quantities and counts remain available. Reports handle omitted monetary fields without showing false zero values or failing to render.

Finance Approver uses a payroll-only cutoff lookup containing IDs, labels and dates. This restores its payroll posting action without widening personnel or attendance access. Payroll payment remains independent of ledger posting.

Journals, vendor bills and payslips retain the original creator and now record the last draft editor. Both are checked by the existing independent-approval rule. Payslip regeneration, rate recomputation and deduction corrections also record the preparer. Legacy rows retain the creator check; historical editors are not guessed. Administrator's existing audited exception is preserved.

Manual QuickBooks exports require existing sales-approval or vendor-bill-approval authority for the document type, plus visibility of its source. Both manual and automatic exports require an approved/firm source document; automatic exports also check the saving actor's approval authority. Approval users receive only the connection indicator needed to show export controls; integration settings remain workspace administration. No new export role or approval stage is introduced.

Role/permission administration is described as fully trusted authority, including the ability to create Administrators. Employee records and individual account assignments were outside this follow-up's scope.

Validation includes targeted API regressions for price privacy, independent review after edits/regeneration, the limited payroll lookup, role-update preservation, and manual/automatic QuickBooks exports. `npm run test:roles:ux` exercises receiving/reports, Finance Approver's payroll action, and export controls in Chromium against disposable local data and mocked QuickBooks.

Final follow-up validation on the merged branch: TypeScript passed. The complete regression exercised 2,995 tests across 293 files: 2,992 passed initially; three payroll UI tests and their associated unhandled rejections used the old cutoff endpoint in their mock. Updating that fixture resolved them, and the entire affected file passed all 30 tests without errors. The only correction to this implementation after the complete run was that test fixture. Concurrent mobile requests, Sales/QA and authored-guide changes (through `0ad1508`) were then preserved by rebase. Final TypeScript and all 254 tests across the ten affected integration/regression files passed. The full suite was not repeated after the fixture correction and integration of those concurrent changes. The final Chromium run passed all three role workflows, including actually posting generated payroll as Finance Approver, with zero page exceptions. All fixtures used disposable data, and QuickBooks was mocked.

## Role and permission selection — 22 October 2026

Account creation, account editing and HR onboarding share a searchable role chooser. Search matches role names, descriptions and the actual permissions in the live bundle, including custom roles. Each choice shows its description and permission count; the selected role has an expandable preview organized by work area. Full access administration is called out explicitly. Choices remain limited to the original select's server-authorized options, and read-only role fields remain disabled. Browsing does not change the account or mark its form as edited; selecting a different role remains an unsaved form change until the account is saved.

The permission editor adds an Off filter, live enabled counts in the work-area menu, clickable permission labels, and optional inline explanations alongside the existing hover/focus/tap help. Empty results have a Clear filters action. Role edits now expose added/removed draft permissions through Changed and individual Undo actions; account exceptions retain their separate person-only wording. This is a UI change with no schema, default-role, employee-record or account-assignment changes.

Validation on the integrated branch: TypeScript; 212 tests across eight affected UI/navigation/role and integrated mobile/commercial-visibility files; the Roles list browser regression; `npm run test:permissions:ux` covering desktop, keyboard, touch, light/dark themes and 360/390px layouts; and all six `npm run test:mobile:access` acceptance checks. Browser fixtures use disposable local records. No full-suite rerun is claimed for this UI change.
