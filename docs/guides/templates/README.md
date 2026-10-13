# Import templates

Ready-to-fill CSV templates for bulk-loading data. Each is the **same file** the
**Download template** button produces inside the app's Import window — kept here too so
you can send one to a customer before onboarding, or open it in Excel / Google Sheets and
fill it in offline.

| File | Import at | Matched (updated) by |
|---|---|---|
| [inventory-items.csv](inventory-items.csv) | Inventory → **Import** | `sku` |
| [suppliers.csv](suppliers.csv) | Inventory → Suppliers → **Import** | `name` (case-insensitive) |
| [employees.csv](employees.csv) | HR → Employees → **Import** | `employee_no` |

**How to use:** keep the header row, replace the example rows with your data, save as
CSV, then in the app click **Import**, load the file, leave **“Check first”** ticked to
preview, fix anything flagged, then import for real. Full walkthrough:
[../csv-import-export.md](../csv-import-export.md).

---

## Inventory items — columns

| Column | Required | Notes |
|---|---|---|
| `name` | ✅ | The item name. |
| `sku` | — | Unique code. **This is the match key.** Blank = always created new. Two rows can't share a SKU. |
| `category` | — | Free text (e.g. Fasteners, Raw Material). |
| `department` | — | Must already exist (Admin → Departments). Matched by name. |
| `supplier` | — | Must already exist (Suppliers screen). Matched by name. |
| `unit` | — | pcs, kg, sheet, box… Defaults to `pcs`. |
| `min_quantity` | — | Reorder level. Non-negative whole number. The item flags as low when stock ≤ this. |
| `quantity` | — | **Opening stock — only applied when the row creates a new item.** Ignored on an update (use Stock in/out to change stock). Put `0` if none yet. |
| `location` | — | Free-text location label on the item (not the multi-location stock — that's set by receiving/transfer). |
| `notes` | — | Anything. |

## Suppliers — columns

| Column | Required | Notes |
|---|---|---|
| `name` | ✅ | **Match key** (case-insensitive). |
| `contact_person` | — | |
| `phone` | — | Any format. Wrap in quotes if it contains a comma. |
| `email` | — | |
| `address` | — | Wrap in `"quotes"` if it contains a comma. |
| `notes` | — | Payment terms, etc. |

## Employees — columns

| Column | Required | Notes |
|---|---|---|
| `employee_no` | ✅ | **Match key.** Your own numbering (e.g. EMP-0001). |
| `name` | ✅ | Full name. |
| `department` | — | Must already exist. Matched by name. |
| `position` | — | Job title. |
| `rate_type` | — | `daily` or `monthly`. Defaults to `daily`. |
| `daily_rate` | needed if `rate_type=daily` | Number, no commas or ₱ sign. |
| `monthly_rate` | needed if `rate_type=monthly` | Number. The system stores the equivalent daily rate automatically. |
| `status` | — | `probationary`, `regular`, `resigned`, or `terminated`. Defaults to `probationary`. |
| `start_date` | — | `YYYY-MM-DD` (e.g. 2024-03-01). |
| `sss_no` | — | Leave blank if unknown; fill in later. |
| `philhealth_no` | — | |
| `pagibig_no` | — | |
| `tin_no` | — | |

Import **never** changes an employee's linked login account, photo, or payroll history —
it only writes the 201-file master fields above.

---

### Excel / Google Sheets tips

- Save/Download as **CSV** (comma-separated), UTF-8.
- Numbers: no thousands separators, no currency symbols (`25000`, not `₱25,000`).
- If a cell has a comma (an address), the app handles it, but keep it wrapped in quotes if
  your editor doesn't do that automatically.
- Delete the example rows before importing; keeping them creates sample records in your
  actual workspace.
