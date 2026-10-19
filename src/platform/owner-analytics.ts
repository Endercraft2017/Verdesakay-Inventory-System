/** Aggregate SaaS telemetry; no request bodies, tokens, employee pay or document contents. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseBody } from '../shared/validation';
import { platformDb, getTenant, listProvisioningLog, type TenantRow } from './platform';
import { queryOne, queryAll, withTenant, getDb, uploadDir, DATA_DIR } from '../shared/db';
import { MODULES, enabledModules } from '../shared/modules';
import { planFor, tenantUsage, dirSizeBytes } from './quota';
import { backupDir } from '../shared/backup';
import { lastDrill } from './backup-health';
import { subscriptionView } from './subscription';

let initialized: ReturnType<typeof platformDb> | null = null;
function db() {
  const d = platformDb();
  if (initialized !== d) {
    d.exec(`CREATE TABLE IF NOT EXISTS tenant_telemetry (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL, user_id INTEGER, module TEXT NOT NULL,
      status INTEGER NOT NULL, duration_ms REAL NOT NULL, at TEXT NOT NULL, client TEXT NOT NULL DEFAULT 'desktop');
      CREATE INDEX IF NOT EXISTS telemetry_tenant_time ON tenant_telemetry(slug, at);
      CREATE TABLE IF NOT EXISTS tenant_usage_history (
        slug TEXT NOT NULL, day TEXT NOT NULL, usage TEXT NOT NULL, PRIMARY KEY(slug,day));
      CREATE TABLE IF NOT EXISTS tenant_owner_details (slug TEXT PRIMARY KEY, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenant_support (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
        by TEXT NOT NULL, at TEXT NOT NULL);`);
    if (!(d.prepare('PRAGMA table_info(tenant_telemetry)').all() as Array<{name: string}>).some(c => c.name === 'client')) d.exec("ALTER TABLE tenant_telemetry ADD COLUMN client TEXT NOT NULL DEFAULT 'desktop'");
    const supportColumns = new Set((d.prepare('PRAGMA table_info(tenant_support)').all() as Array<{name: string}>).map(c => c.name));
    for (const [name, definition] of Object.entries({ description: "TEXT NOT NULL DEFAULT ''", category: "TEXT NOT NULL DEFAULT 'issue'", priority: "TEXT NOT NULL DEFAULT 'normal'", source: "TEXT NOT NULL DEFAULT 'owner'" })) {
      if (!supportColumns.has(name)) d.exec(`ALTER TABLE tenant_support ADD COLUMN ${name} ${definition}`);
    }
    d.exec(`CREATE TABLE IF NOT EXISTS tenant_support_replies (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, slug TEXT NOT NULL,
      body TEXT NOT NULL, by TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS support_reply_ticket ON tenant_support_replies(slug,ticket_id);`);
    initialized = d;
  }
  return d;
}
const isoAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
let prunedDay = '';
export function recordTenantRequest(slug: string, userId: number | null, module: string, status: number, durationMs: number, client = 'desktop') {
  if (slug === 'default') return;
  try {
    const d = db(), at = new Date().toISOString();
    d.prepare('INSERT INTO tenant_telemetry(slug,user_id,module,status,duration_ms,at,client) VALUES(?,?,?,?,?,?,?)')
      .run(slug, userId, module, status, Math.max(0, durationMs), at, client === 'mobile' ? 'mobile' : 'desktop');
    if (prunedDay !== at.slice(0, 10)) {
      d.prepare('DELETE FROM tenant_telemetry WHERE at < ?').run(isoAgo(90));
      d.prepare('DELETE FROM tenant_usage_history WHERE day < ?').run(isoAgo(365).slice(0, 10));
      prunedDay = at.slice(0, 10);
    }
  } catch (e) { console.error('[analytics] telemetry write failed:', (e as Error).message); }
}
export function requestModule(url: string): string {
  const p = url.split('?')[0]!;
  if (p === '/api/auth/login') return 'login';
  if (/^\/api\/(hr|payroll|kiosk|employee)/.test(p)) return 'hr';
  if (/^\/api\/(production|job-orders|bom|qc|manufacturing|finished-products|parts-slips|rts)/.test(p)) return 'manufacturing';
  if (/^\/api\/(purchasing|goods-receipts|vendor-bills)/.test(p)) return 'purchasing';
  if (/^\/api\/(accounting|ledger|tax|petty-cash|finance)/.test(p)) return 'accounting';
  if (/^\/api\/(inventory|orders|suppliers|customers|locations|deliveries)/.test(p)) return 'inventory';
  if (/^\/api\/ai\b/.test(p)) return 'ai';
  if (/^\/api\/mail\b/.test(p)) return 'email';
  if (/^\/api\/quickbooks\b/.test(p)) return 'quickbooks';
  return 'core';
}
export function snapshotTenantUsage(slug: string) {
  const usage = withTenant(slug, () => tenantUsage(slug));
  db().prepare('INSERT INTO tenant_usage_history(slug,day,usage) VALUES(?,?,?) ON CONFLICT(slug,day) DO UPDATE SET usage=excluded.usage')
    .run(slug, new Date().toISOString().slice(0, 10), JSON.stringify(usage));
  return usage;
}
const detailsSchema = z.object({
  contact_name: z.string().max(150).default(''),
  contact_email: z.union([z.email(), z.literal('')]).default(''),
  notes: z.string().max(10000).default(''),
  warning_pct: z.number().min(1).max(100).default(80),
  inactive_days: z.number().int().min(1).max(365).default(14),
  sync_stale_hours: z.number().int().min(1).max(720).default(24),
  ai_cost_per_call_php: z.number().nonnegative().max(1000000).nullable().default(null),
}).strict();
export function ownerDetails(slug: string) {
  const row = db().prepare('SELECT details FROM tenant_owner_details WHERE slug=?').get(slug) as { details: string } | undefined;
  return detailsSchema.parse(row ? JSON.parse(row.details) : {});
}
export function saveOwnerDetails(slug: string, input: unknown) {
  const details = parseBody(detailsSchema, input);
  db().prepare('INSERT INTO tenant_owner_details(slug,details) VALUES(?,?) ON CONFLICT(slug) DO UPDATE SET details=excluded.details')
    .run(slug, JSON.stringify(details));
}
export const ticketSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(10000),
  category: z.enum(['bug', 'issue']).default('issue'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
}).strict();
export function addSupport(slug: string, input: unknown, by: string, source: 'owner' | 'tenant' = 'owner') {
  const v = source === 'tenant' ? { ...parseBody(ticketSchema, input), status: 'open' } : parseBody(ticketSchema.extend({
    description: z.string().trim().max(10000).default(''), status: z.enum(['open', 'in_progress', 'resolved']),
  }), input);
  const result = db().prepare('INSERT INTO tenant_support(slug,subject,status,by,at,description,category,priority,source) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(slug, v.subject, v.status, by, new Date().toISOString(), v.description, v.category, v.priority, source);
  return Number(result.lastInsertRowid);
}
export function listSupport(slug: string, tenantOnly = false) {
  const d = db();
  const tickets = d.prepare(`SELECT * FROM tenant_support WHERE slug=? ${tenantOnly ? "AND source='tenant'" : ''} ORDER BY id DESC`).all(slug) as Array<{id: number; status: string; priority: string; [key: string]: unknown}>;
  const replies = d.prepare('SELECT * FROM tenant_support_replies WHERE slug=? ORDER BY id').all(slug) as Array<{ticket_id: number; [key: string]: unknown}>;
  return tickets.map(t => ({ ...t, replies: replies.filter(r => r.ticket_id === t.id) }));
}
const ticketIdentitySchema = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export function replySupport(slug: string, id: number, input: unknown, by: string, source: 'owner' | 'tenant') {
  parseBody(ticketIdentitySchema, { id });
  const v = parseBody(z.object({ body: z.string().trim().min(1).max(10000) }).strict(), input);
  const d = db();
  if (!d.prepare(`SELECT 1 FROM tenant_support WHERE slug=? AND id=? ${source === 'tenant' ? "AND source='tenant'" : ''}`).get(slug, id)) return false;
  d.prepare('INSERT INTO tenant_support_replies(ticket_id,slug,body,by,source,at) VALUES(?,?,?,?,?,?)')
    .run(id, slug, v.body, by, source, new Date().toISOString());
  return true;
}
export function updateSupport(slug: string, id: number, input: unknown) {
  parseBody(ticketIdentitySchema, { id });
  const v = parseBody(z.object({ status: z.enum(['open', 'in_progress', 'resolved']) }).strict(), input);
  return db().prepare('UPDATE tenant_support SET status=? WHERE slug=? AND id=?').run(v.status, slug, id).changes > 0;
}
function backupHealth(slug: string) {
  const result: { last_snapshot_at: string | null; last_run_at: string | null; last_run_ok: boolean | null;
    restore_verified: boolean | null; restore_verified_at: string | null } =
    { last_snapshot_at: null, last_run_at: null, last_run_ok: null, restore_verified: null, restore_verified_at: null };
  // This workspace's copies in the last off-site restore drill (src/platform/backup-health.ts).
  const drill = lastDrill();
  const drilled = drill?.results.filter((r) => r.name === slug) ?? [];
  if (drill && drilled.length) { result.restore_verified = drilled.every((r) => r.ok); result.restore_verified_at = drill.at; }
  for (const kind of ['daily', 'manual']) {
    const dir = path.join(backupDir(), slug, kind);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.db'))) {
      const at = fs.statSync(path.join(dir, f)).mtime.toISOString();
      if (!result.last_snapshot_at || at > result.last_snapshot_at) result.last_snapshot_at = at;
    }
  }
  try {
    const status = JSON.parse(fs.readFileSync(path.join(backupDir(), 'status.json'), 'utf8'));
    const own = status.last_run?.results?.find((r: { name: string }) => r.name === slug);
    if (own) { result.last_run_at = status.last_run.at; result.last_run_ok = own.ok && !own.mirrorError; }
  } catch { /* unknown, not healthy */ }
  return result;
}
function syncHealth(slug: string, staleHours: number) {
  const conn = getDb(slug);
  const exists = (name: string) => !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const devices = exists('sync_nodes') ? conn.prepare('SELECT node_no,name,last_seen_at,revoked_at FROM sync_nodes WHERE revoked_at IS NULL').all() : [];
  const threshold = Date.now() - staleHours * 3600000;
  return { devices: devices.map(d => ({ node: d.node_no, name: d.name, last_seen_at: d.last_seen_at,
    stale: !d.last_seen_at || Date.parse(String(d.last_seen_at).replace(' ', 'T') + (String(d.last_seen_at).includes('Z') ? '' : 'Z')) < threshold })),
    pending: exists('sync_commands') ? Number(conn.prepare("SELECT COUNT(*) AS n FROM sync_commands WHERE state IN ('local','received','host_confirmed')").get()?.n ?? 0) : 0,
    conflicts: exists('sync_commands') ? Number(conn.prepare("SELECT COUNT(*) AS n FROM sync_commands WHERE state IN ('rejected','conflict') AND dismissed_at IS NULL").get()?.n ?? 0) : 0,
    device_local_queue_visibility: 'Only queues stored on this server are visible.' };
}
export function tenantAnalytics(t: TenantRow) {
  const d = db(), details = ownerDetails(t.slug);
  let usage: ReturnType<typeof tenantUsage> | null = null;
  try { usage = snapshotTenantUsage(t.slug); } catch { /* unavailable */ }
  const stats = d.prepare(`SELECT MAX(CASE WHEN user_id IS NOT NULL AND status BETWEEN 200 AND 299 THEN at END) AS last_activity,
    COUNT(DISTINCT CASE WHEN user_id IS NOT NULL AND status BETWEEN 200 AND 299 AND at>=? THEN user_id END) AS active_7,
    COUNT(DISTINCT CASE WHEN user_id IS NOT NULL AND status BETWEEN 200 AND 299 THEN user_id END) AS active_30,
    COUNT(*) AS requests, SUM(status>=500) AS errors, AVG(duration_ms) AS avg_ms FROM tenant_telemetry WHERE slug=? AND at>=?`)
    .get(isoAgo(7), t.slug, isoAgo(30))!;
  stats.last_activity = d.prepare('SELECT MAX(at) AS at FROM tenant_telemetry WHERE slug=? AND user_id IS NOT NULL AND status BETWEEN 200 AND 299').get(t.slug)?.at ?? null;
  const latencies = d.prepare('SELECT duration_ms FROM tenant_telemetry WHERE slug=? AND at>=? ORDER BY duration_ms')
    .all(t.slug, isoAgo(7)).map(r => Number(r.duration_ms));
  const moduleUsage = d.prepare(`SELECT module, COUNT(*) AS requests, COUNT(DISTINCT user_id) AS active_users,
    MAX(at) AS last_used FROM tenant_telemetry WHERE slug=? AND at>=? AND user_id IS NOT NULL AND status BETWEEN 200 AND 299 GROUP BY module`)
    .all(t.slug, isoAgo(30));
  moduleUsage.push({ module: 'mobile', ...d.prepare('SELECT COUNT(*) AS requests, COUNT(DISTINCT user_id) AS active_users, MAX(at) AS last_used FROM tenant_telemetry WHERE slug=? AND at>=? AND client=\'mobile\' AND user_id IS NOT NULL AND status BETWEEN 200 AND 299').get(t.slug, isoAgo(30)) });
  const enabled = [...enabledModules(t.slug)];
  const limits = planFor(t.slug).limits;
  const capacity = ['users', 'storage_mb', 'inventory_items', 'ai_calls_month'].map(k => {
    const key = k as keyof typeof limits;
    const cap = Number.isFinite(limits[key]) ? limits[key] : null;
    return { key: k, used: usage?.[key] ?? null, limit: cap,
      percent: cap === null || !usage ? null : cap === 0 ? usage[key] > 0 ? 100 : 0 : Math.round(usage[key] / cap * 1000) / 10 };
  });
  const storage = usage ? { uploads_mb: usage.storage_mb,
    database_mb: fs.existsSync(path.join(DATA_DIR, `${t.slug}.db`)) ? Math.round(fs.statSync(path.join(DATA_DIR, `${t.slug}.db`)).size / 104857.6) / 10 : null,
    kiosk_photos_mb: Math.round(dirSizeBytes(path.join(uploadDir(t.slug), 'kiosk-punches')) / 104857.6) / 10,
    folders: fs.existsSync(uploadDir(t.slug)) ? fs.readdirSync(uploadDir(t.slug), { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => ({ name: e.name, mb: Math.round(dirSizeBytes(path.join(uploadDir(t.slug), e.name)) / 104857.6) / 10 })) : [] } : null;
  const backup = backupHealth(t.slug), sync = syncHealth(t.slug, details.sync_stale_hours);
  const count = (sql: string) => withTenant(t.slug, () => queryOne<{ n: number }>(sql)?.n ?? 0);
  const onboarding = [
    { step: 'Additional login account', applicable: true, done: (usage?.users ?? 0) > 1 },
    { step: 'First inventory item', applicable: enabled.includes('inventory'), done: (usage?.inventory_items ?? 0) > 0 },
    { step: 'First employee', applicable: enabled.includes('hr'), done: (usage?.employees ?? 0) > 0 },
    { step: 'First stock transaction', applicable: enabled.includes('inventory'), done: count('SELECT COUNT(*) AS n FROM inventory_transactions') > 0 },
  ].filter(s => s.applicable);
  const alerts: { code: string; message: string }[] = [];
  capacity.filter(c => c.percent !== null && c.percent >= details.warning_pct).forEach(c => alerts.push({ code: 'capacity', message: `${c.key}: ${c.percent}% of allowance used` }));
  if (stats.last_activity && String(stats.last_activity) < isoAgo(details.inactive_days)) alerts.push({ code: 'inactive', message: 'No recent authenticated activity' });
  if (!stats.last_activity) alerts.push({ code: 'activity_unknown', message: 'No activity recorded since telemetry was enabled' });
  if (!backup.last_snapshot_at || backup.last_snapshot_at < isoAgo(2)) alerts.push({ code: 'backup', message: 'No recent local backup snapshot' });
  if (backup.last_run_ok === false) alerts.push({ code: 'backup_failure', message: 'Latest recorded backup attempt failed' });
  if (backup.restore_verified === false) alerts.push({ code: 'restore_drill_failure', message: 'The last off-site restore drill failed' });
  if (sync.devices.some(d => d.stale)) alerts.push({ code: 'sync', message: 'One or more enrolled devices have stale heartbeats' });
  if (Number(stats.errors) > 0) alerts.push({ code: 'errors', message: 'Server errors recorded in the last 30 days' });
  const trialLapsed = t.status === 'trial' && t.trial_ends_at && Date.parse(t.trial_ends_at) < Date.now();
  if (t.status === 'past_due' || trialLapsed) alerts.push({ code: 'past_due', message: 'Tenant is read-only due to subscription status' });
  const history = d.prepare('SELECT day,usage FROM tenant_usage_history WHERE slug=? ORDER BY day DESC LIMIT 90').all(t.slug)
    .map(r => ({ day: r.day, usage: JSON.parse(String(r.usage)) })).reverse();
  const first = history[0], last = history[history.length - 1];
  const elapsed = first && last ? (Date.parse(String(last.day)) - Date.parse(String(first.day))) / 86400000 : 0;
  const growth = elapsed > 0 ? (Number(last!.usage.storage_mb) - Number(first!.usage.storage_mb)) / elapsed : null;
  return { generated_at: new Date().toISOString(), details, usage, capacity, storage, storage_growth: { mb_per_day: growth, estimated_days_to_limit: growth !== null && growth > 0 && usage && Number.isFinite(limits.storage_mb) ? Math.max(0, (limits.storage_mb - usage.storage_mb) / growth) : null }, engagement: stats,
    performance: { p95_ms_7_days: latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null },
    login_activity: d.prepare("SELECT SUM(status BETWEEN 200 AND 299) AS successful, SUM(status=401) AS failed FROM tenant_telemetry WHERE slug=? AND module='login' AND at>=?").get(t.slug, isoAgo(30)),
    daily_activity: d.prepare('SELECT substr(at,1,10) AS day, COUNT(DISTINCT CASE WHEN status BETWEEN 200 AND 299 THEN user_id END) AS active_users, COUNT(*) AS requests, SUM(status>=500) AS errors FROM tenant_telemetry WHERE slug=? GROUP BY substr(at,1,10) ORDER BY day').all(t.slug),
    module_usage: enabled.map(module => ({ module, ...moduleUsage.find(r => r.module === module), requests: Number(moduleUsage.find(r => r.module === module)?.requests ?? 0) })),
    onboarding, sync, backup, history, alerts,
    subscription_history: listProvisioningLog(t.slug, 100).filter(e => e.action === 'subscription' || e.action === 'modules' || e.action === 'plan' || (e.action === 'update' && /plan=|modules=/.test(e.detail ?? ''))),
    ai_estimated_cost_php: details.ai_cost_per_call_php === null || !usage ? null : Math.round(usage.ai_calls_month * details.ai_cost_per_call_php * 100) / 100,
    billing: { connected: false, monthly_quote_php: subscriptionView(t)?.monthly_total ?? null,
      collected_revenue_php: null, paid_through: null, renewal_at: null, payment_history: [],
      note: 'Payment provider not connected; quotes are not collected revenue.' },
    support: listSupport(t.slug),
    tracking_started_at: d.prepare('SELECT MIN(at) AS at FROM tenant_telemetry WHERE slug=?').get(t.slug)?.at ?? null };
}
