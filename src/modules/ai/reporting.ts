/**
 * Report rendering: a small Markdown subset → HTML and → .docx (Word).
 * Used by the AI agent's `create_report_document` tool. Supports #/##/###
 * headings, paragraphs, - / * bullet lists, 1. numbered lists, | pipe | tables,
 * and inline **bold** / *italic* / `code`.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
} from 'docx';

export type Block =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Parse the Markdown subset into a flat block list. */
export function parseMarkdown(md: string): Block[] {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();

    if (!t) { flush(); continue; }

    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: (['h1', 'h2', 'h3'] as const)[h[1]!.length - 1]!, text: h[2]!.trim() });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      flush();
      const columns = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? '')) { rows.push(splitRow(lines[i] ?? '')); i++; }
      i--;
      blocks.push({ type: 'table', columns, rows });
      continue;
    }

    if (/^[-*]\s+/.test(t)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')); i++; }
      i--;
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')); i++; }
      i--;
      blocks.push({ type: 'ol', items });
      continue;
    }

    para.push(t);
  }
  flush();
  return blocks;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inlineHtml = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');

export function renderHtml(title: string, blocks: Block[]): string {
  const body = blocks.map((b) => {
    switch (b.type) {
      case 'h1': return `<h1>${inlineHtml(b.text)}</h1>`;
      case 'h2': return `<h2>${inlineHtml(b.text)}</h2>`;
      case 'h3': return `<h3>${inlineHtml(b.text)}</h3>`;
      case 'p': return `<p>${inlineHtml(b.text)}</p>`;
      case 'ul': return `<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`;
      case 'ol': return `<ol>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ol>`;
      case 'table':
        return `<table><thead><tr>${b.columns.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a;max-width:820px;margin:32px auto;padding:0 24px}
  h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:22px 0 6px} h3{font-size:15px;margin:16px 0 4px}
  p{margin:8px 0} ul,ol{margin:8px 0 8px 22px}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
  th,td{border:1px solid #ccc;padding:6px 9px;text-align:left} th{background:#f4f4f4}
  code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:12px}
  .rpt-meta{color:#666;font-size:12px;margin-bottom:18px}
  @media print{body{margin:0}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="rpt-meta">Generated ${new Date().toLocaleString()}</div>
${body}
</body></html>`;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

/** Split "a **b** c `d`" into styled TextRuns. */
function inlineRuns(s: string): TextRun[] {
  const out: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(new TextRun(s.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    else if (tok.startsWith('`')) out.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas' }));
    else out.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(new TextRun(s.slice(last)));
  return out.length ? out : [new TextRun(s)];
}

export async function renderDocx(title: string, blocks: Block[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    new Paragraph({ children: [new TextRun({ text: `Generated ${new Date().toLocaleString()}`, italics: true, size: 18, color: '666666' })] }),
  ];

  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
      const level = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }[b.type];
      children.push(new Paragraph({ heading: level, children: inlineRuns(b.text) }));
    } else if (b.type === 'p') {
      for (const line of b.text.split('\n')) children.push(new Paragraph({ children: inlineRuns(line) }));
    } else if (b.type === 'ul' || b.type === 'ol') {
      for (const it of b.items) {
        children.push(new Paragraph(
          b.type === 'ul'
            ? { bullet: { level: 0 }, children: inlineRuns(it) }
            : { numbering: { reference: 'rpt-ol', level: 0 }, children: inlineRuns(it) }
        ));
      }
    } else if (b.type === 'table') {
      const cell = (text: string, header = false) =>
        new TableCell({
          width: { size: Math.floor(100 / Math.max(1, b.columns.length)), type: WidthType.PERCENTAGE },
          children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text, bold: header })] })],
        });
      const rows = [
        new TableRow({ tableHeader: true, children: b.columns.map((c) => cell(c, true)) }),
        ...b.rows.map((r) => new TableRow({
          children: b.columns.map((_, i) => cell(r[i] ?? '')),
        })),
      ];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ text: '' }));
    }
  }

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'rpt-ol',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
