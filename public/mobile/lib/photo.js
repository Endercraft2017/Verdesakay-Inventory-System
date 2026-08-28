/* Item photo capture — opens the camera / picker and uploads to POST /inventory/:id/image.
   mPhoto.capture(itemId).then(onOk) — resolves after a successful upload. */
(function () {
  function capture(itemId) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment'; // hint phones to open the rear camera
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { reject(new Error('cancelled')); return; }
        if (file.size > 5 * 1024 * 1024) { mToast('Photo is larger than 5 MB', 'err'); reject(new Error('too big')); return; }
        var fd = new FormData();
        fd.append('image', file, file.name || 'photo.jpg');
        mToast('Uploading photo…');
        API.upload('/inventory/' + itemId + '/image', fd)
          .then(function (r) { mToast('Photo saved'); resolve(r); })
          .catch(function (e) { mToast(e.message || 'Upload failed', 'err'); reject(e); });
      };
      input.click();
    });
  }
  window.mPhoto = { capture: capture };
})();
