/* All app scripts use these scoped storage objects. The browser's native storage stays
   intact; tokens, kiosk grants, drafts and preferences belong to this tenant's namespace. */
function tenantStorage(storage) {
  var prefix = window.VDS_BASE_PATH ? 'tenant:' + window.VDS_BASE_PATH + ':' : '';
  if (!prefix) return storage;
  function keys() {
    var out = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key && key.indexOf(prefix) === 0) out.push(key.slice(prefix.length));
    }
    return out;
  }
  return {
    getItem: function (key) { return storage.getItem(prefix + key); },
    setItem: function (key, value) { storage.setItem(prefix + key, value); },
    removeItem: function (key) { storage.removeItem(prefix + key); },
    clear: function () { keys().forEach(function (key) { storage.removeItem(prefix + key); }); },
    key: function (index) { return keys()[index] || null; },
    get length() { return keys().length; },
  };
}
// Lexical bindings scope existing scripts without replacing browser APIs or their prototypes.
function browserStorage(name) {
  try { return tenantStorage(window[name]); }
  catch (e) {
    var memory = new Map();
    return {
      getItem: function (key) { return memory.has(key) ? memory.get(key) : null; },
      setItem: function (key, value) { memory.set(String(key), String(value)); },
      removeItem: function (key) { memory.delete(String(key)); },
      clear: function () { memory.clear(); },
      key: function (index) { return Array.from(memory.keys())[index] || null; },
      get length() { return memory.size; },
    };
  }
}
const localStorage = browserStorage('localStorage');
const sessionStorage = browserStorage('sessionStorage');
