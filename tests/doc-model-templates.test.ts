import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {setupApp,cleanup,login,type TestContext} from './helpers';
const model=createRequire(import.meta.url)('../public/js/doc-model.js');
let ctx:TestContext,token:string;
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);});afterAll(()=>cleanup(ctx));
describe('seeded template corpus through the document model',()=>{
 it('keeps every field/control token and remains stable after repeated HTML/model conversions',async()=>{
  const h={Authorization:'Bearer '+token},list=await ctx.api.get('/api/templates').set(h);expect(list.status).toBe(200);expect(list.body.length).toBeGreaterThan(20);
  const dom=new JSDOM('<!doctype html>');try{
   for(const entry of list.body){
    const res=await ctx.api.get('/api/templates/'+entry.id).set(h);expect(res.status).toBe(200);
    const body=res.body.body,document=model.fromHtml(body,dom.window.document),html=model.toHtml(document);
    expect(html.match(/\{\{[^}]+\}\}/g)||[],entry.name).toEqual(body.match(/\{\{[^}]+\}\}/g)||[]);
    expect(model.toHtml(model.fromHtml(html,dom.window.document)),entry.name).toBe(html);
   }
  }finally{dom.window.close();}
 });
});
