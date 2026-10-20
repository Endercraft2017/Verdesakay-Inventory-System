# Sensitive-action inventory and remaining design work

20 October 2026. Source inventory for prioritization, not proof of complete authorization or
step-up coverage. The broader control AUTHZ-15 remains FAIL. Existing permissions do not become
new permissions when identity is reverified. Owner participation comes after local engineering.

| Action surface | Existing authority / fresh-proof status | Remaining work and severity |
|---|---|---|
| Tenant users/roles/permissions/security policy; office-PC trust | Existing online-only routes with permission and five-minute session proof | High: real enrollment, supported clients and remaining action-matrix review |
| QuickBooks configuration/OAuth/automatic-export retry | Online; administrator permissions, recent proof and OAuth live-actor binding | High: provider acceptance, controlled uncertain-write reconciliation and operational escalation |
| Manual `POST /api/quickbooks/push/order/:id` | Online; order-specific edit authority, recent proof, required destination/source-version preconditions, live actor/order checks before provider calls (implemented this increment) | High: real currency/tax/company acceptance, real-device review acceptance; source preconditions are not one-time transaction signing |
| Platform billing settings, QR, invoices, record/confirm/reject payment, void | Owner-console auth; existing enrolled-operator passkey/fresh-write policy | High: real operator enrollment/policy enforcement and financial lifecycle reconciliation; no independent acceptance inferred |
| Accounting `/ledger/setup`, accounts CRUD, posting-rules | accounting.manage; company claim authority | High: design and test proportionate verification compatible with offline authority; no new cloud-only restriction applied |
| Accounting `/ledger/periods` creation/close/reopen; journal-entry post/void/edit/delete | accounting.manage; company claims, with existing closed-period/site-decision controls | High: local verification, actor/command binding and cloud replay evidence while preserving the accepted site decision |
| Accounting `/payments`, `/payments/:id/void`, `/credit-notes`, `/credit-notes/:id/void` | accounting.manage; company claims | High: financial approval evidence, safe retries/reversals and replay/role/race matrix |
| Accounting tax/statutory-deduction/tax-code settings; petty-cash funds/entries | accounting.manage; claim or physical class | High: distinguish configuration/approval from physical cash recording; risk-specific verification and recovery |
| Unresolved historical payslip ownership repair | New online-only payroll.manage workflow; fresh proof, purpose/actor/session/company/record/employee-bound encrypted review, revision compare/update and mandatory attributed history | High: verified historical evidence, duplicate/filing reconciliation, independent audit protection, sync/restore/operator acceptance. [Contract](../operations/payroll-identity-repair.md) |
| HR employee rate changes, payroll-policy/tables, generate/post GL, mark/unmark paid, deduction edits | payroll.manage (with applicable HR access); company claims | High: pay approval scope and durable local-authority verification; do not invalidate disconnected payroll by adding a cloud-only token check |
| HR approval authorities; core department create/edit/delete | Current users.manage/hr.manage combinations; company claims | High: managerial authority, replay/role/freshness tests and narrowly scoped local proof |
| Accounting statutory/tax reports, employee tax detail, payroll exports/email | Current accounting/payroll/HR read/send permissions; email online | High: route/field-specific minimization and export authorization; BIR 2316 detail now uses an explicit tax-template projection ([scope](../operations/accounting-tax-privacy.md)); self-service/email ownership now rejects ambiguous names and invalid stamped references ([scope](../operations/payslip-identity-disclosure.md)); other report/export fields and custom variables still need review |
| Broader inventory/production/order/release/refund-like business decisions | Existing role/resource and sync authority rules vary | High: extend explicit action matrix, actor transitions, retries and authority-change evidence |

Source anchors: src/shared/step-up.ts; src/core/users.routes.ts department routes;
src/modules/accounting/accounting.routes.ts; src/modules/hr/hr.routes.ts;
src/modules/quickbooks/quickbooks.routes.ts; src/platform/billing-console.routes.ts.
The table groups route families; it is not an assertion that all application routes have been
exhaustively inventoried. The 233-control scorecard remains the complete handbook mapping.

## Offline decision

Preserve current accounting/payroll company-claim authority in this increment. A replay is not
an interactive cloud session, session_stepups is deliberately node-local, and disconnected PCs
cannot learn immediate cloud revocation. Adding requireFreshVerification to these handlers
would either refuse legitimate accepted site work or tempt an unsafe replay bypass. Neither
behavior is implemented.

The next engineering design must inventory local actor proof, supported factor/origin/device
availability, command/data binding, expiry and authoritative site signatures, then prove that
unauthorized replay cannot manufacture approval. Cloud-only MFA secrets must not be copied
into every office snapshot. Compare local password verification plus supported device factors
against restricting selected financial finalization to online operation, with explicit workflow
and security acceptance. This is design work still owed by engineering, not a request for the
owner to implement it. A local password alone is not proof of an enrolled cloud authenticator.

## Research and decision limits

OWASP Authentication and Transaction Authorization guidance reviewed today supports server-side
checks, current state at execution, understandable significant-data review and limited validity.
This increment adds recent proof and destination binding to the already-online manual export;
it does not claim unique per-transaction authorization, full compliance, or independent assurance.
HTTP RFC 9110 informs conservative handling of uncertain non-idempotent writes. Intuit request-ID
pages were not retrievable here, so provider guarantees were not broadened. Further offline
factor/origin and real-provider decisions need dedicated research/prototypes and acceptance.
