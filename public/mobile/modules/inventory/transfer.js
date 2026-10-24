/* Existing Transfer route and item-detail handoff. */
(function(){
  MApp.route('transfer',function(view){return mStockForms.pick(view,'transfer');});
  window.mTransferForm=function(view,item){return mStockForms.open(view,'transfer',item);};
})();
