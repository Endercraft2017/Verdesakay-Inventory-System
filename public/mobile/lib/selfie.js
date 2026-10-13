/* Front-camera selfie — the phone time-in's second step (POST /hr/clock/punch/selfie).
   mSelfie.take({ title, note, auto }) → Promise<Blob> (JPEG, at most MAX_W px wide). Rejects with
   Error('cancelled') when closed, or with a readable message when the camera can't start.
   `auto` (seconds): a countdown starts once the camera is live and the photo is taken and
   returned by itself — no review step; tapping the picture or "Take now" shoots at once.
   Without it: a shutter button, then "Use this photo" / "Retake".
   Live camera only, never a gallery pick: the photo is taken at the moment of the punch.
   The preview is mirrored like a front camera; the saved photo is not. */
(function () {
  var MAX_W = 640;

  function take(opts) {
    opts = opts || {};
    var auto = opts.auto > 0 ? Math.round(opts.auto) : 0;
    return new Promise(function (resolve, reject) {
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        reject(new Error('This phone can’t open its camera here. Time in at the office kiosk instead.'));
        return;
      }
      var overlay = mEl(
        '<div class="m-scan m-selfie" role="dialog" aria-label="' + mEsc(opts.title || 'Take a selfie') + '">' +
        '  <div class="m-scan-head">' +
        '    <span>' + mEsc(opts.title || 'Take a selfie') + '</span>' +
        '    <span class="m-scan-head-btns"><button class="m-scan-x" type="button" aria-label="Cancel">&times;</button></span>' +
        '  </div>' +
        '  <div class="m-scan-stage m-selfie-stage">' +
        '    <video playsinline muted></video>' +
        '    <span class="m-selfie-count" aria-hidden="true" hidden></span>' +
        '  </div>' +
        '  <div class="m-scan-msg" role="status">Starting the camera…</div>' +
        '  <div class="m-selfie-actions">' +
        '    <button class="m-btn" type="button" data-shoot disabled>' + (auto ? 'Take now' : 'Take selfie') + '</button>' +
        '    <button class="m-btn" type="button" data-use hidden>Use this photo</button>' +
        '    <button class="m-btn m-btn-secondary" type="button" data-retake hidden>Retake</button>' +
        '  </div>' +
        '</div>'
      );
      (document.getElementById('m-overlay-root') || document.body).appendChild(overlay);

      var video = overlay.querySelector('video');
      var stage = overlay.querySelector('.m-selfie-stage');
      var count = overlay.querySelector('.m-selfie-count');
      var still = null; // the taken photo's preview (review mode), made on the first shot
      var msg = overlay.querySelector('.m-scan-msg');
      var shoot = overlay.querySelector('[data-shoot]');
      var use = overlay.querySelector('[data-use]');
      var retake = overlay.querySelector('[data-retake]');
      var stream = null, shot = null, stillUrl = null, settled = false, live = false, ticker = null;

      function close() {
        if (ticker) clearInterval(ticker);
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        if (stillUrl) URL.revokeObjectURL(stillUrl);
        overlay.remove();
      }
      function fail(err) { if (settled) return; settled = true; close(); reject(err); }
      function finish(blob) { if (settled) return; settled = true; close(); resolve(blob); }
      function showLive() {
        shot = null;
        if (still) still.hidden = true;
        video.hidden = false;
        shoot.hidden = false; use.hidden = true; retake.hidden = true;
        msg.textContent = opts.note || 'Center your face, then take the photo.';
      }

      /** The current frame as a JPEG (unmirrored), or null if the camera has no frame yet. */
      function grab(done) {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { done(null); return; }
        var scale = Math.min(1, MAX_W / w);
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(done, 'image/jpeg', 0.8);
      }

      function shootNow() {
        if (!live || settled || shoot.disabled) return;
        if (ticker) { clearInterval(ticker); ticker = null; }
        count.hidden = true;
        shoot.disabled = true;
        grab(function (blob) {
          shoot.disabled = false;
          if (!blob) { msg.textContent = 'Could not take the photo — tap to try again.'; return; }
          if (auto) { finish(blob); return; }
          shot = blob;
          if (stillUrl) URL.revokeObjectURL(stillUrl);
          stillUrl = URL.createObjectURL(blob);
          if (!still) {
            still = document.createElement('img');
            still.alt = 'Your selfie';
            stage.appendChild(still);
          }
          still.src = stillUrl;
          still.hidden = false; video.hidden = true;
          shoot.hidden = true; use.hidden = false; retake.hidden = false;
          msg.textContent = 'Is your face clear? Use this photo to finish.';
        });
      }

      function startCountdown() {
        var left = auto;
        count.hidden = false;
        count.textContent = String(left);
        ticker = setInterval(function () {
          left -= 1;
          if (left > 0) { count.textContent = String(left); return; }
          shootNow();
        }, 1000);
      }

      overlay.querySelector('.m-scan-x').onclick = function () { fail(new Error('cancelled')); };
      shoot.onclick = shootNow;
      if (auto) stage.onclick = shootNow;
      retake.onclick = showLive;
      use.onclick = function () { if (shot) finish(shot); };

      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
        .then(function (s) {
          if (settled) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          video.srcObject = s;
          return video.play();
        })
        .then(function () {
          if (settled) return;
          live = true;
          shoot.disabled = false;
          showLive();
          if (auto) startCountdown();
        })
        .catch(function (err) {
          var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          fail(new Error(denied
            ? 'Camera is blocked — allow the camera for this site, then try again.'
            : 'Could not start the camera — close other camera apps and try again.'));
        });
    });
  }

  window.mSelfie = { take: take };
})();
