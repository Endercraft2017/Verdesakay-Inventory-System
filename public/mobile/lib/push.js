/* Web-push subscription management for the mobile app.
   mPush.isSupported() / status() / enable() / disable() / release() / test()

   A browser has ONE push subscription, but on a shared phone the server may have it registered
   to whoever last turned notifications on there. status() therefore asks the server whether
   this subscription is the signed-in person's; release() (called on sign-out) drops it when it
   is, so their notifications stop arriving on a phone they've left. On a borrowed-phone
   sign-in notifications stay off ('shared'). */
(function () {
  function urlB64ToUint8(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function reg() { return navigator.serviceWorker.getRegistration((window.VDS_BASE_PATH || '') + '/m'); }

  var mPush = {
    isSupported: isSupported,

    /** 'unsupported' | 'no-sw' | 'denied' | 'shared' | 'off' | 'on' */
    status: function () {
      if (window.API && API.isSharedSession && API.isSharedSession()) return Promise.resolve('shared');
      if (!isSupported()) return Promise.resolve('unsupported');
      if (Notification.permission === 'denied') return Promise.resolve('denied');
      return reg().then(function (r) {
        if (!r || !r.pushManager) return 'no-sw';
        return r.pushManager.getSubscription().then(function (s) {
          if (!s) return 'off';
          // Subscribed in this browser — but is it registered to the person signed in now?
          return API.get('/push/status?endpoint=' + encodeURIComponent(s.endpoint))
            .then(function (st) { return st && st.this_device === true ? 'on' : 'off'; });
        });
      });
    },

    enable: function () {
      if (!isSupported()) return Promise.reject(new Error('This device can’t show notifications'));
      return Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') throw new Error('Notification permission was not granted');
        return Promise.all([navigator.serviceWorker.ready, API.get('/push/key')]);
      }).then(function (r) {
        var registration = r[0], key = r[1].key;
        return registration.pushManager.getSubscription().then(function (existing) {
          return existing || registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8(key),
          });
        });
      }).then(function (sub) {
        return API.post('/push/subscribe', sub.toJSON());
      }).then(function () { return 'on'; });
    },

    disable: function () {
      return reg().then(function (r) {
        if (!r) return 'off';
        return r.pushManager.getSubscription().then(function (sub) {
          if (!sub) return 'off';
          return API.post('/push/unsubscribe', { endpoint: sub.endpoint })
            .then(function () { return sub.unsubscribe(); })
            .then(function () { return 'off'; });
        });
      });
    },

    /** On sign-out: unsubscribe this browser if its subscription is the signed-in person's
        (a coworker's own subscription on their phone is left alone). */
    release: function () {
      if (!isSupported()) return Promise.resolve();
      return reg().then(function (r) {
        if (!r || !r.pushManager) return;
        return r.pushManager.getSubscription().then(function (sub) {
          if (!sub) return;
          return API.get('/push/status?endpoint=' + encodeURIComponent(sub.endpoint)).then(function (st) {
            if (!st || !st.this_device) return;
            return API.post('/push/unsubscribe', { endpoint: sub.endpoint })
              .catch(function () {})
              .then(function () { return sub.unsubscribe(); });
          });
        });
      }).catch(function () {});
    },

    test: function () { return API.post('/push/test'); },
  };

  // A second tap (including after reopening Settings) shares the existing permission/setup job.
  var changePending = null;
  ['enable', 'disable'].forEach(function (name) {
    var change = mPush[name];
    mPush[name] = function () {
      if (changePending) return changePending;
      changePending = Promise.resolve().then(change).finally(function () { changePending = null; });
      return changePending;
    };
  });
  window.mPush = mPush;
})();
