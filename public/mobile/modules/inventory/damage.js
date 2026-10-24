/* Existing Report Damage route and item-detail handoff; offline queue retained. */
(function(){
  MApp.route('damage',function(view){return mStockForms.pick(view,'damage');});
  window.mDamageForm=function(view,item){return mStockForms.open(view,'damage',item);};
})();
