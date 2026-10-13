# Bulk import & export (CSV)

Load or update many records at once from a spreadsheet, and export your data back out to
a `.csv` file you can open in Excel or Google Sheets.

Available for **Inventory items**, **Suppliers**, and **Employees**. They all work the
same way.

## What it's for

- **Onboarding** — get your existing item list, vendor list, or staff list into the
  system in minutes instead of typing each one.
- **Bulk edits** — export, change a column in Excel (reorder levels, item descriptions, positions),
  re-import.
- **Backups / sharing** — export a clean copy of your data whenever you want.

## Before you start

| Data | Where | Permission |
|---|---|---|
| Items | Inventory → **Import** button (top right) | Inventory: create |
| Suppliers | Inventory → Suppliers → **Import** | Inventory: create |
| Employees | HR → Employees → **Import** | HR: manage |

Export sits next to Import (or inside the Import window as **Export current data**).

## Steps — importing

1. Open the list screen and click **Import**.
2. Click **Download template** to get a `.csv` with the correct column headers and a few
   example rows. Fill it in with your data (keep the header row; replace the examples).
   The same templates are in [templates/](templates/) if you'd rather grab them up front
   or send one to a customer — [templates/README.md](templates/README.md) explains every
   column.
3. Back in the Import window, either **Choose file…** or paste the CSV text into the box.
4. Leave **“Check first (validate, don’t save)”** ticked and click **Import**. Nothing is
   saved yet — you get a report: how many rows would be *created*, *updated*, or
   *skipped*, and the reason for each skipped row.
5. Fix any flagged rows in your spreadsheet and repeat step 3–4 until there are no errors.
6. Untick **Check first** and click **Import** again to save for real.

## How rows are matched (create vs update)

Each record type has a **key column**. If a row's key matches an existing record, that
record is **updated**; otherwise a new one is **created**.

| Data | Key column | Notes |
|---|---|---|
| Items | `sku` | A row with a blank SKU is always created. Import **never changes an existing item's stock quantity** — use Stock in/out for that. On a *new* item, the `quantity` column becomes its opening stock. |
| Suppliers | `name` (case-insensitive) | |
| Employees | `employee_no` | Never touches the person's linked login account, photo, or payroll history — master data only. |

## The columns

**Items:** `name` (required), `sku`, `category`, `department`, `supplier`, `unit`,
`min_quantity`, `quantity`, `location`, `notes`.
`department` and `supplier` are matched **by name** and must already exist.

**Suppliers:** `name` (required), `contact_person`, `phone`, `email`, `address`, `notes`.

**Employees:** `employee_no` + `name` (required), `department` (must exist), `position`,
`rate_type` (`daily` or `monthly`), `daily_rate` **or** `monthly_rate`, `status`
(`probationary` / `regular` / `resigned` / `terminated`), `start_date` (`YYYY-MM-DD`),
`sss_no`, `philhealth_no`, `pagibig_no`, `tin_no`.

The item CSV importer does not support barcode, custom attributes or price/cost fields;
edit those on the item screen.

Column headers are not case-sensitive and a few friendly spellings are accepted
(e.g. `Reorder Level` → `min_quantity`, `Salary` → `monthly_rate`, `Date Hired` →
`start_date`).

## Tips & gotchas

- **Create your departments and suppliers first.** Import won't invent them — a row
  pointing at a department or supplier that doesn't exist is skipped with an error.
- **One bad row doesn't stop the rest.** Good rows in the same file still import; only the
  flagged rows are skipped.
- **Preserve match keys.** Export → edit → re-import updates rows with unchanged keys.
  A blank item SKU creates a new item on every import. Changing a SKU or employee number
  also creates a new record instead of renaming the original.
- Keep the header row. A file with no `name` column (or no `employee_no`) is rejected
  outright.
- Big files are fine; the limit is about 5 MB of text (tens of thousands of rows).

## If something goes wrong

| Message | Meaning / fix |
|---|---|
| “The CSV must have a "name" column.” | Your header row is missing a required column, or it's misspelled. |
| “Unknown department "X"” | Create department X first (Admin → Departments, or HR → the department picker). |
| “Unknown supplier "X"” | Add supplier X first, or clear that cell. |
| “Monthly rate is required when rate type is monthly” | Fill `monthly_rate`, or set `rate_type` to `daily`. |
| Row skipped, “Invalid row” | Usually a bad number (letters in a numeric column) or a value too long. |
| Everything imported but stock is 0 | Expected for existing items — import never moves stock. Use **Stock in/out** at the correct location to post the opening balance or correction. |
