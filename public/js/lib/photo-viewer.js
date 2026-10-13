/* Full-screen, read-only viewer for authenticated photo attachments. */
(function () {
  function open(source, name) {
    var overlay = document.createElement('div');
    overlay.className = 'attachment-photo-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', name || 'Photo');
    overlay.innerHTML = '<div class="attachment-photo-viewer-bar"><span></span><button type="button" aria-label="Close photo">×</button></div><img alt="" /><p class="attachment-photo-viewer-error" hidden>Photo unavailable. Ask the sender to resend it.</p>';
    overlay.querySelector('span').textContent = name || 'Photo';
    var image = overlay.querySelector('img');
    image.alt = name || 'Photo';
    function unavailable() {
      image.hidden = true;
      overlay.querySelector('.attachment-photo-viewer-error').hidden = false;
    }
    image.onerror = unavailable;
    var ownedUrl = null;
    var previousFocus = document.activeElement;
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); close(); } }
    overlay.onclick = function (event) { if (event.target === overlay) close(); };
    overlay.querySelector('button').onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('button').focus();
    if (/^(blob:|data:)/.test(source)) image.src = source;
    else API.blobUrl(source).then(function (url) {
      if (!overlay.isConnected) { URL.revokeObjectURL(url); return; }
      ownedUrl = url;
      image.src = url;
    }).catch(function () { if (overlay.isConnected) unavailable(); });
  }
  window.PhotoViewer = { open: open };

  function openAttachment(source, name, mime) {
    var ext = (name || '').split('.').pop().toLowerCase();
    var kind = ext === 'pdf' ? 'pdf' : /^(mp4|webm|mov|m4v)$/i.test(ext) ? 'video'
      : /^(mp3|m4a|wav|ogg)$/i.test(ext) ? 'audio'
      : /^(docx|xlsx|txt|log|md|csv|tsv|json)$/i.test(ext) ? 'text' : 'unsupported';
    var overlay = document.createElement('div');
    overlay.className = 'attachment-document-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Preview ' + (name || 'attachment'));
    overlay.innerHTML = '<div class="attachment-document-panel"><header><strong></strong><div><button type="button" data-download>Download</button><button type="button" data-close aria-label="Close preview">×</button></div></header><div class="attachment-document-body">Loading preview…</div></div>';
    overlay.querySelector('strong').textContent = name || 'Attachment';
    var body = overlay.querySelector('.attachment-document-body');
    var ownedUrl = null;
    var previousFocus = document.activeElement;
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); close(); } }
    overlay.onclick = function (event) { if (event.target === overlay) close(); };
    overlay.querySelector('[data-close]').onclick = close;
    overlay.querySelector('[data-download]').onclick = function () {
      API.download(source, name).catch(function () { body.textContent = 'Download failed. Please try again.'; });
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close]').focus();
    if (kind === 'unsupported') {
      body.textContent = 'Preview is not available for this file type. Download it to view.';
      return;
    }
    if (kind === 'text') {
      API.get(source + '/preview').then(function (result) {
        if (!overlay.isConnected) return;
        var pre = document.createElement('pre');
        pre.textContent = result.text || 'This file has no readable text.';
        body.replaceChildren(pre);
      }).catch(function (error) {
        if (overlay.isConnected) body.textContent = error.message || 'Preview unavailable. Download the file to view it.';
      });
      return;
    }
    var mediaType = kind === 'pdf' ? 'application/pdf'
      : kind === 'video' ? ({ mp4:'video/mp4', m4v:'video/mp4', webm:'video/webm', mov:'video/quicktime' })[ext]
      : ({ mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg' })[ext];
    API.blobUrl(source, mediaType).then(function (url) {
      if (!overlay.isConnected) { URL.revokeObjectURL(url); return; }
      ownedUrl = url;
      var media = document.createElement(kind === 'pdf' ? 'iframe' : kind);
      media.src = url;
      if (kind === 'pdf') media.title = name || 'PDF preview';
      else { media.controls = true; media.playsInline = true; }
      media.onerror = function () { body.textContent = 'Preview unavailable. Download the file to view it.'; };
      body.replaceChildren(media);
    }).catch(function () {
      if (overlay.isConnected) body.textContent = 'File unavailable. Ask the sender to resend it.';
    });
  }
  window.AttachmentViewer = { open: openAttachment };
})();
