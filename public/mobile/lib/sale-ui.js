/* Shared customer identity and factual handoff details for the existing Sales screens. */
(function () {
  var sequence = 0;
  function customerPicker(options) {
    var initial=options.value||{};
    var state = {customer_id:initial.customer_id||null,customer_name:initial.customer_name||'',customer_contact:initial.customer_contact||'',customer_mode:initial.customer_mode};
    state.customer_name=String(state.customer_name||'');state.customer_contact=String(state.customer_contact||'');
    var selectedName = state.customer_name, rows = [], matches = [], active = -1, prefix = 'sale-customer-' + (++sequence);
    var root = mEl('<section class="rk-card sale-customer-picker">' +
      '<label class="m-field"><span class="m-label">Customer entry</span><select class="m-input" data-customer-mode><option value="walkin">Walk-in / unregistered</option><option value="existing">Existing registered customer</option></select></label>' +
      '<div data-search-area><label class="m-field"><span class="m-label">Search registered customers</span><input class="m-input" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="'+prefix+'" data-customer-search></label><div id="'+prefix+'" class="sale-customer-results" role="listbox" aria-label="Matching registered customers" hidden></div><button type="button" class="rk-btn secondary" data-customer-retry hidden>Retry customer search</button></div>' +
      '<p class="sale-customer-status" role="status" data-customer-status></p><input type="hidden" data-customer>' +
      '<label class="m-field"><span class="m-label">Customer name *</span><input class="m-input" data-customer-name data-f="customer" autocomplete="organization" maxlength="160"></label>' +
      '<label class="m-field"><span class="m-label">Contact</span><input class="m-input" data-contact data-f="contact" maxlength="160"></label></section>');
    var mode=root.querySelector('[data-customer-mode]'), search=root.querySelector('[data-customer-search]'), list=root.querySelector('[role=listbox]');
    var name=root.querySelector('[data-customer-name]'), contact=root.querySelector('[data-contact]'), status=root.querySelector('[data-customer-status]');
    mode.value=state.customer_mode||(state.customer_id?'existing':'walkin');if(mode.value==='walkin')state.customer_id=null;name.value=state.customer_name;contact.value=state.customer_contact;search.value=state.customer_name;
    function close(){list.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');active=-1;}
    function emit(){state.customer_mode=mode.value;root.querySelector('[data-customer]').value=state.customer_id||'';options.onChange?.(Object.assign({},state));}
    function describe(){root.querySelector('[data-search-area]').hidden=mode.value!=='existing';status.textContent=state.customer_id?'Selected registered customer: '+selectedName:mode.value==='existing'?'Choose a search result to link an existing customer.':'Walk-in entry · no customer registry link.';}
    function choose(customer){state.customer_id=customer.id;state.customer_name=selectedName=customer.name;state.customer_contact=customer.phone||customer.email||customer.contact_person||'';name.value=state.customer_name;contact.value=state.customer_contact;search.value=customer.name;close();describe();emit();}
    function draw(){
      var q=search.value.trim().toLowerCase();matches=q?rows.filter(function(c){return [c.name,c.phone,c.email,c.contact_person].join(' ').toLowerCase().includes(q);}).slice(0,15):[];
      list.innerHTML=matches.length?matches.map(function(c,i){return '<button type="button" role="option" aria-selected="'+(i===active)+'" id="'+prefix+'-'+i+'" data-customer-option="'+i+'" tabindex="-1"><b>'+mEsc(c.name)+'</b><small>'+mEsc(c.phone||c.email||c.contact_person||'No contact')+'</small></button>';}).join(''):'<p>No matching registered customer. Use Walk-in for an unregistered entry.</p>';
      list.hidden=!q;search.setAttribute('aria-expanded',q?'true':'false');
      if(active>=0&&matches[active])search.setAttribute('aria-activedescendant',prefix+'-'+active);else search.removeAttribute('aria-activedescendant');
      list.querySelectorAll('[data-customer-option]').forEach(function(button){button.onclick=function(){choose(matches[Number(button.dataset.customerOption)]);};});
    }
    async function load(){try{rows=await API.get('/customers');if(!root.isConnected)return;root.querySelector('[data-customer-retry]').hidden=true;if(mode.value==='existing'&&document.activeElement===search)draw();}catch(e){if(!root.isConnected)return;status.textContent='Registered customers are unavailable. Retry, or explicitly use Walk-in.';root.querySelector('[data-customer-retry]').hidden=false;}}
    mode.onchange=function(){close();state.customer_id=null;describe();if(mode.value==='existing'){search.value=name.value;search.focus();draw();}emit();};
    search.oninput=function(){state.customer_id=null;state.customer_name=name.value=search.value;active=-1;describe();draw();emit();};
    search.onfocus=draw;
    search.onkeydown=function(event){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();active=Math.max(0,Math.min(matches.length-1,active+(event.key==='ArrowDown'?1:-1)));draw();}else if(event.key==='Enter'&&!list.hidden){event.preventDefault();if(matches[active])choose(matches[active]);}else if(event.key==='Escape')close();};
    root.querySelector('[data-search-area]').onfocusout=function(event){if(!this.contains(event.relatedTarget))close();};
    name.oninput=function(){state.customer_name=name.value;if(state.customer_id&&name.value!==selectedName){state.customer_id=null;mode.value='walkin';close();describe();status.textContent='Walk-in entry · the previous customer link was removed after the name changed.';}emit();};
    contact.oninput=function(){state.customer_contact=contact.value;emit();};
    root.querySelector('[data-customer-retry]').onclick=load;describe();root.querySelector('[data-customer]').value=state.customer_id||'';
    // Mount first; failed registry reads never prevent explicit walk-in entry.
    Promise.resolve().then(load);
    return {el:root,value:function(){if(mode.value==='existing'&&!state.customer_id)throw new Error('Choose an existing customer from search, or select Walk-in.');if(!state.customer_name.trim())throw new Error('Enter the customer name.');return Object.assign({},state,{customer_name:state.customer_name.trim(),customer_contact:state.customer_contact.trim()||null});}};
  }
  function deliveryFacts(order){
    var result=RoleUI.field('Target delivery date',order.expected_date||'Not set');
    var events=(order.delivery_events||[]).filter(function(e){return e.delivered_at&&e.status==='delivered';});
    if(events.length)result+=RoleUI.section('Recorded delivery / courier handoffs')+events.map(function(e){var raw=String(e.delivered_at),date=new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(raw)?raw:raw.replace(' ','T')+'Z');var when=isNaN(date.getTime())?raw:date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});return RoleUI.field(e.delivery_mode==='courier'?'Courier pickup / handoff':'Customer delivery',(e.release_slip_number?e.release_slip_number+' · ':'')+(e.number?e.number+' · ':'')+when);}).join('');
    return result;
  }
  function productionJobs(av){
    var jobs=[],seen={};(av.lines||[]).forEach(function(l){(l.linked_job_orders||[]).forEach(function(j){if(!seen[j.id]){seen[j.id]=true;jobs.push(j);}});});
    return jobs.length?RoleUI.section('Linked production jobs')+jobs.map(function(j){return '<details class="rk-card sale-linked-job"><summary><b>'+mEsc(j.number)+'</b> · '+mEsc(j.qty_ordered)+(Number(j.qty_ordered)===1?' unit · ':' units · ')+mEsc(j.status)+'<small>View production handoff</small></summary>'+RoleUI.field('Completed / remaining',j.qty_done+' / '+j.remaining)+RoleUI.note('info','Read-only linked production record. Planning actions belong to Production.')+'</details>';}).join('')+RoleUI.note('info','Production owns plan approval, kit release, building, inspection and receipt. New drafts still need Production approval. Planned jobs are not RTS stock.') : '';
  }
  function paintApproval(view,s,id){
    mWorkflow.paint(view,s,async function(body,saved,visible){
      if(saved.operation.state!=='confirmed'||saved.operation.local)return;
      var host=mEl('<section data-sale-production-result></section>');body.appendChild(host);
      async function refresh(){try{var av=await API.get('/orders/'+id+'/availability');if(!visible())return;host.innerHTML=productionJobs(av)||RoleUI.note('info','Review the current sale for its warehouse handoff. No linked production job is listed.');}catch(e){if(!visible())return;host.innerHTML=RoleUI.note('warn','Production handoff details are unavailable. Refresh before assuming there is no production work.')+RoleUI.actions([{id:'sale-result-refresh',label:'Refresh production details',kind:'secondary'}]);host.querySelector('button').onclick=refresh;}}
      await refresh();
    });
  }
  window.mSaleUI={customerPicker:customerPicker,deliveryFacts:deliveryFacts,productionJobs:productionJobs,paintApproval:paintApproval};
})();
