/** AI analytics tools — executed directly (no LLM). Covers permission gating,
    the attendance/activity/inventory/manufacturing reports, and run_analytics_query. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import type { AuthUser, Permission } from '../src/shared/types';

let ctx: TestContext;
let token: string;
let exec: typeof import('../src/modules/ai/ai-analytics').executeAnalyticsTool;
let toolsFor: typeof import('../src/modules/ai/ai-analytics').analyticsToolsForUser;
let db: typeof import('../src/shared/db');

const authHdr = () => ({ Authorization: `Bearer ${token}` });
const user = (perms: Permission[]): AuthUser => ({
  id: 1, username: 'admin', full_name: 'Admin', role: 'admin',
  department_id: null, active: 1, department_name: null, permissions: perms,
});
const admin = () => user([...ALL_PERMISSIONS]);

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  const mod = await import('../src/modules/ai/ai-analytics');
  exec = mod.executeAnalyticsTool;
  toolsFor = mod.analyticsToolsForUser;
  db = await import('../src/shared/db');
});
afterAll(() => cleanup(ctx));

describe('ai-analytics: permission gating', () => {
  it('filters tools by permission and denies out-of-scope calls', () => {
    const hrOnly = user(['hr.view']);
    const names = toolsFor(hrOnly).map((t) => t.function.name);
    expect(names).toContain('attendance_report');
    expect(names).not.toContain('low_stock_report');
    expect(names).not.toContain('run_analytics_query');

    const r = exec('low_stock_report', {}, hrOnly);
    expect(r).toMatchObject({ success: false, error: 'Permission denied.' });
  });
});

describe('ai-analytics: inventory reports', () => {
  it('low_stock_report + reorder_suggestions flag items at/under reorder level', async () => {
    await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'AA Low Item', sku: 'AA-LOW', quantity: 2, min_quantity: 10 });
    await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'AA OK Item', sku: 'AA-OK', quantity: 50, min_quantity: 5 });

    const low = exec('low_stock_report', {}, admin()) as { data: { items: Array<{ sku: string; shortfall: number }> } };
    const row = low.data.items.find((i) => i.sku === 'AA-LOW');
    expect(row).toBeTruthy();
    expect(row!.shortfall).toBe(8);
    expect(low.data.items.some((i) => i.sku === 'AA-OK')).toBe(false);

    const re = exec('reorder_suggestions', { target_multiple: 2 }, admin()) as { data: { items: Array<{ sku: string; suggested_order_qty: number }> } };
    expect(re.data.items.find((i) => i.sku === 'AA-LOW')!.suggested_order_qty).toBe(18); // 10*2 - 2
  });

  it('stock_movement_summary totals ins and outs over a range', async () => {
    const { body } = await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'AA Mover', sku: 'AA-MV', quantity: 20 });
    await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr()).send({ change: -5, reason: 'out' });

    const r = exec('stock_movement_summary', { item_id: body.id }, admin()) as { data: { total_in: number; total_out: number; net: number } };
    expect(r.data.total_in).toBe(20);
    expect(r.data.total_out).toBe(5);
    expect(r.data.net).toBe(15);
  });

  it('dead_stock returns a well-formed (here empty) list for fresh stock', () => {
    const r = exec('dead_stock', { days: 90 }, admin()) as { data: { items: unknown[]; since: string } };
    expect(Array.isArray(r.data.items)).toBe(true);
    expect(r.data.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ai-analytics: activity report', () => {
  it('summarises what happened, by action / user / entity', async () => {
    await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'AA Act Item', quantity: 1 });
    await new Promise((r) => setTimeout(r, 30)); // let the activity-log finish hook run

    const r = exec('activity_report', {}, admin()) as {
      data: { total: number; by_action: Array<{ action: string }>; by_entity: Array<{ entity: string }> };
    };
    expect(r.data.total).toBeGreaterThan(0);
    expect(r.data.by_action.some((a) => a.action === 'create')).toBe(true);
    expect(r.data.by_entity.some((e) => e.entity === 'inventory')).toBe(true);
  });
});

describe('ai-analytics: attendance reports', () => {
  beforeAll(() => {
    // Minimal HR fixture: one 09:00 shift, one employee, a period, and 4 attendance days.
    const shift = db.run("INSERT INTO shifts (name, start_time, end_time, is_default) VALUES ('Day', '09:00', '18:00', 1)").lastInsertRowid;
    const emp = db.run(
      "INSERT INTO employees (name, employee_no, default_shift_id, status) VALUES ('Chronically Late', 'E-001', ?, 'regular')",
      shift
    ).lastInsertRowid;
    const period = db.run(
      "INSERT INTO attendance_periods (label, start_date, end_date) VALUES ('Test', '2026-08-01', '2026-08-31')"
    ).lastInsertRowid;
    const day = (d: string, tin: string | null, formId: number | null = null) =>
      db.run(
        'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id, form_record_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        period, emp, d, tin, tin ? '18:00' : null, shift, formId
      );
    day('2026-08-04', '09:45'); // late
    day('2026-08-05', '10:20'); // late
    day('2026-08-06', '08:55'); // on time
    day('2026-08-07', null);    // absent (no form)

    // A leave form covering one more day so it isn't counted as an absence.
    const fd = db.run("INSERT INTO form_definitions (name, slug) VALUES ('Leave Request', 'leave_request')").lastInsertRowid;
    // Dated inside the period it excuses: left to default to "today", leave_ot_summary's
    // fixed August–September range stopped finding it on 2026-10-01.
    const fr = db.run(
      "INSERT INTO form_records (form_def_id, number, data, created_at) VALUES (?, 'LR-1', '{}', '2026-08-07 08:00:00')", fd,
    ).lastInsertRowid;
    day('2026-08-08', null, Number(fr)); // excused
  });

  it('attendance_report counts present / absent / late', () => {
    const r = exec('attendance_report', { from: '2026-08-01', to: '2026-08-31' }, admin()) as {
      data: { employees: Array<{ name: string; days_present: number; days_absent: number; late_days: number; days_with_form: number }> };
    };
    const e = r.data.employees.find((x) => x.name === 'Chronically Late')!;
    expect(e.days_present).toBe(3);
    expect(e.late_days).toBe(2);
    expect(e.days_absent).toBe(1);      // the excused day doesn't count
    expect(e.days_with_form).toBe(1);
  });

  it('attendance_detail (item 6 — AI can check timekeeping, read-only) returns raw day rows and flags incomplete ones', () => {
    const emp = db.queryOne<{ id: number }>("SELECT id FROM employees WHERE name = 'Chronically Late'")!.id;
    const periodId = db.queryOne<{ id: number }>("SELECT id FROM attendance_periods WHERE label = 'Test'")!.id;
    // A day with only time_in set — the fixture's own day() helper never produces this
    // combination (it always pairs a time_in with '18:00' or leaves both null).
    db.run(
      "INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out) VALUES (?, ?, '2026-08-09', '09:00', NULL)",
      periodId, emp
    );

    const noEmp = exec('attendance_detail', { from: '2026-08-01', to: '2026-08-31' }, admin());
    expect(noEmp).toMatchObject({ success: false });

    const r = exec('attendance_detail', { employee_id: emp, from: '2026-08-01', to: '2026-08-31' }, admin()) as {
      data: { days: Array<{ work_date: string; time_in: string | null; time_out: string | null; incomplete: boolean; linked_form: string | null }> };
    };
    const complete = r.data.days.find((d) => d.work_date === '2026-08-06'); // 08:55/18:00
    expect(complete!.incomplete).toBe(false);
    const absentDay = r.data.days.find((d) => d.work_date === '2026-08-07'); // both null
    expect(absentDay!.incomplete).toBe(false); // a plain absence, not "incomplete"
    const excused = r.data.days.find((d) => d.work_date === '2026-08-08');
    expect(excused!.linked_form).toBe('Leave Request');
    const incompleteDay = r.data.days.find((d) => d.work_date === '2026-08-09');
    expect(incompleteDay!.incomplete).toBe(true); // only time_in set

    // hr.view can check, but nothing in ai-tools.ts/ai-analytics.ts lets the AI write to
    // attendance_records at all — "checking only, not editing" holds by construction, not by
    // a permission check that could be misconfigured.
    const names = toolsFor(user(['hr.view'])).map((t) => t.function.name);
    expect(names).toContain('attendance_detail');
    expect(names.some((n) => /attendance/i.test(n) && /update|create|edit|delete|set/i.test(n))).toBe(false);
  });

  it('chronic_lateness ranks repeat offenders above a threshold', () => {
    const r = exec('chronic_lateness', { from: '2026-08-01', to: '2026-08-31', min_late_days: 2 }, admin()) as {
      data: { employees: Array<{ name: string; late_days: number }> };
    };
    expect(r.data.employees[0]!.name).toBe('Chronically Late');
    expect(r.data.employees[0]!.late_days).toBe(2);
  });

  it('absence_report surfaces unexcused absences', () => {
    const r = exec('absence_report', { from: '2026-08-01', to: '2026-08-31', min_absences: 1 }, admin()) as {
      data: { employees: Array<{ name: string; days_absent: number }> };
    };
    expect(r.data.employees.find((x) => x.name === 'Chronically Late')!.days_absent).toBe(1);
  });

  it('leave_ot_summary counts leave/OT forms per employee', () => {
    const r = exec('leave_ot_summary', { from: '2026-08-01', to: '2026-09-30' }, admin()) as {
      data: { rows: Array<{ name: string; form_type: string; count: number }> };
    };
    expect(r.data.rows.some((x) => x.form_type === 'leave_request' && x.count >= 1)).toBe(true);
  });
});

describe('ai-analytics: manufacturing reports', () => {
  it('job_order_report + qc_report reflect a completed QC run', async () => {
    const p = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'AA MFG Product' })).body.id;
    const c = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'AA MFG Part', quantity: 100 })).body.id;
    await ctx.api.put(`/api/finished-products/${p}`).set(authHdr()).send({ components: [{ component_item_id: c, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(authHdr()).send({ product_item_id: p, qty_ordered: 3, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(authHdr());
    await addSerializedUnits(ctx.api, token, mo, 3, 'AAMFG');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(authHdr())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id, units[1]!.id], result: 'pass' });
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[2]!.id], result: 'fail', disposition: 'scrap', remarks: 'crack' });

    const jr = exec('job_order_report', {}, admin()) as { data: { totals: { ordered: number; done: number; scrapped: number } } };
    expect(jr.data.totals.ordered).toBeGreaterThanOrEqual(3);
    expect(jr.data.totals.done).toBeGreaterThanOrEqual(2);
    expect(jr.data.totals.scrapped).toBeGreaterThanOrEqual(1);

    const qc = exec('qc_report', {}, admin()) as { data: { pass: number; fail: number; pass_rate: number; top_fail_remarks: Array<{ remarks: string }> } };
    expect(qc.data.pass).toBeGreaterThanOrEqual(2);
    expect(qc.data.fail).toBeGreaterThanOrEqual(1);
    expect(qc.data.top_fail_remarks.some((x) => x.remarks === 'crack')).toBe(true);
  });
});

describe('ai-analytics: run_analytics_query', () => {
  it('does not expose custom SQL even to administrators', () => {
    const r = exec('run_analytics_query', { sql: 'SELECT COUNT(*) AS n FROM inventory_items LIMIT 1' }, admin()) as {
      success: boolean; data: { rows: Array<{ n: number }> };
    };
    expect(r.success).toBe(false);
    expect(toolsFor(admin()).map(t => t.function.name)).not.toContain('run_analytics_query');
  });

  it('rejects writes, stacked statements, and users/sessions access', () => {
    for (const sql of [
      "SELECT value FROM settings",
      'SELECT * FROM "users"',
      'SELECT * FROM password_resets',
      "SELECT * FROM notes",
      "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT * FROM x",
      "DELETE FROM inventory_items",
      "SELECT 1; DROP TABLE inventory_items",
      "SELECT password_hash FROM users",
      "SELECT * FROM sessions LIMIT 1",
      "WITH x AS (UPDATE inventory_items SET quantity = 0 RETURNING id) SELECT * FROM x",
    ]) {
      expect(exec('run_analytics_query', { sql }, admin()).success, sql).toBe(false);
    }
  });
});
