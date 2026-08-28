/* Barcode / QR scanner overlay. Reads BOTH 1D barcodes and 2D QR codes.
   Prefers the native BarcodeDetector (fast, low battery — Android Chrome); falls back
   to the vendored ZXing multi-format reader (iOS Safari, older browsers). Always offers
   manual code entry as a last resort (and the only path on an insecure origin). */
(function () {
  // 1D + 2D formats we care about, in the BarcodeDetector vocabulary.
  var WANT_FORMATS = [
    'qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8',
    'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix', 'aztec', 'pdf417',
  ];

  function secureCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** open({ onResult(text), title }) */
  function open(opts) {
    opts = opts || {};
    var overlay = mEl(
      '<div class="m-scan">' +
      '  <div class="m-scan-head">' +
      '    <span>' + mEsc(opts.title || 'Scan barcode or QR') + '</span>' +
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
    var timer = null;
    var zx = null;
    var done = false;

    function say(text) { msg.hidden = false; msg.textContent = text; }
    function manualOnly(text) {
      say(text);
      overlay.querySelector('.m-scan-stage').hidden = true;
      overlay.querySelector('input').focus();
    }

    function stop() {
      done = true;
      if (timer) clearInterval(timer);
      if (zx) { try { zx.reset(); } catch (e) { /* ignore */ } }
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

    function camError(err) {
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      manualOnly(denied
        ? 'Camera permission denied. Type the code below instead.'
        : 'Could not start the camera. Type the code below instead.');
    }

    /* ---- Native BarcodeDetector: our own stream + a polling loop ---- */
    function startNative(formats) {
      var detector = new BarcodeDetector({ formats: formats });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        .then(function (s) { stream = s; video.srcObject = s; return video.play(); })
        .then(function () {
          var firstTry = true;
          timer = setInterval(function () {
            if (done) return;
            detector.detect(video)
              .then(function (codes) { if (codes && codes.length) finish(codes[0].rawValue); })
              .catch(function () {
                // Some engines declare BarcodeDetector but throw on detect() —
                // bail to ZXing on the very first failure.
                if (firstTry && window.ZXing) { clearInterval(timer); timer = null; startZXing(); }
              })
              .finally(function () { firstTry = false; });
          }, 300);
        })
        .catch(camError);
    }

    /* ---- ZXing fallback: the reader owns the camera; reset() tears it down ---- */
    function startZXing() {
      zx = new ZXing.BrowserMultiFormatReader();
      zx.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        video,
        function (result) { if (result && !done) finish(result.getText ? result.getText() : result.text); }
      ).catch(camError);
    }

    if (!secureCamera()) {
      manualOnly('Camera needs a secure (HTTPS) connection. Type the code below instead.');
      return { close: stop };
    }

    if (window.BarcodeDetector && BarcodeDetector.getSupportedFormats) {
      BarcodeDetector.getSupportedFormats()
        .then(function (supported) {
          var use = WANT_FORMATS.filter(function (f) { return supported.indexOf(f) !== -1; });
          if (use.length) startNative(use);
          else if (window.ZXing) startZXing();
          else manualOnly('This browser can’t scan. Type the code below instead.');
        })
        .catch(function () { if (window.ZXing) startZXing(); else manualOnly('This browser can’t scan. Type the code below instead.'); });
    } else if (window.ZXing) {
      startZXing();
    } else {
      manualOnly('This browser can’t scan. Type the code below instead.');
    }

    return { close: stop };
  }

  window.mScanner = { open: open, supported: secureCamera };
})();
