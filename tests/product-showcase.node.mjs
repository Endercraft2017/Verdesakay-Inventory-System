import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../website/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../website/product-showcase.js',import.meta.url),'utf8');
const experience=await readFile(new URL('../website/experience.js',import.meta.url),'utf8');
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function setup({reduced=false,failed=[],deferred=[]}={}){
 const dom=new JSDOM(html,{url:'https://otom.afkcube.com/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window, scheduled=new Map(), holds=new Map(), media={matches:reduced};
 let counter=0,observed;
 w.setTimeout=(fn,delay)=>{const id=++counter;scheduled.set(id,{fn,delay});return id};
 w.clearTimeout=id=>scheduled.delete(id);
 w.matchMedia=()=>media;media.addEventListener=(_,fn)=>media.listener=fn;
 w.IntersectionObserver=class{constructor(fn){this.callback=fn}observe(){observed=this.callback}unobserve(){}};
 w.Image=function(){const image=w.document.createElement('img');Object.defineProperty(image,'naturalWidth',{value:1440});Object.defineProperty(image,'src',{get(){return this.getAttribute('src')},set(value){this.setAttribute('src',value);if(deferred.some(s=>value.includes(s))) holds.set(value,()=>this.onload?.());else if(failed.some(s=>value.includes(s))) queueMicrotask(()=>this.onerror?.());else queueMicrotask(()=>this.onload?.())}});return image};
 w.eval(experience);w.eval(source);
 const root=w.document.querySelector('[data-product-showcase]');
 const stage=w.document.querySelector('[data-tour-media]');
 function visible(value){observed([{isIntersecting:value,intersectionRatio:value?.8:0}]);}
 function advance(){const entry=[...scheduled.entries()].find(([,v])=>v.delay===5500);assert.ok(entry,'autoplay timer exists');scheduled.delete(entry[0]);entry[1].fn();}
 function click(selector){w.document.querySelector(selector).click();}
 function selected(){return w.document.querySelector('[data-tour-screen][aria-pressed=true]').dataset.tourScreen;}
 function reduce(value){media.matches=value;media.listener({matches:value});}
 return {dom,w,root,stage,scheduled,holds,visible,advance,click,selected,reduce};
}
test('source initializes six genuine capture slides with one accessible active image and static links',()=>{
 const x=setup();assert.equal(x.root.querySelectorAll('.showcase-slide').length,6);assert.equal(x.root.querySelectorAll('.showcase-slide[aria-hidden=false]').length,1);assert.equal(x.root.querySelectorAll('img[data-tour-image]').length,1);assert.equal(x.root.querySelector('[data-showcase-transport]').hidden,false);assert.equal(x.selected(),'attendance');assert.equal([...x.scheduled.values()].filter(t=>t.delay===5500).length,0);x.dom.window.close();
 const plain=new JSDOM(html);assert.equal(plain.window.document.querySelectorAll('[data-tour-fallback] a').length,6);assert.equal(plain.window.document.querySelector('[data-tour-controls]').hidden,true);plain.window.close();
});
test('autoplay waits for visibility, changes real image and matching caption, then stops offscreen',async()=>{
 const x=setup();x.visible(true);assert.equal(x.root.dataset.showcaseState,'running');x.advance();await flush();assert.equal(x.selected(),'payroll');assert.match(x.root.querySelector('[data-tour-full]').href,/otom-payroll.webp$/);assert.equal(x.root.querySelector('.tour-figure [data-tour-title]').textContent,'Keep draft payroll in view.');assert.equal(x.root.querySelector('[data-tour-status]').textContent,'');x.visible(false);assert.equal(x.root.dataset.showcaseState,'waiting');assert.equal([...x.scheduled.values()].filter(t=>t.delay===5500).length,0);x.dom.window.close();
});
test('first pointer Pause click remains paused after focus stops autoplay; explicit Play resumes',()=>{
 const x=setup();x.visible(true);const button=x.root.querySelector('[data-showcase-play]');button.dispatchEvent(new x.w.Event('pointerdown',{bubbles:true}));button.focus();button.click();assert.equal(x.root.dataset.showcaseState,'paused');assert.equal(x.root.querySelector('[data-showcase-play-label]').textContent,'Play');button.click();assert.equal(x.root.dataset.showcaseState,'running');x.dom.window.close();
});
test('manual and keyboard selection hold autoplay until Play and preserve edited inquiry text',async()=>{
 const x=setup();x.visible(true);x.click('[data-tour-screen=production]');await flush();assert.equal(x.selected(),'production');assert.equal(x.root.dataset.showcaseState,'paused');x.click('[data-tour-inquiry]');assert.match(x.w.document.getElementById('c-workflow').value,/^Production:/);x.w.document.getElementById('c-workflow').value='Keep my own wording';x.click('[data-tour-screen=inventory]');await flush();x.click('[data-tour-inquiry]');assert.equal(x.w.document.getElementById('c-workflow').value,'Keep my own wording');x.root.querySelector('[data-showcase-next]').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await flush();assert.equal(x.selected(),'production');assert.equal(x.root.dataset.showcaseInstant,'true');x.dom.window.close();
});
test('reduced motion blocks automatic playback and retains instant manual navigation during runtime preference changes',async()=>{
 const x=setup({reduced:true});x.visible(true);assert.equal(x.root.dataset.showcaseState,'reduced');assert.equal(x.root.querySelector('[data-showcase-play]').disabled,true);x.click('[data-tour-screen=mobile]');await flush();assert.equal(x.selected(),'mobile');x.reduce(false);assert.equal(x.root.dataset.showcaseState,'paused');x.click('[data-showcase-play]');assert.equal(x.root.dataset.showcaseState,'running');x.reduce(true);assert.equal(x.root.dataset.showcaseState,'reduced');assert.equal([...x.scheduled.values()].filter(t=>t.delay===5500).length,0);x.dom.window.close();
});
test('failed capture load keeps preceding accurate image, caption, full-size link and inquiry brief',async()=>{
 const x=setup({failed:['otom-production']});x.click('[data-tour-screen=inventory]');await flush();const previous=x.root.querySelector('.tour-figure [data-tour-title]').textContent;x.click('[data-tour-screen=production]');await flush();assert.equal(x.selected(),'inventory');assert.equal(x.root.querySelector('.tour-figure [data-tour-title]').textContent,previous);assert.match(x.root.querySelector('[data-tour-full]').href,/otom-inventory.webp$/);assert.match(x.root.querySelector('[data-showcase-feedback]').textContent,/previous view is still shown/);assert.equal(x.root.querySelector('[data-tour-inquiry]').disabled,false);assert.equal(x.root.dataset.showcaseState,'paused');x.dom.window.close();
});
test('a late earlier load cannot override a newer selected screen',async()=>{
 const x=setup({deferred:['otom-production']});x.click('[data-tour-screen=production]');x.click('[data-tour-screen=mobile]');await flush();assert.equal(x.selected(),'mobile');for(const fn of x.holds.values())fn();await flush();assert.equal(x.selected(),'mobile');assert.equal(x.root.querySelector('.tour-figure [data-tour-title]').textContent,'Give employees a clear starting point.');x.dom.window.close();
});
test('pointer hover and document visibility suspend motion without silently undoing manual pause',()=>{
 const x=setup();x.visible(true);x.root.dispatchEvent(new x.w.Event('pointerenter'));assert.equal(x.root.dataset.showcaseState,'waiting');x.root.dispatchEvent(new x.w.Event('pointerleave'));assert.equal(x.root.dataset.showcaseState,'running');Object.defineProperty(x.w.document,'hidden',{value:true,configurable:true});x.w.document.dispatchEvent(new x.w.Event('visibilitychange'));assert.equal(x.root.dataset.showcaseState,'waiting');Object.defineProperty(x.w.document,'hidden',{value:false,configurable:true});x.w.document.dispatchEvent(new x.w.Event('visibilitychange'));assert.equal(x.root.dataset.showcaseState,'running');x.root.querySelector('[data-tour-full]').focus();assert.equal(x.root.dataset.showcaseState,'paused');x.root.dispatchEvent(new x.w.Event('pointerleave'));assert.equal(x.root.dataset.showcaseState,'paused');x.dom.window.close();
});
test('touch swipe selects the next screen while a vertical gesture leaves the selection unchanged',async()=>{
 const x=setup();
 function pointer(type,clientX,clientY){const event=new x.w.Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',pointerId:7,clientX,clientY});x.stage.dispatchEvent(event);}
 pointer('pointerdown',200,100);pointer('pointerup',190,250);await flush();assert.equal(x.selected(),'attendance');
 pointer('pointerdown',250,100);pointer('pointerup',100,110);await flush();assert.equal(x.selected(),'payroll');assert.equal(x.root.dataset.showcaseState,'paused');x.dom.window.close();
});
