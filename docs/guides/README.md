# User Guides

Plain-language how-tos for the people who use the system day to day — not developers.
Each guide is short, task-focused, and safe to hand to a new hire or attach to a training
session.

> **In the app:** users don't need these files day to day — the **Help** button on the
> right-hand icon rail opens an explainer for whatever screen they're on, plus an index
> to every other topic. That content lives in [`public/js/help.js`](../../public/js/help.js).
> These markdown guides are the longer-form version for trainers and onboarding packs;
> keep the two in step when a feature changes.

> Admins: the setup/config side of some of these lives in the concept docs
> ([../EMAIL-SETUP.md](../EMAIL-SETUP.md), [../PH-PAYROLL-COMPLIANCE.md](../PH-PAYROLL-COMPLIANCE.md)).

| Guide | For | What it covers |
|---|---|---|
| [Bulk import & export (CSV)](csv-import-export.md) | Inventory / HR staff | Load or update many items, suppliers, or employees from a spreadsheet; export data back out. Fill-in [templates/](templates/) included. |
| [Multi-level BOMs, costing & where-used](multi-level-bom.md) | Production / purchasing | Explode a product through sub-assemblies to raw materials, roll up standard cost, find where a part is used |
| [Purchasing: receiving & vendor bills](purchasing.md) | Warehouse / purchasing / AP | Record goods receipts against a PO (posts stock), enter vendor bills, and the 3-way match that gates approval |
| [Reports (operational dashboards)](reports.md) | Owners / ops / purchasing / HR | The fixed Home → Reports snapshot: stock value, production throughput, purchasing & payables aging, sales, payroll |
| [Using the AI Assistant](ai-assistant.md) | Everyone | Ask questions about your data, get reports and Word documents, take quick actions |
| [The Mobile Warehouse App](mobile-warehouse-app.md) | Warehouse / stockroom | Scan, move, count, receive, and report damage from a phone — online or offline |
| [Sending email from the system](sending-email.md) | Staff with the Email tool | Send a message, payslip, or PO by email; what to do when it fails |
| [Payroll rate tables](payroll-rate-tables.md) | Payroll admin | The SSS / PhilHealth / Pag-IBIG / BIR withholding tables the system uses; when and how to update them each year |
| [QuickBooks Online](quickbooks-setup.md) | Admin / operator | Connecting a workspace to QuickBooks and pushing orders as invoices / bills |
| [BIR Form 2316](bir-2316.md) | Payroll admin | Generating the year-end Certificate of Compensation Payment / Tax Withheld per employee; what it doesn't track |
| [BIR Form 1601-C](bir-1601c.md) | Payroll admin | The monthly withholding-tax remittance worksheet; how it reconciles to 1604-C |
| [BIR 1604-C Alphalist](bir-alphalist.md) | Payroll admin | Generating the Schedule 1 Alphalist of Employees CSV, and how to turn it into the `.DAT` |
| [Tax & compliance (BIR + agency forms)](final-pay-and-contributions.md) | Accounting / payroll admin | Accounting → Tax & Compliance (1601-C, 1604-C + reconciliation, Alphalist, 2316, 0619-E, 2550M, SSS/PhilHealth/Pag-IBIG schedules) and HR's final-pay / 13th-month worksheets |
| [Books — the general ledger](general-ledger.md) | Bookkeeper / accountant | Setting up the chart of accounts, recording & posting journal entries, closing periods, and the Trial Balance / P&L / Balance Sheet / GL reports (Phase 0) |

## Writing a new guide

When a feature ships, add a guide here **in the same change**. Keep to this shape:

1. **What it's for** — one or two sentences, in the user's words.
2. **Before you start** — permissions needed, where the button is.
3. **Steps** — numbered, imperative ("Click…", "Choose…"), one action per step.
4. **Tips & gotchas** — the things that trip people up.
5. **If something goes wrong** — the common errors and the fix.

Then add a row to the table above.
