/* Circular, movable Quick Orbit. Existing actions and role routing are preserved. */
(function(){
  var KEY='vds_m_orbit_v2',orbit,dialog=null,resting=null,pointer=null,moved=false;
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
    qc: { label: 'Inspect unit', route: 'qc', icon: icon('<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/>') },
    repairs: { label: 'Parts requests', route: 'repairs', icon: icon('<path d="m14 7 3-3 3 3-3 3"/><path d="M17 7 7 17M5 15l4 4"/>') },
    receiving: { label: 'Record RTS', route: 'receiving', icon: icon('<path d="M4 8h16v12H4zM8 4h8v4M8 13h8"/>') },
    kitscan: { label: 'Scan job order', route: 'kit-release', params: { scan: '1' }, icon: icon('<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><path d="M8 9h8v6H8z"/>') },
    release: { label: 'Release order', route: 'so', icon: icon('<path d="M3 6h13v11H3zM16 10h3l2 3v4h-5M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>') }
  };

  function roleAction() {
    if (!window.MApp) return null;
    if ((MApp.can('production.inspect_qc') || MApp.can('production.inspect_qa')) && MApp.canOpen(ACTIONS.qc.route)) return ACTIONS.qc;
    if ((MApp.can('production.repairs')) && MApp.canOpen(ACTIONS.repairs.route)) return ACTIONS.repairs;
    if ((MApp.can('production.record')) && MApp.canOpen(ACTIONS.jobs.route)) return ACTIONS.jobs;
    if ((MApp.can('production.receive')) && MApp.canOpen(ACTIONS.receiving.route)) return ACTIONS.receiving;
    if ((MApp.can('orders.release')) && MApp.canOpen(ACTIONS.release.route)) return ACTIONS.release;
    // Warehouse: Figma 62:372 — the job-order scan shortcut into kit release.
    if ((MApp.can('production.kit_release')) && MApp.canOpen(ACTIONS.kitscan.route)) return ACTIONS.kitscan;
    if ((MApp.can('inventory.mobile')) && MApp.canOpen(ACTIONS.scan.route)) return ACTIONS.scan;
    return null;
  }

  function available(){
    var actions=[ACTIONS.request,ACTIONS.report];
    if(MApp.can('messages.send'))actions.push(ACTIONS.message);
    var role=roleAction();if(role)actions.push(role);return actions;
  }
  function close(){if(dialog)dialog.close();}
  function renderActions(){
    if(!orbit||!window.MApp)return;close();
    orbit.querySelector('.v2-orbit-menu').innerHTML=available().map(function(a){return '<button class="v2-orbit-action" type="button" data-route="'+a.route+'"'+(a.params?' data-params=\''+JSON.stringify(a.params)+'\'':'')+'><span class="v2-orbit-icon" aria-hidden="true">'+a.icon+'</span><span class="v2-orbit-label">'+a.label+'</span></button>';}).join('');
    orbit.querySelectorAll('.v2-orbit-action').forEach(function(button){button.onclick=function(){
      if(!dialog)return;
      var action=available().find(function(a){return a.route===button.dataset.route;});
      if(!action||!MApp.canOpen(action.route)){close();renderActions();return;}
      close();MApp.go(action.route,action.params||null);
    };});
    syncVisibility();
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
    var angles=buttons.length===4?[-75,-25,25,75]:buttons.length===3?[-75,0,75]:[-55,55];
    var radius=buttons.length===4?Math.max(148,(width+8)/(.9063-.2588),(height+8)/(.8452)):Math.max(132,(width+8)/.7412);
    var half=radius*Math.sin(75*Math.PI/180)+height/2+12,reach=radius+width/2+12;
    var horizontalRadius=buttons.length===4?Math.max(148,(height+8)/.6475,(width+8)/.8452):Math.max(132,(height+8)/.7412);
    var horizontalHalf=horizontalRadius*Math.sin(75*Math.PI/180)+width/2+12,horizontalReach=horizontalRadius+height/2+12;
    var horizontal=v.h<half*2&&v.w>=horizontalHalf*2&&v.h>=horizontalReach+size/2+24;
    var compact=!horizontal&&(v.h<half*2||v.w<reach+size/2+12);
    orbit.classList.toggle('is-horizontal',horizontal);orbit.classList.toggle('is-compact',compact);
    if(compact){
      position(v.x+(v.w-size)/2,v.y+v.h-size-12);
      menu.style.left=(v.x+12)+'px';menu.style.top=(v.y+12)+'px';menu.style.width=Math.max(0,v.w-24)+'px';menu.style.height=Math.max(44,v.h-size-36)+'px';menu.style.gridTemplateColumns=v.w<228?'96px':'repeat(2,96px)';
      return;
    }
    menu.removeAttribute('style');
    if(horizontal){
      var hx=Math.max(v.x+horizontalHalf,Math.min(v.x+v.w-horizontalHalf,resting.x+size/2)),up=resting.y+size/2>=v.y+v.h/2;
      var hy=up?Math.max(v.y+horizontalReach,Math.min(v.y+v.h-size/2-12,resting.y+size/2)):Math.max(v.y+size/2+12,Math.min(v.y+v.h-horizontalReach,resting.y+size/2));
      position(hx-size/2,hy-size/2);buttons.forEach(function(b,i){var a=angles[i]*Math.PI/180;b.style.left=(size/2+horizontalRadius*Math.sin(a))+'px';b.style.top=(size/2+(up?-1:1)*horizontalRadius*Math.cos(a))+'px';});return;
    }
    var centerX=resting.x+size/2,side=centerX<v.x+v.w/2?1:-1;
    centerX=side===1?Math.min(centerX,v.x+v.w-reach):Math.max(centerX,v.x+reach);
    centerX=Math.max(v.x+size/2+8,Math.min(v.x+v.w-size/2-8,centerX));
    var centerY=Math.max(v.y+half,Math.min(v.y+v.h-half,resting.y+size/2));
    position(centerX-size/2,centerY-size/2);
    buttons.forEach(function(b,i){var angle=angles[i]*Math.PI/180;b.style.left=(size/2+side*radius*Math.cos(angle))+'px';b.style.top=(size/2+radius*Math.sin(angle))+'px';});
  }
  function open(){
    if(dialog||orbit.hidden||!window.MessageOverlay)return;
    var r=orbit.getBoundingClientRect(),menu=orbit.querySelector('.v2-orbit-menu'),handle=orbit.querySelector('.v2-orbit-handle'),app=document.getElementById('m-app');
    resting=clamp(r.left,r.top);var layer=document.createElement('div');layer.className='v2-orbit-overlay';layer.setAttribute('aria-label','Quick actions');
    layer.innerHTML='<div class="v2-orbit-backdrop" aria-hidden="true"></div>';document.body.appendChild(layer);layer.appendChild(orbit);
    menu.hidden=false;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';appWasInert=!!app?.inert;if(app)app.inert=true;
    handle.setAttribute('aria-expanded','true');handle.setAttribute('aria-label','Close quick actions');layout();
    handle.focus({preventScroll:true});
    dialog=MessageOverlay.mount(layer,{initialFocus:'.v2-orbit-action',onClose:function(){
      dialog=null;document.body.appendChild(orbit);orbit.classList.remove('open','is-compact','is-horizontal');menu.hidden=true;menu.removeAttribute('style');
      handle.setAttribute('aria-expanded','false');handle.setAttribute('aria-label','Open or move quick actions');
      document.body.style.overflow=oldOverflow;if(app)app.inert=appWasInert;
      if(resting){var p=clamp(resting.x,resting.y);position(p.x,p.y);}resting=null;
    }});
    layer.querySelector('.v2-orbit-backdrop').onclick=close;
    layer.addEventListener('keydown',function(e){if(e.altKey)return;var buttons=Array.from(menu.querySelectorAll('button')),index=buttons.indexOf(document.activeElement),next;
      if(['ArrowDown','ArrowRight'].includes(e.key))next=(index+1)%buttons.length;
      if(['ArrowUp','ArrowLeft'].includes(e.key))next=(index+buttons.length-1)%buttons.length;
      if(e.key==='Home')next=0;if(e.key==='End')next=buttons.length-1;
      if(next!=null){e.preventDefault();buttons[next].focus();}
    });
    requestAnimationFrame(function(){if(dialog)orbit.classList.add('open');});
  }
  function syncVisibility(){
    if(!orbit)return;var app=document.getElementById('m-app'),entry=document.activeElement,keyboard=!!(entry&&/^(INPUT|TEXTAREA|SELECT)$/.test(entry.tagName))||!!(window.visualViewport&&window.visualViewport.height<window.innerHeight*.72);
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
