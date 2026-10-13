/* Full-screen, read-only viewer for authenticated photo attachments. */
(function () {
  function open(source, name) {
    var overlay = document.createElement('div');
    overlay.className = 'attachment-photo-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', name || 'Photo');
    overlay.innerHTML = '<div class="attachment-photo-viewer-bar"><span></span><button type="button" aria-label="Close photo">×</button></div><img alt="" />';
    overlay.querySelector('span').textContent = name || 'Photo';
    var image = overlay.querySelector('img');
    image.alt = name || 'Photo';
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
    }).catch(function () { if (overlay.isConnected) image.alt = 'Photo could not be loaded'; });
  }
  window.PhotoViewer = { open: open };
})();
