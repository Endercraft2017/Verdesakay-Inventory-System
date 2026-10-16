/**
 * Operational dashboards — fixed, at-a-glance reporting that doesn't need the AI
 * assistant. One endpoint (`GET /api/analytics/overview`) returns every section the
 * caller is permitted to see; the frontend renders it as KPI cards + mini tables.
 *
 * Everything here is read-only. Costs come from the item `attributes` JSON
 * (`standard_cost` → `purchase_price` → 0), same convention as src/bom-resolvers.ts.
 */
import { moduleEnabled } from '../shared/modules';
import { Router } from 'express';
import { queryOne, queryAll } from '../shared/db';
import { requireAuth } from '../shared/auth';
import type { Permission } from '../shared/types';

const router = Router();
router.use(requireAuth);

const UNIT_COST = `COALESCE(
  CAST(json_extract(i.attributes, '$.standard_cost')  AS REAL),
  CAST(json_extract(i.attributes, '$.purchase_price') AS REAL),
  0)`;

const num = (v: unknown): number => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;
const daysAgo = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* --------------------------------------------------------------- inventory --- */

function inventorySection() {
  const totals = queryOne<{ items: number; low: number; oos: number; value: number }>(`
    SELECT COUNT(*) AS items,
           SUM(CASE WHEN quantity <= min_quantity AND quantity > 0 THEN 1 ELSE 0 END) AS low,
           SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) AS oos,
           SUM(quantity * ${UNIT_COST}) AS value
    FROM inventory_items i`);

  const byLocation = queryAll<{ location: string; value: number; units: number }>(`
    SELECT l.name AS location,
           SUM(s.quantity * ${UNIT_COST}) AS value,
           SUM(s.quantity) AS units
    FROM inventory_stock s
    JOIN inventory_items i ON i.id = s.item_id
    JOIN locations l ON l.id = s.location_id
    WHERE s.quantity <> 0
    GROUP BY l.id ORDER BY value DESC LIMIT 8`);

  const topItems = queryAll<{ name: string; sku: string | null; quantity: number; value: number }>(`
    SELECT i.name, i.sku, i.quantity, i.quantity * ${UNIT_COST} AS value
    FROM inventory_items i
    WHERE i.quantity > 0
    ORDER BY value DESC LIMIT 8`);

  const dead = queryOne<{ n: number; value: number }>(`
    SELECT COUNT(*) AS n, SUM(i.quantity * ${UNIT_COST}) AS value
    FROM inventory_items i
    WHERE i.quantity > 0
      AND NOT EXISTS (
        SELECT 1 FROM inventory_transactions t
        WHERE t.item_id = i.id AND t.created_at >= ?)`, daysAgo(90));

  return {
    items: totals?.items ?? 0,
    low_stock: totals?.low ?? 0,
    out_of_stock: totals?.oos ?? 0,
    stock_value: num(totals?.value),
    dead_stock_count: dead?.n ?? 0,
    dead_stock_value: num(dead?.value),
    value_by_location: byLocation.map((r) => ({ location: r.location, value: num(r.value), units: r.units })),
    top_value_items: topItems.map((r) => ({ ...r, value: num(r.value) })),
  };
}

/* -------------------------------------------------------------- production --- */

function productionSection() {
  const byStatus = Object.fromEntries(
    queryAll<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM job_orders GROUP BY status'
    ).map((r) => [r.status, r.n])
  );

  const wip = queryOne<{ orders: number; qty: number }>(`
    SELECT COUNT(*) AS orders,
           SUM(MAX(qty_ordered - qty_done - qty_scrapped, 0)) AS qty
    FROM job_orders WHERE status IN ('released','in_progress','paused')`);

  const OPEN = "status IN ('draft','released','in_progress','paused')";
  const sched = queryOne<{ overdue: number; due_week: number }>(`
    SELECT SUM(CASE WHEN due_date IS NOT NULL AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN due_date IS NOT NULL AND due_date >= date('now')
                    AND due_date < date('now','+7 day') THEN 1 ELSE 0 END) AS due_week
    FROM job_orders WHERE ${OPEN}`);

  const windowStats = (days: number) =>
    queryOne<{ mos: number; done: number; scrapped: number }>(`
      SELECT COUNT(*) AS mos, SUM(qty_done) AS done, SUM(qty_scrapped) AS scrapped
      FROM job_orders
      WHERE status = 'completed' AND COALESCE(closed_at, updated_at) >= ?`, daysAgo(days));

  const w30 = windowStats(30);
  const w90 = windowStats(90);
  const scrapRate = (s?: { done: number; scrapped: number }) => {
    const d = Number(s?.done) || 0;
    const k = Number(s?.scrapped) || 0;
    return d + k > 0 ? Math.round((k / (d + k)) * 1000) / 10 : 0;
  };

  const recent = queryAll<{ number: string; product_name: string; qty_done: number; closed_at: string | null }>(`
    SELECT number, product_name, qty_done, COALESCE(closed_at, updated_at) AS closed_at
    FROM job_orders WHERE status = 'completed'
    ORDER BY COALESCE(closed_at, updated_at) DESC LIMIT 6`);

  return {
    by_status: byStatus,
    wip_orders: wip?.orders ?? 0,
    wip_qty: Number(wip?.qty) || 0,
    overdue: Number(sched?.overdue) || 0,
    due_this_week: Number(sched?.due_week) || 0,
    last_30: { mos: w30?.mos ?? 0, units_done: Number(w30?.done) || 0, units_scrapped: Number(w30?.scrapped) || 0, scrap_rate_pct: scrapRate(w30 ?? undefined) },
    last_90: { mos: w90?.mos ?? 0, units_done: Number(w90?.done) || 0, units_scrapped: Number(w90?.scrapped) || 0, scrap_rate_pct: scrapRate(w90 ?? undefined) },
    recent_completed: recent,
  };
}

/* -------------------------------------------------------------- purchasing --- */

function purchasingSection() {
  const openPos = queryOne<{ n: number; value: number }>(`
    SELECT COUNT(*) AS n, SUM(total) AS value
    FROM orders WHERE type = 'purchase' AND status NOT IN ('completed','cancelled')`);

  const receivedValue = queryOne<{ v: number }>(`
    SELECT SUM(gi.quantity * COALESCE(oi.unit_price, 0)) AS v
    FROM goods_receipt_items gi
    LEFT JOIN order_items oi ON oi.id = gi.order_item_id`);

  const billedValue = queryOne<{ v: number }>(`
    SELECT SUM(bi.line_total) AS v
    FROM vendor_bill_items bi JOIN vendor_bills b ON b.id = bi.bill_id
    WHERE b.status <> 'disputed'`);

  const draftBills = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM vendor_bills WHERE status = 'draft'");

  // AP aging on approved (payable) bills, bucketed by due date vs today.
  const aging = queryOne<{ current: number; d1_30: number; d31_60: number; d60_plus: number; total: number }>(`
    SELECT
      SUM(CASE WHEN due_date IS NULL OR due_date >= date('now') THEN total ELSE 0 END) AS current,
      SUM(CASE WHEN due_date < date('now') AND due_date >= date('now','-30 day') THEN total ELSE 0 END) AS d1_30,
      SUM(CASE WHEN due_date < date('now','-30 day') AND due_date >= date('now','-60 day') THEN total ELSE 0 END) AS d31_60,
      SUM(CASE WHEN due_date < date('now','-60 day') THEN total ELSE 0 END) AS d60_plus,
      SUM(total) AS total
    FROM vendor_bills WHERE status = 'approved'`);

  const grni = num((Number(receivedValue?.v) || 0) - (Number(billedValue?.v) || 0));
  return {
    open_pos: openPos?.n ?? 0,
    open_po_value: num(openPos?.value),
    gr_ni_value: grni > 0 ? grni : 0, // goods received, not yet invoiced
    bills_to_approve: draftBills?.n ?? 0,
    ap_aging: {
      current: num(aging?.current), d1_30: num(aging?.d1_30),
      d31_60: num(aging?.d31_60), d60_plus: num(aging?.d60_plus), total: num(aging?.total),
    },
  };
}

/* ------------------------------------------------------------------- sales --- */

function salesSection() {
  const open = queryOne<{ n: number; value: number }>(`
    SELECT COUNT(*) AS n, SUM(total) AS value
    FROM orders WHERE type = 'sale' AND status NOT IN ('completed','cancelled')`);

  const byStatus = Object.fromEntries(
    queryAll<{ status: string; n: number; value: number }>(
      "SELECT status, COUNT(*) AS n, SUM(total) AS value FROM orders WHERE type = 'sale' GROUP BY status"
    ).map((r) => [r.status, { count: r.n, value: num(r.value) }])
  );

  const weekly = queryAll<{ week: string; n: number; value: number }>(`
    SELECT strftime('%Y-%W', COALESCE(order_date, created_at)) AS week,
           COUNT(*) AS n, SUM(total) AS value
    FROM orders
    WHERE type = 'sale' AND COALESCE(order_date, created_at) >= date('now','-56 day')
    GROUP BY week ORDER BY week`);

  // Backordered: approved/released, not fulfilled, with a line not yet fully released.
  const backorder = queryOne<{ n: number; value: number }>(`
    SELECT COUNT(*) AS n, SUM(o.total) AS value FROM orders o
    WHERE o.type = 'sale' AND o.fulfilled_at IS NULL AND LOWER(o.status) IN ('approved','released')
      AND EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL
          AND oi.quantity > COALESCE(oi.released_qty,0)
            + (SELECT COUNT(*) FROM job_order_units ju
                WHERE ju.order_id = o.id AND ju.product_item_id = oi.item_id AND ju.status IN ('reserved','sold'))
      )`);

  return {
    open_orders: open?.n ?? 0,
    open_value: num(open?.value),
    backorder_count: backorder?.n ?? 0,
    backorder_value: num(backorder?.value),
    by_status: byStatus,
    weekly: weekly.map((r) => ({ week: r.week, count: r.n, value: num(r.value) })),
  };
}

/* ----------------------------------------------------------------- payroll --- */

function payrollSection() {
  const form = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'");
  if (!form) return { periods: [] as unknown[] };

  const rows = queryAll<{
    period: string | null; headcount: number; gross: number; net: number;
    sss: number; philhealth: number; pagibig: number; tax: number; last_at: string;
  }>(`
    SELECT period,
           COUNT(*) AS headcount,
           SUM(COALESCE(CAST(json_extract(data,'$.total_earnings') AS REAL), 0)) AS gross,
           SUM(COALESCE(CAST(json_extract(data,'$.net_pay') AS REAL), 0)) AS net,
           SUM(COALESCE(CAST(json_extract(data,'$.sss') AS REAL), 0)) AS sss,
           SUM(COALESCE(CAST(json_extract(data,'$.philhealth') AS REAL), 0)) AS philhealth,
           SUM(COALESCE(CAST(json_extract(data,'$.pagibig') AS REAL), 0)) AS pagibig,
           SUM(COALESCE(CAST(json_extract(data,'$.withholding_tax') AS REAL), 0)) AS tax,
           MAX(created_at) AS last_at
    FROM form_records
    WHERE form_def_id = ? AND period IS NOT NULL
    GROUP BY period ORDER BY last_at DESC LIMIT 6`, form.id);

  // Item 7: how many employees have an incomplete day (exactly one of time_in/time_out set,
  // not both blank — a blank day is a plain absence, not a data problem) in any recent cutoff.
  // Matches the per-cutoff roster count in hr.routes.ts GET /periods/:id exactly (no
  // "cutoff covers today" restriction — the missing time-out is just as real once a cutoff has
  // ended), bounded to cutoffs ending within the last ~120 days so ancient data doesn't inflate
  // this actionable "go fix this" home-page figure.
  const incomplete = queryOne<{ n: number }>(`
    SELECT COUNT(DISTINCT ar.employee_id) AS n
    FROM attendance_records ar
    JOIN attendance_periods p ON p.id = ar.period_id
    WHERE p.end_date >= date('now', 'localtime', '-120 day')
      AND ar.work_date <= date('now', 'localtime')
      AND ((ar.time_in IS NOT NULL AND ar.time_in != '') <> (ar.time_out IS NOT NULL AND ar.time_out != ''))
  `);

  return {
    periods: rows.map((r) => ({
      period: r.period,
      headcount: r.headcount,
      gross: num(r.gross),
      net: num(r.net),
      statutory: num((Number(r.sss) || 0) + (Number(r.philhealth) || 0) + (Number(r.pagibig) || 0)),
      tax: num(r.tax),
    })),
    incomplete_timekeeping: incomplete?.n || 0,
  };
}

/* -------------------------------------------------------------- the route --- */

// GET /api/analytics/overview — every section the caller may see.
router.get('/overview', (req, res) => {
  const can = (p: Permission) => req.user!.permissions.includes(p);
  const out: Record<string, unknown> = { generated_at: new Date().toISOString() };

  if (moduleEnabled('inventory') && can('inventory.view')) out.inventory = inventorySection();
  if (moduleEnabled('manufacturing') && can('production.view')) out.production = productionSection();
  if (moduleEnabled('purchasing') && can('purchasing.view')) out.purchasing = purchasingSection();
  if (moduleEnabled('inventory') && can('orders.view')) out.sales = salesSection();
  if (moduleEnabled('hr') && can('payroll.view')) out.payroll = payrollSection(); // pay is its own permission (payroll/pay-access.ts)

  res.json(out);
});

export default router;
