/* Section policy shared by Data Forms and Form Builder. */
window.DataForms = (() => {
  const scopes = ['hr', 'inventory', 'admin', 'accounting'];
  const labels = { hr: 'HR', inventory: 'Inventory', admin: 'Admin', accounting: 'Accounting', general: 'General' };
  function canManage(scope) {
    return scope
      ? scopes.includes(scope) && App.hasPermission('forms.manage.' + scope)
      : scopes.every((s) => App.hasPermission('forms.manage.' + s));
  }
  return { scopes, labels, canManage };
})();
