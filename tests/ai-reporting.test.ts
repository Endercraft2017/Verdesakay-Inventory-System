/** AI report generation: Markdown → HTML / DOCX, the create_report_document tool,
    and the auth-gated download endpoint. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { parseMarkdown, renderHtml, renderDocx } from '../src/modules/ai/reporting';
import type { AuthUser } from '../src/shared/types';

let ctx: TestContext;
let token: string;
let exec: typeof import('../src/modules/ai/ai-reporting').executeReportingTool;

const authHdr = () => ({ Authorization: `Bearer ${token}` });
const someUser: AuthUser = {
  id: 1, username: 'u', full_name: 'U', role: 'admin',
  department_id: null, active: 1, department_name: null, permissions: [],
};

const MD = `# Daily Report

Some **bold** intro text.

## Low stock

| Item | Qty | Min |
|---|---|---|
| Bolt | 2 | 10 |
| Nut | 0 | 5 |

## Actions
- Reorder bolts
- Call supplier

1. First
2. Second
`;

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  exec = (await import('../src/modules/ai/ai-reporting')).executeReportingTool;
});
afterAll(() => cleanup(ctx));

describe('reporting: markdown parser', () => {
  it('splits headings, paragraphs, tables and lists', () => {
    const b = parseMarkdown(MD);
    expect(b[0]).toEqual({ type: 'h1', text: 'Daily Report' });
    expect(b.some((x) => x.type === 'table' && x.columns.length === 3 && x.rows.length === 2)).toBe(true);
    expect(b.some((x) => x.type === 'ul' && x.items.length === 2)).toBe(true);
    expect(b.some((x) => x.type === 'ol' && x.items.length === 2)).toBe(true);
  });
});

describe('reporting: renderers', () => {
  it('renderHtml produces a self-contained doc with the table', () => {
    const html = renderHtml('Daily Report', parseMarkdown(MD));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<th>Item</th>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>Reorder bolts</li>');
  });

  it('renderDocx returns a non-trivial .docx buffer (zip)', async () => {
    const buf = await renderDocx('Daily Report', parseMarkdown(MD));
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // zip signature
  });
});

describe('reporting: create_report_document tool', () => {
  it('writes both files to UPLOAD_DIR and returns download urls', async () => {
    const r = await exec('create_report_document', { title: 'Weekly Ops', content: MD, format: 'both' }, someUser);
    expect(r.success).toBe(true);
    const files = (r.data as { files: Array<{ name: string; url: string; format: string; bytes: number }> }).files;
    expect(files.map((f) => f.format).sort()).toEqual(['docx', 'html']);
    for (const f of files) {
      // The owner's id leads the name — only they can download it.
      expect(f.name).toMatch(/^ai-report-u\d+-weekly-ops-\d+-[a-f0-9]+\.(html|docx)$/);
      expect(f.url).toBe(`/api/ai/reports/${f.name}`);
      expect(fs.existsSync(path.join(ctx.tmpDir, 'uploads', f.name))).toBe(true);
      expect(f.bytes).toBeGreaterThan(100);
    }
  });

  it('rejects empty content', async () => {
    const r = await exec('create_report_document', { title: 'x', content: '   ' }, someUser);
    expect(r.success).toBe(false);
  });
});

describe('reporting: GET /api/ai/reports/:name', () => {
  it('serves a generated report, rejects junk names, 404s missing, 401s without auth', async () => {
    const r = await exec('create_report_document', { title: 'DL Test', content: MD, format: 'html' }, someUser);
    const name = (r.data as { files: Array<{ name: string }> }).files[0]!.name;

    const ok = await ctx.api.get(`/api/ai/reports/${name}`).set(authHdr());
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toContain('dl-test.html');

    expect((await ctx.api.get('/api/ai/reports/..%2Fdata.db').set(authHdr())).status).toBe(400);
    expect((await ctx.api.get('/api/ai/reports/ai-report-nope-1700000000000-abc123.docx').set(authHdr())).status).toBe(404);
    expect((await ctx.api.get(`/api/ai/reports/${name}`)).status).toBe(401);
  });
});
