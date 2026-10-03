/* The installed phone app (docs/OFFLINE-FIRST.md §29, phase 7a).

   Loaded only in the APK / iPhone build, before /js/api.js (mobile-app/build-web.mjs puts it in the
   bundled page). The app's pages ship inside it, so it opens with no network at all; what it needs
   is which server to talk to: the company's cloud address, or the site host on the office Wi-Fi.
   That is asked once, on first launch, and kept (localStorage `vds_api_base`).

   window.VDS_NATIVE — true inside the installed app (api.js then sends requests to that server).
   VdsNative.showConnect(done) — the "Connect to your company" screen; calls done() once saved. */
(function () {
  window.VDS_NATIVE = true;
  var KEY = 'vds_api_base';

  function normalise(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      return new URL(s).origin; // scheme + host + port; any path the person typed is dropped
    } catch (e) {
      return '';
    }
  }

  /** Is `base` a Verdesakay server? Resolves to null when it is, or a reason when it isn't. */
  function check(base) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    return fetch(base + '/api/health', ctl ? { signal: ctl.signal } : {})
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { return body && body.ok === true ? null : 'That address answered, but it is not a Verdesakay server.'; })
      .catch(function () { return 'Could not reach that address. Check it, and that this phone is on the right network.'; })
      .then(function (why) { clearTimeout(timer); return why; });
  }

  function showConnect(done) {
    var screen = document.getElementById('m-connect');
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'm-connect';
      screen.className = 'm-screen m-login';
      screen.innerHTML =
        '<form class="m-card" id="m-connect-form" novalidate>' +
          '<div class="m-brand"><div class="m-mark">V</div><h1>Verdesakay</h1><div class="m-sub">Connect to your company</div></div>' +
          '<div id="m-connect-error" class="m-error hidden"></div>' +
          '<label for="m-connect-url">Server address</label>' +
          '<input id="m-connect-url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" ' +
            'placeholder="yourcompany.app.afkcube.com" required />' +
          '<p class="m-connect-help">Your company\'s address, from your administrator. At a site with an office PC ' +
            'that keeps working offline, you can use that PC\'s address instead (for example https://192.168.1.20:3000).</p>' +
          '<button class="m-btn" type="submit">Connect</button>' +
        '</form>';
      document.body.appendChild(screen);
    }
    var login = document.getElementById('m-login');
    if (login) login.classList.add('hidden');
    screen.classList.remove('hidden');
    var form = screen.querySelector('#m-connect-form');
    var input = screen.querySelector('#m-connect-url');
    var err = screen.querySelector('#m-connect-error');
    try { input.value = localStorage.getItem(KEY) || ''; } catch (e) { /* storage blocked */ }
    form.onsubmit = function (e) {
      e.preventDefault();
      var base = normalise(input.value);
      err.classList.add('hidden');
      if (!base) {
        err.textContent = 'Enter the server address, for example yourcompany.app.afkcube.com';
        err.classList.remove('hidden');
        return;
      }
      var btn = form.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      check(base).then(function (why) {
        btn.disabled = false;
        btn.textContent = 'Connect';
        if (why) {
          err.textContent = why;
          err.classList.remove('hidden');
          return;
        }
        try { localStorage.setItem(KEY, base); } catch (e2) { /* storage blocked: kept for this run only */ }
        screen.classList.add('hidden');
        done();
      });
    };
  }

  /** Forget the server; the next start asks again. */
  function forgetServer() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  window.VdsNative = { showConnect: showConnect, forgetServer: forgetServer, check: check, normalise: normalise };
})();
