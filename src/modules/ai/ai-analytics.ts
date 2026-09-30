/**
 * AI analytics tools — read-only reporting the LLM agent can call.
 *
 * These are additive to src/ai-tools.ts: `getToolsForUser` merges these specs in,
 * and `executeTool` delegates unknown names here. Each tool is permission-gated
 * (same effective-permissions model as the core tools) and only ever reads.
 */
import { queryAll, queryOne, getSetting } from '../../shared/db';
import type { CerebrasTool, ToolResult } from './ai-tools';
import type { AuthUser, Permission } from '../../shared/types';

type AnalyticsToolName =
  | 'attendance_report'
  | 'attendance_detail'
  | 'chronic_lateness'
  | 'absence_report'
  | 'leave_ot_summary'
  | 'activity_report'
  | 'low_stock_report'
  | 'reorder_suggestions'
  | 'dead_stock'
  | 'stock_movement_summary'
  | 'job_order_report'
  | 'qc_report'
  | 'run_analytics_query';

const PERMISSION: Record<AnalyticsToolName, Permission> = {
  attendance_report: 'hr.view',
  attendance_detail: 'hr.view',
  chronic_lateness: 'hr.view',
  absence_report: 'hr.view',
  leave_ot_summary: 'hr.view',
  activity_report: 'audit.view',
  low_stock_report: 'inventory.view',
  reorder_suggestions: 'inventory.view',
  dead_stock: 'inventory.view',
  stock_movement_summary: 'inventory.view',
  job_order_report: 'inventory.view',
  qc_report: 'inventory.view',
  run_analytics_query: 'audit.view', // admin-only escape hatch
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function range(a: Record<string, unknown>, defDays = 30): { from: string; to: string } {
  const from = typeof a.from === 'string' && a.from ? a.from : daysAgo(defDays);
  const to = typeof a.to === 'string' && a.to ? a.to : today();
  return { from, to };
}

/** SQL that turns an 'HH:MM' (or 'HH:MM:SS') column into minutes-past-midnight. */
const mins = (col: string) =>
  `(CAST(substr(${col},1,2) AS INTEGER)*60 + CAST(substr(${col},4,2) AS INTEGER))`;

/** Effective shift-start expression: record shift → employee default → company default → 09:00. */
const SHIFT_START = `COALESCE(sh.start_time, defsh.start_time, anysh.start_time, '09:00')`;
const ATT_JOINS = `
  FROM attendance_records ar
  JOIN employees e ON e.id = ar.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN shifts sh ON sh.id = ar.shift_id
  LEFT JOIN shifts defsh ON defsh.id = e.default_shift_id
  LEFT JOIN shifts anysh ON anysh.is_default = 1
`;

function graceMinutes(): number {
  const p = getSetting<{ grace_minutes?: number }>('payroll_policy');
  return typeof p?.grace_minutes === 'number' ? p.grace_minutes : 10;
}

/** Reject anything that isn't a plain single read. */
function safeSelect(sqlRaw: unknown): string | null {
  if (typeof sqlRaw !== 'string') return null;
  const s = sqlRaw.trim().replace(/;+\s*$/, '');
  if (!s || !/^(select|with)\b/i.test(s)) return null;
  if (/;/.test(s)) return null; // no stacked statements
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant)\b/i.test(s)) return null;
  if (/pragma_|sqlite_/i.test(s)) return null; // schema-introspection functions / tables
  if (/password_hash|\bsessions\b|permission_overrides|\b(from|join)\s+(main\.)?users\b/i.test(s)) return null;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool specs (OpenAI-compatible, sent to the model)
// ─────────────────────────────────────────────────────────────────────────────

const dateRangeProps = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago).' },
  to: { type: 'string', description: 'End date YYYY-MM-DD (default: today).' },
};

const SPECS: Record<AnalyticsToolName, CerebrasTool> = {
  attendance_report: {
    type: 'function',
    function: {
      name: 'attendance_report',
      description:
        'Per-employee attendance totals over a date range: days recorded, present, absent, late days, total late minutes, and days covered by a leave/OT form. Absent = a work day with no time-in and no linked form.',
      parameters: {
        type: 'object',
        properties: {
          ...dateRangeProps,
          department_id: { type: 'number', description: 'Limit to one department.' },
          employee_id: { type: 'number', description: 'Limit to one employee.' },
        },
      },
    },
  },
  attendance_detail: {
    type: 'function',
    function: {
      name: 'attendance_detail',
      description:
        'The raw day-by-day time-in/time-out rows for one employee over a date range — read-only, for '
        + 'answering "what time did X clock in on Y" or checking a specific day, not for editing. Each row also '
        + 'flags "incomplete" (only one of time-in/time-out set — a data-entry gap, not a plain absence) and '
        + 'names any linked OT/Leave/Half-Day/Undertime/Offset form.',
      parameters: {
        type: 'object',
        properties: {
          ...dateRangeProps,
          employee_id: { type: 'number', description: 'Required — which employee.' },
        },
        required: ['employee_id'],
      },
    },
  },
  chronic_lateness: {
    type: 'function',
    function: {
      name: 'chronic_lateness',
      description: 'Employees who were late on at least `min_late_days` days in the range, worst first. "Late" = time-in later than shift start + grace period.',
      parameters: {
        type: 'object',
        properties: { ...dateRangeProps, min_late_days: { type: 'number', description: 'Minimum late days to include (default 3).' } },
      },
    },
  },
  absence_report: {
    type: 'function',
    function: {
      name: 'absence_report',
      description: 'Employees ranked by unexcused absent days in the range (no time-in, no linked leave/OT form).',
      parameters: {
        type: 'object',
        properties: { ...dateRangeProps, min_absences: { type: 'number', description: 'Minimum absences to include (default 2).' } },
      },
    },
  },
  leave_ot_summary: {
    type: 'function',
    function: {
      name: 'leave_ot_summary',
      description: 'Counts of leave / overtime / half-day / offset / holiday-work forms per employee in the range.',
      parameters: {
        type: 'object',
        properties: { ...dateRangeProps, employee_id: { type: 'number', description: 'Limit to one employee.' } },
      },
    },
  },
  activity_report: {
    type: 'function',
    function: {
      name: 'activity_report',
      description: 'What happened in the app: counts by action / user / module plus a sample of entries. Use `date` for a single day, or from/to for a range.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'A single day YYYY-MM-DD.' },
          ...dateRangeProps,
          user_id: { type: 'number' },
          entity: { type: 'string', description: 'Module, e.g. inventory, hr, users, orders.' },
          action: { type: 'string', description: 'e.g. create, update, delete, login, stock-adjust.' },
          limit: { type: 'number', description: 'Sample rows to return (default 30, max 200).' },
        },
      },
    },
  },
  low_stock_report: {
    type: 'function',
    function: {
      name: 'low_stock_report',
      description: 'Items at or below their reorder level (quantity <= min_quantity), with the shortfall and supplier.',
      parameters: { type: 'object', properties: {} },
    },
  },
  reorder_suggestions: {
    type: 'function',
    function: {
      name: 'reorder_suggestions',
      description: 'Low-stock items with a suggested order quantity to bring them back up to a multiple of the reorder level.',
      parameters: {
        type: 'object',
        properties: { target_multiple: { type: 'number', description: 'Target = min_quantity * this (default 2).' } },
      },
    },
  },
  dead_stock: {
    type: 'function',
    function: {
      name: 'dead_stock',
      description: 'Items with stock on hand but no movement in the last N days.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Look-back window (default 90).' } } },
    },
  },
  stock_movement_summary: {
    type: 'function',
    function: {
      name: 'stock_movement_summary',
      description: 'Total stock in / out / net over a range, plus the biggest-moving items.',
      parameters: {
        type: 'object',
        properties: { ...dateRangeProps, item_id: { type: 'number', description: 'Limit to one item.' } },
      },
    },
  },
  job_order_report: {
    type: 'function',
    function: {
      name: 'job_order_report',
      description: 'Manufacturing job orders: counts by status and totals for units ordered / done / scrapped, with a list.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string' }, ...dateRangeProps },
      },
    },
  },
  qc_report: {
    type: 'function',
    function: {
      name: 'qc_report',
      description: 'QA/QC results over a range: pass / fail counts, pass rate, and the most common failure remarks.',
      parameters: { type: 'object', properties: { ...dateRangeProps } },
    },
  },
  run_analytics_query: {
    type: 'function',
    function: {
      name: 'run_analytics_query',
      description:
        'Run one read-only SQL SELECT against the database for a question no other tool covers. SELECT/WITH only, single statement, always include a LIMIT. Tables include inventory_items, inventory_stock, inventory_transactions, locations, suppliers, bom_components, job_orders, job_order_components, job_order_units, qc_records, orders, order_items, employees, attendance_records, attendance_periods, shifts, form_records, form_definitions, activity_log, departments. (users/sessions are off-limits.)',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single SELECT/WITH statement with a LIMIT.' } },
        required: ['sql'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

export function analyticsToolsForUser(user: AuthUser): CerebrasTool[] {
  return (Object.keys(SPECS) as AnalyticsToolName[])
    .filter((n) => user.permissions.includes(PERMISSION[n]))
    .map((n) => SPECS[n]);
}

export function isAnalyticsTool(name: string): boolean {
  return name in SPECS;
}

export function executeAnalyticsTool(name: string, args: unknown, user: AuthUser): ToolResult {
  const n = name as AnalyticsToolName;
  const perm = PERMISSION[n];
  if (!perm) return { success: false, error: `Unknown tool: ${name}` };
  if (!user.permissions.includes(perm)) return { success: false, error: 'Permission denied.' };
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (n) {
      case 'attendance_report': {
        const { from, to } = range(a);
        const grace = graceMinutes();
        const where = ['ar.work_date BETWEEN ? AND ?'];
        const params: unknown[] = [from, to];
        if (a.department_id) { where.push('e.department_id = ?'); params.push(Number(a.department_id)); }
        if (a.employee_id) { where.push('e.id = ?'); params.push(Number(a.employee_id)); }
        const lateCond = `ar.time_in IS NOT NULL AND ar.time_in <> '' AND (${mins('ar.time_in')} - ${mins(SHIFT_START)}) > ${grace}`;
        const rows = queryAll(
          `SELECT e.id AS employee_id, e.name, e.employee_no, d.name AS department,
                  COUNT(*) AS days_recorded,
                  SUM(CASE WHEN ar.time_in IS NOT NULL AND ar.time_in <> '' THEN 1 ELSE 0 END) AS days_present,
                  SUM(CASE WHEN (ar.time_in IS NULL OR ar.time_in = '') AND ar.form_record_id IS NULL THEN 1 ELSE 0 END) AS days_absent,
                  SUM(CASE WHEN ${lateCond} THEN 1 ELSE 0 END) AS late_days,
                  SUM(CASE WHEN ${lateCond} THEN (${mins('ar.time_in')} - ${mins(SHIFT_START)} - ${grace}) ELSE 0 END) AS total_late_minutes,
                  SUM(CASE WHEN ar.form_record_id IS NOT NULL THEN 1 ELSE 0 END) AS days_with_form
           ${ATT_JOINS}
           WHERE ${where.join(' AND ')}
           GROUP BY e.id
           ORDER BY days_absent DESC, late_days DESC`,
          ...params
        );
        return { success: true, data: { from, to, grace_minutes: grace, employees: rows } };
      }

      case 'attendance_detail': {
        if (!a.employee_id) return { success: false, error: 'employee_id is required.' };
        const { from, to } = range(a);
        const rows = queryAll<{
          work_date: string; time_in: string | null; time_out: string | null; notes: string | null;
          shift_name: string | null; form_name: string | null;
        }>(
          `SELECT ar.work_date, ar.time_in, ar.time_out, ar.notes,
                  sh.name AS shift_name, fd.name AS form_name
           FROM attendance_records ar
           LEFT JOIN shifts sh ON sh.id = ar.shift_id
           LEFT JOIN form_records fr ON fr.id = ar.form_record_id
           LEFT JOIN form_definitions fd ON fd.id = fr.form_def_id
           WHERE ar.employee_id = ? AND ar.work_date BETWEEN ? AND ?
           ORDER BY ar.work_date`,
          Number(a.employee_id), from, to
        );
        const today = new Date().toISOString().slice(0, 10);
        const days = rows.map((r) => ({
          work_date: r.work_date,
          time_in: r.time_in || null,
          time_out: r.time_out || null,
          shift: r.shift_name,
          linked_form: r.form_name,
          notes: r.notes || null,
          incomplete: !!r.time_in !== !!r.time_out && r.work_date <= today,
        }));
        return { success: true, data: { employee_id: Number(a.employee_id), from, to, days } };
      }

      case 'chronic_lateness': {
        const { from, to } = range(a);
        const grace = graceMinutes();
        const min = a.min_late_days != null ? Number(a.min_late_days) : 3;
        const lateCond = `ar.time_in IS NOT NULL AND ar.time_in <> '' AND (${mins('ar.time_in')} - ${mins(SHIFT_START)}) > ${grace}`;
        const rows = queryAll(
          `SELECT e.id AS employee_id, e.name, d.name AS department,
                  SUM(CASE WHEN ${lateCond} THEN 1 ELSE 0 END) AS late_days,
                  SUM(CASE WHEN ${lateCond} THEN (${mins('ar.time_in')} - ${mins(SHIFT_START)} - ${grace}) ELSE 0 END) AS total_late_minutes
           ${ATT_JOINS}
           WHERE ar.work_date BETWEEN ? AND ?
           GROUP BY e.id
           HAVING late_days >= ?
           ORDER BY late_days DESC, total_late_minutes DESC`,
          from, to, min
        );
        return { success: true, data: { from, to, min_late_days: min, employees: rows } };
      }

      case 'absence_report': {
        const { from, to } = range(a);
        const min = a.min_absences != null ? Number(a.min_absences) : 2;
        const rows = queryAll(
          `SELECT e.id AS employee_id, e.name, d.name AS department,
                  SUM(CASE WHEN (ar.time_in IS NULL OR ar.time_in = '') AND ar.form_record_id IS NULL THEN 1 ELSE 0 END) AS days_absent,
                  COUNT(*) AS days_recorded
           FROM attendance_records ar
           JOIN employees e ON e.id = ar.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE ar.work_date BETWEEN ? AND ?
           GROUP BY e.id
           HAVING days_absent >= ?
           ORDER BY days_absent DESC`,
          from, to, min
        );
        return { success: true, data: { from, to, min_absences: min, employees: rows } };
      }

      case 'leave_ot_summary': {
        const { from, to } = range(a);
        const where = ['fr.created_at BETWEEN ? AND ?', "fd.slug IN ('leave_request','overtime_request','halfday_request','offset_form','lunch_offset_form','holiday_work_request','rest_day_work_request','rest_day_change')"];
        const params: unknown[] = [from, `${to} 23:59:59`];
        if (a.employee_id) { where.push('ar.employee_id = ?'); params.push(Number(a.employee_id)); }
        const rows = queryAll(
          `SELECT e.id AS employee_id, e.name, fd.slug AS form_type, COUNT(DISTINCT fr.id) AS count
           FROM form_records fr
           JOIN form_definitions fd ON fd.id = fr.form_def_id
           LEFT JOIN attendance_records ar ON ar.form_record_id = fr.id
           LEFT JOIN employees e ON e.id = ar.employee_id
           WHERE ${where.join(' AND ')}
           GROUP BY e.id, fd.slug
           ORDER BY count DESC`,
          ...params
        );
        return { success: true, data: { from, to, rows } };
      }

      case 'activity_report': {
        const date = typeof a.date === 'string' && a.date ? a.date : null;
        const from = date ?? (typeof a.from === 'string' && a.from ? a.from : daysAgo(7));
        const to = date ? `${date} 23:59:59` : (typeof a.to === 'string' && a.to ? `${a.to} 23:59:59` : `${today()} 23:59:59`);
        const where = ['created_at BETWEEN ? AND ?'];
        const params: unknown[] = [from, to];
        if (a.user_id) { where.push('user_id = ?'); params.push(Number(a.user_id)); }
        if (typeof a.entity === 'string' && a.entity) { where.push('entity = ?'); params.push(a.entity); }
        if (typeof a.action === 'string' && a.action) { where.push('action = ?'); params.push(a.action); }
        const w = 'WHERE ' + where.join(' AND ');
        const limit = Math.min(200, Math.max(1, Number(a.limit) || 30));
        return {
          success: true,
          data: {
            from, to,
            total: queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM activity_log ${w}`, ...params)?.n ?? 0,
            by_action: queryAll(`SELECT action, COUNT(*) AS n FROM activity_log ${w} GROUP BY action ORDER BY n DESC`, ...params),
            by_user: queryAll(`SELECT user_name, COUNT(*) AS n FROM activity_log ${w} GROUP BY user_name ORDER BY n DESC`, ...params),
            by_entity: queryAll(`SELECT entity, COUNT(*) AS n FROM activity_log ${w} GROUP BY entity ORDER BY n DESC`, ...params),
            sample: queryAll(
              `SELECT created_at, user_name, action, entity, entity_id, summary, status_code
               FROM activity_log ${w} ORDER BY id DESC LIMIT ${limit}`,
              ...params
            ),
          },
        };
      }

      case 'low_stock_report': {
        const rows = queryAll(
          `SELECT i.id, i.name, i.sku, i.quantity, i.min_quantity,
                  (i.min_quantity - i.quantity) AS shortfall, s.name AS supplier
           FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id
           WHERE i.quantity <= i.min_quantity
             AND (i.category IS NULL OR i.category <> 'Damage')
           ORDER BY shortfall DESC, i.name COLLATE NOCASE`
        );
        return { success: true, data: { count: rows.length, items: rows } };
      }

      case 'reorder_suggestions': {
        const mult = a.target_multiple != null ? Math.max(1, Number(a.target_multiple)) : 2;
        const rows = queryAll(
          `SELECT i.id, i.name, i.sku, i.quantity, i.min_quantity, s.name AS supplier,
                  MAX(i.min_quantity * ? - i.quantity, i.min_quantity) AS suggested_order_qty
           FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id
           WHERE i.quantity <= i.min_quantity AND i.min_quantity > 0
             AND (i.category IS NULL OR i.category <> 'Damage')
           ORDER BY suggested_order_qty DESC`,
          mult
        );
        return { success: true, data: { target_multiple: mult, items: rows } };
      }

      case 'dead_stock': {
        const days = a.days != null ? Math.max(1, Number(a.days)) : 90;
        const cutoff = daysAgo(days);
        const rows = queryAll(
          `SELECT i.id, i.name, i.sku, i.quantity,
                  (SELECT MAX(t.created_at) FROM inventory_transactions t WHERE t.item_id = i.id) AS last_movement
           FROM inventory_items i
           WHERE i.quantity > 0
             AND (i.category IS NULL OR i.category <> 'Damage')
             AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.item_id = i.id AND t.created_at >= ?)
           ORDER BY last_movement ASC`,
          cutoff
        );
        return { success: true, data: { since: cutoff, count: rows.length, items: rows } };
      }

      case 'stock_movement_summary': {
        const { from, to } = range(a);
        const where = ['t.created_at BETWEEN ? AND ?'];
        const params: unknown[] = [from, `${to} 23:59:59`];
        if (a.item_id) { where.push('t.item_id = ?'); params.push(Number(a.item_id)); }
        const w = 'WHERE ' + where.join(' AND ');
        const totals = queryOne(
          `SELECT COALESCE(SUM(CASE WHEN t.change > 0 THEN t.change END),0) AS total_in,
                  COALESCE(SUM(CASE WHEN t.change < 0 THEN -t.change END),0) AS total_out,
                  COALESCE(SUM(t.change),0) AS net
           FROM inventory_transactions t ${w}`,
          ...params
        );
        const by_item = queryAll(
          `SELECT i.name, i.sku,
                  COALESCE(SUM(CASE WHEN t.change > 0 THEN t.change END),0) AS in_qty,
                  COALESCE(SUM(CASE WHEN t.change < 0 THEN -t.change END),0) AS out_qty
           FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id ${w}
           GROUP BY t.item_id ORDER BY (in_qty + out_qty) DESC LIMIT 20`,
          ...params
        );
        return { success: true, data: { from, to, ...(totals as object), by_item } };
      }

      case 'job_order_report': {
        const { from, to } = range(a, 90);
        const where = ['j.created_at BETWEEN ? AND ?'];
        const params: unknown[] = [from, `${to} 23:59:59`];
        if (typeof a.status === 'string' && a.status) { where.push('j.status = ?'); params.push(a.status); }
        const w = 'WHERE ' + where.join(' AND ');
        return {
          success: true,
          data: {
            from, to,
            by_status: queryAll(`SELECT status, COUNT(*) AS n FROM job_orders j ${w} GROUP BY status`, ...params),
            totals: queryOne(
              `SELECT COALESCE(SUM(qty_ordered),0) AS ordered, COALESCE(SUM(qty_done),0) AS done,
                      COALESCE(SUM(qty_scrapped),0) AS scrapped
               FROM job_orders j ${w}`,
              ...params
            ),
            list: queryAll(
              `SELECT j.number, j.product_name, j.qty_ordered, j.qty_done, j.qty_scrapped, j.status, j.created_at
               FROM job_orders j ${w} ORDER BY j.id DESC LIMIT 50`,
              ...params
            ),
          },
        };
      }

      case 'qc_report': {
        const { from, to } = range(a, 90);
        const params = [from, `${to} 23:59:59`];
        const counts = queryOne<{ pass: number; fail: number }>(
          `SELECT COALESCE(SUM(result = 'pass'),0) AS pass, COALESCE(SUM(result = 'fail'),0) AS fail
           FROM qc_records WHERE created_at BETWEEN ? AND ?`,
          ...params
        ) ?? { pass: 0, fail: 0 };
        const total = counts.pass + counts.fail;
        return {
          success: true,
          data: {
            from, to,
            pass: counts.pass, fail: counts.fail,
            pass_rate: total ? Math.round((counts.pass / total) * 1000) / 10 : null,
            top_fail_remarks: queryAll(
              `SELECT remarks, COUNT(*) AS n FROM qc_records
               WHERE result = 'fail' AND remarks IS NOT NULL AND TRIM(remarks) <> '' AND created_at BETWEEN ? AND ?
               GROUP BY remarks ORDER BY n DESC LIMIT 15`,
              ...params
            ),
          },
        };
      }

      case 'run_analytics_query': {
        const sql = safeSelect(a.sql);
        if (!sql) {
          return { success: false, error: 'Only a single read-only SELECT/WITH statement is allowed (no users/sessions).' };
        }
        let rows: unknown[];
        try { rows = queryAll(sql); }
        catch (e) { return { success: false, error: `Query failed: ${e instanceof Error ? e.message : String(e)}` }; }
        const truncated = rows.length > 500;
        return { success: true, data: { row_count: rows.length, truncated, rows: rows.slice(0, 500) } };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
