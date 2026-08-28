/* QR scanner overlay. Uses the native BarcodeDetector when available, otherwise the
   vendored jsQR on a canvas. Always offers manual code entry as a fallback (and the
   only path when the camera is blocked or the origin isn't secure). */
(function () {
  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** open({ onResult(text), title }) */
  function open(opts) {
    opts = opts || {};
    var overlay = mEl(
      '<div class="m-scan">' +
      '  <div class="m-scan-head">' +
      '    <span>' + mEsc(opts.title || 'Scan code') + '</span>' +
      '    <button class="m-scan-x" aria-label="Close">&times;</button>' +
      '  </div>' +
      '  <div class="m-scan-stage">' +
      '    <video playsinline muted></video>' +
      '    <div class="m-scan-frame"></div>' +
      '  </div>' +
      '  <div class="m-scan-msg" hidden></div>' +
      '  <form class="m-scan-manual">' +
      '    <input type="text" placeholder="Or type the code" autocomplete="off" autocapitalize="characters" />' +
      '    <button class="m-btn" type="submit">Use code</button>' +
      '  </form>' +
      '</div>'
    );
    document.getElementById('m-overlay-root').appendChild(overlay);

    var video = overlay.querySelector('video');
    var msg = overlay.querySelector('.m-scan-msg');
    var stream = null;
    var raf = null;
    var timer = null;
    var done = false;
    var canvas = document.createElement('canvas');
    var detector = null;

    function say(text) { msg.hidden = false; msg.textContent = text; }

    function stop() {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      overlay.remove();
    }

    function finish(text) {
      if (done || !text) return;
      stop();
      opts.onResult(String(text).trim());
    }

    overlay.querySelector('.m-scan-x').onclick = stop;
    overlay.querySelector('.m-scan-manual').onsubmit = function (e) {
      e.preventDefault();
      var v = e.target.querySelector('input').value.trim();
      if (v) finish(v);
    };

    function scanLoopJsQR() {
      if (done) return;
      var w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        try {
          var img = ctx.getImageData(0, 0, w, h);
          var code = window.jsQR ? window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' }) : null;
          if (code && code.data) return finish(code.data);
        } catch (e) { /* keep trying */ }
      }
      raf = requestAnimationFrame(scanLoopJsQR);
    }

    function scanLoopNative() {
      timer = setInterval(function () {
        if (done) return;
        detector.detect(video)
          .then(function (codes) { if (codes && codes.length) finish(codes[0].rawValue); })
          .catch(function () { /* transient */ });
      }, 350);
    }

    if (!supported()) {
      say('Camera needs a secure (HTTPS) connection. Type the code below instead.');
      overlay.querySelector('.m-scan-stage').hidden = true;
      overlay.querySelector('input').focus();
      return { close: stop };
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        if (window.BarcodeDetector) {
          return BarcodeDetector.getSupportedFormats().then(function (fmts) {
            if (fmts.indexOf('qr_code') !== -1) {
              detector = new BarcodeDetector({ formats: ['qr_code'] });
              scanLoopNative();
            } else {
              scanLoopJsQR();
            }
          });
        }
        scanLoopJsQR();
      })
      .catch(function (err) {
        var m = err && err.name === 'NotAllowedError'
          ? 'Camera permission denied. Type the code below instead.'
          : 'Could not start the camera. Type the code below instead.';
        say(m);
        overlay.querySelector('.m-scan-stage').hidden = true;
        overlay.querySelector('input').focus();
      });

    return { close: stop };
  }

  window.mScanner = { open: open, supported: supported };
})();
