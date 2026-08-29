/**
 * DB access for the versioned PH statutory rate tables (`payroll_tables`).
 * The math lives in src/ph-statutory.ts; this just resolves which version applies
 * for a given pay date and exposes list/add for the admin screen.
 */
import { queryAll, queryOne, run } from './db';
import {
  SSS_2026, PHILHEALTH_2026, PAGIBIG_2026, RWT_2026,
  type StatutoryTables, type SssParams, type PhilHealthParams, type PagIbigParams, type RwtParams,
} from './ph-statutory';

export type PayrollTableKind = 'sss' | 'philhealth' | 'pagibig' | 'rwt';
export const PAYROLL_TABLE_KINDS: PayrollTableKind[] = ['sss', 'philhealth', 'pagibig', 'rwt'];

export interface PayrollTableRow {
  id: number;
  kind: PayrollTableKind;
  effective_from: string; // YYYY-MM-DD
  data: unknown;
  note: string | null;
  created_by: number | null;
  created_at: string;
}

const FALLBACK: Record<PayrollTableKind, unknown> = {
  sss: SSS_2026, philhealth: PHILHEALTH_2026, pagibig: PAGIBIG_2026, rwt: RWT_2026,
};

interface RawRow { id: number; kind: PayrollTableKind; effective_from: string; data: string; note: string | null; created_by: number | null; created_at: string; }

function parse(r: RawRow): PayrollTableRow {
  let data: unknown = {};
  try { data = JSON.parse(r.data); } catch { /* leave {} */ }
  return { ...r, data };
}

/** Every stored version, newest effective date first. */
export function listPayrollTables(): PayrollTableRow[] {
  return queryAll<RawRow>(
    `SELECT * FROM payroll_tables ORDER BY kind, effective_from DESC`
  ).map(parse);
}

/** The row of `kind` in force on `onDate` (YYYY-MM-DD, default today): the latest whose
    effective_from is on or before that date. Null if none — caller falls back to the seed. */
export function effectiveRow(kind: PayrollTableKind, onDate?: string): PayrollTableRow | null {
  const date = onDate || new Date().toISOString().slice(0, 10);
  const r = queryOne<RawRow>(
    `SELECT * FROM payroll_tables
      WHERE kind = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`,
    kind, date
  );
  return r ? parse(r) : null;
}

/** The full resolved table set for a pay date, each kind falling back to the built-in
    2026 seed if nothing is stored. */
export function effectiveTables(onDate?: string): StatutoryTables {
  const pick = <T>(kind: PayrollTableKind): T =>
    (effectiveRow(kind, onDate)?.data ?? FALLBACK[kind]) as T;
  return {
    sss: pick<SssParams>('sss'),
    philhealth: pick<PhilHealthParams>('philhealth'),
    pagibig: pick<PagIbigParams>('pagibig'),
    rwt: pick<RwtParams>('rwt'),
  };
}

/** Insert (or replace, same kind+date) a rate-table version. */
export function upsertPayrollTable(
  kind: PayrollTableKind, effectiveFrom: string, data: unknown, note: string | null, userId: number | null
): void {
  run(
    `INSERT INTO payroll_tables (kind, effective_from, data, note, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, effective_from) DO UPDATE SET
       data = excluded.data, note = excluded.note, created_by = excluded.created_by, created_at = datetime('now')`,
    kind, effectiveFrom, JSON.stringify(data), note, userId
  );
}

export function deletePayrollTable(id: number): boolean {
  return run('DELETE FROM payroll_tables WHERE id = ?', id).changes > 0;
}
