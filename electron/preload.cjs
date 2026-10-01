/* The bridge between the desktop shell and its windows (contextIsolation on): the setup
   screen's enrolment, and the few desktop-only settings. The app's data never goes through it —
   the app talks to its own server over HTTP like a browser. */
const { contextBridge, ipcRenderer } = require('electron');

// Inside the running app: settings only the desktop app has. The web app shows them only when
// `window.desktopApp` exists (never in a browser).
contextBridge.exposeInMainWorld('desktopApp', {
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', !!on),
});

contextBridge.exposeInMainWorld('desktopSetup', {
  hostCertificate: (hostAddress) => ipcRenderer.invoke('host-certificate', hostAddress),
  enrol: (form) => ipcRenderer.invoke('enrol', form),
  onLog: (cb) => ipcRenderer.on('enrol-log', (_e, line) => cb(line)),
});
