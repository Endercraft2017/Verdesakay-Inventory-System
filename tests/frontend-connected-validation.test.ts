import {it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
function setup(){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://localhost'}),w=dom.window as any;
 w.UI={esc:(v:unknown)=>String(v??''),money:(v:number)=>v.toFixed(2)};w.API={get:async()=>[]};
 for(const file of ['form-validation','form-math','form-print','form-connections','form-items'])w.eval(fs.readFileSync(path.join(import.meta.dirname,'../public/js/lib/'+file+'.js'),'utf8'));
 const field={key:'items',label:'Products',type:'line_items',required:true},root=w.document.querySelector('main');root.innerHTML='<div data-summary></div>'+w.FormItems.render(field);w.FormItems.mount(root,[field],{});
 return {dom,w,root,field};
}
it('collects every row error, focuses its control and removes errors as rows are corrected or removed',()=>{
 const {dom,w,root,field}=setup();
 try{
  root.querySelector('[data-add-item]').click();root.querySelector('[data-add-item]').click();
  const rows=root.querySelectorAll('[data-item-row]');
  for(const row of rows){row.querySelector('[data-item-quantity]').value='0';row.querySelector('[data-item-price]').value='-1';row.querySelector('[data-item-discount]').value='101';}
  const errors=w.FormItems.validate(root,field);expect(errors).toHaveLength(8);
  expect(w.FormValidation.show(root,errors,root.querySelector('[data-summary]'))).toBe(false);
  root.querySelector('[data-summary] button').click();expect(w.document.activeElement).toBe(rows[0].querySelector('select'));
  const price=rows[0].querySelector('[data-item-price]');price.value='0';price.dispatchEvent(new w.Event('input',{bubbles:true}));expect(price.hasAttribute('aria-invalid')).toBe(false);
  expect(root.querySelectorAll('[data-summary] button')).toHaveLength(7);
  rows[0].querySelector('[data-remove-item]').click();expect(root.querySelectorAll('[data-summary] button')).toHaveLength(4); // only the removed row errors disappear
  // Saving revalidates the remaining row instead of retaining references to removed controls.
  const remaining=w.FormItems.validate(root,field);expect(remaining).toHaveLength(4);expect(remaining.every((error:any)=>error.control.isConnected)).toBe(true);
 }finally{dom.window.close();}
});
it('targets an empty required table at Add row and clears that error as soon as a row is added',()=>{
 const {dom,w,root,field}=setup();try{
  const errors=w.FormItems.validate(root,field);expect(errors).toHaveLength(1);w.FormValidation.show(root,errors,root.querySelector('[data-summary]'));
  root.querySelector('[data-summary] button').click();expect(w.document.activeElement).toBe(root.querySelector('[data-add-item]'));
  root.querySelector('[data-add-item]').click();expect(root.querySelector('[data-add-item]').hasAttribute('aria-invalid')).toBe(false);expect(root.querySelectorAll('[data-summary] button')).toHaveLength(2);expect(w.FormItems.validate(root,field)).toHaveLength(2);
 }finally{dom.window.close();}
});
