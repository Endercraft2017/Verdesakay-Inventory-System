/* Read-only coaching: highlights controls; navigation and business actions remain explicit. */
(function () {
  const key = id => `vds_guide:${window.VDS_BASE_PATH || '/'}:${App.getMe?.()?.id || 'guest'}:${id}`;
  let state = null;
  function savedStep(id) { try { return Math.max(0, Number(localStorage.getItem(key(id))) || 0); } catch { return 0; } }
  function remember(id,i) { try { localStorage.setItem(key(id),String(i)); } catch {} }
  const query=selector=>{try{return document.querySelector(selector);}catch{return null;}};
  function position() {
    if (!state) return;
    const step=state.p.steps[state.i], loc=App.currentLocation?.(), correctScreen=step.to?.route && loc?.route===step.to.route && Object.entries(step.to.filter||{}).every(([k,v])=>String(loc.filter?.[k])===String(v));
    const view=document.querySelector('#view');
    if(state.p.kind==='feature' && correctScreen && view?.dataset.route===step.to.route && !/Loading…/.test(view.textContent) && window.GuideCenter) { start(GuideCenter.contextual(view),0,{root:view}); return; }
    const selector=step.spot||(correctScreen?'#view .topbar h2':null);
    const el=step.target?.isConnected ? step.target : selector ? query(selector) : null;
    if(el && state.lastScrolledTarget!==el){state.lastScrolledTarget=el;try{el.scrollIntoView({block:'nearest',inline:'nearest',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches?'auto':'smooth'});}catch{}}
    const rect=el?.getBoundingClientRect(), visible=!!rect && rect.width>0 && rect.height>0 && !el.closest('[hidden], .hidden');
    state.target=visible?el:null;
    const locator=state.coach.querySelector('.guide-locator');
    if(state.ring.hidden===visible)state.ring.hidden=!visible;
    const message=!visible&&(step.spot||step.to?.route)?(step.to?.route?'Choose Open screen to show the relevant screen, or skip this step.':'Open the relevant dialog or section to find this control. You can also skip this step.'):'';
    if(locator.textContent!==message)locator.textContent=message;
    if(visible){const pad=5;Object.assign(state.ring.style,{left:(rect.left-pad)+'px',top:(rect.top-pad)+'px',width:(rect.width+pad*2)+'px',height:(rect.height+pad*2)+'px'});state.ring.dataset.step=String(state.i+1);}
    const r=visible?rect:{left:-1000,right:-999,top:-1000,bottom:-999};
    const box=state.coach.getBoundingClientRect(), gap=12, width=innerWidth, height=innerHeight;
    const spots=[{left:Math.max(gap,width-box.width-gap),top:Math.max(gap,height-box.height-gap)},{left:gap,top:Math.max(gap,height-box.height-gap)},{left:Math.max(gap,width-box.width-gap),top:gap},{left:gap,top:gap}];
    const overlap=p=>Math.max(0,Math.min(p.left+box.width,r.right)-Math.max(p.left,r.left))*Math.max(0,Math.min(p.top+box.height,r.bottom)-Math.max(p.top,r.top));
    spots.sort((a,b)=>overlap(a)-overlap(b));Object.assign(state.coach.style,{left:spots[0].left+'px',top:spots[0].top+'px',bottom:'auto',right:'auto'});
  }
  function close(complete=false) {
    if(!state)return;const s=state;state=null;s.observer.disconnect();document.removeEventListener('keydown',s.onKey,true);document.removeEventListener('click',s.onClick);window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);s.coach.remove();s.ring.remove();
    if(complete){try{localStorage.removeItem(key(s.p.id));}catch{}UI.toast('Walkthrough complete — '+s.p.title,'success');}
    if(s.previousFocus?.isConnected)s.previousFocus.focus({preventScroll:true});
  }
  function go(delta) { if(!state)return;const i=state.i+delta;if(i<0)return;if(i>=state.p.steps.length){close(true);return;}state.i=i;state.pendingAdvance=false;render(); }
  function openScreen() {
    if(!state)return;const step=state.p.steps[state.i];if(!step.to?.route)return;
    if(App.canAccessRoute&&!App.canAccessRoute(step.to.route,step.to.filter)){UI.toast('This screen is not available to your role or workspace.','info');return;}
    App.navigate(step.to.route,step.to.filter);requestAnimationFrame(position);
  }
  function render() {
    if(!state)return;const {p,i,coach}=state,step=p.steps[i],available=!step.to?.route||!App.canAccessRoute||App.canAccessRoute(step.to.route,step.to.filter);remember(p.id,i);
    const restoreCoachFocus=coach.contains(document.activeElement);
    coach.innerHTML=`<div class="guide-coach-bar"><span style="width:${Math.round((i+1)/p.steps.length*100)}%"></span></div><div class="guide-coach-head"><strong class="guide-coach-title">${UI.esc(p.title)}</strong><span class="guide-coach-count">${i+1} / ${p.steps.length}</span><button type="button" class="icon-btn" data-act="minimize" aria-label="Minimize or expand guide" aria-expanded="true">${UI.icon('adjust',14)}</button><button type="button" class="icon-btn" data-act="close" aria-label="Exit walkthrough">${UI.icon('close',14)}</button></div><div class="guide-coach-body" aria-live="polite"><h4>${UI.esc(step.title)}</h4>${step.role?`<div class="guide-coach-role">${UI.esc(step.role)}</div>`:''}<div class="guide-coach-text">${step.body||''}</div>${step.tip?`<div class="guide-tip">${step.tip}</div>`:''}<p class="guide-locator muted"></p>${!available?'<p class="tool-note">This step belongs to another role or a module unavailable in this workspace. Read it for context, or skip it.</p>':''}${step.to?.external?`<p class="muted">${UI.esc(step.to.label)} · phone app</p>`:''}</div><div class="guide-coach-foot"><button class="btn secondary small" type="button" data-act="back" ${i===0?'disabled':''}>Back</button>${step.to?.route?`<button class="btn secondary small" type="button" data-act="open" ${available?'':'disabled'}>Open screen</button>`:''}${i+1<p.steps.length?'<button class="btn secondary small" type="button" data-act="skip">Skip</button>':''}<button class="btn small" type="button" data-act="next">${i+1===p.steps.length?'Finish':'Next'}</button></div><p class="guide-coach-keys">← / → change steps outside fields · Esc exits · no action is submitted automatically</p>`;
    coach.querySelector('[data-act="close"]').onclick=()=>close(false);coach.querySelector('[data-act="back"]').onclick=()=>go(-1);coach.querySelector('[data-act="next"]').onclick=()=>go(1);coach.querySelector('[data-act="skip"]')?.addEventListener('click',()=>go(1));coach.querySelector('[data-act="open"]')?.addEventListener('click',openScreen);
    coach.querySelector('[data-act="minimize"]').onclick=e=>{const small=coach.classList.toggle('minimized');e.currentTarget.setAttribute('aria-expanded',String(!small));position();};
    coach.classList.remove('minimized');if(restoreCoachFocus)coach.querySelector('[data-act="next"]').focus();requestAnimationFrame(position);
  }
  function start(id,index=0,options={}) {
    let p=typeof id==='object'?id:window.GUIDE?.byId[id];if(!p?.steps.length)return;const loc=App.currentLocation?.();if(p.kind==='feature'&&loc?.route===p.route&&Object.entries(p.filter||{}).every(([k,v])=>String(loc.filter?.[k])===String(v))&&window.GuideCenter){p=GuideCenter.contextual(document.querySelector('#view'));options={...options,root:document.querySelector('#view')};}close(false);
    const coach=document.createElement('section'),ring=document.createElement('div');coach.className='guide-coach open';coach.tabIndex=-1;coach.setAttribute('role','dialog');coach.setAttribute('aria-label',p.title+' walkthrough');ring.className='guide-focus-ring';ring.setAttribute('aria-hidden','true');document.body.append(ring,coach);
    const onKey=e=>{if(e.defaultPrevented||e.isComposing)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(false);return;}if(/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName)||e.target?.isContentEditable||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='ArrowRight'){e.preventDefault();go(1);}else if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}};
    const onClick=e=>{if(!state)return;const step=state.p.steps[state.i];if(step.advanceOn==='click'&&state.target?.contains(e.target)){state.pendingAdvance=true;}};
    const observer=new MutationObserver(()=>{if(!state)return;if(state.root&&!state.root.isConnected){close(false);return;}const step=state.p.steps[state.i];if(state.pendingAdvance&&step.nextSpot&&query(step.nextSpot)){go(1);return;}position();});
    state={p,i:Math.min(Math.max(0,index),p.steps.length-1),coach,ring,onKey,onClick,observer,root:options.root||p.context,previousFocus:document.activeElement};
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','open']});document.addEventListener('keydown',onKey,true);document.addEventListener('click',onClick);window.addEventListener('resize',position);window.addEventListener('scroll',position,true);render();coach.focus({preventScroll:true});
  }
  window.GuideTour={start,resume:id=>start(id,savedStep(id)),savedStep,close:()=>close(false)};
})();
