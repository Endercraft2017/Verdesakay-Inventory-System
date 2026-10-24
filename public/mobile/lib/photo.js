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
  function pickFile(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var done = false;
      function current() { return !opts.signal?.aborted && (!opts.isCurrent || opts.isCurrent()); }
      function finish(error, file) { if (done) return; done = true; input.remove(); opts.signal?.removeEventListener('abort',abort); if (error) reject(error); else resolve(file); }
      function abort() { finish(Object.assign(new Error('cancelled'),{cancelled:true})); }
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.oncancel = abort;
      opts.signal?.addEventListener('abort',abort,{once:true});
      input.onchange = function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file || !current()) { abort(); return; }
        preparePhoto(file).then(function(prepared) { if (!current()) abort(); else finish(null,prepared); }).catch(function (err) { if (current()) mToast(err.message, 'err'); finish(err); });
      };
      if (!current()) { abort(); return; }
      input.click();
    });
  }

  function capture(itemId, opts) {
    opts = opts || {};
    function current() { return !opts.signal?.aborted && (!opts.isCurrent || opts.isCurrent()); }
    return pickFile(opts).then(function (file) {
      if (!current()) throw Object.assign(new Error('cancelled'),{cancelled:true});
      var fd = new FormData();
      fd.append('image', file, file.name || 'photo.jpg');
      mToast('Uploading photo…');
      opts.onUpload?.();
      return API.upload('/inventory/' + itemId + '/image', fd, opts)
        .then(function (r) { if (current()) mToast('Photo saved'); return r; })
        .catch(function (e) { if (current() && !e.cancelled) mToast(e.message || 'Upload failed', 'err'); throw e; });
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
      .catch(function (e) { if(!opts?.isCurrent||opts.isCurrent())mToast(e.message || 'Upload failed', 'err'); throw e; });
  }

  /** `url` is /api-relative (fetched with the signed-in token), or an already-loaded blob: URL. */
  function view(url) {
    var root = document.getElementById('m-overlay-root') || document.body;
    var ov = mEl('<div class="m-photo-view"><img alt="" /></div>');
    if (/^blob:/.test(url)) ov.querySelector('img').src = url;
    else API.blobUrl(url).then(function (u) { ov.querySelector('img').src = u; }).catch(function () {});
    ov.onclick = function () { ov.remove(); };
    root.appendChild(ov);
    return ov;
  }

  /** A horizontal strip of thumbnails + (optionally) an add tile. */
  function thumbs(kind, refId, opts) {
    opts=opts||{};var strip=mEl('<div class="m-thumbs"></div>'),busy=false,urls=[],overlays=[];
    function current(){return !opts.signal?.aborted&&(!opts.scope||opts.scope.current());}
    function run(invoke,timeout){return opts.scope?opts.scope.run(invoke,timeout):invoke({});}
    function cleanup(){urls.forEach(function(u){URL.revokeObjectURL(u);});urls=[];overlays.forEach(function(ov){ov.remove();});overlays=[];}
    opts.signal?.addEventListener('abort',cleanup,{once:true});
    function addTile(){
      if(!opts.editable||!current())return;
      var tile=mEl('<button class="m-thumb m-thumb-add" type="button">＋<span>Photo</span></button>');
      tile.onclick=async function(){
        if(busy||!current())return;busy=true;tile.disabled=true;
        try{var file=await pickFile({signal:opts.signal,isCurrent:current});if(!current())return;
          await run(function(request){return attachBlob(kind,refId,file,file.name||'photo.jpg',opts.caption,Object.assign({},request,{idempotencyKey:'photo-'+crypto.randomUUID()}));},60000);
          if(current())reload();
        }catch(error){if(current()&&!error.cancelled&&error.message!=='cancelled')mToast(error.message||'Photo was not confirmed. Refresh before another upload.','err');}
        finally{busy=false;if(current())tile.disabled=false;}
      };strip.appendChild(tile);
    }
    function reload(){
      if(!current())return;cleanup();strip.innerHTML='';
      run(function(request){return API.get('/attachments?kind='+encodeURIComponent(kind)+'&ref_id='+refId,request);}).then(function(rows){
        if(!current())return;if(!Array.isArray(rows))throw new Error('Photos could not be read.');
        rows.forEach(function(row){
          var cell=mEl('<div class="m-thumb"><img alt="Attached photo"></div>');
          run(function(request){return API.blobUrl(row.url,undefined,request).then(function(url){if(!current()){URL.revokeObjectURL(url);return null;}urls.push(url);return url;});}).then(function(url){if(current()&&url){cell.querySelector('img').src=url;cell.querySelector('img').onclick=function(){if(current())overlays.push(view(url));};}}).catch(function(){});
          if(opts.editable){var remove=mEl('<button class="m-thumb-x" type="button" aria-label="Remove photo">×</button>');remove.onclick=async function(){if(busy||!current())return;busy=true;remove.disabled=true;try{await run(function(request){return API.del('/attachments/'+row.id,request);});if(current())reload();}catch(error){if(current())mToast(error.message||'Failed','err');}finally{busy=false;if(current())remove.disabled=false;}};cell.appendChild(remove);}
          strip.appendChild(cell);
        });addTile();
      }).catch(function(error){if(!current())return;strip.appendChild(mEl('<span class="m-hint">'+mEsc(error.message||'Photos could not be loaded.')+'</span>'));var retry=mEl('<button class="m-chip" type="button">Retry photos</button>');retry.onclick=reload;strip.appendChild(retry);addTile();});
    }
    reload();strip.reload=reload;return strip;
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
