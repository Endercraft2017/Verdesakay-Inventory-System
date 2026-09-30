/** Employee information-change requests (form slug `information_change`). The employee asks
 *  for a correction to an authoritative HR field; nothing on their record changes until an
 *  hr.manage approver approves it in /api/me/approvals, which applies it atomically and records
 *  it in employee_profile_changes (source 'info_change'). Department heads can't decide these —
 *  they're HR-record changes, not team requests.
 *
 *  Contact details and the preferred name are NOT here: the employee edits those directly
 *  (employee-profile.ts). */
import { queryOne, queryAll, run } from '../../shared/db';
import { CIVIL_STATUSES, birthDateError } from '../../shared/validation';

export const INFO_CHANGE_SLUG = 'information_change';

type InfoColumn = 'name' | 'sss_no' | 'philhealth_no' | 'pagibig_no' | 'tin_no' | 'birth_date' | 'civil_status';

interface InfoField {
  label: string;
  /** employees column written on approval; null = recorded for HR to action by hand. */
  column: InfoColumn | null;
  /** Normalize a requested value, or return an error message. */
  check?: (v: string) => string | { error: string };
}

const digits = (min: number, max: number, what: string) => (v: string) => {
  const d = v.replace(/[\s-]/g, '');
  return /^\d+$/.test(d) && d.length >= min && d.length <= max ? v.trim() : { error: `${what} should be ${min === max ? min : `${min}–${max}`} digits` };
};

/** Option label (what the employee picks) → how it's handled. */
export const INFO_CHANGE_FIELDS: Record<string, InfoField> = {
  'Legal name': {
    label: 'Legal name', column: 'name',
    check: (v) => (/^[\p{L}][\p{L} .,'-]{1,159}$/u.test(v.trim()) ? v.trim().replace(/\s+/g, ' ') : { error: 'Enter the full legal name as it appears on your ID' }),
  },
  'SSS number': { label: 'SSS number', column: 'sss_no', check: digits(10, 10, 'SSS number') },
  'PhilHealth number': { label: 'PhilHealth number', column: 'philhealth_no', check: digits(12, 12, 'PhilHealth number') },
  'Pag-IBIG number': { label: 'Pag-IBIG number', column: 'pagibig_no', check: digits(12, 12, 'Pag-IBIG number') },
  'TIN': { label: 'TIN', column: 'tin_no', check: digits(9, 12, 'TIN') },
  'Birth date': {
    label: 'Birth date', column: 'birth_date',
    check: (v) => { const err = birthDateError(v.trim()); return err ? { error: err } : v.trim(); },
  },
  'Civil status': {
    label: 'Civil status', column: 'civil_status',
    // Case-insensitive, stored as the canonical label.
    check: (v) => CIVIL_STATUSES.find((s) => s.toLowerCase() === v.trim().replace(/\s+/g, ' ').toLowerCase())
      ?? { error: `Civil status must be one of: ${CIVIL_STATUSES.join(', ')}` },
  },
  'Other official record': { label: 'Other official record', column: null },
};

type Emp = { id: number; name: string } & Record<Exclude<InfoColumn, 'name'>, string | null>;

/** Validate + normalize a self-filed request. The server, not the client, decides who it's for
 *  and what the current value is. Throws a 400-shaped error on bad input. */
export function prepareInfoChange(userId: number, data: Record<string, unknown>): Record<string, string | number | null> {
  const fail = (msg: string, status = 400) => { throw Object.assign(new Error(msg), { status }); };
  const emp = queryOne<Emp>(
    'SELECT id, name, sss_no, philhealth_no, pagibig_no, tin_no, birth_date, civil_status FROM employees WHERE user_id = ?', userId
  );
  if (!emp) fail('Your account is not linked to an employee record. Ask HR to link it.', 403);
  const e = emp!;
  const fieldName = String(data.field ?? '');
  const spec = INFO_CHANGE_FIELDS[fieldName];
  if (!spec) fail(`Choose what to change: ${Object.keys(INFO_CHANGE_FIELDS).join(', ')}`);
  const raw = String(data.requested_value ?? '').trim();
  if (!raw) fail('Enter the correct value');
  if (raw.length > 500) fail('The correct value is too long');
  const reason = String(data.reason ?? '').trim();
  if (reason.length < 5) fail('Explain the reason (and which document shows it)');
  const checked = spec!.check ? spec!.check(raw) : raw;
  if (typeof checked !== 'string') fail(checked.error);
  const current = spec!.column ? (e[spec!.column] ?? null) : null;
  if (spec!.column && current === checked) fail('That is already the value on your record');
  return {
    employee_name: e.name, employee_id: e.id, field: fieldName,
    requested_value: checked as string, current_value: current, reason: reason.slice(0, 2000),
  };
}

/** Apply an approved request to the employee record. Call inside the approval transaction.
 *  Returns what happened so the approver sees whether HR still needs to act by hand. */
export function applyInfoChange(data: Record<string, unknown>, deciderId: number):
  { applied: boolean; column: string | null; previous: string | null; note?: string } {
  const spec = INFO_CHANGE_FIELDS[String(data.field ?? '')];
  const employeeId = Number(data.employee_id);
  if (!spec || !employeeId) return { applied: false, column: null, previous: null, note: 'Unrecognized request — update the record by hand.' };
  if (!spec.column) {
    return { applied: false, column: null, previous: null, note: `${spec.label} isn't stored on the employee record — update it by hand.` };
  }
  const emp = queryOne<Record<string, string | null>>(`SELECT ${spec.column} AS v FROM employees WHERE id = ?`, employeeId);
  if (!emp) throw Object.assign(new Error('The employee record no longer exists'), { status: 409 });
  const previous = emp.v ?? null;
  const next = String(data.requested_value);
  if (spec.column === 'name') {
    const dup = queryOne('SELECT id FROM employees WHERE name = ? AND id != ?', next, employeeId);
    if (dup) throw Object.assign(new Error('Another employee already has that name — resolve it in HR before approving'), { status: 409 });
  }
  run(`UPDATE employees SET ${spec.column} = ? WHERE id = ?`, next, employeeId);
  run(
    `INSERT INTO employee_profile_changes (employee_id, field, old_value, new_value, changed_by, source)
     VALUES (?, ?, ?, ?, ?, 'info_change')`,
    employeeId, spec.column, previous, next, deciderId
  );
  return { applied: true, column: spec.column, previous };
}

/** Every former legal name — from approved information changes or HR edits (payslips carry
 *  the name as it was when generated, so a renamed employee still sees older payslips). */
export function previousNames(employeeId: number): string[] {
  return queryAll<{ old_value: string }>(
    `SELECT DISTINCT old_value FROM employee_profile_changes
     WHERE employee_id = ? AND field = 'name' AND old_value IS NOT NULL`,
    employeeId
  ).map((r) => r.old_value);
}
