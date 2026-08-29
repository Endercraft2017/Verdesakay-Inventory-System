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
| [Using the AI Assistant](ai-assistant.md) | Everyone | Ask questions about your data, get reports and Word documents, take quick actions |
| [The Mobile Warehouse App](mobile-warehouse-app.md) | Warehouse / stockroom | Scan, move, count, receive, and report damage from a phone — online or offline |
| [Sending email from the system](sending-email.md) | Staff with the Email tool | Send a message, payslip, or PO by email; what to do when it fails |
| [Payroll rate tables](payroll-rate-tables.md) | Payroll admin | The SSS / PhilHealth / Pag-IBIG / BIR withholding tables the system uses; when and how to update them each year |
| [BIR Form 2316](bir-2316.md) | Payroll admin | Generating the year-end Certificate of Compensation Payment / Tax Withheld per employee; what it doesn't track |

## Writing a new guide

When a feature ships, add a guide here **in the same change**. Keep to this shape:

1. **What it's for** — one or two sentences, in the user's words.
2. **Before you start** — permissions needed, where the button is.
3. **Steps** — numbered, imperative ("Click…", "Choose…"), one action per step.
4. **Tips & gotchas** — the things that trip people up.
5. **If something goes wrong** — the common errors and the fix.

Then add a row to the table above.
