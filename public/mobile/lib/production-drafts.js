/* Production drafts. IndexedDB keeps File/Blob bytes and immutable unit-upload or
   JSON approval/acceptance/output/scrap and warehouse attempts across restarts. No background submission: the operator explicitly retries.
   Keys include the API server/tenant and signed-in account, including on shared phones. */
(function () {
  var opening;
  var writes = {};
  function scope() {
    var me = MApp.getMe();
    if (!me || me.id == null) throw new Error('Sign in before opening production drafts.');
    return JSON.stringify([API.base(), me.id]);
  }
  function key(jobId) { return scope() + ':' + jobId; }
  function db() {
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('Draft storage is unavailable. Enable browser storage before saving this action.')); return; }
      var req = indexedDB.open('vds_production_drafts', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('drafts', { keyPath: 'key' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(new Error('Could not open production draft storage.')); };
      req.onblocked = function () { reject(new Error('Close other app tabs to open production draft storage.')); };
    }).catch(function (err) { opening = null; throw err; });
    return opening;
  }
  function transaction(mode, action) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('drafts', mode), req;
        try { req = action(tx.objectStore('drafts')); } catch (err) { reject(err); return; }
        tx.oncomplete = function () { resolve(req.result); };
        tx.onerror = tx.onabort = function () { reject(new Error('Could not save this attempt on the device. Free storage and keep the original attempt for recovery.')); };
      });
    });
  }
  function snapshot(s) {
    return { key: s.key, batch: s.batch, operation: s.operation ? JSON.parse(JSON.stringify(s.operation)) : null, rows: s.rows.map(function (r) {
      return { identifier: r.identifier, file: r.file, saved: !!r.saved, unitId: r.unitId || null,
        local: r.local || null, attempt: r.attempt ? Object.assign({}, r.attempt) : null };
    }) };
  }
  function change(s, data) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts'), error, revision;
        var req = store.get(s.key);
        req.onsuccess = function () {
          var current = req.result;
          if ((current ? current.revision || 0 : 0) !== (s.revision || 0)) {
            error = new Error('This draft changed in another tab. Reload before saving another action.');
            tx.abort(); return;
          }
          revision = (s.revision || 0) + 1;
          if (data) { data.revision = revision; store.put(data); }
          else store.delete(s.key);
        };
        tx.oncomplete = function () { s.revision = data ? revision : 0; resolve(); };
        tx.onerror = tx.onabort = function () { reject(error || new Error('Could not save this attempt on the device. Free storage and keep the original attempt for recovery.')); };
      });
    });
  }
  function save(s) {
    var data = snapshot(s);
    // Keep rapid input/photo saves in order; a prior failed save may be retried.
    var next = (writes[s.key] || Promise.resolve()).catch(function () {}).then(function () {
      return change(s, data);
    });
    writes[s.key] = next;
    return next;
  }
  function load(jobId) {
    var k = key(jobId);
    return (writes[k] || Promise.resolve()).catch(function () {}).then(function () {
      return transaction('readonly', function (store) { return store.get(k); });
    }).then(function (s) {
      if (s) {
        s.rows.forEach(function (r) { if (r.attempt && r.attempt.state === 'sending') r.attempt.state = 'unknown'; });
        if (s.operation && s.operation.state === 'sending') s.operation.state = 'unknown';
      }
      return s || null;
    });
  }
  function remove(s) {
    return (writes[s.key] || Promise.resolve()).catch(function () {}).then(function () {
      return change(s, null);
    });
  }
  // Discover interrupted approvals even after the server removes an approved
  // draft from its awaiting-approval queue. Never cross an account/tenant scope.
  function listActions(kind, namespace) {
    var pattern = namespace === 'issue' ? /^\d+:[A-Za-z0-9-]+:action$/ : /^\d+:action$/;
    var prefix = scope() + ':' + (namespace ? namespace + ':' : '');
    return Promise.all(Object.keys(writes).map(function (k) { return writes[k].catch(function () {}); })).then(function () {
      return transaction('readonly', function (store) { return store.getAllKeys(); }).then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.indexOf(prefix) === 0 && pattern.test(k.slice(prefix.length)); })
          .map(function (k) { return transaction('readonly', function (store) { return store.get(k); }); }));
      });
    }).then(function (records) {
      return records.filter(function (s) { return s && s.key.indexOf(prefix) === 0 && pattern.test(s.key.slice(prefix.length)) && s.operation && s.operation.kind === kind; })
        .map(function (s) { if (s.operation.state === 'sending') s.operation.state = 'unknown'; var id = Number(s.key.slice(prefix.length).split(':')[0]); return { id: id, jobId: id, record: s }; });
    });
  }
  function approvalCount(rows) {
    return listActions('approve').then(function (saved) {
      return new Set(rows.map(function (j) { return j.id; }).concat(saved.map(function (s) { return s.jobId; }))).size;
    });
  }
  window.mProductionDrafts = { key: key, load: load, save: save, remove: remove,
    listActions: listActions, approvalCount: approvalCount,
    loadAction: function (jobId) { return load(jobId + ':action'); } };
})();
