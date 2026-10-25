/* Shared mobile presentation. Native form controls and workflow handlers remain
   the source of values/validation. Refresh is explicitly limited to read views. */
(function () {
  var controls=new WeakMap(),menus=new Set(),disclosures=new WeakMap(),sequence=0,openControl=null,refreshBinding=null,refreshing=false,refreshEpoch=0,gesture=null,indicator,refreshButton,frame;
  var reduced=function(){return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;};
  var ease='cubic-bezier(.22,1,.36,1)';
  function animate(element,frames,duration,instant){
    if(instant||reduced()||!element.animate)return null;
    return element.animate(frames,{duration:duration,easing:ease,fill:'both'});
  }
  function enhanceSelect(select){
    if(controls.has(select)||select.multiple||select.size>1||select.closest('[data-native-select]'))return;
    var wrapper=document.createElement('span'),menu=document.createElement('div'),anchor=select.closest('.rk-field')||wrapper,id='m-select-'+(++sequence),opened=false,active=0,items=[],events,motion,typed='',typedAt=0;
    var control={select:select,menu:menu,close:close};controls.set(select,control);menus.add(control);wrapper.className='m-select-wrap';select.before(wrapper);wrapper.appendChild(select);
    select.classList.add('m-select-control');anchor.classList.add('m-select-anchor');
    var label=select.labels?.[0],caption=label?.querySelector('small,.m-label');
    if(!select.hasAttribute('aria-label')&&!select.hasAttribute('aria-labelledby')&&caption){caption.id=caption.id||id+'-label';select.setAttribute('aria-labelledby',caption.id);}
    else if(!select.hasAttribute('aria-label')&&!select.hasAttribute('aria-labelledby')&&label){var labelCopy=label.cloneNode(true);labelCopy.querySelectorAll('select,input,.m-select-wrap').forEach(function(el){el.remove();});if(labelCopy.textContent.trim())select.setAttribute('aria-label',labelCopy.textContent.trim());}
    menu.className='m-select-menu';menu.id=id;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',caption?.textContent||select.getAttribute('aria-label')||'Options');menu.hidden=true;document.body.appendChild(menu);
    select.setAttribute('aria-controls',id);select.setAttribute('aria-expanded','false');
    function place(){
      var rect=anchor.getBoundingClientRect(),dock=document.querySelector('#m-tabbar')?.getBoundingClientRect(),header=document.querySelector('.m-topbar')?.getBoundingClientRect(),bottom=Math.min(window.visualViewport?.height||innerHeight,dock?.height?dock.top:innerHeight)-12,above=rect.top-(header?.bottom||0)-12,below=bottom-rect.bottom,up=below<176&&above>below;
      menu.classList.toggle('opens-above',up);menu.style.maxHeight=Math.max(44,Math.min(312,up?above:below))+'px';menu.style.position='fixed';menu.style.left=rect.left+'px';menu.style.right='auto';menu.style.width=rect.width+'px';menu.style.top=up?'auto':rect.bottom+6+'px';menu.style.bottom=up?innerHeight-rect.top+6+'px':'auto';
    }
    function highlight(index,scroll){
      if(!items.length)return;active=(index+items.length)%items.length;
      items.forEach(function(item,i){item.el.classList.toggle('is-active',i===active);});
      select.setAttribute('aria-activedescendant',items[active].el.id);if(scroll)items[active].el.scrollIntoView({block:'nearest'});
    }
    function choose(item,instant){
      if(select.disabled||item.option.disabled||item.option.parentElement?.disabled)return;
      var changed=select.value!==item.option.value;select.value=item.option.value;close(instant);select.focus({preventScroll:true});
      if(changed){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
    }
    function populate(){
      menu.replaceChildren();items=[];
      Array.from(select.options).forEach(function(option,index){
        if(option.hidden)return;var item=document.createElement('div');item.id=id+'-'+index;item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.textContent=option.textContent;
        var disabled=option.disabled||option.parentElement?.disabled;item.setAttribute('aria-disabled',String(!!disabled));menu.appendChild(item);
        if(disabled)return;var record={el:item,option:option};items.push(record);
        item.onpointerdown=function(e){e.preventDefault();};item.onclick=function(e){e.preventDefault();e.stopPropagation();choose(record,e.detail===0);};
      });
    }
    function close(instant){
      if(!opened)return;opened=false;events?.abort();motion?.cancel();select.setAttribute('aria-expanded','false');select.removeAttribute('aria-activedescendant');menu.setAttribute('aria-hidden','true');menu.classList.add('is-closing');if(openControl?.select===select)openControl=null;
      var finish=function(){if(opened)return;menu.hidden=true;menu.classList.remove('is-closing');menu.removeAttribute('aria-hidden');anchor.classList.remove('is-select-open');motion?.cancel();motion=null;};
      motion=animate(menu,[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-2px)'}],95,instant);
      if(motion)motion.finished.then(finish).catch(function(){});else finish();
    }
    function open(instant,index){
      if(select.disabled||!select.isConnected)return;openControl?.close(true);motion?.cancel();opened=true;populate();menu.hidden=false;menu.classList.remove('is-closing');menu.removeAttribute('aria-hidden');anchor.classList.add('is-select-open');select.setAttribute('aria-expanded','true');openControl={select:select,close:close};
      events=new AbortController();document.addEventListener('pointerdown',function(e){if(!anchor.contains(e.target)&&!menu.contains(e.target))close();},{signal:events.signal});window.addEventListener('resize',place,{signal:events.signal});window.visualViewport?.addEventListener('resize',place,{signal:events.signal});window.addEventListener('scroll',function(e){if(e.target!==menu&&!menu.contains(e.target))close(true);},{capture:true,signal:events.signal});
      place();highlight(index==null?Math.max(0,items.findIndex(function(item){return item.option.selected;})):index,true);
      motion=animate(menu,[{opacity:0,transform:'translateY(-4px)'},{opacity:1,transform:'translateY(0)'}],150,instant);
    }
    select.addEventListener('pointerdown',function(e){if(e.button>0)return;e.preventDefault();select.focus({preventScroll:true});});
    select.addEventListener('mousedown',function(e){e.preventDefault();});
    select.addEventListener('click',function(e){e.preventDefault();if(opened)close(e.detail===0);else open(e.detail===0);});
    select.addEventListener('blur',function(){close(document.documentElement.dataset.inputMethod==='keyboard');});
    select.addEventListener('change',function(){close(true);});
    select.addEventListener('keydown',function(e){
      if(select.disabled)return;if(e.key==='Tab'){close(true);return;}if(e.key==='Escape'){if(opened){e.preventDefault();e.stopPropagation();close(true);}return;}
      if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(e.key)){
        e.preventDefault();if(!opened){open(true,e.key==='Home'?0:e.key==='End'?Array.from(select.options).filter(function(o){return !o.hidden&&!o.disabled&&!o.parentElement?.disabled;}).length-1:undefined);return;}
        if(e.key==='Enter'||e.key===' '){if(items[active])choose(items[active],true);}else highlight(e.key==='Home'?0:e.key==='End'?items.length-1:active+(e.key==='ArrowDown'?1:-1),true);return;
      }
      if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();var now=Date.now();typed=now-typedAt>700?e.key:typed+e.key;typedAt=now;if(!opened)open(true);var found=items.findIndex(function(item){return item.option.textContent.toLowerCase().startsWith(typed.toLowerCase());});if(found>=0)highlight(found,true);}
    });
  }
  function enhanceDetails(details){
    if(disclosures.has(details))return;var summary=details.querySelector(':scope>summary');if(!summary)return;var animations=[],target=details.open,version=0;
    disclosures.set(details,true);
    summary.addEventListener('click',function(e){
      if(e.target.closest('a,button,input,select'))return;e.preventDefault();var run=++version;
      // Queue reads can change open after enhancement. Start from that real
      // state when idle; retain the intended target while reversing motion.
      target=!(animations.length?target:details.open);animations.forEach(function(a){a.cancel();});animations=[];
      if(target)details.open=true;
      var children=Array.from(details.children).filter(function(child){return child!==summary;});
      children.forEach(function(child){var a=animate(child,target?[{opacity:0,transform:'translateY(-3px)'},{opacity:1,transform:'translateY(0)'}]:[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-2px)'}],target?140:90,e.detail===0);if(a)animations.push(a);});
      if(!animations.length){details.open=target;return;}Promise.allSettled(animations.map(function(a){return a.finished;})).then(function(){if(run!==version)return;if(!target)details.open=false;animations.forEach(function(a){a.cancel();});animations=[];});
    });
  }
  function sync(){
    if(!window.document)return;
    var view=document.querySelector('#m-view');if(!view)return;
    document.querySelectorAll('select').forEach(enhanceSelect);view.querySelectorAll('details').forEach(enhanceDetails);
    var title=document.querySelector('#m-title')?.textContent?.trim();view.querySelectorAll('h1').forEach(function(h){h.classList.toggle('m-ux-duplicate-title',h.textContent.trim()===title);});
    if(refreshButton){var available=refreshing||!!refreshAction();if(refreshButton.hidden===available)refreshButton.hidden=!available;}
  }
  function bindRefresh(root,fn,available){refreshBinding={root:root,fn:fn,available:available,hash:location.hash};}
  function refreshAction(){
    if(!MApp.getMe?.()||document.querySelector('#m-app')?.classList.contains('hidden'))return null;
    if(document.querySelector('.v2-orbit-overlay,[role=dialog],.guide-coach'))return null;
    if(refreshBinding?.root.isConnected&&refreshBinding.hash===location.hash)return !refreshBinding.available||refreshBinding.available()?refreshBinding.fn:null;
    var p=MApp.currentLocation?.();
    if(!p||Object.keys(p.params||{}).some(function(k){return !['tab','role','seg','view'].includes(k);}))return null;
    if(!['home','work','sales','order-tracking','notifications','directory','production','job-orders','qc','repairs','receiving','so','deliveries'].includes(p.name))return null;
    return async function(){var hash=location.hash,fields=Array.from(document.querySelectorAll('#m-view input[type=search],#m-view select')).map(function(el){return el.value;});await MApp.refreshAccess({required:true});if(hash!==location.hash)return;await MApp.render();if(hash!==location.hash)return;document.querySelectorAll('#m-view input[type=search],#m-view select').forEach(function(el,i){if(fields[i]!==undefined){el.value=fields[i];el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));}});};
  }
  function hideIndicator(){indicator?.classList.remove('is-visible','is-ready','is-busy');if(indicator)indicator.style.transform='translate(-50%,-12px)';}
  async function refresh(){
    var action=refreshAction();if(refreshing||!action)return;var epoch=refreshEpoch;refreshing=true;refreshButton.disabled=true;indicator.classList.add('is-visible','is-busy');indicator.classList.remove('is-ready');indicator.style.transform='translate(-50%,12px)';indicator.querySelector('[role=status]').textContent='Refreshing…';
    try{var result=await action();if(epoch===refreshEpoch)indicator.querySelector('[role=status]').textContent=result?.ok===false?'Some work could not be refreshed':'Updated';}
    catch(e){if(epoch===refreshEpoch){indicator.querySelector('[role=status]').textContent='Could not refresh';window.mToast?.(e.message||'Could not refresh. Try again.','err');}}
    finally{if(epoch===refreshEpoch){refreshing=false;refreshButton.disabled=false;hideIndicator();}}
  }
  function navigation(){
    openControl?.close(true);refreshBinding=null;gesture=null;
    if(frame!==location.hash){frame=location.hash;refreshEpoch++;refreshing=false;if(refreshButton)refreshButton.disabled=false;hideIndicator();}
  }
  function boot(){
    // A nested menu owns the first Escape before a dialog's capture handler can
    // dismiss the entire editor. Focus remains on the actual select control.
    window.addEventListener('keydown',function(e){if(e.key==='Escape'&&openControl){e.preventDefault();e.stopImmediatePropagation();openControl.close(true);}},{capture:true});
    document.addEventListener('pointerdown',function(){document.documentElement.dataset.inputMethod='pointer';},{passive:true});
    document.addEventListener('keydown',function(){document.documentElement.dataset.inputMethod='keyboard';});
    indicator=document.createElement('div');indicator.className='m-pull-refresh';indicator.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 7v5h-5M19 12a7 7 0 1 0-2 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="m-ux-sr" role="status"></span>';document.body.appendChild(indicator);
    refreshButton=document.createElement('button');refreshButton.type='button';refreshButton.className='m-screen-refresh';refreshButton.setAttribute('aria-label','Refresh current screen');refreshButton.textContent='Refresh current screen';refreshButton.onclick=refresh;document.querySelector('#m-app')?.prepend(refreshButton);
    document.addEventListener('touchstart',function(e){
      if(refreshing||openControl||e.touches.length!==1||!refreshAction()||scrollY>0||document.querySelector('#m-app')?.classList.contains('hidden'))return;
      var target=e.target;if(target.closest('input,select,textarea,[contenteditable],.m-select-menu,#m-tabbar,.v2-orbit,.v2-orbit-overlay'))return;
      for(var ancestor=target;ancestor&&ancestor!==document.body;ancestor=ancestor.parentElement){if(ancestor.scrollTop>0)return;}
      var point=e.touches[0],top=document.querySelector('.m-topbar')?.getBoundingClientRect().bottom||80;if(point.clientY>top+110)return;
      gesture={x:point.clientX,y:point.clientY,delta:0,hash:location.hash};
    },{passive:true});
    document.addEventListener('touchmove',function(e){
      if(!gesture)return;if(e.touches.length!==1||gesture.hash!==location.hash||scrollY>0){gesture=null;hideIndicator();return;}
      var point=e.touches[0],dy=point.clientY-gesture.y,dx=Math.abs(point.clientX-gesture.x);if(dy<0||dx>Math.max(16,dy)){gesture=null;hideIndicator();return;}
      if(dy<12)return;e.preventDefault();gesture.delta=dy;indicator.classList.add('is-visible');indicator.classList.toggle('is-ready',dy>=96);indicator.style.transform='translate(-50%,'+Math.min(72,dy*.5)+'px)';indicator.querySelector('[role=status]').textContent=dy>=96?'Release to refresh':'Pull to refresh';
    },{passive:false});
    document.addEventListener('touchend',function(){var current=gesture;gesture=null;if(current?.delta>=96){refresh();}else if(!refreshing)hideIndicator();},{passive:true});
    document.addEventListener('touchcancel',function(){gesture=null;if(!refreshing)hideIndicator();},{passive:true});
    document.addEventListener('keydown',function(e){if(e.altKey&&e.key.toLowerCase()==='r'&&refreshAction()){e.preventDefault();refresh();}});
    var observer=new MutationObserver(function(records){if(!window.document)return;records.forEach(function(record){var select=record.target.nodeType===1?record.target.closest('select'):record.target.parentElement?.closest('select');if(select)controls.get(select)?.close(true);});sync();menus.forEach(function(control){if(!control.select.isConnected){control.close(true);control.menu.remove();menus.delete(control);}});});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected','hidden','value','label']});sync();
  }
  window.mScreenUX={bindRefresh:bindRefresh,refresh:refresh,navigation:navigation,sync:sync};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
