import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { DocumentInputError, exportDocx, importDocx } from '../src/core/document-conversion';
vi.mock('../src/core/document-conversion', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/document-conversion')>();
  return { ...actual, exportDocx: vi.fn(actual.exportDocx), importDocx: vi.fn(actual.importDocx) };
});
let ctx: TestContext, token: string;
const base = '/api/templates/studio/documents/new-template:error-audit';
const marker = '/private/provider/synthetic-sensitive-detail';
beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
afterAll(() => cleanup(ctx));
const input = { name: 'Test', body: '<p>Keep my draft</p>', widthMm: 210, heightMm: 297, marginMm: 14 };
describe('document conversion error disclosure', () => {
  it('hides unexpected export exceptions even when they carry a public-looking status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      vi.mocked(exportDocx).mockRejectedValueOnce(Object.assign(new Error(marker), { status: 400, expose: true }));
      const response = await ctx.api.post(base + '/export-docx').auth(token, { type: 'bearer' }).send(input);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error', request_id: response.headers['x-request-id'] });
      expect(response.body.request_id).toBeTruthy();
      expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(log.mock.calls)).toContain(response.body.request_id);
    } finally { log.mockRestore(); }
  });
  it('retains explicitly authored document-limit feedback', async () => {
    vi.mocked(exportDocx).mockRejectedValueOnce(new DocumentInputError('Document has too many elements'));
    const response = await ctx.api.post(base + '/export-docx').auth(token, { type: 'bearer' }).send(input);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Document has too many elements');
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });
  it('never exposes parser exception details from imports', async () => {
    vi.mocked(importDocx).mockRejectedValueOnce(new Error(marker));
    const response = await ctx.api.post(base + '/import-docx').auth(token, { type: 'bearer' }).attach('file', Buffer.from('invalid'), 'test.docx');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Could not read this DOCX. Choose a valid document and try again.');
    expect(response.body.request_id).toBeTruthy();
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });
  it('handles a real malformed archive without exposing dependency errors', async () => {
    const response = await ctx.api.post(base + '/import-docx').auth(token, { type: 'bearer' }).attach('file', Buffer.from('not a zip'), 'broken.docx');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Could not read this DOCX. Choose a valid document and try again.');
  });
});
