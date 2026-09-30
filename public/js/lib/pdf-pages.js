/* Dependency-free (vendored) PDF → page photos, in the browser. Each page is drawn into a
   <canvas> by pdf.js and encoded as a fresh JPEG, so only the visible pixels leave the device:
   the PDF's metadata (author, creator app, dates, XMP), embedded files, form data, scripts and
   hidden layers never do. Used by the anonymous report channel so a document can go through
   the same photo path — and the same server-side stripping — as a picture.

   pdf.js (public/js/vendor/pdfjs, see its VERSION file) is imported on first use only, so
   it costs nothing for anyone who never picks a PDF. Scripting is off.

   PdfPages.toJpegs(file, opts) -> Promise<{ files: File[], totalPages: number }>
     opts: { maxPages=4, maxDim=2048, quality=0.85, name(i) -> 'photo-<i+1>.jpg' }
     Rejects with a readable message for a password-protected or unreadable PDF. */
(function () {
  var BASE = '/js/vendor/pdfjs/';
  var OUT_MIME = 'image/jpeg';
  var lib = null;

  function load() {
    if (!lib) {
      lib = import(BASE + 'pdf.min.mjs').then(function (m) {
        m.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
        return m;
      });
      lib.catch(function () { lib = null; }); // allow a retry after a network blip
    }
    return lib;
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, OUT_MIME, quality); });
  }

  function renderPage(doc, num, o) {
    return doc.getPage(num).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = Math.min(3, o.maxDim / Math.max(base.width, base.height));
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise
        .then(function () { page.cleanup(); return toBlob(canvas, o.quality); });
    });
  }

  function toJpegs(file, opts) {
    var o = Object.assign({ maxPages: 4, maxDim: 2048, quality: 0.85, name: function (i) { return 'photo-' + (i + 1) + '.jpg'; } }, opts || {});
    var task = null; // pdf.js 6: destroy() lives on the loading task, not the document
    function done() { if (task) task.destroy(); }
    return Promise.all([load(), file.arrayBuffer()])
      .then(function (r) {
        task = r[0].getDocument({
          data: new Uint8Array(r[1]),
          standardFontDataUrl: BASE + 'standard_fonts/',
          wasmUrl: BASE + 'wasm/',
          enableScripting: false,
        });
        return task.promise;
      })
      .then(function (doc) {
        var files = [];
        var n = Math.min(doc.numPages, o.maxPages);
        var chain = Promise.resolve();
        for (var i = 1; i <= n; i++) {
          (function (num) {
            chain = chain.then(function () { return renderPage(doc, num, o); }).then(function (blob) {
              if (!blob) throw new Error('A page couldn’t be drawn.');
              files.push(new File([blob], o.name(files.length), { type: OUT_MIME, lastModified: 0 }));
            });
          })(i);
        }
        return chain.then(function () { return { files: files, totalPages: doc.numPages }; });
      })
      .then(function (r) { done(); return r; }, function (e) {
        done();
        if (e && e.name === 'PasswordException') throw new Error('That PDF is password-protected. Remove the password or send photos of the pages.');
        throw new Error('That PDF couldn’t be read. Try sending photos of the pages instead.');
      });
  }

  window.PdfPages = { toJpegs: toJpegs };
})();
