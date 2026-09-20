/**
 * AI reporting tool — `create_report_document`. The agent gathers data with the
 * analytics tools, writes the report in Markdown, then calls this to get a
 * downloadable HTML and/or Word (.docx) file. Files land in UPLOAD_DIR and are
 * served (auth-checked) by GET /api/ai/reports/:name.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from '../../shared/db';
import { parseMarkdown, renderHtml, renderDocx } from './reporting';
import type { CerebrasTool, ToolResult } from './ai-tools';
import type { AuthUser } from '../../shared/types';

const SPEC: CerebrasTool = {
  type: 'function',
  function: {
    name: 'create_report_document',
    description:
      'Turn a report you have written into a downloadable HTML and/or Word (.docx) file. Write the body in Markdown: #/##/### headings, blank-line paragraphs, "- " bullet lists, "1." numbered lists, "| a | b |" tables, **bold**, *italic*. Gather all figures with other tools FIRST, then pass the whole finished report here.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Report title.' },
        content: { type: 'string', description: 'The full report body as Markdown.' },
        format: { type: 'string', enum: ['html', 'docx', 'both'], description: 'Default: both.' },
      },
      required: ['title', 'content'],
    },
  },
};

export function reportingToolsForUser(_user: AuthUser): CerebrasTool[] {
  return [SPEC]; // any authenticated user — the data itself came from permission-gated tools
}

export function isReportingTool(name: string): boolean {
  return name === 'create_report_document';
}

/** Only files this tool creates may be served back. */
export const REPORT_FILE_RE = /^ai-report-[A-Za-z0-9-]+\.(html|docx)$/;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'report';

export async function executeReportingTool(name: string, args: unknown, _user: AuthUser): Promise<ToolResult> {
  if (name !== 'create_report_document') return { success: false, error: `Unknown tool: ${name}` };
  const a = (args ?? {}) as Record<string, unknown>;
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 160) : 'Report';
  const content = typeof a.content === 'string' ? a.content : '';
  if (!content.trim()) return { success: false, error: 'No report content provided.' };
  const fmt = a.format === 'html' || a.format === 'docx' ? a.format : 'both';

  const blocks = parseMarkdown(content);
  const stamp = `${slug(title)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const files: Array<{ name: string; url: string; format: string; bytes: number }> = [];

  try {
    if (fmt === 'html' || fmt === 'both') {
      const fn = `ai-report-${stamp}.html`;
      const buf = Buffer.from(renderHtml(title, blocks), 'utf8');
      await fs.promises.writeFile(path.join(uploadDir(), fn), buf);
      files.push({ name: fn, url: `/api/ai/reports/${fn}`, format: 'html', bytes: buf.length });
    }
    if (fmt === 'docx' || fmt === 'both') {
      const fn = `ai-report-${stamp}.docx`;
      const buf = await renderDocx(title, blocks);
      await fs.promises.writeFile(path.join(uploadDir(), fn), buf);
      files.push({ name: fn, url: `/api/ai/reports/${fn}`, format: 'docx', bytes: buf.length });
    }
  } catch (e) {
    return { success: false, error: `Failed to render the document: ${e instanceof Error ? e.message : String(e)}` };
  }

  return { success: true, data: { title, files, note: 'Give the user the download link(s).' } };
}
