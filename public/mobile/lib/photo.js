/* Photo capture + attachments.
   mPhoto.capture(itemId)          → camera/picker → POST /inventory/:id/image
   mPhoto.attach(kind, refId, cap) → camera/picker → POST /attachments  → {id,url}
   mPhoto.thumbs(kind, refId, {editable}) → a DOM strip of attachment thumbnails
   mPhoto.view(url)                → fullscreen viewer */
(function () {
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
        if (file.size > 8 * 1024 * 1024) { mToast('Photo is larger than 8 MB', 'err'); reject(new Error('too big')); return; }
        resolve(file);
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
    return pickFile().then(function (file) {
      var fd = new FormData();
      fd.append('image', file, file.name || 'photo.jpg');
      fd.append('kind', kind);
      fd.append('ref_id', String(refId));
      if (caption) fd.append('caption', caption);
      mToast('Uploading photo…');
      return API.upload('/attachments', fd)
        .then(function (r) { mToast('Photo attached'); return r; })
        .catch(function (e) { mToast(e.message || 'Upload failed', 'err'); throw e; });
    });
  }

  function view(url) {
    var root = document.getElementById('m-overlay-root') || document.body;
    var ov = mEl('<div class="m-photo-view"><img alt="" /></div>');
    API.blobUrl(url).then(function (u) { ov.querySelector('img').src = u; }).catch(function () {});
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

  window.mPhoto = { capture: capture, attach: attach, thumbs: thumbs, view: view };
})();
