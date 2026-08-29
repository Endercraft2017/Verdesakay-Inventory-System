/* Web-push subscription management for the mobile app.
   mPush.isSupported() / status() / enable() / disable() / test() */
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

  function reg() { return navigator.serviceWorker.getRegistration('/m'); }

  var mPush = {
    isSupported: isSupported,

    /** 'unsupported' | 'no-sw' | 'denied' | 'off' | 'on' */
    status: function () {
      if (!isSupported()) return Promise.resolve('unsupported');
      if (Notification.permission === 'denied') return Promise.resolve('denied');
      return reg().then(function (r) {
        if (!r || !r.pushManager) return 'no-sw';
        return r.pushManager.getSubscription().then(function (s) { return s ? 'on' : 'off'; });
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
            .catch(function () {})
            .then(function () { return sub.unsubscribe(); })
            .then(function () { return 'off'; });
        });
      });
    },

    test: function () { return API.post('/push/test'); },
  };

  window.mPush = mPush;
})();
