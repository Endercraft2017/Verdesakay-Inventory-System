import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { it, expect, vi } from 'vitest';

it('MFA modal keeps initial focus and does not redirect a user who moved to the code field', async () => {
  vi.useFakeTimers();
  const dom = new JSDOM('<div id="modal-root"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
    w.eval(fs.readFileSync(new URL('../public/js/lib/mfa.js', import.meta.url), 'utf8') + ';window.Mfa=Mfa;');
    const requests: unknown[] = [];
    w.API = { post: async (url: string, body: unknown) => { requests.push({ url, body }); return { ok: true }; } };
    const finished = w.Mfa.disable();
    const dialog = w.document.querySelector('[role="dialog"]');
    const password = dialog.querySelector('[data-f="pw"]');
    const code = dialog.querySelector('[data-f="code"]');
    expect(w.document.activeElement).toBe(password);
    password.value = 'Synthetic focus regression password';
    code.focus();
    await vi.advanceTimersByTimeAsync(60);
    expect(w.document.activeElement).toBe(code);
    // Model text input after focus movement; the real failed HTTP capture had
    // this value appended to the password and an empty code, rejected by the API.
    w.document.activeElement.value += 'abcde-12345';
    dialog.querySelector('[data-confirm]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(await finished).toBe(true);
    expect(requests).toEqual([{ url: '/auth/mfa/disable', body: { password: 'Synthetic focus regression password', code: 'abcde-12345' } }]);
  } finally {
    dom.window.close();
    vi.useRealTimers();
  }
});
