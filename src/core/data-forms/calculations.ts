import '../../../public/js/lib/form-math.js';
import type {AuthUser,FieldDef} from '../../shared/types';
import {ValidationError} from '../../shared/validation';
import {sourceRows} from './sources';
const math=(globalThis as unknown as {FormMath:{number:(v:unknown,label?:string)=>number;line:(q:unknown,p:unknown,d?:unknown)=>number;round:(v:number)=>number;validate:(f:FieldDef[])=>void;calculate:(f:FieldDef[],d:Record<string,unknown>)=>Record<string,unknown>}}).FormMath;
export function validateCalculations(fields:FieldDef[]) {
  try{math.validate(fields);}catch(error){throw new ValidationError((error as Error).message);}
}
export function calculateRecord(fields:FieldDef[],input:Record<string,unknown>,user:AuthUser,previous:Record<string,unknown>={}) {
  const data={...input};
  try{
    for(const field of fields)if(field.type==='line_items') {
      const rows=data[field.key]??[];
      if(!Array.isArray(rows)||rows.length>50)throw new Error(field.label+': use up to 50 item rows');
      if(field.required&&!rows.length)throw new Error(field.label+': add at least one item');
      const old=Array.isArray(previous[field.key])?previous[field.key] as Record<string,unknown>[]:[],seen=new Set();
      data[field.key]=rows.map((row:Record<string,unknown>,index:number)=>{
        const rowId=String(row.row_id||'row_'+index),id=Number(row.product_id);
        if(!/^[a-zA-Z0-9_-]{1,64}$/.test(rowId)||seen.has(rowId))throw new Error(field.label+': item row identifiers must be unique');seen.add(rowId);
        if(!Number.isSafeInteger(id)||id<1)throw new Error(field.label+` row ${index+1}: select a product`);
        const saved=old.find(r=>r.row_id===rowId&&Number(r.product_id)===id);
        const source=saved||sourceRows('product',user,'',id)[0];
        if(!source)throw new Error(field.label+` row ${index+1}: product is no longer available`);
        const catalogCurrency=String(source.currency??source.catalog_currency??'PHP');
        if(catalogCurrency!==(field.currency||'PHP'))throw new Error(field.label+': catalog currency differs; choose a product priced in '+(field.currency||'PHP'));
        const price=field.price_editable===false?(source.sale_price??saved?.unit_price):row.unit_price;
        const quantity=math.number(row.quantity,'Quantity'),unitPrice=math.number(price,'Unit price'),discount=math.number(row.discount_percent??0,'Discount percentage');
        const lineTotal=math.line(quantity,unitPrice,discount);
        return {row_id:rowId,product_id:id,catalog_currency:catalogCurrency,name:source.name,sku:source.sku,unit:source.unit,sale_price:source.sale_price,quantity,unit_price:unitPrice,discount_percent:discount,discount_amount:math.round(math.line(quantity,unitPrice)-lineTotal),net_unit_price:unitPrice*(1-discount/100),line_total:lineTotal};
      });
    }
    // Connected invoices validate required inputs on the server as well as in the browser.
    if(fields.some(field=>['reference','system','line_items','calculated'].includes(field.type)))for(const field of fields) {
      if(field.type==='number' && data[field.key]!=null && data[field.key]!=='')data[field.key]=math.number(data[field.key],field.label);
      if(field.required&&!['calculated','line_items'].includes(field.type)&&(data[field.key]==null||data[field.key]===''||(field.type==='checkbox'&&data[field.key]!==true&&data[field.key]!=='Yes')))throw new Error(field.label+' is required');
    }
    return math.calculate(fields,data);
  }catch(error){if((error as {status?:number}).status===403)throw error;throw new ValidationError((error as Error).message);}
}
