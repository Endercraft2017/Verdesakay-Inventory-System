/* Camera acquisition is simulated; native lookup, line selection and sticker gates run. */
(function(){
  if(!__SCRATCH_CONFIG__.releaseReview)return;
  window.__nativeScannerOpen=mScanner.open;window.__scanTrace=[];
  mScanner.open=function(options){var previous=document.activeElement,reader=mEl('<dialog class="m-profile-dialog" aria-labelledby="release-reader-title"><h2 id="release-reader-title">Simulated label reader</h2><p>Choose a fictional sticker to present. This does not test a physical camera.</p><div class="m-actions" data-codes></div><p role="status" data-reader-status></p><button type="button" class="rk-btn secondary m-ux-action" data-close>Cancel</button></dialog>');document.body.appendChild(reader);reader.showModal();var closed=false;
    var handle={close:function(){if(closed)return;closed=true;reader.close();reader.remove();if(previous?.isConnected)previous.focus({preventScroll:true});}};
    __releaseFixture.codes.concat(['WRONG-LABEL']).forEach(function(code){var button=mEl('<button type="button" class="rk-btn secondary m-ux-action"></button>');button.textContent=code;button.onclick=function(){window.__scanTrace.push({code:code,at:Date.now()});if(options.continuous){options.onResult(code,{source:"camera",capturedAt:Date.now(),simulated:true});if(!closed)reader.querySelector('[data-reader-status]').textContent='Label presented. Verification decides whether it matches.';}else{handle.close();options.onResult(code,{source:"camera",capturedAt:Date.now(),simulated:true});}};reader.querySelector('[data-codes]').appendChild(button);});
    reader.querySelector('[data-close]').onclick=handle.close;reader.oncancel=function(e){e.preventDefault();handle.close();};reader.querySelector('[data-close]').focus();return handle;
  };
})();
