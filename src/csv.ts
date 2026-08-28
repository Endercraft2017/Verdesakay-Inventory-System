/**
 * Shared CSV helpers — dependency-free, RFC4180-ish. Used by the payroll "Summary"
 * import (src/hr-payroll-import.ts) and the generic data import/export endpoints
 * (e.g. GET/POST /api/inventory/import|export).
 */

/** Parse CSV text into a grid of string cells. Handles quoted fields, "" escapes,
    embedded commas/newlines, and CRLF. Trailing blank line is ignored. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // skip — handled with the following \n
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface CsvTable {
  /** Header labels exactly as they appeared (trimmed). */
  headers: string[];
  /** One object per data row, keyed by the lower-cased, trimmed header label.
      Values are trimmed strings; missing trailing cells become ''. */
  rows: Record<string, string>[];
}

/** Parse CSV text whose first non-empty line is a header row. Blank lines are skipped. */
export function parseCsvTable(text: string): CsvTable {
  const grid = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length === 0) return { headers: [], rows: [] };
  const headers = grid[0]!.map((h) => h.trim());
  const keys = headers.map((h) => h.toLowerCase());
  const rows = grid.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    keys.forEach((k, i) => { obj[k] = (r[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

/** Serialize rows to CSV text (CRLF line endings, always-quote is avoided — a cell
    is quoted only if it contains a comma, quote, or newline). */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}
