/** Shared request validation and date eligibility for filing, linking and payroll. */
import { queryAll, queryOne, run, getSetting } from '../../shared/db';
import { ValidationError } from '../../shared/validation';
import { cutoffIsPaid } from './workflow';
import { restDaySwapsFor } from './rest-day';
import type { FieldDef } from '../../shared/types';
import { noWorkFormIds } from '../../core/form-actions';

export const ATTENDANCE_REQUESTS = ['leave_request', 'overtime_request', 'undertime_request',
  'halfday_request', 'offset_form', 'lunch_offset_form', 'holiday_work_request',
  'rest_day_work_request', 'rest_day_change', 'reported_absence', 'schedule_change'];
const internal = ['employee_id', 'approved_by', 'decided_by', 'decided_at', 'decision_note',
  'leave_days_charged', 'charged_dates', 'leave_warnings', 'current_shift_id'];

/** Stable IDs take precedence; legacy names must identify exactly one employee. */
export const requestEmployeeJoin = `e.id = CASE WHEN json_valid(fr.data) THEN
  COALESCE(CAST(json_extract(fr.data, '$.employee_id') AS INTEGER),
    CASE WHEN json_extract(fr.data, '$.employee_name') IS NOT NULL THEN
      (SELECT MIN(legacy.id) FROM employees legacy WHERE legacy.name = json_extract(fr.data, '$.employee_name') HAVING COUNT(*) = 1)
    ELSE (SELECT fallback.id FROM employees fallback WHERE fallback.user_id = fr.created_by) END) END`;

export function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function leaveDates(data: Record<string, unknown>): string[] {
  if (String(data.leave_dates || '').trim()) {
    const dates = [...new Set(String(data.leave_dates).split(/[\s,;]+/).filter(Boolean))].sort();
    if (dates.length > 366 || dates.some(d => !realDate(d))) throw new ValidationError('Selected leave dates must be real YYYY-MM-DD dates (maximum 366).');
    return dates;
  }
  if (!realDate(data.date_from) || !realDate(data.date_to) || data.date_to < data.date_from) {
    throw new ValidationError('Enter valid inclusive leave dates, with the end on or after the start.');
  }
  const result: string[] = [], cur = new Date(data.date_from + 'T00:00:00Z');
  while (cur.toISOString().slice(0, 10) <= data.date_to) {
    if (result.length === 366) throw new ValidationError('Select no more than 366 leave dates.');
    result.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

function safeData(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** All selected dates remain covered; only scheduled working dates consume the bank. */
export function scheduledLeaveDates(employeeId: number, dates: string[]): string[] {
  const employee = queryOne<{ rest_days: string | null }>('SELECT rest_days FROM employees WHERE id = ?', employeeId);
  const policy = getSetting<{ default_rest_days?: number[] }>('payroll_policy');
  let restDays = policy?.default_rest_days ?? [0, 6];
  try { if (employee?.rest_days) restDays = JSON.parse(employee.rest_days); } catch { /* use policy */ }
  const swaps = restDaySwapsFor(employeeId);
  const noWorkIds = noWorkFormIds();
  const calendars = queryAll<{ slug: string; data: string }>(`SELECT fd.slug, fr.data FROM form_records fr
    JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'company_holiday' ${noWorkIds.length ? `OR fd.id IN (${noWorkIds.map(() => '?').join(',')})` : ''}`, ...noWorkIds)
    .map(r => ({ slug: r.slug, data: safeData(r.data) }));
  return dates.filter(date => {
    const override = queryOne<{ rest_day: string | null; holiday_type: string | null }>(
      'SELECT rest_day, holiday_type FROM attendance_records WHERE employee_id = ? AND work_date = ? ORDER BY id DESC LIMIT 1', employeeId, date);
    const rest = override?.rest_day || swaps.get(date)?.rest_day || (restDays.includes(new Date(date + 'T00:00:00Z').getUTCDay()) ? 'yes' : 'no');
    if (rest === 'yes') return false;
    if (['regular', 'special_non_working', 'cancelled_paid', 'cancelled_unpaid'].includes(override?.holiday_type || '')) return false;
    return !calendars.some(c => c.slug === 'company_holiday'
      ? override?.holiday_type !== 'none' && c.data.date === date && ['Regular Holiday', 'Special Non-Working Holiday'].includes(String(c.data.type))
      : realDate(c.data.date_from) && realDate(c.data.date_to) && date >= c.data.date_from && date <= c.data.date_to);
  });
}

export function normalizeRequest(slug: string, fields: FieldDef[], raw: Record<string, unknown>, employeeId: number): Record<string, unknown> {
  const employee = queryOne<{ id: number; name: string; employee_no: string; position: string | null; department_name: string | null }>(
    `SELECT e.id, e.name, e.employee_no, e.position, d.name AS department_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`, employeeId);
  if (!employee) throw new ValidationError('Select a valid employee before filing this request.');
  const data = { ...raw, employee_id: employee.id, employee_name: employee.name,
    name: employee.name, employee_no: employee.employee_no, position: employee.position || '', department: employee.department_name || '' } as Record<string, unknown>;
  for (const key of internal) if (key !== 'employee_id') delete data[key];
  if (slug === 'leave_request') {
    const dates = leaveDates(data);
    data.leave_dates = dates.join(','); data.date_from = dates[0]; data.date_to = dates.at(-1);
    data.days = scheduledLeaveDates(employeeId, dates).length;
    data.with_pay = data.leave_type === 'Unpaid Leave' ? 'No' : (data.with_pay || 'Yes');
    if (!['Yes', 'No'].includes(String(data.with_pay))) throw new ValidationError('With pay must be Yes or No.');
  }
  for (const f of fields) {
    if (internal.includes(f.key)) continue;
    let value = data[f.key];
    if ((value === undefined || value === null || value === '') && f.default != null && f.default !== '') data[f.key] = value = f.default;
    if (f.required && (value === undefined || value === null || String(value).trim() === '')) throw new ValidationError(`${f.label} is required.`);
    if (value === undefined || value === null || value === '') continue;
    if (['text','textarea','employee'].includes(f.type) && typeof value !== 'string') throw new ValidationError(`${f.label} must be text.`);
    if (f.type === 'checkbox') {
      if (![true, false, 'Yes', 'No'].includes(value as any)) throw new ValidationError(`${f.label} must be Yes or No.`);
      data[f.key] = value === true || value === 'Yes' ? 'Yes' : 'No';
    }
    if (f.type === 'number') {
      if (!['string','number'].includes(typeof value) || !Number.isFinite(Number(value))) throw new ValidationError(`${f.label} must be a valid number.`);
      data[f.key] = Number(value);
    }
    if (f.type === 'date' && !realDate(value)) throw new ValidationError(`${f.label} must be a real calendar date.`);
    if (f.type === 'time' && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new ValidationError(`${f.label} must be a valid HH:MM time.`);
    if (f.type === 'select' && f.options?.length && !f.options.some(o => String(typeof o === 'object' ? (o as any).value ?? (o as any).label : o) === String(value))) throw new ValidationError(`${f.label}: select one of the available options.`);
  }
  if (ATTENDANCE_REQUESTS.includes(slug) && (typeof data.reason !== 'string' || !data.reason.trim())) throw new ValidationError('Reason is required and must be text.');
  if (ATTENDANCE_REQUESTS.includes(slug) && slug !== 'leave_request') {
    const date = requestDate(slug, data);
    if (!realDate(date)) throw new ValidationError('A valid request date is required.');
  }
  if (slug === 'schedule_change' && !queryOne('SELECT id FROM shifts WHERE id = ?', Number(data.requested_shift_id))) {
    throw new ValidationError('Choose an available shift for this schedule change.');
  }
  return data;
}

export function requestDate(slug: string, data: Record<string, unknown>): unknown {
  return slug === 'rest_day_change' ? data.original_rest_day : data.work_date || data.date;
}

export function requestMatchesDay(slug: string, data: Record<string, unknown>, employeeId: number, date: string): boolean {
  if (slug === 'company_holiday') return data.date === date;
  if (slug === 'no_work_memo') return realDate(data.date_from) && realDate(data.date_to) && date >= data.date_from && date <= data.date_to;
  if (!ATTENDANCE_REQUESTS.includes(slug)) return false;
  const beneficiary = requestEmployeeId(data);
  if (beneficiary !== employeeId) return false;
  try { return slug === 'leave_request' ? leaveDates(data).includes(date) : requestDate(slug, data) === date; }
  catch { return false; }
}

export function requestEmployeeId(data: Record<string, unknown>): number {
  let beneficiary = Number(data.employee_id);
  if (!beneficiary && data.employee_name) {
    const matches = queryAll<{ id: number }>('SELECT id FROM employees WHERE name = ?', String(data.employee_name));
    if (matches.length === 1) beneficiary = matches[0]!.id;
  }
  return beneficiary;
}

export function leavePreview(employeeId: number, data: Record<string, unknown>) {
  const employee = queryOne<{ leave_days_per_year: number; leave_days_used: number }>('SELECT leave_days_per_year, leave_days_used FROM employees WHERE id = ?', employeeId);
  if (!employee) throw new ValidationError('Employee not found.');
  const dates = leaveDates(data), working = scheduledLeaveDates(employeeId, dates);
  return { dates, working_dates: working, days: working.length, remaining: employee.leave_days_per_year - employee.leave_days_used,
    warnings: leaveWarnings(employeeId, data) };
}

export function overlappingLeave(employeeId: number, dates: string[], exceptId = 0) {
  const covered = new Set(dates);
  return queryAll<{ id: number; number: string; status: string; data: string }>(`SELECT fr.id, fr.number, fr.status, fr.data FROM form_records fr
    JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'leave_request' AND fr.status IN ('pending','approved') AND fr.id != ?
    AND CAST(json_extract(fr.data, '$.employee_id') AS INTEGER) = ?`, exceptId, employeeId)
    .flatMap(r => { try { const data = safeData(r.data), overlap = leaveDates(data).filter(d => covered.has(d));
      return overlap.length ? [{ ...r, data, dates: overlap }] : []; } catch { return []; } });
}

export function leaveWarnings(employeeId: number, data: Record<string, unknown>, exceptId = 0): string[] {
  const dates = leaveDates(data), working = scheduledLeaveDates(employeeId, dates);
  const warnings = overlappingLeave(employeeId, dates, exceptId).map(r => `${r.number} (${r.status}) also covers ${r.dates.join(', ')}.`);
  const excluded = dates.filter(d => !working.includes(d));
  if (excluded.length) warnings.push(`${excluded.length} selected rest/holiday/no-work date(s) do not consume leave balance: ${excluded.join(', ')}.`);
  return warnings;
}

/** Link selected leave dates across existing cutoffs; never mutate paid attendance. */
export function attachLeave(recordId: number): { linked_dates: string[]; warnings: string[] } {
  const record = queryOne<{ data: string; status: string }>('SELECT data, status FROM form_records WHERE id = ?', recordId);
  if (!record || !['pending', 'approved'].includes(record.status)) return { linked_dates: [], warnings: [] };
  const data = safeData(record.data), employeeId = requestEmployeeId(data), dates = leaveDates(data);
  if (!employeeId) throw new ValidationError('This leave has no unambiguous employee. HR must correct the employee before linking.');
  const rows = queryAll<{ id: number; period_id: number; work_date: string; form_record_id: number | null; form_record_ids: string | null }>(
    'SELECT id, period_id, work_date, form_record_id, form_record_ids FROM attendance_records WHERE employee_id = ?', employeeId);
  const linked = new Set<string>(), locked = new Set<string>();
  for (const row of rows) {
    let ids: number[] = row.form_record_id ? [row.form_record_id] : [];
    try { if (row.form_record_ids) ids = JSON.parse(row.form_record_ids); } catch { /* retain legacy single link */ }
    const wanted = dates.includes(row.work_date);
    if (cutoffIsPaid(row.period_id)) { if (wanted && !ids.includes(recordId)) locked.add(row.work_date); continue; }
    const next = ids.filter(id => id !== recordId); if (wanted) { next.push(recordId); linked.add(row.work_date); }
    if (JSON.stringify(next) !== JSON.stringify(ids)) run("UPDATE attendance_records SET form_record_ids = ?, form_record_id = ?, updated_at = datetime('now') WHERE id = ?", next.length ? JSON.stringify(next) : null, next[0] ?? null, row.id);
  }
  const warnings = [...locked].map(d => `${d}: paid cutoff is locked; attendance was not changed.`);
  const missing = dates.filter(d => !rows.some(r => r.work_date === d));
  if (missing.length) warnings.push(`${missing.length} date(s) have no cutoff roster yet; their links will be added when the employee is added to that cutoff.`);
  return { linked_dates: [...linked].sort(), warnings };
}

export function attachEmployeeLeaves(employeeId: number): void {
  for (const r of queryAll<{ id: number }>(`SELECT fr.id FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
    WHERE fd.slug = 'leave_request' AND fr.status IN ('pending','approved') AND CAST(json_extract(fr.data,'$.employee_id') AS INTEGER) = ?`, employeeId)) {
    try { attachLeave(r.id); } catch { /* legacy malformed leave cannot authorize new attendance */ }
  }
}
