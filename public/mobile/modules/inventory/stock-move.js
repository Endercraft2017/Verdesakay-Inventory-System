/* Existing Stock In / Out routes and item-detail handoff. */
(function(){
  MApp.route('stock-move',function(view,params){return mStockForms.pick(view,params?.mode==='out'?'out':'in');});
  window.mStockMoveForm=function(view,options){return mStockForms.open(view,options.mode==='out'?'out':'in',options.item);};
})();
