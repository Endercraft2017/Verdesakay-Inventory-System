/* One IndexedDB protocol shared by the page and service worker. A lease prevents
   overlapping sends/discards; its expiry recovers a closed/crashed sender. A retry
   always keeps the original key/body, including after an uncertain outcome. */
(function (global) {
  function create(base) {
    var opened;
    function db() {
      if (opened) return opened;
      opened = new Promise(function (resolve, reject) {
        var request = indexedDB.open('vds_mobile' + (base || ''), 2), failed = false;
        request.onupgradeneeded = function () {
          ['ops', 'meta'].forEach(function (name) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath:name === 'ops' ? 'key' : 'k'});
          });
        };
        request.onsuccess = function () {
          if (failed) { request.result.close(); return; }
          request.result.onversionchange = function () { request.result.close(); opened = null; };
          resolve(request.result);
        };
        request.onerror = request.onblocked = function () { failed = true; reject(request.error || new Error('Phone storage is unavailable. Close other app tabs and retry.')); };
      }).catch(function (error) { opened = null; throw error; });
      return opened;
    }
    function request(store, mode, invoke) {
      return db().then(function (database) {
        return new Promise(function (resolve, reject) {
          var tx = database.transaction(store, mode), result;
          try { result = invoke(tx.objectStore(store)); } catch (error) { tx.abort(); reject(error); return; }
          tx.oncomplete = function () { resolve(result && 'result' in result ? result.result : result); };
          tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Phone storage could not be updated.')); };
        });
      });
    }
    // Both records are read in the same transaction as a conditional write.
    function edit(key, invoke) {
      return db().then(function (database) {
        return new Promise(function (resolve, reject) {
          var tx = database.transaction(['ops','meta'], 'readwrite'), ops = tx.objectStore('ops');
          var item = ops.get(key), token = tx.objectStore('meta').get('token'), result, count = 0, failure;
          function ready() {
            if (++count !== 2) return;
            try {
              var change = invoke(item.result, token.result) || {};
              if (change.remove) ops.delete(key);
              else if (change.row) ops.put(change.row);
              result = change.value;
            } catch (error) { failure = error; tx.abort(); }
          }
          item.onsuccess = token.onsuccess = ready;
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = tx.onabort = function () { reject(failure || tx.error || new Error('Phone storage could not be updated.')); };
        });
      });
    }
    function owns(row, owner) {
      return !!owner && owner.user_id != null && (row.user_id == null || row.user_id === owner.user_id)
        && (row.server_base == null || row.server_base === owner.api_base);
    }
    function authenticated(meta, owner) {
      return !!meta && !!owner && meta.v === owner.v && meta.user_id === owner.user_id && (meta.api_base || '') === (owner.api_base || '');
    }
    function busy(row) { return !!row.lease && row.lease.until > Date.now(); }
    return {
      request:request, edit:edit, owns:owns, busy:busy,
      all:function () { return request('ops','readonly',function (s) { return s.getAll(); }).then(function (rows) { return (rows || []).sort(function (a,b) { return a.created-b.created; }); }); },
      token:function () { return request('meta','readonly',function (s) { return s.get('token'); }); },
      claim:function (key, owner, lease, force) {
        return edit(key,function (row,meta) {
          if (!row || !authenticated(meta,owner) || !owns(row,owner) || busy(row) || row.local_command || (!force && row.error)) return {};
          row.lease = {id:lease,until:Date.now()+45000}; row.error = null;
          return {row:row,value:row};
        });
      },
      settle:function (key, lease, patch) {
        return edit(key,function (row) {
          // Never resurrect a discarded copy or overwrite a newer sender's result.
          if (!row || row.lease?.id !== lease) return {};
          if (patch === null) return {remove:true,value:true};
          delete row.lease; Object.assign(row,patch);
          return {row:row,value:true};
        });
      },
      discard:function (key, owner, current) {
        return edit(key,function (row,meta) {
          if (!current() || !authenticated(meta,owner)) throw new Error('The sign-in changed. Reopen Pending sync.');
          if (!row || !owns(row,owner)) return {};
          if (busy(row)) throw new Error('This action is sending. Wait for its result before discarding the phone copy.');
          return {remove:true,value:true};
        });
      }
    };
  }
  global.MobileQueueStore = {create:create};
})(typeof window === 'undefined' ? self : window);
