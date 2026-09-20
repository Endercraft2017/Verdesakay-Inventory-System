/**
 * Shared machinery for the "upload a CSV to create/update rows" endpoints
 * (inventory items, suppliers, employees, …). Parsing lives in src/csv.ts; this
 * adds header resolution (with friendly aliases), the per-row transaction loop
 * with error collection, and the standard result shape.
 */
import { db } from './db';
import { parseCsvTable } from './csv';

export interface ImportField {
  /** Canonical key (lower-case) callers use to read the cell. */
  key: string;
  /** Extra header spellings that map to this key (lower-cased on compare). */
  aliases?: string[];
  required?: boolean;
}

export interface ImportRowError {
  row: number;
  key: string;
  message: string;
}

export interface ImportReport {
  dry_run: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}

/** What a row handler returns: an outcome, or an error that skips the row.
    `key` is the row's identifying value (name / employee_no / …) for the report. */
export type RowOutcome = 'created' | 'updated' | { error: string; key?: string };

export interface ResolvedImport {
  /** Read a cell for the given canonical key from a raw parsed row (trimmed). */
  get: (row: Record<string, string>, key: string) => string;
  rows: Record<string, string>[];
}

/** Validate that every required field's column (or an alias) is present. Throws an
    Error (400-friendly message) if not; otherwise returns a `get()` accessor. */
export function resolveImport(csv: string, fields: ImportField[]): ResolvedImport {
  const table = parseCsvTable(csv);
  if (table.headers.length === 0) throw new Error('The CSV is empty.');

  const canonOf = new Map<string, string>(); // header(lower) -> canonical key
  for (const f of fields) {
    canonOf.set(f.key.toLowerCase(), f.key);
    for (const a of f.aliases ?? []) canonOf.set(a.toLowerCase(), f.key);
  }
  const present = new Set<string>();
  for (const h of table.headers) {
    const c = canonOf.get(h.trim().toLowerCase());
    if (c) present.add(c);
  }
  const missing = fields.filter((f) => f.required && !present.has(f.key));
  if (missing.length) {
    throw new Error(`The CSV must have ${missing.length === 1 ? 'a' : ''} "${missing.map((f) => f.key).join('", "')}" column${missing.length > 1 ? 's' : ''}.`);
  }

  const get = (row: Record<string, string>, key: string): string => {
    for (const [h, v] of Object.entries(row)) {
      if (canonOf.get(h.toLowerCase()) === key) return (v ?? '').trim();
    }
    return '';
  };
  return { get, rows: table.rows };
}

/** Run `handle` over every row inside one transaction, collecting per-row errors
    (a bad row is skipped, never aborts the batch). `dry_run` rolls back at the end. */
export function importLoop(
  rows: Record<string, string>[],
  dryRun: boolean,
  handle: (row: Record<string, string>, rowNo: number) => RowOutcome
): ImportReport {
  const errors: ImportRowError[] = [];
  let created = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    rows.forEach((row, idx) => {
      const rowNo = idx + 1; // 1-based data row (header is row 0)
      try {
        const outcome = handle(row, rowNo);
        if (outcome === 'created') created++;
        else if (outcome === 'updated') updated++;
        else errors.push({ row: rowNo, key: outcome.key ?? '', message: outcome.error });
      } catch (e) {
        errors.push({ row: rowNo, key: '', message: e instanceof Error ? e.message : 'Row failed' });
      }
    });
    if (dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    dry_run: dryRun,
    total: rows.length,
    created,
    updated,
    skipped: errors.length,
    errors: errors.slice(0, 200),
  };
}
