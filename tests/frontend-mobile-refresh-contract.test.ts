import {expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const base=path.resolve('public/mobile');
function files(dir:string):string[]{return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):entry.name.endsWith('.js')?[path.join(dir,entry.name)]:[]);}

// An architectural guard against another page retaining its own ordinary reload
// button. Error retries and explicit business checks are different actions.
it('keeps ordinary Refresh buttons out of the visible mobile page layout',()=>{
  const failures:string[]=[];
  for(const file of files(base)){
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/<button\b(?:(?!<\/button>)[\s\S])*?<\/button>/g)){
      if(/\bRefresh(?:ing)?\b/.test(match[0])&&!/\bhidden\b/.test(match[0]))failures.push(path.relative(base,file)+': '+match[0].slice(0,160));
    }
    for(const match of source.matchAll(/label\s*:\s*['"]Refresh\b[^'"]*['"]/g))failures.push(path.relative(base,file)+': '+match[0]);
  }
  expect(failures).toEqual([]);
});

it('registers the formerly missed HR and stock readers with shared refresh',()=>{
  const readers=['hr/approvals','hr/directory','hr/clock','hr/requests','hr/schedule','hr/time-fix','hr/payslips','core/confidential-reports','inventory/item-detail','inventory/location-view','inventory/low-stock','inventory/stock-count-tasks'];
  for(const reader of readers)expect(fs.readFileSync(path.join(base,'modules',reader+'.js'),'utf8'),reader).toContain('mScreenUX?.bindRefresh');
  expect(fs.readFileSync(path.join(base,'lib/screen-ux.js'),'utf8')).toContain('refreshBinding.available()');
});

it('retains named stock checks and recount safeguards instead of treating them as page reloads',()=>{
  expect(fs.readFileSync(path.join(base,'lib/count-form.js'),'utf8')).toContain('Start a new count');
  expect(fs.readFileSync(path.join(base,'lib/stock-action-ui.js'),'utf8')).toContain('Check latest stock');
  expect(fs.readFileSync(path.join(base,'modules/inventory/sales.js'),'utf8')).toContain('Check latest stock');
  expect(fs.readFileSync(path.join(base,'modules/manufacturing/kit-release.js'),'utf8')).toContain('Check stock and purchasing');
});
