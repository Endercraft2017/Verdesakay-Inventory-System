import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

function client(fetch: ReturnType<typeof vi.fn>) {
  const dom = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only' });
  const win = dom.window;
  Object.assign(win, { fetch });
  win.URL.createObjectURL = vi.fn(() => 'blob:attachment');
  win.URL.revokeObjectURL = vi.fn();
  win.localStorage.setItem('vds_token', 'test-token');
  win.eval(fs.readFileSync('public/js/api.js', 'utf8') + '\nwindow.mediaAPI = API;');
  return { dom, api: (win as any).mediaAPI, win };
}

describe('authenticated attachment downloads', () => {
  it('fetches relative and API-prefixed attachment paths with authentication', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['video']) }));
    const { dom, api } = client(fetch);
    await api.blobUrl('/messages/1/attachments/2');
    await api.blobUrl('/api/messages/1/attachments/2');
    for (const [url, options] of fetch.mock.calls as any) {
      expect(url).toBe('/api/messages/1/attachments/2');
      expect(options.headers.Authorization).toBe('Bearer test-token');
    }
    dom.window.close();
  });

  it('reports the server reason when an attachment cannot be downloaded', async () => {
    const { dom, api } = client(vi.fn(async () => ({ ok: false, status: 410, json: async () => ({ error: 'File is missing on disk' }) })));
    await expect(api.download('/messages/1/attachments/2', 'clip.mp4')).rejects.toThrow('File is missing on disk');
    dom.window.close();
  });

  it('attaches the save link before clicking and preserves the original filename', async () => {
    const { dom, api, win } = client(vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['video']) })));
    const clicks: any[] = [];
    win.HTMLAnchorElement.prototype.click = function () { clicks.push({ connected: this.isConnected, name: this.download, href: this.href }); };
    await api.download('/messages/1/attachments/2', 'My clip 🎬.mp4');
    expect(clicks).toEqual([{ connected: true, name: 'My clip 🎬.mp4', href: 'blob:attachment' }]);
    expect(win.document.querySelector('a')).toBeNull();
    dom.window.close();
  });
});
