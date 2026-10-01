/** "Open when Windows starts" (electron/autostart.cjs, docs/OFFLINE-FIRST.md §17): the login-item
 *  options for the packaged app and the source tree, and the first-start default per role. */
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { AUTOSTART_ARG, loginItemOptions, defaultAutostart } = require('../electron/autostart.cjs') as {
  AUTOSTART_ARG: string;
  loginItemOptions: (o: { on: boolean; isPackaged: boolean; execPath: string; mainScript: string }) =>
    { openAtLogin: boolean; path: string; args: string[] };
  defaultAutostart: (role: string) => boolean;
};

describe('open when Windows starts', () => {
  it('the installed app starts its own exe, marked as an automatic start', () => {
    expect(loginItemOptions({ on: true, isPackaged: true, execPath: 'C:\\Apps\\Verdesakay.exe', mainScript: 'x' }))
      .toEqual({ openAtLogin: true, path: 'C:\\Apps\\Verdesakay.exe', args: [AUTOSTART_ARG] });
  });

  it('from the source tree, electron.exe gets the main script first', () => {
    expect(loginItemOptions({ on: false, isPackaged: false, execPath: 'electron.exe', mainScript: 'electron\\main.cjs' }))
      .toEqual({ openAtLogin: false, path: 'electron.exe', args: ['electron\\main.cjs', AUTOSTART_ARG] });
  });

  it('is on by default only for the site\'s main PC', () => {
    expect(defaultAutostart('host')).toBe(true);
    expect(defaultAutostart('pc')).toBe(false);
  });
});
