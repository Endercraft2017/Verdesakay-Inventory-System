import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/mobile/lib/photo.js', import.meta.url), 'utf8');
function boot(compress: (file: any) => Promise<any>) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const w: any = dom.window;
  w.ImageCompress = { maybeCompress: compress };
  w.mToast = () => {};
  w.eval(source);
  return w;
}
describe('operational phone photo preparation', () => {
  it('compresses a camera selection before the upload-size check', async () => {
    const compressed = { size: 300000, type: 'image/jpeg', name: 'camera.jpg' };
    const picked: any[] = [];
    const w = boot(async file => { picked.push(file); return compressed; });
    const pending = w.mPhoto.pickFile();
    const input = w.document.querySelector('input');
    const original = { size: 12000000, type: 'image/jpeg', name: 'camera.jpg' };
    Object.defineProperty(input, 'files', { value: [original] });
    input.dispatchEvent(new w.Event('change'));
    expect(await pending).toBe(compressed);
    expect(picked).toEqual([original]);
    w.close();
  });
  it('retains already-small files and refuses photos still above the server limit', async () => {
    const w = boot(async file => file);
    const small = { size: 20000, type: 'image/png' };
    expect(await w.mPhoto.preparePhoto(small)).toBe(small);
    await expect(w.mPhoto.preparePhoto({ size: 9000000 })).rejects.toThrow('still larger than 8 MB');
    w.close();
  });
  it('does not recompress an immutable attachment or signature during upload/retry', async () => {
    let compressed = 0;
    const w = boot(async file => { compressed++; return file; });
    const uploads: any[] = [];
    w.API = { upload: async (_path: string, body: any) => { uploads.push(body); return { id: 1 }; } };
    const file = new w.File(['prepared bytes'], 'prepared.jpg', { type: 'image/jpeg' });
    await w.mPhoto.attachBlob('qc_unit', 1, file, 'prepared.jpg');
    await w.mPhoto.attachBlob('signature', 1, file, 'signature.png');
    expect(compressed).toBe(0);
    expect(uploads).toHaveLength(2);
    w.close();
  });
  it('compresses ordinary multi-photo picks while preserving custom privacy preparation', async () => {
    let compressed = 0;
    const w = boot(async file => { compressed++; return file; });
    w.mEl = (html: string) => { const box = w.document.createElement('div'); box.innerHTML = html; return box.firstElementChild; };
    w.URL.createObjectURL = () => 'blob:preview'; w.URL.revokeObjectURL = () => {};
    const file = new w.File(['photo'], 'phone.jpg', { type: 'image/jpeg' });
    async function select(picker: any) {
      w.document.body.appendChild(picker);
      picker.querySelector('.m-thumb-add').click();
      const input = w.document.querySelector('input');
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new w.Event('change'));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const ordinary = w.mPhoto.picker({ max: 1 }); await select(ordinary);
    expect(compressed).toBe(1); expect(ordinary.files()).toEqual([file]);
    const scrubbed = new w.File(['scrubbed'], 'anonymous.jpg', { type: 'image/jpeg' });
    const anonymous = w.mPhoto.picker({ max: 1, prepare: async () => scrubbed }); await select(anonymous);
    expect(compressed).toBe(1); expect(anonymous.files()).toEqual([scrubbed]);
    w.close();
  });
});
