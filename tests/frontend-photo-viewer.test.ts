import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

function viewer(api: any) {
  const dom = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only' });
  Object.assign(dom.window, { API: api });
  dom.window.URL.revokeObjectURL = vi.fn();
  dom.window.eval(fs.readFileSync('public/js/lib/photo-viewer.js', 'utf8'));
  return dom;
}

describe('full-screen attachment previews', () => {
  it('hides the photo until decoding completes and cleans up on close', async () => {
    const dom = viewer({ blobUrl: vi.fn(async () => 'blob:photo') });
    (dom.window as any).PhotoViewer.open('/messages/1/attachments/2', 'photo.jpg');
    const image = dom.window.document.querySelector('img')!;
    const loader = dom.window.document.querySelector('.attachment-media-loading') as HTMLElement;
    expect(image.hidden).toBe(true);
    expect(loader.hidden).toBe(false);
    await Promise.resolve();
    image.dispatchEvent(new dom.window.Event('load'));
    expect(image.hidden).toBe(false);
    expect(loader.hidden).toBe(true);
    (dom.window.document.querySelector('button') as HTMLElement).click();
    expect(dom.window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
    dom.window.close();
  });

  it('shows a photo error without leaving a broken image visible', async () => {
    const dom = viewer({ blobUrl: vi.fn(async () => { throw new Error('Missing'); }) });
    (dom.window as any).PhotoViewer.open('/messages/1/attachments/2', 'photo.jpg');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((dom.window.document.querySelector('img') as HTMLImageElement).hidden).toBe(true);
    expect((dom.window.document.querySelector('.attachment-photo-viewer-error') as HTMLElement).hidden).toBe(false);
    expect((dom.window.document.querySelector('.attachment-media-loading') as HTMLElement).hidden).toBe(true);
    dom.window.close();
  });

  it('keeps the video preview intact when a download fails', async () => {
    const dom = viewer({ blobUrl: vi.fn(async () => 'blob:video'), download: vi.fn(async () => { throw new Error('File is missing on disk'); }) });
    (dom.window as any).AttachmentViewer.open('/messages/1/attachments/2', 'clip.mp4');
    await Promise.resolve();
    const video = dom.window.document.querySelector('video')!;
    expect(video.hidden).toBe(true);
    video.dispatchEvent(new dom.window.Event('loadeddata'));
    expect(video.hidden).toBe(false);
    (dom.window.document.querySelector('[data-download]') as HTMLElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dom.window.document.querySelector('video')).toBe(video);
    expect(dom.window.document.querySelector('[role=alert]')?.textContent).toBe('File is missing on disk');
    dom.window.close();
  });
});

it('shows upload progress and a saving phase, then clears the indicator', () => {
  const dom = viewer({});
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const status = (dom.window as any).MessageUpload.create(host);
  status.start();
  const panel = dom.window.document.querySelector('.message-upload') as HTMLElement;
  expect(panel.hidden).toBe(false);
  expect(panel.textContent).toContain('Preparing files');
  status.progress({ loaded: 50, total: 100 });
  expect(panel.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50');
  status.progress({ loaded: 100, total: 100 });
  expect(panel.textContent).toContain('saving message');
  status.stop();
  expect(panel.hidden).toBe(true);
  dom.window.close();
});
