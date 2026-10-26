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

  var active = null, sequence = 0;

  function secureCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** open({ onResult(text), title, continuous }) — with `continuous`, the overlay stays
      open and onResult fires for each new code (same code ignored for ~1.2 s); close with
      the X button or the returned `.close()`. */
  function open(opts) {
    opts = opts || {};
    if (active?.current && !active.current()) active = null;
    var inputId = 'm-scanner-code-' + (++sequence), owner = window.mReadScope?.identity();
    if (active && opts.key && active.key === opts.key) { active.focus(); return active; }
    if (active) active.close();
    var openingHash = location.hash, reason = 'cancelled';
    var overlay = mEl(
      '<div class="m-scan" role="dialog" aria-modal="true" aria-label="' + mEsc(opts.title || 'Scan barcode or QR') + '">' +
      '  <div class="m-scan-head">' +
      '    <span>' + mEsc(opts.title || 'Scan barcode or QR') + '</span>' +
      '    <span class="m-scan-head-btns">' +
      '      <button class="m-scan-torch" aria-label="Toggle light" aria-pressed="false" hidden>&#9728;</button>' +
      '      <button class="m-scan-x" aria-label="Close">&times;</button>' +
      '    </span>' +
      '  </div>' +
      '  <div class="m-scan-stage">' +
      '    <video playsinline muted></video>' +
      '    <div class="m-scan-frame"></div>' +
      '  </div>' +
      '  <div class="m-scan-msg" role="status" hidden></div>' +
      '  <form class="m-scan-manual">' +
      '    <label for="' + inputId + '">' + mEsc(opts.manualLabel || 'Barcode or QR code') + '<input id="' + inputId + '" type="text" placeholder="Or type the code" autocomplete="off" autocapitalize="characters" value="' + mEsc(opts.initialCode || '') + '" /></label>' +
      '    <button class="m-btn" type="submit">Use code</button>' +
      '  </form><div class="m-scanner-error" role="alert"></div><button type="button" class="m-camera-retry" hidden>Retry camera</button>' +
      '</div>'
    );
    (document.getElementById('m-overlay-root') || document.body).appendChild(overlay);

    var video = overlay.querySelector('video');
    var msg = overlay.querySelector('.m-scan-msg');
    var stream = null;
    var timer = null;
    var zx = null;
    var done = false, cameraVersion = 0, cameraTimer;
    var retryCamera = overlay.querySelector('.m-camera-retry');

    function usable() { if (done) return false; if (!overlay.isConnected || document.getElementById('m-app')?.matches('.hidden,[hidden]') || (owner && owner !== window.mReadScope?.identity()) || (opts.isCurrent && !opts.isCurrent())) { stop('navigation'); return false; } return true; }
    function say(text) { if (usable()) { msg.hidden = false; msg.textContent = text; } }
    if (opts.allowManual === false) overlay.querySelector('.m-scan-manual').remove();

    function manualOnly(text) {
      if (!usable()) return;
      cameraVersion++; clearTimeout(cameraTimer); clearInterval(timer);
      if (zx) { try { zx.reset(); } catch (ignore) {} zx = null; }
      stopStream(); retryCamera.hidden = false; retryCamera.disabled = false;
      overlay.querySelector('.m-scan-torch').hidden = true;
      if (opts.allowManual === false) { say('Camera scanning is required. Enable camera access and use HTTPS, then try again.'); overlay.querySelector('.m-scan-stage').hidden = true; return; }
      say(text);
      overlay.querySelector('.m-scan-stage').hidden = true;
      overlay.querySelector('input').focus();
    }

    function stopStream() {
      var media = stream || video.srcObject;
      if (media?.getTracks) media.getTracks().forEach(function (track) { track.stop(); });
      stream = null; video.srcObject = null;
    }
    function cleanup() {
      if (done) return;
      done = true; cameraVersion++; clearTimeout(cameraTimer);
      if (timer) clearInterval(timer);
      if (zx) { try { zx.reset(); } catch (e) {} }
      stopStream(); observer.disconnect(); window.removeEventListener('hashchange', departed); window.removeEventListener('pagehide', pageLeft);
      if (active === control) active = null;
      if (opts.onClose) opts.onClose(reason);
    }
    function stop(why) { reason = typeof why === 'string' ? why : 'cancelled'; control.close(); }
    function departed() { queueMicrotask(function () { if (location.hash !== openingHash || (opts.isCurrent && !opts.isCurrent())) stop('navigation'); }); }
    function pageLeft() { stop('navigation'); }
    var observer = new MutationObserver(function () { if (!overlay.isConnected || document.getElementById('m-app')?.matches('.hidden,[hidden]') || (owner && owner !== window.mReadScope?.identity()) || (opts.isCurrent && !opts.isCurrent())) stop('navigation'); });
    var control = MessageOverlay.mount(overlay, { initialFocus: '.m-scan-x', onClose: cleanup });
    control.key = opts.key; control.current = usable; active = control;
    observer.observe(document.body, { childList: true, subtree: true, attributes:true, attributeFilter:['class','hidden'] }); window.addEventListener('hashchange', departed); window.addEventListener('pagehide', pageLeft);

    var lastCode = null, lastAt = 0;
    function finish(text, source) {
      if (!usable() || !text) return;
      text = String(text).trim();
      if (opts.continuous) {
        var now = Date.now();
        if (text === lastCode && now - lastAt < 1200) return;   // debounce repeat reads
        lastCode = text; lastAt = now;
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* ignore */ }
        opts.onResult(text, { source: source || 'camera', capturedAt: Date.now() });
        return;
      }
      stop('result');
      opts.onResult(text, { source: source || 'camera', capturedAt: Date.now() });
    }

    overlay.querySelector('.m-scan-x').onclick = stop;

    // Torch / flashlight — offered only when the running video track supports it.
    var torchOn = false;
    function wireTorch() {
      if (!usable()) return;
      var src = stream || video.srcObject;
      var track = src && src.getVideoTracks && src.getVideoTracks()[0];
      var caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (!track || !caps.torch) return;
      var btn = overlay.querySelector('.m-scan-torch'), version = cameraVersion;
      btn.hidden = false; btn.disabled = false;
      btn.onclick = function () {
        if (!usable() || btn.disabled) return;
        var desired = !torchOn; btn.disabled = true;
        Promise.resolve().then(function () { return track.applyConstraints({advanced:[{torch:desired}]}); }).then(function () {
          if (!cameraCurrent(version)) return; torchOn = desired; btn.classList.toggle('on',torchOn); btn.setAttribute('aria-pressed',String(torchOn)); say('Camera light ' + (torchOn ? 'on.' : 'off.'));
        }).catch(function () { if (cameraCurrent(version)) say('The camera light could not be changed. Try again.'); }).finally(function () { if (cameraCurrent(version)) btn.disabled = false; });
      };
    }

    if (opts.allowManual !== false) overlay.querySelector('.m-scan-manual').onsubmit = function (e) {
      e.preventDefault();
      if (!usable() || opts.allowManual === false) return;
      var inp = e.target.querySelector('input');
      var v = inp.value.trim();
      if (!v) { overlay.querySelector('.m-scanner-error').textContent = 'Enter a barcode or QR code.'; inp.setAttribute('aria-invalid','true'); inp.focus(); return; }
      if (opts.continuous) { lastCode = null; opts.onResult(v, { source: 'manual', capturedAt: Date.now() }); inp.value = ''; inp.focus(); }
      else finish(v, 'manual');
    };

    overlay.querySelector('input')?.addEventListener('input',function () { this.removeAttribute('aria-invalid'); overlay.querySelector('.m-scanner-error').textContent = ''; });
    function cameraCurrent(version) { return usable() && version === cameraVersion; }
    function cameraReady(version) { if (!cameraCurrent(version)) return; clearTimeout(cameraTimer); say('Align the barcode or QR code inside the frame, or use the controls below.'); wireTorch(); }
    function camError(err, version) {
      if (!cameraCurrent(version)) return;
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      manualOnly(denied
        ? 'Camera permission denied. Type the code below instead.'
        : 'Could not start the camera. Type the code below instead.');
    }

    /* ---- Native BarcodeDetector: our own stream + a polling loop ---- */
    function startNative(formats,version) {
      if (!cameraCurrent(version)) return;
      var detecting = false;
      var detector = new BarcodeDetector({ formats: formats });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        .then(function (s) { if (!cameraCurrent(version)) { s.getTracks().forEach(function (t) { t.stop(); }); return; } stream = s; video.srcObject = s; return video.play(); })
        .then(function () {
          if (!cameraCurrent(version)) return;
          cameraReady(version);
          var firstTry = true;
          timer = setInterval(function () {
            if (!cameraCurrent(version) || detecting) return;
            detecting = true;
            Promise.resolve().then(function () { return detector.detect(video); })
              .then(function (codes) { if (cameraCurrent(version) && codes && codes.length) finish(codes[0].rawValue); })
              .catch(function () {
                // Some engines declare BarcodeDetector but throw on detect() —
                // bail to ZXing on the very first failure.
                if (cameraCurrent(version) && firstTry) { clearInterval(timer); timer = null; stopStream(); if (window.ZXing) startZXing(version); else manualOnly('This browser could not read camera frames. Use the code entry below instead.'); }
              })
              .finally(function () { firstTry = false; detecting = false; });
          }, 300);
        })
        .catch(function (error) { camError(error,version); });
    }

    /* ---- ZXing fallback: the reader owns the camera; reset() tears it down ---- */
    function startZXing(version) {
      if (!cameraCurrent(version)) return;
      var reader = zx = new ZXing.BrowserMultiFormatReader(), readerVideo = video;
      function stopReader() {
        var media = readerVideo.srcObject;
        reader.reset();
        if (media?.getTracks) media.getTracks().forEach(function (track) { track.stop(); });
        readerVideo.srcObject = null;
      }
      reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        readerVideo,
        function (result) { if (!cameraCurrent(version)) { stopReader(); return; } if (result) finish(result.getText ? result.getText() : result.text); }
      ).then(function () { if (!cameraCurrent(version)) { stopReader(); return; } cameraReady(version); }).catch(function (error) { camError(error,version); });
    }

    function startCamera() {
      if (!usable() || retryCamera.disabled) return;
      retryCamera.disabled = true;
      var version = ++cameraVersion;
      // A late ZXing reader owns its original element, never a replacement camera.
      var nextVideo = video.cloneNode(false); video.replaceWith(nextVideo); video = nextVideo;
      torchOn = false; var light = overlay.querySelector('.m-scan-torch'); light.hidden = true; light.disabled = false; light.setAttribute('aria-pressed','false'); light.classList.remove('on');
      retryCamera.hidden = true; overlay.querySelector('.m-scan-stage').hidden = false;
      say(opts.allowManual === false ? 'Starting camera…' : 'Starting camera… You can type a code below while it opens.');
      cameraTimer = setTimeout(function () { if (cameraCurrent(version)) manualOnly('The camera did not start in time. Retry camera or type the code below.'); },15000);
      if (!secureCamera()) { manualOnly('Camera needs a secure (HTTPS) connection. Type the code below instead.'); return; }
      if (window.BarcodeDetector && BarcodeDetector.getSupportedFormats) {
        BarcodeDetector.getSupportedFormats().then(function (supported) {
          if (!cameraCurrent(version)) return;
          var use = WANT_FORMATS.filter(function (format) { return supported.indexOf(format) !== -1; });
          if (use.length) startNative(use,version);
          else if (window.ZXing) startZXing(version);
          else manualOnly('This browser can’t scan. Type the code below instead.');
        }).catch(function (error) { if (!cameraCurrent(version)) return; if (window.ZXing) startZXing(version); else camError(error,version); });
      } else if (window.ZXing) startZXing(version);
      else manualOnly('This browser can’t scan. Type the code below instead.');
    }
    retryCamera.onclick = startCamera;
    startCamera();
    return control;
  }

  /** Physical sticker verification is separate from finding/selecting a record.
      New selections start unverified. Recovery retries the already-reviewed request. */
  function verification(host, codes, onChange, options) {
    options = options || {};
    var entries = codes.map(function (entry) { return typeof entry === 'string' ? {code:entry,aliases:[]} : entry; });
    var expected = entries.map(function (entry) { return String(entry.code).trim(); });
    var seen = {}, active = null, verifiedAt = Date.now();
    function matches(value) { return entries.filter(function (entry) { return [entry.code].concat(entry.aliases || []).some(function(v){return String(v).trim().toLowerCase()===String(value).trim().toLowerCase();}); }); }
    if (options.initial && options.initial.source === 'camera' && (!options.isCurrent || options.isCurrent())) {
      var initial = matches(options.initial.code);
      if (initial.length === 1) { seen[String(initial[0].code).toLowerCase()] = true; verifiedAt=options.initial.capturedAt||Date.now(); }
    }
    function complete() { return (!options.maxAge || Date.now()-verifiedAt < options.maxAge) && (!options.isCurrent || options.isCurrent()) && expected.length > 0 && expected.every(function (code) { return seen[code.toLowerCase()]; }); }
    function paint() {
      host.innerHTML = '<div class="rk-card rk-field"><small>Physical label</small><p data-scan-status></p><button type="button" class="rk-btn secondary" data-verify-label>' + (complete() ? 'Scan a different label' : 'Scan attached sticker' + (expected.length > 1 ? 's' : '')) + '</button></div>';
      host.querySelector('[data-scan-status]').textContent = expected.filter(function (code) { return seen[code.toLowerCase()]; }).length + ' of ' + expected.length + ' labels scanned';
      if (complete()) host.querySelector('[data-scan-status]').textContent = 'Label verified · no second scan needed';
      else if (options.reason) host.querySelector('[data-scan-status]').textContent = typeof options.reason==='function'?options.reason():options.reason;
      if(options.initial && complete()) host.querySelector('[data-verify-label]').hidden=true;
      host.querySelector('[data-verify-label]').onclick = function () {
        if (active) active.close();
        seen = {}; if (onChange) onChange(false);
        active = window.mScanner.open({ title: 'Scan the attached QR sticker', continuous: true, allowManual: false, onResult: function (value, metadata) {
          if (!host.isConnected) { active?.close(); return; }
          var code = String(value || '').trim().toLowerCase();
          var found = matches(code);
          if (metadata?.source === 'manual' || found.length !== 1 || options.isCurrent && !options.isCurrent()) { mToast('Wrong, stale or ambiguous label. Scan a sticker for the selected stock.', 'err'); return; }
          seen[String(found[0].code).toLowerCase()] = true; verifiedAt=Date.now();
          if (complete()) active?.close();
          paint();
        } });
      };
      if (onChange) onChange(complete());
    }
    paint();
    return { complete: complete, refresh: paint };
  }

  window.mScanner = { open: open, supported: secureCamera, verification: verification };
})();
