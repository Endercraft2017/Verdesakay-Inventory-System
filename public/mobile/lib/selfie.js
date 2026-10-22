/* Live front-camera capture. Auto mode retains the two-second countdown/Take now;
   non-auto mode retains Use this photo/Retake. No gallery selection or persisted photo.
   Camera failures stay in the dialog. A clock-owned capture can be cancelled on navigation
   or when its held scan expires; late permission, play and canvas callbacks are discarded. */
(function () {
  var MAX_W = 640, active = null;
  function take(opts) {
    opts = opts || {};
    if (active && opts.key && active.key === opts.key) { active.control.focus(); return active.promise; }
    if (active) active.promise.cancel();
    var auto = opts.auto > 0 ? Math.round(opts.auto) : 0, cancel, overlay, control;
    var promise = new Promise(function (resolve, reject) {
      overlay = mEl('<div class="m-scan m-selfie" role="dialog" aria-modal="true" aria-label="' + mEsc(opts.title || 'Take a selfie') + '">' +
        '<div class="m-scan-head"><span>' + mEsc(opts.title || 'Take a selfie') + '</span><span class="m-scan-head-btns"><button class="m-scan-x" type="button" aria-label="Cancel selfie">×</button></span></div>' +
        '<div class="m-scan-stage m-selfie-stage"><video playsinline muted hidden></video><div class="m-selfie-off"><span aria-hidden="true">◉</span><p>Camera is off</p></div><span class="m-selfie-count" aria-hidden="true" hidden></span></div>' +
        '<div class="m-scan-msg" role="status" aria-live="polite">Starting the camera…</div><div class="m-selfie-error" role="alert" tabindex="-1" hidden></div>' +
        '<div class="m-selfie-actions"><button class="m-btn" type="button" data-shoot disabled>' + (auto ? 'Take now' : 'Take selfie') + '</button><button class="m-btn" type="button" data-use hidden>Use this photo</button><button class="m-btn m-btn-secondary" type="button" data-retake hidden>Retake</button><button class="m-btn" type="button" data-camera-retry hidden>Retry camera</button></div></div>');
      (document.getElementById('m-overlay-root') || document.body).appendChild(overlay);
      var video = overlay.querySelector('video'), stage = overlay.querySelector('.m-selfie-stage'), count = overlay.querySelector('.m-selfie-count');
      var msg = overlay.querySelector('.m-scan-msg'), error = overlay.querySelector('.m-selfie-error'), off = overlay.querySelector('.m-selfie-off');
      var shoot = overlay.querySelector('[data-shoot]'), use = overlay.querySelector('[data-use]'), retake = overlay.querySelector('[data-retake]'), retry = overlay.querySelector('[data-camera-retry]');
      var stream = null, still = null, stillUrl = null, shot = null, settled = false, closed = false, live = false, acquiring = false, shooting = false, ticker = null, expiry = null, version = 0;
      var openingHash = location.hash;
      function stopClock() { if (ticker) clearInterval(ticker); ticker = null; count.hidden = true; }
      function stopStream() { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; video.srcObject = null; live = false; }
      function cleanup() {
        if (closed) return;
        closed = true; version++; stopClock(); stopStream(); if (expiry) clearTimeout(expiry);
        if (stillUrl) URL.revokeObjectURL(stillUrl); stillUrl = null; shot = null;
        observer.disconnect(); window.removeEventListener('hashchange', departed);
        if (active?.control === control) active = null;
      }
      function end(err, blob) { if (settled) return; settled = true; control.close(); if (err) reject(err); else resolve(blob); }
      cancel = function () { end(new Error('cancelled')); };
      function expired() { var err = new Error('That scan has expired — scan the office code again.'); err.code = 'scan-expired'; end(err); }
      function usable() {
        if (settled) return false;
        if (!overlay.isConnected || (opts.isCurrent && !opts.isCurrent())) { cancel(); return false; }
        if (opts.expiresAt && Date.now() >= opts.expiresAt) { expired(); return false; }
        return true;
      }
      function departed() { queueMicrotask(function () { if (location.hash !== openingHash || (opts.isCurrent && !opts.isCurrent())) cancel(); }); }
      var observer = new MutationObserver(function () { if (!overlay.isConnected || (opts.isCurrent && !opts.isCurrent())) cancel(); });
      control = MessageOverlay.mount(overlay, { initialFocus: '.m-scan-x', onClose: function () { cleanup(); if (!settled) { settled = true; reject(new Error('cancelled')); } } });
      observer.observe(document.body, { childList: true, subtree: true }); window.addEventListener('hashchange', departed);
      overlay.querySelector('.m-scan-x').onclick = cancel;
      if (opts.expiresAt) expiry = setTimeout(expired, Math.max(0, opts.expiresAt - Date.now()));
      function showLive() {
        shot = null; if (still) still.hidden = true;
        video.hidden = false; off.hidden = true; error.hidden = true;
        shoot.hidden = false; shoot.disabled = false; use.hidden = true; retake.hidden = true; retry.hidden = true;
        msg.textContent = opts.note || 'Center your face, then take the photo.';
      }
      function cameraError(err) {
        if (!usable()) return;
        acquiring = false; stopClock(); stopStream(); video.hidden = true; off.hidden = false;
        shoot.hidden = true; use.hidden = true; retake.hidden = true; retry.hidden = false; retry.disabled = false;
        msg.textContent = 'Your punch is not complete until the selfie is accepted.';
        error.textContent = err?.message || 'Could not start the camera. Close other camera apps and try again.';
        error.hidden = false; error.focus();
      }
      function startCamera() {
        if (!usable() || acquiring) return;
        acquiring = true; var stamp = ++version; error.hidden = true; retry.disabled = true; shoot.disabled = true;
        msg.textContent = 'Starting the camera…';
        Promise.resolve().then(function () {
          if (!usable()) return null;
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('This phone can’t open its camera here. Open the app using HTTPS or time in at the office kiosk.');
          return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
        }).then(function (media) {
          if (!media) return;
          if (!usable() || stamp !== version) { media.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = media; video.srcObject = media; return video.play();
        }).then(function () {
          if (!usable() || stamp !== version) return;
          acquiring = false; live = true; showLive(); if (auto) startCountdown();
        }).catch(function (err) {
          if (stamp !== version || !usable()) return;
          var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          cameraError(new Error(denied ? 'Camera is blocked — allow the camera for this site, then retry. No new punch has been recorded.' : err?.message || 'Could not start the camera — close other camera apps and retry.'));
        });
      }
      function shootNow() {
        if (!usable() || !live || shooting || shoot.disabled) return;
        shooting = true; shoot.disabled = true; stopClock();
        function captured(blob) {
          if (!usable()) return;
          shooting = false; shoot.disabled = false;
          if (!blob) { error.textContent = 'Could not take the photo. Tap Take now to try again.'; error.hidden = false; return; }
          if (auto) { end(null, blob); return; }
          shot = blob; if (stillUrl) URL.revokeObjectURL(stillUrl); stillUrl = URL.createObjectURL(blob);
          if (!still) { still = document.createElement('img'); still.alt = 'Your selfie'; stage.appendChild(still); }
          still.src = stillUrl; still.hidden = false; video.hidden = true;
          shoot.hidden = true; use.hidden = false; retake.hidden = false; error.hidden = true;
          msg.textContent = 'Is your face clear? Use this photo to finish.';
        }
        try {
          var width = video.videoWidth, height = video.videoHeight;
          if (!width || !height) { captured(null); return; }
          var canvas = document.createElement('canvas'), scale = Math.min(1, MAX_W / width);
          canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(captured, 'image/jpeg', 0.8);
        } catch (err) { captured(null); }
      }
      function startCountdown() {
        var left = auto; count.hidden = false; count.textContent = String(left);
        msg.textContent = 'Photo in ' + left + ' seconds. Look at the camera.';
        ticker = setInterval(function () { if (!usable()) return; left--; if (left <= 0) { shootNow(); return; } count.textContent = String(left); msg.textContent = 'Photo in ' + left + ' second. Look at the camera.'; }, 1000);
      }
      retry.onclick = startCamera; shoot.onclick = shootNow; if (auto) stage.onclick = shootNow;
      retake.onclick = function () { if (usable()) showLive(); }; use.onclick = function () { if (usable() && shot) end(null, shot); };
      startCamera();
    });
    promise.cancel = function () { cancel(); }; promise.overlay = overlay;
    active = { key: opts.key, control: control, promise: promise };
    return promise;
  }
  window.mSelfie = { take: take };
})();
