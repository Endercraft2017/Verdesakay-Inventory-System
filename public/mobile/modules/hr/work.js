/* Work Hub — Figma node 46:548.
   Work answers “what do I need to do now?” and exposes only permission-backed operations. */
(function () {
  // Explanations are attached only to rendered, permission-filtered Work entries.
  var WORK_HELP = {
  sales:['Follow customer sales through CSR review, warehouse preparation, releasing and completion.','Open the exact order to check stock, customer details and the next owner.','Commercial changes require their own permissions. Only the releasing workflow issues stock-out slips.'],
  customers:['Search customers and their recent sales.','Create or edit only with assigned sales permissions.','Customer registry changes do not move stock.'],
  'order-tracking':['Follow sales and customer job orders without commercial changes.','Review status, shortages and issued trips.','Read-only tracking does not allocate, authorize or release stock.'],
  notifications:['Review stored notices and their history.','Open a notice to follow its permitted current destination.','Live records and current permissions decide which actions remain available.'],
  'purchase-requests:new':['Request a purchase budget for tools, supplies or parts.','Enter freeform item names, quantities and expected prices. No SKU or supplier is required.','Approval authorizes spending; it does not close the PR or add stock.'],
  'purchase-requests:review':['Review internal purchase requests using PR approval authority.','Approve or reject budgets, assign a buyer, record physical cash and review receipts and actual spending.','Return liquidation for correction or close after recording exact change/reimbursement. Supplier-order management does not grant this authority.'],
  'purchase-requests:assigned':['Complete purchases assigned to you.','Upload camera photos or receipt files and enter what was actually bought, including extra items within the approved budget.','Only the assigned buyer submits liquidation. Submission needs receipts and authority review before closure; it adds no stock.'],
  "receive": [
    "Receive goods delivered against an existing supplier purchase order.",
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
    "Choose a job order and receive its final-passed units into ready-to-sell (RTS) stock.",
    "For pre-system units, enter a legacy intake with identifier, photo and location; both QC and QA must pass before stock entry. For eligible output, print, attach and scan each sticker and verify storage.",
    "Confirmed Products In adds finished stock. Capacity, duplicate and mismatch checks may block it. This is separate from Receive supplier delivery."
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
    "Choose the job order, then select its Ready/Reinspect unit card and match the production identifier and job order to the physical unit before checks. QR is optional before Products In; stop if identity is unclear. Failed/held decisions need evidence.",
    "QC and QA may run in either order. Only both required passes make a unit eligible for receiving. Repair or rejection has a separate disposition; a QC pass is not stock-in."
  ],
  "qc:qa": [
    "Perform the appearance/final QA pass for eligible units.",
    "Choose the job order, then select its Ready/Recheck unit card and confirm the production identifier and job order against the physical unit; no QR sticker is required yet. Review the recorded inspection results and complete appearance checks. QA can run before QC. Follow repair/hold evidence prompts.",
    "Both required QC and QA passes queue RTS recording; either desk may go first. An inspection never adds stock. Settle repair requests before rechecking returned units."

  ],
  "sales-service": [
    "Find and follow up a customer sale order by customer name or SO number.",
    "Search the live list and open the exact sale to review its lines, value, stage, and next owner.",
    "Customer-service review does not accept, pick, or release warehouse stock."
  ],
  "sales-new": [
    "Prepare a new customer sale order from the phone.",
    "Choose stock lines or products, select the build form for a finished product, set its selling price, and add separate fees when needed.",
    "Saving creates an open order for Sales review. It does not approve the sale or deduct stock."
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
    "Notes-list checklist ticks save immediately; wait for confirmation or retry feedback. Text/editor changes still need Save. Linked personal tasks stay connected; notes do not change business records."
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
  var STOCK_EFFECTS = {
    'purchase-requests:new':'No stock movement. This requests a spending budget.',
    'purchase-requests:review':'No stock movement. Financial approval and closure only.',
    'purchase-requests:assigned':'No stock movement. Supplier goods still need normal receiving.',
    receive:'Adds purchased stock when the supplier goods receipt is confirmed.',
    receiving:'Adds finished stock when Products In / RTS receipt is confirmed.',
    so:'Picking reserves goods; issuing the trip slip deducts its load.',
    'kit-release':'Picking holds components; issuing the parts slip deducts them.',
    allocate:'Direct sale deducts units immediately. A move changes their location.',
    repairs:'Issuing approved repair parts moves stock; viewing a request does not.',
    returns:'Return receipt alone adds no stock. Restock requires inspection.',
    'semi-finishing':'Removes one semi-built package; fully built stock returns only after inspection and receipt.',
    'stock-counts':'Count submission moves no stock. Review and reconciliation are separate.',
    'stock-count-tasks':'Assignment and submission move no stock; reconciliation completes the check.',
    'stock-move':'Confirmed stock-in/out changes quantity at the selected location.',
    transfer:'Changes location balances, not total stock.',
    damage:'Moves damaged quantity out of sellable stock.',
    deliveries:'Records delivery or carrier handoff; does not deduct stock again.',
    item:'Lookup only; no stock change.',
    'assign-qr':'Label association only; no stock change.'
  };
  function explain(row, key, title) {
    var help=WORK_HELP[key];
    if(!help) return;
    row.dataset.workGuide=''; row.dataset.workGuideTitle=title;
    if(STOCK_EFFECTS[key]) row.dataset.workGuideEffect=STOCK_EFFECTS[key];
    row.dataset.workGuidePurpose=help[0]; row.dataset.workGuideWhen=help[1]; row.dataset.workGuideResult=help[2];
  }
  function helpKey(op) {
    if(op.route==='purchase-requests')return 'purchase-requests:'+(op.params?.view||'new');
    if(op.route==='job-orders' && op.params?.view==='approval') return 'job-orders:approval';
    if(op.route==='qc') return 'qc:'+op.params.role+(op.params.tab==='hold'?':hold':'');
    return op.route;
  }

  var OPS = [
    { label: 'Receive supplier delivery', sub: 'Goods arriving against supplier orders', route: 'receive', permission: 'inventory.receive', count: function (read) { return openCount('/orders?type=purchase',read); } },
    { label: 'Release orders', sub: 'Allocated units ready for handoff', route: 'so', permission: 'orders.release',
      count: function (read) { return (read || API.get)('/release-slips/queue').then(function (q) {
        return (q.to_accept || []).length + (q.releasing || []).length;
      }); } },
    { label: 'Customer service', sub: 'Search and follow up sale orders', route: 'sales-service', all: ['orders.view'], any: ['orders.create','orders.edit'], action: true },
    { label: 'New sale order', sub: 'Prepare an open customer order', route: 'sales-new', all: ['orders.view','orders.create'], action: true },
    { label: 'Kit releases', sub: 'Pick and release job-order kits', route: 'kit-release', permission: 'production.kit_release',
      count: function (read) { return (read || API.get)('/job-orders?stage=awaiting_release').then(function (rows) { return (rows || []).length; }); } },
    { label: 'Allocate units', sub: 'Assign passed units to orders', route: 'allocate', any: ['inventory.transfer','orders.direct_sale'] },
    { label: 'Parts requests', sub: 'Issue parts for repair or rework', route: 'repairs', permission: 'production.repairs',
      count: function (read) { return (read || API.get)('/production/repairs?status=requested').then(function (r) { return (r || []).length; }); } },
    { label: 'RTS recording', sub: 'Record QA-passed finished goods', route: 'receiving', permission: 'production.receive',
      count: function (read) { return readyToReceive(read); } },
    { label: 'Awaiting production approval', sub: 'Review draft quantities, components and stock', route: 'job-orders', params: { view: 'approval' }, permission: 'production.approve',
      count: function (read) { return (read || API.get)('/job-orders?stage=awaiting_approval').then(function (rows) { return mProductionDrafts.approvalCount(rows || []); }); } },
    { label: 'Production job orders', sub: 'Accept kits and record active work', route: 'job-orders', permission: 'production.record',
      count: function (read) { return (read || API.get)('/job-orders').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'released' || x.status === 'in_progress'; }).length;
      }); } },
    { label: 'Saved unit issue reports', sub: 'Resume reports and their photos', route: 'unit-issues', any: ['production.inspect_qc', 'production.inspect_qa', 'production.record', 'production.manage'],
      count: function (read) { return mProductionDrafts.listActions('unit-issue', 'issue').then(function (saved) { return saved.length; }); } },
    { label: 'QC technical inspection', sub: 'Inspect units waiting for QC', route: 'qc', params: { role: 'qc' }, permission: 'production.inspect_qc',
      count: function (read) { return actionableInspection('qc',read); } },
    { label: 'QA appearance inspection', sub: 'Inspect units waiting for QA', route: 'qc', params: { role: 'qa' }, permission: 'production.inspect_qa',
      count: function (read) { return actionableInspection('qa',read); } },
    // Someone who decides QA holds without inspecting (production.qa_review, e.g. the Production Manager).
    { label: 'QA holds', sub: 'Decide units QA held for review', route: 'qc', params: { role: 'qa', tab: 'hold' }, any: ['production.qa_review','production.inspect_qa'],
      count: function (read) { return Promise.all([(read || API.get)('/qc/holds'), mProductionDrafts.listActions('hold-decision', 'hold')]).then(function (both) { return new Set(both[0].map(function (h) { return h.id; }).concat(both[1].map(function (a) { return a.id; }))).size; }); } },
    { label: 'Deliveries', sub: 'Field drops and proof of delivery', route: 'deliveries', any: ['delivery.run', 'delivery.manage'],
      count: function (read) { return (read || API.get)('/deliveries?mine=1').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'pending' || x.status === 'out_for_delivery'; }).length;
      }); } }
  ];

  OPS.push(
    {label:'Customer returns',sub:'Receive, inspect and track returned goods',route:'returns',any:['returns.receive','returns.inspect','returns.dispose','inventory.view','orders.release','orders.view','production.inspect_qc','production.inspect_qa']},
    {label:'Semi-built finishing',sub:'Send a complete semi-built package to finishing',route:'semi-finishing',any:['production.approve','production.manage']}
  );

  OPS.push({label:'My planned checks',sub:'Assigned physical counts and overdue shelves',route:'stock-count-tasks',permission:'inventory.count',count:function(read){return (read || API.get)('/inventory/stock-counts/tasks?status=open&mine=1').then(function(rows){return rows.length;});}});

  OPS.push(
    {label:'Make PR',sub:'Request a budget for any purchase',route:'purchase-requests',params:{step:'new'},permission:'purchasing.request',strict:true},
    {label:'Review PRs',sub:'Approve budgets, cash and liquidation',route:'purchase-requests',params:{view:'review'},any:['purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'],strict:true},
    {label:'My assigned purchases',sub:'Upload receipts and liquidate your purchases',route:'purchase-requests',params:{view:'assigned'},any:['purchasing.request','purchasing.manage'],strict:true}
  );

  OPS.push({label:'Sales pipeline',sub:'CSR review, customer follow-up and real order stages',route:'sales',all:['orders.view'],any:['orders.create','orders.edit']},
    {label:'Customers',sub:'Customer registry and recent sales',route:'customers',permission:'orders.view'},
    {label:'Order tracking',sub:'Read-only sales and warehouse progress',route:'order-tracking',permission:'orders.view'});

  var STOCK_TOOLS = [
    {label:'Physical stock counts',sub:'Scan an exact shelf and submit for review',route:'stock-counts',permission:'inventory.count'},
    {label:'Inventory stock',sub:'Search items, quantities and locations',route:'item',permission:'inventory.view'},
    {label:'Low stock',sub:'Items at or below their reorder point',route:'low-stock',permission:'inventory.view'},
    {label:'Stock movement history',sub:'Review the movements you recorded',route:'my-log',permission:'inventory.view'},
    {label:'Stock in / out',sub:'Record an authorized stock adjustment',route:'stock-move',permission:'inventory.adjust'},
    {label:'Transfer stock',sub:'Move stock between locations',route:'transfer',permission:'inventory.transfer'},
    {label:'Report stock damage',sub:'Record damaged stock with evidence',route:'damage',permission:'inventory.adjust'},
    {label:'Create inventory item',sub:'Add an item to the catalogue',route:'new-item',permission:'inventory.create'},
    {label:'Assign QR label',sub:'Link an item to its stock label',route:'assign-qr',permission:'inventory.adjust'}
  ];

  function openCount(path, read) {
    return (read || API.get)(path).then(function (rows) {
      return (rows || []).filter(function (x) {
        return ['cancelled', 'closed', 'completed'].indexOf(String(x.status).toLowerCase()) === -1;
      }).length;
    });
  }
  // Counted from the desk's own queue: a floor desk can't list every job order (shared/desk-access.ts).
  function actionableInspection(role, read) {
    return (read || API.get)('/qc/queue?role=' + role).then(function (q) { return ((q && q.units) || []).length; });
  }
  function readyToReceive(read) {
    return (read || API.get)('/rts/queue').then(function (q) {
      return mRtsRecovery.count(q);
    });
  }
  function allowed(op) {
    if (!MApp.canOpen(op.route)) return false;
    if (op.all && !op.all.every(function (p) { return MApp.can(p); })) return false;
    if (op.permission) return MApp.can(op.permission);
    if (op.any) return op.any.some(function (p) { return MApp.can(p); });
    return !!op.all;
  }
  function roleName() {
    var me = MApp.getMe() || {};
    return String(me.role_label || me.role || 'employee').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function opRow(op, scope, deferredCount) {
    var owner=mReadScope.identity();
    var row = mEl(
      '<button type="button" class="v2-work-row"><span><b>' + mEsc(op.label) + '</b>' +
      '<small>' + mEsc(op.sub) + '</small></span><em data-count>' + (op.action ? 'GO' : 'OPEN') + '</em>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    explain(row,helpKey(op),op.label);
    row.onclick = function () { if (row.isConnected && !row.closest('.hidden,[hidden]') && owner===mReadScope.identity() && (!scope || scope.current()) && allowed(op)) MApp.go(op.route, op.params); };
    if (op.count && !deferredCount) op.count().then(function (n) {
      var e = row.querySelector('[data-count]');
      if (e) e.textContent = n ? n + ' WAITING' : 'CLEAR';
    }).catch(function () {
      var e = row.querySelector('[data-count]'); if (e) e.textContent = 'UNKNOWN';
    });
    return row;
  }
  function commonTool(label, route, scope) {
    var owner=mReadScope.identity();
    var b = mEl('<button type="button" class="v2-work-tool">' + mEsc(label) + '</button>');
    explain(b,route,label);
    b.onclick = function () { if (b.isConnected && !b.closest('.hidden,[hidden]') && owner===mReadScope.identity() && (!scope || scope.current()) && MApp.canOpen(route)) MApp.go(route); };
    return b;
  }
  function mWorkQueue() {
    var wrap = mEl('<div class="v2-work-list"></div>');
    OPS.filter(allowed).forEach(function (op) { wrap.appendChild(opRow(op)); });
    return wrap;
  }
  window.mWorkQueue = mWorkQueue;

  // Live records, rather than push payloads, decide what can still be acted on.
  // A task link carries only a source and record id; details and actions recheck access.
  function attentionSources() {
    var sources=[];
    function add(key,title,route,permission,path,select,params){
      if(MApp.canOpen(route)&&permission.some(function(p){return MApp.can(p);}))sources.push({key:key,title:title,route:route,path:path,select:select||function(q){return q||[];},params:params||function(r){return {id:r.id};}});
    }
    if(MApp.canOpen('sales'))add('csr','Sales follow-up','sales',['orders.create','orders.edit'],'/orders?type=sale',function(q){return (q||[]).filter(function(r){return !['cancelled','completed','fulfilled'].includes(r.status)&&!(r.release_slip_number&&!r.backordered);});});
    add('release','Sales order releasing','so',['orders.release'],'/release-slips/queue',function(q){return (q.to_accept||[]).concat(q.releasing||[]);});
    add('kits','Production kit release','kit-release',['production.kit_release'],'/job-orders?stage=awaiting_release');
    add('parts','Parts request','repairs',['production.repairs'],'/production/repairs?status=requested');
    add('production','Production work','job-orders',['production.record'],'/job-orders',function(q){return (q||[]).filter(function(r){return ['released','in_progress'].indexOf(r.status)!==-1;});});
    add('approval','Production approval','job-orders',['production.approve'],'/job-orders?stage=awaiting_approval',null,function(r){return {id:r.id,view:'approval'};});
    ['qc','qa'].forEach(function(role){add(role,role.toUpperCase()+' inspection','qc',['production.inspect_'+role],'/qc/queue?role='+role,function(q){return q.units||[];},function(r){return {role:role,unit:r.id};});});
    add('holds','QA hold review','qc',['production.qa_review','production.inspect_qa'],'/qc/holds',null,function(r){return {role:'qa',unit:r.id,step:'hold'};});
    add('rts','RTS receiving','receiving',['production.receive'],'/rts/queue',function(q){return (q.units||[]).filter(function(r){return !r.hold;}).map(function(r){return Object.assign({},r,{work_kind:'unit'});}).concat((q.batches||[]).map(function(r){return Object.assign({},r,{work_kind:'batch'});}));},function(r){return r.work_kind==='batch'?{batch:r.id}:{unit:r.id};});
    add('delivery','Delivery','deliveries',['delivery.run','delivery.manage'],'/deliveries?mine=1',function(q){return (q||[]).filter(function(r){return ['pending','out_for_delivery'].indexOf(r.status)!==-1;});});
    add('pr','Purchase request','purchase-requests',['purchasing.request','purchasing.manage','purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'],'/purchasing/requests',function(q){var user=MApp.getMe()||{};return (q||[]).filter(function(r){
      return (r.status==='pending'&&MApp.can('purchasing.approve_requests')&&(r.requested_by!==user.id||user.role==='admin'))||
        (r.status==='approved'&&r.purchase_mode==='requester_cash'&&r.cash_issued==null&&MApp.can('purchasing.issue_cash'))||
        (r.status==='liquidation_submitted'&&MApp.can('purchasing.settle_requests')&&(r.buyer_id!==user.id||user.role==='admin'))||
        (r.status==='approved'&&r.buyer_id===user.id);
    });});
    add('notice','Unread update','notifications',['mobile.access'],'/notifications',function(q){return (q.items||[]).filter(function(n){var match=/^#\/([a-z-]+)/.exec(n.url||'');return !n.read_at&&(!match||MApp.canOpen(match[1]));}).map(function(n){return Object.assign({},n,{title:n.title,name:n.body});});});
    add('personal','Personal task','tasks',['mobile.access'],'/tasks',function(q){return (q||[]).filter(function(r){return !r.done;});});
    return sources;
  }
  function noticeTarget(url){
    var match=/^#\/([a-z-]+)(?:\?(.*))?$/.exec(url||'');if(!match||!MApp.canOpen(match[1]))return null;
    var params=new URLSearchParams(match[2]||''),route=match[1],key=route==='so'?'release':route==='purchase-requests'?'pr':route==='kit-release'?'kits':route==='repairs'?'parts':route==='deliveries'?'delivery':route==='qc'?(params.get('step')==='hold'?'holds':params.get('role')||'qc'):null;
    var id=params.get(route==='qc'?'unit':'id');return key&&/^\d+$/.test(id||'')?{task:key,record:'record:'+id}:null;
  }
  function attentionId(r){return (r.work_kind||'record')+':'+r.id;}
  function attentionTitle(r){return r.identifier||(r.work_kind==='batch'?(r.number||r.batch_number):null)||r.number||r.batch_number||r.title||r.job_order_number||'Record #'+r.id;}
  function attentionMeta(r,source){
    var state=r.status&&String(r.status).replace(/_/g,' ');
    if(source&&source.key==='kits')state=r.prepared_at?'Ready for kit release':r.warehouse_accepted_at?'Kit preparation':'Awaiting kit acceptance';
    else if(source&&source.key==='release')state=r.warehouse_accepted_at?'Picking / release':'Awaiting warehouse acceptance';
    return [r.work_kind==='batch'?r.remaining_qty+' pcs remaining':null,r.component_name?('Qty '+r.quantity+' · '+r.component_name):r.customer_name||r.product_name||r.reason||r.name,state,r.expected_date&&'Due '+r.expected_date].filter(Boolean).join(' · ');
  }
  function attentionRow(source,r,scope,personalDirect){
    var row=mEl('<button type="button" class="v2-work-row" data-attention="'+mEsc(source.key)+'"><span><b>'+mEsc(attentionTitle(r))+'</b><small>'+mEsc(source.title+' · '+(blockedInspection(source,r)?'Waiting for parts · ':'')+attentionMeta(r,source))+'</small></span><em>REVIEW ›</em></button>');
    var direct=personalDirect&&source.key==='personal';if(direct)explain(row,'personal-task',r.title);
    var owner=mReadScope.identity();row.onclick=function(){if(row.isConnected&&owner===mReadScope.identity()&&(!scope||scope.current())&&(direct||attentionSources().some(function(s){return s.key===source.key;}))){if(direct)MApp.go('tasks',{id:r.id});else MApp.go('work',{task:source.key,record:attentionId(r)});}};return row;
  }
  function workResponse(path, value) {
    var rows;
    if (path === '/release-slips/queue') {
      if (!value || !Array.isArray(value.to_accept) || !Array.isArray(value.releasing)) throw new Error('The releasing queue could not be verified.');
      rows=value.to_accept.concat(value.releasing);
    } else if (/^\/qc\/queue/.test(path)) rows=value?.units;
    else if (path === '/rts/queue') {
      if (!value || !Array.isArray(value.units) || !Array.isArray(value.batches)) throw new Error('The receiving queue could not be verified.');
      rows=value.units.concat(value.batches);
    } else if (path === '/notifications') rows=value?.items;
    else rows=value;
    if (!Array.isArray(rows) || rows.some(function(r){return !r || !Number.isInteger(Number(r.id)) || Number(r.id)<=0;})) throw new Error('The server returned an invalid queue. Refresh to check current work.');
    return value;
  }
  function workReader(scope) {
    var reads=new Map();
    return function(path) {
      if (!reads.has(path)) reads.set(path,scope.run(function(opts){return API.get(path,opts);}).then(function(value){return workResponse(path,value);}));
      return reads.get(path);
    };
  }
  function attentionDetail(view,params) {
    view.innerHTML='';var body=RoleUI.page(view,{role:'Work',title:'Attention item',subtitle:'Checking current status and assigned access'});
    var page=body.closest('.rk-page'),scope=mReadScope.create(page),record=null,source=null,busy=false,error='',status='';
    function subtitle(text){var el=page.querySelector('.rk-head>p');el.setAttribute('role','status');el.textContent=text;}
    function available(){return attentionSources().find(function(s){return s.key===params.task;});}
    function draw() {
      if(!scope.current())return;
      subtitle(busy?'Checking current status and assigned access':error?'Current record needs checking':record?'Latest record checked':'Current access checked');
      body.innerHTML=(record?RoleUI.jobHead({number:attentionTitle(record),name:source.title,meta:attentionMeta(record,source)})+
        RoleUI.note('info','Review this record, then open its workflow to see the actions your permissions allow. Stock and status change only when you confirm an action there.')+
        (blockedInspection(source,record)?RoleUI.note('warn','Waiting for parts: the warehouse must resolve the open request before reinspection.'):'')+
        (record.work_kind==='batch'?RoleUI.field('Batch quantity remaining',record.remaining_qty+' pcs'):'')+
        (record.component_name?RoleUI.field('Requested part',record.component_name+' · Qty '+record.quantity):'')+
        (record.job_order_number?RoleUI.field('Production job order',record.job_order_number):'')+
        (record.identifier?RoleUI.field('Unit',record.identifier):'')+
        (record.summary?RoleUI.field('Order contents',(record.summary.first_name||'')+' · '+record.summary.lines+' line(s)'):'')+
        (record.qty_ordered!=null?RoleUI.field('Outstanding / currently picked',record.qty_ordered+' / '+record.qty_released):'')+
        (record.authorization?RoleUI.field('Release authorization',record.authorization.state||record.authorization.status||'Review in workflow'):'')+
        (record.qc_result?RoleUI.field('QC result',record.qc_result.result||record.qc_result):'')+
        (record.qa_result?RoleUI.field('QA result',record.qa_result.result||record.qa_result):''):'')+
        (error?'<p class="work-feedback error" id="work-check-error" role="alert" tabindex="-1">'+mEsc(error)+'</p>':status?'<p class="work-feedback" role="status">'+mEsc(status)+'</p>':'')+
        (record?'<button type="button" class="rk-btn primary" id="work-open-action"'+(busy||error?' disabled':'')+'>'+(busy?'Checking access…':'Open '+mEsc(source.title))+'</button>':'')+
        (error?'<button type="button" class="rk-btn secondary" data-work-retry'+(busy?' disabled':'')+'>Try again</button>':'')+
        '<button type="button" class="rk-btn secondary" data-work-back>Back to Work</button>';
      body.querySelector('#work-open-action')?.addEventListener('click',function(){if(this.isConnected&&scope.current())check(true);});
      body.querySelector('[data-work-retry]')?.addEventListener('click',function(){if(this.isConnected&&scope.current())check(false);});
      body.querySelector('[data-work-back]').onclick=function(){if(this.isConnected&&scope.current())MApp.go('work');};
    }
    async function check(open) {
      if(busy||!scope.current())return;busy=true;error='';status='';draw();
      try {
        if(open)await scope.run(function(){return MApp.refreshAccess({required:true});});
        if(!scope.current())return;
        source=available();
        if(!source){record=null;status='This duty is no longer available with your current access.';return;}
        var rows=await readAttention(source,false,workReader(scope));
        if(!scope.current())return;
        // Access may have changed while the queue was loading.
        var current=available();if(!current){record=null;status='This duty is no longer available with your current access.';return;}
        record=rows.find(function(r){return attentionId(r)===params.record;})||null;
        if(!record){status='This item no longer needs attention in this queue. It may have been completed, reassigned or moved to another stage. Refresh Work for the latest items.';return;}
        status='Latest record and assigned access checked just now.';
        if(open){MApp.go(current.route,current.params(record));}
      } catch(e) {
        if(e.cancelled||!scope.current())return;
        if(e.status===401||e.status===403)record=null;
        error=(open?'Could not verify current work. Nothing was opened. ':'The current record could not be checked. ')+(e.message||'Reconnect and retry.');
      } finally {
        busy=false;if(scope.current()){draw();if(error)body.querySelector('[role=alert]')?.focus({preventScroll:true});}
      }
    }
    check(false);
  }
  function attentionFeed(page) {
    page.appendChild(mEl('<div class="v2-work-title"><h2>Needs my attention</h2><button type="button" class="rk-back" data-attention-refresh>Refresh</button></div>'));
    var host=mEl('<div class="v2-work-list" data-work-attention></div>');page.appendChild(host);return host;
  }
  function startWorkFeed(page,host,countRows,scope,personalDirect) {
    var groups=new Map(),running=false,poll;
    function group(source) {
      var g=groups.get(source.key);
      if(!g){g={source:source,rows:[],loaded:false,pending:true,error:'',el:mEl('<section class="work-desk" data-work-desk="'+mEsc(source.key)+'"></section>')};groups.set(source.key,g);host.appendChild(g.el);}
      return g;
    }
    function draw(g) {
      if(!scope.current())return;
      var state=g.pending?'Checking…':g.error?(g.loaded?'Last loaded · Not refreshed':'Count unknown'):'Checked just now';
      g.el.innerHTML='<div class="work-desk-heading"><h3>'+mEsc(g.source.title)+'</h3><span role="status">'+state+'</span></div>'+
        (g.error?'<p class="work-feedback error" role="status">'+mEsc(g.error)+' '+(g.loaded?'Showing last loaded records. Open an item to check its current status.':'Pending work could not be checked.')+'</p>':'')+
        (!g.loaded&&g.pending?'<p class="m-hint" role="status">Loading this queue…</p>':g.loaded&&!g.rows.length?'<p class="m-hint">No items waiting in this queue.</p>':'');
      g.rows.forEach(function(r){g.el.appendChild(attentionRow(g.source,r,scope,personalDirect));});
    }
    function count(entry,text){var label=entry.row.querySelector('[data-count]');if(label&&scope.current())label.textContent=text;}
    async function refresh() {
      if(running||!scope.current())return;scope.cancelTimer(poll);running=true;
      var button=page.querySelector('[data-attention-refresh]');button.disabled=true;button.textContent='Refreshing…';
      var sources=attentionSources();
      if(personalDirect&&!sources.some(function(s){return s.key==='personal';}))sources.push({key:'personal',title:'Personal task',route:'tasks',path:'/tasks',select:function(rows){return rows.filter(function(r){return !r.done;});}});
      var read=workReader(scope),keys=sources.map(function(s){return s.key;});
      groups.forEach(function(g,key){if(!keys.includes(key)){g.el.remove();groups.delete(key);}});
      if(!sources.length)host.innerHTML='<p class="v2-work-empty">No current queues are available with your assigned access.</p>';
      var jobs=sources.map(async function(source){
        var g=group(source);g.pending=true;g.error='';draw(g);
        try {
          var rows=await readAttention(source,false,read);if(!scope.current())return;
          if(!(personalDirect&&source.key==='personal')&&!attentionSources().some(function(s){return s.key===source.key;})){g.el.remove();groups.delete(source.key);return;}
          g.rows=rows;g.loaded=true;
        } catch(e) {
          if(e.cancelled||!scope.current())return;
          g.error=e.message||'Could not refresh this queue.';
          if(e.status===401||e.status===403){g.rows=[];g.loaded=false;}
        } finally {g.pending=false;draw(g);}
      });
      countRows.forEach(function(entry){
        if(!entry.op.count)return;count(entry,'CHECKING');
        jobs.push(scope.run(function(){return entry.op.count(read);}).then(function(n){
          if(!Number.isInteger(n)||n<0)throw new Error('Count unavailable');
          if(!allowed(entry.op)){entry.row.remove();return;}count(entry,n?n+' WAITING':'CLEAR');
        }).catch(function(){count(entry,'UNKNOWN');}));
      });
      await Promise.allSettled(jobs);
      if(!scope.current())return;running=false;button.disabled=false;button.textContent='Refresh';poll=scope.later(refresh,30000);
    }
    page.querySelector('[data-attention-refresh]').onclick=refresh;refresh();
  }

  // Reads are bounded and validated: a successful HTTP response is not proof of a valid queue.
  function readAttention(source, context, reader) {
    var strict=['kits','parts','qc','qa','holds','rts'].includes(source.key),timer;
    var request=Promise.resolve().then(function(){return (reader || API.get)(source.path);}).then(function(q){
      if(strict){
        var valid=source.key==='qc'||source.key==='qa'?q&&Array.isArray(q.units):source.key==='rts'?q&&Array.isArray(q.units)&&Array.isArray(q.batches):Array.isArray(q);
        if(!valid)throw new Error('The server returned an invalid queue. Refresh to check current work.');
        if(source.key==='rts'&&q.batches.some(function(b){return !Number.isFinite(Number(b.remaining_qty))||Number(b.remaining_qty)<=0;}))throw new Error('The batch quantities could not be verified.');
      }
      var rows=source.select(q);
      if(strict&&(!Array.isArray(rows)||rows.some(function(r){return !r||!Number.isInteger(Number(r.id))||Number(r.id)<=0;})))throw new Error('The queue records could not be verified.');
      return context?{rows:rows,held:source.key==='rts'?q.units.filter(function(u){return !!u.hold;}).length:0}:rows;
    });
    if(!strict)return request;
    return Promise.race([request,new Promise(function(resolve,reject){timer=setTimeout(function(){reject(new Error('Queue check timed out. Reconnect and refresh.'));},12000);})]).finally(function(){clearTimeout(timer);});
  }
  function blockedInspection(source,r){return ['qc','qa'].includes(source.key)&&r.status==='rework'&&Number(r.open_part_requests)>0;}
  function homeCount(source,rows){
    function amount(n,word){return n+' '+word+(n===1?'':word==='batch'?'es':'s');}
    if(source.key==='rts'){
      var batches=rows.filter(function(r){return r.work_kind==='batch';}),units=rows.length-batches.length;
      return (units||!batches.length?amount(units,'unit'):'')+(units&&batches.length?' · ':'')+(batches.length?amount(batches.length,'batch')+' ('+batches.reduce(function(sum,b){return sum+Number(b.remaining_qty);},0)+' pcs)':'');
    }
    var count=amount(rows.length,source.key==='kits'?'job':source.key==='parts'?'request':source.key==='holds'?'held unit':'unit');
    var blocked=rows.filter(function(r){return blockedInspection(source,r);}).length;
    return count+(blocked?' · '+blocked+' blocked':'');
  }
  // Home and Work share selectors and exact-record links, but each Home desk resolves independently.
  window.mHomeWorkPreview = function(page) {
    var keys=['kits','parts','qc','qa','holds','rts'],params={qc:{role:'qc'},qa:{role:'qa'},holds:{role:'qa',tab:'hold'}};
    function sources(){return attentionSources().filter(function(s){return keys.includes(s.key);});}
    if(!sources().length)return;
    var owner=(MApp.getMe()||{}).id,run=0,timer;
    var section=mEl('<section class="v2-home-work" aria-label="Pending work"><div class="v2-work-title"><h2>Pending work</h2><button type="button" class="rk-back" data-home-work-refresh>Refresh</button></div><div data-home-work-list aria-live="polite"></div></section>');
    page.appendChild(section);
    function current(){return section.isConnected&&(MApp.getMe()||{}).id===owner;}
    async function refresh(){
      clearTimeout(timer);if(!current())return;MApp.refreshAccess();var token=++run,desks=sources(),host=section.querySelector('[data-home-work-list]');
      if(!desks.length){section.remove();return;}host.innerHTML='';
      await Promise.all(desks.map(async function(source){
        var group=mEl('<section class="v2-home-work-desk" data-home-work="'+mEsc(source.key)+'"><div class="v2-home-work-summary"><h3>'+mEsc(source.title)+'</h3><span data-home-work-count>Loading…</span></div><div data-preview-records></div></section>');host.appendChild(group);
        function active(){return current()&&token===run&&group.isConnected;}
        try{
          var result=await readAttention(source,true);if(!active())return;
          if(!sources().some(function(s){return s.key===source.key;})){group.remove();return;}
          group.querySelector('[data-home-work-count]').textContent=homeCount(source,result.rows);
          var records=group.querySelector('[data-preview-records]');
          if(!result.rows.length)records.appendChild(mEl('<p class="m-hint">'+(source.key==='rts'?'No units or batches ready for receiving.':'No pending work in this queue.')+'</p>'));
          result.rows.slice(0,2).forEach(function(record){records.appendChild(attentionRow(source,record));});
          if(result.held){var held=mEl('<button type="button" class="rk-back">'+result.held+' unit'+(result.held===1?'':'s')+' on hold · View RTS issues</button>');held.onclick=function(){if(sources().some(function(s){return s.key==='rts';}))MApp.go('receiving',{tab:'issues'});else MApp.render();};records.appendChild(held);}
        }catch(e){if(!active())return;group.querySelector('[data-home-work-count]').textContent='Unknown';group.querySelector('[data-preview-records]').innerHTML='<p class="m-hint" role="status">Queue unavailable. Reconnect and refresh; pending work could not be checked.</p>';}
        if(!active())return;
        var open=mEl('<button type="button" class="v2-home-secondary">View '+mEsc(source.title)+' queue</button>');
        open.onclick=function(){if(!sources().some(function(s){return s.key===source.key;})){MApp.render();return;}MApp.go(source.route,params[source.key]||{});};group.appendChild(open);
      }));
      if(current()&&token===run)timer=setTimeout(refresh,30000);
    }
    section.querySelector('[data-home-work-refresh]').onclick=refresh;
    setTimeout(refresh,0);
    return section;
  };

  MApp.route('work', function (view,params) {
    if(params&&params.notice){var target=noticeTarget(params.notice);if(target)return attentionDetail(view,target);var route=/^#\/([a-z-]+)/.exec(params.notice);if(route&&route[1]!=='work'&&MApp.canOpen(route[1])){location.hash=params.notice;return;}view.innerHTML='';var unavailable=RoleUI.page(view,{role:'Work',title:'Update unavailable',subtitle:'Current access checked'});unavailable.innerHTML=RoleUI.note('info','This update has no current action with your assigned access. Open Notifications for its history.')+RoleUI.actions([{id:'work-notice-back',label:'Back to Work',kind:'secondary'}]);unavailable.querySelector('#work-notice-back').onclick=function(){MApp.go('work');};return;}
    if(params&&params.task)return attentionDetail(view,params);
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

    var feed=attentionFeed(page);
    var taskHead = mEl('<div class="v2-work-title"><h2>' + (ops.length ? 'My authorized queues' : 'My personal work') + '</h2><span>' + (ops.length ? ops.length + ' authorized queue' + (ops.length === 1 ? '' : 's') : 'Today') + '</span></div>');
    page.appendChild(taskHead);
    var list = mEl('<div class="v2-work-list"></div>');
    page.appendChild(list);
    var countRows=[];
    if (ops.length) ops.forEach(function(op){var row=opRow(op,null,true);list.appendChild(row);countRows.push({op:op,row:row});});
    else list.innerHTML='<p class="m-hint">Open a personal task above, or use Tasks &amp; reminders below.</p>';
    var notices=commonTool('Notifications & history','notifications');notices.classList.add('v2-work-wide-tool');page.appendChild(notices);

    var blocker = mEl(
      '<button type="button" class="v2-work-row blocker"><span><b>Report a blocker</b>' +
      '<small>Missing part, defect or safety issue</small></span>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    explain(blocker,'report-problem','Report a blocker');
    blocker.onclick = function () { if (blocker.isConnected && scope.current()) MApp.go('report-problem'); };
    page.appendChild(blocker);
    if(stockTools.length){
      page.appendChild(mEl('<div class="v2-work-title"><h2>Inventory tools</h2><span>From your assigned access</span></div>'));
      var stockList=mEl('<div class="v2-work-list"></div>');stockTools.forEach(function(op){stockList.appendChild(opRow(op,null,true));});page.appendChild(stockList);
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
    var scope=mReadScope.create(page);
    startWorkFeed(page,feed,countRows,scope,!ops.length);
    MApp.refreshAccess();
  });
})();
