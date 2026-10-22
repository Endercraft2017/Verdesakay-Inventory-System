import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';import path from 'node:path';
function setup(){const dom=new JSDOM('<div id="search"></div>',{runScripts:'outside-only',url:'https://localhost'});const w=dom.window as any;for(const f of ['guide-data.js','guide-search.js'])w.eval(fs.readFileSync(path.join(import.meta.dirname,'../public/js',f),'utf8'));return {dom,w};}
describe('local guide retrieval',()=>{
 it.each([
  ['A customer returned a damaged unit','customer-return',0],
  ['I need a budget to buy tools','budgeted-purchase-request',0],
  ['old stock before the system','legacy-unit-intake',0],
  ['fix an earlier payroll deduction','payroll-correction',undefined],
  ['count the shelf stock','physical-count',undefined],
  ['send a second trip','split-trips',undefined],
  ['invoice from a form','connected-invoice',undefined],
 ])('retrieves published instructions for %s',(query,id,index)=>{
  const {dom,w}=setup();const r=w.GuideSearch.create(w.GUIDE.pipelines).search(query).results[0];
  expect(r.id).toBe(id);if(index!==undefined)expect(r.stepIndex).toBe(index);
  const source=w.document.createElement('div');source.innerHTML=w.GUIDE.byId[r.id].steps[r.stepIndex].body;
  expect(r.body).toBe(source.textContent.replace(/\s+/g,' ').trim());dom.window.close();
 });
 it('asks for clarification rather than guessing receiving or the meaning of PR',()=>{
  const {dom,w}=setup();const e=w.GuideSearch.create(w.GUIDE.pipelines);
  const r=e.search('I want to receive goods');expect(r.results).toHaveLength(0);expect(r.choices).toHaveLength(3);
  expect(e.search(r.choices[0].query).results[0].id).toBe('purchase-to-pay');
  expect(e.search('PR').choices).toHaveLength(2);dom.window.close();
 });
 it('does not return disabled/unprovided guides, and marks team handoffs',()=>{
  const {dom,w}=setup();const items=w.GUIDE.pipelines.filter((p:any)=>p.module==='hr');
  const e=w.GuideSearch.create(items,()=>false);const r=e.search('fix payroll deduction');
  expect(r.results[0].id).toBe('payroll-correction');expect(r.results.every((r:any)=>r.available===false)).toBe(true);
  expect(e.search('request purchase budget').results.some((r:any)=>r.id==='budgeted-purchase-request')).toBe(false);dom.window.close();
 });
 it('has a real no-match state and does not invent a fallback procedure',()=>{
  const {dom,w}=setup();const e=w.GuideSearch.create(w.GUIDE.pipelines);
  expect(e.search('purple unicorn quux').results).toEqual([]);expect(e.search('please help me').results).toEqual([]);dom.window.close();
 });
 it('escapes questions/content and selecting a result only opens the existing guide',()=>{
  const {dom,w}=setup();let selected:any=null;
  w.GuideSearch.mount(w.document.querySelector('#search'),{items:w.GUIDE.pipelines,esc:(s:string)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),canUse:()=>false,onSelect:(id:string,index:number)=>{selected={id,index};}});
  const input=w.document.querySelector('[data-intent-input]');input.value='customer returned damaged <img src=x onerror=alert(1)>';
  w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  expect(w.document.querySelector('[data-intent-results] img')).toBeNull();w.document.querySelector('[data-intent-select]').click();
  expect(selected.id).toBe('customer-return');w.document.querySelector('[data-intent-clear]').click();expect(input.value).toBe('');expect(w.document.querySelector('[data-intent-results]').children).toHaveLength(0);dom.window.close();
 });
});

it('prioritizes a related available screen on equal matches, without granting an action',()=>{
 const {dom,w}=setup();const items=['handoff','available'].map(id=>({id,title:'Prepare packages',steps:[{title:'Prepare a package',body:'Review package contents.',to:{route:id}}]}));
 const r=w.GuideSearch.create(items,(s:any)=>s.to.route==='available').search('prepare package');
 expect(r.results[0].id).toBe('available');expect(r.results[1].available).toBe(false);dom.window.close();
});
