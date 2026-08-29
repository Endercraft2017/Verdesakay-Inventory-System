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
        consumption takes care of itself.</p>`,
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
      id: 'orders', title: 'Sale / Job / Purchase orders', group: 'Orders',
      routes: ['orders'], html: `
        <p>Three document types share one screen, filtered by tab:</p>
        <ul>
          <li><b>Sale Orders</b> — what a customer is buying.</li>
          <li><b>Job Orders</b> — work to be performed (can link to a production Job Order).</li>
          <li><b>Purchase Requests</b> — what you're buying from a supplier.</li>
        </ul>
        <p>Numbers (SO-#####, JO-#####, PR-#####) are assigned automatically. Totals and
        tax are computed for you. Use <b>Templates</b> to control how the printed
        document looks.</p>`,
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
