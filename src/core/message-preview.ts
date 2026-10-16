/** Read-only, bounded text previews for chat attachments. Never return document HTML. */
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { parseDocument, DomUtils } from 'htmlparser2';
import { isTag, type AnyNode } from 'domhandler';

const MAX_PREVIEW_CHARS = 20_000;
const MAX_EXPANDED_BYTES = 30 * 1024 * 1024;

function nodes(node: AnyNode, name: string): AnyNode[] {
  return DomUtils.findAll((item) => isTag(item) && item.name === name, [node]);
}

export async function previewMessageFile(name: string, input: Buffer): Promise<string | null> {
  const ext = name.toLowerCase().split('.').pop();
  if (['txt', 'log', 'md', 'csv', 'tsv', 'json'].includes(ext || '')) {
    return input.toString('utf8').slice(0, MAX_PREVIEW_CHARS);
  }
  if (ext !== 'docx' && ext !== 'xlsx') return null;
  const zip = await JSZip.loadAsync(input);
  let expanded = 0;
  let files = 0;
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue;
    if (++files > 2000) throw Error('Document has too many files to preview');
    const size = (item as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (size == null || size < 0 || size > 15 * 1024 * 1024 || (expanded += size) > MAX_EXPANDED_BYTES) {
      throw Error('Document is too large to preview');
    }
  }
  if (ext === 'docx') {
    if (!zip.file('word/document.xml')) throw Error('Invalid Word document');
    // Mammoth extracts words only. No HTML or links from an attachment reach the app.
    const result = await mammoth.extractRawText({ buffer: input });
    return result.value.slice(0, MAX_PREVIEW_CHARS);
  }
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) throw Error('Spreadsheet has no readable first sheet');
  const sharedXml = zip.file('xl/sharedStrings.xml');
  const shared = sharedXml ? nodes(parseDocument(await sharedXml.async('string'), { xmlMode: true }), 'si')
    .map((si) => DomUtils.textContent(si)) : [];
  const sheetXml = parseDocument(await sheet.async('string'), { xmlMode: true });
  const rows = nodes(sheetXml, 'row').slice(0, 40).map((row) => nodes(row, 'c').slice(0, 16).map((cell) => {
    const value = nodes(cell, 'v')[0];
    const raw = value ? DomUtils.textContent(value) : DomUtils.textContent(nodes(cell, 'is')[0] || cell);
    return (isTag(cell) && cell.attribs.t === 's' ? shared[Number(raw)] || '' : raw).slice(0, 240);
  }).join('\t'));
  return rows.join('\n').slice(0, MAX_PREVIEW_CHARS);
}
