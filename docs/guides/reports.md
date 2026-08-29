# Reports (operational dashboards)

**For:** owners, operations managers, purchasing, HR, accounting
**In the app:** Home → **Reports**

---

## What it's for

A fixed, one-screen snapshot of the business you can read at a glance — **without asking
the AI assistant**. Everything is live and read-only; you see only the sections your role
allows.

## The sections

### Inventory *(needs View inventory)*

| Figure | Meaning |
|---|---|
| **Stock value** | Σ (quantity on hand × unit cost). Unit cost is each item's **Standard cost**, falling back to **Purchase price**, then 0. |
| **Items / Low stock / Out of stock** | Counts across the catalogue. |
| **Dead stock (90d)** | Items with stock on hand but **no movement in 90 days** — count and tied-up value. |
| **Stock value by location** | Where the value sits, from per-location stock. |
| **Highest-value items** | Top items by quantity × cost. |

### Production *(needs View inventory)*

Work in progress (units still to finish on released / in-progress / paused MOs), units
**done** in the last 30 and 90 days, **scrap rate** (scrapped ÷ (done + scrapped)), job
orders by status, and recently completed MOs.

### Purchasing & payables *(needs View orders)*

| Figure | Meaning |
|---|---|
| **Open POs** | Purchase orders not yet completed/cancelled, and their value. |
| **Received, not invoiced** | Value of goods received on GRNs minus what's been billed — your GR/IR exposure. |
| **Bills to approve** | Draft vendor bills waiting on the 3-way match. |
| **Payables aging** | **Approved** vendor bills bucketed by their due date vs today: current / not due, 1–30, 31–60, 60+ days overdue. |

> Payment isn't tracked yet, so "approved" is treated as "payable". Aging uses the bill's
> **due date**.

### Sales orders *(needs View orders)*

Open sale orders and value, a breakdown by status, and order volume for the last 8 weeks
(with a simple value bar).

### Payroll *(needs View HR)*

The latest pay period's **headcount, gross, net, statutory (SSS + PhilHealth + Pag-IBIG),
and withholding tax**, plus a table of the last six periods. Built from the generated
`hr_payroll` records.

## Tips

- Hit **Refresh** after entering new data — the page loads once when you open it.
- Numbers are **rounded to 2 decimals** for display.
- If a section is missing, your role doesn't include the permission for it (View
  inventory / View orders / View HR).
- Need a number that isn't here, or a custom cut? Use the **AI Assistant** — it can run
  ad-hoc analytics and export a report.
