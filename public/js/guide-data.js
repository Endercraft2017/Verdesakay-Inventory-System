/* ============================================================================
   Guide content — the SINGLE SOURCE OF TRUTH for the in-app "How it works"
   playbooks. Consumed by:
     - public/js/views/sop.js   (the full Guide page, route "sop")
     - public/js/guide-tour.js  (the step-by-step walkthrough overlay)
     - public/js/help.js        (per-screen Help drawer → "open the guide")

   Shape:
     PIPELINE { id, title, icon, tagline, audience, intro(html), steps[], gotchas[](html) }
       step  { title, role, body(html), tip?(html),
               to?  : { route, filter?, label }   — an in-app screen (renders as a link,
                                                     and the walkthrough can jump there)
                    | { external, label }         — a screen outside the desktop app
                                                     (the phone app, a sub-tab, a dialog)
               spot? : CSS selector highlighted by the walkthrough once `to` is open }

   Every `to.route` must be a registered route (validated by tests/frontend-guide.test.ts).
   Keep the prose short — this is the "where do I click" map, the fuller manuals live
   in docs/guides/.
   ============================================================================ */

const GUIDE_PIPELINES = [
  /* ------------------------------------------------------------------ Production */
  {
    id: 'production',
    title: 'Production',
    icon: 'printer',
    tagline: 'Bill of materials → job order → QC/QA → Products In → warehouse-ready stock',
    audience: 'Production planners, shop floor, QC/QA, warehouse',
    intro: `How a product goes from a parts list to finished, labelled, traceable stock —
      in the order it actually happens, screen by screen. Each step names the screen it
      lives on and the permission it needs.`,
    steps: [
      {
        title: 'Check the Overview',
        role: 'read: inventory.view',
        to: { route: 'production-overview', label: 'Production → Overview' },
        spot: '.tree-leaf[data-route="production-overview"]',
        body: `Open Production Overview and review overdue jobs, inspection queues, rework and output waiting for receipt. Select a linked row to open the screen where that work is handled.`,
      },
      {
        title: 'Define the finished product & BOM',
        role: 'Inventory · inventory.edit',
        to: { route: 'finished-products', label: 'Production → Product Setup' },
        spot: '.tree-leaf[data-route="finished-products"]',
        body: `Open Product Setup and create or edit the finished product. Add each component and the quantity needed for one unit to its bill of materials (BOM). Review optional labor and overhead costs before saving. Components that have their own BOM are expanded as sub-assemblies.`,
        tip: `A product can be saved with <b>no BOM</b> — it still builds, it just reserves and
          consumes nothing until you add components.`,
      },
      {
        title: 'Attach a QC/QA checklist (optional)',
        role: 'QA · qc.configure',
        to: { route: 'production-qc', label: 'Production → QC / QA → Manage Checklists' },
        body: `Open Manage Checklists on the QC/QA page. Name the checklist, add its checks and choose whether each applies to every inspection, QC or QA. Attach it in the product’s BOM editor. Required checks must be completed before an inspection can pass.`,
      },
      {
        title: 'Schedule / start the job order',
        role: 'Production · inventory.adjust',
        to: { route: 'job-orders', label: 'Production → Job Orders' },
        spot: '.tree-leaf[data-route="job-orders"]',
        body: `Press New job order. Choose the product, quantity, team, work centre and planned dates. Set inspection stages: 0 goes straight to Products In, 1 uses QC/QA, and 2 uses QC then QA. Choose the parts source and default output location, then save the draft. Use Scheduling to review workload across jobs.`,
      },
      {
        title: 'Release (parts out)',
        role: 'Production / warehouse · inventory.adjust',
        to: { route: 'job-orders', label: 'Job order → Release' },
        body: `Open the draft job order and review its planned components and source location. Choose Release when the kit is ready. This deducts the components from that location; a shortfall prevents release. When the ledger is enabled, material value moves into Work in Process.`,
      },
      {
        title: 'Accept the parts kit',
        role: 'Production lead · production.record',
        to: { route: 'job-orders', label: 'Job order → Accept parts kit' },
        body: `Count the handed-over kit against the job order’s Components list. Confirm the count, add a handover note if needed, and press Accept job order. If parts are missing or damaged, use Report a problem instead. Output cannot be recorded until acceptance.`,
      },
      {
        title: 'Build (record production progress)',
        role: 'Shop floor · inventory.adjust',
        to: { route: 'job-orders', label: 'Job order → Record production' },
        body: `Open the accepted job order. Enter the quantities finished and scrapped, add a batch label, and apply the progress. Finished output goes to inspection if configured, otherwise to Products In. Recording output alone does not add stock.`,
      },
      {
        title: 'Inspect (QC/QA)',
        role: 'QC/QA inspector · inventory.adjust',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        spot: '.tree-leaf[data-route="production-qc"]',
        body: `Open a unit or batch in QC/QA and complete the checklist. Choose Pass when its checks are satisfied. For Fail, choose a disposition and attach evidence for every failed unit. Repair sends output to rework; a final pass queues it for Products In. QA may hold a unit for review.`,
      },
      {
        title: 'Decide a QA hold (branch)',
        role: 'Any QA inspector · production.qa_review (Production Manager by default)',
        to: { route: 'job-orders', label: 'Job order → Held by QA for review → Decide…' },
        body: `Open the job order’s Held by QA for review section and choose Decide. Review the evidence, enter a reason and select pass, rectify or fail. Pass sends output to Products In; rectify returns it to rework. The hold prevents job completion until decided.`,
      },
      {
        title: 'Findings & reports',
        role: 'read: inventory.view',
        to: { route: 'production-qc', filter: { tab: 'findings' }, label: 'Production → QC / QA → Findings & Reports' },
        body: `Open Findings & Reports and filter by result, date, job order or product. Open a finding to inspect its checklist, remarks, disposition and inspector. Export CSV when you need the filtered findings outside the app.`,
      },
      {
        title: 'Repair / rework (branch)',
        role: 'Production raises · Warehouse accepts · inventory.adjust',
        to: { route: 'repairs', label: 'Production → Repairs & Parts Requests' },
        body: `Open the unit’s repair panel and request a part to add or replace. Enter the part, quantity and fault reason. The request holds available stock; the parts clerk must issue the exact approved part and quantity. Resolve every request before re-inspection. Replacement parts and revised quantities need requester approval.`,
      },
      {
        title: 'Products In',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'production-receiving', label: 'Production → Products In' },
        spot: '.tree-leaf[data-route="production-receiving"]',
        body: `Open Ready to Receive. Select the units physically received, or enter the actual batch quantity. Choose the storage destination and post the receipt. This adds output to stock; short batch counts are allowed. Review Receipt History afterward. Locations with insufficient capacity cannot receive the output.`,
        tip: `A unit only becomes sellable/reservable once it's been received here — a QC pass
          alone isn't enough.`,
      },
      {
        title: 'Batches / lots & the production record',
        role: 'read: inventory.view',
        to: { route: 'production-batches', label: 'Production → Batches / Lots' },
        body: `Open a batch in Batches / Lots to review its identifier, status and inspection history. Use Full record or scan its QR to inspect the build, sign-offs, repairs and stock movements. A batch inspection records quality information; it does not receive stock.`,
      },
      {
        title: 'Labels & QR',
        role: 'Production · inventory.adjust',
        to: { route: 'finished-products', label: 'Product Setup → Print QR labels' },
        body: `Open Print QR labels for the product’s units or batch. Review the identifiers and copies before printing. Use Label design to change the layout. Scanning these labels opens the matching production record.`,
      },
      {
        title: 'Completion & returns',
        role: 'automatic',
        body: `Review the job order’s built and scrapped totals and outstanding inspections or repairs. It completes automatically when all ordered output is accounted for and nothing remains pending or in rework. Unused components return to the source location. Output still needs Products In receipt even after completion, early closure or cancellation.`,
      },
      {
        title: 'Sell / move finished goods',
        role: 'Sales / warehouse · inventory.adjust',
        to: { route: 'finished-goods', label: 'Production → Finished Goods' },
        body: `Open Finished Goods and find the received units to sell or move. Choose the relevant action and review its order or destination. Only output already received into stock is available here.`,
      },
    ],
    gotchas: [
      `A job order can't auto-complete while a unit is in <b>rework</b>.`,
      `A QC pass (or, with no QC stages, recording progress) doesn't post stock on its own —
       <b>Products In</b> does. Don't confuse "built" with "on hand".`,
      `Repair-issued parts are a direct stock movement — they don't roll into the job order's
       standard per-unit cost.`,
      `Deleting a <b>production team</b> is blocked while a job order points at it — deactivate it.`,
      `The schedule's per-day capacity is <b>advisory</b> only.`,
    ],
  },

  /* --------------------------------------------------------------------- Sales */
  {
    id: 'sales',
    title: 'Sales orders',
    icon: 'forms',
    tagline: 'Order → approve (stock check) → warehouse accepts → release → release slip → deliver',
    audience: 'CSR / sales, warehouse releaser, delivery, accounting',
    intro: `How a customer order moves from raw document to goods out the door. Status runs
      <b>open → approved → released → confirmed / completed</b>; the release slip is what
      confirms it.`,
    steps: [
      {
        title: 'Raise the sale order',
        role: 'CSR / sales · orders.create',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Inventory → Orders → Sale Orders' },
        spot: '.tree-leaf[data-route="orders"]',
        body: `Press New sale order, select the customer and add inventory items, quantities and prices. Choose Ship from and review tax before saving. The new order is open and its lines remain editable until approval.`,
      },
      {
        title: 'Approve — with a stock check',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → Status → Approve' },
        body: `Open the sale order and choose the approval status. Review the stock check, which deducts quantities reserved elsewhere from availability. Approval locks the lines and allows warehouse release. Use Backorders to find approved orders still short of stock.`,
      },
      {
        title: 'Authorize the release',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → key icon' },
        body: `Open the sale order’s key action. Set pickup or delivery, recipient, ID reference, validity, handoff area and whether partial release is allowed. Issue the authorization and give its token to the recipient. Only the last four ID-reference characters are stored. Review warehouse release reports here.`,
      },
      {
        title: 'Cover a shortfall (if the check fails)',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → shortfall prompt' },
        body: `Read the shortfall quantities, then choose the appropriate response: Trim order to available, Create job orders for the shortfall, Draft purchase orders for the shortfall, or Approve as a backorder. Review any generated draft orders before proceeding.`,
      },
      {
        title: 'Warehouse accepts the order',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'queue' }, label: 'Inventory → Releasing → Release Queue' },
        spot: '.tree-leaf[data-route="releasing"]',
        body: `Open Release Queue and find the approved order under Waiting for warehouse acceptance. Review it and press Accept for release. This records your acceptance; picking is unavailable until the order is accepted.`,
      },
      {
        title: 'Release the goods',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'queue' }, label: 'Release Queue → open the order' },
        body: `Open the accepted order. Scan each serialized unit’s printed QR; enter quantities for non-serialized lines. Review the scan results until the lines are covered. Units are reserved for the order at this stage; stock leaves only when the release slip is issued.`,
      },
      {
        title: 'Issue the release slip',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'slips' }, label: 'Release order → Issue release slip' },
        body: `When handing over goods, choose Issue release slip. Enter the recipient’s token, confirm required package items, record collector and vehicle, and attach the required photo. Review any partial-release or supervisor-override details before confirming. Issuing the slip records stock-out and retains the serials for signatures and audit.`,
      },
      {
        title: 'Deliver',
        role: 'Driver · delivery.run',
        to: { external: 'Phone → Work → Deliveries' },
        body: `On the phone, open Work → Deliveries and start the delivery linked to the order. Capture recipient details, signature, photos and location, then mark it delivered. Review any offered order-completion action before confirming it.`,
      },
      {
        title: 'Complete / invoice',
        role: 'Accounting / CSR · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → Status → Completed' },
        body: `After delivery, open the sale order and mark it completed if it still needs completion. Prepare its invoice. Review carefully before reopening or cancelling an order with an issued slip: those actions reverse stock-out and retain the slip history.`,
      },
    ],
    gotchas: [
      `A releaser can't scan against an <b>open</b> order (approve it first) or one the warehouse
       hasn't accepted yet.`,
      `<b>Scanning is records only</b> — stock moves when the release slip is issued, even with the
       general ledger off.`,
      `"Allocate finished units" on the desktop order screen <b>sells</b> units immediately
       (over-the-counter), skipping the reserve step.`,
    ],
  },

  /* ---------------------------------------------------------------- Purchasing */
  {
    id: 'purchasing',
    title: 'Purchasing',
    icon: 'inbox',
    tagline: 'Purchase order → goods receipt → vendor bill (3-way match)',
    audience: 'Purchasing, warehouse, accounting',
    intro: `A purchase order becomes a controlled <b>PO → Goods Receipt → Vendor Bill</b> flow, with
      a 3-way match before any bill is approved for payment.`,
    steps: [
      {
        title: 'Raise the purchase order',
        role: 'Purchasing · orders.create',
        to: { route: 'orders', filter: { type: 'purchase' }, label: 'Inventory → Orders → Purchase Orders' },
        spot: '.tree-leaf[data-route="orders"]',
        body: `Press New purchase order. Select the supplier, expected delivery date and purchased items, then enter quantities and prices. Review the lines before saving the open order.`,
      },
      {
        title: 'Let the system draft POs for you (optional)',
        role: 'Purchasing · inventory.adjust',
        to: { route: 'inventory', filter: { low: '1' }, label: 'Inventory → Low Stock → Reorder PO' },
        body: `Open Low Stock and choose Reorder PO, or use Draft purchase orders for the shortfall on an order. Open the resulting purchase orders and check suppliers, quantities and prices. Generated orders are open drafts that need review.`,
      },
      {
        title: 'Receive what arrived',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'purchasing', filter: { tab: 'receipts' }, label: 'Inventory → Purchasing → Goods Receipts' },
        spot: '.tree-leaf[data-route="purchasing"]',
        body: `Open the purchase order’s Receiving & bills section and press Record receipt. Enter the quantity actually delivered for each line and the destination location. Posting the goods receipt adds that stock. Record later deliveries as additional receipts; the phone’s quick Receive PR uses a separate receipt flow.`,
      },
      {
        title: 'Vendor bill & the 3-way match',
        role: 'Accounting · orders.edit',
        to: { route: 'purchasing', filter: { tab: 'bills' }, label: 'Inventory → Purchasing → Vendor Bills' },
        body: `Record the supplier’s invoice against the purchase order and review its match with receipts. Billed quantities must be covered by receipts and prices within tolerance. Correct missing receipts or bill differences before approval. If an authorized override is needed, read the exception and confirmation; the override is recorded.`,
      },
    ],
    gotchas: [
      `Receiving needs <i>inventory.adjust</i>; billing / approval needs <i>orders.edit</i> — the
       warehouse receives, accounting approves.`,
      `The mobile "Receive PR" shortcut bypasses the desktop GRN / 3-way-match flow — use it only
       for quick unmatched receipts.`,
      `Match tolerance (default 2% on price) is a workspace setting.`,
    ],
  },

  /* ------------------------------------------------------- Payroll & timekeeping */
  {
    id: 'payroll',
    title: 'Payroll & Time Keeping',
    icon: 'users',
    tagline: 'Policy → cutoff → attendance → payslips → statutory → government forms',
    audience: 'HR, timekeepers, accounting',
    intro: `Attendance is organised into <b>cutoff periods</b>; each period turns into a batch of
      payslips and the figures for the statutory returns.`,
    steps: [
      {
        title: 'Set the payroll policy & rate tables',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping → Policy Settings' },
        spot: '.tree-leaf[data-route="hr-timekeeping"]',
        body: `Open Calendar & tools → Policy Settings. Review pay frequency, grace time, overtime, night differential and half-day rules, then Save Rules. Review automatic statutory deduction settings and the applicable rate-table version before generating payroll.`,
        tip: `When official rates change, verify their effective date and <b>Save as a new version</b>. Preserve older versions for payroll covering earlier dates.`,
      },
      {
        title: 'Keep the employee 201 files current',
        role: 'HR · hr.manage',
        to: { route: 'hr-employees', label: 'HR → Employees' },
        spot: '.tree-leaf[data-route="hr-employees"]',
        body: `Open Employees and edit the employee’s record. Review Basic Info, Pay & Schedule, Payroll Rules and Leave & Records. Check daily or monthly rate, status, shift, rest days and statutory identifiers before saving. Statutory deduction switches are also available in Tax & Compliance.`,
      },
      {
        title: 'Open the cutoff period',
        role: 'HR · hr.view',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping' },
        body: `Open the cutoff covering the payroll dates you are processing, or press New Cutoff to create it. Check its inclusive dates and roster before entering attendance. Each employee’s daily records include the applied shift and times.`,
      },
      {
        title: 'Record attendance',
        role: 'HR / timekeeper · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping (grid)' },
        body: `Open an employee in the cutoff and review each day’s shift, time in/out and lunch times. Punches fill roster records live; Import Punches backfills punches recorded before roster inclusion. Correct missing information and inspect the Whole, Half or Undertime classification before generating pay.`,
      },
      {
        title: "Check today's attendance at a glance",
        role: 'HR / timekeeper · hr.view',
        to: { route: 'hr-daily-report', label: 'HR → Time Keeping → Daily Report' },
        body: `Choose a date in Daily Report and review the department counts and employee list. Search an employee or filter an attendance status to investigate. The report reads kiosk and phone punches directly; check rest days, holidays and leave before interpreting a missing punch as absence.`,
      },
      {
        title: 'Link OT / leave / offset forms',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'Time Keeping → employee day → Link a form' },
        body: `Open the employee’s day in Time Keeping and choose Link a form. Inspect the existing form’s details before attaching it, or create a complete form with a reason and its date coverage. Multi-day leave links across its selected dates and consumes scheduled working days only.`,
      },
      {
        title: 'Generate payslips',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping → Generate Payslips' },
        body: `Review this cutoff’s roster, attendance and approved forms, then press Generate Payslips. Read Review notes: warnings remain visible but do not block generation. Confirm when ready and review the generated HR Payroll records. Check manual adjustments again after any regeneration.`,
      },
      {
        title: 'Review & print payslips',
        role: 'HR · hr.view',
        to: { route: 'form-records', filter: { slug: 'hr_payroll' }, label: 'HR → Payroll' },
        body: `Open Payroll and select the cutoff in Period. Open a payslip and compare earnings, deductions and net pay with attendance and approved forms. Preview individual slips or Print Summary before printing. Mark payment only after payment is made; paid payroll locks the cutoff’s attendance and roster.`,
      },
      {
        title: '13th-month & final pay',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping → Payroll Worksheets' },
        body: `Open Calendar & tools → Payroll Worksheets and choose the worksheet you need. Review the employee, period and computed inputs before processing 13th-month or final pay. Review the related tax worksheet separately before filing.`,
      },
      {
        title: 'File the government forms',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting', label: 'Accounting → Tax & Compliance' },
        body: `Open Tax & Compliance, select the return and period, and generate its worksheet. Review compensation tax and SSS, PhilHealth or Pag-IBIG totals against payroll. Export the supported file and submit through the relevant agency portal; generating a worksheet does not file a return.`,
      },
    ],
    gotchas: [
      `Turning a per-employee statutory switch off zeroes that deduction on the employee's
       <b>next generated</b> payslip and drops them from that fund's schedule — it doesn't touch
       payslips already made.`,
      `Always cross-check the first payroll run on a new rate-table version against the agency's
       own calculator before releasing payslips.`,
      `Half-day / undertime classification depends on the policy's half-day window — set it before
       reconciling the period.`,
    ],
  },

  /* ------------------------------------------------------------------ Inventory */
  {
    id: 'inventory',
    title: 'Inventory & stock',
    icon: 'inventory',
    tagline: 'Items → locations → stock in/out → transfer → reorder → labels',
    audience: 'Warehouse, purchasing, inventory clerks',
    intro: `The item list is your catalogue — each row is one product or material with a quantity
      on hand. Every change is kept in the item's history.`,
    steps: [
      {
        title: 'Add your items',
        role: 'Inventory · inventory.edit',
        to: { route: 'inventory', label: 'Inventory → All Items → New item' },
        spot: '.tree-leaf[data-route="inventory"]',
        body: `Press New item and enter a unique SKU, name, unit and reorder level. Add barcode and standard cost when needed, then save. For bulk setup, use Import and check the sample CSV; existing items are matched by SKU.`,
      },
      {
        title: 'Set up locations & suppliers',
        role: 'Inventory · inventory.edit',
        to: { route: 'locations', label: 'Inventory → Locations' },
        body: `Add each storage location and review its type, default setting and capacity. Add vendors under Suppliers, then select each item’s preferred supplier so replenishment orders can use it.`,
      },
      {
        title: 'Record stock in / out & corrections',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Stock in / out' },
        body: `Open the item’s stock action, select the location and movement type, then enter the actual quantity and reason. Review before saving. Check item history or Stock Movements to verify the recorded change.`,
      },
      {
        title: 'Transfer between locations',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Transfer' },
        body: `Open the item’s Transfer action. Select source and destination locations and enter the quantity to move. Review the source balance before confirming. The transfer changes location balances without changing total stock.`,
      },
      {
        title: 'Low stock & Reorder PO',
        role: 'Purchasing · inventory.adjust',
        to: { route: 'inventory', filter: { low: '1' }, label: 'Inventory → Low Stock' },
        body: `Enable Low stock to find items at or below reorder level. Review preferred suppliers, then choose Reorder PO. Check the resulting purchase-order drafts and quantities before using them. Finished products are excluded because they are produced.`,
      },
      {
        title: 'Print barcode labels',
        role: 'Inventory · inventory.view',
        to: { route: 'inventory', label: 'Inventory → Labels' },
        body: `Open Labels, select the items and choose size and copies. Open the print sheet and inspect it before printing. Each Code 128 label uses the item’s barcode, or its SKU if no barcode is set.`,
      },
      {
        title: 'Report damage',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Report damage' },
        body: `Open the item’s Report damage action. Enter the damaged quantity, location and explanation, then review before confirming. This removes it from sellable stock and creates a damage record for traceability.`,
      },
      {
        title: 'Audit the movements',
        role: 'read: inventory.view',
        to: { route: 'inventory-movements', label: 'Inventory → Stock Movements' },
        body: `Open Stock Movements and filter by item, direction, location and date range. Inspect the movements around the quantity change you are investigating, then export the filtered log if needed.`,
      },
    ],
    gotchas: [
      `Importing <b>never changes an existing item's stock</b> — on a new item, the
       <code>quantity</code> column is its opening stock.`,
      `<code>department</code> and <code>supplier</code> on an import are matched by name and must
       already exist.`,
      `Deleting a supplier or location doesn't delete its items — they just lose the link.`,
    ],
  },

  /* ----------------------------------------------------------------- Accounting */
  {
    id: 'accounting',
    title: 'Accounting & compliance',
    icon: 'sheet',
    tagline: 'Books → journals → tax worksheets → AR/AP → petty cash → reports',
    audience: 'Accounting, finance, management',
    intro: `Sale orders, vendor bills and payslips feed the ledger and the statutory returns. The
      tax screens are <b>worksheets</b> — review and adjust before filing.`,
    steps: [
      {
        title: 'What feeds Accounting',
        role: 'context',
        body: `Check the source transactions before reviewing accounting totals: sale orders feed sales and receivables, approved vendor bills feed payables, and payroll feeds compensation and statutory worksheets. Review posting status where a ledger posting is required.`,
      },
      {
        title: 'Set up the books (once)',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-ledger', label: 'Accounting → General Ledger → Books' },
        spot: '.tree-leaf[data-route="accounting-ledger"]',
        body: `Open General Ledger → Books. Review the fiscal year and currency, then choose Set up books. This creates the chart of accounts and first fiscal year. Use posting accounts for journal lines; group accounts are headings.`,
      },
      {
        title: 'Record & post journals',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-ledger', label: 'Accounting → General Ledger → Journal' },
        body: `Choose New entry, enter the date and accounts, and balance total debits and credits. Save a draft, review it, then Post. Posted entries cannot be edited or deleted; use Reverse for a correcting entry. Reports use posted entries.`,
      },
      {
        title: 'Tax & Compliance worksheets',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting', label: 'Accounting → Tax & Compliance' },
        spot: '.tree-leaf[data-route="accounting"]',
        body: `Select the tax or contribution worksheet and its period. Generate and compare it with source transactions, then export the supported CSV or DAT. Submit through the relevant portal after review; the app does not file the return for you.`,
      },
      {
        title: 'Receivables & payables',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting-receivables', label: 'Accounting → Receivables & Payables' },
        body: `Open the customer receivable or supplier payable and review outstanding invoices or bills. Use Record payment for an actual receipt or settlement. Review allocation, date and amount before saving; use credit or debit notes for adjustments.`,
      },
      {
        title: 'Petty cash',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-petty-cash', label: 'Accounting → Cash → Petty Cash' },
        body: `Choose the cash fund, or create one with a custodian and opening float. Record each replenishment with Cash in and each disbursement with Cash out. Review its running balance and export the register for a cash count.`,
      },
      {
        title: 'Read the dashboards',
        role: 'permission-gated',
        to: { route: 'analytics', label: 'Home → Reports' },
        body: `Open Reports and review the stock, production, aging, sales and payroll sections available to your role. Press Refresh after source records change. Investigate a total in its source module before changing records.`,
      },
    ],
    gotchas: [
      `Closing a ledger <b>period</b> locks posting into its dates.`,
      `PH agencies have no direct filing API — every tax screen produces a worksheet / export you
       submit yourself.`,
      `Review 13th-month and final-pay payouts separately when reconciling compensation tax worksheets.`,
    ],
  },

  /* ------------------------------------------------------ QC repair quick sheet */
  {
    id: 'qc-repair',
    title: 'QC repair / rework',
    icon: 'check',
    tagline: 'Quick reference — fail → disposition → parts → re-inspect',
    audience: 'QC/QA, production, warehouse',
    intro: `Use this sequence for failed inspections that need parts and rework.`,
    steps: [
      {
        title: 'Fail → disposition',
        role: 'Inspector',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        body: `Open the inspection and review the failed checks. Enter remarks, attach evidence for the failed unit and choose its disposition before Fail. Scrap, dispose and recycle are terminal; repair sends it to rework. QA can hold it for an authorized decision.`,
      },
      {
        title: 'Raise parts requests',
        role: 'Production',
        to: { route: 'job-orders', label: 'Job order → Repair panel' },
        body: `Open the unit’s Repair panel and choose add for a missing part or replace for a fitted part. Enter the part, quantity and fault reason. Available parts are held for the request; a replacement’s removed part is recorded as damaged.`,
      },
      {
        title: 'Parts clerk issues',
        role: 'Parts clerk · production.repairs',
        to: { route: 'repairs', label: 'Production → Repairs & Parts Requests' },
        body: `Open the parts request and review its approved item and quantity. Issue from an approved location and scan the exact requested part. Enter a reason if rejecting. Request a revision for a different part or quantity; stock moves when issued.`,
      },
      {
        title: 'Re-inspect',
        role: 'Inspector',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        body: `Check that all parts requests are settled, then reopen the unit’s inspection and complete the required checks. A pass returns it to its inspection flow; the final pass queues it for Products In, where stock receipt is recorded.`,
      },
    ],
    gotchas: [],
  },
];

// Task-focused workflows complement the existing operational playbooks.
GUIDE_PIPELINES.push(
  { id: 'getting-started', title: 'Find your way around', icon: 'help', audience: 'Everyone', module: 'home', tagline: 'Find a feature, read its guide, and keep useful shortcuts nearby', intro: 'Start from the task you want to accomplish. Your menus and guides follow your role and enabled modules.', steps: [
    { title: 'Search for a screen', body: 'Type a feature name in Search Menu. Press Enter to open the first match; Escape closes the suggestions.', spot: '#menu-search', tip: 'Alt + Shift + G starts a walkthrough of your current screen or dialog.' },
    { title: 'Open contextual guidance', body: 'Press Guide in the screen, side panel or dialog header to start its highlighted walkthrough. Use Next to move between controls and Escape to exit; the current draft stays open.', spot: '[data-guide-open]' },
    { title: 'Track work that matters', body: 'Open Notes from the side toolbar and choose New note / checklist. Add the steps you need to do, enable Schedule this note and enter its due time before saving.', spot: '[data-tool="notes"]' },
  ], gotchas: ['Guides explain actions; they never save, approve, delete, or pay on your behalf.'] },
  { id: 'keyboard-tips', title: 'Keyboard shortcuts and navigation tips', icon: 'help', module: 'home', tagline: 'Hotkeys that work here, with their exact context', audience: 'Everyone', intro: 'Shortcuts help when you know where they apply. These are implemented in the app.', steps: [
    { title: 'Open a guide', body: '<kbd>Alt + Shift + G</kbd> starts a walkthrough on the current screen or dialog. Tab and Shift + Tab move between controls. Escape closes a tooltip or walkthrough before closing its parent dialog.' },
    { title: 'Find a screen', spot: '#menu-search', body: 'Type in Search Menu. Enter opens the first match; Escape closes suggestions.' },
    { title: 'Add checklist items', body: 'In Notes, Enter in the checklist item box adds the item without saving the entire note.' },
    { title: 'Work in the document editor', body: 'Inside the editor: Ctrl/Cmd + S saves; Ctrl/Cmd + Z undoes; Ctrl/Cmd + Y or Shift + Z redoes; Ctrl/Cmd + F opens Find. Ctrl/Cmd + plus, minus, and zero control zoom.', tip: 'These editor commands apply while editing a document. Ordinary dialogs have their own Save or Confirm buttons.' },
  ], gotchas: [] },
  { id: 'file-request', title: 'File an employee request', icon: 'calendar', module: 'hr', tagline: 'Leave, half-day, overtime, offset, and other requests', audience: 'Employees', intro: 'Submit a complete request and track its review.', steps: [
    { title: 'Choose a request type', to: { route: 'hr-requests', label: 'My HR' }, spot: '#myhr-new', nextSpot: '.modal-overlay [data-field], .modal-overlay .leave-date-picker', advanceOn: 'click', body: 'Open the Requests tab in My HR, press New request and choose Leave, Half Day, Overtime, Offset or the request type you need. Use Attendance corrections for missed punches.' },
    { title: 'Provide the details', body: 'Enter the reason and requested dates or times. For leave, select a date range, separate dates or both and review the date preview. Only scheduled working days consume leave balance.', spot: '.modal-overlay:last-child .modal-body' },
    { title: 'Submit and track', body: 'Review the dates and details before submitting. A submitted request stays pending until an authorized approver decides it. Open it from My HR to inspect its status.', to: { route: 'hr-requests', label: 'My HR' }, spot: '#myhr-content', tip: 'Submitting a form is separate from approval. Warnings are advisory; read them before proceeding.' },
  ], gotchas: ['Only scheduled working days consume paid leave. An approved multi-day leave attaches to every selected covered date.'] },
  { id: 'review-requests', title: 'Review employee requests', icon: 'check', module: 'hr', tagline: 'Inspect details, warnings and authority before deciding', audience: 'Department approvers and HR', intro: 'Make informed decisions without missing the employee’s reason or date coverage.', steps: [
    { title: 'Open approvals', to: { route: 'hr-approvals', label: 'Approvals' }, spot: '#ap-search', body: 'Open Pending in Approvals. Search by employee or request name, then press Review on the item you need to decide. Only requests within your authority are actionable.' },
    { title: 'Inspect the complete request', spot: '.modal-overlay:last-child .modal-body', body: 'Press Review and read the request’s displayed reason, dates and other details. Check relevant attendance and leave balance before deciding; ask for clarification if information is missing.' },
    { title: 'Record the decision', spot: '.modal-overlay:last-child #ap-decision', body: 'Choose Approve or Reject, enter a decision note (including the reason for rejection) and press Save decision. Department approval notifies HR and does not need a second approval. Read any balance-override prompt and subsequent review notes.', tip: 'Approval is an explicit decision; a walkthrough never presses its confirmation button.' },
  ], gotchas: ['Overlapping requests warn rather than block. Approved paid leave must not charge the same date twice.'] },
  { id: 'build-form', title: 'Build a request form', icon: 'forms', module: 'hr', tagline: 'Name → fields → optional automation → review', audience: 'Form administrators', intro: 'Create a useful form without getting lost in its technical settings.', steps: [
    { title: 'Create a form', to: { route: 'form-builder', filter: { scope: 'hr' }, label: 'HR Form Builder' }, spot: '#fb-new-form', advanceOn: 'click', nextSpot: '#fb-name', body: 'Press New Form to build a custom form, or choose Quick Add for a common HR form. A form definition specifies fields; it does not submit a request.' },
    { title: 'Name the form', spot: '#fb-name', body: 'Enter the name employees will recognize, such as Leave Request. The internal ID is generated from it; expand Advanced settings only to change the ID, numbering prefix or icon.' },
    { title: 'Add useful fields', spot: '#fb-add-field', body: 'Press Add field, enter its label and key, choose its type and mark it required when reviewers need it. Include a Reason field for requests. Print templates use the field keys.' },
    { title: 'Choose optional automation', spot: '.fb-actions summary', body: 'Expand Automated actions and press Add action if saving or approving a record should trigger a follow-up. Select its action type and trigger, then review its recipient and message.' },
    { title: 'Review before creating', spot: '.modal-overlay:last-child [data-confirm]', body: 'Check the name, required fields and automation, then press Create form. Open the saved form to test a draft before asking employees to use it.', tip: 'Question-mark icons provide detailed explanations without leaving this dialog.' },
  ], gotchas: ['Changing an existing form ID or field key can affect templates and workflows that refer to it.'] },
  { id: 'notes-scheduler', title: 'Turn a note into scheduled work', icon: 'note', module: 'home', tagline: 'Note → checklist → schedule → complete', audience: 'Everyone', intro: 'Keep personal notes, to-dos and reminders connected.', steps: [
    { title: 'Open Notes', spot: '[data-tool="notes"]', advanceOn: 'click', nextSpot: '#note-new', body: 'Choose Notes in the side toolbar.' },
    { title: 'Create a note or checklist', spot: '#note-new', advanceOn: 'click', nextSpot: '#note-title', body: 'Press New note / checklist and enter a title. Add body text for context and use Add item for each action you need to complete.', tip: 'Enter in the checklist item box adds an item rather than saving the note.' },
    { title: 'Schedule the note', spot: '#note-scheduled', body: 'Check Schedule this note, enter its due date and time, and optionally choose Remind me. Press Save to create or update the linked Tasks & reminders task.' },
    { title: 'Keep progress in sync', spot: '#note-items', body: 'Check each checklist item as you finish it; checking every item completes the linked task. Open Tasks & reminders to review the task and choose Open linked note to return. Reopening the task leaves an item unfinished.', tip: 'Rescheduling updates the same task. Push delivery requires notifications enabled on your device.' },
  ], gotchas: ['Notes are private to your account. Deleting a note preserves the existing scheduled task and its captured context.'] },
  { id: 'document-editing', title: 'Create and edit a document', icon: 'file', module: 'home', tagline: 'Choose a document → edit → preview → save', audience: 'Document users', intro: 'Use the document editor without confusing editing, saving and issuing.', steps: [
    { title: 'Choose the document', to: { route: 'templates', label: 'Templates' }, body: 'Open Templates and create a template or edit an existing one. Select the form it prints and give the template a recognizable name.' },
    { title: 'Edit the content', spot: '.doc-surface', body: 'Write in the document canvas. Select text to format it and insert the form fields you need. Review page layout before previewing.', tip: 'In the document editor: Ctrl/Cmd + S saves, Ctrl/Cmd + Z undoes, and Ctrl/Cmd + Y redoes.' },
    { title: 'Preview and save', spot: '.doc-fs [data-preview]', body: 'Choose Preview and select a record to check field values and page breaks. Return to the editor and Save when the output is correct. Saving a template does not issue a business record.', tip: 'Use the editor’s Find control for search. Editor shortcuts apply inside the editor, not every screen.' },
  ], gotchas: [] },
);

// Cross-module roadmaps: inputs, actions and handoffs verified against the app.
GUIDE_PIPELINES.push(...[
  {
    "id": "sales-to-cash",
    "title": "Sales \u2192 parts \u2192 production \u2192 delivery \u2192 payment",
    "module": "inventory",
    "icon": "send",
    "tagline": "Follow the module connections and team handoffs.",
    "audience": "Everyone involved in the process",
    "pipeline": true,
    "intro": "Follow the business process across modules. Each checkpoint names the responsible team, required inputs and result passed to the next team. Your role may only have access to some screens.",
    "steps": [
      {
        "title": "Sales order",
        "module": "Sales",
        "role": "Sales / CSR",
        "to": {
          "route": "orders",
          "filter": {
            "type": "sale"
          },
          "label": "Inventory → Orders"
        },
        "before": "Customer, stock-linked order lines and ship-from location.",
        "body": "Save the order, then open Review stock & approval. Check local availability and commitments.",
        "result": "An open order and stock review show what must be supplied."
      },
      {
        "title": "Plan missing supply",
        "module": "Sales \u2192 Production / Purchasing",
        "role": "Sales / planner",
        "to": {
          "route": "orders",
          "filter": {
            "type": "sale"
          },
          "label": "Inventory → Orders"
        },
        "before": "A stock review showing a shortage.",
        "body": "Use the offered production or purchase drafting action. Review linked drafts before creating more. Stock elsewhere needs a transfer. Approve or backorder using the available actions.",
        "result": "Linked production jobs or purchase drafts cover the outstanding plan; they are not received stock."
      },
      {
        "title": "Approve the production job",
        "module": "Production",
        "role": "Production approver",
        "to": {
          "route": "job-orders",
          "filter": {},
          "label": "Production → Job Orders"
        },
        "before": "A draft production job, a valid product BOM and planned source/output locations.",
        "body": "Review components and quantity, then Approve. Warehouse must accept the approved job.",
        "result": "An approved job is ready for warehouse kit preparation."
      },
      {
        "title": "Parts request / pick the kit",
        "module": "Production \u2192 Warehouse",
        "role": "Parts clerk / warehouse",
        "to": {
          "route": "job-orders",
          "filter": {},
          "label": "Production → Job Orders"
        },
        "before": "Approved job accepted by warehouse; components available at the source.",
        "body": "Open Pick / review kit and record physically picked quantities. Partial picks can be saved. Replenish shortages through purchasing or transfers.",
        "result": "Picked parts are held for this kit. A fully prepared kit is ready for its parts slip."
      },
      {
        "title": "Release parts and accept the kit",
        "module": "Warehouse \u2192 Production",
        "role": "Warehouse / production lead",
        "to": {
          "route": "job-orders",
          "filter": {},
          "label": "Production → Job Orders"
        },
        "before": "A fully prepared kit and the physical handover.",
        "body": "Use Release & issue slip. Production counts the kit and accepts the job; report missing or damaged parts.",
        "result": "The parts slip deducts components; acceptance allows production recording."
      },
      {
        "title": "Record production",
        "module": "Production",
        "role": "Shop floor",
        "to": {
          "route": "job-orders",
          "filter": {},
          "label": "Production → Job Orders"
        },
        "before": "Released, accepted job and actual completed output.",
        "body": "Record the output using the job\u2019s unit or batch controls. Supply identifiers and photos where required.",
        "result": "Output enters configured inspection stages, or Products In when no inspection is required. It is not yet sellable stock."
      },
      {
        "title": "QC / QA and repair branch",
        "module": "Production \u2192 Quality",
        "role": "QC / QA inspector",
        "to": {
          "route": "production-qc",
          "filter": {},
          "label": "Production → QC / QA"
        },
        "before": "Recorded output and the required checklist.",
        "body": "Inspect and record results. Failed output needing repair goes to Repairs & Parts Requests: request added/replacement parts, have warehouse issue them, settle requests, then re-inspect. Resolve QA holds using authorized actions.",
        "result": "Output that completes required inspections becomes ready for receiving."
      },
      {
        "title": "Receive finished goods",
        "module": "Quality \u2192 Warehouse",
        "role": "Receiving clerk",
        "to": {
          "route": "production-receiving",
          "filter": {},
          "label": "Production → Products In"
        },
        "before": "Output ready to receive and physical counts.",
        "body": "Post Products In to the destination location and review Receipt History. Transfer goods if the sales ship-from location differs.",
        "result": "Received finished goods become stock available for the sales order."
      },
      {
        "title": "Authorize and pick the sales release",
        "module": "Sales \u2192 Warehouse",
        "role": "Sales / releaser",
        "to": {
          "route": "releasing",
          "filter": {
            "tab": "queue"
          },
          "label": "Inventory → Releasing"
        },
        "before": "Approved sales order, stock coverage and release authorization from the order.",
        "body": "Warehouse accepts the order, scans serialized units or enters bulk quantities, then reviews the picked lines.",
        "result": "Goods are reserved for the order; picking alone does not deduct stock."
      },
      {
        "title": "Issue release slip and deliver",
        "module": "Warehouse \u2192 Delivery",
        "role": "Releaser / driver",
        "to": {
          "route": "releasing",
          "filter": {
            "tab": "slips"
          },
          "label": "Inventory → Releasing"
        },
        "before": "Picked goods, authorization token and required handover evidence.",
        "body": "Issue the release slip at handover. For deliveries use Phone \u2192 Work \u2192 Deliveries to record recipient proof and delivery status.",
        "result": "The issued slip records stock-out; delivery evidence records the customer handoff."
      },
      {
        "title": "Complete order and collect payment",
        "module": "Sales \u2192 Accounting",
        "role": "CSR / accountant",
        "to": {
          "route": "accounting-receivables",
          "filter": {},
          "label": "Accounting → Receivables & Payables"
        },
        "before": "Delivered order, reviewed completion/invoice and customer balance.",
        "body": "Complete the sale order when appropriate. Open the customer in AR aging to record a receipt allocated to its open documents.",
        "result": "Posted allocations reduce the outstanding balance. An on-account receipt may leave an invoice open."
      }
    ],
    "gotchas": [
      "Follow only the branches that apply. Existing stock can skip production; purchased goods use goods receipts.",
      "Draft orders, picked kits and QC passes have different effects. Check the result at each handoff before proceeding."
    ]
  },
  {
    "id": "purchase-to-pay",
    "title": "Purchasing \u2192 stock \u2192 bill \u2192 payment \u2192 ledger",
    "module": "purchasing",
    "icon": "send",
    "tagline": "Follow the module connections and team handoffs.",
    "audience": "Everyone involved in the process",
    "pipeline": true,
    "intro": "Follow the business process across modules. Each checkpoint names the responsible team, required inputs and result passed to the next team. Your role may only have access to some screens.",
    "steps": [
      {
        "title": "Purchase order",
        "module": "Purchasing",
        "role": "Purchaser",
        "to": {
          "route": "orders",
          "filter": {
            "type": "purchase"
          },
          "label": "Inventory → Orders"
        },
        "before": "Supplier, required items and approved quantities/prices.",
        "body": "Create or review the purchase draft generated by a sales or parts shortage.",
        "result": "A purchase order records expected supply; stock is unchanged."
      },
      {
        "title": "Goods receipt",
        "module": "Purchasing \u2192 Warehouse",
        "role": "Receiver",
        "to": {
          "route": "purchasing",
          "filter": {
            "tab": "receipts"
          },
          "label": "Inventory → Purchasing"
        },
        "before": "Supplier delivery and purchase order.",
        "body": "Record receipt against the PO with actual quantities and destination.",
        "result": "Posted receipt adds stock for kits or sales."
      },
      {
        "title": "Vendor bill and match",
        "module": "Warehouse \u2192 Accounting",
        "role": "Accountant",
        "to": {
          "route": "purchasing",
          "filter": {
            "tab": "bills"
          },
          "label": "Inventory → Purchasing"
        },
        "before": "Supplier invoice and posted receipts.",
        "body": "Enter and review the bill against PO prices and received quantities. Resolve matching differences before approval.",
        "result": "Approved bill is ready for payable review."
      },
      {
        "title": "Supplier payment",
        "module": "Accounting",
        "role": "Accountant",
        "to": {
          "route": "accounting-receivables",
          "filter": {},
          "label": "Accounting → Receivables & Payables"
        },
        "before": "Reviewed supplier balance and configured cash/bank account.",
        "body": "Open the supplier in AP aging and record the payment with document allocations.",
        "result": "The posted payment and allocations record settlement."
      },
      {
        "title": "Check the ledger",
        "module": "Accounting",
        "role": "Accountant",
        "to": {
          "route": "accounting-ledger",
          "filter": {
            "tab": "journal"
          },
          "label": "Accounting → General Ledger"
        },
        "before": "General Ledger configured and applicable transactions posted.",
        "body": "Review generated journal entries and source references; resolve posting errors or unposted sources.",
        "result": "Source documents and ledger entries reconcile; viewing this guide never posts them."
      }
    ],
    "gotchas": [
      "Follow only the branches that apply. Existing stock can skip production; purchased goods use goods receipts.",
      "Draft orders, picked kits and QC passes have different effects. Check the result at each handoff before proceeding."
    ]
  },
  {
    "id": "attendance-to-payroll",
    "title": "Attendance \u2192 approvals \u2192 payroll \u2192 accounting",
    "module": "hr",
    "icon": "send",
    "tagline": "Follow the module connections and team handoffs.",
    "audience": "Everyone involved in the process",
    "pipeline": true,
    "intro": "Follow the business process across modules. Each checkpoint names the responsible team, required inputs and result passed to the next team. Your role may only have access to some screens.",
    "steps": [
      {
        "title": "Cutoff and roster",
        "module": "HR",
        "role": "HR staff",
        "to": {
          "route": "hr-timekeeping",
          "filter": {},
          "label": "HR → Time Keeping"
        },
        "before": "Employees, payroll policy and effective rate tables.",
        "body": "Create the cutoff and add its employees.",
        "result": "A dated roster is ready for attendance."
      },
      {
        "title": "Attendance and approved forms",
        "module": "HR \u2192 Approvals",
        "role": "Employees / approvers / HR",
        "to": {
          "route": "hr-timekeeping",
          "filter": {},
          "label": "HR → Time Keeping"
        },
        "before": "Cutoff roster and attendance sources.",
        "body": "Review punches and attendance; reconcile approved leave, overtime and offset forms.",
        "result": "Verified inputs are ready for payroll computation."
      },
      {
        "title": "Generate and review payroll",
        "module": "HR",
        "role": "Payroll staff",
        "to": {
          "route": "hr-timekeeping",
          "filter": {},
          "label": "HR → Time Keeping"
        },
        "before": "Verified attendance and adjustments.",
        "body": "Generate Payslips, read review notes and compare earnings, deductions and net pay.",
        "result": "Reviewed payroll records are ready for payment and printing."
      },
      {
        "title": "Pay and post to GL",
        "module": "HR \u2192 Accounting",
        "role": "Payroll / accountant",
        "to": {
          "route": "hr-timekeeping",
          "filter": {},
          "label": "HR → Time Keeping"
        },
        "before": "Reviewed payslips, actual payment and configured ledger.",
        "body": "Mark paid only after payment; use Post to GL explicitly and review its result.",
        "result": "Paid payroll locks the cutoff; posted payroll can be checked in the ledger."
      },
      {
        "title": "Compliance worksheets",
        "module": "Accounting",
        "role": "Tax / accounting staff",
        "to": {
          "route": "accounting",
          "filter": {},
          "label": "Accounting → Tax & Compliance"
        },
        "before": "Reviewed payroll and the reporting period.",
        "body": "Generate and reconcile the supported government worksheets before agency submission.",
        "result": "Exported worksheets are prepared; generating them does not file a return."
      }
    ],
    "gotchas": [
      "Follow only the branches that apply. Existing stock can skip production; purchased goods use goods receipts.",
      "Draft orders, picked kits and QC passes have different effects. Check the result at each handoff before proceeding."
    ]
  }
]);

/* route (+ optional sub-tab hint) → pipeline id, so the per-screen Help drawer can
   offer "walk me through this". Screens not listed just link to the guide index. */
const GUIDE_ROUTE_MAP = {
  'production-overview': 'production',
  'finished-products': 'production',
  'finished-goods': 'production',
  'job-orders': 'production',
  'production-qc': 'production',
  'production-receiving': 'production',
  'repairs': 'production',
  'production-batches': 'production',
  'production-schedule': 'production',
  'production-teams': 'production',
  'production-record': 'production',
  'orders': 'sales',
  'purchasing': 'purchasing',
  'hr': 'payroll',
  'hr-timekeeping': 'payroll',
  'hr-employees': 'payroll',
  'hr-kiosk': 'payroll',
  'hr-daily-report': 'payroll',
  'inventory': 'inventory',
  'inventory-movements': 'inventory',
  'suppliers': 'inventory',
  'locations': 'inventory',
  'accounting': 'accounting',
  'accounting-ledger': 'accounting',
  'accounting-receivables': 'accounting',
  'accounting-petty-cash': 'accounting',
  'analytics': 'accounting',
  'dashboard': 'getting-started',
  'hr-requests': 'file-request',
  'hr-approvals': 'review-requests',
  'form-builder': 'build-form',
  'forms': 'document-editing',
  'templates': 'document-editing',
};

const GUIDE = {
  pipelines: GUIDE_PIPELINES,
  byId: Object.fromEntries(GUIDE_PIPELINES.map((p) => [p.id, p])),
  routeMap: GUIDE_ROUTE_MAP,
  /** Pipeline for a route name (or null). */
  forRoute(route, filter) {
    if (route === 'orders' && filter?.type === 'purchase') return this.byId.purchasing;
    if (route === 'orders' && filter?.type === 'job') return null;
    if (route === 'form-records' && (filter?.slug === 'hr_payroll' || filter?.scope === 'hr')) return this.byId.payroll;
    const id = GUIDE_ROUTE_MAP[route];
    return id ? this.byId[id] : null;
  },
};

// Browser: expose as a global (loaded via <script> before help.js / views/sop.js).
// Node (tests): export for require().
if (typeof window !== 'undefined') window.GUIDE = GUIDE;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GUIDE, GUIDE_PIPELINES, GUIDE_ROUTE_MAP };
}
