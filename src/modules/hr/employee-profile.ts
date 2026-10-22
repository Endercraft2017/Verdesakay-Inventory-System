/** Employee self-service profile — preferred name + personal contact details, kept apart from
 *  the HR-owned `employees` row. The employee edits these directly (re-authenticated with their
 *  password by the caller); HR marks contact details verified. Authoritative fields (legal
 *  name, gov IDs, position, department, pay) are NOT here — they change only through an
 *  approved information-change request (info-change.ts). */
import { queryOne, queryAll, run, db } from '../../shared/db';

export const PROFILE_FIELDS = [
  'preferred_name', 'mobile_phone', 'personal_email', 'home_address',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_phone',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
/** Changing any of these clears HR verification; the preferred name doesn't. */
const CONTACT_FIELDS: ProfileField[] = PROFILE_FIELDS.filter((f) => f !== 'preferred_name');

export type ProfileValues = Record<ProfileField, string | null>;

export interface EmployeeProfile extends ProfileValues {
  employee_id: number;
  updated_at: string | null;
  verified_at: string | null;
  verified_by_name: string | null;
  /** True when there are contact details HR hasn't verified since they last changed. */
  needs_verification: boolean;
}

export function getProfile(employeeId: number): EmployeeProfile {
  const row = queryOne<ProfileValues & { updated_at: string | null; verified_at: string | null; verified_by_name: string | null }>(
    `SELECT p.*, u.full_name AS verified_by_name FROM employee_profiles p
     LEFT JOIN users u ON u.id = p.verified_by WHERE p.employee_id = ?`,
    employeeId
  );
  const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, row?.[f] ?? null])) as ProfileValues;
  const hasContact = CONTACT_FIELDS.some((f) => values[f]);
  return {
    employee_id: employeeId, ...values,
    updated_at: row?.updated_at ?? null,
    verified_at: row?.verified_at ?? null,
    verified_by_name: row?.verified_by_name ?? null,
    needs_verification: hasContact && !row?.verified_at,
  };
}

/** Apply a partial update (keys absent from `input` stay as they are). Returns what changed. */
export function updateProfile(
  employeeId: number, userId: number, input: Partial<ProfileValues>, source: 'self' = 'self'
): { changed: ProfileField[]; verification_cleared: boolean } {
  const before = getProfile(employeeId);
  const changed = PROFILE_FIELDS.filter((f) => f in input && (input[f] ?? null) !== before[f]);
  if (!changed.length) return { changed, verification_cleared: false };
  const clears = changed.some((f) => CONTACT_FIELDS.includes(f)) && !!before.verified_at;

  db.exec('BEGIN');
  try {
    run('INSERT OR IGNORE INTO employee_profiles (employee_id) VALUES (?)', employeeId);
    const sets = changed.map((f) => `${f} = ?`).join(', ');
    run(
      `UPDATE employee_profiles SET ${sets}, updated_at = datetime('now'), updated_by = ?
       ${changed.some((f) => CONTACT_FIELDS.includes(f)) ? ', verified_at = NULL, verified_by = NULL' : ''}
       WHERE employee_id = ?`,
      ...changed.map((f) => input[f] ?? null), userId, employeeId
    );
    for (const f of changed) {
      run(
        'INSERT INTO employee_profile_changes (employee_id, field, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?, ?)',
        employeeId, f, before[f], input[f] ?? null, userId, source
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { changed, verification_cleared: clears };
}

/** HR confirms the current contact details (e.g. called the number). */
export function verifyProfile(employeeId: number, hrUserId: number): EmployeeProfile | null {
  const p = getProfile(employeeId);
  if (!CONTACT_FIELDS.some((f) => p[f])) return null;
  run('INSERT OR IGNORE INTO employee_profiles (employee_id) VALUES (?)', employeeId);
  run("UPDATE employee_profiles SET verified_at = datetime('now'), verified_by = ? WHERE employee_id = ?", hrUserId, employeeId);
  run(
    "INSERT INTO employee_profile_changes (employee_id, field, old_value, new_value, changed_by, source) VALUES (?, 'verified', NULL, NULL, ?, 'hr_verify')",
    employeeId, hrUserId
  );
  return getProfile(employeeId);
}

export function profileHistory(employeeId: number, limit = 50) {
  return queryAll<{ id: number; field: string; old_value: string | null; new_value: string | null; source: string; created_at: string; changed_by_name: string | null }>(
    `SELECT c.id, c.field, c.old_value, c.new_value, c.source, c.created_at, u.full_name AS changed_by_name
     FROM employee_profile_changes c LEFT JOIN users u ON u.id = c.changed_by
     WHERE c.employee_id = ? ORDER BY c.id DESC LIMIT ?`,
    employeeId, limit
  );
}

/** HR worklist: employees whose contact details changed since HR last verified them. */
export function unverifiedProfiles() {
  return queryAll<{ employee_id: number; name: string; employee_no: string | null; updated_at: string | null }>(
    `SELECT p.employee_id, e.name, e.employee_no, p.updated_at
     FROM employee_profiles p JOIN employees e ON e.id = p.employee_id
     WHERE p.verified_at IS NULL
       AND COALESCE(p.mobile_phone, p.personal_email, p.home_address, p.emergency_contact_name,
                    p.emergency_contact_relation, p.emergency_contact_phone) IS NOT NULL
     ORDER BY p.updated_at DESC`
  );
}
