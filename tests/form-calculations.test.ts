import {it,expect} from 'vitest';
import '../public/js/lib/form-math.js';
const math=(globalThis as any).FormMath;
it('rounds monetary row totals, discounts and zero prices consistently',()=>{
 expect(math.line(3,0.1)).toBe(0.3);expect(math.line(2,100,10)).toBe(180);expect(math.line(0.5,99.99)).toBe(50);expect(math.line(2,0)).toBe(0);expect(math.line(2,100,100)).toBe(0);
 for(const values of [[0,1],[-1,1],[1,-1],[1,1,101],[1,1,-1],[Infinity,1],[1,'garbage'],[1e30,1]])expect(()=>math.line(...values)).toThrow();
});
it('evaluates dependent calculations independently of field order without trusting supplied totals',()=>{
 const fields=[{key:'total',label:'Total',type:'calculated',calculation:{operator:'sum',operands:['subtotal','tax']}},{key:'tax',label:'Tax',type:'calculated',calculation:{operator:'percent',operands:['subtotal','rate']}},{key:'subtotal',label:'Subtotal',type:'calculated',calculation:{operator:'sum',operands:['items.line_total']}},{key:'rate',label:'Rate',type:'number'},{key:'items',label:'Items',type:'line_items'}];
 expect(math.calculate(fields,{items:[{line_total:0.1},{line_total:0.2}],rate:12,total:999})).toMatchObject({subtotal:0.3,tax:0.04,total:0.34});
 expect(math.calculate(fields,{items:[],rate:0})).toMatchObject({total:0,subtotal:0,tax:0});
});
it('rejects cycles, unknown paths, nonnumeric dependencies and unsafe amounts',()=>{
 expect(()=>math.validate([{key:'a',label:'A',type:'calculated',calculation:{operator:'sum',operands:['a']}}])).toThrow(/cycle/);
 expect(()=>math.validate([{key:'a',label:'A',type:'calculated',calculation:{operator:'sum',operands:['missing']}}])).toThrow(/unknown/);
 expect(()=>math.validate([{key:'text',label:'Text',type:'text'},{key:'a',label:'A',type:'calculated',calculation:{operator:'sum',operands:['text']}}])).toThrow(/numeric/);
 expect(()=>math.round(Infinity)).toThrow();expect(()=>math.number(true)).toThrow();expect(()=>math.number('')).toThrow();
});
