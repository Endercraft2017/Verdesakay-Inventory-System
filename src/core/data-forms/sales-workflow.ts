/** Critical business action: atomic with submission, independently permissioned and idempotent. */
import {queryOne,run} from '../../shared/db';
import {now} from '../../shared/sync-context';
import {moduleEnabled} from '../../shared/modules';
import {ValidationError} from '../../shared/validation';
import type {AuthUser,FieldDef,FormAction} from '../../shared/types';
import {createDraftSaleForForm} from '../../modules/inventory/orders.routes';
export function validateSalesWorkflow(fields:FieldDef[],actions:FormAction[]) {
  const workflows=actions.filter(action=>action.type==='create_sales_draft');
  if(workflows.length>1)throw new ValidationError('Configure only one sales draft action per form');
  for(const action of workflows){
    if(action.run_on!=='submitted')throw new ValidationError('Sales draft actions run on submission');
    const customer=fields.find(field=>field.key===action.customer_field),items=fields.find(field=>field.key===action.items_field);
    if(customer?.type!=='reference'||customer.source!=='customer'||items?.type!=='line_items')throw new ValidationError('Sales draft action needs a connected customer and product line items');
    if(action.tax_field&&!fields.some(field=>field.key===action.tax_field&&field.type==='number'))throw new ValidationError('Choose a numeric tax percentage field');
    if(action.total_field&&!fields.some(field=>field.key===action.total_field&&field.type==='calculated'))throw new ValidationError('Choose a calculated total field');
  }
}
export function salesLink(recordId:number){return queryOne<{order_id:number;order_number:string;created_at:string}>('SELECT order_id,order_number,created_at FROM form_sales_links WHERE record_id=?',recordId);}
export function runSalesWorkflow(recordId:number,fields:FieldDef[],actions:FormAction[],data:Record<string,unknown>,status:string,user:AuthUser) {
  const action=actions.find(action=>action.type==='create_sales_draft');
  if(action&&!['draft','submitted'].includes(status))throw new ValidationError('Use Draft or Submitted for this form; review and approve its sales order separately');
  if(!action||status!=='submitted'||salesLink(recordId))return salesLink(recordId);
  validateSalesWorkflow(fields,actions);
  if(!moduleEnabled('inventory')||!user.permissions.includes('orders.create')||!user.permissions.includes('orders.view'))throw Object.assign(new Error('Submitting this form requires sales order creation and viewing permissions'),{status:403});
  const customer=data[action.customer_field!] as {id?:number;name?:string;contact_person?:string}|null,rows=data[action.items_field!] as Record<string,unknown>[];
  if(!customer?.id||!rows?.length)throw new ValidationError('Select a customer and add products before submitting');
  if(!queryOne('SELECT id FROM customers WHERE id=? AND archived=0',customer.id))throw new ValidationError('This customer is no longer available. Choose an active customer before submitting.');
  const result=createDraftSaleForForm({customer_id:customer.id,customer_name:customer.name,customer_contact:customer.contact_person,order_date:now().toISOString().slice(0,10),notes:'Created from form record '+recordId,tax_percent:action.tax_field?Number(data[action.tax_field]||0):0,items:rows.map(row=>({item_id:row.product_id,name:row.name,sku:row.sku,unit:row.unit,quantity:row.quantity,unit_price:row.net_unit_price??row.unit_price,description:Number(row.discount_percent)?'List price '+row.unit_price+'; discount '+row.discount_percent+'%':null}))},user.id);
  if(action.total_field&&Math.abs(result.total-Number(data[action.total_field]))>0.005)throw new ValidationError('The form total differs from the sales order total. Review the price, tax and calculation mappings before submitting.');
  run('INSERT INTO form_sales_links(record_id,order_id,order_number,created_at) VALUES(?,?,?,?)',recordId,result.id,result.number,now().toISOString());
  return salesLink(recordId);
}
