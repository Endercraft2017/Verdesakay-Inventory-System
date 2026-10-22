import { parseDocument, DomUtils } from 'htmlparser2';

/** Explicit design pages and forced document boundaries cannot be packed into grid cells. */
export function isMultiPageDocument(body: string): boolean {
  const root = parseDocument(body);
  const elements = DomUtils.findAll(() => true, root.children);
  if (elements.filter(el => 'data-doc-design-page' in el.attribs).length > 1) return true;
  return elements.some(el => el.attribs['data-doc-section-break'] === 'page' || (el.attribs.class || '').split(/\s+/).includes('doc-pagebreak') || /(?:^|;)\s*(?:break-after|break-before)\s*:\s*page\b|(?:^|;)\s*page-break-(?:after|before)\s*:\s*always\b/i.test(el.attribs.style || ''));
}
export const MULTIPAGE_GRID_ERROR = 'Multipage documents cannot use print grids. Set grid rows and columns to 1 and turn Continuous off.';
