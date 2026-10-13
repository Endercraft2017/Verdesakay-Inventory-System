/* Shared local date handling and draft protection for personal tools. */
(function () {
  window.mPersonalTime = {
    input: function (value) { return PersonalUX.input(value); },
    today: function () { var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  };
  var active=null;
  window.mPersonalDraft = {
    arm: function (dirty,busy) { active={hash:location.hash,dirty:dirty,busy:busy}; },
    clear: function () { active=null; },
    allow: function () { if(!active) return true; if(active.busy?.()){mToast('Please wait for saving to finish.');history.replaceState(null,'',active.hash);return false;} if(active.dirty() && !window.confirm('Discard your unsaved changes?')) { history.replaceState(null,'',active.hash); return false; } active=null; return true; }
  };
  window.addEventListener('beforeunload',function(e){if(active && active.dirty()){e.preventDefault();e.returnValue='';}});
})();
