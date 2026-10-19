/** Conservative document conversion. Word receives semantic content, not browser screenshots. */
import { parseDocument, DomUtils } from 'htmlparser2';
import { isTag, type AnyNode, type Element } from 'domhandler';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, InsertedTextRun, DeletedTextRun, FootnoteReferenceRun, TableOfContents, Header, Footer, PageNumber, SectionType, ExternalHyperlink, InternalHyperlink, Bookmark, HeadingLevel, AlignmentType, WidthType, BorderStyle, LevelFormat, HeightRule, VerticalAlign, type IRunOptions, type IParagraphOptions, type ISectionOptions } from 'docx';
/** Messages authored here are safe to show; never expose dependency exceptions. */
export class DocumentInputError extends Error {}
type Mutable<T> = {
    -readonly [K in keyof T]: T[K];
};
const text = (n: AnyNode) => DomUtils.textContent(n);
const children = (n: AnyNode): AnyNode[] => 'children' in n ? n.children : [];
const styles = (n: Element) => Object.fromEntries((n.attribs.style || '').split(';').map(d => d.split(/:(.*)/s)).filter(a => a[0] && a[1]).map(([k, v]) => [k!.trim().toLowerCase(), v!.trim()]));
const color = (value?: string) => {
    if (!value)
        return undefined;
    const hex = /^#([\da-f]{6}|[\da-f]{3})$/i.exec(value);
    if (hex)
        return hex[1]!.length === 3 ? hex[1]!.split('').map(c => c + c).join('') : hex[1];
    const rgb = /^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/i.exec(value);
    return rgb ? rgb.slice(1).map(v => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('') : undefined;
};
const px = (value?: string) => value && /^-?[\d.]+(px|pt)?$/.test(value) ? parseFloat(value) * (value.endsWith('pt') ? 4 / 3 : 1) : undefined;
const safeLink = (v: string) => /^(https?:|mailto:|tel:|#)/i.test(v);
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export { MIME as DOCX_MIME };
export async function exportDocx(input: {
    body: string;
    name: string;
    widthMm: number;
    heightMm: number;
    marginMm: number;
}) {
    const root = parseDocument(input.body), warnings = new Set<string>();
    let nodes = 0, listInstance = 0, changeId = 0;
    const elements = DomUtils.findAll(() => true, root.children);
    const tocPlaceholders = new WeakSet<Paragraph>();
    const noteIds = new Map<string, number>();
    elements.filter(el => el.attribs['data-doc-note-ref']).forEach(el => { const id = el.attribs['data-doc-note-ref']!; if (!noteIds.has(id))
        noteIds.set(id, noteIds.size + 1); });
    let studioConfig: {
        styles?: Record<string, {
            name: string;
            font: string;
            size: number;
            color: string;
            line: number;
            after: number;
        }>;
        trackChanges?: boolean;
    } = {};
    try {
        studioConfig = JSON.parse(elements.find(el => 'data-doc-settings' in el.attribs)?.attribs['data-doc-config'] || '{}');
    }
    catch { }
    const warn = (s: string) => warnings.add(s);
    if (/\{\{\s*[#/]\s*[^}]+\}\}/.test(input.body))
        warn('Repeating and conditional template blocks are not preserved as editable logic in Word. Export HTML for a reusable template, or choose Current preview data for a filled Word document.');
    function runFormat(n: Element, inherited: IRunOptions): Mutable<IRunOptions> {
        const s = styles(n), format: Mutable<IRunOptions> = { ...inherited };
        if (['strong', 'b', 'th'].includes(n.name) || s['font-weight'] === 'bold' || Number(s['font-weight']) >= 600)
            format.bold = true;
        if (s['font-weight'] === 'normal' || /^(?:[1-5]00)$/.test(s['font-weight'] || '')) format.bold = false;
        if (['em', 'i'].includes(n.name) || s['font-style'] === 'italic')
            format.italics = true;
        if (s['font-style'] === 'normal') format.italics = false;
        if (n.name === 'u' || (s['text-decoration-line'] || s['text-decoration'])?.includes('underline'))
            format.underline = {};
        if (['s', 'strike'].includes(n.name) || (n.name === 'del' && !n.attribs['data-doc-change']) || (s['text-decoration-line'] || s['text-decoration'])?.includes('line-through'))
            format.strike = true;
        if (n.name === 'sup' || s['vertical-align'] === 'super') { format.superScript = true; format.subScript = false; }
        if (n.name === 'sub' || s['vertical-align'] === 'sub') { format.subScript = true; format.superScript = false; }
        if (s['vertical-align'] === 'baseline') { format.superScript = false; format.subScript = false; }
        const size = px(s['font-size']);
        if (size)
            format.size = Math.round(size * 1.5);
        const c = color(s.color);
        if (c)
            format.color = c;
        if (s['font-family'])
            format.font = s['font-family'].split(',')[0]!.replace(/['"]/g, '');
        const fill = color(s['background-color'] || s.background);
        if (fill) format.shading = { fill };
        return format;
    }
    function revisionText(list: AnyNode[], inherited: IRunOptions): { text: string; format: IRunOptions }[] {
        const parts: { text: string; format: IRunOptions }[] = [];
        for (const node of list) {
            if (++nodes > 30000) throw new DocumentInputError('Document has too many elements');
            if (node.type === 'text') { parts.push({ text: node.data, format: inherited }); continue; }
            if (!isTag(node) || ['script', 'style'].includes(node.name) || node.attribs['data-doc-hidden'] === 'true') continue;
            const format = runFormat(node, inherited);
            if (node.name === 'br') parts.push({ text: '', format: { ...format, break: 1 } });
            else parts.push(...revisionText(children(node), format));
        }
        return parts;
    }
    function runs(list: AnyNode[], inherited: IRunOptions = {}): (TextRun | ImageRun | InsertedTextRun | DeletedTextRun | FootnoteReferenceRun | ExternalHyperlink | InternalHyperlink | Bookmark)[] {
        const result: (TextRun | ImageRun | InsertedTextRun | DeletedTextRun | FootnoteReferenceRun | ExternalHyperlink | InternalHyperlink | Bookmark)[] = [];
        for (const n of list) {
            if (++nodes > 30000)
                throw new DocumentInputError('Document has too many elements');
            if (n.type === 'text') {
                result.push(new TextRun({ ...inherited, text: n.data }));
                continue;
            }
            if (!isTag(n))
                continue;
            if (n.name === 'style' && !('data-docpage' in n.attribs))
                warn('Custom CSS rules need review in Word; supported inline document formatting was exported.');
            if (['script', 'style'].includes(n.name) || n.attribs['data-doc-hidden'] === 'true' || 'data-doc-settings' in n.attribs || 'data-doc-notes' in n.attribs)
                continue;
            if ('data-doc-settings' in n.attribs || 'data-doc-notes' in n.attribs)
                continue;
            if (n.attribs['data-doc-note-ref']) {
                const id = noteIds.get(n.attribs['data-doc-note-ref']);
                if (id)
                    result.push(new FootnoteReferenceRun(id));
                continue;
            }
            if (['ins', 'del'].includes(n.name) && n.attribs['data-doc-change']) {
                const author = (n.attribs['data-doc-author'] || 'Editor').slice(0, 100), date = /^\d{4}-\d{2}-\d{2}T/.test(n.attribs['data-doc-date'] || '') ? n.attribs['data-doc-date']! : new Date().toISOString();
                for (const part of revisionText(children(n), runFormat(n, inherited))) {
                    const options = { ...part.format, text: part.text, id: ++changeId, author, date };
                    result.push(n.name === 'ins' ? new InsertedTextRun(options) : new DeletedTextRun(options));
                }
                continue;
            }
            const s = styles(n), format = runFormat(n, inherited);
            if (n.name === 'br') {
                result.push(new TextRun({ ...format, break: 1 }));
                continue;
            }
            if (n.name === 'img') {
                const m = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(n.attribs.src || '');
                if (!m) {
                    warn('Linked or unsupported images were omitted. Embed PNG/JPEG/GIF/BMP images to include them in Word.');
                    if (n.attribs.alt)
                        result.push(new TextRun({ ...format, text: '[' + n.attribs.alt + ']' }));
                    continue;
                }
                const data = Buffer.from(m[2]!, 'base64');
                if (data.length > 2 * 1024 * 1024) {
                    warn('An image larger than 2 MB was omitted.');
                    continue;
                }
                const width = Math.min(700, px(s.width) || Number(n.attribs.width) || 300), height = Math.min(1000, px(s.height) || Number(n.attribs.height) || 200);
                result.push(new ImageRun({ data, type: m[1] === 'jpeg' ? 'jpg' : m[1] as 'png' | 'jpg' | 'gif' | 'bmp', transformation: { width: Math.max(1, width), height: Math.max(1, height) }, altText: { name: n.attribs.alt || 'Image', description: n.attribs.alt || '', title: n.attribs.alt || '' } }));
                if (s['object-fit'] || s.filter || s['clip-path'])
                    warn('Image crops, masks and filters need review in Word; original embedded images were exported.');
                continue;
            }
            if (n.name === 'a' && n.attribs.id?.startsWith('doc-heading-')) {
                result.push(new Bookmark({ id: n.attribs.id.replace(/-/g, '_'), children: runs(children(n), format) }));
                continue;
            }
            if (n.name === 'a' && safeLink(n.attribs.href || '')) {
                const linkRuns = runs(children(n), format);
                result.push(n.attribs.href!.startsWith('#') ? new InternalHyperlink({ anchor: n.attribs.href!.slice(1).replace(/-/g, '_'), children: linkRuns }) : new ExternalHyperlink({ link: n.attribs.href!, children: linkRuns }));
                continue;
            }
            result.push(...runs(children(n), format));
        }
        return result;
    }
    function paragraph(n: Element, level?: number, ordered = false, instance = 0, inherited: IRunOptions = {}): Paragraph {
        const s = styles(n), heading = /^h([1-6])$/.exec(n.name);
        const inline = runs([n], inherited);
        const opt: Mutable<IParagraphOptions> = { children: n.attribs.id?.startsWith('doc-heading-') ? [new Bookmark({ id: n.attribs.id.replace(/-/g, '_'), children: inline })] : inline, heading: heading ? HeadingLevel[('HEADING_' + heading[1]) as keyof typeof HeadingLevel] : undefined };
        if (['left', 'center', 'right', 'justify'].includes(s['text-align'] || ''))
            opt.alignment = s['text-align'] === 'justify' ? AlignmentType.JUSTIFIED : s['text-align'] as 'left' | 'center' | 'right';
        const before = px(s['margin-top']), after = px(s['margin-bottom']), left = px(s['margin-left']), first = px(s['text-indent']);
        const line = Number(s['line-height']);
        opt.spacing = { before: before == null ? undefined : Math.round(before * 15), after: after == null ? undefined : Math.round(after * 15), line: line > 0 && line <= 5 ? Math.round(line * 240) : undefined };
        opt.indent = { left: left == null ? undefined : Math.round(left * 15), firstLine: first && first > 0 ? Math.round(first * 15) : undefined, hanging: first && first < 0 ? Math.round(-first * 15) : undefined };
        if (level !== undefined) {
            if (ordered)
                opt.numbering = { reference: 'ordered', level: Math.min(8, level), instance };
            else
                opt.bullet = { level: Math.min(8, level) };
        }
        if (n.attribs['data-doc-style'] && /^[a-zA-Z0-9_-]{1,40}$/.test(n.attribs['data-doc-style']!))
            opt.style = 'Studio_' + n.attribs['data-doc-style'];
        if (s['break-inside'] === 'avoid')
            opt.keepLines = true;
        return new Paragraph(opt);
    }
    function blocks(list: AnyNode[], level = 0, inherited: IRunOptions = {}): (Paragraph | Table)[] {
        const out: (Paragraph | Table)[] = [];
        let inline: AnyNode[] = [];
        const flush = () => {
            if (inline.some(n => text(n).trim() || isTag(n) && n.name === 'img'))
                out.push(new Paragraph({ children: runs(inline, inherited) }));
            inline = [];
        };
        for (const n of list) {
            if (!isTag(n)) {
                if (n.type === 'text')
                    inline.push(n);
                continue;
            }
            if (n.name === 'style' && !('data-docpage' in n.attribs))
                warn('Custom CSS rules need review in Word; supported inline document formatting was exported.');
            if (['script', 'style'].includes(n.name) || n.attribs['data-doc-hidden'] === 'true' || 'data-doc-settings' in n.attribs || 'data-doc-notes' in n.attribs)
                continue;
            if ('data-doc-toc' in n.attribs) {
                flush();
                const placeholder = new Paragraph('');
                tocPlaceholders.add(placeholder);
                out.push(placeholder);
                continue;
            }
            if (n.attribs.class?.includes('doc-pagebreak')) {
                flush();
                out.push(new Paragraph({ children: [new TextRun({ break: 1 })], pageBreakBefore: true }));
                continue;
            }
            if (n.attribs.class?.includes('doc-float'))
                warn('Floating objects are exported in reading order. Positioning, rotation, opacity and design effects need review in Word.');
            if (n.attribs.class?.includes('doc-running-') || n.attribs.class?.includes('doc-page-number'))
                continue;
            if (n.name === 'table') {
                flush();
                // Only direct table-section rows; nested tables are handled inside their cells.
                const directRows = children(n).flatMap(child => isTag(child) && child.name === 'tr' ? [child] : isTag(child) && ['thead', 'tbody', 'tfoot'].includes(child.name) ? children(child).filter((r): r is Element => isTag(r) && r.name === 'tr') : []);
                const ts = styles(n), plain = n.attribs.class?.split(/\s+/).includes('plain'), shaded = n.attribs.class?.split(/\s+/).includes('shaded'), striped = n.attribs.class?.split(/\s+/).includes('striped');
                const tableWidth = ts.width?.endsWith('%') ? Math.max(1, Math.min(100, parseFloat(ts.width))) : 100;
                if (directRows.length) {
                    out.push(new Table({ width: { size: tableWidth, type: WidthType.PERCENTAGE }, borders: plain ? Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(side => [side, { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }])) : undefined, alignment: ts['margin-left'] === 'auto' ? (ts['margin-right'] === 'auto' ? AlignmentType.CENTER : AlignmentType.RIGHT) : AlignmentType.LEFT, rows: directRows.map((row, rowIndex) => new TableRow({ cantSplit: styles(row)['break-inside'] === 'avoid', height: px(styles(row).height) ? { value: Math.round(px(styles(row).height)! * 15), rule: HeightRule.ATLEAST } : undefined, tableHeader: isTag(row.parent as AnyNode) && (row.parent as Element).name === 'thead', children: children(row).filter((c): c is Element => isTag(c) && ['td', 'th'].includes(c.name)).map(cell => {
                                const s = styles(cell);
                                let content = blocks(children(cell), 0, cell.name === 'th' ? { bold: true, color: shaded ? 'FFFFFF' : undefined } : {});
                                if (!content.length)
                                    content = [new Paragraph('')];
                                const span = Math.max(1, Math.min(50, Number(cell.attribs.colspan) || 1)), rowspan = Math.max(1, Math.min(100, Number(cell.attribs.rowspan) || 1));
                                const padding = px(s.padding), border = color(s['border-color']) || color(s.border?.split(/\s+/).at(-1)) || 'D7DEE8';
                                const borderWidth = px(s['border-width']) ?? px(s.border?.split(/\s+/)[0]) ?? .75, borderKind = s['border-style'] || s.border?.split(/\s+/)[1];
                                const fill = color(s['background-color'] || s.background) || (cell.name === 'th' ? (shaded ? '16243D' : 'F4F7FB') : striped && rowIndex % 2 === 0 ? 'F8FAFC' : undefined);
                                return new TableCell({ children: content, columnSpan: span, rowSpan: rowspan, verticalAlign: s['vertical-align'] === 'middle' ? VerticalAlign.CENTER : s['vertical-align'] === 'bottom' ? VerticalAlign.BOTTOM : VerticalAlign.TOP, shading: fill ? { fill } : undefined, margins: padding == null ? undefined : { top: padding * 15, bottom: padding * 15, left: padding * 15, right: padding * 15 }, borders: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, { style: plain || borderKind === 'none' || borderWidth === 0 ? BorderStyle.NONE : borderKind === 'dashed' ? BorderStyle.DASHED : borderKind === 'dotted' ? BorderStyle.DOTTED : BorderStyle.SINGLE, size: Math.max(0, Math.round(borderWidth * 6)), color: border }])) });
                            }) })) }));
                }
                continue;
            }
            if (['ul', 'ol'].includes(n.name)) {
                flush();
                const instance = ++listInstance;
                for (const li of children(n).filter((c): c is Element => isTag(c) && c.name === 'li')) {
                    const rest = children(li).filter(c => !isTag(c) || !['ol', 'ul'].includes(c.name));
                    const pnode = { ...li, children: rest } as Element;
                    out.push(paragraph(pnode, level, n.name === 'ol', instance, inherited));
                    out.push(...blocks(children(li).filter(c => isTag(c) && ['ul', 'ol'].includes(c.name)), level + 1));
                }
                continue;
            }
            if (/^(p|h[1-6]|blockquote|pre)$/.test(n.name)) {
                flush();
                out.push(paragraph(n, undefined, false, 0, inherited));
                const s = styles(n);
                if (s['break-after'] === 'page' || s['page-break-after'] === 'always')
                    out.push(new Paragraph({ pageBreakBefore: true }));
                continue;
            }
            if (['div', 'section', 'article', 'figure', 'figcaption', 'header', 'footer', 'main'].includes(n.name)) {
                flush();
                out.push(...blocks(children(n), level, inherited));
                continue;
            }
            inline.push(n);
        }
        flush();
        return out;
    }
    const mm = (v: number) => Math.round(v * 1440 / 25.4);
    const header = elements.find(el => (el.attribs.class || '').split(/\s+/).includes('doc-running-header'));
    const footer = elements.find(el => (el.attribs.class || '').split(/\s+/).includes('doc-running-footer'));
    const numbered = elements.some(el => (el.attribs.class || '').split(/\s+/).includes('doc-page-number'));
    const sections: ISectionOptions[] = [];
    function addSection(nodes: AnyNode[], section?: Element, converted?: (Paragraph | Table)[]) {
        const content = converted || blocks(nodes);
        if (!content.length)
            content.push(new Paragraph(''));
        const bounded = (value: unknown, lo: number, hi: number, fallback: number) => { const n = Number(value); return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback; };
        const width = bounded(section?.attribs['data-doc-section-width'], 50, 1000, input.widthMm), height = bounded(section?.attribs['data-doc-section-height'], 50, 1000, input.heightMm), margin = bounded(section?.attribs['data-doc-section-margin'], 0, Math.min(width, height) / 2 - 1, input.marginMm);
        const cols = Math.max(1, Math.min(3, Number(section && styles(section)['column-count']) || 1)), gap = parseFloat(section ? styles(section)['column-gap'] || '8' : '8');
        sections.push({ properties: { type: sections.length ? (section?.attribs['data-doc-section-break'] === 'continuous' ? SectionType.CONTINUOUS : SectionType.NEXT_PAGE) : undefined, page: { size: { width: mm(width), height: mm(height) }, margin: { top: mm(margin), bottom: mm(margin), left: mm(margin), right: mm(margin) } }, column: cols > 1 ? { count: cols, space: mm(gap) } : undefined }, headers: header ? { default: new Header({ children: blocks(children(header)) }) } : undefined, footers: footer || numbered ? { default: new Footer({ children: [new Paragraph({ children: [...runs(footer ? children(footer) : []), ...(numbered ? [new TextRun({ children: [' · Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] })] : [])] })] }) } : undefined, children: content.map(child => child instanceof Paragraph && tocPlaceholders.has(child) ? new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-6', beginDirty: true }) : child) });
        if (section?.attribs['data-doc-page-bg'] && section.attribs['data-doc-page-bg'] !== '#ffffff')
            warn('Independent page backgrounds need review in Word. Print/PDF keeps the visual design.');
    }
    const structured = elements.some(el => 'data-doc-section' in el.attribs || 'data-doc-design-page' in el.attribs);
    if (structured) {
        let pending: AnyNode[] = [];
        const flush = () => {const content=blocks(pending);if(content.length)addSection([],undefined,content);pending=[];};
        const visit = (nodes: AnyNode[]) => { for (const n of nodes) {
            if (isTag(n) && ('data-doc-settings' in n.attribs || 'data-doc-notes' in n.attribs))
                continue;
            if (isTag(n) && ('data-doc-section' in n.attribs || 'data-doc-design-page' in n.attribs)) {
                flush();
                addSection(children(n), n);
            }
            else if (isTag(n) && ['div', 'main', 'article'].includes(n.name) && DomUtils.findAll(el => 'data-doc-section' in el.attribs || 'data-doc-design-page' in el.attribs, children(n)).length) {
                flush();
                visit(children(n));
            }
            else
                pending.push(n);
        } };
        visit(root.children);
        flush();
    }
    else
        addSection(root.children);
    if (!sections.length)
        addSection([]);
    const footnotes: Record<string, {
        children: Paragraph[];
    }> = {};
    for (const [key, id] of noteIds) {
        const note = elements.find(el => el.attribs['data-doc-footnote'] === key), body = note && DomUtils.findOne(el => 'data-doc-note-text' in el.attribs, children(note));
        footnotes[id] = { children: [new Paragraph({ children: runs(body ? children(body) : [{ type: 'text', data: note ? text(note) : 'Missing note' } as AnyNode]) })] };
    }
    if (tocPlaceholders && elements.some(el => 'data-doc-toc' in el.attribs))
        warn('Word contents page numbers update when Word refreshes the contents field.');
    const customStyles = Object.entries(studioConfig.styles || {}).filter(([id]) => /^[a-zA-Z0-9_-]{1,40}$/.test(id)).map(([id, s]) => ({ id: 'Studio_' + id, name: s.name, basedOn: 'Normal', next: 'Normal', run: { font: s.font, size: Math.round(s.size * 1.5), color: color(s.color) }, paragraph: { spacing: { line: Math.round(s.line * 240), after: Math.round(s.after * 15) } } }));
    // Built-in named styles also carry their semantic identity even when not customized.
    for (const id of new Set(elements.map(el => el.attribs['data-doc-style']).filter(Boolean))) {
        if (!customStyles.some(s => s.id === 'Studio_' + id))
            customStyles.push({ id: 'Studio_' + id, name: id!, basedOn: 'Normal', next: 'Normal', run: { font: 'Arial', size: 20, color: '111111' }, paragraph: { spacing: { line: 360, after: 180 } } });
    }
    const doc = new Document({ creator: 'Otom Document Studio', title: input.name, features: { trackRevisions: !!studioConfig.trackChanges, updateFields: true }, styles: { paragraphStyles: customStyles }, footnotes, numbering: { config: [{ reference: 'ordered', levels: Array.from({ length: 9 }, (_, level) => ({ level, format: LevelFormat.DECIMAL, text: Array.from({ length: level + 1 }, (_, i) => '%' + (i + 1)).join('.') + '.', alignment: AlignmentType.LEFT, start: 1 })) }] }, sections });
    return { buffer: await Packer.toBuffer(doc), warnings: [...warnings] };
}
export async function importDocx(buffer: Buffer) {
    const zip = await JSZip.loadAsync(buffer);
    let expanded = 0, count = 0;
    for (const file of Object.values(zip.files)) {
        if (file.dir)
            continue;
        if (++count > 2000)
            throw new DocumentInputError('DOCX contains too many files');
        const size = (file as unknown as {
            _data?: {
                uncompressedSize?: number;
            };
        })._data?.uncompressedSize;
        if (size == null || size < 0)
            throw new DocumentInputError('Invalid DOCX archive');
        expanded += size;
        if (expanded > 30 * 1024 * 1024 || size > 15 * 1024 * 1024)
            throw new DocumentInputError('DOCX is too large when expanded');
    }
    if (!zip.file('word/document.xml'))
        throw new DocumentInputError('Choose a valid DOCX document');
    const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false, includeEmbeddedStyleMap: false });
    const root = parseDocument(result.value), allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'i', 'em', 'u', 's', 'sup', 'sub', 'a', 'br', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img', 'blockquote']);
    const anchors = new Map<string, string>();
    DomUtils.findAll(e => !!e.attribs.id, root.children).forEach(e => {
        if (!anchors.has(e.attribs.id!))
            anchors.set(e.attribs.id!, 'doc-heading-import-' + (anchors.size + 1));
    });
    function sanitize(n: AnyNode): string {
        if (n.type === 'text')
            return DomUtils.getOuterHTML(n);
        if (!isTag(n))
            return '';
        if (['script', 'style', 'iframe', 'object'].includes(n.name))
            return '';
        const inner = children(n).map(sanitize).join('');
        if (!allowed.has(n.name))
            return inner;
        const attributes: Record<string, string> = {};
        if (n.attribs.id && anchors.has(n.attribs.id))
            attributes.id = anchors.get(n.attribs.id)!;
        if (n.name === 'a' && safeLink(n.attribs.href || '')) {
            const href = n.attribs.href!;
            attributes.href = href.startsWith('#') && anchors.has(href.slice(1)) ? '#' + anchors.get(href.slice(1)) : href;
        }
        if (n.name === 'img') {
            if (!/^data:image\/(png|jpeg|gif|bmp|webp);base64,/i.test(n.attribs.src || ''))
                return '';
            attributes.src = n.attribs.src!;
            attributes.alt = n.attribs.alt || '';
        }
        for (const k of ['colspan', 'rowspan'])
            if (/^[1-9]\d?$/.test(n.attribs[k] || ''))
                attributes[k] = n.attribs[k]!;
        if (n.name === 'table')
            attributes.class = 'doc-table';
        n.attribs = attributes;
        const open = '<' + n.name + Object.entries(attributes).map(([k, v]) => ' ' + k + '="' + v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"').join('') + '>';
        return open + (['br', 'img'].includes(n.name) ? '' : inner + '</' + n.name + '>');
    }
    const body = root.children.map(sanitize).join('');
    if (body.length > 5000000)
        throw new DocumentInputError('Converted document is too large');
    return { body, warnings: ['DOCX import preserves supported document content. Review fonts, spacing, page layout, drawings, headers and footers against the original. Imported revisions use Word’s proposed text; review history and section/style metadata are not retained.', ...result.messages.map(m => m.message)] };
}
