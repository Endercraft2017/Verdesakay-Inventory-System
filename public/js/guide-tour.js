/* Read-only coaching: highlights controls; navigation and business actions remain explicit. */
(function () {
  const guideApp = () => window.GuideTourPlatform?.App || App;
  const guideUI = () => window.GuideTourPlatform?.UI || UI;
  const key = id => `vds_guide:${window.VDS_BASE_PATH || '/'}:${guideApp().getMe?.()?.id || 'guest'}:${id}`;
  let state = null;
  function savedStep(id) { try { return Math.max(0, Number(localStorage.getItem(key(id))) || 0); } catch { return 0; } }
  function remember(id,i) { try { localStorage.setItem(key(id),String(i)); } catch {} }
  const query=selector=>{try{return document.querySelector(selector);}catch{return null;}};
  function current() {
    if (!state) return false;
    if (state.isCurrent && !state.isCurrent()) { close(false,false); return false; }
    return true;
  }
  function revealSection(el) {
    if(!el?.isConnected||el.closest('[hidden],.hidden'))return false;
    for(let node=el;node;node=node.parentElement){const css=getComputedStyle(node);if(css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse')return false;}
    // Native disclosure state is presentation only. Never click a target or a
    // workflow button to expose it, and do not unhide conditional form fields.
    for(let node=el.parentElement;node;node=node.parentElement){
      if(node.tagName==='DETAILS'&&!node.open){const summary=Array.from(node.children).find(child=>child.tagName==='SUMMARY');if(!summary?.contains(el))node.open=true;}
    }
    return true;
  }
  function position() {
    if (!current()) return;
    const step=state.p.steps[state.i], loc=guideApp().currentLocation?.(), correctScreen=step.to?.route && loc?.route===step.to.route && Object.entries(step.to.filter||{}).every(([k,v])=>String(loc.filter?.[k])===String(v));
    const view=document.querySelector('#view');
    if(state.p.kind==='feature' && correctScreen && view?.dataset.route===step.to.route && !/Loading…/.test(view.textContent) && window.GuideCenter) { start(GuideCenter.contextual(view),0,{root:view}); return; }
    const selector=step.spot||(correctScreen?'#view .topbar h2':null);
    const el=step.target?.isConnected ? step.target : selector ? query(selector) : null;
    const revealable=revealSection(el);
    if(revealable && state.lastScrolledTarget!==el){state.lastScrolledTarget=el;try{el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});}catch{}}
    const rect=el?.getBoundingClientRect(), visible=revealable && !!rect && rect.width>0 && rect.height>0 && (!el.checkVisibility||el.checkVisibility({checkVisibilityCSS:true})) && rect.bottom>0 && rect.top<innerHeight && rect.right>0 && rect.left<innerWidth;
    state.target=visible?el:null;
    const locator=state.coach.querySelector('.guide-locator');
    if(state.ring.hidden===visible)state.ring.hidden=!visible;
    const message=!visible&&(step.spot||step.to?.route)?(step.to?.route?'Choose Open screen to show the relevant screen, or skip this step.':'Open the relevant dialog or section to find this control. You can also skip this step.'):'';
    if(locator.textContent!==message)locator.textContent=message;
    if(visible){const pad=5;Object.assign(state.ring.style,{left:(rect.left-pad)+'px',top:(rect.top-pad)+'px',width:(rect.width+pad*2)+'px',height:(rect.height+pad*2)+'px'});state.ring.dataset.step=String(state.i+1);}
    const r=visible?rect:{left:-1000,right:-999,top:-1000,bottom:-999};
    const viewport=window.visualViewport,offset=viewport?.offsetTop||0,gap=12,width=viewport?.width||innerWidth,height=viewport?Math.min(innerHeight,viewport.height+offset):innerHeight;
    let maxHeight=Math.max(140,height-offset-gap*2);
    // On phones the coach cannot sit beside the target. Keep its instructions
    // scrollable above or below the centered control instead of covering it.
    if(visible && width<state.coach.getBoundingClientRect().width*2+gap*3){maxHeight=Math.min(maxHeight,Math.max(220,Math.max(r.top-offset-gap*2,height-r.bottom-gap*2)));}
    state.coach.style.maxHeight=maxHeight+'px';const box=state.coach.getBoundingClientRect();
    const spots=[{left:Math.max(gap,width-box.width-gap),top:Math.max(gap,height-box.height-gap)},{left:gap,top:Math.max(gap,height-box.height-gap)},{left:Math.max(gap,width-box.width-gap),top:offset+gap},{left:gap,top:offset+gap}];
    const overlap=p=>Math.max(0,Math.min(p.left+box.width,r.right)-Math.max(p.left,r.left))*Math.max(0,Math.min(p.top+box.height,r.bottom)-Math.max(p.top,r.top));
    spots.sort((a,b)=>overlap(a)-overlap(b));Object.assign(state.coach.style,{left:spots[0].left+'px',top:spots[0].top+'px',bottom:'auto',right:'auto'});
  }
  function close(complete=false,restore=true) {
    if(!state)return;const s=state;state=null;s.observer.disconnect();document.removeEventListener('keydown',s.onKey,true);document.removeEventListener('click',s.onClick);window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);s.coach.remove();s.ring.remove();
    if(complete){try{localStorage.removeItem(key(s.p.id));}catch{}guideUI().toast('Walkthrough complete — '+s.p.title,'success');}
    if(restore && (!s.isCurrent || s.isCurrent()) && s.previousFocus?.isConnected && !s.previousFocus.closest('[hidden],.hidden'))s.previousFocus.focus({preventScroll:true});
  }
  function go(delta) { if(!current())return;const i=state.i+delta;if(i<0)return;if(i>=state.p.steps.length){close(true);return;}state.i=i;state.pendingAdvance=false;render(); }
  function openScreen() {
    if(!current())return;const step=state.p.steps[state.i];if(!step.to?.route)return;
    if(guideApp().canAccessRoute&&!guideApp().canAccessRoute(step.to.route,step.to.filter)){guideUI().toast('This screen is not available to your role or workspace.','info');return;}
    guideApp().navigate(step.to.route,step.to.filter);requestAnimationFrame(position);
  }
  function render() {
    if(!current())return;const {p,i,coach}=state,step=p.steps[i],available=!step.to?.route||!guideApp().canAccessRoute||guideApp().canAccessRoute(step.to.route,step.to.filter);remember(p.id,i);
    state.ring.hidden=true;
    const restoreCoachFocus=coach.contains(document.activeElement);
    coach.innerHTML=`<div class="guide-coach-bar"><span style="width:${Math.round((i+1)/p.steps.length*100)}%"></span></div><div class="guide-coach-head"><strong class="guide-coach-title">${guideUI().esc(p.title)}</strong><span class="guide-coach-count">${i+1} / ${p.steps.length}</span><button type="button" class="icon-btn" data-act="minimize" aria-label="Minimize or expand guide" aria-expanded="true">${guideUI().icon('adjust',14)}</button><button type="button" class="icon-btn" data-act="close" aria-label="Exit walkthrough">${guideUI().icon('close',14)}</button></div><div class="guide-coach-body"${p.keyboardBody?' tabindex="0" role="region" aria-label="Guide instructions"':''} aria-live="polite"><h4>${guideUI().esc(step.title)}</h4>${step.role?`<div class="guide-coach-role">${guideUI().esc(step.role)}</div>`:''}<div class="guide-coach-text">${step.body||''}</div>${step.tip?`<div class="guide-tip">${step.tip}</div>`:''}<p class="guide-locator muted"></p>${!available?'<p class="tool-note">This step belongs to another role or a module unavailable in this workspace. Read it for context, or skip it.</p>':''}${step.to?.external?`<p class="muted">${guideUI().esc(step.to.label)} · phone app</p>`:''}</div><div class="guide-coach-foot">${p.stepPicker?`<label class="guide-step-picker"><span>${guideUI().esc(p.stepPicker)}</span><select data-act="jump" aria-label="${guideUI().esc(p.stepPicker)}">${p.steps.map((s,index)=>`<option value="${index}" ${index===i?'selected':''}>${index+1}. ${guideUI().esc(s.title)}</option>`).join('')}</select></label>`:''}${p.variants?`<label class="guide-depth"><span>Guide depth</span><select data-act="depth" aria-label="Guide depth"><option value="detailed" ${state.depth==='detailed'?'selected':''}>Detailed walkthrough</option><option value="brief" ${state.depth==='brief'?'selected':''}>Brief overview</option></select></label>`:''}<button class="btn secondary small" type="button" data-act="back" ${i===0?'disabled':''}>Back</button>${step.to?.route?`<button class="btn secondary small" type="button" data-act="open" ${available?'':'disabled'}>Open screen</button>`:''}${i+1<p.steps.length?'<button class="btn secondary small" type="button" data-act="skip">Skip</button>':''}<button class="btn small" type="button" data-act="next">${i+1===p.steps.length?'Finish':'Next'}</button></div><p class="guide-coach-keys">${window.GuideTourPlatform?.keys || '← / → change steps outside fields · Esc exits · no action is submitted automatically'}</p>`;
    const owner=state;
    function wire(action,handler,event='click') { const el=coach.querySelector(`[data-act="${action}"]`);el?.addEventListener(event,e=>{if(state===owner && el.isConnected && current())handler(e);}); }
    wire('close',()=>close(false));wire('back',()=>go(-1));wire('next',()=>go(1));wire('skip',()=>go(1));wire('open',openScreen);
    wire('minimize',e=>{const small=coach.classList.toggle('minimized');e.currentTarget.setAttribute('aria-expanded',String(!small));position();});
    wire('jump',e=>{const target=Number(e.target.value);if(Number.isInteger(target)&&target>=0&&target<state.p.steps.length)go(target-state.i);},'change');
    wire('depth',e=>{state.depth=e.target.value;try{localStorage.setItem(key(state.p.id)+':depth',state.depth);}catch{}state.p={...state.p,steps:state.p.variants[state.depth]};state.i=0;render();},'change');
    coach.classList.remove('minimized');if(restoreCoachFocus)coach.querySelector('[data-act="next"]').focus();requestAnimationFrame(position);
  }
  function start(id,index=0,options={}) {
    let p=typeof id==='object'?id:window.GUIDE?.byId[id];if(!p?.steps.length)return;const loc=guideApp().currentLocation?.();if(p.kind==='feature'&&loc?.route===p.route&&Object.entries(p.filter||{}).every(([k,v])=>String(loc.filter?.[k])===String(v))&&window.GuideCenter){p=GuideCenter.contextual(document.querySelector('#view'));options={...options,root:document.querySelector('#view')};}close(false);
    let depth='detailed';if(p.variants){try{if(localStorage.getItem(key(p.id)+':depth')==='brief')depth='brief';}catch{}p={...p,steps:p.variants[depth]};}
    const coach=document.createElement('section'),ring=document.createElement('div');coach.className='guide-coach open';coach.tabIndex=-1;coach.setAttribute('role','dialog');coach.setAttribute('aria-label',p.title+' walkthrough');ring.className='guide-focus-ring';ring.hidden=true;ring.setAttribute('aria-hidden','true');document.body.append(ring,coach);
    const onKey=e=>{if(!current())return;if(e.defaultPrevented||e.isComposing)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(false);return;}if(/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName)||e.target?.isContentEditable||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='ArrowRight'){e.preventDefault();go(1);}else if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}};
    const onClick=e=>{if(!current())return;const step=state.p.steps[state.i];if(step.advanceOn==='click'&&state.target?.contains(e.target)){state.pendingAdvance=true;}};
    const observer=new MutationObserver(()=>{if(!current())return;if(state.root&&!state.root.isConnected){close(false);return;}const step=state.p.steps[state.i];if(state.pendingAdvance&&step.nextSpot&&query(step.nextSpot)){go(1);return;}position();});
    state={p,depth,i:Math.min(Math.max(0,index),p.steps.length-1),coach,ring,onKey,onClick,observer,isCurrent:options.isCurrent,root:options.root||p.context,previousFocus:document.activeElement};
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','open','class']});document.addEventListener('keydown',onKey,true);document.addEventListener('click',onClick);window.addEventListener('resize',position);window.addEventListener('scroll',position,true);window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);render();coach.focus({preventScroll:true});
  }
  window.addEventListener('storage',()=>{if(state)current();});
  window.addEventListener('pagehide',()=>close(false,false));
  window.GuideTour={start,resume:id=>start(id,savedStep(id)),savedStep,close:()=>close(false)};
})();
