/** Explicit, permission-aware sources shared by the form builder and record writes. */
import type { AuthUser, FieldDef, Permission } from '../../shared/types';
import { getSetting, queryAll, queryOne } from '../../shared/db';
import { moduleEnabled, type ModuleName } from '../../shared/modules';
import { ValidationError } from '../../shared/validation';

export const FORM_SOURCES = {
  product: { label:'Inventory products', module:'inventory', permission:'inventory.view', fields:['id','name','sku','unit','description','sale_price','currency'] },
  customer: { label:'Customers', module:'inventory', permission:'orders.view', fields:['id','name','contact_person','address','tin'] },
  employee: { label:'Employees', module:'hr', permission:'hr.view', fields:['id','name','employee_no','position','department'] },
  sales_order: { label:'Sales orders', module:'inventory', permission:'orders.view', fields:['id','number','customer_name','order_date','status','total','currency'] },
  supplier: { label:'Suppliers', module:'inventory', permission:'inventory.view', fields:['id','name','contact_person','address'] },
  location: { label:'Inventory locations', module:'inventory', permission:'inventory.view', fields:['id','name','type','address'] },
  account: { label:'Accounting accounts', module:'accounting', permission:'accounting.view', fields:['id','name','code','root_type','currency'] },
  tax_code: { label:'Tax codes', module:'accounting', permission:'accounting.view', fields:['id','name','code','kind','rate'] },
  company: { label:'Company settings', module:null, permission:null, fields:['name','address','phone','email','tin'] },
  user: { label:'Signed-in user', module:null, permission:null, fields:['id','name'] },
} as const;
export type Source = keyof typeof FORM_SOURCES;
export const NUMERIC_SOURCE_FIELDS:Record<Source,readonly string[]>={product:['id','sale_price'],customer:['id'],employee:['id'],sales_order:['id','total'],supplier:['id'],location:['id'],account:['id'],tax_code:['id','rate'],company:[],user:['id']};
type Snapshot = Record<string,string|number|null>;
export function sourceAvailable(source:Source,user:AuthUser):boolean {
  const config=FORM_SOURCES[source];
  return (!config.module || moduleEnabled(config.module as ModuleName)) && (!config.permission || user.permissions.includes(config.permission as Permission));
}
function sourceAccess(source:Source,user:AuthUser) {
  if(!sourceAvailable(source,user))throw Object.assign(new Error('You do not have access to '+FORM_SOURCES[source].label),{status:403});
}
export function sourceRows(source:Source,user:AuthUser,q='',id?:number):Snapshot[] {
  sourceAccess(source,user);
  if(source==='company') {
    const profile=getSetting<Record<string,unknown>>('company_profile')||{};
    return [Object.fromEntries(FORM_SOURCES.company.fields.map(key=>[key,String(profile[key]??'')]))];
  }
  if(source==='user')return [{id:user.id,name:user.full_name}];
  const searchColumn={product:'sku',customer:'contact_person',employee:'employee_no',sales_order:'number',supplier:'contact_person',location:'address',account:'code',tax_code:'code'}[source];
  const filter=id?' AND id=?':' AND (name LIKE ? OR '+searchColumn+' LIKE ?)';
  const params=id?[id]:['%'+q+'%','%'+q+'%'];
  let sql='';
  if(source==='product')sql='SELECT id,name,sku,unit,notes AS description,attributes FROM inventory_items WHERE 1=1';
  if(source==='customer')sql='SELECT id,name,contact_person,address,tin FROM customers WHERE archived=0';
  if(source==='employee')sql="SELECT id,name,employee_no,position,(SELECT name FROM departments WHERE id=employees.department_id) AS department FROM employees WHERE status NOT IN ('terminated','resigned','suspended')";
  if(source==='sales_order')sql="SELECT id,number,number AS name,customer_name,order_date,status,total,currency FROM orders WHERE type='sale' AND status NOT IN ('cancelled','void')";
  if(source==='supplier')sql='SELECT id,name,contact_person,address FROM suppliers WHERE 1=1';
  if(source==='location')sql='SELECT id,name,type,address FROM locations WHERE 1=1';
  if(source==='account')sql='SELECT id,name,code,root_type,currency FROM accounts WHERE archived=0 AND is_group=0';
  if(source==='tax_code')sql='SELECT id,name,code,kind,rate FROM tax_codes WHERE active=1';
  const rows=queryAll<Record<string,unknown>>(sql+filter+' ORDER BY '+(source==='sales_order'?'id DESC':'name COLLATE NOCASE')+' LIMIT 50',...params);
  return rows.map(row=>{
    if(source==='product') {
      let attrs:Record<string,unknown>={};try{attrs=JSON.parse(String(row.attributes||'{}'));}catch{}
      row.currency=String(attrs.currency||'PHP').toUpperCase();
      const value=attrs.sale_price;
      row.sale_price=value!=null && String(value).trim()!=='' && Number.isFinite(Number(value)) && Number(value)>=0?Number(value):null;
    }
    return Object.fromEntries(FORM_SOURCES[source].fields.map(key=>[key,row[key]??null])) as Snapshot;
  });
}
export function validateConnections(fields:FieldDef[]):void {
  const keys=new Set<string>();
  for(const field of fields) {
    if(['__proto__','prototype','constructor','_calculation_snapshot'].includes(field.key))throw new ValidationError('This field key is reserved: '+field.key);
    if(keys.has(field.key))throw new ValidationError('Field keys must be unique: '+field.key);keys.add(field.key);
    if(field.type==='reference' && (!field.source || ['company','user'].includes(field.source)))throw new ValidationError(field.label+': choose a record source');
    if(field.type==='system' && (!field.source || !['company','user'].includes(field.source) || !(FORM_SOURCES[field.source].fields as readonly string[]).includes(field.property||'')))throw new ValidationError(field.label+': choose a company or user property');
    if(field.binding) {
      const selector=fields.find(other=>other.key===field.binding!.field);
      if(!['text','textarea','number'].includes(field.type) || selector?.type!=='reference' || !selector.source || !(FORM_SOURCES[selector.source].fields as readonly string[]).includes(field.binding.property))throw new ValidationError(field.label+': choose a valid connected field and property');
      if(field.type==='number' && selector?.source && !NUMERIC_SOURCE_FIELDS[selector.source].includes(field.binding.property))throw new ValidationError(field.label+': choose a numeric source property');
    }
  }
}
export function resolveConnections(fields:FieldDef[],input:Record<string,unknown>,user:AuthUser,previous:Record<string,unknown>={}):Record<string,unknown> {
  const result={...input};
  for(const field of fields) {
    if(field.type==='system') {
      if(previous[field.key]!==undefined)result[field.key]=previous[field.key];
      else result[field.key]=sourceRows(field.source!,user)[0]?.[field.property!]??'';
    }
    if(field.type!=='reference')continue;
    const raw=input[field.key],old=previous[field.key] as Snapshot|undefined;
    const value=typeof raw==='object' && raw?Number((raw as Snapshot).id):Number(raw);
    if(!value) {if(raw!=null&&raw!=='')throw new ValidationError(field.label+': invalid selection');if(field.required)throw new ValidationError(field.label+' is required');result[field.key]=null;continue;}
    if(!Number.isSafeInteger(value)||value<1)throw new ValidationError(field.label+': invalid selection');
    if(old?.id===value)result[field.key]=old;
    else {
      const selected=sourceRows(field.source!,user,'',value)[0];
      if(!selected)throw new ValidationError(field.label+': this record is no longer available; choose another');
      result[field.key]=selected;
    }
  }
  for(const field of fields)if(field.binding) {
    const ref=result[field.binding.field] as Snapshot|null;
    const value=ref?.[field.binding.property]??'';
    if(field.format==='currency'&&field.binding.property==='sale_price'&&ref&&(ref.currency||'PHP')!==(field.currency||'PHP'))throw new ValidationError(field.label+': catalog currency differs; no currency conversion is performed');
    if(!field.binding.editable || input[field.key]==null || input[field.key]==='')result[field.key]=value;
    if(field.type==='number' && result[field.key]!=='' && !Number.isFinite(Number(result[field.key])))throw new ValidationError(field.label+': enter a finite number');
    if(field.required && (result[field.key]==null || String(result[field.key]).trim()===''))throw new ValidationError(field.label+' is required; the selected record may not have this value');
  }
  return result;
}
