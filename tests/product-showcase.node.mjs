// Integration contracts for the approved showcase. Runtime motion, pause, focus,
// image recovery and touch checks live in website-showcase.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../website/index.html',import.meta.url),'utf8');
const document=new JSDOM(html).window.document;
test('the marketing page loads exactly one screenshot carousel controller',()=>{
 const scripts=[...document.scripts].map(s=>s.getAttribute('src'));
 assert.equal(scripts.filter(s=>/\/(?:product-showcase|showcase)\.js$/.test(s)).length,1);
 assert(scripts.includes('/site/showcase.js'));
 assert(!scripts.includes('/site/product-showcase.js'));
 assert.equal(document.querySelectorAll('[data-tour-media]').length,1);
 assert.equal(document.querySelectorAll('[data-tour-play]').length,1);
});
test('all six real screen selectors retain static full-size links and exact metadata',()=>{
 const keys=['attendance','payroll','mobile','inventory','production','sales'];
 assert.deepEqual([...document.querySelectorAll('[data-tour-screen]')].map(b=>b.dataset.tourScreen),keys);
 for(const key of keys){const b=document.querySelector('[data-tour-screen='+key+']');assert(b.dataset.tourTitle);assert(b.dataset.tourAlt);assert(b.dataset.tourBrief);assert(document.querySelector('[data-tour-fallback] a[href="'+b.dataset.tourImage+'"]'));}
 assert.match(document.querySelector('[data-tour-screen=sales]').dataset.tourDescription,/in development/i);
});
test('manual controls retain accessible names and remain hidden in the static fallback',()=>{
 assert.equal(document.querySelector('[data-tour-transport]').hidden,true);
 for(const selector of ['[data-tour-prev]','[data-tour-next]','[data-tour-play]'])assert(document.querySelector(selector).getAttribute('aria-label'));
 assert.equal(document.querySelector('[data-tour-controls]').hidden,true);
 assert.equal(document.querySelector('[data-tour-fallback]').hidden,false);
});
test('the shared approved semantic tokens load before marketing styles',()=>{
 const styles=[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.getAttribute('href'));
 assert.equal(styles[0],'/css/otom-tokens.css');
 assert(styles.includes('/site/style.css'));
 assert(styles.includes('/site/vendor/swiper-core.css'));
});
