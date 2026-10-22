# Tenant module isolation

A subscription change disables access; it does not drop tables, delete records, or remove source files. Core login, accounts, documents, messages, reporting shell, and admin support remain available. Existing data becomes accessible again when its module is enabled.

| Module | Required subscription modules | Standalone behavior |
| --- | --- | --- |
| Inventory | None | Items, stock, sales/job orders and warehouse operations. Purchase orders also require purchasing. |
| Manufacturing | Inventory | BOM, job orders, production and QC share items and stock. |
| Purchasing | Inventory | Purchase orders, receipts and vendor bills share suppliers and items. |
| HR | None | Employee records, attendance and payroll. Accounting posting is optional. |
| Accounting | None | Accounting screens and ledger; integration data depends on subscribed operational modules. |
| AI | None | Core tools work alone; inventory, purchasing, HR, accounting and email tools require their corresponding entitlements and user permissions. |
| Mobile | None | Enables the mobile shell; individual mobile workflows need their corresponding modules. |
| Email | None | Company mailbox tool. System email notifications are separate from this optional mailbox subscription. |
| QuickBooks | Inventory | Order export requires inventory; exporting purchase orders additionally requires purchasing. Provider credentials are required. |

The resolver automatically includes dependencies. For example, removing inventory while retaining manufacturing keeps inventory enabled. Remove manufacturing and purchasing (and QuickBooks) first if inventory itself should become unavailable. Config validation rejects incomplete dependency lists where used.

Route guards enforce entitlements, navigation hides unavailable sections, shared tenant analytics omit disabled-module sections, and AI tool permissions are intersected with entitlements. Background QuickBooks auto-push and new accounting auto-posting stop when their modules are disabled. Accounting reversals for already-posted source documents remain available internally to preserve journal consistency.

This is a modular monolith with shared tables and infrastructure, not independently deployable services. Physically deleting module files is unsupported. Dependencies between operational workflows still exist, and enabling a module alone does not make another module's workflow available.

Regression coverage in `tests/modules.test.ts` exercises core access and representative routes with no modules, each module alone (with dependencies), and each single-module downgrade. It checks inventory data preservation and AI tool enforcement. These checks do not prove every possible workflow combination.

## Admin support

Registered tenant administrators (`users.manage`) can use **Support → Contact OTOM** to submit bugs/issues and reply. Reports are stored centrally in `platform.db` with category, priority, subject, description, submitter and timestamp. They remain available without paid modules and while billing is past due. Suspended tenants remain blocked by the tenant access policy.

The owner console shows unresolved/urgent counts in Overview and full ticket threads in Support. Owners can reply and set Open, In progress, or Resolved. Legacy owner-created internal entries remain owner-only; they are not disclosed by the tenant API. Only tenant-submitted threads are visible to the tenant.

Ticket delivery requires the online tenant workspace. Installed/offline copies cannot write local support records that never reach the owner. There are no email notifications or attachments in this version; owners check the console and admins refresh their support page. Existing support rows are preserved through additive schema changes.
