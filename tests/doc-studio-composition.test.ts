import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-studio.js',import.meta.url),'utf8');

describe('shared editing during composition',()=>{
  it('defers an in-flight room response until composition has finished',async()=>{
    const dom=new JSDOM('<div id="editor"><div class="doc-fs-bar-actions"></div><div id="surface"></div></div>',{url:'https://studio.test',runScripts:'dangerously'});
    const w=dom.window as any;
    let composing=false, snapshot={body:'<p>Saved</p>'};
    const remote={snapshot:{body:'<p>Remote</p>'},version:2,saved_revision:'r2',room_saved_revision:'r2'};
    let resolveRoom!: (value:unknown)=>void;
    const pending=new Promise(resolve=>{resolveRoom=resolve;});
    let first=true;
    w.API={get:vi.fn((url:string)=>url.endsWith('/library')?Promise.resolve([]):url.endsWith('/draft')?Promise.resolve(null):first?(first=false,pending):Promise.resolve(remote)),put:vi.fn(),del:vi.fn(async()=>({})),post:vi.fn(async()=>[])};
    w.eval(source);
    const apply=vi.fn((value:any)=>{snapshot=value;});
    const shared=w.DocStudio.mount(w.document.querySelector('#editor'),{documentKey:'template:1',getSavedRevision:()=> 'r1'}, {
      surface:w.document.querySelector('#surface'),snapshot:()=>snapshot,dirty:()=>false,isComposing:()=>composing,
      markBlocks:vi.fn(),apply,render:vi.fn(),safeUrl:()=>true,
    });
    try{
      await Promise.resolve(); await Promise.resolve(); composing=true; resolveRoom(remote); await shared.ready;
      expect(apply).not.toHaveBeenCalled(); expect(snapshot.body).toBe('<p>Saved</p>');
      composing=false; await shared.prepareSave();
      expect(apply).toHaveBeenCalledOnce(); expect(snapshot.body).toBe('<p>Remote</p>');
    }finally{shared.close();dom.window.close();}
  });
});
