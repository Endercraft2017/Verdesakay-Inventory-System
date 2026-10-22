# Inventory and production permission audit — 2026-10-19

Branch: `restructure/module-architecture`. Checks used seeded roles and disposable
Express/SQLite accounts; they did not read or change live employee access.

## Required authority by handoff

| Work | Permission that authorizes the action | Built-in path |
| --- | --- | --- |
| Purchasing and goods receipt | `purchasing.manage` to create/change POs; `inventory.adjust` to receive stock | Office purchasing roles; Warehouse receives. |
| Stock and physical counts | `inventory.view` to observe; `inventory.adjust` for stock movement, count planning, independent review/apply and source closure | Warehouse holds both; a narrower counter may hold only view. Self-approval is separately refused. |
| Draft job and parts kit | `inventory.adjust` to create/edit a job, accept/pick/release its warehouse kit | Warehouse and other broad stock roles. |
| Job approval | **`production.approve`**, independent of `inventory.adjust` and `production.manage` | Administrator has it by default. Give a named approver a per-person grant or an approval role; a seeded Production Manager does not have it automatically. |
| Production and inspection | `production.record`; `production.inspect_qc`; `production.inspect_qa`; `production.qa_review` for hold decisions | Production Lead/Manager, QC Inspector, QA Inspector, and Manager respectively. Stage checks still enforce QC before QA. |
| Products In | `production.receive` (or broad `inventory.adjust`) | Products In Clerk; Warehouse also qualifies. |
| Sales authorization and warehouse-out | `orders.edit` for sale changes/authorization; `orders.release` (or `inventory.adjust`) for physical release | Customer Service/Releasing for Sales decisions; Releasing Clerk for warehouse-out. These are separate decisions. |
| Own-driver or courier trip | `delivery.manage` to plan/book; `delivery.run` or `delivery.manage` to record pickup/completion | Releasing role has both; Warehouse has run. Give a driver an explicit run grant if their role is narrower. |

The account editor exposes these keys through the backend catalog. A phone
account also needs `mobile.access` and the tenant needs the relevant module
enabled. A role's saved tenant permissions and a person's overrides are resolved
on each authenticated request; seeded bundles are only defaults for new tenants.

## Verified behavior

The 11 focused permission, role, production approval, stock-count, release and
frontend-navigation suites passed **212 tests**. They cover narrow desk reads,
QC/QA stage separation, independent stock-count review, approval boundaries,
role edits and per-person overrides. `node scripts/test-desktop-clerk-access.mjs`
passed six desktop/phone desk checks. `npm run test:mobile:access` passed the five
real-backend Work grant/revoke and stock-denial checks.

`npm run test:inventory:permissions` uses the real desktop Access editor and
390 px phone Work screen against a disposable backend. A seeded Production
Manager received `403` on job approval and saw no approval tile. The admin's
per-person `production.approve` grant made the tile appear, let the manager load
the actual queue and approve a reviewed draft. Revocation hid the tile and
returned approval to `403` with the new draft unchanged. The browser test was
run twice after the final fix; both runs passed with no page errors.

## Corrections and remaining configuration check

The desktop Access editor previously described `orders.create/edit/delete` as
managing job orders, although those keys govern sale orders; job creation needs
`inventory.adjust` and job approval needs `production.approve`. Its descriptions
now name the actual authority. It also described `inventory.configure` as
location setup when its route saves item-form customization, and implied that
`inventory.mobile` alone enables stock actions when it actually selects the
phone Warehouse segment/scan shortcut. Those descriptions are corrected. A
fast account deep link could also leave a stale
async Admin render opening a second edit dialog. The Admin route now stops after
an await if its view has been replaced; the browser test asserts one editor.

No permission bypass or missing catalog key was confirmed. **The seeded
Production Manager cannot approve jobs until explicitly granted
`production.approve`.** That separation is intentional in the backend and UI,
but a tenant needs at least one authorized approver available for normal work.
The live tenant's edited roles, per-person grants, active users and module
entitlements were not inspected because this audit had no staff login. An admin
should verify those four facts in the deployed account editor before field
acceptance. This is a configuration check, not a reason to grant approval to
every manager automatically.
