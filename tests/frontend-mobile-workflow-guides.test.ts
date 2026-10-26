import {it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
function boot(){
 const dom=new JSDOM('<main id="m-app"><div id="m-view"></div></main>',{runScripts:'outside-only',url:'https://localhost/m#/guides'}),w=dom.window as any;
 const registry=['product-setup','notes','work','requests','approvals','sales','order-tracking','job-orders','kit-release','qc','receiving','repairs','so','purchase-requests','record','stock-counts','new-item','stock-move','transfer','low-stock','assign-qr','damage','my-log','deliveries'];
 let allowed=new Set(registry),employee=true,disabledModules=new Set<string>();
 w.MApp={getMe:()=>({role:'employee'}),can:()=>false,routes:()=>registry,canOpen:(r:string)=>allowed.has(r),isEmployee:()=>employee,hasModule:(m:string)=>!disabledModules.has(m)};
 for(const file of ['js/nav-config.js','js/guide-data.js','mobile/lib/workflow-guide.js'])w.eval(fs.readFileSync(path.join(import.meta.dirname,'../public',file),'utf8')+(file==='js/nav-config.js'?';window.NAV=NAV;':''));
 return {dom,w,registry,deny:(r:string)=>allowed.delete(r),employee:(v:boolean)=>employee=v,disable:(m:string)=>disabledModules.add(m)};
}
it('retains every published guide in one department and preserves module visibility',()=>{
 const {dom,w,disable}=boot(),items=w.MobileWorkflow.items();expect(items).toHaveLength(w.GUIDE.pipelines.length);
 const groups=w.MobileWorkflow.groups.map((g:string[])=>g[0]);expect(items.every((p:any)=>groups.includes(w.MobileWorkflow.group(p)))).toBe(true);
 disable('manufacturing');expect(w.MobileWorkflow.items().some((p:any)=>p.id==='production'||p.id==='quality-to-rts')).toBe(false);dom.window.close();
});
it('opens only registered destinations allowed by current access and keeps web administration as reference',()=>{
 const {dom,w,registry,deny}=boot();
 for(const guide of w.MobileWorkflow.items())for(const row of w.MobileWorkflow.plan(guide))if(row.available)expect(registry).toContain(row.destination.route);
 expect(w.MobileWorkflow.plan(w.GUIDE.byId.payroll).every((s:any)=>!s.available)).toBe(true);
 deny('sales');expect(w.MobileWorkflow.plan(w.GUIDE.byId.sales)[0].destination.route).toBe('order-tracking');
 deny('order-tracking');expect(w.MobileWorkflow.plan(w.GUIDE.byId.sales)[0].available).toBe(false);
 expect(w.MobileWorkflow.plan({id:'unknown',steps:[{title:'Unknown',to:{external:'/m#/not-registered?step=confirm'}}]})[0].available).toBe(false);dom.window.close();
});
it('does not treat a missing employee profile as permission to file a personal request',()=>{
 const {dom,w,employee}=boot();employee(false);const row=w.MobileWorkflow.plan(w.GUIDE.byId['file-request'])[0];expect(row.available).toBe(false);expect(row.label).toBe('Employee profile required');dom.window.close();
});
it('does not navigate denied or web-only steps or mutate the shared authored records',()=>{
 const {dom,w,deny}=boot(),before=JSON.stringify(w.GUIDE.pipelines);deny('job-orders');
 expect(w.MobileWorkflow.visit(w.GUIDE.byId.production,3)).toBe(false);
 expect(w.MobileWorkflow.visit(w.GUIDE.byId.payroll,0)).toBe(false);expect(JSON.stringify(w.GUIDE.pipelines)).toBe(before);dom.window.close();
});

it('uses the shared desktop permission rules for a real tenant-scoped Product Setup link',()=>{
 const {dom,w,deny}=boot();expect(w.MobileWorkflow.plan(w.GUIDE.byId.production)[1].destination.route).toBe('product-setup');expect(w.MobileWorkflow.plan(w.GUIDE.byId.production)[1].available).toBe(true);deny('product-setup');w.VDS_BASE_PATH='/tenant';w.MApp.can=(p:string)=>p==='production.view';const row=w.MobileWorkflow.plan(w.GUIDE.byId.production)[1];expect(row.available).toBe(false);expect(row.web.href).toBe('/tenant/index.html#finished-products');w.MApp.can=()=>false;expect(w.MobileWorkflow.plan(w.GUIDE.byId.production)[1].web).toBeNull();dom.window.close();
});

it('keeps legacy and role palettes attached to the canonical mobile tokens',()=>{
 const legacy=fs.readFileSync(path.join(import.meta.dirname,'../public/mobile/mobile.css'),'utf8');
 const roles=fs.readFileSync(path.join(import.meta.dirname,'../public/mobile/role-kit.css'),'utf8');
 const modern=fs.readFileSync(path.join(import.meta.dirname,'../public/mobile/mobile-v2.css'),'utf8');
 const aliases=[...legacy.matchAll(/--m-(?:bg|surface(?:-2)?|text|muted|border|accent(?:-text)?):\s*([^;]+);/g)];expect(aliases.length).toBeGreaterThan(12);expect(aliases.every(m=>m[1]?.startsWith('var(--v2-'))).toBe(true);
 expect(roles).not.toMatch(/data-role-accent[^{]*\{/);expect(roles).not.toMatch(/--rk-[a-z-]+:\s*#/);
 const controls=fs.readFileSync(path.join(import.meta.dirname,'../public/mobile/controls.css'),'utf8');expect(controls).toContain('border-radius: var(--m-ux-control-radius)');
 expect([...modern.matchAll(/--role-accent:\s*([^;}]+)/g)].every(m=>m[1]==='var(--v2-green)')).toBe(true);
});
