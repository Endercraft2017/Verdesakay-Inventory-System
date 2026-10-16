/* Dependency-free client-side image shrinker for upload. Draws the picture to a
   <canvas>, downscales to a max dimension and re-encodes as JPEG. Used by Messages
   (web + mobile) to keep attachment storage down.

   ImageCompress.maybeCompress(file, opts) -> Promise<File>
     Resolves the ORIGINAL file untouched when: it isn't a re-encodable raster
     (only jpeg/png/webp qualify — GIF/SVG are left alone), it's already under the
     threshold, the re-encode came out no smaller, or anything throws. So it is
     always safe to pipe every picked file through it.

   opts: { thresholdBytes=1MB, maxDim=1920, quality=0.82 }

   ImageCompress.reencode(file, opts) -> Promise<File>
     ALWAYS redraws the picture into a fresh JPEG named `opts.name` (default photo.jpg),
     with lastModified 0: none of the original's metadata (EXIF/GPS/device/time, XMP,
     ICC, comments), filename or date survives. Rejects if the picture can't be decoded —
     never falls back to the original. Used by the anonymous report channel; the server
     strips metadata again (src/shared/image-metadata.ts), this is the first layer. */
(function () {
  var DEFAULTS = { thresholdBytes: 1024 * 1024, maxDim: 1920, quality: 0.82 };
  var OUT_MIME = 'image/jpeg';

  /** Decode + downscale + JPEG-encode. Resolves a Blob, or null when it can't. */
  function drawToJpeg(file, o) {
    return loadImage(file).then(function (img) {
      var srcW = img.width || img.naturalWidth;
      var srcH = img.height || img.naturalHeight;
      if (!srcW || !srcH) return null;
      var scale = Math.min(1, o.maxDim / Math.max(srcW, srcH));
      var w = Math.max(1, Math.round(srcW * scale));
      var h = Math.max(1, Math.round(srcH * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      // Flatten onto white so PNG/WebP transparency doesn't become black under JPEG.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      if (img.close) img.close();
      return toBlob(canvas, o.quality);
    });
  }

  function maybeCompress(file, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type || '')) return Promise.resolve(file);
    if (file.size <= o.thresholdBytes) return Promise.resolve(file);

    return drawToJpeg(file, o)
      .then(function (blob) {
        if (!blob || blob.size >= file.size) return file; // no win — keep the original
        var base = (file.name || 'image').replace(/\.(png|webp|jpe?g)$/i, '');
        return new File([blob], base + '.jpg', { type: OUT_MIME, lastModified: Date.now() });
      })
      .catch(function () { return file; });
  }

  function reencode(file, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    if (!file || !/^image\//i.test(file.type || '')) return Promise.reject(new Error('Only photos can be attached.'));
    return drawToJpeg(file, o).then(function (blob) {
      if (!blob) throw new Error('That photo couldn’t be prepared. Try another one.');
      return new File([blob], o.name || 'photo.jpg', { type: OUT_MIME, lastModified: 0 });
    }, function () { throw new Error('That photo couldn’t be prepared. Try another one.'); });
  }

  function loadImage(file) {
    if (window.createImageBitmap) {
      // `imageOrientation` bakes in EXIF rotation from phone photos where supported;
      // ignored elsewhere.
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) { canvas.toBlob(resolve, OUT_MIME, quality); return; }
      try { resolve(dataURLToBlob(canvas.toDataURL(OUT_MIME, quality))); }
      catch (e) { resolve(null); }
    });
  }

  function dataURLToBlob(dataURL) {
    var parts = dataURL.split(',');
    var bstr = atob(parts[1]);
    var n = bstr.length;
    var u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], { type: OUT_MIME });
  }

  window.ImageCompress = { maybeCompress: maybeCompress, reencode: reencode };
})();
