/* Internal PRs authorize spending; supplier orders and stock receiving stay separate.
   Every submitted decision/file has a durable immutable workflow attempt. */
(function () {
  var R=RoleUI, BASE='/purchasing/requests', serial=0;
  var canReview=function(){return ['purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'].some(function(p){return MApp.can(p);});};
  var me=function(){return (MApp.getMe()||{}).id;};
  var isBuyer=function(r){return r.buyer_id===me();};
  var money=function(n){return 'PHP '+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});};
  var status=function(s){return String(s||'').replace(/[_-]/g,' ');};
  function actionLabel(action){return {'approve':'Approve budget','reject':'Reject PR','issue-cash':'Record cash issued','return-liquidation':'Return liquidation','close':'Close PR'}[action]||status(action);}
  function go(params){var old=location.hash;MApp.go('purchase-requests',params||{});if(old===location.hash)MApp.render();}
  function page(view,title,sub){return R.page(view,{role:'Purchasing',title:title,subtitle:sub});}
  function field(label,attr,type,value){return '<label class="rk-card rk-field"><small>'+mEsc(label)+'</small><input class="rk-input" '+attr+' type="'+(type||'text')+'" value="'+mEsc(value==null?'':value)+'"></label>';}
  function noteField(attr,value){return '<label class="rk-card rk-field"><small>Note / reason</small><textarea class="rk-input" '+attr+' maxlength="2000">'+mEsc(value||'')+'</textarea></label>';}
  function error(e){mToast(e.message||String(e),'err');}
  function back(body,id,params){body.querySelector('#'+id).onclick=function(){go(params);};}
  function slots(id){return ['pr-action-'+id,'pr-receipt-'+id,'pr-liquidation-'+id];}
  async function pending(view,slot){var run=serial,hash=location.hash,s=await mWorkflow.load(slot);if(run!==serial||location.hash!==hash)return true;if(s&&s.operation.state!=='draft'){mWorkflow.paint(view,s);return true;}return false;}
  async function submit(view,s,options){await mWorkflow.start(s,Object.assign({role:'Purchasing',reviewRoute:'purchase-requests'},options));if(mWorkflow.owns(s)&&view.isConnected&&location.hash===options.hash)mWorkflow.paint(view,s);}
  function saver(s,body,collect){var work=Promise.resolve();return function(){collect();work=work.catch(function(){}).then(function(){return mWorkflow.save(s);});work.then(function(){if(body.isConnected&&body.querySelector('[data-pr-draft]'))body.querySelector('[data-pr-draft]').textContent='Draft saved on this device';}).catch(function(e){if(body.isConnected&&body.querySelector('[data-pr-draft]'))body.querySelector('[data-pr-draft]').textContent='Draft could not be saved: '+e.message;});return work;};}
  function linesMarkup(lines){return lines.map(function(x,i){return '<fieldset class="rk-card rk-field" data-line="'+i+'"><legend>Item '+(i+1)+'</legend>'+field('Item name','data-name maxlength="200"','text',x.name)+field('Quantity','data-qty min="0.001" step="any"','number',x.quantity)+field('Unit price','data-price min="0" step="0.01"','number',x.price)+'<button type="button" class="rk-btn secondary" data-remove="'+i+'">Remove item</button></fieldset>';}).join('');}
  function validLines(lines,max){return lines.length>0&&lines.length<=max&&lines.every(function(x){return x.name.trim().length>=2&&x.name.trim().length<=200&&String(x.quantity).trim()!==''&&Number.isFinite(Number(x.quantity))&&Number(x.quantity)>0&&Number(x.quantity)<=1e7&&String(x.price).trim()!==''&&Number.isFinite(Number(x.price))&&Number(x.price)>=0&&Number(x.price)<=1e9;});}
  function total(lines){return Math.round(lines.reduce(function(sum,x){return sum+Number(x.quantity)*Number(x.price);},0)*100)/100;}

  async function list(view,params){
    var run=serial,hash=location.hash,rows=await API.get(BASE);if(run!==serial||hash!==location.hash)return;
    var mode=params.view||'mine';if(mode==='review'&&!canReview())throw new Error('PR approval authority is required.');
    rows=rows.filter(function(r){return mode==='review'||(mode==='assigned'?isBuyer(r):r.requested_by===me());});
    var body=page(view,mode==='review'?'Review PRs':mode==='assigned'?'My assigned purchases':'My purchase requests','Budgets, receipts and liquidation — no stock movement');
    body.innerHTML=R.note('info','Approval authorizes spending. A buyer must submit receipts and actual purchases before authority closes the PR. Stock receiving is a separate workflow.')+
      (MApp.can('purchasing.request')?R.actions([{id:'pr-new',label:'Make PR',kind:'primary'}]):'')+
      '<div data-pr-list>'+rows.map(function(r){return R.jobCard({id:r.id,number:r.number,name:r.reason,meta:status(r.status)+' · Requested '+money(r.requested_budget)+' · Approved '+(r.approved_budget==null?'—':money(r.approved_budget))+' · Buyer '+(r.buyer_name||'Not assigned')+' · '+r.receipt_count+' receipt(s)',pill:{text:status(r.status)}});}).join('')+'</div>'+(rows.length?'':R.note('info','No purchase requests in this list.'));
    var create=body.querySelector('#pr-new');if(create)create.onclick=function(){go({step:'new'});};
    body.querySelectorAll('[data-id]').forEach(function(button){button.onclick=function(){go({id:button.dataset.id});};});
    var savedActions=(await mProductionDrafts.listWorkflows('pr-')).filter(function(s){return /^pr-(create|(?:action|receipt|liquidation)-\d+)$/.test(s.operation.route);});if(run!==serial||hash!==location.hash)return;
    if(savedActions.length){var host=mEl('<section class="rk-card"><h3>Saved PR work</h3></section>');savedActions.forEach(function(saved){var op=saved.operation,slot=op.route,match=/^pr-(action|receipt|liquidation)-(\d+)$/.exec(slot);var label=op.state==='draft'?'Resume '+(slot==='pr-create'?'request':match?match[1]:'saved work'):'Recover '+(op.title||'saved request');var button=mEl('<button type="button" class="rk-btn secondary">'+mEsc(label)+'</button>');button.onclick=function(){go(slot==='pr-create'?{step:'new'}:{id:Number(match[2]),step:match[1]==='receipt'?'receipt':match[1]==='liquidation'?'liquidation':undefined});};host.appendChild(button);});body.prepend(host);}

  }

  async function lineForm(view,r){
    if(!r&&!MApp.can('purchasing.request'))throw new Error('Purchase request permission is required.');
    if(r&&(!isBuyer(r)||r.status!=='approved'))throw new Error('Only this PR’s assigned buyer can submit its liquidation while approved.');
    var run=serial,hash=location.hash,slot=r?'pr-liquidation-'+r.id:'pr-create',s=await mWorkflow.draft(slot);if(run!==serial||hash!==location.hash)return;
    if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    var b=s.batch,lines=b.lines||(r?(r.purchases.length?r.purchases:r.items).map(function(x){return {name:x.name,quantity:x.quantity,price:x.actual_unit_price==null?'':x.actual_unit_price};}):[{name:'',quantity:1,price:''}]);b.lines=lines;
    var body=page(view,r?'Liquidate '+r.number:'Make PR',r?'Record actual purchases, including extra/substituted items within budget':'Freeform items — no inventory SKU or supplier needed');
    body.innerHTML=R.note('info',r?'Approved budget '+money(r.approved_budget)+'. Upload receipts before submission. Cash issued: '+(r.cash_issued==null?'Not recorded':money(r.cash_issued))+'.':'Enter what you need and its estimated cost. This requests a budget; it does not order goods or add stock.')+
      (r?'':field('Reason for purchase','data-reason maxlength="2000"','text',b.reason)+field('Needed by (optional)','data-date','date',b.needed_by))+
      '<div data-lines></div>'+R.actions([{id:'pr-add',label:'Add item',kind:'secondary'}])+'<strong data-total></strong><div data-budget-warning role="alert"></div>'+
      noteField('data-note',b.note)+'<p data-pr-draft role="status"></p>'+R.check('pr-confirm','I checked the items and amounts')+
      R.actions([{id:'pr-submit',label:r?'Submit liquidation':'Submit request',kind:'primary'},{id:'pr-back',label:r?'Back to request':'My requests',kind:'secondary'}]);
    var save=saver(s,body,function(){b.lines=lines;b.note=body.querySelector('[data-note]').value;if(!r){b.reason=body.querySelector('[data-reason]').value;b.needed_by=body.querySelector('[data-date]').value;}});
    function calculate(){var amount=total(lines),valid=validLines(lines,r?150:100)&&Number.isFinite(amount)&&amount>0;
      var over=r&&Math.round(amount*100)>Math.round(r.approved_budget*100),noReceipts=r&&!r.receipts.length,noCash=r&&r.purchase_mode==='requester_cash'&&r.cash_issued==null;
      body.querySelector('[data-total]').textContent=(r?'Actual spending: ':'Requested budget: ')+money(Number.isFinite(amount)?amount:0);
      body.querySelector('[data-budget-warning]').textContent=over?'Actual spending exceeds the approved overall budget.':noReceipts?'Upload at least one receipt before liquidation.':noCash?'Authority must record the cash physically issued first.':'';
      body.querySelector('#pr-submit').disabled=!valid||!!over||!!noReceipts||!!noCash||!body.querySelector('#pr-confirm').checked;
    }
    function paint(){body.querySelector('[data-lines]').innerHTML=linesMarkup(lines);body.querySelectorAll('[data-line]').forEach(function(row){var i=Number(row.dataset.line);['name','qty','price'].forEach(function(key){row.querySelector('[data-'+key+']').oninput=function(){lines[i][key==='qty'?'quantity':key]=this.value;calculate();save();};});});
      body.querySelectorAll('[data-remove]').forEach(function(button){button.onclick=function(){lines.splice(Number(button.dataset.remove),1);paint();save();};});calculate();}
    body.querySelector('#pr-add').onclick=function(){if(lines.length>=(r?150:100)){mToast('Item limit reached.','err');return;}lines.push({name:'',quantity:1,price:''});paint();save();};
    body.querySelectorAll('[data-note],[data-reason],[data-date]').forEach(function(el){el.oninput=save;});body.querySelector('#pr-confirm').onchange=calculate;
    back(body,'pr-back',r?{id:r.id}:{});paint();
    body.querySelector('#pr-submit').onclick=async function(){var btn=this;try{if(btn.disabled)return;btn.disabled=true;await save();var amount=total(lines);if(!validLines(lines,r?150:100)||!Number.isFinite(amount)||amount<=0||r&&Math.round(amount*100)>Math.round(r.approved_budget*100))throw new Error('Complete each item within the allowed budget.');if(!r&&b.reason.trim().length<3)throw new Error('Explain why this purchase is needed.');
      var payload={items:lines.map(function(x){var item={name:x.name.trim(),quantity:Number(x.quantity)};item[r?'actual_unit_price':'estimated_unit_price']=Number(x.price);return item;})};
      if(r)payload.note=b.note.trim()||null;else{payload.reason=b.reason.trim();payload.needed_by=b.needed_by||null;}
      await submit(view,s,{path:r?BASE+'/'+r.id+'/liquidation':BASE,payload:payload,title:r?'Liquidation for '+r.number:'New purchase request',successLabel:r?'Liquidation submitted — awaiting review':'Request submitted — awaiting approval',reviewParams:r?{id:r.id}:{},resultParam:r?null:'id',hash:hash});
    }catch(e){error(e);if(body.isConnected)calculate();}};
  }

  function available(r,action){var permission=action==='issue-cash'?'purchasing.issue_cash':['close','return-liquidation'].indexOf(action)!==-1?'purchasing.settle_requests':'purchasing.approve_requests';if(!MApp.can(permission))return false;if((MApp.getMe()||{}).role!=='admin'&&((['approve','reject'].indexOf(action)!==-1&&r.requested_by===me())||(action==='close'&&isBuyer(r))))return false;return (r.status==='pending'&&['approve','reject'].indexOf(action)!==-1)||(r.status==='approved'&&r.purchase_mode==='requester_cash'&&r.cash_issued==null&&action==='issue-cash')||(r.status==='liquidation_submitted'&&['return-liquidation','close'].indexOf(action)!==-1);}
  async function decision(view,r,action){
    if(!available(r,action))throw new Error('This approval action is not available with your authority or the current PR status.');
    var run=serial,hash=location.hash,s=await mWorkflow.draft('pr-action-'+r.id);if(run!==serial||hash!==location.hash)return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    var b=s.batch;if(b.action!==action){b.action=action;b.budget=r.requested_budget;b.mode='requester_cash';b.buyer='';b.amount=r.approved_budget;b.note='';b.returned='';b.reimbursed='';}
    var buyers=action==='approve'?await API.get(BASE+'/buyers'):[];if(run!==serial||hash!==location.hash)return;
    var body=page(view,actionLabel(action)+' · '+r.number,'PR approval authority — confirm physical cash movements truthfully');
    var expectedReturn=r.purchase_mode==='requester_cash'?Math.max(0,Math.round((r.cash_issued||0)*100)-Math.round((r.actual_total||0)*100))/100:0;
    var expectedReimbursement=r.purchase_mode==='requester_cash'?Math.max(0,Math.round((r.actual_total||0)*100)-Math.round((r.cash_issued||0)*100))/100:0;
    body.innerHTML=R.field('Requested budget',money(r.requested_budget))+R.field('Approved budget',r.approved_budget==null?'—':money(r.approved_budget))+
      (action==='approve'?field('Approved overall budget','data-budget min="0.01" step="0.01"','number',b.budget)+'<label class="rk-card rk-field"><small>Purchase arrangement</small><select data-mode><option value="requester_cash">Cash to requester</option><option value="assigned_buyer">Assigned buyer</option></select></label><label class="rk-card rk-field" data-buyer-row><small>Assigned buyer</small><select data-buyer><option value="">Choose buyer</option>'+buyers.map(function(u){return '<option value="'+u.id+'">'+mEsc(u.full_name)+'</option>';}).join('')+'</select></label>':action==='issue-cash'?field('Cash physically issued','data-amount min="0.01" step="0.01"','number',b.amount):action==='close'?R.field('Actual spending',money(r.actual_total))+R.field('Required change returned',money(expectedReturn))+R.field('Required reimbursement paid',money(expectedReimbursement))+field('Change physically returned','data-returned min="0" step="0.01"','number',b.returned)+field('Reimbursement physically paid','data-reimbursed min="0" step="0.01"','number',b.reimbursed):'')+
      noteField('data-note',b.note)+'<p data-pr-draft role="status"></p>'+R.check('pr-action-confirm','I reviewed the request, evidence and any physical cash settlement')+R.actions([{id:'pr-action-save',label:actionLabel(action),kind:action==='reject'?'danger':'primary'},{id:'pr-back',label:'Back to request',kind:'secondary'}]);
    if(action==='approve'){body.querySelector('[data-mode]').value=b.mode;body.querySelector('[data-buyer]').value=b.buyer;var toggle=function(){body.querySelector('[data-buyer-row]').hidden=body.querySelector('[data-mode]').value!=='assigned_buyer';};toggle();}
    var save=saver(s,body,function(){['budget','mode','buyer','amount','note','returned','reimbursed'].forEach(function(key){var input=body.querySelector('[data-'+key+']');if(input)b[key]=input.value;});});
    body.querySelectorAll('input:not([type=checkbox]),select,textarea').forEach(function(input){input.oninput=function(){if(action==='approve')toggle();save();};});
    var btn=body.querySelector('#pr-action-save');btn.disabled=true;body.querySelector('#pr-action-confirm').onchange=function(){btn.disabled=!this.checked;};back(body,'pr-back',{id:r.id});
    btn.onclick=async function(){try{if(btn.disabled)return;btn.disabled=true;await save();var payload={note:b.note.trim()||null};
      if(action==='approve'){if(!Number.isFinite(Number(b.budget))||Number(b.budget)<=0||Number(b.budget)>1e9)throw new Error('Enter a positive approved budget.');if(b.mode==='assigned_buyer'&&!b.buyer)throw new Error('Choose the assigned buyer.');payload.approved_budget=Number(b.budget);payload.purchase_mode=b.mode;payload.buyer_id=b.mode==='assigned_buyer'?Number(b.buyer):null;}
      if(['reject','return-liquidation'].indexOf(action)!==-1&&(!payload.note||payload.note.length<3))throw new Error('Enter a reason of at least three characters.');
      if(action==='issue-cash'){if(!String(b.amount).trim()||!Number.isFinite(Number(b.amount))||Number(b.amount)<=0||Number(b.amount)>r.approved_budget)throw new Error('Cash must be positive and within the approved budget.');payload={amount:Number(b.amount)};}
      if(action==='close'){if(String(b.returned).trim()===''||String(b.reimbursed).trim()===''||!Number.isFinite(Number(b.returned))||!Number.isFinite(Number(b.reimbursed))||Math.round(Number(b.returned)*100)!==Math.round(expectedReturn*100)||Math.round(Number(b.reimbursed)*100)!==Math.round(expectedReimbursement*100))throw new Error('Record the exact returned change and reimbursement shown above.');payload.cash_returned=Number(b.returned);payload.reimbursed_amount=Number(b.reimbursed);}
      await submit(view,s,{path:BASE+'/'+r.id+'/'+action,payload:payload,title:actionLabel(action)+' · '+r.number,reviewParams:{id:r.id},hash:hash});
    }catch(e){error(e);if(body.isConnected)btn.disabled=false;}};
  }

  async function receipt(view,r){
    if(!isBuyer(r)||r.status!=='approved')throw new Error('Only the assigned buyer may add receipts while this PR is approved.');
    var run=serial,hash=location.hash,s=await mWorkflow.draft('pr-receipt-'+r.id);if(run!==serial||hash!==location.hash)return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    var body=page(view,'Receipt for '+r.number,'JPG, PNG, WebP or PDF · up to 8 MB per file');
    body.innerHTML=R.note('info','Upload one receipt at a time. Camera photos use the same compression as other mobile evidence. PDFs retain their original file.')+'<div data-selected role="status"></div>'+R.actions([{id:'pr-camera',label:'Take receipt photo',kind:'secondary'},{id:'pr-file',label:'Choose receipt file',kind:'secondary'},{id:'pr-upload',label:'Upload receipt',kind:'primary'},{id:'pr-back',label:'Back to request',kind:'secondary'}]);
    var btn=body.querySelector('#pr-upload'),busy=false;function show(){body.querySelector('#pr-camera').disabled=busy;body.querySelector('#pr-file').disabled=busy;body.querySelector('[data-selected]').textContent=s.rows.length?s.rows[0].identifier+' · '+Math.round(s.rows[0].file.size/1024)+' KB saved on this device':'No file selected';btn.disabled=busy||!s.rows.length;}show();back(body,'pr-back',{id:r.id});
    async function selected(file,alreadyPrepared){busy=true;show();try{if(['image/jpeg','image/png','image/webp','application/pdf'].indexOf(file.type)===-1)throw new Error('Choose a JPG, PNG, WebP or PDF receipt.');var prepared=file.type==='application/pdf'||alreadyPrepared?file:await mPhoto.preparePhoto(file);if(prepared.size>8*1024*1024)throw new Error('Receipt must be 8 MB or smaller.');if(run!==serial||hash!==location.hash||!mWorkflow.owns(s))return;s.rows=[{file:prepared,identifier:prepared.name||file.name||'receipt.jpg'}];await mWorkflow.save(s);}catch(e){error(e);}finally{busy=false;if(body.isConnected)show();}}
    body.querySelector('#pr-camera').onclick=function(){mPhoto.pickFile().then(function(file){return selected(file,true);}).catch(function(e){if(e.message!=='cancelled')error(e);});};
    body.querySelector('#pr-file').onclick=function(){var input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp,application/pdf';input.onchange=function(){var file=input.files[0];if(file)selected(file);};input.click();};
    btn.onclick=async function(){try{if(btn.disabled||busy||!s.rows.length)return;btn.disabled=true;body.querySelector('#pr-camera').disabled=true;body.querySelector('#pr-file').disabled=true;await submit(view,s,{path:BASE+'/'+r.id+'/receipts',multipart:true,fileField:'file',payload:{},title:'Receipt for '+r.number,successLabel:'Receipt uploaded',reviewParams:{id:r.id},hash:hash});}catch(e){error(e);if(body.isConnected){body.querySelector('#pr-camera').disabled=false;body.querySelector('#pr-file').disabled=false;show();}}};
  }

  async function detail(view,r){
    var body=page(view,r.number,status(r.status));
    function items(title,rows,key){return '<section class="rk-card"><h3>'+title+'</h3>'+rows.map(function(x){return '<p><b>'+mEsc(x.name)+'</b><br>'+mEsc(x.quantity)+' × '+mEsc(money(x[key]))+' = '+mEsc(money(x.quantity*x[key]))+'</p>';}).join('')+'</section>';}
    body.innerHTML=R.note('info','This PR does not add inventory stock. Approval alone does not close it.')+R.field('Reason',r.reason)+R.field('Requester',r.requested_by_name||'—')+R.field('Needed by',r.needed_by||'Not specified')+
      R.field('Requested budget',money(r.requested_budget))+R.field('Approved budget',r.approved_budget==null?'Not approved':money(r.approved_budget))+R.field('Purchase arrangement',r.purchase_mode==='requester_cash'?'Cash to requester':r.purchase_mode==='assigned_buyer'?'Assigned buyer':'Not chosen')+R.field('Buyer',r.buyer_name||'Not assigned')+R.field('Cash issued',r.cash_issued==null?'Not recorded':money(r.cash_issued))+R.field('Actual spending',r.actual_total==null?'Not submitted':money(r.actual_total))+R.field('Receipts',r.receipts.length)+
      (r.decision_note?R.field('Approval / rejection note',r.decision_note):'')+(r.liquidation_note?R.field('Liquidation note',r.liquidation_note):'')+(r.close_note?R.field(r.status==='approved'?'Correction requested':'Closing note',r.close_note):'')+
      (r.status==='closed'?R.field('Change returned',money(r.cash_returned))+R.field('Reimbursement paid',money(r.reimbursed_amount)):'')+
      items('Requested items',r.items,'estimated_unit_price')+(r.purchases.length?items('Actual purchases',r.purchases,'actual_unit_price'):'')+
      '<section class="rk-card"><h3>Receipts</h3>'+r.receipts.map(function(f){return '<p>'+mEsc(f.original_name)+' <button type="button" class="rk-btn secondary" data-receipt="'+f.id+'">View / download receipt</button></p>';}).join('')+'</section>'+
      R.actions((isBuyer(r)&&r.status==='approved'?[{id:'pr-receipt',label:'Add receipt',kind:'secondary'},{id:'pr-liquidate',label:'Enter actual purchases',kind:'primary'}]:[]).concat(['approve','reject','issue-cash','return-liquidation','close'].filter(function(a){return available(r,a);}).map(function(a){return {id:'pr-'+a,label:actionLabel(a),kind:'secondary'};})).concat([{id:'pr-back',label:'Back to my requests',kind:'secondary'}]));
    body.querySelectorAll('[data-receipt]').forEach(function(button){button.onclick=async function(){button.disabled=true;try{var file=r.receipts.find(function(f){return f.id===Number(button.dataset.receipt);});await API.download(BASE+'/'+r.id+'/receipts/'+file.id,file.original_name);}catch(e){error(e);}finally{if(button.isConnected)button.disabled=false;}};});
    var upload=body.querySelector('#pr-receipt');if(upload)upload.onclick=function(){go({id:r.id,step:'receipt'});};var liquidate=body.querySelector('#pr-liquidate');if(liquidate)liquidate.onclick=function(){go({id:r.id,step:'liquidation'});};
    ['approve','reject','issue-cash','return-liquidation','close'].forEach(function(a){var button=body.querySelector('#pr-'+a);if(button)button.onclick=function(){go({id:r.id,step:'decision',action:a});};});back(body,'pr-back',canReview()?{view:'review'}:{});
  }

  MApp.route('purchase-requests',async function(view,params){
    params=params||{};var run=++serial,hash=location.hash;view.innerHTML=R.skeleton(2);
    try{
      if(params.view==='review'&&!canReview())throw new Error('PR approval authority is required.');
      if(params.step==='new')return await lineForm(view,null);
      if(!params.id)return await list(view,params);
      var id=Number(params.id),r=await API.get(BASE+'/'+id);if(run!==serial||hash!==location.hash)return;
      for(var slot of slots(id)){if(await pending(view,slot))return;if(run!==serial||hash!==location.hash)return;}
      if(params.step==='liquidation')return await lineForm(view,r);
      if(params.step==='receipt')return await receipt(view,r);
      if(params.step==='decision')return await decision(view,r,params.action);
      await detail(view,r);
    }catch(e){if(run!==serial||hash!==location.hash)return;view.innerHTML='';var body=page(view,'Purchase requests','Unable to open this operation');body.appendChild(R.error(e,function(){MApp.render();}));var b=mEl(R.actions([{id:'pr-work',label:'Back to Work',kind:'secondary'}]));b.querySelector('button').onclick=function(){MApp.go('work');};body.appendChild(b);}
  });
})();
