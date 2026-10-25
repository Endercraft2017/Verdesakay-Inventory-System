/* Keep inventory picking quantities above the virtual keyboard and fixed chrome.
   Reads layout only; it never changes quantities, drafts or stock. */
(function () {
  var frame,timer;
  function eligible(input){return input?.isConnected&&!input.disabled&&!input.readOnly&&input.matches('.m-batch-page input[type="number"],.kr-counter input,[data-label-qty]');}
  function visible(el){if(!el)return false;var style=getComputedStyle(el);return style.display!=='none'&&style.visibility!=='hidden'&&el.getBoundingClientRect().height>0;}
  function reveal(){
    var input=document.activeElement;if(!eligible(input))return;
    var viewport=window.visualViewport,top=viewport?.offsetTop||0,bottom=top+(viewport?.height||innerHeight),header=document.querySelector('.m-topbar');
    if(visible(header))top=Math.max(top,header.getBoundingClientRect().bottom);
    [document.querySelector('[data-batch-dock]'),document.querySelector('#m-tabbar')].forEach(function(el){if(visible(el))bottom=Math.min(bottom,el.getBoundingClientRect().top);});
    top+=12;bottom-=12;var r=input.getBoundingClientRect();if(bottom-top<r.height)return;
    if(r.top<top||r.bottom>bottom)window.scrollBy({top:r.top+r.height/2-(top+bottom)/2,left:0,behavior:'instant'});
  }
  function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(reveal);}
  document.addEventListener('focusin',function(e){if(!eligible(e.target))return;schedule();clearTimeout(timer);timer=setTimeout(schedule,220);});
  window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
})();
