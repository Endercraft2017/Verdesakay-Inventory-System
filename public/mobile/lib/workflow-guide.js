/* Authored workflow references + permission-aware phone destinations. No business writes. */
(function(){
  var groups=[['production','Production'],['hr','HR'],['sales','Sales'],['inventory','Inventory'],['purchasing','Purchasing'],['accounting','Accounting'],['personal','My work']];
  var byId={production:'production','qc-repair':'production','quality-to-rts':'production','legacy-unit-intake':'production','semi-finishing':'production',sales:'sales','sales-to-cash':'sales','split-trips':'sales','ckd-sale':'sales','connected-invoice':'sales','customer-return':'sales',inventory:'inventory','physical-count':'inventory',purchasing:'purchasing','purchase-to-pay':'purchasing','budgeted-purchase-request':'purchasing',payroll:'hr','attendance-to-payroll':'hr','payroll-correction':'hr','file-request':'hr','review-requests':'hr','build-form':'hr',accounting:'accounting'};
  var modules={production:'manufacturing','qc-repair':'manufacturing',sales:'sales',purchasing:'purchasing',payroll:'hr',inventory:'inventory',accounting:'accounting'};
  var labels={'sales-to-cash':'From sale to payment','purchase-to-pay':'From purchase to payment','attendance-to-payroll':'Attendance to payroll','split-trips':'Release an order in trips','ckd-sale':'Sell a CKD unit','semi-finishing':'Finish a semi-built unit','customer-return':'Handle a customer return','physical-count':'Count physical stock','connected-invoice':'Invoice a customer','payroll-correction':'Correct payroll','quality-to-rts':'Inspect and receive production','budgeted-purchase-request':'Request a purchase budget','legacy-unit-intake':'Receive an existing unit'};
  var captions={'sales-to-cash':'Orders, supply, release, delivery and collection','purchase-to-pay':'Supplier orders, goods, bills and payments','attendance-to-payroll':'Recorded time, approved requests and payslips','split-trips':'Pick and issue only the goods on each trip','ckd-sale':'Allocate the unit and verify its loose parts','semi-finishing':'Move a semi-built unit through its final build','customer-return':'Receive, inspect and decide the next action','physical-count':'Count an exact location and review differences','connected-invoice':'Prepare an invoice from connected records','payroll-correction':'Check the source before recalculating pay','quality-to-rts':'Inspection, repair branches and stock receipt','budgeted-purchase-request':'Budget approval, cash, receipts and settlement','legacy-unit-intake':'Inspect a physical unit not yet in the system'};
  var session=null,watcher=null,frame=0;
  function plain(value){var el=document.createElement('div');el.innerHTML=value||'';return el.textContent.trim();}
  function destination(route,selector,instruction,params){return {route:route,selector:selector,instruction:instruction,params:params};}
  function failed(root){return root&&Array.from(root.querySelectorAll('.m-error,.rk-error')).some(function(el){return el.textContent.trim()&&!el.closest('form,[hidden],.hidden')&&(!el.checkVisibility||el.checkVisibility());});}
  function dest(guide,index){
    var s=guide.steps[index],r=s.to?.route;
    if(guide.id==='notes-scheduler')return [
      destination('notes','#m-note-new','Press New note / checklist to start.'),
      destination('notes','#m-note-title','Give the note a title and add its details.',{new:1}),
      destination('notes','#m-note-scheduled','Enable Schedule this note, then choose its due time.',{new:1}),
      destination('notes','#m-note-add-item, #m-note-save','Add or update the checklist. Save only when you are ready.',{new:1})
    ][index];
    if(guide.id==='file-request')return destination('requests',index===0?'#m-req-new':index===1?'.m-request-type, #m-req-new':'#m-req-list','Choose the request you want to file or review. Follow its own review and submission checks.');
    if(guide.id==='review-requests')return destination('approvals',index===0?'[data-appr-item], #m-appr-request-title':index===1?'#m-appr-request-title':'#m-appr-note','Select the relevant request and read its details before making any decision.');
    if(guide.id==='getting-started')return index===2?destination('notes','#m-note-new','Open or create a note for your own work.'):destination('work',index===0?'[data-work-tools]>summary':'#m-guide-start','Use Work & tools to find your authorized work areas.');
    if(guide.id==='inventory')return [destination('new-item','[data-name], input','Enter the item details; creating it is your action.'),null,destination('stock-move','[data-item-search], input','Select the exact stock item before choosing a movement.'),destination('transfer','[data-item-search], input','Select the item and verify the source and destination.'),destination('low-stock','[data-id]','Choose an item to inspect its current stock.'),destination('assign-qr','input','Select the exact item before assigning its physical label.'),destination('damage','input','Select the item and enter the required evidence.'),destination('my-log','[data-id]','Review the recorded stock movements.')][index];
    if(r==='finished-products')return destination('product-setup','[data-bom-products] [data-id], #bom-new, #bom-review','Choose a product to define or inspect its components.');
    if(r==='production-overview')return destination('job-orders','#pm-all, [data-id]','Review production status, then open all production or a relevant job.');
    if(guide.id==='production'&&index===2)return null; // Checklist administration is web-only.
    if(guide.id==='production'&&index===9)return null; // Findings reports are not the inspection queue.
    if(r==='job-orders'){
      if(/kit|parts out|pick the kit/i.test(s.title))return destination('kit-release','[data-jo], [data-id], #kr-counted','Choose the job whose parts kit you are handling.');
      return destination('job-orders','[data-jo], [data-id], #jo-counted, #jo-plan-reviewed','Choose the relevant job. Its current status determines the actions available.');
    }
    if(r==='orders'&&s.to.filter?.type==='sale'){var action=guide.id==='sales'?(index===0?'#sale-new':index===1||index===3?'#sale-approve, #sale-approval-open':index===2?'#sale-authorize':''):guide.id==='sales-to-cash'?(index===0?'#sale-new':'#sale-approve'):'';return destination(MApp.canOpen('sales')?'sales':'order-tracking',(action?action+', ':'')+'[data-sales-list] .sales-order','Choose the customer order, then use its current checks.');}
    if(r==='production-qc')return destination('qc','[data-jo], [data-unit], #qc-identity','Choose the matching job and physical unit before starting an inspection.');
    if(r==='production-receiving')return destination('receiving','[data-jo], #rts-legacy, #rts-print-labels','Choose the exact job or authorized intake before receiving goods.');
    if(r==='repairs')return destination('repairs','[data-id], [data-jo]','Choose the repair or parts request you are responsible for.');
    if(r==='releasing')return destination('so','[data-id], [data-so]','Choose the approved order for this handoff. Read its current release checks.');
    if(r==='hr-requests')return destination('requests','#m-req-new, #m-req-list','Open your request and follow its review steps.');
    if(r==='hr-approvals')return destination('approvals','#m-appr-request-title, [data-appr-item]','Choose a request within your approval authority.');
    if(r==='stock-counts')return destination('stock-counts','input, [data-id]','Select the exact location and count scope.');
    if(r==='purchase-requests')return destination('purchase-requests','[data-id], [data-pr], input','Choose the purchase request and inspect its current budget, cash or receipt stage.');
    if(r==='production-record')return destination('record','[data-id], [data-jo]','Choose the production record you want to inspect.');
    if(s.to?.external){var match=s.to.external.match(/#\/([a-z-]+)(?:\?([^\s]*))?/);if(match)return destination(match[1],'[data-id], [data-jo], input','Choose the relevant record and follow this workflow step.',Object.fromEntries(new URLSearchParams(match[2]||'')));if(/Deliveries/.test(s.to.external))return destination('deliveries','[data-id]','Choose the assigned delivery trip.');}
    return null;
  }
  function webDestination(step){
    if(!step.to?.route||typeof NAV==='undefined')return null;
    function allowed(node){return (!node.adminOnly||MApp.getMe()?.role==='admin')&&(!node.requiredModule||MApp.hasModule(node.requiredModule))&&(!node.requiredPermission||MApp.can(node.requiredPermission))&&(!node.requiredAnyPermission||node.requiredAnyPermission.some(MApp.can));}
    var found=NAV.some(function(section){return allowed(section)&&section.subtabs.some(function(tab){return allowed(tab)&&(tab.tree||[]).some(function(leaf){return leaf.route===step.to.route&&(!leaf.filter||Object.keys(leaf.filter).every(function(k){return String(leaf.filter[k])===String(step.to.filter?.[k]);}));});});});
    if(!found)return null;
    var query=new URLSearchParams(step.to.filter||{}).toString(),hash=step.to.route+(query?'?'+query:''),href=(window.VDS_BASE_PATH||'')+'/index.html#'+hash;
    return {href:href,route:step.to.route,title:step.to.label||step.title};
  }
  function plan(guide){return guide.steps.map(function(step,index){
    var d=dest(guide,index),registered=d&&MApp.routes().includes(d.route),employeeNeeded=registered&&['requests','clock','payslips','schedule'].includes(d.route)&&!MApp.isEmployee?.(),allowed=!!(registered&&!employeeNeeded&&MApp.canOpen(d.route)),web=allowed||employeeNeeded?null:webDestination(step);
    if(d)d.title=({'so':'Release orders','qc':'QC / QA','receiving':'RTS receiving','notes':'Notes / checklists','product-setup':'Products & BOM','job-orders':'Production','kit-release':'Kit releases','purchase-requests':'Purchase requests'})[d.route]||d.route.replace(/-/g,' ');
    return {step:step,destination:registered?d:null,web:web,available:allowed,label:web?'Open web app · new tab':employeeNeeded?'Employee profile required':registered?'Another team / access required':step.to?.route?'Web app access required':'Reference step'};
  });}
  function items(){return GUIDE.pipelines.filter(function(p){var module=p.module||modules[p.id]||'home';return module==='home'||MApp.hasModule(module);});}
  function valid(){return session&&session.owner===mReadScope.identity()&&!document.querySelector('#m-app')?.matches('.hidden,[hidden]');}
  function stop(){session=null;watcher?.disconnect();watcher=null;window.cancelAnimationFrame?.(frame);frame=0;GuideTour.close();}
  function show(){
    frame=0;
    if(!valid()){stop();return;}
    session.renderedHash=location.hash;
    var current=session,steps=plan(current.guide).map(function(row,index){var d=row.destination;return {title:row.step.title,instruction:row.available?d.instruction:row.label+': '+plain(row.step.before||row.step.body).slice(0,150),waiting:function(){if(!row.available)return row.label+'. Read this reference step; use the arrows to continue.';var root=document.querySelector('#m-view');if(root?.querySelector('[data-no-permission]'))return 'Access is unavailable. Close the guide or continue to another step.';if(failed(root))return 'This screen could not be loaded. Use its Retry control, or leave the guide.';if(root?.querySelector('.m-empty'))return 'No eligible record is shown here. The guide does not create or complete work.';return 'Choose the relevant record, or wait for this screen to load. The guide never performs the action.';},resolveTarget:function(){
      if(!valid()||session!==current||current.index!==index||!row.available||!MApp.canOpen(d.route)||MApp.currentLocation().name!==d.route)return null;
      var root=document.querySelector('#m-view');if(root.querySelector('[data-no-permission]')||failed(root))return null;
      return d.selector?Array.from(root.querySelectorAll(d.selector)).find(function(el){return !el.disabled&&!el.closest('[hidden],.hidden');})||null:null;
    }};});
    GuideTour.start({id:'mobile-workflow:'+current.guide.id,title:current.guide.title,steps:steps,compact:true,onMove:move,onExit:stop},current.index,{isCurrent:valid});
    if(current.focusAction){var control=document.querySelector('.guide-compact [data-act="'+current.focusAction+'"]');if(control?.disabled)control=document.querySelector('.guide-compact [data-act=next]');control?.focus({preventScroll:true});current.focusAction=null;}
  }
  function sync(){
    if(!valid()){stop();return;}
    // Draft confirmation may navigate with replaceState + render rather than a
    // hashchange. Resume only the destination the employee explicitly requested.
    if(session.pending){
      if(location.hash===session.pending.hash){session.index=session.pending.index;session.pending=null;session.renderedHash=null;}
      else if(!document.querySelector('dialog[open], [aria-modal="true"]')){session.pending=null;session.focusAction=null;}
    }
    if(session.renderedHash&&session.renderedHash!==location.hash){var row=plan(session.guide)[session.index];if(!row.available||row.destination.route!==MApp.currentLocation().name){stop();return;}}
    if((session.renderedHash!==location.hash||!document.querySelector('.guide-compact'))&&!frame)frame=requestAnimationFrame(show);
  }
  function move(delta){
    if(!valid()){stop();return;}
    var index=session.index+delta;
    if(index<0)return;if(index>=session.guide.steps.length){stop();mToast('Guidance ended. Check the app’s recorded results for completed work.');return;}
    session.focusAction=document.activeElement?.closest('.guide-compact [data-act]')?.dataset.act||null;
    visit(session.guide,index,true);
  }
  function visit(guide,index,guided){
    var row=plan(guide)[index];if(!row)return false;
    if(!row.available){if(guided&&session){session.index=index;show();return true;}return false;}
    var before=MApp.currentLocation(),d=row.destination,params=d.params;
    // Keep the employee's selected record/draft when continuing on that screen.
    if(before.name===d.route&&session&&(guide.id!=='notes-scheduler'||index>0&&document.querySelector('#m-note-editor')))params=before.params;
    var expected=MApp.nav(d.route,params);
    if(location.hash!==expected)MApp.go(d.route,params);
    if(location.hash!==expected){if(guided&&session)session.pending={index:index,hash:expected};return false;}
    if(guided){
      if(!session||session.guide!==guide){stop();session={guide:guide,index:index,owner:mReadScope.identity()};watcher=new MutationObserver(sync);watcher.observe(document.body,{attributes:true,subtree:true,childList:true,attributeFilter:['hidden','class','open']});}
      session.index=index;window.cancelAnimationFrame?.(frame);frame=requestAnimationFrame(show);
    }
    return true;
  }
  function start(guide,index){if(index===undefined)index=plan(guide).findIndex(function(s){return s.available;});if(index<0)return false;return visit(guide,index,true);}
  window.addEventListener('hashchange',function(){
    if(!session)return;if(!valid()){stop();return;}
    var row=plan(session.guide)[session.index],route=MApp.currentLocation().name;
    if(!row.available||row.destination.route!==route){stop();return;}
    sync();
  });
  window.addEventListener('storage',function(){if(session&&!valid())stop();});window.addEventListener('pagehide',stop);
  window.MobileWorkflow={label:function(p){return labels[p.id]||p.title;},caption:function(p){return captions[p.id]||p.tagline;},groups:groups,group:function(p){return byId[p.id]||({manufacturing:'production',hr:'hr',sales:'sales',inventory:'inventory',purchasing:'purchasing',accounting:'accounting'})[p.module]||'personal';},items:items,plan:plan,start:start,visit:function(p,i){return visit(p,i,false);},stop:stop,active:function(){return !!session;},plain:plain};
})();
