/* Preview-only environment adapter. Real UI modules never import this file. */
(function () {
  function resolveImage(image){var src=image.getAttribute('src'),asset=window.__SCRATCH_ASSETS__?.[src];if(asset){image.dataset.scratchImageSource=src;image.setAttribute('src',asset);}}
  new MutationObserver(function(records){records.forEach(function(r){if(r.type==='attributes')resolveImage(r.target);r.addedNodes.forEach(function(n){if(n.nodeType!==1)return;if(n.matches('img[src]'))resolveImage(n);n.querySelectorAll('img[src]').forEach(resolveImage);});});}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  var config=window.__SCRATCH_CONFIG__,transport=config.response||'normal',confirmed=false,seeded=config.view==='results',journal=[],receipts=new Map(),sequence=0;
  function memory(){var data=new Map();return{get length(){return data.size;},key:function(i){return Array.from(data.keys())[i]??null;},getItem:function(k){return data.get(String(k))??null;},setItem:function(k,v){data.set(String(k),String(v));},removeItem:function(k){data.delete(String(k));},clear:function(){data.clear();}};}
  // srcdoc inherits its parent's base URL; preserve real fragment-history semantics inside this frame.
  var originalReplace=history.replaceState.bind(history);history.replaceState=function(state,title,url){if(location.href.startsWith('about:srcdoc')&&typeof url==='string'&&url.startsWith('#'))url='about:srcdoc'+url;return originalReplace(state,title,url);};
  var local=memory(),session=memory();Object.defineProperty(window,'localStorage',{value:local});Object.defineProperty(window,'sessionStorage',{value:session});
  local.setItem('vds_token','scratch-fixture-only');local.setItem('vds_m_owner','1');local.setItem('vds_theme',config.dark?'dark':'light');
  document.documentElement.dataset.theme=config.dark?'dark':'light';local.setItem('vds_batch_layout:'+JSON.stringify(['',1]),config.layout||'list');
  // Direct-file/srcdoc hosts have a null URL origin. Supply a URL parsing base,
  // never a network destination; fetch below handles every request in memory.
  var RealURL=window.URL;window.URL=class extends RealURL{constructor(input,base){super(input,base==='null'?'https://scratch.invalid':base);}};
  Object.defineProperty(navigator,'serviceWorker',{value:{controller:null,ready:Promise.resolve({sync:{register:async function(){}}}),register:async function(){return{};},addEventListener:function(){}}});
  Object.defineProperty(navigator,'mediaDevices',{value:undefined});
  window.XMLHttpRequest=function(){throw new Error('Uploads are outside this isolated batch preview.');};
  window.WebSocket=function(){throw new Error('Realtime transport is outside this isolated batch preview.');};
  window.BroadcastChannel=undefined;
  var user={id:1,username:'preview-warehouse',full_name:'Warehouse review',role:'warehouse',permissions:['mobile.access','inventory.mobile','inventory.view'].concat(config.role==='view'?[]:['inventory.adjust','production.kit_release','orders.release']),modules:['inventory'],work_shortcuts:['scan']};
  var locations=[{id:1,name:'Main',is_default:1,parent_id:null,type:'warehouse'},{id:2,name:'Branch',is_default:0,parent_id:null,type:'warehouse'}];
  var names=['M8 flange bolt','Control cable','Inline fuse','Cable gland M20','DIN rail terminal block','24 V relay','Panel mounting bracket','Heat-shrink sleeve','Crimp lug 6 mm²','Conduit clamp','Terminal end plate','Junction box gasket'];
  if(config.photo==='similar'){names[0]='M8 flange bolt · 25 mm';names[2]='M8 flange bolt · 40 mm';}
  var items=names.slice(0,Number(config.count)||3).map(function(name,i){var finished=(config.finished||config.request==='so')&&i===2;return{id:i+1,name:'Fictional '+(finished?'controller assembly':name)+(config.long?' · reinforced replacement component for the warehouse controller maintenance service kit':''),sku:i===0?'DEMO-BOLT':i===1?'DEMO-CABLE':i===2?(finished?'DEMO-CTRL':'DEMO-FUSE'):'DEMO-'+String(i+1).padStart(3,'0'),unit:i===1||i===7?'m':'pcs',is_finished_product:finished?1:0,image_path:config.photo==='missing'?null:'fixture-illustration-'+(i+1),min_quantity:0};});
  var stock=Object.fromEntries(items.map(function(item,i){return[item.id,{1:{assembled:i===0?12:i===1?20:i===2?2:12+i,semi_built:item.is_finished_product?1:0},2:{assembled:i===0?8:i===1?0:i===2?12:8+i,semi_built:item.is_finished_product?3:0}}];}));
  if(config.negative&&stock[1])stock[1][1].assembled=-2;
  function item(id){var it=items.find(function(i){return i.id===Number(id);});return it?Object.assign({},it,{quantity:Object.values(stock[it.id]).reduce(function(n,r){return n+r.assembled+r.semi_built;},0)}):null;}
  function stockRows(id){return locations.map(function(l){var r=stock[id][l.id],reserved=config.reserved&&Number(id)===1&&l.id===1?8:0;return{location_id:l.id,location_name:l.name,quantity:r.assembled+r.semi_built,assembled_quantity:r.assembled,semi_built_quantity:r.semi_built,assembled_movable:Math.max(0,r.assembled-reserved),semi_built_movable:r.semi_built};});}
  function illustration(id){
    var bolt=id===1||(config.photo==='similar'&&id===3),long=config.photo==='similar'&&id===3;
    var drawing=bolt?'<g transform="translate(80 22) rotate(20 170 100)"><path d="M65 70h180v64H65Z" fill="#b5bfc2" stroke="#58676d" stroke-width="3"/>'+Array.from({length:long?15:10},function(_,n){return '<path d="m'+(90+n*10)+' 72 -15 60" stroke="#697b82" stroke-width="3"/>';}).join('')+'<path d="m30 62 35-20 35 20v80l-35 20-35-20Z" fill="#cdd5d7" stroke="#58676d" stroke-width="4"/><path d="m42 75 23-13 23 13v52l-23 13-23-13Z" fill="#9caaae" stroke="#58676d" stroke-width="3"/></g>':id===2?'<g fill="none" stroke="#384747" stroke-width="17"><path d="M105 110c-10-75 220-75 220 0s-220 75-220 0 180-45 180 0-125 35-125 0"/><path d="M285 110h75M105 110H65"/></g><path d="M350 91h35v38h-35ZM45 90h30v40H45Z" fill="#a9b4b6" stroke="#58676d" stroke-width="3"/>':'<rect x="142" y="65" width="140" height="90" rx="38" fill="#cedbe0" stroke="#596e74" stroke-width="3"/><path d="M178 110h68" stroke="#8d652f" stroke-width="6"/><path d="M125 70h40v80h-40ZM260 70h40v80h-40Z" fill="#a7b4b8" stroke="#58676d" stroke-width="3"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 240"><rect width="440" height="240" rx="18" fill="#edf2ef"/>'+drawing+'<text x="220" y="224" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#52645a">Demo illustration · not a catalogue photo</text></svg>';
  }
  function json(body,status,headers){return new Response(JSON.stringify(body),{status:status||200,headers:Object.assign({'Content-Type':'application/json'},headers||{})});}
  function wait(ms,signal){return new Promise(function(resolve,reject){var timer=setTimeout(resolve,ms);if(signal?.aborted){clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));}else signal?.addEventListener('abort',function(){clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});}
  window.fetch=async function(input,init){
    init=init||{};var url=new RealURL(typeof input==='string'?input:input.url,'https://scratch.invalid'),path=url.pathname.replace(/^\/api/,''),method=init.method||'GET';
    var headers=new Headers(init.headers||{}),key=headers.get('Idempotency-Key'),body=init.body?JSON.parse(init.body):null;
    journal.push({method:method,path:path,key:key,body:body});await wait(transport==='slow'&&method!=='GET'?700:8,init.signal);
    if(path.match(/^\/inventory\/\d+\/image$/)){var photoId=Number(path.split('/')[2]);if(config.photo==='slow')await wait(1500,init.signal);if(config.photo==='failed'&&!confirmed)return json({error:'Fixture photo unavailable.'},503);return new Response(illustration(photoId),{headers:{'Content-Type':'image/svg+xml'}});}
    var job=path.match(/^\/job-orders\/(601|602)(\/availability)?$/);
    if(job){var first=job[1]==='601',parts=first?[{id:1,need:5,picked:1},{id:2,need:2,picked:0}]:[{id:1,need:3,picked:0},{id:3,need:2,picked:0}];if(!job[2])return json({id:Number(job[1]),number:'JO-DEMO-'+(first?'A':'B'),product_name:first?'Controller assembly':'Relay panel',qty_ordered:first?2:1,source_location_id:1,source_location_name:'Main'});return json({source_location_id:1,source_location_name:'Main',lines:parts.map(function(p){var have=stock[p.id][1].assembled,held=(p.id===1&&!first?1:0)+(config.reserved&&p.id===1?8:0);return{component_item_id:p.id,component_name:item(p.id).name,need:p.need,picked:p.picked,have:have,held_elsewhere:held,available:Math.max(0,have-held),short:Math.max(0,p.need-(have-held))};}),shortfalls:[]});}
    if(path==='/release-slips/orders/501/context'){
      var lines=config.request==='ckd'?[{id:901,item_id:90,name:'Controller component kit',quantity:2,fulfillment_mode:'ckd'},{id:902,item_id:91,name:'Relay panel component kit',quantity:1,fulfillment_mode:'ckd'},{id:903,item_id:1,name:item(1).name,quantity:5,parent_order_item_id:901,held_qty:1,fulfillment_mode:'ckd_component'},{id:904,item_id:2,name:item(2).name,quantity:2,parent_order_item_id:901,held_qty:0,fulfillment_mode:'ckd_component'},{id:905,item_id:1,name:item(1).name,quantity:3,parent_order_item_id:902,held_qty:0,fulfillment_mode:'ckd_component'},{id:906,item_id:3,name:item(3).name,quantity:2,parent_order_item_id:902,held_qty:0,fulfillment_mode:'ckd_component'}]:[{id:910,item_id:3,name:item(3).name,quantity:5,held_qty:0,fulfillment_mode:'assembled'}];
      return json({order:{id:501,number:'SO-DEMO-501',location_id:1,location_name:'Main'},lines:lines.map(function(l){return Object.assign({cancelled_qty:0,dispatched_qty:0,released_qty:0},l);}),availability:lines.filter(function(l){return l.fulfillment_mode!=='ckd';}).map(function(l){var have=stock[l.item_id][1].assembled,held=l.item_id===1?1:0;return{order_item_id:l.id,item_id:l.item_id,on_hand:have,free_to_allocate:Math.max(0,have-held-(config.reserved&&l.item_id===1?8:0))};})});
    }
    if(path==='/auth/me')return json({user:user});
    if(path==='/locations')return json(locations);
    if(path==='/users/me/work-shortcuts')return json({shortcuts:['scan']});
    if(path==='/notifications/unread-count')return json({count:0});
    if(path==='/messages/unread-count')return json({count:0});
    if(path==='/inventory/lookup'){var code=url.searchParams.get('code'),found=items.find(function(i){return i.sku===code;});if(code==='SERIAL-DEMO')return json(Object.assign({},item(3),{unit:{id:991,identifier:code}}));return found?json(item(found.id)):json({error:'No item matches this code.'},404);}
    if(path==='/inventory'&&method==='GET'){var q=(url.searchParams.get('q')||'').toLowerCase();return json(items.filter(function(i){return(i.name+' '+i.sku).toLowerCase().includes(q);}).map(function(i){return item(i.id);}));}
    var detail=path.match(/^\/inventory\/(\d+)(\/stock)?$/);
    if(detail&&method==='GET'){if(transport==='readfail')return json({error:'Fixture: current stock read is unavailable.'},503);return item(detail[1])?json(detail[2]?stockRows(detail[1]):item(detail[1])):json({error:'Item not found'},404);}
    if(path.startsWith('/sync/command/'))return json({state:confirmed?'confirmed':'local'});
    var adjustment=path.match(/^\/inventory\/(\d+)\/adjust$/);
    if(adjustment&&method==='POST'){
      if(config.role==='view')return json({error:'Stock adjustment permission required.'},403);
      if(transport==='offline')throw new TypeError('Fixture: interrupted write transport');
      if(receipts.has(key)){var prior=receipts.get(key);return json(prior.body,prior.status,prior.headers);}
      var id=Number(adjustment[1]),it=item(id),build=body.build_mode||'assembled',q=body.change,loc=body.location_id||1;
      if(!it||!stock[id][loc])return json({error:'Item or location not found.'},404);
      if(!Number.isSafeInteger(q)||q===0)return json({error:'Quantity must be a nonzero whole number.'},400);
      if(build==='semi_built'&&!it.is_finished_product)return json({error:'Semi-built stock is only for finished products.'},400);
      if(transport==='mixed'&&id===3&&q<0)stock[id][loc][build]=1;
      var after=stock[id][loc][build]+q;
      if(after<0){var refusal={body:{error:'Not enough stock at '+locations.find(function(l){return l.id===loc;}).name+'. Only '+stock[id][loc][build]+' available.'},status:400};receipts.set(key,refusal);return json(refusal.body,refusal.status);}
      stock[id][loc][build]=after;sequence++;
      var result={ok:true,quantity:item(id).quantity,location_quantity:after},extra=transport==='local'?{'X-Sync-State':'local','X-Sync-Command':'scratch-command-'+sequence}:{};
      receipts.set(key,{body:result,status:200,headers:extra});
      if(transport==='unknown'&&id===3)return json({error:'Fixture: response lost after applying this movement. Check the original request.'},503);
      if(transport==='incomplete'&&id===3)return json({ok:true});
      return json(result,200,extra);
    }
    return json({error:'This action is outside the isolated three-view preview.'},501);
  };
  var mode=config.view==='in'?'in':'out',route='batch-'+mode,now=Date.now();
  function draftRows(){return items.map(function(i,n){return{item:item(i.id),quantity:String(n===0?3:n===1?2:n===2?(mode==='in'?1:config.ready?2:5):1),build_mode:'assembled'};});}
  var rows=config.empty?[]:draftRows(),operation={kind:'workflow',route:route,state:'draft'};
  if(seeded){operation={kind:'workflow',route:route,state:'batch',mode:'out',location_id:1,location:'Main',note:'',created:now,entries:items.slice(0,3).map(function(i,n){var quantity=[3,2,5][n],key='scratch-seeded-row-'+i.id,result={ok:true,quantity:stock[i.id][1].assembled-quantity,location_quantity:stock[i.id][1].assembled-quantity};if(n<2){stock[i.id][1].assembled-=quantity;receipts.set(key,{body:result,status:200});}return{id:i.id,name:i.name,sku:i.sku,unit:i.unit,finished:!!i.is_finished_product,mode:'out',quantity:quantity,build_mode:'assembled',key:key,created:now,state:n<2?'confirmed':'refused',result:n<2?result:null,error:n===2?'Only 2 pcs remained when this row reached the server. No movement recorded.':null,path:'/inventory/'+i.id+'/adjust',payload:{change:-quantity,location_id:1,build_mode:'assembled',reason:null}};})};}
  window.__scratchReady=new Promise(function(resolve,reject){var open=indexedDB.open('vds_production_drafts',1);open.onupgradeneeded=function(){open.result.createObjectStore('drafts',{keyPath:'key'});};open.onerror=function(){reject(open.error);};open.onsuccess=function(){var db=open.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({key:JSON.stringify(['',1])+':workflow-'+route+':0:action',batch:{mode:mode,location_id:1,note:'',rows:rows},operation:operation,rows:[],revision:1});tx.oncomplete=function(){db.close();resolve();};tx.onerror=function(){reject(tx.error);};};});
  window.__scratch={inspect:function(){return structuredClone({config:config,transport:transport,stock:stock,journal:journal,receipts:Array.from(receipts.entries()),applied:sequence,user:user});},reconnect:function(){transport='normal';confirmed=true;window.dispatchEvent(new Event('online'));},setTransport:function(value){transport=value;}};
  location.hash='#/batch?mode='+mode;
})();
