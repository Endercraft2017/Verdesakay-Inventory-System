/* Work Hub — Figma node 46:548.
   Work answers “what do I need to do now?” and exposes only permission-backed operations. */
(function () {
  // Explanations are attached only to rendered, permission-filtered Work entries.
  var WORK_HELP = {
  "receive": [
    "Receive items delivered against a supplier purchase request/order. PR means purchase request here.",
    "Use when purchased goods physically arrive. Check the order, actual quantities and destination. This is not receipt of goods built by Production.",
    "A confirmed supplier goods receipt adds purchased stock. It does not approve the vendor bill or pay the supplier; those are later purchasing/accounting steps."
  ],
  "so": [
    "Prepare and hand over goods for an approved customer sales order.",
    "Use after Sales approves and authorizes release. Warehouse accepts, selects exact sale lines/build states and scans or enters the actual load.",
    "Picking holds stock; the issued trip slip records stock-out. Later loads stay on the same SO. This is different from releasing production parts."
  ],
  "kit-release": [
    "Hand BOM components from warehouse to a production job.",
    "Use for an approved job: accept it, pick the kit and review source stock. Partial picks may be saved.",
    "Picking holds components. Release & issue slip deducts them; Production must then count and accept the kit. This does not ship customer goods."
  ],
  "allocate": [
    "Select exact in-stock finished units for a direct sale or a location move.",
    "Use only when you intend the direct stock-out or move shown on that screen. Check the product, build state, source and exact sales line.",
    "A direct sale removes stock immediately and still needs a numbered trip slip. This is not the reserve-only picking step in Release orders."
  ],
  "repairs": [
    "Issue extra or replacement parts for repair/rework requests.",
    "Review the approved part, quantity and storage source. Escalate shortages; a different part or quantity requires an approved revision.",
    "Issuing moves the parts. Settle requests before reinspection; issuing a part does not itself pass the unit or receive finished goods."
  ],
  "receiving": [
    "Receive final-passed production output into ready-to-sell (RTS) stock.",
    "Use after required QC/QA has passed, or for eligible no-inspection output. Verify the exact units/batch quantities and storage location.",
    "Confirmed Products In adds finished stock. Capacity, duplicate and mismatch checks may block it. This is not Receive PR for supplier deliveries."
  ],
  "job-orders:approval": [
    "Approve a production plan before warehouse release.",
    "Review product, quantity, components, locations, schedule and stock warnings. Approval requires its own authority.",
    "Approval allows the warehouse kit workflow; it does not issue parts, record production or add finished stock."
  ],
  "job-orders": [
    "Accept a released parts kit and record production output.",
    "Count the kit before accepting it. Record serialized units with identifier and photo, or use the supported batch quantity controls.",
    "Output continues to configured QC/QA or receiving. Recording output does not make it sellable stock. Recover saved attempts after an unknown response."
  ],
  "unit-issues": [
    "Resume saved findings and their photos for a production unit.",
    "Use to finish an interrupted report or review/edit/resolve permitted findings. Check which unit and issue the saved work belongs to.",
    "An issue report preserves evidence; it does not itself change inspection disposition, pause production or move stock."
  ],
  "qc:qc": [
    "Perform the technical QC pass for units at your authorized stage.",
    "Open the waiting unit, verify its identity and complete required checks. Failed/held decisions need evidence.",
    "Pass advances to QA when required, otherwise to receiving. Repair or rejection has a separate disposition; a QC pass is not stock-in."
  ],
  "qc:qa": [
    "Perform the appearance/final QA pass for eligible units.",
    "Review the unit, earlier QC result and required appearance checks. Follow the repair/hold evidence prompts.",
    "A final pass queues RTS recording; it does not add stock. Settle repair requests before rechecking returned units."
  ],
  "qc:qa:hold": [
    "Decide the outcome of units QA placed on hold.",
    "Review the held unit, evidence and reason using your QA-review authority. Record the authorized decision and reason.",
    "The decision returns it to the appropriate quality/repair/receiving flow. A held unit is not ready-to-sell stock."
  ],
  "deliveries": [
    "Handle a booked own-driver trip or courier pickup for a specific release slip.",
    "Check your assigned booking and its actual manifest. Use the driver delivery or courier pickup action that matches the booking.",
    "Driver delivery records recipient handoff; courier pickup records carrier custody, not customer receipt. Neither deducts stock a second time."
  ],
  "returns": [
    "Receive, inspect or follow up customer goods tied to their original trip slip.",
    "Open the correct shipped slip/serial and use only the receipt, inspection or repair actions your account offers.",
    "A return receipt records custody, not stock-in or refund. Inspection/restock, rejected-goods repair and Finance credit are separate steps."
  ],
  "semi-finishing": [
    "Finish one complete semi-built RTS package into a fully built unit.",
    "Select the eligible source package, confirm its loose parts and supply the required identifier/photo.",
    "The same package goes through inspection and RTS receiving. Do not pick BOM components or Add unit again for this conversion."
  ],
  "stock-count-tasks": [
    "Carry out physical stock checks assigned to you.",
    "Open an assignment, visit its exact item/location/build state and record the observation. Check due and overdue dates.",
    "Submitting is not completion: independent review and applied correction/verification finish the task. Rejected counts need a fresh observation."
  ],
  "stock-counts": [
    "Record physically present stock at an exact location and build state.",
    "Count the displayed untracked quantity, batches and serial labels against the current snapshot. Recount if the book snapshot changes.",
    "Submission is evidence and does not adjust stock. A different authorized person reviews it before reconciliation."
  ],
  "item": [
    "Look up inventory quantities and their storage locations.",
    "Use to identify the item and inspect its available details before choosing a separate stock action.",
    "Looking up an item changes no stock. Viewing access does not grant adjustment permission."
  ],
  "low-stock": [
    "Find items at or below their configured reorder level.",
    "Review the shortage and exact location before coordinating replenishment.",
    "The list identifies a replenishment need; opening it does not purchase, receive or create stock."
  ],
  "my-log": [
    "Review inventory movements recorded under your account.",
    "Use to check what changed, where, when and why after a stock action.",
    "This is history, not a way to edit or reverse a physical movement."
  ],
  "stock-move": [
    "Record an authorized stock-in or stock-out adjustment.",
    "Use only for an intentional movement with the exact item, build state, location, quantity and reason. Use the dedicated order/production flows for those handoffs.",
    "Confirmation changes stock. For a book-versus-physical discrepancy use Physical stock counts and review instead of hiding the difference with an adjustment."
  ],
  "transfer": [
    "Move existing stock between exact storage locations.",
    "Select source, destination, build state and the exact tracked units/batches where required.",
    "Location balances change, not total stock. A parent location does not automatically own its child locations’ stock."
  ],
  "damage": [
    "Record stock that is physically damaged.",
    "Identify the item, quantity, location and reason; follow the screen’s evidence prompts.",
    "The damage action affects sellable stock. Reporting a blocker or unit issue is a different informational action."
  ],
  "new-item": [
    "Add a new catalogue item.",
    "Check the item code, name, unit and required fields; avoid creating a duplicate of an existing item.",
    "A saved item creates the catalogue record. Later stock changes must use authorized stock workflows."
  ],
  "assign-qr": [
    "Associate a stock label with the correct inventory item.",
    "Verify the physical label and selected item before saving the association.",
    "The label helps future identification; assigning it does not receive or move stock."
  ],
  "report-problem": [
    "Tell the responsible person about a blocker, defect or safety concern.",
    "Include what happened, the affected job/item and the action needed. Use the tracked production issue flow where appropriate.",
    "Sending a report does not issue parts, stop production or fix stock. Follow the operational action needed to resolve it."
  ],
  "personal-task": [
    "Open the personal task shown in your Work list.",
    "Read its deadline, reminder and any linked note/checklist in Tasks & reminders.",
    "Completing this task updates personal work tracking; it does not post an operational stock or payroll action."
  ],
  "tasks": [
    "Manage your personal to-dos, deadlines and reminders.",
    "Open a task to inspect its schedule or linked note, then complete or reopen it when appropriate.",
    "These tasks are shared with the webapp’s Tasks & reminders. They are separate from operational queue counts."
  ],
  "notes": [
    "Keep private notes/checklists and optionally schedule them.",
    "Open a note, edit its text or checklist, and explicitly save changes.",
    "Saved checklist progress and linked tasks stay connected; notes do not change business records."
  ],
  "guides": [
    "Read the connected workflow library across modules.",
    "Use when you need the wider sequence before or after one of your tasks.",
    "This Work Guide explains only what is displayed for your account; the library provides the broader process. Reading never submits work."
  ],
  "schedule": [
    "Review your employee shift and work schedule.",
    "Compare planned dates with your actual attendance and use the appropriate employee request/correction if needed.",
    "Viewing a schedule does not clock you in or change payroll attendance."
  ],
  "announcements": [
    "Read company notices shared with staff.",
    "Open the notice and review its date and instructions.",
    "Reading a notice does not create or complete an operational task."
  ],
  "confidential-reports": [
    "Review anonymous report cases your account is authorized to handle.",
    "Open the case and follow its permitted response, assignment and status actions.",
    "Only authorized case handling changes the report; confidentiality and case access still apply."
  ],
  "approvals": [
    "Review employee requests awaiting your approval authority.",
    "Read the request’s dates, reason and supporting details before deciding.",
    "Your saved decision affects that request’s approval process; opening the inbox does not approve anything."
  ]
};
  function explain(row, key, title) {
    var help=WORK_HELP[key];
    if(!help) return;
    row.dataset.workGuide=''; row.dataset.workGuideTitle=title;
    row.dataset.workGuidePurpose=help[0]; row.dataset.workGuideWhen=help[1]; row.dataset.workGuideResult=help[2];
  }
  function helpKey(op) {
    if(op.route==='job-orders' && op.params?.view==='approval') return 'job-orders:approval';
    if(op.route==='qc') return 'qc:'+op.params.role+(op.params.tab==='hold'?':hold':'');
    return op.route;
  }

  var OPS = [
    { label: 'Receive PR', sub: 'Purchase requests', route: 'receive', permission: 'inventory.adjust', count: function () { return openCount('/orders?type=purchase'); } },
    { label: 'Release orders', sub: 'Allocated units ready for handoff', route: 'so', any: ['orders.release','inventory.adjust'],
      count: function () { return API.get('/orders?type=sale').then(function (rows) {
        return (rows || []).filter(function (x) { return ['approved', 'released'].indexOf(String(x.status).toLowerCase()) !== -1; }).length;
      }); } },
    { label: 'Kit releases', sub: 'Pick and release job-order kits', route: 'kit-release', permission: 'inventory.adjust',
      count: function () { return API.get('/job-orders?stage=awaiting_release').then(function (rows) { return (rows || []).length; }); } },
    { label: 'Allocate units', sub: 'Assign passed units to orders', route: 'allocate', permission: 'inventory.adjust' },
    { label: 'Parts requests', sub: 'Issue parts for repair or rework', route: 'repairs', permission: 'production.repairs',
      count: function () { return API.get('/production/repairs?status=requested').then(function (r) { return (r || []).length; }); } },
    { label: 'RTS recording', sub: 'Record QA-passed finished goods', route: 'receiving', permission: 'production.receive',
      count: function () { return readyToReceive(); } },
    { label: 'Awaiting production approval', sub: 'Review draft quantities, components and stock', route: 'job-orders', params: { view: 'approval' }, permission: 'production.approve',
      count: function () { return API.get('/job-orders?stage=awaiting_approval').then(function (rows) { return mProductionDrafts.approvalCount(rows || []); }); } },
    { label: 'Production job orders', sub: 'Accept kits and record active work', route: 'job-orders', permission: 'production.record',
      count: function () { return API.get('/job-orders').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'released' || x.status === 'in_progress'; }).length;
      }); } },
    { label: 'Saved unit issue reports', sub: 'Resume reports and their photos', route: 'unit-issues', any: ['production.inspect_qc', 'production.inspect_qa', 'production.record', 'production.manage'],
      count: function () { return mProductionDrafts.listActions('unit-issue', 'issue').then(function (saved) { return saved.length; }); } },
    { label: 'QC technical inspection', sub: 'Inspect units waiting for QC', route: 'qc', params: { role: 'qc' }, permission: 'production.inspect_qc',
      count: function () { return actionableInspection('qc'); } },
    { label: 'QA appearance inspection', sub: 'Inspect units waiting for QA', route: 'qc', params: { role: 'qa' }, permission: 'production.inspect_qa',
      count: function () { return actionableInspection('qa'); } },
    // Someone who decides QA holds without inspecting (production.qa_review, e.g. the Production Manager).
    { label: 'QA holds', sub: 'Decide units QA held for review', route: 'qc', params: { role: 'qa', tab: 'hold' }, permission: 'production.qa_review',
      count: function () { return Promise.all([API.get('/qc/holds'), mProductionDrafts.listActions('hold-decision', 'hold')]).then(function (both) { return new Set(both[0].map(function (h) { return h.id; }).concat(both[1].map(function (a) { return a.id; }))).size; }); } },
    { label: 'Deliveries', sub: 'Field drops and proof of delivery', route: 'deliveries', any: ['delivery.run', 'delivery.manage'],
      count: function () { return API.get('/deliveries?mine=1').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'pending' || x.status === 'out_for_delivery'; }).length;
      }); } }
  ];

  OPS.push(
    {label:'Customer returns',sub:'Receive, inspect and track returned goods',route:'returns',any:['inventory.view','inventory.adjust','orders.release','orders.view','production.inspect_qc','production.inspect_qa']},
    {label:'Semi-built finishing',sub:'Send a complete semi-built package to finishing',route:'semi-finishing',any:['production.approve','production.manage']}
  );

  OPS.push({label:'My planned checks',sub:'Assigned physical counts and overdue shelves',route:'stock-count-tasks',permission:'inventory.view',count:function(){return API.get('/inventory/stock-counts/tasks?status=open&mine=1').then(function(rows){return rows.length;});}});

  var STOCK_TOOLS = [
    {label:'Physical stock counts',sub:'Scan an exact shelf and submit for review',route:'stock-counts',permission:'inventory.view'},
    {label:'Inventory stock',sub:'Search items, quantities and locations',route:'item',permission:'inventory.view'},
    {label:'Low stock',sub:'Items at or below their reorder point',route:'low-stock',permission:'inventory.view'},
    {label:'Stock movement history',sub:'Review the movements you recorded',route:'my-log',permission:'inventory.view'},
    {label:'Stock in / out',sub:'Record an authorized stock adjustment',route:'stock-move',permission:'inventory.adjust'},
    {label:'Transfer stock',sub:'Move stock between locations',route:'transfer',permission:'inventory.adjust'},
    {label:'Report stock damage',sub:'Record damaged stock with evidence',route:'damage',permission:'inventory.adjust'},
    {label:'Create inventory item',sub:'Add an item to the catalogue',route:'new-item',permission:'inventory.create'},
    {label:'Assign QR label',sub:'Link an item to its stock label',route:'assign-qr',permission:'inventory.adjust'}
  ];

  function openCount(path) {
    return API.get(path).then(function (rows) {
      return (rows || []).filter(function (x) {
        return ['cancelled', 'closed', 'completed'].indexOf(String(x.status).toLowerCase()) === -1;
      }).length;
    });
  }
  // Counted from the desk's own queue: a floor desk can't list every job order (shared/desk-access.ts).
  function actionableInspection(role) {
    return API.get('/qc/queue?role=' + role).then(function (q) { return ((q && q.units) || []).length; });
  }
  function readyToReceive() {
    return API.get('/rts/queue').then(function (q) {
      return mRtsRecovery.count(q);
    });
  }
  function allowed(op) {
    if (!MApp.canOpen(op.route)) return false;
    if (MApp.can('inventory.adjust') && op.permission !== 'orders.release' && op.permission !== 'production.approve') return true;
    if (op.permission && MApp.can(op.permission)) return true;
    return op.any && op.any.some(function (p) { return MApp.can(p); });
  }
  function roleName() {
    var me = MApp.getMe() || {};
    return String(me.role_label || me.role || 'employee').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function opRow(op) {
    var row = mEl(
      '<button type="button" class="v2-work-row"><span><b>' + mEsc(op.label) + '</b>' +
      '<small>' + mEsc(op.sub) + '</small></span><em data-count>OPEN</em>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    explain(row,helpKey(op),op.label);
    row.onclick = function () { MApp.go(op.route, op.params); };
    if (op.count) op.count().then(function (n) {
      var e = row.querySelector('[data-count]');
      if (e) e.textContent = n ? n + ' WAITING' : 'CLEAR';
    }).catch(function () {
      var e = row.querySelector('[data-count]'); if (e) e.textContent = 'OPEN';
    });
    return row;
  }
  function commonTool(label, route) {
    var b = mEl('<button type="button" class="v2-work-tool">' + mEsc(label) + '</button>');
    explain(b,route,label);
    b.onclick = function () { MApp.go(route); };
    return b;
  }
  function employeeTasks(host) {
    API.get('/tasks').then(function (rows) {
      var open = (rows || []).filter(function (x) { return !x.done; }).slice(0, 3);
      host.innerHTML = '';
      if (!open.length) {
        host.appendChild(mEl('<div class="v2-work-empty">No personal tasks waiting.</div>'));
        return;
      }
      open.forEach(function (x) {
        var r = mEl(
          '<button type="button" class="v2-work-row"><span><b>' + mEsc(x.title) + '</b>' +
          '<small>' + mEsc(x.due_date ? 'Due ' + x.due_date : 'No due date') + '</small></span>' +
          '<em>TO DO</em><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
        );
        explain(r,'personal-task',x.title);
        r.onclick = function () { MApp.go('tasks', { id: x.id }); };
        host.appendChild(r);
      });
    }).catch(function () { host.innerHTML = '<div class="v2-work-empty">Tasks are unavailable offline.</div>'; });
  }

  function mWorkQueue() {
    var wrap = mEl('<div class="v2-work-list"></div>');
    OPS.filter(allowed).forEach(function (op) { wrap.appendChild(opRow(op)); });
    return wrap;
  }
  window.mWorkQueue = mWorkQueue;

  MApp.route('work', function (view,params) {
    MApp.setTitle('Work');
    var me = MApp.getMe() || {};
    var ops = OPS.filter(allowed), stockTools = STOCK_TOOLS.filter(function(op){return MApp.canOpen(op.route)&&MApp.can(op.permission);});
    view.innerHTML = '';
    var page = mEl('<section class="v2-work" data-figma-node="46:548"></section>');
    page.appendChild(mEl('<header class="v2-work-heading"><h1>Work</h1><p>What do I need to do now?</p></header>'));
    page.appendChild(mEl(
      '<section class="v2-work-assignment"><span>CURRENT WORK CONTEXT</span><strong>' +
      mEsc(roleName()) + (me.department_name ? ' · ' + mEsc(me.department_name) : '') +
      '</strong><p>' + (ops.length ? mEsc(ops[0].sub) : 'Personal tasks and employee services') + '</p></section>'
    ));

    var taskHead = mEl('<div class="v2-work-title"><h2>My tasks</h2><span>' + (ops.length ? ops.length + ' authorized queue' + (ops.length === 1 ? '' : 's') : 'Today') + '</span></div>');
    page.appendChild(taskHead);
    var list = mEl('<div class="v2-work-list"></div>');
    page.appendChild(list);
    if (ops.length) ops.forEach(function (op) { list.appendChild(opRow(op)); });
    else employeeTasks(list);

    var blocker = mEl(
      '<button type="button" class="v2-work-row blocker"><span><b>Report a blocker</b>' +
      '<small>Missing part, defect or safety issue</small></span>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    explain(blocker,'report-problem','Report a blocker');
    blocker.onclick = function () { MApp.go('report-problem'); };
    page.appendChild(blocker);
    if(stockTools.length){
      page.appendChild(mEl('<div class="v2-work-title"><h2>Inventory tools</h2><span>From your assigned access</span></div>'));
      var stockList=mEl('<div class="v2-work-list"></div>');stockTools.forEach(function(op){stockList.appendChild(opRow(op));});page.appendChild(stockList);
    }

    page.appendChild(mEl('<div class="v2-work-title tools"><h2>My tools</h2></div>'));
    var tools = mEl('<div class="v2-work-tools"></div>');
    tools.appendChild(commonTool('Tasks & reminders', 'tasks'));
    tools.appendChild(commonTool('Notes / checklists', 'notes'));
    tools.appendChild(commonTool('Guides', 'guides'));
    tools.appendChild(commonTool('Schedule', 'schedule'));
    tools.appendChild(commonTool('Announcements', 'announcements'));
    // Case handlers for the anonymous channel (HR/admin by default).
    if (MApp.can('reports.confidential')) tools.appendChild(commonTool('Anonymous reports', 'confidential-reports'));
    page.appendChild(tools);

    if (MApp.canApprove()) {
      var approve = commonTool('Approvals', 'approvals');
      approve.classList.add('v2-work-wide-tool');
      page.appendChild(approve);
    }
    view.appendChild(page);
    MApp.refreshAccess();
  });
})();
