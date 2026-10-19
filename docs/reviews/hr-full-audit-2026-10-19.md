# HR and forms audit — 19 October 2026

Scope: the `restructure/module-architecture` branch, focusing on HR calculations, employee requests and approvals, form definitions and records, payroll navigation, and the form-list interface. Tests and browser interactions used disposable local data. The live tenant was not changed.

## Findings and changes

1. **Payroll opened under Documents.** `findLeaf` routed every `form-records` screen to the Documents hub before matching HR navigation. Payroll now resolves to the HR Payroll tab, HR-scoped forms to HR Forms, and the Payroll back button returns to HR Forms. Opening HR Payroll from the form list also retains its payroll route context. A user without HR access still follows the authorized Documents route.
2. **Forms were difficult to scan.** The index used cards that hid record count, field count, numbering, and update information in compact text. It now displays a file-explorer-style list with columns for those values, sortable Name/Records/Fields/Updated headers, and a favorite action. On narrow screens the list scrolls horizontally, keeps the form name visible, and explains the sideways scroll.
3. **No new calculation defect was reproduced.** The focused 68-file HR/forms/payroll/accounting run passed 1,123 tests. It covers attendance and overtime rules, holidays and rest days, scheduled-day leave charging, paid/unpaid leave handling, per-day rate changes, statutory schedules, deductions, payslip previews and locks, report grouping, seeded form definitions, calculated fields, and employee/HR form requests. Manual statutory mode intentionally preserves HR-entered deductions and net pay on regeneration.

The local Playwright forms/payroll run covered the new explorer and route, record editing and validation, payroll deduction previews and paid locks, mobile request validation, and legacy-owner reconciliation. Light desktop and dark phone layouts were inspected; accessibility scans reported no violations.

## Remaining acceptance boundaries

- Historical payslips with ambiguous names still require HR to verify their source documents and assign an employee through **Review legacy owners**. Until then they remain separate in statutory summaries and hidden from employee self-service.
- Automated tests cannot establish that payroll policy settings and statutory tables match a tenant's current contracts or filing obligations. HR/accounting must sign off real cutoff totals and filings before use.
- A disposable local browser confirms current branch behavior. Deployment, physical-device camera/GPS/offline behavior, actual payment, and real-tenant data were not exercised in this pass.

These are operational acceptance checks, not evidence that the current calculations or form flows failed. The audit does not claim that every possible HR scenario is defect-free.
