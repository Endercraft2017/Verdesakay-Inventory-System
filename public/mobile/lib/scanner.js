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

  /** open({ onResult(text), title, continuous }) — with `continuous`, the overlay stays
      open and onResult fires for each new code (same code ignored for ~1.2 s); close with
      the X button or the returned `.close()`. */
  function open(opts) {
    opts = opts || {};
    var overlay = mEl(
      '<div class="m-scan">' +
      '  <div class="m-scan-head">' +
      '    <span>' + mEsc(opts.title || 'Scan barcode or QR') + '</span>' +
      '    <span class="m-scan-head-btns">' +
      '      <button class="m-scan-torch" aria-label="Toggle light" hidden>&#9728;</button>' +
      '      <button class="m-scan-x" aria-label="Close">&times;</button>' +
      '    </span>' +
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
    if (opts.allowManual === false) overlay.querySelector('.m-scan-manual').remove();

    function manualOnly(text) {
      if (opts.allowManual === false) { say('Camera scanning is required. Enable camera access and use HTTPS, then try again.'); overlay.querySelector('.m-scan-stage').hidden = true; return; }
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

    var lastCode = null, lastAt = 0;
    function finish(text) {
      if (done || !text) return;
      text = String(text).trim();
      if (opts.continuous) {
        var now = Date.now();
        if (text === lastCode && now - lastAt < 1200) return;   // debounce repeat reads
        lastCode = text; lastAt = now;
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* ignore */ }
        opts.onResult(text);
        return;
      }
      stop();
      opts.onResult(text);
    }

    overlay.querySelector('.m-scan-x').onclick = stop;

    // Torch / flashlight — offered only when the running video track supports it.
    var torchOn = false;
    function wireTorch() {
      if (done) return;
      var src = stream || video.srcObject;
      var track = src && src.getVideoTracks && src.getVideoTracks()[0];
      var caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (!track || !caps.torch) return;
      var btn = overlay.querySelector('.m-scan-torch');
      btn.hidden = false;
      btn.onclick = function () {
        torchOn = !torchOn;
        btn.classList.toggle('on', torchOn);
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
      };
    }

    if (opts.allowManual !== false) overlay.querySelector('.m-scan-manual').onsubmit = function (e) {
      e.preventDefault();
      if (opts.allowManual === false) return;
      var inp = e.target.querySelector('input');
      var v = inp.value.trim();
      if (!v) return;
      if (opts.continuous) { lastCode = null; opts.onResult(v); inp.value = ''; inp.focus(); }
      else finish(v);
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
          wireTorch();
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
      ).then(function () { setTimeout(wireTorch, 400); }).catch(camError);
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

  /** Physical sticker verification is separate from finding/selecting a record.
      New selections start unverified. Recovery retries the already-reviewed request. */
  function verification(host, codes, onChange) {
    var entries = codes.map(function (entry) { return typeof entry === 'string' ? {code:entry,aliases:[]} : entry; });
    var expected = entries.map(function (entry) { return String(entry.code).trim(); });
    var seen = {}, active = null;
    function complete() { return expected.length > 0 && expected.every(function (code) { return seen[code.toLowerCase()]; }); }
    function paint() {
      host.innerHTML = '<div class="rk-card rk-field"><small>Attached QR sticker verification</small><p data-scan-status></p><button type="button" class="rk-btn secondary" data-verify-label>Scan attached sticker' + (expected.length > 1 ? 's' : '') + '</button></div>';
      host.querySelector('[data-scan-status]').textContent = expected.filter(function (code) { return seen[code.toLowerCase()]; }).length + ' of ' + expected.length + ' labels scanned';
      host.querySelector('[data-verify-label]').onclick = function () {
        if (active) active.close();
        active = window.mScanner.open({ title: 'Scan the attached QR sticker', continuous: true, allowManual: false, onResult: function (value) {
          if (!host.isConnected) { active.close(); return; }
          var code = String(value || '').trim().toLowerCase();
          var matches = entries.filter(function (entry) { return [entry.code].concat(entry.aliases || []).some(function(v){return String(v).trim().toLowerCase()===code;}); });
          if (matches.length !== 1) { mToast('Wrong or ambiguous label. Scan a sticker for the selected stock.', 'err'); return; }
          seen[String(matches[0].code).toLowerCase()] = true;
          if (complete()) active.close();
          paint();
        } });
      };
      if (onChange) onChange(complete());
    }
    paint();
    return { complete: complete };
  }

  window.mScanner = { open: open, supported: secureCamera, verification: verification };
})();
