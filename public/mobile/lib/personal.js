/* Shared local date handling and draft protection for personal tools. */
(function () {
  window.mPersonalTime = {
    input: function (value) { return PersonalUX.input(value); },
    today: function () { var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  };
  var active=null;
  window.mPersonalDraft = {
    arm: function (dirty,busy,options) { active={hash:location.hash,dirty:dirty,busy:busy,options:options}; },
    clear: function () { active=null; },
    allow: function () {
      if (!active) return true;
      var entry = active, destination = location.hash;
      if (entry.busy?.()) {
        mToast(entry.options?.busyText?.() || 'Please wait for saving to finish.');
        history.replaceState(null, '', entry.hash); return false;
      }
      if (entry.dirty() && entry.options?.confirmLeave) {
        history.replaceState(null, '', entry.hash);
        entry.options.confirmLeave(function () {
          if (active !== entry || entry.busy?.()) return;
          active = null; history.replaceState(null, '', destination); MApp.render();
        });
        return false;
      }
      if (entry.dirty() && !window.confirm('Discard your unsaved changes?')) { history.replaceState(null, '', entry.hash); return false; }
      active = null; return true;
    }

  };
  window.addEventListener('beforeunload',function(e){if(active && active.dirty()){e.preventDefault();e.returnValue='';}});
})();
