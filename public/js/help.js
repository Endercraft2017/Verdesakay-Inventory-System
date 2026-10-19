/* In-app Help. A rail button (data-tool="help", wired in tools.js) opens a drawer
   with plain-language explainers for the screen the user is on, plus an index to
   every other topic. Content is authored here as HTML; the fuller written manuals
   live in docs/guides/ for trainers. */
(function () {
  // group -> for the picker's <optgroup>. routes -> which App route auto-selects this.
  const TOPICS = [
    { id: 'departments', title: 'Departments', group: 'Admin', routes: [],
      html: `<p><b>Admin → Accounts → Departments</b> opens the department manager.</p><ol><li>Enter a name in <b>Add department</b> and click <b>Add</b>.</li><li>Use a row's <b>Edit</b> action to rename it or assign its Head (approves requests).</li><li>Review the Members, Items and Files counts before deleting a department.</li></ol><p>Department management needs <i>users.manage</i>. Close this dialog to return to the account list.</p>`,
    },
    { id: 'payments', title: 'Payments', group: 'Accounting', routes: [], workflow: 'accounting',
      html: `<p><b>Accounting → Receivables &amp; Payables → Payments</b> lists customer receipts and supplier settlements. Set up <b>Books</b> and a cash/bank account first so Deposit to / Pay from has an account to select.</p><ol><li>Click <b>Record payment</b>, choose whether money is received or paid, select the party, date, amount and cash/bank account.</li><li>For invoice/bill allocations, open the party from AR / AP Aging and use its Record receipt/payment action; tick the open documents and set each Apply amount. The top-level Record payment form records an on-account payment. Click <b>Save payment</b> (needs <i>accounting.manage</i>).</li><li>Open a posted payment to review its allocations. Use <b>Void payment</b> for a mistake; do not post a second payment as a correction.</li></ol><p>View access needs <i>accounting.view</i>.</p>`,
    },
    { id: 'credit-notes', title: 'Credit / Debit Notes', group: 'Accounting', routes: [], workflow: 'accounting',
      html: `<p><b>Accounting → Receivables &amp; Payables → Credit / Debit Notes</b> records returns, allowances and overbilling.</p><ol><li>Click <b>New note</b>, choose Customer credit or Supplier debit, select the party, Date, Net amount, VAT amount, optional Tax code and Reason. For a return-linked customer credit select its Related sale order.</li><li>Review the values and click <b>Issue note</b> (needs <i>accounting.manage</i>).</li><li>Open an issued note to see its details; use <b>Void note</b> if it was issued incorrectly.</li></ol><p>A note adjusts the financial balance; it is not a general stock-return form.</p>`,
    },
    { id: 'qc-findings', title: 'QC / QA Findings & Reports', group: 'Manufacturing', routes: [], workflow: 'production',
      html: `<p><b>Production → QC / QA → Findings &amp; Reports</b> is the inspection history.</p><ol><li>Filter the result and date range, or search by job order or product.</li><li>Open a finding to see the inspector, remarks, disposition and checklist snapshot.</li><li>Use <b>Export</b> to download the filtered findings.</li></ol><p>Recording a new Pass/Fail belongs to <b>Inspection Queue</b>, not this history view. Reading needs <i>inventory.view</i>.</p>`,
    },
    { id: 'low-stock', title: 'Low Stock', group: 'Inventory', routes: [], workflow: 'inventory',
      html: `<p><b>Inventory → Items → Low Stock</b> opens the inventory list with <b>Low stock</b> ticked.</p><ol><li>Review items at or below their Safety Stock Quantity (reorder level); use other list filters to narrow the result.</li><li>Click <b>Reorder PO</b>, review the target multiplier and draft purchases (needs <i>purchasing.manage</i>).</li><li>Review the drafts under <b>Inventory → Orders → Purchase Orders</b>. Finished products are skipped; build those through Production.</li><li>Untick <b>Low stock</b> or choose All Items to return to the full catalogue.</li></ol>`,
    },

    {
      id: 'purchase-orders', title: 'Purchase Orders', group: 'Orders', routes: [], workflow: 'purchasing',
      html: `<p><b>Inventory → Orders → Purchase Orders</b> is the purchasing document list.</p><ol><li>Click <b>New Purchase Order</b>, choose <b>Supplier (on file)</b>, set Expected delivery, and add the items, quantities and prices.</li><li>Save the order, then review its row details and print it with the appropriate template.</li><li>Use the row's <b>Receiving &amp; bills</b> action to <b>Record receipt</b> for deliveries and enter vendor bills.</li><li>Managing POs and bills needs <i>purchasing.manage</i>; receiving needs <i>inventory.adjust</i>. Posting a goods receipt adds stock. Approving a bill checks receipt coverage and PO prices; creating the PO alone does not receive goods.</li></ol><p>This is separate from Sale Orders and production Job Orders.</p>`,
    },
    {
      id: 'job-documents', title: 'Job Order documents', group: 'Orders', routes: [],
      html: `<p><b>Inventory → Orders → Job Orders</b> stores customer work documents, numbered JO-….</p><ol><li>Click <b>New Job Order</b>, enter the customer, work/items, quantities and prices, and save.</li><li>Open the row to review or print the document.</li><li>For a build, use the row's <b>Start production</b> action, choose the finished product, build quantity, source and output locations, then create the linked production order.</li><li>Manage that build under <b>Production → Job Orders</b>; the JO document and the production order are separate records.</li></ol><p>Stock-kit release, acceptance, inspection and Products In belong to the production order, not this document.</p>`,
    },
    {
      id: 'new-item', title: 'New / Edit item', group: 'Inventory', routes: [],
      html: `<p>Open <b>Inventory → All Items → New item</b>, or use the row's Edit action.</p><ol><li>On <b>Default</b>, enter <b>Item Name</b> and <b>Item Code</b> (the SKU). A blank code can use the numbering policy; <b>Fn</b> controls its format for accounts with configuration access.</li><li>Choose Unit, Category, Department and Supplier; set Purchase Price, Sale Price and Standard Cost where applicable.</li><li>Use <b>Qty</b> for <b>Safety Stock Quantity</b> (the reorder level) and stock-related fields, and <b>Item Information</b> / <b>Additional Information</b> for other details.</li><li>Click <b>Create item</b> or <b>Save changes</b>. Set opening Inventory Qty when creating; use Stock in / out for later quantity changes.</li></ol><p><b>Option</b> changes which fields and tabs appear (needs <i>inventory.configure</i>). Labels and visibility can be customized, so your company's layout may differ.</p>`,
    },
    {
      id: 'payroll-policy', title: 'Payroll Policy Settings', group: 'HR', routes: [], workflow: 'payroll',
      html: `<p>Open <b>HR → Time Keeping → Policy Settings</b> (changes need <i>hr.manage</i>).</p><ol><li>In <b>Shifts</b>, use <b>Add Shift</b> for start/end times and the default shift.</li><li>In <b>Payroll Rules</b>, review grace, late/OT blocks and rates, monthly-rate divisor, the OT cap and whether a linked approved OT form is required.</li><li>Review the fixed/per-hours pay mode, minimum-time and half-day rules, lunch deduction and rest-day defaults.</li><li>Set pay frequency, automatic statutory deductions and the cutoff deduction schedule. Use <b>Open rate tables</b> for effective-dated contribution rules.</li><li>Scroll to <b>Save Rules</b>, then check the recalculated attendance before generating payslips.</li></ol><p>Kiosk approval, clock-location and attendance settings are also available here. Policy changes affect later computations; review existing periods before regenerating payroll.</p>`,
    },
    {
      id: 'cutoff', title: 'New / Edit Cutoff', group: 'HR', routes: [], workflow: 'payroll',
      html: `<p>In <b>HR → Time Keeping</b>, click <b>New Cutoff</b>.</p><ol><li>Enter a Label, Start date and End date; the end must be on or after the start.</li><li>Click <b>Create</b> (or <b>Save</b> when editing), then open the cutoff row.</li><li>Use the employee-picker or <b>Add All</b> controls to build its roster. A new cutoff alone has no attendance or payslips.</li><li>Open an employee's Daily Time record to enter or review attendance. Import Punches backfills earlier punches; punches for rostered staff also update attendance live.</li></ol><p>Creation/roster/attendance changes need <i>hr.manage</i>; reading needs <i>hr.view</i>.</p>`,
    },
    {
      id: 'global-variables', title: 'Template variables', group: 'Documents', routes: [],
      html: `<p>Use <b>Documents → Templates → Variables</b> for global template variables, or the editor's variable manager for variables local to one template.</p><ol><li>Click <b>New variable</b> and give it a key, label and category.</li><li>Choose a fixed value, bound data field or formula, complete its settings, and save.</li><li>Insert it with <b>Variables → Insert variable</b> or its <code>{{key}}</code> token.</li><li>Check a preview and a real printed record; a field may be empty if that record has no value.</li></ol><p>Changing a global variable affects every template using it. Editing variables requires <i>templates.edit</i>.</p>`,
    },
    {
      id: 'company-profile', title: 'Company profile', group: 'Documents', routes: [],
      html: `<p>Open <b>Documents → Templates → Company profile</b>.</p><ol><li>Enter the company name, address, phone, email and Logo URL.</li><li>Choose whether to compress large message images before uploading.</li><li>Click <b>Save</b> (needs <i>templates.company</i>), then preview a document that uses <code>{{company.*}}</code>.</li></ol><p>These values are shared across templates; this is different from editing one template. Without company-profile permission the fields are read-only.</p>`,
    },
    {
      id: 'barcode-labels', title: 'Barcode labels', group: 'Inventory', routes: [], workflow: 'inventory',
      html: `<p>In <b>Inventory</b>, filter the item list first, then click <b>Labels</b>.</p><ol><li>Choose Label size, Copies per item and whether to show the name.</li><li>Tick the items to print; Toggle all changes the selection.</li><li>Click <b>Open print sheet</b>, review the sheet and print it.</li></ol><p>Labels encode the item's Barcode when set, otherwise Item Code/SKU. Items without a code are skipped. These are item barcodes; serialized production units use their own QR labels.</p>`,
    },

    {
      id: 'data-forms', title: 'Data Forms', group: 'Documents', routes: ['form-records'],
      html: `<p><b>Documents → Data Forms</b> is the hub for versioned entries, connected values and linked print layouts.</p><ol><li>Choose a form, then use search, favorites/recents, columns or saved filters.</li><li>Complete the original schema’s fields; connected selections save reviewed source values and calculations are recomputed by the server. Save Draft to continue later.</li><li>An Inventory entry user needs <i>forms.fill.inventory</i> and that form’s Access role/account grant; existing managers retain their section access. Entry access is not design, delete or approval access.</li><li>Submit only after review. A sales-enabled form links to one open sales order; use <b>Review sales order</b> for subsequent sales changes. The submitted source record is locked.</li><li>Check revision history before corrections. Archived forms block new records; authorized historical corrections require a reason. CSV preview lists rejected source lines and requires consent for partial import.</li></ol><p>A form called Invoice does not itself issue a posted accounting invoice or move stock.</p>`,
    },
    {
      id: 'payroll-records', title: 'Payroll records', group: 'HR', routes: [],
      html: `<p><b>HR → Payroll</b> uses the HR Payroll Data Form.</p><ol><li>Generate from a populated cutoff, then compare earnings/deductions with attendance and approved requests.</li><li>Preview deduction overrides, then explicitly save. Inspect the before/after history, actor and reason. Paid slips reject edits; archived corrections require a reason.</li><li>An earlier correction flags later same-month cutoffs. Review/regenerate unpaid later cutoffs oldest first; manual amounts and paid locks need separate review.</li><li>Paid records are finalized; employee draft payroll/timekeeping is watermarked and may change. Final payslip download is available only while Paid.</li><li>Use <b>Post to GL</b> explicitly and check any re-posting flag after recalculation. Payment and ledger posting are separate checkpoints.</li></ol>`,
    },
    {
      id: 'hr-forms', title: 'HR request forms and notices', group: 'HR', routes: [],
      html: `<p><b>HR → HR Forms</b> opens HR Data Forms, including leave, overtime, offset, undertime and notices.</p><ol><li>Choose the form and create or review its records (needs <i>forms.manage.hr</i>).</li><li>Complete the employee, date and request details, then use the available approval actions.</li><li>In <b>Time Keeping</b>, link the approved request to the appropriate attendance day. Saving a form alone does not attach it to attendance.</li></ol>`,
    },
    {
      id: 'stock-movements', title: 'Stock Movements', group: 'Inventory', routes: ['inventory-movements'],
      html: `<p><b>Inventory → Stock Movements → All Movements</b> is the read-only movement history across items.</p><ol><li>Search by item, SKU or reason; choose Stock IN/OUT, location and date filters.</li><li>Review the change, location balance, total balance, reason and staff member.</li><li>Use Prev/Next to browse history and Export to download the filtered movements.</li></ol><p>Reading requires <i>inventory.view</i>. Make corrections from the item actions in All Items; this log does not edit stock.</p>`,
    },
    {
      id: 'production-record', title: 'Production record', group: 'Manufacturing', routes: ['production-record'],
      html: `<p>A unit or batch's <b>Production record</b> is its printable traceability history (needs <i>inventory.view</i>).</p><ol><li>Open it from a unit/batch's View record action, or scan its label in the phone app and choose Open production record.</li><li>Review identity, job order, build photo, team, inspection findings, repairs and movements.</li><li>Use Print for the record or Print label where available.</li></ol><p>Opening the route without a unit or batch does not select a record; open it from its source first. A record or label does not receive stock.</p>`,
    },
    {
      id: 'production-teams', title: 'Production Teams', group: 'Manufacturing', routes: ['production-teams'],
      html: `<p><b>Production → Scheduling → Teams</b> manages crews (read: <i>inventory.view</i>; changes: <i>inventory.adjust</i>).</p><ol><li>Click New team, enter its name and notes, and create it.</li><li>Open the team row, click Add members, select employees and an optional role, then Add selected.</li><li>Assign the team on the job order's New/Edit or Team / schedule form.</li></ol><p>A team referenced by any job order cannot be deleted. Edit it and clear Active instead.</p>`,
    },
    {
      id: 'notes', title: 'Notes', group: 'Tools', routes: [],
      html: `<p>Open the right-rail <b>Notes</b> tool for your private notes.</p><ol><li>Click New note, enter an optional title and the required note text, then save.</li><li>Open an existing note to edit it; use its delete action to remove it.</li></ol><p>Notes are saved to your account and remain after closing the drawer.</p>`,
    },
    {
      id: 'scheduler', title: 'Scheduler', group: 'Tools', routes: [],
      html: `<p>Open <b>Scheduler</b> on the right rail for your personal tasks.</p><ol><li>Enter a task title and optional due date, then click Add.</li><li>Tick the task to mark it done, or untick to reopen it.</li><li>Use the delete action to remove a task.</li></ol><p>These are saved tasks; entering a due date does not configure an automatic job.</p>`,
    },
    {
      id: 'bookmarks', title: 'Bookmarks', group: 'Tools', routes: [],
      html: `<p>Open <b>Bookmarks</b> on the right rail to save shortcuts.</p><ol><li>Navigate to the screen and filter you want to save.</li><li>Open Bookmarks and click Bookmark current page.</li><li>Choose a saved bookmark to return to that location, or delete an unwanted bookmark.</li></ol><p>A shortcut does not grant access to a restricted screen.</p>`,
    },
    {
      id: 'bug-reports', title: 'Report a bug', group: 'Tools', routes: [],
      html: `<p>Use the right-rail bug button to report a software problem.</p><ol><li>Enter a clear title, describe what you did and what happened, and include reproduction steps.</li><li>Add a screenshot or attachment if available, then submit the report.</li></ol><p>Administrators can use View reports to review reports. For a stock or parts-kit issue, use the phone's Report a problem to message a supervisor.</p>`,
    },

    {
      id: 'site-map', title: 'Site Map', group: 'Basics', routes: [],
      html: `<p>Use the Site Map to find and open a screen.</p><ol><li>Find the area heading, then the subsection and screen name. Scroll inside the map to see the remaining areas.</li><li>Click a screen name to close the map and open that screen. Entries such as Low Stock or Payroll open their own filtered view.</li><li>Only areas available to your account and workspace appear. Ask an administrator about missing access.</li><li>Click Close to return to your current screen. Search Menu is another way to find a screen by name.</li></ol>`,
    },
    {
      id: 'guide-center', title: 'Guide Center', group: 'Basics', routes: ['sop'],
      html: `<p>Browse the end-to-end workflows from Home → Help / SOP.</p><ol><li>Choose a workflow from the list to read its steps in order.</li><li>Use a screen link to open the screen described by that step.</li><li>Start the walkthrough for guided navigation. Back and Next change steps; Finish ends the walkthrough.</li><li>Use Print to print the selected workflow.</li></ol>`,
    },
    {
      id: 'files', title: 'Files', group: 'Documents', routes: ['forms'],
      html: `<p>Documents → Files → All Files stores uploaded documents, separate from Data Forms.</p><ol><li>Click Upload, choose a file and complete its details, then save.</li><li>Search or filter the list to find a file. Open a row to preview supported formats.</li><li>Use Download to save a copy, or Print where available. Delete is shown only when you have permission.</li></ol>`,
    },
    {
      id: 'customers', title: 'Customers', group: 'Inventory', routes: ['customers'],
      html: `<p>Inventory → Customers stores the customer records used by sale orders.</p><ol><li>Click New customer and enter the customer and contact details, then save.</li><li>Search by customer details; open a row to inspect the record.</li><li>Use Edit to update details. Creating and editing customers requires <i>orders.edit</i>; deleting requires <i>orders.delete</i>.</li></ol>`,
    },
    {
      id: 'announcements', title: 'Announcements', group: 'Basics', routes: ['announcements'],
      html: `<p>Home → Announcements shows notices shared with staff.</p><ol><li>Read the announcement list for current notices.</li><li>With posting access, click New announcement, complete the notice and save.</li><li>Use the row Edit or Delete buttons to manage a notice when your role allows it.</li></ol>`,
    },
    {
      id: 'hr-overview', title: 'Human Resources overview', group: 'HR', routes: ['hr'],
      html: `<p>HR → Overview summarises employees, attendance and HR work.</p><ol><li>Open an attendance summary to view the matching Daily Report.</li><li>Use Employees for staff records and Time Keeping for cutoff attendance and payroll.</li><li>Payroll and HR Forms open their respective Data Forms.</li></ol>`,
    },
    {
      id: 'kiosk', title: 'Time-in Kiosk', group: 'HR', routes: ['hr-kiosk'],
      html: `<p>HR → Time Keeping → Time-in Kiosk records live attendance punches on the office monitor.</p><ol><li>If this PC needs approval, ask an HR manager to approve it as an office kiosk.</li><li>Allow camera access. Employees scan the rotating QR from the phone app, or enter their employee number on the kiosk.</li><li>Check the displayed confirmation after each punch.</li><li>Field Work records separate departures and returns; it does not change payroll hours. Import or reconcile attendance in Time Keeping for payroll.</li></ol>`,
    },
    {
      id: 'daily-report', title: 'Daily Report', group: 'HR', routes: ['hr-daily-report'],
      html: `<p>HR → Time Keeping → Daily Report shows attendance for the selected date.</p><ol><li>Choose a date, or click Today, then Refresh to reload the figures.</li><li>Filter by status or search for an employee; review the department summaries.</li><li>The roster comes from cutoff periods covering that date. If no cutoff covers it, set up the cutoff and its roster in Time Keeping.</li><li>Live kiosk and phone punches supplement attendance that has not been entered or imported into the cutoff grid.</li></ol>`,
    },
    {
      id: 'production-overview', title: 'Production overview', group: 'Manufacturing', routes: ['production-overview'],
      html: `<p>Production → Overview summarises production work and waiting queues.</p><ol><li>Review overdue job orders, rework and pending inspections or receipts.</li><li>Open a summary row to go to the screen that handles the work.</li><li>Use Product Setup for BOMs, Job Orders for builds, and Products In for receiving finished output.</li></ol>`,
    },
    {
      id: 'production-qc', title: 'QC / QA', group: 'Manufacturing', routes: ['production-qc'],
      html: `<p><b>Production → QC / QA</b> separates inspection from receiving.</p><ol><li>Choose a unit on your authorized QC or QA stage. A single-stage job combines the checks; two stages enforce separate permissions.</li><li>Complete required checks; N/A does not satisfy a required check. Fail/hold needs the unit’s evidence photo.</li><li>Choose Pass, repair/rectification or terminal rejection. Final QA holds need an authorized hold decision; they do not enter RTS while unresolved.</li><li>Settle repair-part requests and re-inspect. Informational issue reports alone never advance or block the inspection.</li><li>Final-passed units go to <b>Products In</b>; passing does not add stock.</li></ol>`,
    },
    {
      id: 'repairs', title: 'Repairs & Parts Requests', group: 'Manufacturing', routes: ['repairs'],
      html: `<p><b>Repairs &amp; Parts Requests</b> supplies extra/replacement parts for inspection rework or a customer return repair.</p><ol><li>Raise the request with the exact part, quantity and fault reason. Available stock is held for it.</li><li>The clerk selects an approved storage source and issues only the approved part and quantity. Escalate shortages.</li><li>A changed part or quantity needs a formal revision approved by the requester or independent supervisor; the proposer cannot approve it.</li><li>Settle all requests before reinspection. A manufacturing unit returns to QC/QA; returned customer goods need repair completion and a fresh warehouse return inspection.</li></ol>`,
    },
    {
      id: 'products-in', title: 'Products In', group: 'Manufacturing', routes: ['production-receiving'],
      html: `<p><b>Products In / RTS recording</b> is the stock-in checkpoint after quality.</p><ol><li>Choose ready units and actual whole-number batch quantities. Desktop can combine units and multiple batches into one receipt at one storage location.</li><li>Verify the physical output and exact destination. Total capacity, duplicate serials, invalid/transit locations and product-data mismatches may block posting.</li><li>Post once and check Receipt History. Phone groups save per-job receipt attempts before submission; recover unknown results with their original key.</li><li>A site-PC acknowledgement remains pending until sync confirms. Transfer received stock if the sale ships from a different location.</li></ol><p>Do not use Products In for customer return reinspection; that has its own return workflow.</p>`,
    },
    {
      id: 'finished-goods', title: 'Finished Goods', group: 'Manufacturing', routes: ['finished-goods'],
      html: `<p>Production → Finished Goods lists received products currently on hand.</p><ol><li>Search by product name or SKU.</li><li>Open a product row for its details and unit or location breakdown.</li><li>Use Sell / Move for stock on hand (needs <i>inventory.adjust</i>). Sell deducts stock immediately; Release SOs instead reserves it until the order is confirmed/completed. If nothing appears, check that Products In has received the output.</li></ol>`,
    },
    {
      id: 'receivables', title: 'Receivables & Payables', group: 'Accounting', routes: ['accounting-receivables'],
      html: `<p>Accounting → Receivables & Payables tracks outstanding invoices, bills and settlements.</p><ol><li>Review AR / AP aging for the chosen date and open a party to inspect outstanding balances.</li><li>With accounting manage access, click Record payment and enter the customer receipt or supplier payment and its allocations.</li><li>Use Payments to review posted settlements. Void a mistaken payment rather than editing its history.</li><li>Use Credit / Debit Notes for returns, allowances or overbilling; open a note to inspect or void it when allowed.</li></ol>`,
    },

    {
      id: 'getting-started', title: 'Getting around', group: 'Basics', routes: ['dashboard'],
      html: `
        <p>The system is organised into <b>areas</b> along the top (Inventory, Documents, HR, …),
        each with <b>sub-tabs</b> and a tree of screens on the left.</p>
        <ul>
          <li><b>Search Menu</b> (top-left) jumps to any screen by name.</li>
          <li><b>Site Map</b> shows everything you can open, at a glance.</li>
          <li>The <b>icon rail</b> on the right holds your personal tools — AI Assistant,
              Notes, Email, Scheduler, Bookmarks — and this <b>Help</b> button.</li>
          <li>You only see what your <b>role</b> allows. If a screen or button is missing,
              it's a permission — ask an admin.</li>
        </ul>
        <p>Help always opens to the screen you're on. Use the picker above to read any
        other topic.</p>`,
    },
    {
      id: 'analytics', title: 'Reports (operational dashboards)', group: 'Basics', routes: ['analytics'],
      html: `
        <p><b>Home → Reports</b> is a fixed, at-a-glance snapshot of the business — no
        need to ask the AI assistant. You see only the sections your role allows.</p>
        <ul>
          <li><b>Inventory</b> — total <b>stock value</b> (quantity × each item's
              standard cost, falling back to purchase price), low / out-of-stock counts,
              <b>dead stock</b> (on hand but no movement in 90 days), value by location,
              and the highest-value items.</li>
          <li><b>Production</b> — work in progress, units finished in the last 30 / 90
              days, <b>scrap rate</b>, job orders by status, recently completed MOs.</li>
          <li><b>Purchasing &amp; payables</b> — open POs and their value, <b>received
              but not invoiced</b>, bills waiting for approval, and <b>payables aging</b>
              (approved vendor bills bucketed by how overdue they are).</li>
          <li><b>Sales orders</b> — open orders and value, a breakdown by status, and the
              last 8 weeks of order volume.</li>
          <li><b>Payroll</b> (HR) — the latest period's headcount, gross, net, statutory
              and tax, plus the last six periods.</li>
        </ul>
        <p>The figures are live — hit <b>Refresh</b> after entering new data. Numbers are
        rounded for display.</p>`,
    },
    {
      id: 'inventory', title: 'Inventory — items & stock', group: 'Inventory', routes: ['inventory'],
      html: `
        <p><b>Inventory → Items → All Items</b> is your catalogue. Each row is a product or material
        with a quantity on hand. Reading needs <i>inventory.view</i>, New/Import <i>inventory.create</i>,
        Edit <i>inventory.edit</i>, stock actions <i>inventory.adjust</i>, and Reorder PO <i>orders.create</i>.</p>
        <ul>
          <li><b>New item</b> — enter Item Name, Item Code (SKU) and Unit on <b>Default</b>.
              Set <b>Safety Stock Quantity</b> (the reorder level) on <b>Qty</b>, then click <b>Create item</b>.
              The <b>Option</b> panel can customize fields and tabs.</li>
          <li><b>Stock in / out</b> (row action) — record a delivery, a withdrawal, or a
              correction. Every change is kept in the item's <b>history</b>.</li>
          <li><b>Transfer</b> — move units from one location to another; the grand total
              doesn't change.</li>
          <li><b>Low Stock</b> filter — everything at or below its reorder level.</li>
          <li><b>Reorder PO</b> — one click drafts purchase orders for everything at or below its
              reorder level, one per preferred supplier, topping each item up to a multiple
              of its reorder level. With the Low Stock filter on it acts on just the
              filtered list. Finished products are skipped (those are produced). Review and
              send the drafts from <i>Purchase Orders</i>.</li>
          <li><b>Import / Export</b> — bulk-load or update items from a spreadsheet
              (see the <i>Bulk import & export</i> topic).</li>
          <li><b>Labels</b> — print <b>Code 128 barcode labels</b> for the items in the
              current list. Each label encodes the item's <b>Barcode</b> field if it has
              one, otherwise its <b>SKU</b>; items with neither are skipped. Pick a label
              size and copies, tick which items, then <b>Open print sheet</b>. A single
              item's detail view also has a <b>Print label</b> button. The labels scan
              back with this system's phone scanner.</li>
        </ul>
        <p><b>Damage:</b> reporting damaged units moves them into a separate "damage"
        record so they leave sellable stock without vanishing from the books.</p>`,
    },
    {
      id: 'csv-import', title: 'Bulk import & export (CSV)', group: 'Inventory',
      routes: [], html: `
        <p>Load or update many <b>items</b>, <b>suppliers</b>, or <b>employees</b> at once
        from a spreadsheet, and export your data back out. All three work the same way —
        the <b>Import</b> button is on each list screen.</p>
        <ol>
          <li>Click <b>Import</b> → <b>Download template</b>. Fill it in (keep the header row).</li>
          <li>Choose the file or paste the text.</li>
          <li>Leave <b>“Check first”</b> ticked and click <b>Import</b> — nothing is saved,
              you get a report of what <i>would</i> be created / updated / skipped and why.</li>
          <li>Fix the flagged rows, then untick <b>Check first</b> and import for real.</li>
        </ol>
        <p><b>How rows match:</b> each type has a key column — items by <code>sku</code>,
        suppliers by <code>name</code>, employees by <code>employee_no</code>. A match
        <b>updates</b>; no match <b>creates</b>.</p>
        <ul>
          <li>Importing <b>never changes an existing item's stock</b>. On a new item, the
              <code>quantity</code> column is its opening stock.</li>
          <li><code>department</code> and <code>supplier</code> are matched by name and must
              <b>already exist</b> — create them first.</li>
          <li>One bad row is skipped with a reason; good rows still import. Review the import report.</li>
          <li>Keep matching keys intact when exporting and reimporting. An item with a blank SKU is always
              created as new, so importing it again creates a duplicate. Item price and barcode fields
              are not supported by the CSV importer.</li>
        </ul>`,
    },
    {
      id: 'suppliers', title: 'Suppliers', group: 'Inventory', routes: ['suppliers'],
      html: `
        <p><b>Inventory → Suppliers</b> is your vendor list. Link an item to a supplier so reorder POs
        know who to buy from. New/Import needs <i>inventory.create</i>; Edit needs <i>inventory.edit</i>;
        Delete needs <i>inventory.delete</i>.</p>
        <ul>
          <li><b>New supplier</b> — name, contact person, phone, email, address.</li>
          <li><b>Import</b> — bulk-load from a spreadsheet (matched by name).</li>
          <li>Deleting a supplier doesn't delete its items — they just lose the link.</li>
        </ul>`,
    },
    {
      id: 'locations', title: 'Locations', group: 'Inventory', routes: ['locations'],
      html: `
        <p><b>Inventory → Locations</b> lists warehouses, branches, stores and trucks holding stock.</p>
        <ol><li>Click <b>New location</b>, enter its name, type, address and notes, then <b>Create location</b>
        (needs <i>inventory.create</i>).</li><li>Open a location to see its stock. Use <b>Set as default</b> for the normal
        destination of new stock, or Edit to change its details (needs <i>inventory.edit</i>).</li>
        <li>Use the item's Transfer action to move stock between locations.</li></ol>
        <p>Deleting needs <i>inventory.delete</i>. Move all stock out first, and choose another default
        before deleting the current default when other locations remain.</p>`,
    },
    {
      id: 'finished-products', title: 'Product Setup & BOM', group: 'Manufacturing',
      routes: ['finished-products'], html: `
        <p>Open <b>Production → Product Setup → Products &amp; BOM</b>, click <b>New finished product</b>,
        choose an existing inventory item and define its BOM, then save (needs <i>inventory.edit</i>).
        Add an item in Inventory first if it is missing. <b>QC/QA Checklists</b> needs <i>qc.configure</i>.</p>
        <p>A <b>finished product</b> is something you build rather than buy. Its
        <b>Bill of Materials (BOM)</b> lists the parts and quantities needed to make one
        unit.</p>
        <p>When you release a <b>Job Order</b> for that product, the system reserves and
        consumes those parts from stock automatically. Keep the BOM accurate and job-order
        consumption takes care of itself.</p>
        <h4>Multi-level BOMs &amp; costing</h4>
        <p>A component can itself be a finished product with its own BOM — a
        <b>sub-assembly</b> (e.g. a wheel that goes into a bike). Open any finished
        product to see:</p>
        <ul>
          <li><b>Std. material cost / unit</b> — the parts cost to build one, with
              sub-assembly costs rolled up from <i>their</i> components. Costs come from
              each item's <i>Standard cost</i> (falling back to <i>Purchase price</i>).</li>
          <li><b>Full material requirements (all levels)</b> — type a build quantity and
              the system explodes every sub-assembly down to raw materials, adds up the
              quantities, and totals the cost. Use this for purchasing and quoting.</li>
          <li><b>Where used</b> — on any BOM line, see every product that consumes that
              part, directly or through a sub-assembly, before you change or discontinue it.</li>
        </ul>
        <p>If a BOM ever refers back to itself, the explosion stops at the loop and shows
        a warning — fix the BOM so it forms a tree.</p>`,
    },
    {
      id: 'job-orders', title: 'Job Orders (production)', group: 'Manufacturing',
      routes: ['job-orders'], html: `<p>Production builds from an approved job through warehouse kit handover, output recording, quality and receiving.</p><ol><li>Create/review the draft and component snapshot. A <i>production.approve</i> holder approves; edits withdraw approval and reset pre-release acceptance/picks.</li><li>Warehouse uses <b>Accept (warehouse)</b>, <b>Pick / review kit</b>, then <b>Release &amp; issue slip</b>. Partial picks hold stock; the numbered parts slip deducts it. Sale-linked jobs use the sale’s stock review for combined purchasing.</li><li>Production counts and accepts the released kit before recording. Record serialized units individually with identifier + photo; use batch quantities only for non-serialized jobs.</li><li>Inspect through configured QC/QA stages. Issues and photos are informational; use authorized Pause to stop work.</li><li>Only <b>Products In</b> receives output into stock. Close early preserves pending/rework/held output and repair requests for completion; it is different from cancellation.</li></ol><p>For uncertain mobile saves, recover the original saved attempt rather than add the same unit or receipt again.</p>`,
    },
    {
      id: 'production-batches', title: 'Batches / lots & records', group: 'Manufacturing',
      routes: ['production-batches'], html: `
        <p><b>Production → Batches / Lots</b>: choose a status filter, then open a batch.
        Reading needs <i>inventory.view</i>; edits need <i>inventory.adjust</i>.</p>
        <p>A <b>batch / lot</b> groups the units off one job order under a
        <code>BATCH-#####</code> number.</p>
        <ul>
          <li>A job order with <b>no inspection stages</b> records one batch per
              production-progress entry automatically. A job order <b>with QC/QA</b> only
              makes a batch when you type a <b>batch label</b> on the progress form — its
              units are then tagged with it.</li>
          <li>Open a batch to <b>relabel</b> it, change its status, or record a
              <b>batch-level QC/QA sign-off</b> (checklist + pass/fail), and to
              <b>print QR labels</b> for it.</li>
          <li>Scanning a unit or batch QR opens its <b>Production record</b> — a printable
              page with the build details, every QC/QA sign-off, repairs, and the stock
              movements it drove. Also reachable from the units table in Finished
              Products.</li>
        </ul>`,
    },
    {
      id: 'production-schedule', title: 'Teams & schedule', group: 'Manufacturing',
      routes: ['production-schedule'], html: `
        <p>Assign job orders to a crew and plan them on a calendar.</p>
        <ul>
          <li><b>Teams</b> — make a named production team and add its members. A job order
              is assigned a team (and a free-text <i>work centre / line</i>) on its
              New / Edit form or the <b>Team / schedule…</b> button. A team can't be
              deleted while a job order points at it — deactivate it instead.</li>
          <li><b>Schedule</b> — a month calendar places each job order across its
              <i>planned start → due date</i>, coloured by status and filterable by team
              or work centre. Set an advisory <b>units/day capacity</b> and days over it
              are flagged; overdue job orders show in red. <b>Home → Reports</b> shows the
              overdue count.</li>
        </ul>`,
    },
    {
      id: 'quickbooks', title: 'QuickBooks Online', group: 'Orders', routes: [],
      html: `
        <p>Push <b>sale / job orders</b> to QuickBooks as <b>Invoices</b> and
        <b>purchase orders</b> as <b>Bills</b>. One-way, on demand or automatic.</p>
        <ul>
          <li>Admins: the <b>QuickBooks</b> button on the Orders screen → <b>Connect</b>
              (a popup signs you in to Intuit and picks the company).</li>
          <li>Once connected, each order row has a <b>QuickBooks</b> icon — click to
              create or update that Invoice / Bill. Re-pushing updates, never duplicates.</li>
          <li><b>Auto-push</b> (a checkbox in the QuickBooks window) sends every saved
              order in the background.</li>
          <li>It's per-workspace and one-way. Your accountant may need to set a default
              income/expense account in QuickBooks for lines to post cleanly.</li>
        </ul>`,
    },
    {
      id: 'orders', title: 'Sale Orders', group: 'Orders',
      routes: ['orders'], workflow: 'sales', html: `<p><b>Inventory → Sale Orders</b> connects customer demand to stock, production, purchasing and trip releases.</p><ol><li>Save an open order with the exact item, price and build state: Fully built, Semi-built or CKD. Services remain non-stock.</li><li>Open <b>Review stock &amp; approval</b>: check the exact ship-from location, commitments, kit/repair holds and linked supply. <b>Awaiting release</b> is unpicked firm demand, not just shortages.</li><li>Draft only uncovered CKD-parts production/purchases. An eligible complete semi-built package can use <b>Finish a semi-built RTS unit</b>; do not issue its BOM again.</li><li>Approve separately and issue current release authority. Warehouse accepts and allocates exact lines; each vehicle gets its own slip and linked trip.</li><li>Further loads stay on the same SO. Cancel only unshipped remaining demand with a reason; shipped returns use the original slip.</li></ol><p>Drafts and allocations are not stock-out. A trip slip deducts only its physical load.</p>`,
    },
    {
      id: 'purchasing', title: 'Purchasing — receiving & vendor bills', group: 'Orders',
      routes: ['purchasing', 'purchase-requests'], html: `
        <p>Purchasing turns a <b>Purchase Order</b> into a controlled flow:</p>
        <p><b>PO → Goods Receipt → Vendor Bill</b>, with a <b>3-way match</b> before any
        bill is approved for payment.</p>
        <h4>Receiving what arrived</h4>
        <ul>
          <li>Open a purchase order (Orders → Purchase Orders → <b>Receiving &amp; bills</b>),
              then <b>Record receipt</b>.</li>
          <li>Pick the location stock lands in and enter the quantity that actually
              arrived per line. Posting the receipt <b>moves that stock in</b> and shows
              in the item's history.</li>
          <li>The PO shows <b>received vs ordered</b> per line and an overall status
              (not received / partial / received / over-received). Receive as many times
              as deliveries come.</li>
          <li>Wrong receipt? <b>Delete</b> it — the stock it posted is reversed.</li>
        </ul>
        <h4>Vendor bills &amp; the 3-way match</h4>
        <ul>
          <li><b>New vendor bill</b> records the supplier's invoice — their invoice
              number, dates, lines and prices.</li>
          <li><b>Approve</b> runs the 3-way match: every billed line must be covered by
              what was <b>received</b> (counting earlier approved bills), and the price
              must be within tolerance of the <b>PO price</b>. Charges not on the PO are
              flagged.</li>
          <li>A clean match approves straight away. Exceptions block approval — receive
              the shortfall, fix the bill, or <b>Force approve</b> (your override is
              recorded against your name).</li>
          <li><b>Dispute</b> parks a bill with a reason; editing a disputed bill returns
              it to draft.</li>
        </ul>
        <p><b>Internal Purchase Requests</b> are separate: staff propose items and a budget;
        purchasing approves cash to the requester or assigns a buyer. The buyer uploads receipts
        and actual purchases, then purchasing checks liquidation and closes the request. A PR
        does not create a supplier order or post stock. The phone's old <b>Receive PR</b> action
        handles supplier deliveries, not these internal spending requests.</p>
        <p>Use the <b>Match tolerance</b> button on Goods Receipts or Vendor Bills to review price percentage,
        flat-peso and quantity tolerances. Editing and saving require <i>orders.edit</i>; the price percentage defaults to 2%.</p>
        <p><b>Who can do what:</b> receiving needs <i>Adjust inventory</i>; raising and
        approving bills needs <i>Edit orders</i> — so the warehouse receives and
        accounting approves.</p>`,
    },
    {
      id: 'hr-employees', title: 'Employees (201 file)', group: 'HR',
      routes: ['hr-employees'], html: `
        <p>The staff master list. Each record holds the <b>201-file</b> data: employee
        number, department, position, pay rate (daily or monthly), employment status,
        start date, statutory numbers (SSS / PhilHealth / Pag-IBIG / TIN), a photo, and
        uploaded documents.</p>
        <ul>
          <li><b>New Employee</b> — the employee number is suggested; the gear button sets
              the numbering format.</li>
          <li><b>Linked account</b> — connect a login to a person so their data and
              account trace to each other.</li>
          <li><b>Import</b> — bulk-load or update from a spreadsheet (matched by employee
              number; never touches logins, photos, or payroll history).</li>
          <li><b>Generate ID</b> — prints an ID card from the template.</li>
          <li>You can't delete someone with attendance history — set them to
              resigned / terminated instead.</li>
        </ul>`,
    },
    {
      id: 'timekeeping', title: 'Time Keeping & payslips', group: 'HR',
      routes: ['hr-timekeeping'], html: `
        <p>Start at <b>HR → Time Keeping → New Cutoff</b>: enter its label and dates, create it,
        then open its row and add the employees to the roster. Attendance is organised into <b>cutoff periods</b>. For each period you record
        daily <b>time in / out</b> per employee (and which shift applied that day).</p>
        <ul>
          <li><b>Policy Settings</b> configures shifts and payroll rules; use <b>Save Rules</b> after changes.</li>
          <li>Lateness is measured against the shift start plus the grace minutes in your
              payroll policy.</li>
          <li>Link a day to an approved OT / Leave / Half-day form so it's treated
              correctly.</li>
          <li><b>Generate Payslips</b> creates records in the HR Payroll form for the
              period, which you then print.</li>
        </ul>
        <p><b>Statutory deductions:</b> in <b>Payroll Rules</b>, set your <b>pay frequency</b>
        and leave <b>“Auto-compute SSS / PhilHealth / Pag-IBIG / withholding tax”</b> on —
        Generate Payslips then fills those lines from the current government rate tables
        (the monthly contribution is split across your cutoffs). Turn it off to type them
        by hand. Cash advances and other manual deduction lines are kept when you regenerate.
        <b>Rest-day overtime is computed from attendance</b> and is recalculated on regeneration.
        Check the cutoff deduction schedule and each payslip's deduction switches before release.</p>`,
    },
    {
      id: 'bir-alphalist', title: 'BIR 1604-C Alphalist', group: 'Accounting', routes: [],
      html: `
        <p>The <b>Alphabetical List of Employees</b> that goes with the annual
        <b>1604-C</b> return (due Jan 31). Open it from <b>Accounting → Tax &amp; Compliance</b>.</p>
        <ul>
          <li>Pick the year. One row per employee, in the BIR's <b>Schedule 1</b> column
              order.</li>
          <li><b>Export CSV (BIR layout)</b> gives every column (gross, non-taxable
              breakdown, taxable breakdown, tax due, tax withheld, year-end adjustment,
              substituted-filing flag).</li>
        </ul>
        <p><b>Then:</b> complete the columns payroll can't fill (de-minimis, allowances,
        any previous-employer figures), open the BIR <b>Alphalist Data Entry &amp;
        Validation Module</b>, bring in this data (type it, or use an Excel→DAT converter
        that takes this layout), and clear <b>every</b> validation error before you submit
        the <code>.DAT</code>. Schedule 2 (minimum-wage earners) isn't generated — add it
        in the module if you have MWEs.</p>`,
    },
    {
      id: 'bir-1601c', title: 'BIR Form 1601-C (monthly)', group: 'Accounting', routes: [],
      html: `
        <p>The <b>Monthly Remittance Return of Income Taxes Withheld on Compensation</b> —
        what you file and remit every month. Open it from <b>Accounting → Tax &amp; Compliance</b>.</p>
        <ul>
          <li>Pick the year; the table shows all 12 months: employees paid, gross
              compensation, non-taxable, taxable, and <b>tax withheld</b> (the amount to
              remit for that month).</li>
          <li>The 12 monthly figures should reconcile to the annual <b>1604-C</b>.</li>
          <li><b>Export CSV</b> for your records or your accountant.</li>
        </ul>
        <p>Non-taxable here is the SSS / PhilHealth / Pag-IBIG employee shares only.
        <b>13th-month pay isn't a payslip line</b>, so if you pay it in December, add it to
        that month's return by hand. Deadline: the 10th of the following month (15th on
        eFPS).</p>`,
    },
    {
      id: 'bir-2316', title: 'BIR Form 2316 (year-end)', group: 'Accounting', routes: [],
      html: `
        <p>The <b>Certificate of Compensation Payment / Tax Withheld</b> each employee gets
        at year-end (and the employer files with the BIR). Open it from
        <b>Accounting → Tax &amp; Compliance</b>.</p>
        <ul>
          <li>Pick the year. The table shows each employee's gross compensation, taxable
              amount, tax due, tax withheld, and the over/under difference.</li>
          <li><b>Print</b> on a row renders that employee's certificate (from the editable
              "BIR 2316" template under Documents → Templates).</li>
          <li><b>Export CSV</b> gives the whole list.</li>
        </ul>
        <p><b>It's a worksheet.</b> The figures come from the payslips generated that year
        plus the annual tax table. Payroll doesn't track de-minimis benefits, allowances,
        or a previous employer's numbers — add those and check against the official BIR
        form before you issue or file. Deadlines: give to employees by <b>Jan 31</b>,
        file with the BIR by <b>Feb 28</b>.</p>`,
    },
    {
      id: 'gov-forms', title: 'Tax & Compliance (BIR + agency forms)', group: 'Accounting',
      routes: ['accounting'],
      html: `
        <p><b>Accounting → Tax &amp; Compliance</b> builds supported statutory worksheets from your
        payroll, sales and purchase records. All are <b>worksheets</b> — review and adjust
        before filing in eBIRForms / eFPS or each agency's portal (the app does not submit filings). Payroll <i>processing</i> (13th-month, final pay) stays under
        <b>HR → Time Keeping → Payroll Worksheets</b>.</p>
        <ul>
          <li><b>2550M</b> — monthly VAT worksheet from the sales and purchase journals, including
              exempt/zero-rated classifications and credit/debit notes. Review disallowed input VAT. Use the current BIR filing requirements; this is the monthly worksheet, not a filing submission.</li>
          <li><b>2550Q / SLSP</b> — quarterly VAT and summary sales/purchase lists; CSV and DAT exports where offered.</li>
          <li><b>Withholding register / 1601-EQ + QAP / 1604-E / 2307</b> — supplier withholding register,
              quarterly and annual worksheets, and printable supplier certificates.</li>
          <li><b>Tax codes</b> — classifications used on sales and bills.</li>
          <li><b>1702Q / 1702-RT</b> — corporate income tax worksheet; review the book income and adjustments.</li>
          <li><b>Books of Accounts / Financial Statements (AFS)</b> — printable ledger books and a draft statement pack.</li>
          <li><b>0619-E</b> — Monthly remittance of expanded / creditable withholding tax.
              Add one line per <b>ATC</b> (type of income payment: rent, professional
              fees, contractors, TWA purchases) with its base and rate; the payee detail
              goes on the quarterly 1601-EQ. Deadline: 10th of the following month.</li>
          <li><b>1601-C</b> — monthly withholding tax on compensation; the 12 months
              reconcile to the annual 1604-C.</li>
          <li><b>1604-C</b> — the annual return face: the 12-month schedule plus a
              <b>reconciliation</b> against the year-end tax due per the Alphalist. Clear
              any under-remittance before filing (deadline Jan 31).</li>
          <li><b>1604-C Alphalist</b> — Schedule 1, every employee paid in the year, in
              the BIR column layout; CSV → <code>.DAT</code> via BIR's validation module.</li>
          <li><b>BIR 2316</b> — the year-end certificate per employee; Print renders it
              from the editable "BIR 2316" template.</li>
          <li><b>Contribution schedule</b> — the monthly <b>SSS R-3</b> /
              <b>PhilHealth RF-1·EPRS</b> / <b>Pag-IBIG MCRF·eSRS</b> collection list.
              EE + ER (+ EC for SSS) recomputed from the rate tables on each person's
              month-total pay. Export the CSV and upload in the agency portal.</li>
          <li><b>Statutory deductions</b> (needs <i>Accounting: manage</i>) — turn
              <b>SSS / PhilHealth / Pag-IBIG / withholding tax</b> on or off <b>per
              employee</b>. An off switch zeroes that deduction on the employee's next
              generated payslip and drops them from that fund's schedule. HR's
              <i>Auto-compute statutory</i> policy is still the company-wide master
              switch; this is the per-person override.</li>
        </ul>
        <p>For journals and financial statements, open <b>Accounting → General Ledger → Books</b>.
        Use <b>Receivables &amp; Payables</b> to record customer and supplier settlements.</p>`,
    },
    {
      id: 'gl-books', title: 'Books (general ledger)', group: 'Accounting', routes: ['accounting-ledger'],
      html: `
        <p><b>Accounting → General Ledger → Books</b> is the double-entry ledger — the
        BIR "Books of Accounts" in one place.</p>
        <ul>
          <li><b>Set up books</b> (once, needs <i>Accounting: manage</i>) creates a
              standard Philippine SMB <b>chart of accounts</b> and your first fiscal
              year. Everything is editable after.</li>
          <li><b>Chart of Accounts</b> — the account tree. <b>Group</b> accounts are
              headers you can't post to; leaf accounts hold the balances. An account with
              entries can be renamed/archived but not deleted or re-typed.</li>
          <li><b>Journal</b> — record a manual transaction: pick accounts, put amounts in
              the <b>Debit</b> or <b>Credit</b> column; totals must match. Save as a
              <b>draft</b>, then <b>Post</b> it. A posted entry is never edited or
              deleted — <b>Reverse</b> it and a mirror entry is posted, leaving both in
              the ledger.</li>
          <li><b>Trial Balance / Profit &amp; Loss / Balance Sheet / General Ledger</b> —
              live reports from the posted entries.</li>
          <li><b>Periods</b> — closing a period locks posting into its dates.</li>
        </ul>
        <p><b>Posting Rules</b> selects the accounts for automatic sales and purchase entries.
        Confirmed sale orders and approved vendor bills post to the ledger; reopening or disputing
        them reverses their entries. Payroll posts only when you use <b>Post to GL</b> on the
        payroll records screen after reviewing the cutoff.</p>`,
    },
    {
      id: 'petty-cash', title: 'Petty Cash', group: 'Accounting', routes: ['accounting-petty-cash'],
      html: `
        <p><b>Accounting → Cash → Petty Cash</b> is a running record of the office cash
        box — every peso <b>in</b> and <b>out</b>.</p>
        <ul>
          <li><b>Funds</b> — make one fund per cash box (e.g. "Main Petty Cash", or one
              per branch). Set its <b>custodian</b> and <b>opening float</b>. Multiple
              funds are fine; the toolbar dropdown switches between them.</li>
          <li><b>Cash out</b> — a disbursement: date, amount, a category (Transport,
              Supplies, Meals…), who you paid, and the OR / voucher number.</li>
          <li><b>Cash in</b> — money added: usually a <b>Replenishment</b> (top-up), or a
              returned cash advance / refund.</li>
          <li>The table shows a <b>running balance</b> after every entry, and the panel up
              top shows opening balance, total in, total out, and closing balance for the
              date range you pick.</li>
          <li><b>Export</b> downloads the register as CSV for the cash count / liquidation.</li>
        </ul>
        <p>Recording entries needs the <i>Accounting: manage</i> permission; anyone with
        <i>Accounting: view</i> can read the register. A fund that already has entries
        can't be deleted — set it <b>inactive</b> instead.</p>`,
    },
    {
      id: 'payroll-rate-tables', title: 'Payroll rate tables (SSS/PhilHealth/etc.)', group: 'HR', routes: [],
      html: `
        <p>The government contribution and withholding-tax figures the payslip computation
        uses. Open them from <b>Time Keeping → Policy Settings → Statutory Rate Tables →
        Open rate tables</b> (needs HR manage).</p>
        <ul>
          <li>The <b>2026</b> seed tables are built in; verify their figures before using them for payroll.</li>
          <li>Each table is stored with an <b>effective date</b>; a payroll run uses the
              newest one on or before the pay date.</li>
          <li><b>Every January</b>, if SSS / PhilHealth issue a new circular or the BIR a
              new withholding table, paste the new figures and <b>Save as new version</b>
              with the circular's actual effective date. Saving the same table kind and date replaces
              that version; choose a new date to preserve earlier rules. Existing payslips change only if regenerated.</li>
          <li>Always cross-check the first run on a new schedule against the agency's own
              calculator before releasing payslips.</li>
        </ul>`,
    },
    {
      id: 'form-builder', title: 'Form Builder', group: 'Documents',
      routes: ['form-builder'], html: `<p><b>Form Builder</b> designs fields, access and optional automation.</p><ol><li>Choose the form section and add typed fields. Use <b>Sales invoice starter</b> for the Inventory invoice layout, dates, customer, product rows and payment terms.</li><li>Connect safe permissioned product/customer/employee/etc. sources. Configure editable or locked values and calculations. Review matching currency and source permissions.</li><li>For Inventory entry staff, configure <b>Access</b> role/account grants in addition to their account’s Enter Inventory forms permission.</li><li>In Automation map <b>Create a draft sales order on submission</b> only when wanted. Submission still needs sales and source permissions.</li><li>Save the versioned definition and review its linked print layout. Archived forms retain records/layouts but block new entries; existing records keep their original schema.</li></ol>`,
    },
    {
      id: 'templates', title: 'Document Templates', group: 'Documents',
      routes: ['templates'], html: `
        <p><b>Documents → Templates</b> controls printed orders, payslips, IDs and forms.
        Viewing needs <i>templates.view</i>; editing needs <i>templates.edit</i>.</p>
        <ol><li>Click <b>Create template</b> and choose a starting layout, or open a template to edit it.</li>
        <li>Use <b>Edit</b> to type and format. Advanced source editing is under <b>More → Edit HTML / CSS</b>.</li>
        <li>Use <b>Insert → Field</b> or the Fields sidebar for record fields and <code>{{company.*}}</code> details.
        Repeating item rows and formulas have their own sections in the editor’s <b>Guide</b>.</li>
        <li>Check <b>Print preview</b> for measured sheets and <b>Preview data</b> in the Print grid sidebar for sample values, then <b>Save</b>. Print a real record to check its actual values.</li></ol>
        <p><b>Company profile</b> updates shared company details (needs <i>templates.company</i>).
        The <b>Variables</b> button manages reusable custom values and formulas.</p>
      `,
    },
    {
      id: 'activity', title: 'Activity Log', group: 'Admin', routes: ['activity'],
      html: `
        <p>An append-only record of every change made in the system — who, what, when,
        from where. Filter by user, module, action, or date. Requires <i>audit.view</i>.</p>
        <p>Use it to answer "who changed this?" and as evidence for audits. Entries are
        kept for about a month, then trimmed automatically; "Prune…" clears them sooner.</p>`,
    },
    {
      id: 'admin', title: 'Accounts, roles & permissions', group: 'Admin',
      routes: ['admin'], html: `
        <p>Create user accounts, assign a <b>role</b> and department, reset passwords, and
        enable/disable people.</p>
        <ul>
          <li>A role comes with a default set of <b>permissions</b>. You can grant or
              revoke individual permissions per user in the permission editor.</li>
          <li><b>Departments</b> are managed here (and inline from HR).</li>
          <li>The <b>admin</b> role always has every permission.</li>
          <li>Set each person's <b>email</b> so they can use <b>“Forgot password?”</b> on
              the sign-in screen (needs the company mailbox configured in Email → Settings). Without an
              email, a staff member with <i>users.manage</i> must reset the password here.</li>
        </ul>`,
    },
    {
      id: 'ai-assistant', title: 'AI Assistant', group: 'Tools', routes: [],
      html: `
        <p>A chat panel (sparkle icon on the rail) that answers questions about your data,
        builds reports and Word documents, and does small tasks — in plain language.</p>
        <ul>
          <li>Ask like you'd ask a colleague, and <b>give a date range</b>:
              "attendance summary for the last cutoff", "items below reorder level as a table".</li>
          <li>It only sees and does what <b>your account</b> can. Depending on your permissions,
              it can create, update or delete inventory, orders, notes and tasks, and send messages or email.
              State the record and intended change clearly.</li>
          <li>If it made a file, a <b>download</b> button appears under the reply.</li>
          <li><b>Check anything that matters</b> against the real screen — it can be wrong.</li>
          <li>Admins: <b>AI settings</b> (button in the assistant panel) sets the API key,
              model, and endpoint — any OpenAI-compatible provider works.</li>
        </ul>`,
    },
    {
      id: 'mobile-app', title: 'Mobile Warehouse App', group: 'Tools', routes: [],
      html: `<p>Open the workspace’s <code>/m</code> phone app for role- and permission-filtered <b>Work</b> queues. Work refreshes effective access; a role name alone does not grant a task.</p><ul><li>Release orders and Kit releases are separate; the old Pick route no longer moves stock.</li><li>Stock moves/counts and eligible QC decisions may queue using cached data. Serialized photos, kit release, final warehouse-out and RTS receipts require their online confirmation flow. Read pending states rather than assume background completion.</li><li>Saved attempts/evidence for production, receipts, handoff, delivery and courier pickup survive supported recovery paths. After a lost response use the original saved attempt; site-local results remain pending until sync confirms.</li><li>Returns, Semi-finishing, unit Issues and photos, exact line/build-state allocation and per-slip Deliveries have their own workflows.</li><li>Use HTTPS for the camera; keep site data while any saved work or queue remains unresolved.</li></ul>`,
    },
    {
      id: 'email', title: 'Sending email', group: 'Tools', routes: [],
      html: `
        <p>The <b>Email</b> tool (mail icon on the rail) sends a plain message through your
        company's mailbox and logs it.</p>
        <ul>
          <li>Needs the <b>Send email</b> permission, and an admin must have connected the
              mailbox first (otherwise: "Email is not configured").</li>
          <li>One recipient per message here. The AI Assistant can email a report it made.</li>
          <li>Replies go to the company mailbox / reply-to address, not your personal inbox.</li>
        </ul>`,
    },
    {
      id: 'messages', title: 'Internal messages', group: 'Tools', routes: ['messages'],
      html: `
        <p><b>Messages → Messages</b> is a conversation list with threaded chat, not an inbox/sent form.</p>
        <ol><li>Click <b>New</b>, choose a colleague, or select an existing conversation.</li>
        <li>Type your message and send it. Use the attachment button to add files.</li>
        <li>Use a message's actions to reply, react, or edit/remove your own message.</li>
        <li>Use <b>Load earlier messages</b> to see older history. Opening a conversation marks incoming messages read.</li></ol>
        <p>Reading needs <i>messages.view</i>; sending needs <i>messages.send</i>.
        Your attachment storage usage is shown in <b>My Account</b>.</p>
      `,
    },
    {
      id: 'account', title: 'My Account', group: 'Basics', routes: ['account'],
      html: `<p>Open <b>My Account</b> for profile and login credentials.</p><ol><li>Edit the display name and Save profile.</li><li>Change username using the current password; the new name must be unique and use the supported characters. Renaming retains your account/Company ID and calling session, while other sessions are revoked.</li><li>Change password using the current password and matching confirmation. Follow the current on-screen password requirements.</li></ol><p>Company ID and workspace identity are separate from your username. Administrators manage role and department.</p>`,
    },
  ];

  // Task checkpoints shared by the drawer and Guide Center.
  TOPICS.push(
    {id:'release-orders',title:'Release Sale Orders',group:'Orders',routes:['releasing'],html:'<p>Release Queue accepts approved sales and allocates exact serials, batches or bulk quantities to their sale lines/build states. Release Slips chooses each vehicle’s actual load, authority, package evidence and required goods photo. Only that slip load leaves stock. Later trips remain on the same SO. Book own delivery or courier pickup per slip. Record returned goods against the original slip; receiving a return does not restock or refund it.</p>'},
    {id:'contact-verification',title:'Contact Verification',group:'HR',routes:['hr-contact-verification'],html:'<p>Review employee contact verification status. Open the relevant employee and follow the available verification actions. Check the employee record before correcting contact details.</p>'},
    {id:'company-assets',title:'Company Assets',group:'HR',routes:['hr-assets'],html:'<p>Review company assets and their employee assignments. Use the available actions to record changes and check the saved assignment before handing over an asset.</p>'},
    {id:'hr-approvals',title:'HR Approvals',group:'HR',routes:['hr-approvals'],html:'<p>Open a pending request and review its dates, details and attachments before approving or rejecting it. Follow the available actions for your role; a request must complete its approval process before it is treated as approved.</p>'},
    {id:'sync',title:'Sync',group:'Admin',routes:['sync'],html:'<p>Review synchronization status and connection details. Check reported errors before retrying. Synchronization configuration affects this installation; ask the administrator responsible for its connected systems before changing it.</p>'},
    {id:'hr-requests',title:'My HR requests',group:'HR',routes:['hr-requests'],html:'<p>Review your HR requests and their approval status. Open the request you need to inspect, or create a request using an available form. Access depends on your linked employee account and the forms enabled for your workspace.</p>'},
    {id:'confidential-reports',title:'Confidential reports',group:'HR',routes:['confidential-reports'],html:'<p>Use the available filters to find a confidential report and open its details. This screen requires confidential-report access; ask an administrator if you cannot open it.</p>'},
    {id:'identified-reports',title:'Identified reports',group:'HR',routes:['identified-reports'],html:'<p>Open a case sent or assigned to you to review its number, incident details, evidence and history. The selected recipient or assigned handler can update status, assign another active staff member and reply; the employee sees these updates in My identified reports. Access is limited to the reporter, recipient and assigned handler.</p>'},
    {id:'stock-discrepancies',title:'Stock review',group:'Inventory',routes:['stock-discrepancies'],html:'<p>Review offline stock discrepancies and possible duplicate deductions from older direct sales. Count the physical stock and check movement evidence before a normal stock adjustment. Marking a case reviewed never changes stock.</p>'},
    {id:'stock-counts',title:'Physical counts',group:'Inventory',routes:['stock-counts'],html:'<p>Planned checks assign an item, exact location and build state to a worker with a due date. Coverage shows active stock positions without a plan or reconciled count. The assigned worker records untracked quantity, physically present serials and each batch count. A different authorized person approves it; only correction or verification completes the task. Rejected counts can be repeated, and repeating plans create the next check after completion. Resolve serialized differences through exact-unit workflows.</p>'},
    {id:'support',title:'Contact OTOM',group:'Tools',routes:['support'],html:'<p>Use Contact OTOM to review support requests and contact the service team. Include the affected screen, what you expected and what happened. Review the request before submitting.</p>'},
    {id:'billing',title:'Workspace billing',group:'Admin',routes:['billing'],html:'<p>Review the invoices and payment instructions for this workspace. Report a payment with the requested reference and supporting receipt. A reported payment must be verified before it is treated as settled. Self-hosted installations may have no workspace billing.</p>'}
  );
  {const p = window.GUIDE && GUIDE.byId["split-trips"]; if(p) TOPICS.push({id:"sales-trips",title:"Trip releases and courier pickup",group:"Orders",routes:[],workflow:"split-trips",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  {const p = window.GUIDE && GUIDE.byId["customer-return"]; if(p) TOPICS.push({id:"customer-returns",title:"Customer returns and credit",group:"Inventory",routes:[],workflow:"customer-return",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  {const p = window.GUIDE && GUIDE.byId["ckd-sale"]; if(p) TOPICS.push({id:"ckd-shipping",title:"CKD whole-kit sales",group:"Orders",routes:[],workflow:"ckd-sale",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  {const p = window.GUIDE && GUIDE.byId["semi-finishing"]; if(p) TOPICS.push({id:"semi-finishing",title:"Finish a semi-built RTS unit",group:"Manufacturing",routes:[],workflow:"semi-finishing",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  {const p = window.GUIDE && GUIDE.byId["connected-invoice"]; if(p) TOPICS.push({id:"connected-invoice",title:"Connected invoice and sales submission",group:"Documents",routes:[],workflow:"connected-invoice",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  {const p = window.GUIDE && GUIDE.byId["payroll-correction"]; if(p) TOPICS.push({id:"payroll-corrections",title:"Payroll correction history",group:"HR",routes:[],workflow:"payroll-correction",html:`<p>${p.intro}</p><ol>${p.steps.map(s=>`<li><b>${s.title}</b> — ${s.body}<p><i>Result:</i> ${s.result}</p></li>`).join('')}</ol>`});}
  const CHECKPOINTS = {
    'barcode-labels': ['Select the items and confirm the printer label size.', 'Review the print sheet, then print one test label before the full batch.', 'If labels are clipped, match paper size and scale in the print dialog.'],
    'products-in': ['Confirm QC/QA is complete, or that the order requires no inspection.', 'Posted output appears in Receipt History and stock at the selected location.', 'If output is missing, check inspection status and whether it was already received.'],
    'cutoff': ['Check the date range and identify the employees to include.', 'The saved cutoff appears in Time Keeping; its roster must be added separately.', 'An empty attendance grid can mean the cutoff has no employees yet.'],
    'payments': ['Set up Books and the cash/bank account; check the outstanding documents.', 'The saved payment appears in Payments; review allocations and remaining balances.', 'If an invoice is still open, check whether the payment was recorded on account.'],
    'site-map': ['Use an account with access to the screen you want to open.', 'Selecting a screen closes the map and opens the matching view.', 'If a screen is missing, ask an administrator to check role and workspace access.'],
    'mobile-app': ['Use HTTPS for scanning and sign in with access to the intended action.', 'A queued action becomes final only after Pending sync confirms server acceptance.', 'Check Pending sync for errors; keep site data until pending actions have synced.'],
  };
  TOPICS.forEach(t => {
    const c = CHECKPOINTS[t.id];
    if (c) t.html += `<div class="guide-checkpoints"><p><b>Before you start:</b> ${c[0]}</p><p><b>Check the result:</b> ${c[1]}</p><p><b>If it does not work:</b> ${c[2]}</p></div>`;
  });

  function feedbackHTML() {
    return `<div class="guide-feedback"><p>Was this guide helpful?</p><button type="button" class="btn secondary small" data-guide-feedback="yes">Yes</button> <button type="button" class="btn secondary small" data-guide-feedback="no">Needs improvement</button></div>`;
  }

  function wireFeedback(el, topic) {
    el.querySelectorAll('[data-guide-feedback]').forEach(button => {
      button.onclick = () => {
        const helpful = button.dataset.guideFeedback === 'yes';
        const loc = (window.App && App.currentLocation && App.currentLocation()) || {};
        // Capture the source screen now, before any later navigation or topic change.
        const context = `${loc.label || loc.route || 'Guide'} | Guide: ${topic.id}`.slice(0, 200);
        UI.modal({ title: 'Guide feedback', confirmText: 'Send feedback',
          onOpen: ov => ov.classList.add('guide-feedback-modal'),
          bodyHTML: `<p><b>${UI.esc(topic.title)}</b> — ${helpful ? 'Helpful' : 'Needs improvement'}</p><label for="guide-feedback-note">${helpful ? 'What helped? (optional)' : 'What should we improve?'}</label><textarea id="guide-feedback-note" maxlength="3500" placeholder="Describe the unclear step, missing detail, or incorrect instruction."></textarea><p class="muted">Your feedback will be saved for administrators to review in View reports.</p>`,
          onConfirm: async ov => {
            const note = ov.querySelector('#guide-feedback-note').value.trim();
            if (!helpful && !note) throw new Error('Please describe what needs improvement.');
            const fd = new FormData();
            fd.append('title', `Guide feedback: ${topic.title}`.slice(0, 200));
            fd.append('steps_to_reproduce', `Read guide: ${topic.title} (${topic.id}).\nRating: ${helpful ? 'Helpful' : 'Needs improvement'}.`);
            fd.append('description', note || 'This guide was helpful.');
            fd.append('page_context', context);
            await API.upload('/bug-reports', fd);
            UI.toast('Guide feedback sent — thank you!');
          },
        });
      };
    });
  }

  const byId = Object.fromEntries(TOPICS.map((t) => [t.id, t]));
  const routeIndex = {};
  TOPICS.forEach((t) => (t.routes || []).forEach((r) => (routeIndex[r] = t.id)));

  function pickerHtml(activeId) {
    const groups = [];
    TOPICS.forEach((t) => {
      let g = groups.find((x) => x.name === t.group);
      if (!g) groups.push((g = { name: t.group, items: [] }));
      g.items.push(t);
    });
    return `<select id="help-pick" class="help-pick" style="width:100%;margin-bottom:10px">
      ${groups.map((g) => `<optgroup label="${UI.esc(g.name)}">
        ${g.items.map((t) => `<option value="${t.id}" ${t.id === activeId ? 'selected' : ''}>${UI.esc(t.title)}</option>`).join('')}
      </optgroup>`).join('')}
    </select>`;
  }

  /** Resolve from the selected topic, never an unrelated background screen. */
  function pipelineFor(t) {
    if (!window.GUIDE) return null;
    if (t.workflow) return GUIDE.byId[t.workflow] || null;
    if (['payroll-records', 'hr-forms', 'payroll-rate-tables'].includes(t.id)) return GUIDE.byId.payroll;
    if (['bir-alphalist', 'bir-1601c', 'bir-2316'].includes(t.id)) return GUIDE.byId.accounting;
    for (const r of (t.routes || [])) {
      const g = GUIDE.forRoute(r);
      if (g) return g;
    }
    return null;
  }

  function renderBody(el, topicId, close) {
    const t = byId[topicId] || byId['getting-started'];
    const pipe = pipelineFor(t);
    el.querySelector('.drawer-body').innerHTML = `
      <div class="help-jump">
        <button type="button" class="btn secondary small" id="help-open-guide">${UI.icon('forms', 14)} Open the full Guide</button>
        ${pipe ? `<button type="button" class="btn small" id="help-walk">${UI.icon('sparkles', 14)} Walk through ${UI.esc(pipe.title)}</button>` : ''}
      </div>
      ${pickerHtml(t.id)}
      <div class="help-content">
        <h4 style="margin:0 0 8px">${UI.esc(t.title)}</h4>
        ${t.html}
        ${pipe ? `<p style="margin-top:10px"><a href="#" id="help-sop">Full workflow — ${UI.esc(pipe.title)}, end to end &rarr;</a></p>` : ''}
      </div>
      ${feedbackHTML()}
      <p class="muted" style="margin-top:14px;border-top:1px solid var(--border);padding-top:8px">
        Trainers: full written guides are in <code>docs/guides/</code>.
      </p>`;

    wireFeedback(el, t);
    const pick = el.querySelector('#help-pick');
    if (pick) pick.addEventListener('change', () => renderBody(el, pick.value, close));

    const gotoGuide = () => {
      try { window.App && App.navigate('sop', { helpTopic: t.id }); } catch (_) {}
      if (close) close();
    };
    const openGuide = el.querySelector('#help-open-guide');
    if (openGuide) openGuide.addEventListener('click', gotoGuide);
    const sopLink = el.querySelector('#help-sop');
    if (sopLink) sopLink.addEventListener('click', (e) => { e.preventDefault(); gotoGuide(); });

    const walk = el.querySelector('#help-walk');
    if (walk) walk.addEventListener('click', () => {
      if (close) close();
      try { window.GuideTour && pipe && GuideTour.start(pipe.id, Math.max(0, pipe.steps.findIndex((step) => step.to && (t.routes || []).includes(step.to.route)))); } catch (_) {}
    });
  }

  const formTopics = {};
  function rememberForm(form) {
    formTopics[form.id] = form.slug === 'hr_payroll' ? 'payroll-records'
      : form.scope === 'hr' ? 'hr-forms' : 'data-forms';
  }

  function forLocation(route, filter) {
    if (route === 'admin' && filter && filter.tab === 'departments') return byId.departments;
    if (route === 'inventory' && filter && filter.low === '1') return byId['low-stock'];
    if (route === 'production-qc' && filter && filter.tab === 'findings') return byId['qc-findings'];
    if (route === 'accounting-receivables' && filter && filter.tab === 'payments') return byId.payments;
    if (route === 'accounting-receivables' && filter && filter.tab === 'credit notes') return byId['credit-notes'];
    if (route === 'orders' && filter && filter.type === 'purchase') return byId['purchase-orders'];
    if (route === 'orders' && filter && filter.type === 'job') return byId['job-documents'];
    if (route === 'form-records' && filter && formTopics[filter.form_id]) return byId[formTopics[filter.form_id]];
    if (route === 'form-records' && filter && filter.slug === 'hr_payroll') return byId['payroll-records'];
    if (route === 'form-records' && filter && filter.scope === 'hr') return byId['hr-forms'];
    return byId[routeIndex[route] || 'getting-started'];
  }

  function open(topicId) {
    let loc = {};
    try { loc = (window.App && App.currentLocation && App.currentLocation()) || {}; } catch (_) {}
    const id = topicId || forLocation(loc.route, loc.filter).id;
    // An explicit topic link switches an open Help drawer instead of toggling it shut.
    const existing = topicId && document.querySelector('.drawer.open #help-pick');
    if (existing) {
      const el = existing.closest('.drawer');
      renderBody(el, id, () => el.querySelector('.drawer-close').click());
      return;
    }
    const d = UI.drawer({ title: 'Help', icon: 'help', key: 'help', bodyHTML: '' });
    if (d) { d.el.classList.add('help-drawer'); renderBody(d.el, id, d.close); }
  }

  window.Help = { open, topics: TOPICS, forLocation, rememberForm, feedbackHTML, wireFeedback };
})();
