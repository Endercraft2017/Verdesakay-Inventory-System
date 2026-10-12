/** The browser and automated notices share the same escaped variables, loops and formulas. */
import { createRequire } from 'node:module';
import { queryAll } from './db';
import type { DocVariable } from './types';
const requireClient=createRequire(import.meta.url);
const {renderTemplate}=requireClient('../../public/js/doc-template.js') as {renderTemplate:(body:string,ctx:Record<string,unknown>)=>string};
const {applyVariables}=requireClient('../../public/js/doc-context.js') as {applyVariables:(ctx:Record<string,unknown>,variables:DocVariable[])=>Record<string,unknown>};

export function templateVariables(templateId:number):DocVariable[]{
 return queryAll<DocVariable>("SELECT * FROM doc_variables WHERE scope='global' OR (scope='template' AND template_id=?) ORDER BY sort,id",templateId);
}
export function renderDocument(body:string,context:Record<string,unknown>,templateId:number):string {
 const global=Object.fromEntries(queryAll<{key:string;value:string}>('SELECT key,value FROM global_variables').map(v=>[v.key,v.value]));
 return renderTemplate(body,applyVariables({...context,global},templateVariables(templateId)));
}
