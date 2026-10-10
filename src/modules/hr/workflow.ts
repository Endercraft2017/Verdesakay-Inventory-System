/** Shared HR workflow guards. Settings are tenant-scoped and synced with the workspace. */
import { notifyUser, type PushPayload } from '../../shared/push';
import { userPermissions } from '../../shared/roles';
import type { Role } from '../../shared/types';
import { queryAll, queryOne, getSetting } from '../../shared/db';

export function approverDepartmentIds(userId: number): number[] {
  const heads = queryAll<{ id: number }>(
    'SELECT id FROM departments WHERE head_user_id = ?',
    userId,
  ).map((r) => r.id);
  const delegates = getSetting<Record<string, number[]>>('hr_department_approvers') ?? {};
  const existing = queryAll<{ id: number }>('SELECT id FROM departments');
  return [
    ...new Set([
      ...heads,
      ...existing
        .filter(
          (d) =>
            delegates[String(d.id)]?.includes(userId) &&
            queryOne(
              'SELECT u.id FROM users u LEFT JOIN employees e ON e.user_id = u.id WHERE u.id = ? AND u.active = 1 AND CASE WHEN e.id IS NOT NULL THEN e.department_id ELSE u.department_id END = ?',
              userId,
              d.id,
            ),
        )
        .map((d) => d.id),
    ]),
  ];
}

/** Any paid payslip freezes the shared attendance cutoff. Legacy slips match its label. */
export function cutoffIsPaid(periodId: number): boolean {
  return !!queryOne(
    `SELECT fr.id FROM form_records fr
    JOIN form_definitions fd ON fd.id = fr.form_def_id
    JOIN attendance_periods p ON p.id = ?
    WHERE fd.slug = 'hr_payroll' AND fr.status = 'paid'
      AND (CASE WHEN json_valid(fr.data) THEN CAST(json_extract(fr.data, '$.cutoff_id') AS INTEGER) END = p.id
        OR (CASE WHEN json_valid(fr.data) THEN json_extract(fr.data, '$.cutoff_id') END IS NULL AND fr.period = p.label)) LIMIT 1`,
    periodId,
  );
}

export function payrollWarnings(period: {
  id: number;
  start_date: string;
  end_date: string;
}): string[] {
  const warnings: string[] = [];
  const roster = queryAll<{ employee_id: number; daily_rate: number }>(
    `SELECT DISTINCT e.id AS employee_id, e.daily_rate FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id WHERE ar.period_id = ?`,
    period.id,
  );
  const unset = roster.filter((e) => e.daily_rate <= 0).length;
  if (unset) warnings.push(`${unset} employee(s) have an unset pay rate.`);
  const missing =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attendance_records WHERE period_id = ? AND work_date <= date('now', 'localtime') AND ((COALESCE(time_in, '') = '') <> (COALESCE(time_out, '') = ''))`,
      period.id,
    )?.n ?? 0;
  if (missing)
    warnings.push(`${missing} attendance day(s) have an incomplete time-in/time-out pair.`);
  const unlogged =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT employee_id FROM attendance_records WHERE period_id = ? GROUP BY employee_id HAVING SUM(CASE WHEN COALESCE(time_in, '') != '' OR COALESCE(time_out, '') != '' THEN 1 ELSE 0 END) = 0)`,
      period.id,
    )?.n ?? 0;
  if (unlogged)
    warnings.push(
      `${unlogged} employee(s) have no punches recorded for this cutoff. Check their schedule and leave.`,
    );
  const fixes =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM time_corrections tc WHERE tc.status = 'pending' AND tc.work_date BETWEEN ? AND ? AND tc.employee_id IN (SELECT employee_id FROM attendance_records WHERE period_id = ?)`,
      period.start_date,
      period.end_date,
      period.id,
    )?.n ?? 0;
  if (fixes)
    warnings.push(`${fixes} attendance correction(s) for this cutoff are pending approval.`);
  const requests =
    queryOne<{ n: number }>(
      `SELECT COUNT(DISTINCT fr.id) AS n FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id JOIN employees e ON e.id = CASE WHEN json_valid(fr.data) THEN CAST(json_extract(fr.data, '$.employee_id') AS INTEGER) END OR (CASE WHEN json_valid(fr.data) THEN json_extract(fr.data, '$.employee_id') END IS NULL AND e.user_id = fr.created_by) WHERE fr.status = 'pending' AND fd.scope = 'hr' AND e.id IN (SELECT employee_id FROM attendance_records WHERE period_id = ?)`,
      period.id,
    )?.n ?? 0;
  if (requests)
    warnings.push(
      `${requests} HR request(s) from roster employees are pending. Check whether they affect this cutoff.`,
    );
  return warnings;
}

export function notifyApprovers(
  departmentId: number | null,
  payload: PushPayload,
  exceptUserId?: number,
): void {
  for (const user of queryAll<{ id: number; role: Role; permission_overrides: string }>(
    'SELECT id, role, permission_overrides FROM users WHERE active = 1',
  )) {
    if (user.id === exceptUserId) continue;
    let overrides = {};
    try {
      overrides = JSON.parse(user.permission_overrides || '{}');
    } catch {
      /* keep role defaults */
    }
    if (
      userPermissions(user.role, overrides).includes('hr.manage') ||
      (departmentId != null && approverDepartmentIds(user.id).includes(departmentId))
    )
      void notifyUser(user.id, payload);
  }
}
