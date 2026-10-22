import {it,expect} from 'vitest';
import fs from 'node:fs';
const XLSX=new Function('module','require',fs.readFileSync('public/js/vendor/xlsx-style.min.js','utf8')+';return XLSX;')(undefined,undefined);
const module={exports:{} as any};
new Function('module','exports','XLSX',fs.readFileSync('public/js/hr-payroll-export.js','utf8'))(module,module.exports,XLSX);
it('keeps spreadsheet-looking text inert in an actual XLSX round trip with a visible draft notice',()=>{
 const hostile='=HYPERLINK("https://example.test","synthetic")';
 const wb=module.exports.buildPayrollWorkbook([{id:1,number:'COPY',status:'draft',data:{employee_name:hostile,dept_position:'+SYNTHETIC / Staff',total_earnings:1000,net_pay:1000}}],{name:'Payroll',fields:[]},{title:'@SUM(1,2)',copyNotice:'DRAFT — NOT FINAL'});
 const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),read=XLSX.read(bytes,{type:'buffer',cellFormula:true}),cells=Object.values(read.Sheets[read.SheetNames[0]]) as any[];
 expect(cells.find(c=>c?.v===hostile)).toMatchObject({t:'s',v:hostile});expect(cells.some(c=>c?.f)).toBe(false);expect(cells.some(c=>c?.v==='DRAFT — NOT FINAL')).toBe(true);expect(cells.some(c=>c?.v==='@SUM(1,2)'&&c.t==='s')).toBe(true);
});
it('escapes copy notices and employee text in the printable summary',()=>{
 const html=module.exports.buildPayrollSummaryHtml([{data:{employee_name:'<script>synthetic()</script>',net_pay:1}}],{name:'Payroll',fields:[]},{copyNotice:'DRAFT <img src=x>'});
 expect(html).toContain('DRAFT &lt;img src=x&gt;');expect(html).not.toContain('<script>synthetic()');
});
