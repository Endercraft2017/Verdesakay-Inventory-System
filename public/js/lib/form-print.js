/* Pure print fragments shared by generated server layouts and the browser designer. */
(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const path=field=>['company','global','record','number','today','user','order','fields'].includes(field.key)?'fields.'+field.key:field.key;
  const currency=field=>/^[A-Z]{3}$/.test(field.currency||'')?field.currency:'PHP';
  const money=(value,code)=>'{{= money('+value+', "'+code+'")}}';
  function field(field,classes={row:'ff-row',label:'ff-label',value:'ff-value'}){
    const key=path(field);
    if(field.type==='line_items')return `<h3>${esc(field.label)}</h3><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Unit price</th><th>Discount %</th><th>Line total</th></tr></thead><tbody>{{#${key}}}<tr><td>{{name}}</td><td>{{quantity}}</td><td>{{unit}}</td><td>${money('unit_price',currency(field))}</td><td>{{discount_percent}}</td><td>${money('line_total',currency(field))}</td></tr>{{/${key}}}</tbody></table>`;
    const token=field.format==='currency'?money(key,currency(field)):'{{'+key+(field.type==='reference'?(field.source==='sales_order'?'.number':'.name'):'')+'}}';
    return `<div class="${classes.row}"><span class="${classes.label}">${esc(field.label)}</span><span class="${classes.value}">${token}</span></div>`;
  }
  function invoice(form){
    const find=key=>form.fields.find(item=>item.key===key),row=key=>find(key)?field(find(key)):'',value=key=>find(key)?'{{'+path(find(key))+'}}':'';
    const grouped=new Set(['company_name','company_address','company_tin','customer','billing_address','customer_tin','invoice_date','due_date','items','subtotal','tax_rate','tax','total','payment_terms']);
    return `<style>.invoice{font:12px Arial,sans-serif;color:#111}.invoice-head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #222;padding-bottom:14px}.invoice h1{font-size:20px;margin:0 0 8px}.invoice-company{font-size:16px;font-weight:bold}.invoice-party{padding:14px 0}.invoice table{width:100%;border-collapse:collapse}.invoice th,.invoice td{border-bottom:1px solid #ccc;padding:8px;text-align:left}.invoice th:nth-child(n+4),.invoice td:nth-child(n+4){text-align:right}.invoice-summary{margin:18px 0 18px auto;width:55%}.invoice .ff-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0}.invoice .ff-label{font-weight:bold}.invoice .ff-value{white-space:pre-wrap;text-align:right}.invoice-summary .ff-row:last-child{border-top:2px solid #222;font-size:16px}.invoice-terms{white-space:pre-wrap;margin:20px 0}.invoice-signatures{display:flex;justify-content:space-between;gap:32px;margin-top:48px}.invoice-signatures span{border-top:1px solid #777;width:45%;text-align:center;padding-top:6px}</style><section class="invoice"><header class="invoice-head"><div><div class="invoice-company">${value('company_name')}</div><div>${value('company_address')}</div><div>TIN: ${value('company_tin')}</div></div><div><h1>${esc(form.name)}</h1><div>No. {{record.number}}</div><div>Status: {{record.status}}</div>${row('invoice_date')}${row('due_date')}</div></header><section class="invoice-party"><strong>Bill to</strong>${row('customer')}${row('billing_address')}${row('customer_tin')}</section>${row('items')}<section class="invoice-summary">${['subtotal','tax_rate','tax','total'].map(row).join('')}</section><section class="invoice-terms"><strong>Payment terms</strong><div>${value('payment_terms')}</div></section>${form.fields.filter(item=>!grouped.has(item.key)).map(item=>field(item)).join('')}<footer class="invoice-signatures"><span>Issued by</span><span>Received by</span></footer></section>`;
  }
  const api={field,path,currency,money,invoice};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof window!=='undefined')window.FormPrint=api;
})();
