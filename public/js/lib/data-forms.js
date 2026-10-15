/* Section policy shared by Data Forms and Form Builder. */
window.DataForms = (() => {
  const scopes = ['hr', 'inventory', 'admin', 'accounting'];
  const labels = { hr: 'HR', inventory: 'Inventory', admin: 'Admin', accounting: 'Accounting', general: 'General' };
  function canManage(scope) {
    return scope
      ? scopes.includes(scope) && App.hasPermission('forms.manage.' + scope)
      : scopes.every((s) => App.hasPermission('forms.manage.' + s));
  }
  function canBrowseScope(scope) {
    return canManage(scope) || (scope === 'hr' && App.hasPermission('payroll.view'));
  }
  const emptyPreferences = () => ({ favorites: [], recent: [], views: {} });
  async function preferences() {
    try { const value = await API.get('/data-forms/preferences'); return value && !Array.isArray(value) && Array.isArray(value.favorites) ? value : emptyPreferences(); }
    catch { return { ...emptyPreferences(), unavailable: true }; }
  }
  async function savePreference(change) { return API.put('/data-forms/preferences', change); }
  function displayValue(value){return Array.isArray(value)?value.map(row=>typeof row==='object'&&row?`${row.name||'Item'} × ${row.quantity??''} · ${row.line_total??''}`:String(row)).join('; '):value&&typeof value==='object'?String(value.name||value.number||value.id||''):String(value??'');}
  function displayTime(value) { const text=String(value||'');const date=new Date(text.includes('T')?text:text.replace(' ','T')+'Z');return Number.isNaN(date.getTime())?text:date.toLocaleString(); }
  async function recordHistory(record) {
    const revisions = await API.get('/form-records/' + record.id + '/revisions');
    UI.modal({ title: 'Change history — ' + record.number, size: 'lg', cancelText: 'Close', bodyHTML: revisions.map(row => `<section class="form-history-entry"><h4>Revision ${row.revision} · Form version ${row.definition_version}</h4><p class="muted">${UI.esc(displayTime(row.created_at))} · ${UI.esc(row.changed_by_name || (row.source === 'captured' ? 'Earlier update; author unavailable' : 'System / legacy record'))}</p><p>${UI.esc(row.reason || 'No reason provided')}</p><p>Status: ${UI.esc(row.status)}</p>${(row.schema?.fields || []).map(field => `<div class="tool-row"><strong>${UI.esc(field.label)}</strong><span>${UI.esc(displayValue(row.data[field.key]))}</span></div>`).join('')}</section>`).join('') || '<p>No history available.</p>' });
  }
  async function definitionHistory(form) {
    const versions = await API.get('/form-definitions/' + form.id + '/versions');
    UI.modal({ title: 'Form versions — ' + form.name, size: 'lg', cancelText: 'Close', bodyHTML: versions.map(row => `<section class="form-history-entry"><h4>Version ${row.version}: ${UI.esc(row.definition.name)}</h4><p class="muted">${UI.esc(displayTime(row.created_at))} · ${UI.esc(row.created_by_name || 'System')}</p>${row.legacy_baseline ? '<p class="muted">Baseline captured when versioning was introduced; earlier definitions cannot be reconstructed.</p>' : ''}<p>${UI.esc(row.reason || 'No reason provided')}</p><table><thead><tr><th>Field</th><th>Key</th><th>Type</th><th>Required</th></tr></thead><tbody>${row.definition.fields.map(field => `<tr><td>${UI.esc(field.label)}</td><td>${UI.esc(field.key)}</td><td>${UI.esc(field.type)}</td><td>${field.required ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></section>`).join('') });
  }
  return { scopes, labels, canManage, canBrowseScope, preferences, savePreference, recordHistory, definitionHistory, displayTime, displayValue };
})();
