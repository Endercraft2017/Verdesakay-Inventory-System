/** Retain source values validated by the originating server across trusted command replay.
 * Ordinary HTTP requests never get to supply a previous snapshot. */
import type {AuthUser,FieldDef} from '../../shared/types';
import {syncContext,reRunOfRecordedCommand} from '../../shared/sync-context';
import {sourceAvailable} from './sources';
const key='data_form';
const connected=(field:FieldDef)=>['reference','system','line_items'].includes(field.type);
export function recordedReferences(formId:number,version:number,fields:FieldDef[],user:AuthUser):Record<string,unknown>{
 if(!reRunOfRecordedCommand())return {};
 const snapshot=syncContext()?.validatedSnapshots?.[key] as {form_id:number;definition_version:number;values:Record<string,unknown>}|undefined;
 if(!snapshot)return {}; // Compatibility for commands recorded by older app versions.
 if(snapshot.form_id!==formId||snapshot.definition_version!==version)throw Object.assign(new Error('This form changed while the record was offline. Review its saved values before resubmitting.'),{status:409});
 const result:Record<string,unknown>={};
 for(const field of fields.filter(connected)){
  const value=snapshot.values?.[field.key];if(value===undefined)continue;
  const source=field.type==='line_items'?'product':field.source;
  if(value!=null&&(!Array.isArray(value)||value.length)&&source&&!sourceAvailable(source,user))throw Object.assign(new Error('The connected source is no longer available to this account'),{status:403});
  result[field.key]=value;
 }
 return result;
}
export function captureReferences(formId:number,version:number,fields:FieldDef[],data:Record<string,unknown>):void{
 const ctx=syncContext();if(ctx?.mode!=='record')return;
 const selected=fields.filter(connected);if(!selected.length)return;
 (ctx.validatedSnapshots??={})[key]={form_id:formId,definition_version:version,values:Object.fromEntries(selected.filter(field=>Object.hasOwn(data,field.key)).map(field=>[field.key,data[field.key]]))};
}
