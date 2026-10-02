/* On-screen signature pad. mSignature() -> { el, isEmpty(), clear(), toBlob(cb) }. */
(function () {
  function signature() {
    var wrap = mEl(
      '<div class="m-sign">' +
      '  <canvas class="m-sign-cv"></canvas>' +
      '  <div class="m-sign-bar"><span>Sign above</span>' +
      '    <button type="button" class="m-sign-clear">Clear</button></div>' +
      '</div>'
    );
    var cv = wrap.querySelector('canvas');
    var ctx = cv.getContext('2d');
    var dirty = false;
    var drawing = false;
    var last = null;

    function resize() {
      var ratio = window.devicePixelRatio || 1;
      var w = cv.clientWidth || 300;
      var h = 170;
      // Resizing a canvas clears it: skip height-only resizes (the on-screen keyboard, the
      // browser toolbar collapsing) so a signature already drawn isn't silently wiped.
      if (cv.width === Math.round(w * ratio) && cv.height === Math.round(h * ratio)) return;
      cv.width = w * ratio;
      cv.height = h * ratio;
      cv.style.height = h + 'px';
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
    }
    // size once it's in the DOM
    setTimeout(resize, 0);
    window.addEventListener('resize', resize);

    function pos(e) {
      var r = cv.getBoundingClientRect();
      var t = e.touches && e.touches[0];
      return { x: (t ? t.clientX : e.clientX) - r.left, y: (t ? t.clientY : e.clientY) - r.top };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      dirty = true;
    }
    function end() { drawing = false; }

    cv.addEventListener('touchstart', start, { passive: false });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', end);
    cv.addEventListener('mousedown', start);
    cv.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);

    function clear() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      dirty = false;
    }
    wrap.querySelector('.m-sign-clear').onclick = clear;

    return {
      el: wrap,
      isEmpty: function () { return !dirty; },
      clear: clear,
      toBlob: function (cb) {
        if (cv.toBlob) cv.toBlob(function (b) { cb(b); }, 'image/png');
        else {
          var s = atob(cv.toDataURL('image/png').split(',')[1]);
          var arr = new Uint8Array(s.length);
          for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
          cb(new Blob([arr], { type: 'image/png' }));
        }
      },
    };
  }
  window.mSignature = signature;
})();
