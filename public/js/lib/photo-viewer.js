/* Full-screen, read-only viewer for authenticated photo attachments. */
(function () {
  function loadingHTML(label) {
    return '<div class="attachment-media-loading" role="status"><span class="attachment-media-tile" aria-hidden="true">◇</span><span>' + label + '</span></div>';
  }
  // Shared by attachment viewers and mobile message controls. Only the top dialog owns keys.
  var dialogs = [];
  function mountDialog(overlay, options) {
    options = options || {};
    var previousFocus = document.activeElement, closed = false;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.tabIndex = -1;
    function controls() { return Array.prototype.filter.call(overlay.querySelectorAll('button,a[href],input,textarea,select,video[controls],audio[controls],iframe,[tabindex="0"]'), function (el) { return !el.disabled && !el.hidden && !el.closest('[hidden]'); }); }
    function focus() { var target = options.initialFocus && overlay.querySelector(options.initialFocus); if (target && (target.disabled || target.hidden || target.closest('[hidden]'))) target = null; (target || controls()[0] || overlay).focus(); }
    function close() {
      if (closed || (options.canClose && !options.canClose())) return false;
      closed = true;
      overlay.remove(); document.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocus, true);
      dialogs.splice(dialogs.indexOf(controller), 1);
      if (options.onClose) options.onClose();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      return true;
    }
    function top() { return dialogs[dialogs.length - 1] === controller; }
    function onFocus(event) { if (top() && !overlay.contains(event.target)) focus(); }
    function onKey(event) {
      if (!top()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      var list = controls(), first = list[0], last = list[list.length - 1];
      if (!list.length) { event.preventDefault(); overlay.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement) || document.activeElement === overlay)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement) || document.activeElement === overlay)) { event.preventDefault(); first.focus(); }
    }
    var controller = { overlay: overlay, close: close, focus: focus };
    dialogs.push(controller);
    document.addEventListener('keydown', onKey, true); document.addEventListener('focusin', onFocus, true);
    overlay.addEventListener('click', function (event) { if (event.target === overlay) close(); });
    focus(); return controller;
  }
  window.MessageOverlay = { mount: mountDialog };
  var activeViewer = null, pendingDownloads = Object.create(null);
  function existingViewer(key) {
    if (!activeViewer) return null;
    if (activeViewer.overlay.isConnected && activeViewer.key === key) { activeViewer.focus(); return activeViewer.overlay; }
    activeViewer.close(); return null;
  }
  function open(source, name) {
    var key = 'photo:' + source, existing = existingViewer(key);
    if (existing) return existing;
    var overlay = document.createElement('div');
    overlay.className = 'attachment-photo-viewer';
    overlay.setAttribute('aria-label', name || 'Photo');
    overlay.innerHTML = '<div class="attachment-photo-viewer-bar"><span></span><button type="button" data-close aria-label="Close photo">×</button></div><img alt="" hidden /><div class="attachment-photo-viewer-error" hidden><p role="alert">Photo unavailable. Check your connection and try again. If it was removed, ask the sender to resend it.</p><button type="button" data-retry>Retry photo</button></div>';
    overlay.insertAdjacentHTML('beforeend', loadingHTML('Preparing photo…'));
    overlay.querySelector('span').textContent = name || 'Photo';
    var image = overlay.querySelector('img'), loading = overlay.querySelector('.attachment-media-loading');
    var errorBox = overlay.querySelector('.attachment-photo-viewer-error'), retry = overlay.querySelector('[data-retry]');
    var ownedUrl = null, pending = false, version = 0;
    image.alt = name || 'Photo';
    function releaseUrl() { if (ownedUrl) { URL.revokeObjectURL(ownedUrl); ownedUrl = null; } }
    function unavailable() {
      if (!overlay.isConnected) return;
      pending = false; loading.hidden = true; image.hidden = true; errorBox.hidden = false; retry.disabled = false;
      overlay.setAttribute('aria-busy', 'false');
    }
    image.onerror = unavailable;
    image.onload = function () { if (!overlay.isConnected) return; pending = false; loading.hidden = true; errorBox.hidden = true; image.hidden = false; retry.disabled = false; overlay.setAttribute('aria-busy', 'false'); };
    function load() {
      if (pending || !overlay.isConnected) return;
      pending = true; var attempt = ++version;
      if (errorBox.contains(document.activeElement)) overlay.querySelector('[data-close]').focus();
      releaseUrl(); image.removeAttribute('src'); image.hidden = true; errorBox.hidden = true; loading.hidden = false; retry.disabled = true;
      overlay.setAttribute('aria-busy', 'true');
      if (/^(blob:|data:)/.test(source)) { image.src = source; return; }
      API.blobUrl(source).then(function (url) {
        if (!overlay.isConnected || attempt !== version) { URL.revokeObjectURL(url); return; }
        ownedUrl = url; image.src = url;
      }).catch(function () { if (attempt === version) unavailable(); });
    }
    document.body.appendChild(overlay);
    var control = mountDialog(overlay, { initialFocus: '[data-close]', onClose: function () { version++; releaseUrl(); if (activeViewer === control) activeViewer = null; } });
    control.key = key; activeViewer = control;
    overlay.querySelector('[data-close]').onclick = control.close; retry.onclick = load; load();
    return overlay;
  }
  window.PhotoViewer = { open: open };

  // Shared desktop/mobile composer feedback, with real bytes sent rather than a timer.
  window.MessageUpload = {
    create: function (host) {
      var panel = document.createElement('div');
      panel.className = 'message-upload';
      panel.hidden = true;
      panel.innerHTML = '<div class="message-upload-copy" role="status" aria-live="polite">Preparing files…</div><div class="message-upload-track" role="progressbar" aria-label="File upload" aria-valuemin="0" aria-valuemax="100"><span></span></div>';
      host.after(panel);
      var label = panel.querySelector('.message-upload-copy');
      var track = panel.querySelector('.message-upload-track');
      var fill = track.querySelector('span');
      return {
        start: function () { panel.hidden = false; panel.classList.add('is-indeterminate'); label.textContent = 'Preparing files…'; track.removeAttribute('aria-valuenow'); fill.style.width = ''; },
        progress: function (event) {
          if (!event.total) { label.textContent = 'Uploading files…'; return; }
          var percent = Math.min(100, Math.floor(event.loaded / event.total * 100));
          panel.classList.remove('is-indeterminate');
          track.setAttribute('aria-valuenow', percent);
          fill.style.width = percent + '%';
          label.textContent = percent === 100 ? 'Upload complete · saving message…' : 'Uploading files · ' + percent + '%';
          if (percent === 100) panel.classList.add('is-saving');
        },
        stop: function () { panel.hidden = true; panel.classList.remove('is-saving'); },
      };
    },
  };

  function openAttachment(source, name, mime) {
    var key = 'file:' + source, existing = existingViewer(key);
    if (existing) return existing;
    var ext = (name || '').split('.').pop().toLowerCase();
    var kind = ext === 'pdf' ? 'pdf' : (mime || '').startsWith('video/') || /^(mp4|webm|mov|m4v)$/i.test(ext) ? 'video'
      : /^(mp3|m4a|wav|ogg)$/i.test(ext) ? 'audio'
      : /^(docx|xlsx|txt|log|md|csv|tsv|json)$/i.test(ext) ? 'text' : 'unsupported';
    var overlay = document.createElement('div');
    overlay.className = 'attachment-document-viewer';
    overlay.setAttribute('aria-label', 'Preview ' + (name || 'attachment'));
    overlay.innerHTML = '<div class="attachment-document-panel"><header><strong></strong><div><button type="button" data-download>Download</button><button type="button" data-close aria-label="Close preview">×</button></div></header><p class="attachment-download-error" role="status" hidden></p><div class="attachment-document-body"></div></div>';
    overlay.querySelector('strong').textContent = name || 'Attachment';
    var body = overlay.querySelector('.attachment-document-body'), download = overlay.querySelector('[data-download]');
    var notice = overlay.querySelector('.attachment-download-error');
    var ownedUrl = null, pending = false, downloading = false, version = 0;
    function releaseUrl() { if (ownedUrl) { URL.revokeObjectURL(ownedUrl); ownedUrl = null; } }
    function failed(message) {
      if (!overlay.isConnected) return;
      pending = false; body.removeAttribute('aria-busy');
      body.innerHTML = '<div class="attachment-preview-error"><p role="alert"></p><button type="button" data-retry>Retry preview</button></div>';
      body.querySelector('p').textContent = message || 'Preview unavailable. Try again or download the file to view it.';
      body.querySelector('button').onclick = load;
    }
    function load() {
      if (pending || !overlay.isConnected) return;
      pending = true; var attempt = ++version;
      if (body.contains(document.activeElement)) overlay.querySelector('[data-close]').focus();
      body.replaceChildren(); releaseUrl(); body.innerHTML = loadingHTML('Preparing preview…'); body.setAttribute('aria-busy', 'true');
      if (kind === 'unsupported') { pending = false; body.removeAttribute('aria-busy'); body.textContent = 'Preview is not available for this file type. Download it to view.'; return; }
      if (kind === 'text') {
        API.get(source + '/preview').then(function (result) {
          if (!overlay.isConnected || attempt !== version) return;
          var pre = document.createElement('pre'); pre.textContent = result.text || 'This file has no readable text.';
          pending = false; body.removeAttribute('aria-busy'); body.replaceChildren(pre);
        }).catch(function (error) { if (attempt === version) failed(error.message); }); return;
      }
      var mediaType = kind === 'pdf' ? 'application/pdf' : kind === 'video' ? ({ mp4:'video/mp4', m4v:'video/mp4', webm:'video/webm', mov:'video/quicktime' })[ext] : ({ mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg' })[ext];
      API.blobUrl(source, mediaType).then(function (url) {
        if (!overlay.isConnected || attempt !== version) { URL.revokeObjectURL(url); return; }
        ownedUrl = url;
        var media = document.createElement(kind === 'pdf' ? 'iframe' : kind);
        if (kind === 'pdf') media.title = name || 'PDF preview';
        else { media.controls = true; media.playsInline = true; }
        media.onerror = function () { if (attempt === version) failed('Preview unavailable. Try again or download the file to view it.'); };
        if (kind === 'video' || kind === 'audio') {
          media.hidden = true; media.preload = 'auto';
          media.onloadeddata = function () {
            if (!overlay.isConnected || attempt !== version) return;
            pending = false; body.removeAttribute('aria-busy');
            var loading = body.querySelector('.attachment-media-loading'); if (loading) loading.remove(); media.hidden = false;
          };
          body.appendChild(media);
        } else { pending = false; body.removeAttribute('aria-busy'); body.replaceChildren(media); }
        media.src = url;
      }).catch(function (error) { if (attempt === version) failed(error.message || 'File unavailable. Ask the sender to resend it.'); });
    }
    function watchDownload(job) {
      downloading = true; download.disabled = true; download.textContent = 'Downloading…'; notice.hidden = true;
      job.then(function () { if (overlay.isConnected) { notice.setAttribute('role', 'status'); notice.textContent = 'Download started.'; notice.hidden = false; } },
        function (error) { if (overlay.isConnected) { notice.setAttribute('role', 'alert'); notice.textContent = error.message || 'Download failed. Please try again.'; notice.hidden = false; } })
        .finally(function () { downloading = false; download.disabled = false; download.textContent = 'Download'; });
    }
    download.onclick = function () {
      if (downloading || pendingDownloads[source]) return;
      var job = Promise.resolve().then(function () { return API.download(source, name); });
      pendingDownloads[source] = job;
      job.then(function () { delete pendingDownloads[source]; }, function () { delete pendingDownloads[source]; });
      watchDownload(job);
    };
    if (pendingDownloads[source]) watchDownload(pendingDownloads[source]);
    document.body.appendChild(overlay);
    var control = mountDialog(overlay, { initialFocus: '[data-close]', onClose: function () { version++; releaseUrl(); if (activeViewer === control) activeViewer = null; } });
    control.key = key; activeViewer = control; overlay.querySelector('[data-close]').onclick = control.close;
    load(); return overlay;
  }
  window.AttachmentViewer = { open: openAttachment };
})();
