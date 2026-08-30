/* In-app Help. A rail button (data-tool="help", wired in tools.js) opens a drawer
   with plain-language explainers for the screen the user is on, plus an index to
   every other topic. Content is authored here as HTML; the fuller written manuals
   live in docs/guides/ for trainers. */
(function () {
  // group -> for the picker's <optgroup>. routes -> which App route auto-selects this.
  const TOPICS = [
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
      id: 'inventory', title: 'Inventory — items & stock', group: 'Inventory', routes: ['inventory', 'inventory-movements'],
      html: `
        <p>The item list is your catalogue. Each row is one product or material with a
        quantity on hand.</p>
        <ul>
          <li><b>New item</b> — add one product. Set a <b>SKU</b> (unique code), unit,
              and a <b>reorder level</b> so it flags when stock runs low.</li>
          <li><b>Stock in / out</b> (row action) — record a delivery, a withdrawal, or a
              correction. Every change is kept in the item's <b>history</b>.</li>
          <li><b>Transfer</b> — move units from one location to another; the grand total
              doesn't change.</li>
          <li><b>Low Stock</b> filter — everything at or below its reorder level.</li>
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
          <li>One bad row is skipped with a reason; the good rows in the same file still import.</li>
          <li>Export → edit in Excel → re-import is safe: it produces all updates, no duplicates.</li>
        </ul>`,
    },
    {
      id: 'suppliers', title: 'Suppliers', group: 'Inventory', routes: ['suppliers'],
      html: `
        <p>Your vendor list. Link an item to a supplier so reorder reports know who to buy
        from.</p>
        <ul>
          <li><b>New supplier</b> — name, contact person, phone, email, address.</li>
          <li><b>Import</b> — bulk-load from a spreadsheet (matched by name).</li>
          <li>Deleting a supplier doesn't delete its items — they just lose the link.</li>
        </ul>`,
    },
    {
      id: 'locations', title: 'Locations', group: 'Inventory', routes: ['locations'],
      html: `
        <p>Warehouses, branches, stores, or trucks that hold stock. One is the
        <b>default</b> — new stock lands there unless you say otherwise.</p>
        <p>Once you have more than one, each item tracks a quantity <b>per location</b>, and
        you can <b>Transfer</b> between them.</p>`,
    },
    {
      id: 'finished-products', title: 'Finished products & BOM', group: 'Manufacturing',
      routes: ['finished-products'], html: `
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
      routes: ['job-orders'], html: `
        <p>A Job Order builds N units of a finished product.</p>
        <ol>
          <li><b>Create</b> it: choose the product and quantity. It starts as a draft.</li>
          <li><b>Release</b> it: the BOM parts are consumed from the source location. You
              can still add or remove components manually for one-off builds.</li>
          <li><b>Track</b> progress: mark units done or scrapped. <b>Pause</b> or
              <b>cancel</b> anytime — cancelling returns the <i>unused</i> parts only.</li>
          <li><b>QA/QC</b>: inspectors record pass / fail per unit, with remarks on
              failures. You can require one or two QC stages.</li>
          <li>Give each physical unit an <b>identifier</b> (serial / chassis / motor no.).
              Passed units are added to the finished product's quantity and can be
              <b>exploded</b> to show every serial.</li>
        </ol>`,
    },
    {
      id: 'quickbooks', title: 'QuickBooks Online', group: 'Orders', routes: [],
      html: `
        <p>Push <b>sale / job orders</b> to QuickBooks as <b>Invoices</b> and
        <b>purchase requests</b> as <b>Bills</b>. One-way, on demand or automatic.</p>
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
      id: 'orders', title: 'Sale / Job / Purchase orders', group: 'Orders',
      routes: ['orders'], html: `
        <p>Three document types share one screen, filtered by tab:</p>
        <ul>
          <li><b>Sale Orders</b> — what a customer is buying.</li>
          <li><b>Job Orders</b> — work to be performed (can link to a production Job Order).</li>
          <li><b>Purchase Orders</b> — what you're buying from a supplier. Pick the
              <b>Supplier</b> and an <b>Expected delivery</b> date so Purchasing can
              track it. The row's <b>Receiving &amp; bills</b> icon opens its receipts
              and vendor bills.</li>
        </ul>
        <p>Numbers (SO-#####, JO-#####, PR-#####) are assigned automatically. Totals and
        tax are computed for you. Use <b>Templates</b> to control how the printed
        document looks.</p>`,
    },
    {
      id: 'purchasing', title: 'Purchasing — receiving & vendor bills', group: 'Orders',
      routes: ['purchasing'], html: `
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
        <p>Match tolerance (default 2% on price) is a workspace setting via
        <code>PUT /api/purchasing/tolerance</code>.</p>
        <p><b>Who can do what:</b> receiving needs <i>Adjust inventory</i>; raising and
        approving bills needs <i>Edit orders</i> — so the warehouse receives and
        accounting approves.</p>`,
    },
    {
      id: 'hr-employees', title: 'Employees (201 file)', group: 'HR',
      routes: ['hr-employees', 'hr'], html: `
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
        <p>Attendance is organised into <b>cutoff periods</b>. For each period you record
        daily <b>time in / out</b> per employee (and which shift applied that day).</p>
        <ul>
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
        by hand. Cash advance and rest-day OT are always entered manually and are kept when
        you re-generate.</p>`,
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
        <p><b>Accounting → Tax &amp; Compliance</b> builds every statutory return from your
        payroll, sales and purchase records. All are <b>worksheets</b> — review and adjust
        before filing in eBIRForms / eFPS or each agency's portal (PH agencies have no
        direct filing API). Payroll <i>processing</i> (13th-month, final pay) stays under
        <b>HR → Time Keeping → Payroll Worksheets</b>.</p>
        <ul>
          <li><b>2550M</b> — Monthly VAT declaration: output VAT from the month's sale
              orders, input VAT from approved vendor bills. Adjust for exempt / zero-rated
              sales and disallowed input. Deadline: 20th of the following month.</li>
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
        <p>A full double-entry general ledger (chart of accounts, journals, financial
        statements, VAT/EWT registers, BIR books of accounts) is planned — see
        <code>docs/ACCOUNTING-SYSTEM-PLAN.md</code>.</p>`,
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
        <p>This is <b>Phase 0</b>. Auto-posting from invoices, bills and payslips, plus
        the BIR books/SLSP exports, come next — see
        <code>docs/ACCOUNTING-SYSTEM-PLAN.md</code>.</p>`,
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
          <li>The <b>2026</b> schedule is built in — payroll works out of the box.</li>
          <li>Each table is stored with an <b>effective date</b>; a payroll run uses the
              newest one on or before the pay date.</li>
          <li><b>Every January</b>, if SSS / PhilHealth issue a new circular or the BIR a
              new withholding table, paste the new figures and <b>Save as new version</b>
              dated <code>YYYY-01-01</code>. Don't edit last year's in place — past runs
              must keep their old numbers.</li>
          <li>Always cross-check the first run on a new schedule against the agency's own
              calculator before releasing payslips.</li>
        </ul>`,
    },
    {
      id: 'form-builder', title: 'Form Builder & Data Forms', group: 'Documents',
      routes: ['form-builder', 'form-records'], html: `
        <p><b>Form Builder</b> lets an admin design a custom form type — its fields, an
        icon, and a number prefix — without a developer. Forms are grouped by section
        (HR / Inventory / Admin / Accounting) and only that section's managers can edit
        them.</p>
        <p><b>Data Forms</b> is where staff fill in and store records of those forms. Each
        record gets an automatic number and can be printed against a linked template.</p>`,
    },
    {
      id: 'templates', title: 'Document Templates', group: 'Documents',
      routes: ['templates'], html: `
        <p>Templates control how printed documents look — orders, payslips, ID cards.
        They use <code>{{placeholders}}</code> that are filled from the record, the
        company profile, and today's date.</p>
        <p>Edit the HTML directly, or drop in variables from the picker. The
        <b>company profile</b> (name, address, phone) feeds every <code>{{company.*}}</code>
        placeholder in one place.</p>`,
    },
    {
      id: 'activity', title: 'Activity Log', group: 'Admin', routes: ['activity'],
      html: `
        <p>An append-only record of every change made in the system — who, what, when,
        from where. Filter by user, module, action, or date. Admin-only.</p>
        <p>Use it to answer "who changed this?" and as evidence for audits.</p>`,
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
              the sign-in screen (needs email set up under the Email tool). Without an
              email, only an admin can reset their password here.</li>
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
          <li>It only sees and does what <b>your account</b> can. It won't do bulk edits.</li>
          <li>If it made a file, a <b>download</b> button appears under the reply.</li>
          <li><b>Check anything that matters</b> against the real screen — it can be wrong.</li>
          <li>Admins: <b>AI settings</b> (button in the assistant panel) sets the API key,
              model, and endpoint — any OpenAI-compatible provider works.</li>
        </ul>`,
    },
    {
      id: 'mobile-app', title: 'Mobile Warehouse App', group: 'Tools', routes: [],
      html: `
        <p>A phone version at <code>/m</code> for the stockroom: scan an item, move stock,
        count, fulfil orders, or report damage — and it keeps working <b>offline</b>.</p>
        <ul>
          <li>Open the normal system address on a phone; you're sent to the mobile app
              automatically. Needs the <b>mobile warehouse</b> permission.</li>
          <li>Offline, submissions <b>queue</b> and send themselves when the signal returns.
              Don't clear the browser's site data while the queue has items.</li>
          <li>The camera scanner needs HTTPS; otherwise you get manual code entry.</li>
        </ul>`,
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
        <p>Send messages to other staff inside the system — an inbox, a sent box, and an
        unread badge on the rail. Good for a quick note tied to work, without leaving the
        app.</p>`,
    },
    {
      id: 'account', title: 'My Account', group: 'Basics', routes: ['account'],
      html: `
        <p>Update your display name and <b>change your password</b>. If your account is
        linked to an employee record, your HR profile is shown here too (read-only).</p>`,
    },
  ];

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

  function renderBody(el, topicId) {
    const t = byId[topicId] || TOPICS[0];
    el.querySelector('.drawer-body').innerHTML = `
      ${pickerHtml(t.id)}
      <div class="help-content">
        <h4 style="margin:0 0 8px">${UI.esc(t.title)}</h4>
        ${t.html}
      </div>
      <p class="muted" style="margin-top:14px;border-top:1px solid var(--border);padding-top:8px">
        Trainers: full written guides are in <code>docs/guides/</code>.
      </p>`;
    const pick = el.querySelector('#help-pick');
    if (pick) pick.addEventListener('change', () => renderBody(el, pick.value));
  }

  function open(topicId) {
    let route = '';
    try { route = (window.App && App.currentLocation && App.currentLocation().route) || ''; } catch (_) {}
    const id = topicId || routeIndex[route] || 'getting-started';
    const d = UI.drawer({ title: 'Help', icon: 'help', key: 'help', bodyHTML: '' });
    if (d) renderBody(d.el, id);
  }

  window.Help = { open, topics: TOPICS };
})();
