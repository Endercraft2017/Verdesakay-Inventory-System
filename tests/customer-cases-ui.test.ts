import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
const source=(p:string)=>fs.readFileSync(path.join(import.meta.dirname,'..','public/js',p),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

describe('CSR screen behavior',()=>{
  it('keeps a failed case edit visible with its values, then records the successful next action',async()=>{
    const dom=new JSDOM('<div id="modal-root"></div><div id="toasts"></div>',{runScripts:'outside-only',url:'http://localhost/'});
    const w=dom.window;
    w.eval(`var ICONS={};window.handlers={};window.fail=true;window.saved=[];
      var App={getMe:()=>({id:2}),hasPermission:()=>true,register:(n,fn)=>handlers[n]=fn};
      var API={get:async p=>p.includes('owners')?[{id:2,full_name:'Synthetic CSR'}]:{id:1,name:'Synthetic customer',orders:[]},
        post:async(p,b)=>{if(window.fail)throw new Error('Synthetic save failed');window.saved.push(b);}};`);
    w.eval(source('ui.js')+'\n'+source('modules/inventory/customer-cases.js')+'\nwindow.cases=CustomerCases;');
    await w.cases.create(1,'inquiry');
    const input=(key:string,value:string)=>{w.document.querySelector<HTMLInputElement>(`[data-c="${key}"]`)!.value=value;};
    input('summary','Customer asked about availability');input('next_action','Reply tomorrow');input('due_at','2026-10-23T09:00');
    w.document.querySelector<HTMLButtonElement>('[data-confirm]')!.click();await tick();
    expect(w.document.querySelector('[data-modal-error]')!.textContent).toBe('Synthetic save failed');
    expect(w.document.querySelector<HTMLInputElement>('[data-c="summary"]')!.value).toBe('Customer asked about availability');
    w.fail=false;w.document.querySelector<HTMLButtonElement>('[data-confirm]')!.click();await tick();
    expect(w.saved[0].next_action).toBe('Reply tomorrow');expect(w.saved[0].request_key).toBeTruthy();
    expect(w.document.querySelector('.modal-overlay')).toBeNull();dom.window.close();
  });
  it('does not open a customer dialog after its delayed read outlives navigation',async()=>{
    const dom=new JSDOM('<div id="view"></div>',{runScripts:'outside-only',url:'http://localhost/#customers'});
    const w=dom.window;let release!: (value:object)=>void;
    const detail=new Promise<object>(resolve=>release=resolve);
    Object.assign(w,{App:{hasPermission:()=>true,register:(_name:string,fn:unknown)=>{w.renderCustomers=fn;}},
      UI:{icon:()=>'',esc:String,emptyState:()=>'',modal:()=>{w.modalOpened=true;}},
      API:{get:async(p:string)=>p==='/customers'?[]:await detail}});
    w.eval(source('modules/inventory/customers.js'));
    const opened=w.renderCustomers(w.document.querySelector('#view'),{id:1});await tick();
    w.location.hash='customer-work';release({id:1,name:'Delayed customer',orders:[]});await opened;
    expect(w.modalOpened).not.toBe(true);dom.window.close();
  });
  it('programmatic navigation renders once and retains a hash URL for reload/back navigation',async()=>{
    const html=fs.readFileSync(path.join(import.meta.dirname,'..','public/index.html'),'utf8');
    const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});const w=dom.window;
    // No boot: exercise the actual router while keeping network and authentication out of this check.
    w.document.addEventListener=()=>{};
    w.eval('var NAV=[];var UI={esc:String};var API={};');
    w.eval(source('app.js')+'\nwindow.renders=0;App.register("csr-check",()=>window.renders++);');
    w.eval('App.navigate("csr-check",{case_id:12});');await tick();
    expect(w.location.pathname).toBe('/');expect(w.location.hash).toBe('#csr-check?case_id=12');expect(w.renders).toBe(1);
    // pushState must not produce the hashchange that previously opened a second modal.
    let changes=0;w.addEventListener('hashchange',()=>changes++);
    w.eval('App.navigate("csr-check",{case_id:13});');await tick();expect(changes).toBe(0);expect(w.renders).toBe(2);
    dom.window.close();
  });
});
