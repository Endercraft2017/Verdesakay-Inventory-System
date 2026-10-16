/**
 * Minimal, dependency-free PDF writer for simple text documents (payslips, slips).
 * A4 portrait, the two built-in Helvetica faces, left/right-aligned text and horizontal
 * rules, automatic page breaks. Text is encoded as WinAnsi (Latin-1 subset); characters
 * outside it are replaced with '?', so callers should write "PHP" rather than "₱".
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;

type Font = 'regular' | 'bold';

/** Helvetica / Helvetica-Bold advance widths (per 1000 em) for ASCII 32–126, from the standard
 *  Adobe AFM metrics, so right-aligned amounts line up exactly. Other characters use 556. */
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function textWidth(s: string, size: number, font: Font): number {
  const table = font === 'bold' ? W_BOLD : W_REGULAR;
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 32 && c <= 126 ? table[c - 32]! : 556;
  }
  return (w / 1000) * size;
}

function escapeText(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    const c = code <= 0xff ? ch : '?';
    if (c === '\\' || c === '(' || c === ')') out += '\\' + c;
    else if (code < 32) out += ' ';
    else out += c;
  }
  return out;
}

export class PdfDoc {
  private pages: string[][] = [[]];
  private y = PAGE_H - MARGIN;
  readonly width = PAGE_W - MARGIN * 2;
  readonly left = MARGIN;

  private get ops(): string[] { return this.pages[this.pages.length - 1]!; }

  /** Start a new page if fewer than `h` points remain. */
  ensure(h: number): void {
    if (this.y - h < MARGIN) { this.pages.push([]); this.y = PAGE_H - MARGIN; }
  }

  private put(x: number, y: number, s: string, size: number, font: Font): void {
    this.ops.push(`BT /${font === 'bold' ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapeText(s)}) Tj ET`);
  }

  /** One line of text; `right` (optional) is right-aligned on the same baseline. */
  line(text: string, opts: { size?: number; bold?: boolean; right?: string; rightBold?: boolean; indent?: number; gap?: number } = {}): void {
    const size = opts.size ?? 10;
    const lh = size * 1.45;
    this.ensure(lh);
    this.y -= lh;
    this.put(this.left + (opts.indent ?? 0), this.y, text, size, opts.bold ? 'bold' : 'regular');
    if (opts.right != null) {
      const f: Font = opts.rightBold ?? opts.bold ? 'bold' : 'regular';
      this.put(this.left + this.width - textWidth(opts.right, size, f), this.y, opts.right, size, f);
    }
    if (opts.gap) this.y -= opts.gap;
  }

  rule(gap = 6): void {
    this.ensure(gap * 2);
    this.y -= gap;
    this.ops.push(`0.6 w 0.75 G ${this.left} ${this.y.toFixed(2)} m ${(this.left + this.width).toFixed(2)} ${this.y.toFixed(2)} l S`);
    this.y -= gap;
  }

  space(h: number): void { this.ensure(h); this.y -= h; }

  /** Serialize to a PDF 1.4 file. */
  toBuffer(meta: { title?: string } = {}): Buffer {
    const objs: string[] = [];
    const add = (body: string): number => { objs.push(body); return objs.length; };
    const catalog = add('');           // 1 — patched below
    const pagesId = add('');           // 2 — patched below
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      kids.push(add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`
      ));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${escapeText(meta.title ?? 'Document')}) /Producer (Otom) >>`);

    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
