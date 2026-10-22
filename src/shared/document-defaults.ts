import type { DatabaseSync } from 'node:sqlite';

export const BUILTIN_DOCUMENTS = [
  {key:'sale_order',label:'Sales order',name:'Sale Order',type:'sale'},
  {key:'job_order',label:'Job order',name:'Job Order',type:'job'},
  {key:'purchase_request',label:'Purchase request',name:'Purchase Request',type:'purchase'},
  {key:'employee_id',label:'Employee ID card',name:'Employee ID Card',type:'generic'},
  {key:'asset_issuance',label:'Asset issuance form',name:'Asset Issuance Form',type:'generic'},
  {key:'bir_2316',label:'BIR 2316 worksheet',name:'BIR 2316',type:'generic'},
] as const;

export function createDocumentDefaultsSchema(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS document_defaults (
    key TEXT PRIMARY KEY,
    template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL
  )`);
}

export function initializeDocumentDefaults(db:DatabaseSync):void {
  for(const item of BUILTIN_DOCUMENTS){
    if(db.prepare('SELECT key FROM document_defaults WHERE key=?').get(item.key))continue;
    const named=db.prepare('SELECT id FROM doc_templates WHERE name=? AND type=? ORDER BY id LIMIT 1').get(item.name,item.type) as {id:number}|undefined;
    const fallback=item.type!=='generic'?db.prepare('SELECT id FROM doc_templates WHERE type=? ORDER BY id LIMIT 1').get(item.type) as {id:number}|undefined:undefined;
    db.prepare('INSERT INTO document_defaults(key,template_id) VALUES(?,?)').run(item.key,named?.id||fallback?.id||null);
  }
}
