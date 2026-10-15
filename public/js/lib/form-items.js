/* Repeating product rows; server repeats all validation and arithmetic before saving. */
window.FormItems = (() => {
  function render(field){return `<fieldset class="form-items" data-items="${field.key}"><legend>${UI.esc(field.label)}${field.required?' *':''}</legend><p class="muted">Select products, review their prices, and enter quantities. Up to 50 rows.</p><div data-item-rows></div><button type="button" class="btn secondary small" data-add-item>Add product row</button><p data-items-error role="status"></p><p>Subtotal: <strong data-items-total>0.00</strong></p></fieldset>`;}
  function mount(overlay,fields,data,onChange) {
    for(const field of fields.filter(f=>f.type==='line_items')){
      const root=overlay.querySelector(`[data-items="${field.key}"]`),list=root.querySelector('[data-item-rows]'),add=root.querySelector('[data-add-item]');
      let rows=(Array.isArray(data[field.key])?data[field.key]:[]).map(row=>({...row}));
      function current(){return [...list.querySelectorAll('[data-item-row]')].map(element=>{
        const select=element.querySelector('select[data-field]'),snapshot=select.__referenceValue||{};
        return {row_id:element.dataset.itemRow,product_id:select.value,...Object.fromEntries(['name','sku','unit','sale_price'].map(key=>[key,snapshot[key]??''])),quantity:element.querySelector('[data-item-quantity]').value,unit_price:element.querySelector('[data-item-price]').value,discount_percent:element.querySelector('[data-item-discount]').value};
      });}
      function totals(){let sum=0;root.querySelector('[data-items-error]').textContent='';
        for(const element of list.querySelectorAll('[data-item-row]'))try{const total=FormMath.line(element.querySelector('[data-item-quantity]').value,element.querySelector('[data-item-price]').value,element.querySelector('[data-item-discount]').value);element.querySelector('[data-line-total]').textContent=UI.money(total);sum+=total;}catch(error){element.querySelector('[data-line-total]').textContent='—';root.querySelector('[data-items-error]').textContent=error.message;}
        root.querySelector('[data-items-total]').textContent=UI.money(FormMath.round(sum));onChange?.();
      }
      function draw(){
        list.innerHTML=rows.map((row,index)=>{
          const prefix=field.key+'_'+row.row_id;
          const product={key:prefix+'_product',label:'Product '+(index+1),type:'reference',source:'product',required:true};
          return `<section class="form-item-row" data-item-row="${row.row_id}" aria-label="${UI.esc(field.label)} row ${index+1}">${FormConnections.render(product,row.product_id?{id:row.product_id,name:row.name,sku:row.sku,unit:row.unit,sale_price:row.sale_price}:null)}<div class="form-item-values"><label>Quantity<input type="number" min="0.000001" step="any" data-item-quantity value="${UI.esc(String(row.quantity??1))}" aria-required="true"></label><label>Unit<input data-field="${prefix}_unit" readonly value="${UI.esc(row.unit||'')}"></label><label>Unit price<input data-item-price data-field="${prefix}_price" type="number" min="0" step="any" value="${UI.esc(String(row.unit_price??''))}" ${field.price_editable===false?'readonly':''} aria-required="true"></label><label>Discount %<input type="number" data-item-discount min="0" max="100" step="any" value="${UI.esc(String(row.discount_percent??0))}"></label><span>Line total: <strong data-line-total>—</strong></span></div><button type="button" class="btn secondary small" data-remove-item="${row.row_id}">Remove row ${index+1}</button></section>`;
        }).join('');
        for(const [index,row] of rows.entries()){
          const prefix=field.key+'_'+row.row_id,element=list.querySelector(`[data-item-row="${row.row_id}"]`);
          const virtual=[{key:prefix+'_product',label:'Product '+(index+1),type:'reference',source:'product'},{key:prefix+'_unit',type:'text',binding:{field:prefix+'_product',property:'unit',editable:false}},{key:prefix+'_price',type:'number',binding:{field:prefix+'_product',property:'sale_price',editable:field.price_editable!==false}}];
          FormConnections.mount(element,virtual,{[prefix+'_product']:row.product_id?{id:row.product_id,name:row.name,sku:row.sku,unit:row.unit,sale_price:row.sale_price}:null});
        }
        list.querySelectorAll('[data-remove-item]').forEach(button=>button.onclick=()=>{overlay.__markDirty?.();rows=current().filter(row=>row.row_id!==button.dataset.removeItem);draw();});
        add.disabled=rows.length>=50;totals();
      }
      add.onclick=()=>{overlay.__markDirty?.();rows=current();if(rows.length>=50)return;rows.push({row_id:FormConnections.key(),quantity:1});draw();list.lastElementChild?.querySelector('input')?.focus();};
      list.addEventListener('input',totals);list.addEventListener('change',totals);
      root.__collect=()=>current().map(row=>({...row,discount_amount:FormMath.round(FormMath.line(row.quantity,row.unit_price)-FormMath.line(row.quantity,row.unit_price,row.discount_percent)),line_total:FormMath.line(row.quantity,row.unit_price,row.discount_percent)}));draw();
    }
  }
  function collect(overlay,field){const root=overlay.querySelector(`[data-items="${field.key}"]`);const rows=root.__collect();if(field.required&&!rows.length)throw new Error(field.label+': add at least one product');if(rows.some(row=>!row.product_id))throw new Error(field.label+': select a product on every row');return rows;}
  return {render,mount,collect};
})();
