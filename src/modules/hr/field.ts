/**
 * Field-work log -- a separate out/in log from the payroll time clock (src/clock.ts).
 * Some companies use this as their basis for staff being away on field work (deliveries,
 * site visits, errands). It's deliberately its own table (field_punches): a plain kind
 * toggle with no lunch/segment classification, and it never touches time_punches or
 * attendance_records, so a mid-day field trip can't skew payroll hours.
 */
import { queryOne, queryAll, run } from '../../shared/db';

export interface FieldPunchRow {
  id: number;
  employee_id: number;
  ts: string;
  work_date: string;
  kind: string; // 'out' | 'in'
  source: string; // 'kiosk'
}

function localDate(): string {
  const d = new Date(); // the server runs on-site, so this is office-local time
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface FieldPunchResult {
  ok: true;
  duplicate?: boolean;
  id: number;
  employee_id: number;
  employee_name: string;
  kind: 'out' | 'in';
  at: string; // "HH:MM"
  work_date: string;
  source: 'kiosk';
}

/** Record a field trip out/in for an employee -- alternates out/in per day, starting with
 *  'out'. De-dupes a repeat within 45s, same guard as the time clock's recordPunch. */
export function recordFieldPunch(
  employee: { id: number; name: string },
  source: 'kiosk'
): FieldPunchResult {
  const date = localDate();
  const prior = queryAll<FieldPunchRow>(
    'SELECT * FROM field_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
    employee.id,
    date
  );

  const last = prior[prior.length - 1];
  if (last) {
    const gap = Date.now() - new Date(last.ts.replace(' ', 'T')).getTime();
    if (gap >= 0 && gap < 45_000) {
      return {
        ok: true, duplicate: true, id: last.id, employee_id: employee.id, employee_name: employee.name,
        kind: last.kind as 'out' | 'in', at: last.ts.slice(11, 16), work_date: date, source,
      };
    }
  }

  const kind: 'out' | 'in' = last && last.kind === 'out' ? 'in' : 'out';
  const info = run(
    `INSERT INTO field_punches (employee_id, work_date, kind, source) VALUES (?, ?, ?, ?)`,
    employee.id, date, kind, source
  );
  const row = queryOne<FieldPunchRow>('SELECT * FROM field_punches WHERE id = ?', Number(info.lastInsertRowid))!;
  return {
    ok: true, id: row.id, employee_id: employee.id, employee_name: employee.name,
    kind, at: row.ts.slice(11, 16), work_date: date, source,
  };
}
