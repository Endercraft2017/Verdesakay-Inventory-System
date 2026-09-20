# `src/core/doc-catalog.ts`

## Purpose
A single static, categorized catalog of the data paths a document-template variable can bind to (the "field" option of a `doc_variables` row's `source_type`). Backs the `GET /api/templates/data-source-catalog`-style palette in the document-template editor UI, describing what `{{company.*}}`, `{{order.*}}`, per-line-item, and HR-Payroll-flat fields are actually available to reference.

## Exports / Public API

```ts
export const DATA_SOURCE_CATALOG: CatalogGroup[]
```
An array of `{ group: string, items: CatalogEntry[] }` objects (`CatalogGroup`/`CatalogEntry` types from `src/shared/types.ts`), five groups in fixed order:
1. **Company** — `company.name`, `company.address`, `company.phone`, `company.email`.
2. **Order** — `order.no`, `order.type`, `order.date`, `order.status`, `order.customer_name`, `order.customer_contact`, `order.notes`, `order.currency`, `order.subtotal`, `order.tax_percent`, `order.tax_amount`, `order.total`.
3. **Line item (per row)** — `name`, `sku`, `description`, `quantity`, `unit`, `unit_price`, `line_total` (unprefixed — meaningful only inside a `{{#items}}...{{/items}}` loop).
4. **Meta** — `user.name` ("Prepared by"), `today`.
5. **HR Payroll** — 21 flat (unprefixed) paths matching the `hr_payroll` form's field keys one-for-one (`employee_name`, `dept_position`, `payroll_period`, `pay_date`, `daily_rate`, `days_worked`, `ot_hours`, `ot_rate_hour`, `basic_salary`, `overtime_pay`, `undertime_pay`, `holiday_pay`, `special_holiday_30`, `rest_day_ot`, `total_earnings`, `sss`, `philhealth`, `pagibig`, `cash_advance`, `late_absences`, `total_deductions`, `net_pay`) — only meaningful when the template is rendered by the dedicated HR Payroll print flow (`public/js/hr-payroll-print.js`), which builds its own flat record-derived context rather than the shared `company`/`order`/`items` context.

This is a plain data constant — no functions, no logic.

## Internal / non-exported helpers
None.

## Dependencies
- `./types` — `CatalogGroup` (type-only import; `CatalogEntry` is used structurally within it but not imported by name).

## Used by
- `src/core/templates.routes.ts` — imports `DATA_SOURCE_CATALOG` and returns it verbatim from a `GET` handler (`res.json(DATA_SOURCE_CATALOG)`) so the frontend template/variable editor can render the field picker.

## Notes / gotchas
- This catalog is **descriptive, not enforced** — nothing validates that a `doc_variables` row's `field_path` (or a hand-written `{{var}}` token in a template body) actually exists in `DATA_SOURCE_CATALOG`; it's purely a curated list surfaced in the editor UI for discoverability. A template can reference any path the render context happens to expose, cataloged here or not.
- The **"Line item"** and **"HR Payroll"** groups both list bare, unprefixed keys (`name`, `quantity`, `basic_salary`, ...) rather than dotted paths — these two groups are contextual: "Line item" paths only resolve inside a `{{#items}}` loop, and "HR Payroll" paths only resolve when the template is rendered via the payroll-slip print path, not the generic order-template renderer. Nothing in the catalog's own shape distinguishes "always available" (Company/Meta) from "only available in one specific render context" (Line item/HR Payroll) — that context is documented only in code comments here, not encoded in the data.
- Keeping this file in sync with `seedHrPayrollForm()`'s field list in `src/shared/db.ts` (both enumerate the same 21-ish `hr_payroll` field keys) is manual — adding/renaming a field on that form definition should be mirrored here if it should show up in the template editor's picker.
