import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

it('reserves a modal before slow loading, keeps one instance, and permits reopening after close', async () => {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/#inventory' });
  const w = dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
    let release: () => void = () => {}, opens = 0;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const open = async () => { opens++; await ready; return w.UI.modal({title:'New item',bodyHTML:'<input value="Draft">'}); };
    const first = w.UI.modalTask('new-item', open);
    expect(w.UI.modalTask('new-item', open)).toBe(first);
    release(); const dialog = await first;
    expect(opens).toBe(1);
    expect(w.document.querySelectorAll('[role=dialog]').length).toBe(1);
    expect(await w.UI.modalTask('new-item', open)).toBe(dialog);
    dialog.close(); await w.UI.modalTask('new-item', open);
    expect(opens).toBe(2);
  } finally { dom.window.close(); }
});

it('releases a failed opener and discards a dialog loaded after navigation', async () => {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>', {runScripts:'outside-only',url:'https://localhost/#inventory'});
  const w=dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url),'utf8')+';window.UI=UI;');
    expect(await w.UI.modalTask('item',async()=>{throw Error('Sample failure');})).toBeNull();
    let release:()=>void=()=>{};const wait=new Promise<void>(resolve=>{release=resolve;});
    const loading=w.UI.modalTask('item',async()=>{await wait;return w.UI.modal({title:'Item',bodyHTML:'<p>Sample</p>'});});
    w.location.hash='#settings';release();
    expect(await loading).toBeNull();
    expect(w.document.querySelector('[role=dialog]')).toBeNull();
    expect(await w.UI.modalTask('item',async()=>w.UI.modal({title:'Item',bodyHTML:'<p>Sample</p>'}))).toBeTruthy();
  } finally {dom.window.close();}
});

it('runs one shared modal submission while a slow request is pending',async()=>{
  const dom=new JSDOM('<div id="view"></div><div id="modal-root"></div>',{runScripts:'outside-only',url:'https://localhost/'});const w=dom.window as any;
  try{
    w.eval(fs.readFileSync(new URL('../public/js/ui.js',import.meta.url),'utf8')+';window.UI=UI;');
    let calls=0,release:()=>void=()=>{};const wait=new Promise<void>(resolve=>{release=resolve;});
    const modal=w.UI.modal({title:'Save',bodyHTML:'<p>Sample</p>',confirmText:'Save',onConfirm:async()=>{calls++;await wait;return false;}});
    const button=modal.overlay.querySelector('[data-confirm]');button.click();button.dispatchEvent(new w.MouseEvent('click'));button.dispatchEvent(new w.MouseEvent('click'));
    expect(calls).toBe(1);release();await wait;await new Promise(resolve=>setTimeout(resolve,0));
    expect(button.disabled).toBe(false);
  }finally{dom.window.close();}
});

it('keeps push ownership failures visible and shares a slow browser permission request',async()=>{
  const dom=new JSDOM('',{runScripts:'outside-only',url:'https://localhost/'});const w=dom.window as any;
  try{
    let requests=0,release:(value:string)=>void=()=>{};
    const permission=new Promise<string>(resolve=>{release=resolve;});
    const subscription={endpoint:'sample',toJSON:()=>({endpoint:'sample'})};
    const registration={pushManager:{getSubscription:async()=>subscription}};
    Object.defineProperty(w.navigator,'serviceWorker',{value:{getRegistration:async()=>registration,ready:Promise.resolve(registration)}});
    w.PushManager=function(){};w.Notification={permission:'granted',requestPermission:()=>{requests++;return permission;}};
    let failStatus=true;
    w.API={isSharedSession:()=>false,get:async(path:string)=>{if(path.startsWith('/push/status')){if(failStatus)throw Error('Sample offline');return{this_device:false};}return{key:'sample'};},post:async()=>({})};
    w.eval(fs.readFileSync(new URL('../public/mobile/lib/push.js',import.meta.url),'utf8'));
    await expect(w.mPush.status()).rejects.toThrow('Sample offline');
    failStatus=false;expect(await w.mPush.status()).toBe('off');
    const first=w.mPush.enable();expect(w.mPush.enable()).toBe(first);
    await Promise.resolve();expect(requests).toBe(1);release('granted');expect(await first).toBe('on');
  }finally{dom.window.close();}
});
