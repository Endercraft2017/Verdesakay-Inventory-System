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

describe('attachment upload progress', () => {
  it('reports actual bytes and preserves authentication and response handling', async () => {
    const { dom, api, win } = client(vi.fn());
    let xhr: any;
    class FakeXHR {
      upload: any = {};
      status = 201;
      responseText = '{"id":42}';
      headers: any = {};
      open = vi.fn();
      setRequestHeader(key: string, value: string) { this.headers[key] = value; }
      getResponseHeader(key: string) { return key.toLowerCase() === 'content-type' ? 'application/json' : null; }
      send = vi.fn();
      onload!: () => void;
      constructor() { xhr = this; }
    }
    Object.assign(win, { XMLHttpRequest: FakeXHR });
    const progress = vi.fn();
    const pending = api.upload('/messages', new win.FormData(), { onProgress: progress });
    xhr.upload.onprogress({ loaded: 500, total: 1000, lengthComputable: true });
    expect(progress).toHaveBeenCalledWith({ loaded: 500, total: 1000 });
    expect(xhr.headers.Authorization).toBe('Bearer test-token');
    expect(xhr.headers['Content-Type']).toBeUndefined();
    xhr.onload();
    await expect(pending).resolves.toEqual({ id: 42 });
    dom.window.close();
  });
});
