/* "Open when Windows starts" (docs/OFFLINE-FIRST.md §17). Uses Windows' per-user startup list
   (Electron's login items → HKCU\...\Run), so no admin rights. A start from there passes
   `--autostart`, and the window opens minimized. Pure helpers, kept apart from main.cjs so they
   can be tested without Electron. */

const AUTOSTART_ARG = '--autostart';

/** The options for app.setLoginItemSettings. A packaged app starts its own exe; from the source
 *  tree the exe is electron.exe, which needs the main script as its first argument. */
function loginItemOptions({ on, isPackaged, execPath, mainScript }) {
  return isPackaged
    ? { openAtLogin: !!on, path: execPath, args: [AUTOSTART_ARG] }
    : { openAtLogin: !!on, path: execPath, args: [mainScript, AUTOSTART_ARG] };
}

/** The first-start default: the site's main PC must run all day for its LAN, so it starts with
 *  Windows; other PCs only when someone turns it on. */
function defaultAutostart(role) {
  return role === 'host';
}

module.exports = { AUTOSTART_ARG, loginItemOptions, defaultAutostart };
