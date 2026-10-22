/* Photo capture + attachments.
   mPhoto.capture(itemId)          → camera/picker → POST /inventory/:id/image
   mPhoto.attach(kind, refId, cap) → camera/picker → POST /attachments  → {id,url}
   mPhoto.thumbs(kind, refId, {editable}) → a DOM strip of attachment thumbnails
   mPhoto.view(url)                → fullscreen viewer (/api-relative path or blob: URL)
   mPhoto.picker({max, prepare, accept, canEdit, onBusy, onError}) → local multi-photo picker (nothing uploaded); .files(), .clear()
                                     prepare(file, index, room) → Promise<File | File[]> runs on each
                                     pick (e.g. ImageCompress.reencode; a PDF → several page photos),
                                     `room` = slots left; a rejection skips that pick.
                                     accept defaults to 'image/*' */
(function () {
  function preparePhoto(file) {
    return ImageCompress.maybeCompress(file).then(function (prepared) {
      if (prepared.size > 8 * 1024 * 1024) throw new Error('Photo is still larger than 8 MB. Take a smaller photo.');
      return prepared;
    });
  }
  function pickFile() {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { reject(new Error('cancelled')); return; }
        preparePhoto(file).then(resolve).catch(function (err) { mToast(err.message, 'err'); reject(err); });
      };
      input.click();
    });
  }

  function capture(itemId) {
    return pickFile().then(function (file) {
      var fd = new FormData();
      fd.append('image', file, file.name || 'photo.jpg');
      mToast('Uploading photo…');
      return API.upload('/inventory/' + itemId + '/image', fd)
        .then(function (r) { mToast('Photo saved'); return r; })
        .catch(function (e) { mToast(e.message || 'Upload failed', 'err'); throw e; });
    });
  }

  function attach(kind, refId, caption) {
    return pickFile().then(function (file) { return attachBlob(kind, refId, file, file.name || 'photo.jpg', caption); });
  }

  /** Upload an already-obtained Blob/File (e.g. a signature canvas) as an attachment. */
  function attachBlob(kind, refId, blob, filename, caption, opts) {
    var fd = new FormData();
    fd.append('image', blob, filename || 'upload.png');
    fd.append('kind', kind);
    fd.append('ref_id', String(refId));
    if (caption) fd.append('caption', caption);
    return API.upload('/attachments', fd, opts)
      .catch(function (e) { mToast(e.message || 'Upload failed', 'err'); throw e; });
  }

  /** `url` is /api-relative (fetched with the signed-in token), or an already-loaded blob: URL. */
  function view(url) {
    var root = document.getElementById('m-overlay-root') || document.body;
    var ov = mEl('<div class="m-photo-view"><img alt="" /></div>');
    if (/^blob:/.test(url)) ov.querySelector('img').src = url;
    else API.blobUrl(url).then(function (u) { ov.querySelector('img').src = u; }).catch(function () {});
    ov.onclick = function () { ov.remove(); };
    root.appendChild(ov);
  }

  /** A horizontal strip of thumbnails + (optionally) an add tile. */
  function thumbs(kind, refId, opts) {
    opts = opts || {};
    var strip = mEl('<div class="m-thumbs"></div>');

    function addTile() {
      if (!opts.editable) return;
      var t = mEl('<button class="m-thumb m-thumb-add" type="button">＋<span>Photo</span></button>');
      t.onclick = function () {
        attach(kind, refId, opts.caption).then(function () { reload(); }).catch(function () {});
      };
      strip.appendChild(t);
    }

    function reload() {
      strip.innerHTML = '';
      API.get('/attachments?kind=' + encodeURIComponent(kind) + '&ref_id=' + refId)
        .then(function (rows) {
          (rows || []).forEach(function (r) {
            var cell = mEl('<div class="m-thumb"><img alt="" /></div>');
            API.blobUrl(r.url).then(function (u) { cell.querySelector('img').src = u; }).catch(function () {});
            cell.querySelector('img').onclick = function () { view(r.url); };
            if (opts.editable) {
              var x = mEl('<button class="m-thumb-x" type="button" aria-label="Remove">×</button>');
              x.onclick = function () {
                API.del('/attachments/' + r.id).then(reload).catch(function (e) { mToast(e.message || 'Failed', 'err'); });
              };
              cell.appendChild(x);
            }
            strip.appendChild(cell);
          });
          addTile();
        })
        .catch(function () { addTile(); });
    }
    reload();
    strip.reload = reload;
    return strip;
  }

  /** Pick photos to send later with a form — kept in memory only, shown as removable thumbnails.
      `initial` re-shows files picked earlier (e.g. coming back from a review screen). */
  function picker(opts) {
    opts = opts || {};
    var max = opts.max || 4;
    var files = (opts.initial || []).slice(0, max);
    var strip = mEl('<div class="m-thumbs m-photo-picker"></div>');

    function render() {
      strip.innerHTML = '';
      files.forEach(function (f, i) {
        var url = URL.createObjectURL(f);
        var cell = mEl('<div class="m-thumb"><img alt="Photo ' + (i + 1) + '" /></div>');
        var img = cell.querySelector('img');
        img.onload = function () { URL.revokeObjectURL(url); };
        img.src = url;
        var x = mEl('<button class="m-thumb-x" type="button" aria-label="Remove photo ' + (i + 1) + '">×</button>');
        x.onclick = function () { if (opts.canEdit && !opts.canEdit()) return; files.splice(i, 1); render(); if (opts.onChange) opts.onChange(files); };
        cell.appendChild(x);
        strip.appendChild(cell);
      });
      if (files.length >= max) return;
      var add = mEl('<button class="m-thumb m-thumb-add" type="button">＋<span>Photo</span></button>');
      add.onclick = function () {
        if (opts.canEdit && !opts.canEdit()) return;
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = opts.accept || 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = function () {
          if (opts.canEdit && !opts.canEdit()) { input.remove(); return; }
          var picked = Array.prototype.slice.call(input.files || [], 0, max - files.length);
          input.remove();
          if ((input.files || []).length > picked.length) mToast('Up to ' + max + ' photos', 'err');
          add.disabled = true;
          add.querySelector('span').textContent = 'Preparing…';
          if (opts.onBusy) opts.onBusy(true);
          picked.reduce(function (p, f) {
            return p.then(function () {
              var room = max - files.length;
              if (room <= 0) return;
              // Custom preparation (e.g. anonymous metadata stripping) keeps its
              // stricter contract. Ordinary operational photos share compression.
              return Promise.resolve().then(function () { return opts.prepare ? opts.prepare(f, files.length, room) : preparePhoto(f); }).then(function (out) {
                files = files.concat(out).slice(0, max);
              }, function (e) { if (opts.onError) opts.onError(e); mToast(e.message || 'Photo skipped', 'err'); });
            });
          }, Promise.resolve()).then(function () { render(); if (opts.onChange) opts.onChange(files); if (opts.onBusy) opts.onBusy(false); });
        };
        input.click();
      };
      strip.appendChild(add);
    }
    render();
    strip.files = function () { return files.slice(); };
    strip.clear = function () { files = []; render(); };
    return strip;
  }

  window.mPhoto = { capture: capture, attach: attach, attachBlob: attachBlob, thumbs: thumbs, view: view, pickFile: pickFile, picker: picker, preparePhoto: preparePhoto };
})();
