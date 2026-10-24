/* Circular, movable Quick Orbit. Common actions plus account-scoped work shortcuts. */
(function(){
  var KEY='vds_m_orbit_v2',orbit,dialog=null,resting=null,pointer=null,moved=false;
  var setup=null,profileOwner=null,selection=null,profileRead=null;
  var startX=0,startY=0,baseX=0,baseY=0,oldOverflow='',appWasInert=false;
  var icon = function (body) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };
  var ACTIONS = {
    request: { label: 'New request', route: 'requests', params: { new: '1' }, icon: icon('<path d="M12 5v14M5 12h14"/>') },
    report: { label: 'Report issue', route: 'report-problem', icon: icon('<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>') },
    message: { label: 'New message', route: 'inbox', params: { new: '1' }, icon: icon('<path d="M4 5h16v12H8l-4 4V5Z"/><path d="M8 9h8M8 13h5"/>') },
    scan: { label: 'Scan item', route: 'scan', icon: icon('<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M4 12h16"/>') },
    jobs: { label: 'Job orders', route: 'job-orders', icon: icon('<path d="M9 4h6l1 3H8l1-3Z"/><rect x="3" y="7" width="18" height="13" rx="2"/>') },
    qc: { label: 'QC inspection', route: 'qc', params: {role:'qc'}, icon: icon('<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/>') },
    repairs: { label: 'Parts requests', route: 'repairs', icon: icon('<path d="m14 7 3-3 3 3-3 3"/><path d="M17 7 7 17M5 15l4 4"/>') },
    receiving: { label: 'Record RTS', route: 'receiving', icon: icon('<path d="M4 8h16v12H4zM8 4h8v4M8 13h8"/>') },
    kitscan: { label: 'Scan job order', route: 'kit-release', params: { scan: '1' }, icon: icon('<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><path d="M8 9h8v6H8z"/>') },
    release: { label: 'Release order', route: 'so', icon: icon('<path d="M3 6h13v11H3zM16 10h3l2 3v4h-5M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>') }
  };

  ACTIONS.qa={label:'QA inspection',route:'qc',params:{role:'qa'},icon:ACTIONS.qc.icon};
  ACTIONS.counts={label:'Stock counts',route:'stock-counts',icon:ACTIONS.jobs.icon};
  ACTIONS.purchasing={label:'Purchase requests',route:'purchase-requests',icon:ACTIONS.request.icon};
  ACTIONS.purchaseReceive={label:'Receive purchases',route:'receive',icon:ACTIONS.receiving.icon};
  ACTIONS.deliveries={label:'My deliveries',route:'deliveries',icon:ACTIONS.release.icon};
  var WORK={
    qc:['production.inspect_qc'],qa:['production.inspect_qa','production.qa_review'],
    repairs:['production.repairs'],jobs:['production.record','production.manage','production.pause','production.approve'],
    receiving:['production.receive'],kitscan:['production.kit_release'],release:['orders.release'],scan:['inventory.mobile'],counts:['inventory.count'],
    purchasing:['purchasing.request','purchasing.manage','purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'],purchaseReceive:['inventory.receive'],deliveries:['delivery.run']
  };
  function workOptions(){return Object.keys(WORK).filter(function(id){return WORK[id].some(function(p){return MApp.can(p);})&&MApp.canOpen(ACTIONS[id].route);});}
  function owner(){var me=MApp.getMe?.();return me?.id!=null&&window.API?JSON.stringify([API.base?.(),me.id,API.isSharedSession?.()]):null;}
  function identity(){return window.mReadScope?mReadScope.identity():JSON.stringify([owner(),window.API?.getToken?.(),MApp.getMe?.()?.permissions,MApp.getMe?.()?.modules]);}
  function storage(){return API.isSharedSession?.()?sessionStorage:localStorage;}
  function valid(ids){return Array.isArray(ids)&&ids.length>=1&&ids.length<=2&&new Set(ids).size===ids.length&&ids.every(function(id){return Object.prototype.hasOwnProperty.call(WORK,id);});}
  function cache(ids){try{storage().setItem('vds_m_work_shortcuts:'+profileOwner,JSON.stringify(ids));}catch(e){}}
  function loadProfile(){
    var next=owner();if(next===profileOwner)return;
    profileRead?.abort();profileRead=null;profileOwner=next;selection=null;
    if(!next)return;
    try{var saved=JSON.parse(storage().getItem('vds_m_work_shortcuts:'+next));if(valid(saved))selection=saved;}catch(e){}
    var controller=new AbortController(),captured=identity(),timer=setTimeout(function(){controller.abort();},12000);profileRead=controller;
    Promise.resolve().then(function(){return API.get('/mobile/quick-actions',{signal:controller.signal,isCurrent:function(){return !controller.signal.aborted&&captured===identity();}});}).then(function(p){
      if(controller.signal.aborted||captured!==identity()||(!valid(p?.shortcuts)&&p?.shortcuts!==null))return;
      selection=p.shortcuts;cache(selection);if(!dialog&&!setup)renderActions();
    }).catch(function(){/* Cached choices or the permitted recommendation remain usable offline. */}).finally(function(){clearTimeout(timer);if(profileRead===controller)profileRead=null;});
  }
  function available(){
    var ids=['request','report'];if(MApp.can('messages.send')&&MApp.canOpen('inbox'))ids.push('message');
    var options=workOptions(),chosen=selection===null?options.slice(0,1):selection.filter(function(id){return options.includes(id);});
    return ids.concat(chosen).map(function(id){return Object.assign({id:id},ACTIONS[id]);});
  }
  function close(){if(setup)setup.close();if(dialog)dialog.close();}
  function renderActions(){
    if(!orbit||!window.MApp)return;close();loadProfile();
    orbit.querySelector('.v2-orbit-menu').innerHTML=available().map(function(a){return '<button class="v2-orbit-action" type="button" data-action="'+a.id+'" data-route="'+a.route+'"'+(a.params?' data-params=\''+JSON.stringify(a.params)+'\'':'')+'><span class="v2-orbit-icon" aria-hidden="true">'+a.icon+'</span><span class="v2-orbit-label">'+a.label+'</span></button>';}).join('');
    orbit.querySelectorAll('.v2-orbit-action').forEach(function(button){button.onclick=function(){
      if(!dialog)return;
      var action=available().find(function(a){return a.id===button.dataset.action;});
      if(!action||!MApp.canOpen(action.route)){close();renderActions();return;}
      close();MApp.go(action.route,action.params||null);
    };});syncVisibility();
  }
  function editShortcuts(){
    close();var options=workOptions(),captured=identity(),app=document.getElementById('m-app'),wasInert=!!app?.inert,overflow=document.body.style.overflow;
    var layer=document.createElement('div');layer.className='v2-orbit-overlay v2-orbit-settings';layer.setAttribute('aria-labelledby','orbit-settings-title');
    layer.innerHTML='<div class="v2-orbit-backdrop" aria-hidden="true"></div><form class="v2-orbit-settings-card"><h2 id="orbit-settings-title">Your work shortcuts</h2><p>Keep the common actions. Add one or two shortcuts for the work you do most.</p><label for="orbit-first">First shortcut</label><select id="orbit-first" required></select><label for="orbit-second">Second shortcut <span>(optional)</span></label><select id="orbit-second"><option value="">None</option></select><p class="v2-orbit-settings-status" role="status" aria-live="polite"></p><div class="v2-orbit-settings-buttons"><button type="button" class="m-btn m-btn-secondary" data-cancel>Cancel</button><button type="submit" class="m-btn">Save shortcuts</button></div></form>';
    var first=layer.querySelector('#orbit-first'),second=layer.querySelector('#orbit-second'),status=layer.querySelector('[role="status"]'),save=layer.querySelector('[type="submit"]');
    options.forEach(function(id){[first,second].forEach(function(select){var o=document.createElement('option');o.value=id;o.textContent=ACTIONS[id].label;select.appendChild(o);});});
    var chosen=available().map(function(a){return a.id;}).filter(function(id){return options.includes(id);});first.value=chosen[0]||options[0]||'';second.value=chosen[1]||'';
    function distinct(){Array.from(second.options).forEach(function(o){o.disabled=o.value!==''&&o.value===first.value;});if(second.value===first.value)second.value='';}
    first.onchange=distinct;distinct();
    if(!options.length){status.textContent='No work shortcuts are available for your current access.';save.disabled=true;first.disabled=true;second.disabled=true;}
    else if(!owner()){status.textContent='Sign in to save your work shortcuts.';save.disabled=true;}
    document.body.appendChild(layer);document.body.style.overflow='hidden';if(app)app.inert=true;
    setup=MessageOverlay.mount(layer,{initialFocus:options.length?'#orbit-first':'[data-cancel]',onClose:function(){setup=null;document.body.style.overflow=overflow;if(app)app.inert=wasInert;syncVisibility();}});
    layer.querySelector('[data-cancel]').onclick=close;layer.querySelector('.v2-orbit-backdrop').onclick=close;
    layer.querySelector('form').onsubmit=async function(e){
      e.preventDefault();if(save.disabled)return;
      var ids=[first.value];if(second.value)ids.push(second.value);
      if(!valid(ids)||ids.some(function(id){return !workOptions().includes(id);})||captured!==identity()){status.textContent='Your access changed. Close this window and choose again.';return;}
      profileRead?.abort();profileRead=null;save.disabled=true;first.disabled=true;second.disabled=true;status.textContent='Saving shortcuts…';
      var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},12000);
      try{
        var result=await API.put('/mobile/quick-actions',{shortcuts:ids},{signal:controller.signal,isCurrent:function(){return captured===identity();}});
        if(captured!==identity())return;
        if(!valid(result?.shortcuts))throw new Error('Could not confirm the saved shortcuts. Please try again.');
        selection=result.shortcuts;cache(selection);
        if(!layer.isConnected){renderActions();return;}
        if(API.syncLocal?.(result)){status.textContent='Saved on this site PC. Sync to your other devices is pending.';save.textContent='Saved';layer.querySelector('[data-cancel]').textContent='Done';}
        else{close();renderActions();}
      }catch(error){if(captured!==identity()||!layer.isConnected)return;status.textContent=error.message||'Could not save. Check your connection and try again.';save.disabled=false;first.disabled=false;second.disabled=false;}finally{clearTimeout(timer);}
    };
  }
  function positionEditor(){
    var button=document.querySelector('.v2-orbit-edit');if(!button)return;
    var v=viewport(),rects=Array.from(orbit.querySelectorAll('button')).map(function(b){var r=b.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});
    button.classList.remove('icon-only');var w=144,h=44;
    function find(){return [[v.x+12,v.y+v.h-h-12],[v.x+v.w-w-12,v.y+v.h-h-12],[v.x+12,v.y+12],[v.x+v.w-w-12,v.y+12]].find(function(p){return !rects.some(function(r){return p[0]<r.right+8&&p[0]+w>r.left-8&&p[1]<r.bottom+8&&p[1]+h>r.top-8;});});}
    var p=find();if(!p){w=44;button.classList.add('icon-only');p=find()||[v.x+12,v.y+12];}
    button.style.left=p[0]+'px';button.style.top=p[1]+'px';
  }
  function viewport(){var v=window.visualViewport;return {x:v?.offsetLeft||0,y:v?.offsetTop||0,w:v?.width||window.innerWidth,h:v?.height||window.innerHeight};}
  function clamp(x,y){
    var v=viewport(),r=orbit.getBoundingClientRect(),w=r.width||56,h=r.height||56;
    return {x:Math.max(v.x+8,Math.min(v.x+v.w-w-8,x)),y:Math.max(v.y+Math.min(76,Math.max(8,v.h-h-8)),Math.min(v.y+v.h-h-Math.min(104,Math.max(8,v.h-h-84)),y))};
  }
  function position(x,y){orbit.style.left=x+'px';orbit.style.top=y+'px';orbit.style.right='auto';orbit.style.bottom='auto';}
  function persist(p){try{localStorage.setItem(KEY,JSON.stringify({x:p.x/window.innerWidth,y:p.y/window.innerHeight}));}catch(e){}}
  function place(x,y,save){var p=clamp(x,y);if(dialog){resting=p;layout();}else position(p.x,p.y);if(save)persist(p);}
  function restore(){try{var p=JSON.parse(localStorage.getItem(KEY)||'null');if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))place(p.x*window.innerWidth,p.y*window.innerHeight,false);}catch(e){}}
  function snap(){var r=orbit.getBoundingClientRect(),v=viewport(),x=r.left+r.width/2<v.x+v.w/2?v.x+8:v.x+v.w-r.width-8;place(x,r.top,true);}
  function layout(){
    var menu=orbit.querySelector('.v2-orbit-menu'),buttons=Array.from(menu.querySelectorAll('button')),v=viewport(),r=orbit.getBoundingClientRect(),size=r.width||56;
    var width=Math.max(96,...buttons.map(function(b){return b.offsetWidth;})),height=Math.max(80,...buttons.map(function(b){return b.offsetHeight;}));
    var angles=buttons.length===5?[-75,-37.5,0,37.5,75]:buttons.length===4?[-75,-25,25,75]:buttons.length===3?[-75,0,75]:[-55,55];
    var radius=buttons.length===5?Math.max(148,(width+8)/.5345,(height+8)/.6088):buttons.length===4?Math.max(148,(width+8)/(.9063-.2588),(height+8)/(.8452)):Math.max(132,(width+8)/.7412);
    var half=radius*Math.sin(75*Math.PI/180)+height/2+12,reach=radius+width/2+12;
    var horizontalRadius=buttons.length===5?Math.max(148,(height+8)/.5345,(width+8)/.6088):buttons.length===4?Math.max(148,(height+8)/.6475,(width+8)/.8452):Math.max(132,(height+8)/.7412);
    var horizontalHalf=horizontalRadius*Math.sin(75*Math.PI/180)+width/2+12,horizontalReach=horizontalRadius+height/2+12;
    var horizontal=v.h<half*2&&v.w>=horizontalHalf*2&&v.h>=horizontalReach+size/2+24;
    var compact=!horizontal&&(v.h<half*2||v.w<reach+size/2+12);
    orbit.classList.toggle('is-horizontal',horizontal);orbit.classList.toggle('is-compact',compact);
    if(compact){
      position(v.x+(v.w-size)/2,v.y+v.h-size-12);
      menu.style.left=(v.x+12)+'px';menu.style.top=(v.y+12)+'px';menu.style.width=Math.max(0,v.w-24)+'px';menu.style.top=(v.y+68)+'px';menu.style.height=Math.max(44,v.h-size-92)+'px';menu.style.gridTemplateColumns=v.w<228?'88px':v.w<300?'repeat(2,88px)':'repeat(3,88px)';
      positionEditor();return;
    }
    menu.removeAttribute('style');
    if(horizontal){
      var hx=Math.max(v.x+horizontalHalf,Math.min(v.x+v.w-horizontalHalf,resting.x+size/2)),up=resting.y+size/2>=v.y+v.h/2;
      var hy=up?Math.max(v.y+horizontalReach,Math.min(v.y+v.h-size/2-12,resting.y+size/2)):Math.max(v.y+size/2+12,Math.min(v.y+v.h-horizontalReach,resting.y+size/2));
      position(hx-size/2,hy-size/2);buttons.forEach(function(b,i){var a=angles[i]*Math.PI/180;b.style.left=(size/2+horizontalRadius*Math.sin(a))+'px';b.style.top=(size/2+(up?-1:1)*horizontalRadius*Math.cos(a))+'px';});positionEditor();return;
    }
    var centerX=resting.x+size/2,side=centerX<v.x+v.w/2?1:-1;
    centerX=side===1?Math.min(centerX,v.x+v.w-reach):Math.max(centerX,v.x+reach);
    centerX=Math.max(v.x+size/2+8,Math.min(v.x+v.w-size/2-8,centerX));
    var centerY=Math.max(v.y+half,Math.min(v.y+v.h-half,resting.y+size/2));
    position(centerX-size/2,centerY-size/2);
    buttons.forEach(function(b,i){var angle=angles[i]*Math.PI/180;b.style.left=(size/2+side*radius*Math.cos(angle))+'px';b.style.top=(size/2+radius*Math.sin(angle))+'px';});positionEditor();
  }
  function open(){
    if(dialog||orbit.hidden||!window.MessageOverlay)return;renderActions();if(orbit.hidden)return;
    var r=orbit.getBoundingClientRect(),menu=orbit.querySelector('.v2-orbit-menu'),handle=orbit.querySelector('.v2-orbit-handle'),app=document.getElementById('m-app');
    resting=clamp(r.left,r.top);var layer=document.createElement('div');layer.className='v2-orbit-overlay';layer.setAttribute('aria-label','Quick actions');
    layer.innerHTML='<div class="v2-orbit-backdrop" aria-hidden="true"></div><button type="button" class="v2-orbit-edit" aria-label="Edit work shortcuts"><span aria-hidden="true">⚙</span><span class="v2-orbit-edit-text">Edit shortcuts</span></button>';document.body.appendChild(layer);layer.appendChild(orbit);
    menu.hidden=false;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';appWasInert=!!app?.inert;if(app)app.inert=true;
    handle.setAttribute('aria-expanded','true');handle.setAttribute('aria-label','Close quick actions');layout();
    handle.focus({preventScroll:true});
    dialog=MessageOverlay.mount(layer,{initialFocus:'.v2-orbit-action',onClose:function(){
      dialog=null;document.body.appendChild(orbit);orbit.classList.remove('open','is-compact','is-horizontal');menu.hidden=true;menu.removeAttribute('style');
      handle.setAttribute('aria-expanded','false');handle.setAttribute('aria-label','Open or move quick actions');
      document.body.style.overflow=oldOverflow;if(app)app.inert=appWasInert;
      if(resting){var p=clamp(resting.x,resting.y);position(p.x,p.y);}resting=null;
    }});
    layer.querySelector('.v2-orbit-backdrop').onclick=close;layer.querySelector('.v2-orbit-edit').onclick=editShortcuts;
    layer.addEventListener('keydown',function(e){if(e.altKey||e.target.closest('.v2-orbit-edit'))return;var buttons=Array.from(menu.querySelectorAll('button')),index=buttons.indexOf(document.activeElement),next;
      if(['ArrowDown','ArrowRight'].includes(e.key))next=(index+1)%buttons.length;
      if(['ArrowUp','ArrowLeft'].includes(e.key))next=(index+buttons.length-1)%buttons.length;
      if(e.key==='Home')next=0;if(e.key==='End')next=buttons.length-1;
      if(next!=null){e.preventDefault();buttons[next].focus();}
    });
    requestAnimationFrame(function(){if(dialog){orbit.classList.add('open');positionEditor();}});
  }
  function syncVisibility(){
    if(!orbit)return;if(setup){if(profileOwner!==owner()||document.getElementById('m-app')?.matches('.hidden,[hidden]'))close();else return;}var app=document.getElementById('m-app'),entry=document.activeElement,keyboard=!!(entry&&/^(INPUT|TEXTAREA|SELECT)$/.test(entry.tagName))||!!(window.visualViewport&&window.visualViewport.height<window.innerHeight*.72);
    var hidden=keyboard||!!app?.matches('.hidden,[hidden]')||document.body.classList.contains('m-chat-thread-active')||document.body.classList.contains('personal-editor-open');
    if(hidden)close();orbit.classList.toggle('is-keyboard',keyboard);if(orbit.hidden!==hidden)orbit.hidden=hidden;
  }
  function init(){
    if(document.getElementById('v2-quick-orbit'))return;
    orbit=document.createElement('div');orbit.id='v2-quick-orbit';orbit.className='v2-orbit';
    orbit.innerHTML='<div id="v2-orbit-menu" class="v2-orbit-menu" role="group" aria-label="Quick action shortcuts" hidden></div><button class="v2-orbit-handle" type="button" aria-expanded="false" aria-haspopup="dialog" aria-controls="v2-orbit-menu" aria-describedby="v2-orbit-hint" aria-label="Open or move quick actions"><span class="v2-orbit-grip" aria-hidden="true">⋮⋮</span><span class="v2-orbit-plus" aria-hidden="true">+</span></button><span class="v2-orbit-hint" id="v2-orbit-hint">Drag to move. Alt and arrow keys move the shortcut with a keyboard.</span>';
    document.body.appendChild(orbit);renderActions();restore();var handle=orbit.querySelector('.v2-orbit-handle');
    handle.addEventListener('pointerdown',function(e){if(e.button!==0||e.isPrimary===false||pointer!=null)return;pointer=e.pointerId;moved=false;startX=e.clientX;startY=e.clientY;var r=orbit.getBoundingClientRect();baseX=r.left;baseY=r.top;try{handle.setPointerCapture?.(e.pointerId);}catch(error){}});
    handle.addEventListener('pointermove',function(e){if(pointer!==e.pointerId)return;var dx=e.clientX-startX,dy=e.clientY-startY;if(Math.hypot(dx,dy)>6)moved=true;if(moved){orbit.classList.add('is-dragging');place(baseX+dx,baseY+dy,false);}});
    function end(e){if(pointer!==e.pointerId)return;if(moved)snap();pointer=null;orbit.classList.remove('is-dragging');}
    handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',function(e){end(e);moved=true;});handle.addEventListener('lostpointercapture',end);
    handle.addEventListener('click',function(e){if(moved&&e.detail!==0){moved=false;return;}moved=false;if(dialog)close();else open();});
    handle.addEventListener('keydown',function(e){if(!e.altKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();var r=orbit.getBoundingClientRect(),v=viewport();place(e.key==='ArrowLeft'?v.x+8:e.key==='ArrowRight'?v.x+v.w-r.width-8:r.left,r.top+(e.key==='ArrowUp'?-24:e.key==='ArrowDown'?24:0),true);});
    document.addEventListener('focusin',syncVisibility);document.addEventListener('focusout',function(){setTimeout(syncVisibility,0);});
    window.addEventListener('resize',function(){if(dialog){resting=clamp(resting.x,resting.y);layout();}else restore();syncVisibility();});
    window.visualViewport?.addEventListener('resize',function(){if(dialog)layout();syncVisibility();});
    window.addEventListener('hashchange',function(){close();renderActions();});window.addEventListener('pagehide',close);
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')close();});
    var observer=new MutationObserver(syncVisibility);observer.observe(document.body,{attributes:true,attributeFilter:['class']});var app=document.getElementById('m-app');if(app)observer.observe(app,{attributes:true,attributeFilter:['class','hidden']});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  window.mQuickOrbit={refresh:renderActions,close:close};
})();
