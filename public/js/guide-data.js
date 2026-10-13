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
        body: `The home screen for this whole tab, not a working screen of its own — a
          summary of where things stand: overdue job orders, units stuck in rework, what's
          waiting on someone (QC/QA queue, Products In, repair requests to accept), and a
          short production report. Every row links straight to the screen that handles it.`,
      },
      {
        title: 'Define the finished product & BOM',
        role: 'Inventory · inventory.edit',
        to: { route: 'finished-products', label: 'Production → Product Setup' },
        spot: '.tree-leaf[data-route="finished-products"]',
        body: `A one-time setup step, not part of the day-to-day flow below: pick an item and
          list the parts to build one unit — that list is the <b>BOM</b>. A component that is
          itself a finished product with its own BOM is a <b>sub-assembly</b> and is exploded
          automatically. Optionally set a standard <b>Labor</b> and <b>Overhead</b> per unit —
          they're added on top of the rolled-up material cost to value finished units into
          stock.`,
        tip: `A product can be saved with <b>no BOM</b> — it still builds, it just reserves and
          consumes nothing until you add components.`,
      },
      {
        title: 'Attach a QC/QA checklist (optional)',
        role: 'QA · qc.configure',
        to: { route: 'production-qc', label: 'Production → QC / QA → Manage Checklists' },
        body: `Also setup: build named, reusable checklists (each check scoped to <i>every</i>
          inspection, the <i>QA</i> pass, or the <i>QC</i> pass) from <b>Manage Checklists</b> —
          reachable from either QC/QA page — then attach one to the product on its BOM editor
          in Product Setup. Required checks must be ticked before a unit or batch can pass.`,
      },
      {
        title: 'Schedule / start the job order',
        role: 'Production · inventory.adjust',
        to: { route: 'job-orders', label: 'Production → Job Orders' },
        spot: '.tree-leaf[data-route="job-orders"]',
        body: `Where the day-to-day pipeline actually starts. Choose the product and quantity.
          Set the <b>team</b>, <b>work centre</b>, <b>planned start</b>, <b>due date</b> and
          <b>priority</b> right here, and how many <b>inspection stages</b> apply (0 = straight
          to Products In, 1 = QC/QA, 2 = QC then QA). Pick the <b>source</b> location (parts are
          pulled from) and the <b>output</b> location (a default destination — Products In can
          still send finished units elsewhere at receiving time). It starts as a <b>draft</b>.
          <b>Production → Scheduling</b> is the supporting calendar/roster view across every
          job order, for monitoring at a glance rather than one at a time.`,
      },
      {
        title: 'Release (parts out)',
        role: 'Production / warehouse · inventory.adjust',
        to: { route: 'job-orders', label: 'Job order → Release' },
        body: `Reserves and deducts the planned components from the source location — it fails with
          a shortfall list if stock is short (no partial release). If the general ledger is on, the
          material value moves from Inventory into Work in Process. Records who released it.`,
      },
      {
        title: 'Accept the parts kit',
        role: 'Production lead · production.record',
        to: { route: 'job-orders', label: 'Job order → Accept parts kit' },
        body: `The production lead counts the released kit against the job order's Components
          list and taps <b>Accept job order</b> (optional handover note). Records who accepted it
          and when. Output can't be recorded until the kit is accepted — a short or damaged kit
          goes back to the warehouse via <b>Report a problem</b> instead.`,
      },
      {
        title: 'Build (record production progress)',
        role: 'Shop floor · inventory.adjust',
        to: { route: 'job-orders', label: 'Job order → Record production' },
        body: `Enter units <b>finished</b> and <b>scrapped</b>. Either way this doesn't post to
          stock yet — with <b>0 inspection stages</b> the entry becomes a batch/lot awaiting
          Products In directly; with <b>1–2 stages</b> the units queue for inspection first —
          give the entry a <b>batch label</b> to group them.`,
      },
      {
        title: 'Inspect (QC/QA)',
        role: 'QC/QA inspector · inventory.adjust',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        spot: '.tree-leaf[data-route="production-qc"]',
        body: `Select a unit or a batch, work the checklist, then <b>Pass</b> or <b>Fail</b>. The
          final pass queues the unit for Products In (below) — it isn't stock yet. A <b>fail</b>
          needs a <b>disposition</b>: <i>scrap / dispose / recycle</i> (terminal — counts as
          scrapped) or <i>repair</i> — and an <b>evidence photo</b> of each failed unit (the app
          refuses the fail without one, on the phone and here). On the final pass, QA can also
          <b>hold</b> a unit for review.`,
      },
      {
        title: 'Decide a QA hold (branch)',
        role: 'Any QA inspector · production.qa_review (Production Manager by default)',
        to: { route: 'job-orders', label: 'Job order → Held by QA for review → Decide…' },
        body: `A held unit is <b>on hold</b>: out of stock, and its job order can't complete. Every
          QA inspector and everyone who can decide QA holds is notified. Open it (phone: QA desk →
          <b>On hold</b>, or Work → <b>QA holds</b>; desktop: the job order) and decide with a
          reason: <b>pass</b> (on to Products In), <b>rectify</b> (back to rework) or <b>fail</b>.
          The inspector who held it is notified.`,
      },
      {
        title: 'Findings & reports',
        role: 'read: inventory.view',
        to: { route: 'production-qc', filter: { tab: 'findings' }, label: 'Production → QC / QA → Findings & Reports' },
        body: `Every pass/fail ever recorded, across every job order — filter by result, date, or a
          job order / product search, and export to CSV. Open a row for the full finding: the
          checklist snapshot, remarks, disposition and inspector.`,
      },
      {
        title: 'Repair / rework (branch)',
        role: 'Production raises · Warehouse accepts · inventory.adjust',
        to: { route: 'repairs', label: 'Production → Repairs & Parts Requests' },
        body: `A unit failed as <b>repair</b> goes to rework and holds the job order open. From the
          repair panel, raise <b>parts requests</b> — <i>add</i> a missing part or <i>replace</i> a
          fitted one (the removed part is booked to its damage record). Raising a request
          <b>holds the part</b> at an approved parts location, so kits, other requests and sales
          can't take it; with no free stock anywhere it's a <b>shortage</b>. The parts clerk issues
          it from an approved location, scanning the <b>exact part and quantity</b> — another part or
          quantity needs a <b>revision</b> the requester approves. The requester is notified when
          it's issued, rejected, short or revised. The unit can only be re-inspected once every
          request is settled — passing then rejoins the flow at Products In.`,
      },
      {
        title: 'Products In',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'production-receiving', label: 'Production → Products In' },
        spot: '.tree-leaf[data-route="production-receiving"]',
        body: `The checkpoint that mirrors Purchasing's <b>Goods Receipt</b>: nothing posts to
          stock until it's confirmed/counted in here, whether it needed QC or not. <b>Ready to
          Receive</b> lists every job order with output waiting — tick the units, or enter a
          batch's received quantity (short counts allowed), pick the <b>destination
          location</b>, and post. Picking a different location than the job order's default
          output is how a "warehouse transfer" away from the shop floor happens, in the same
          step. Only storage locations count (not a truck), and a location with a <b>capacity</b>
          (Inventory → Locations) refuses what won't fit. A unit is never received twice.
          <b>Receipt History</b> is the log of every past receipt.`,
        tip: `A unit only becomes sellable/reservable once it's been received here — a QC pass
          alone isn't enough.`,
      },
      {
        title: 'Batches / lots & the production record',
        role: 'read: inventory.view',
        to: { route: 'production-batches', label: 'Production → Batches / Lots' },
        body: `A <b>batch/lot</b> groups the units off one job order under a <code>BATCH-#####</code>
          number — the traceability log, independent of whether it's been received yet. Open one
          to relabel it, change its status, or record an optional batch-level QC/QA sign-off (a
          quality flag, not a receipt). Scanning a unit or batch QR opens its printable
          <b>Production record</b> — the build details, every sign-off, repairs, and the stock
          movements it drove.`,
      },
      {
        title: 'Labels & QR',
        role: 'Production · inventory.adjust',
        to: { route: 'finished-products', label: 'Product Setup → Print QR labels' },
        body: `Print QR labels per unit (its identifier) or per batch. Edit the layout under
          <b>Label design</b>. Scanning a label in this system's scanner resolves it to the
          production record.`,
      },
      {
        title: 'Completion & returns',
        role: 'automatic',
        body: `Production completion tracks the <i>build</i>, not receiving: once every ordered
          unit is accounted for (built + scrapped) and nothing is pending or in rework, the job
          order <b>completes</b> and the components reserved but not consumed are returned to
          the source location — even if some output is still awaiting Products In (real
          physical units don't wait on paperwork). <b>Close (finish early)</b> or <b>Cancel</b>
          do the same return manually; either way, whatever was already built still needs to be
          received.`,
      },
      {
        title: 'Sell / move finished goods',
        role: 'Sales / warehouse · inventory.adjust',
        to: { route: 'finished-goods', label: 'Production → Finished Goods' },
        body: `<b>Finished Goods</b> is the cross-product view of what's actually on hand, ready
          to sell or move — everything Products In has received. Sell against a sale order, or
          move it again with the same action used at receiving. Only received (in-stock) units
          can be sold or moved.`,
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
        body: `Pick the customer, add line items from inventory (finished products or raw items), set
          the <b>Ship from</b> location and tax. It starts <b>open</b> and line items stay freely
          editable while it is.`,
      },
      {
        title: 'Approve — with a stock check',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → Status → Approve' },
        body: `Moving the order to <b>approved</b> checks every line against available stock (net of
          what's reserved elsewhere). Approving <b>locks the line items</b> and unlocks the warehouse
          to release. The toolbar's <b>Backorders</b> toggle lists every approved order still short
          of stock — those rows carry a ⚠ badge.`,
      },
      {
        title: 'Authorize the release',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → key icon' },
        body: `Every sale order needs a <b>release authorization</b> before the goods can leave
          (unless the company turns the policy off on the same screen). Set pickup or delivery,
          the approved recipient, an ID reference (only the last 4 characters are kept), how long
          it's valid, the handoff area, and whether a <b>partial release</b> is allowed. Give the
          <b>token</b> it shows to the recipient — the releaser never sees it. Release reports from
          the warehouse notify you and are resolved here.`,
      },
      {
        title: 'Cover a shortfall (if the check fails)',
        role: 'CSR / manager · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → shortfall prompt' },
        body: `If a line is short you get four choices: <b>Trim to available</b>, <b>Create job
          orders for the shortfall</b> (a draft MO per short finished-product line, linked to this
          order), <b>Draft purchase orders for the shortfall</b> (one per preferred supplier for
          parts that must be bought), or <b>Approve as a backorder</b> (proceed anyway).`,
      },
      {
        title: 'Warehouse accepts the order',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'queue' }, label: 'Inventory → Releasing → Release Queue' },
        spot: '.tree-leaf[data-route="releasing"]',
        body: `Approved orders wait under <b>Waiting for warehouse acceptance</b>. Press <b>Accept for
          release</b> (or <b>Accept</b> on the phone) to take the order on — that records who
          accepted it and when. Nothing can be picked until it's accepted.`,
      },
      {
        title: 'Release the goods',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'queue' }, label: 'Release Queue → open the order' },
        body: `Scan each unit's printed QR label (desktop scan box, or <b>Scan units to release</b> on
          the phone); for non-serialized lines, enter the quantity. Scanned units go to
          <b>reserved</b> — earmarked for the order but still physically on hand. Once every line is
          covered the order flips to <b>released</b>. <b>Nothing leaves inventory yet.</b>`,
      },
      {
        title: 'Issue the release slip',
        role: 'Warehouse releaser · inventory.adjust / orders.release',
        to: { route: 'releasing', filter: { tab: 'slips' }, label: 'Release order → Issue release slip' },
        body: `As the goods leave, press <b>Issue release slip</b>: enter the <b>token</b> the
          recipient presents, confirm every required package item, enter who collected them and
          the vehicle, and add at least one photo of what's going out (required). If the recipient
          can't present the token, a <b>warehouse supervisor</b> can release without it — with a
          reason that prints on the slip (on the phone the releaser asks and supervisors are
          notified). With Sales' permission an incomplete order can go out as a <b>partial
          release</b>: the rest moves to a new backorder order. The slip (RS-xxxxx) lists every line
          and unit serial. <b>This is when stock leaves inventory</b> — the order becomes
          <b>confirmed</b>, reserved units flip to <b>sold</b>, and (with the general ledger on) COGS
          is posted. Print it from <b>Release Slips</b> for signatures.`,
      },
      {
        title: 'Deliver',
        role: 'Driver · delivery.run',
        to: { external: 'Phone → Work → Deliveries' },
        body: `Create / start a delivery linked to the order, capture the proof of delivery
          (recipient, signature, photos, location) and mark it delivered. If the order isn't
          confirmed yet, the phone then offers <b>"Mark SO-xxxx completed"</b> — one tap runs the
          next step.`,
      },
      {
        title: 'Complete / invoice',
        role: 'Accounting / CSR · orders.edit',
        to: { route: 'orders', filter: { type: 'sale' }, label: 'Sale order → Status → Completed' },
        body: `Once delivered, move the order to <b>completed</b> and invoice it. Re-opening or
          cancelling a slipped order reverses the stock-out; the slip stays on record.`,
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
        body: `Pick the <b>supplier</b> and an <b>expected delivery</b> date. Lines can include items
          you already stock — that's just a top-up purchase.`,
      },
      {
        title: 'Let the system draft POs for you (optional)',
        role: 'Purchasing · inventory.adjust',
        to: { route: 'inventory', filter: { low: '1' }, label: 'Inventory → Low Stock → Reorder PO' },
        body: `<b>Inventory → Reorder PO</b> drafts a PO for everything below its reorder level (one
          per preferred supplier). The <b>Draft purchase orders for the shortfall</b> button on a
          short sale / job order does the same for that order's gap. Each lands as an <b>open</b>
          draft to review under Purchase Orders.`,
      },
      {
        title: 'Receive what arrived',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'purchasing', filter: { tab: 'receipts' }, label: 'Inventory → Purchasing → Goods Receipts' },
        spot: '.tree-leaf[data-route="purchasing"]',
        body: `From the PO's <b>Receiving &amp; bills</b>, press <b>Record receipt</b>. Enter the
          quantity that actually arrived per line and the location. Posting the receipt (GRN-#####)
          <b>moves that stock in</b> and shows in the item's history. Receive as many times as
          deliveries come. On the phone: <b>Work → Receive PR</b>.`,
      },
      {
        title: 'Vendor bill & the 3-way match',
        role: 'Accounting · orders.edit',
        to: { route: 'purchasing', filter: { tab: 'bills' }, label: 'Inventory → Purchasing → Vendor Bills' },
        body: `Record the supplier's invoice, then <b>Approve</b>. The 3-way match requires every
          billed line to be covered by what was received, and the price to be within tolerance of
          the PO price; off-PO charges are flagged. A clean match approves; an exception blocks
          approval until you receive the shortfall, fix the bill, or <b>Force approve</b> (recorded
          against your name).`,
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
        body: `Set your <b>pay frequency</b>, grace minutes, OT rules and cap, night-differential,
          minimum work-time policy, and the half-day window. Leave <b>Auto-compute SSS / PhilHealth
          / Pag-IBIG / withholding tax</b> on to fill those lines from the government rate tables
          (the <b>2026</b> schedule is built in — <i>Statutory Rate Tables → Open rate tables</i>).`,
        tip: `Every January, paste any new SSS / PhilHealth / BIR figures and <b>Save as a new
          version</b> dated <code>YYYY-01-01</code> — don't edit last year's in place.`,
      },
      {
        title: 'Keep the employee 201 files current',
        role: 'HR · hr.manage',
        to: { route: 'hr-employees', label: 'HR → Employees' },
        spot: '.tree-leaf[data-route="hr-employees"]',
        body: `Each record needs a <b>pay rate</b> (daily or monthly), employment status, and the
          statutory numbers (SSS / PhilHealth / Pag-IBIG / TIN). Per-employee statutory on/off
          switches live under <b>Accounting → Tax &amp; Compliance → Statutory deductions</b>.`,
      },
      {
        title: 'Open the cutoff period',
        role: 'HR · hr.view',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping' },
        body: `Pick or create the cutoff you're processing. Each period holds a daily <b>time in /
          out</b> per employee and which shift applied that day.`,
      },
      {
        title: 'Record attendance',
        role: 'HR / timekeeper · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping (grid)' },
        body: `Enter time in / out (and the lunch bracket), then <b>reconcile</b> punches into the
          grid. Each day is classified <b>Whole / Half / Undertime Day</b>. The <b>Time-in Kiosk</b>
          (an office monitor) and the phone time clock feed raw punches into this grid.`,
      },
      {
        title: "Check today's attendance at a glance",
        role: 'HR / timekeeper · hr.view',
        to: { route: 'hr-daily-report', label: 'HR → Time Keeping → Daily Report' },
        body: `A live, whole-company snapshot for one date: <b>Present / Late / Half Day /
          Absent / On Leave</b> counts, broken down per department, plus a searchable employee
          list. <b>Half Day</b> is anyone who first timed in after lunch started (late if past the
          afternoon start), left at lunch, or has a Half Day form — the same days payroll pays as
          half days. Reads
          today's kiosk/phone punches directly — no need to wait for <i>Import Punches</i> or a
          cutoff to exist. Rest days, holidays, and company no-work days are shown separately so
          they're never mistaken for absences.`,
      },
      {
        title: 'Link OT / leave / offset forms',
        role: 'HR · hr.manage',
        to: { route: 'form-records', filter: { scope: 'hr' }, label: 'HR → Memos & Notices / request forms' },
        body: `Attach an approved <b>Overtime</b>, <b>Leave</b>, <b>Offset</b> or <b>Undertime</b>
          form to the day so it's paid correctly (an Offset form's optional <i>New Time In</i>
          shifts the whole day's window). HR memos and NTEs live here too.`,
      },
      {
        title: 'Generate payslips',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping → Generate Payslips' },
        body: `<b>Generate Payslips</b> creates records in the HR Payroll form for the period.
          With auto-compute on, SSS / PhilHealth / Pag-IBIG / withholding are filled from the rate
          tables (the monthly contribution split across your cutoffs). Cash advance and rest-day OT
          are entered by hand and are <b>kept</b> when you re-generate.`,
      },
      {
        title: 'Review & print payslips',
        role: 'HR · hr.view',
        to: { route: 'form-records', filter: { slug: 'hr_payroll' }, label: 'HR → Payroll' },
        body: `Open the Payroll form for the period, check the lines against the grid, then
          <b>print</b> each payslip against the payslip template.`,
      },
      {
        title: '13th-month & final pay',
        role: 'HR · hr.manage',
        to: { route: 'hr-timekeeping', label: 'HR → Time Keeping → Payroll Worksheets' },
        body: `13th-month and final-pay <i>processing</i> stay here under Time Keeping. (13th-month
          isn't a payslip line, so a December payout is added to that month's 1601-C by hand.)`,
      },
      {
        title: 'File the government forms',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting', label: 'Accounting → Tax & Compliance' },
        body: `<b>Tax &amp; Compliance</b> builds every statutory return from the payslips —
          <b>1601-C</b> (monthly), <b>1604-C</b> + <b>Alphalist</b> (annual), <b>2316</b> per
          employee, and the monthly <b>SSS / PhilHealth / Pag-IBIG</b> contribution schedules. All
          are worksheets — review before filing in eBIRForms / eFPS or each agency's portal.`,
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
        body: `Set a unique <b>SKU</b>, a unit, and a <b>reorder level</b> so the item flags when
          stock runs low. Optionally add a <b>Barcode</b> and a <b>Standard cost</b> (used to value
          stock and roll up BOM costs). Bulk-load with <b>Import</b> (matched by SKU).`,
      },
      {
        title: 'Set up locations & suppliers',
        role: 'Inventory · inventory.edit',
        to: { route: 'locations', label: 'Inventory → Locations' },
        body: `Add each warehouse / branch / truck that holds stock; one is the <b>default</b> where
          new stock lands. Add vendors under <b>Suppliers</b> and link each item to a preferred one
          so reorder POs know who to buy from.`,
      },
      {
        title: 'Record stock in / out & corrections',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Stock in / out' },
        body: `Record a delivery, a withdrawal, or a correction from the item's row action. Every
          movement is kept in the item's <b>history</b> and on the cross-item <b>Stock Movements</b>
          screen.`,
      },
      {
        title: 'Transfer between locations',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Transfer' },
        body: `Move units from one location to another — the grand total doesn't change. Once you
          have more than one location, each item tracks a quantity <b>per location</b>.`,
      },
      {
        title: 'Low stock & Reorder PO',
        role: 'Purchasing · inventory.adjust',
        to: { route: 'inventory', filter: { low: '1' }, label: 'Inventory → Low Stock' },
        body: `The <b>Low Stock</b> filter shows everything at or below its reorder level.
          <b>Reorder PO</b> drafts purchase orders for that list — one per preferred supplier,
          topping each item to a multiple of its reorder level. Finished products are skipped
          (those are produced).`,
      },
      {
        title: 'Print barcode labels',
        role: 'Inventory · inventory.view',
        to: { route: 'inventory', label: 'Inventory → Labels' },
        body: `Print <b>Code 128</b> labels for the items in the current list — each encodes the
          item's Barcode, or its SKU if it has none. Pick a size and copies, tick the items, then
          <b>Open print sheet</b>. The labels scan back with this system's phone scanner.`,
      },
      {
        title: 'Report damage',
        role: 'Warehouse · inventory.adjust',
        to: { route: 'inventory', label: 'Inventory → item row → Report damage' },
        body: `Reporting damaged units moves them into a separate <b>damage</b> record — they leave
          sellable stock without vanishing from the books.`,
      },
      {
        title: 'Audit the movements',
        role: 'read: inventory.view',
        to: { route: 'inventory-movements', label: 'Inventory → Stock Movements' },
        body: `Every in / out / transfer / damage across every item, filterable — the answer to
          "why did this quantity change?".`,
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
        body: `<b>Sale orders</b> (output VAT, AR, sales), <b>approved vendor bills</b> (input VAT,
          AP, expenses) and <b>generated payslips</b> (withholding, contributions) are the sources.
          Keep those flows clean and the accounting screens mostly fill themselves.`,
      },
      {
        title: 'Set up the books (once)',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-ledger', label: 'Accounting → General Ledger → Books' },
        spot: '.tree-leaf[data-route="accounting-ledger"]',
        body: `<b>Set up books</b> creates a standard Philippine SMB <b>chart of accounts</b> and
          your first fiscal year. <b>Group</b> accounts are headers you can't post to; leaf accounts
          hold balances.`,
      },
      {
        title: 'Record & post journals',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-ledger', label: 'Accounting → General Ledger → Journal' },
        body: `Pick accounts, put amounts in the <b>Debit</b> or <b>Credit</b> column (totals must
          match), save as a <b>draft</b>, then <b>Post</b>. A posted entry is never edited or
          deleted — <b>Reverse</b> it and a mirror entry is posted. Trial Balance / P&amp;L /
          Balance Sheet are live from the posted entries.`,
      },
      {
        title: 'Tax & Compliance worksheets',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting', label: 'Accounting → Tax & Compliance' },
        spot: '.tree-leaf[data-route="accounting"]',
        body: `Builds <b>2550M</b> (VAT), <b>0619-E</b> (expanded withholding), <b>1601-C / 1604-C /
          Alphalist / 2316</b> (compensation tax) and the <b>SSS / PhilHealth / Pag-IBIG</b>
          contribution schedules from your records. Export the CSV / DAT and file in each portal.`,
      },
      {
        title: 'Receivables & payables',
        role: 'Accounting · accounting.view',
        to: { route: 'accounting-receivables', label: 'Accounting → Receivables & Payables' },
        body: `AR / AP aging, <b>Payments</b> against invoices and bills, and <b>Credit / Debit
          Notes</b>. This is where a customer payment or a supplier settlement is recorded.`,
      },
      {
        title: 'Petty cash',
        role: 'Accounting · accounting.manage',
        to: { route: 'accounting-petty-cash', label: 'Accounting → Cash → Petty Cash' },
        body: `One fund per cash box, with a custodian and opening float. Record every <b>cash
          out</b> (disbursement) and <b>cash in</b> (replenishment); the table keeps a running
          balance. <b>Export</b> the register for the cash count.`,
      },
      {
        title: 'Read the dashboards',
        role: 'permission-gated',
        to: { route: 'analytics', label: 'Home → Reports' },
        body: `A fixed, at-a-glance snapshot — stock value, production, <b>payables aging</b>, sales,
          and the latest payroll period — with only the sections your role allows. Hit
          <b>Refresh</b> after entering new data.`,
      },
    ],
    gotchas: [
      `Closing a ledger <b>period</b> locks posting into its dates.`,
      `PH agencies have no direct filing API — every tax screen produces a worksheet / export you
       submit yourself.`,
      `13th-month pay isn't a payslip line — add a December payout to that month's 1601-C by hand.`,
    ],
  },

  /* ------------------------------------------------------ QC repair quick sheet */
  {
    id: 'qc-repair',
    title: 'QC repair / rework',
    icon: 'check',
    tagline: 'Quick reference — fail → disposition → parts → re-inspect',
    audience: 'QC/QA, production, warehouse',
    intro: `The short version of Production steps 6–7.`,
    steps: [
      {
        title: 'Fail → disposition',
        role: 'Inspector',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        body: `<i>scrap / dispose / recycle</i> = terminal (counts as scrapped). <b>repair</b> = the
          unit goes to rework and the job order stays open. QA can also <b>hold</b> it for review.
          Every fail needs an evidence photo of the unit.`,
      },
      {
        title: 'Raise parts requests',
        role: 'Production',
        to: { route: 'job-orders', label: 'Job order → Repair panel' },
        body: `<i>add</i> (a missing part) or <i>replace</i> (swap — the old part goes to its damage
          record). Add a fault reason (assembler / production / supplier / wear / other). The part
          is <b>held</b> for the request at once; you're notified as it moves.`,
      },
      {
        title: 'Parts clerk issues',
        role: 'Parts clerk · production.repairs',
        to: { route: 'repairs', label: 'Production → Repairs & Parts Requests' },
        body: `Issue from an approved location, scanning the exact part and quantity; reject needs a
          reason; a shortage can be escalated; another part or quantity needs a revision the
          requester approves. Issuing is the only point stock moves.`,
      },
      {
        title: 'Re-inspect',
        role: 'Inspector',
        to: { route: 'production-qc', label: 'Production → QC / QA' },
        body: `Allowed only once no request is still open. Pass → the unit resumes its stage flow;
          the final pass queues it for <b>Products In</b>, which is what actually posts it to
          stock.`,
      },
    ],
    gotchas: [],
  },
];

// Task-focused workflows complement the existing operational playbooks.
GUIDE_PIPELINES.push(
  { id: 'getting-started', title: 'Find your way around', icon: 'help', audience: 'Everyone', module: 'home', tagline: 'Find a feature, read its guide, and keep useful shortcuts nearby', intro: 'Start from the task you want to accomplish. Your menus and guides follow your role and enabled modules.', steps: [
    { title: 'Search for a screen', body: 'Type a feature name in Search Menu. Press Enter to open the first match; Escape closes the suggestions.', spot: '#menu-search', tip: 'Alt + Shift + G opens guides for your current screen or dialog.' },
    { title: 'Open contextual guidance', body: 'Use the Guide button in a screen, side panel, or dialog header. A dialog guide keeps the current draft open.', spot: '[data-guide-open]' },
    { title: 'Track work that matters', body: 'Notes support checklists and linked Scheduler tasks. Add a due time and reminder when you need to come back to something.', spot: '[data-tool="notes"]' },
  ], gotchas: ['Guides explain actions; they never save, approve, delete, or pay on your behalf.'] },
  { id: 'keyboard-tips', title: 'Keyboard shortcuts and navigation tips', icon: 'help', module: 'home', tagline: 'Hotkeys that work here, with their exact context', audience: 'Everyone', intro: 'Shortcuts help when you know where they apply. These are implemented in the app.', steps: [
    { title: 'Open a guide', body: '<kbd>Alt + Shift + G</kbd> opens guides for the current screen or dialog. Tab and Shift + Tab move between controls. Escape closes a tooltip or walkthrough before closing its parent dialog.' },
    { title: 'Find a screen', spot: '#menu-search', body: 'Type in Search Menu. Enter opens the first match; Escape closes suggestions.' },
    { title: 'Add checklist items', body: 'In Notes, Enter in the checklist item box adds the item without saving the entire note.' },
    { title: 'Work in the document editor', body: 'Inside the editor: Ctrl/Cmd + S saves; Ctrl/Cmd + Z undoes; Ctrl/Cmd + Y or Shift + Z redoes; Ctrl/Cmd + F opens Find. Ctrl/Cmd + plus, minus, and zero control zoom.', tip: 'These editor commands apply while editing a document. Ordinary dialogs have their own Save or Confirm buttons.' },
  ], gotchas: [] },
  { id: 'file-request', title: 'File an employee request', icon: 'calendar', module: 'hr', tagline: 'Leave, half-day, overtime, offset, and other requests', audience: 'Employees', intro: 'Submit a complete request and track its review.', steps: [
    { title: 'Choose a request type', to: { route: 'hr-requests', label: 'My HR' }, spot: '#myhr-new', nextSpot: '.modal-overlay [data-field], .modal-overlay .leave-date-picker', advanceOn: 'click', body: 'Open New request and choose the type you need.' },
    { title: 'Provide the details', body: 'Give a clear reason and complete the required fields. For leave, select a range, separate dates, or both. The preview counts scheduled working days only.', spot: '.modal-overlay:last-child .modal-body' },
    { title: 'Submit and track', body: 'Review the dates and details before submitting. A submitted request stays pending until an authorized approver decides it. Open it from My HR to inspect its status.', to: { route: 'hr-requests', label: 'My HR' }, spot: '#myhr-content', tip: 'Submitting a form is separate from approval. Warnings are advisory; read them before proceeding.' },
  ], gotchas: ['Only scheduled working days consume paid leave. An approved multi-day leave attaches to every selected covered date.'] },
  { id: 'review-requests', title: 'Review employee requests', icon: 'check', module: 'hr', tagline: 'Inspect details, warnings and authority before deciding', audience: 'Department approvers and HR', intro: 'Make informed decisions without missing the employee’s reason or date coverage.', steps: [
    { title: 'Open approvals', to: { route: 'hr-approvals', label: 'Approvals' }, spot: '#ap-search', body: 'Find the request in your approvals inbox. Your authority determines which decisions you can make.' },
    { title: 'Inspect the complete request', spot: '.modal-overlay:last-child .modal-body', body: 'Open the request. Review its reason, dates, existing attendance, balance and any overlap warnings. Ask for clarification when information is missing.' },
    { title: 'Record the decision', body: 'Approve or reject only when ready. Department approvers or HR may approve according to their authority. Read any balance override message before confirming.', tip: 'Approval is an explicit decision; a walkthrough never presses its confirmation button.' },
  ], gotchas: ['Overlapping requests warn rather than block. Approved paid leave must not charge the same date twice.'] },
  { id: 'build-form', title: 'Build a request form', icon: 'forms', module: 'hr', tagline: 'Name → fields → optional automation → review', audience: 'Form administrators', intro: 'Create a useful form without getting lost in its technical settings.', steps: [
    { title: 'Create a form', to: { route: 'form-builder', filter: { scope: 'hr' }, label: 'HR Form Builder' }, spot: '#fb-new-form', advanceOn: 'click', nextSpot: '#fb-name', body: 'Choose New Form or a Quick Add starting point.' },
    { title: 'Name the form', spot: '#fb-name', body: 'Use a name people recognize. The internal form ID is generated automatically. Advanced settings contain the ID, numbering prefix and icon.' },
    { title: 'Add useful fields', spot: '#fb-add-field', body: 'Add the information reviewers need, including a reason where appropriate. Choose each field’s type and whether it is required. Each key becomes a print-template variable.' },
    { title: 'Choose optional automation', spot: '.fb-actions summary', body: 'Expand Automated actions only if the form should notify someone, file information or trigger a follow-up. Check the action type and when it runs.' },
    { title: 'Review before creating', spot: '.modal-overlay:last-child [data-confirm]', body: 'Review fields and automation before choosing Create form. Saving is your action, not the guide’s.', tip: 'Question-mark icons provide detailed explanations without leaving this dialog.' },
  ], gotchas: ['Changing an existing form ID or field key can affect templates and workflows that refer to it.'] },
  { id: 'notes-scheduler', title: 'Turn a note into scheduled work', icon: 'note', module: 'home', tagline: 'Note → checklist → schedule → complete', audience: 'Everyone', intro: 'Keep personal notes, to-dos and reminders connected.', steps: [
    { title: 'Open Notes', spot: '[data-tool="notes"]', advanceOn: 'click', nextSpot: '#note-new', body: 'Choose Notes in the side toolbar.' },
    { title: 'Create a note or checklist', spot: '#note-new', advanceOn: 'click', nextSpot: '#note-title', body: 'Choose New note / checklist. Add text, checklist items, or both.', tip: 'Enter in the checklist item box adds an item rather than saving the note.' },
    { title: 'Schedule the note', spot: '#note-scheduled', body: 'Enable Schedule this note, choose its due date/time, and optionally set a reminder. Save when the details are correct.' },
    { title: 'Keep progress in sync', body: 'Completing all checklist items completes the linked task. Reopening the task leaves an item unfinished. Use View in Scheduler or Open linked note to move between them.', tip: 'Rescheduling updates the same task. Push delivery requires notifications enabled on your device.' },
  ], gotchas: ['Notes are private to your account. Deleting a note preserves the existing scheduled task and its captured context.'] },
  { id: 'document-editing', title: 'Create and edit a document', icon: 'file', module: 'home', tagline: 'Choose a document → edit → preview → save', audience: 'Document users', intro: 'Use the document editor without confusing editing, saving and issuing.', steps: [
    { title: 'Choose the document', to: { route: 'forms', label: 'Documents' }, body: 'Open or create the document you need. Your permissions determine what you can edit or issue.' },
    { title: 'Edit the content', spot: '.doc-editor', body: 'Enter content, insert fields and adjust the layout. Preview with a real record when working on a template.', tip: 'In the document editor: Ctrl/Cmd + S saves, Ctrl/Cmd + Z undoes, and Ctrl/Cmd + Y redoes.' },
    { title: 'Preview and save', body: 'Check page breaks, required information and output before saving or issuing. Saving an edit is separate from issuing a business record.', tip: 'Use the editor’s Find control for search. Editor shortcuts apply inside the editor, not every screen.' },
  ], gotchas: [] },
);

/* route (+ optional sub-tab hint) → pipeline id, so the per-screen Help drawer can
   offer "walk me through this". Screens not listed just link to the guide index. */
const GUIDE_ROUTE_MAP = {
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
  forRoute(route) {
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
