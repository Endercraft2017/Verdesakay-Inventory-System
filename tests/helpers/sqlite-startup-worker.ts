/** Disposable process driver. Barriers live here, never in application startup. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [mode, output, marker] = process.argv.slice(2) as [string, string, string];
if (!mode || !output || !marker) throw new Error('Disposable startup driver requires mode, output and marker');
const signal = (name: string) => fs.writeFileSync(path.join(output, name), 'ready');
function wait() {
  const deadline = Date.now() + 25_000;
  while (!fs.existsSync(path.join(output, 'release'))) {
    if (Date.now() > deadline) throw new Error('Disposable startup barrier expired');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
let paused = false;
if (mode === 'warm-hold') DatabaseSync.prototype.exec = function (sql: string) {
  if (!paused && sql.includes('DROP TRIGGER IF EXISTS doc_studio_cleanup_template')) {
    paused = true; originalExec.call(this, 'BEGIN IMMEDIATE'); signal('held'); wait();
    try { return originalExec.call(this, sql); }
    finally { originalExec.call(this, 'COMMIT'); }
  }
  return originalExec.call(this, sql);
};
if (['fresh-hold', 'open', 'catalog-hold', 'catalog-open'].includes(mode)) DatabaseSync.prototype.prepare = function (sql: string) {
  const statement = originalPrepare.call(this, sql);
  if (sql === 'SELECT COUNT(*) AS c FROM users') {
    const get = statement.get.bind(statement);
    statement.get = (...args: any[]) => { const row = get(...args); if (row?.c === 0) signal(marker + '-empty'); return row; };
  }
  if (mode === 'fresh-hold' && sql.includes('INSERT INTO users (username, full_name, password_hash') ||
      mode === 'catalog-hold' && sql.includes('INSERT INTO platform_users (username, password_hash')) {
    const run = statement.run.bind(statement);
    statement.run = (...args: any[]) => { if (!paused) { paused = true; signal('held'); wait(); } return run(...args); };
  }
  return statement;
};
const result: Record<string, unknown> = {};
let close = () => {};
try {
  if (mode.startsWith('lock-')) {
    const { withDatabaseInitialization } = await import('../../src/shared/sqlite-initialization');
    signal(marker + '-started'); const started = Date.now();
    try {
      withDatabaseInitialization(process.env.DB_PATH!, () => { result.entered = true; if (mode === 'lock-hold') { signal('held'); wait(); } });
      result.ok = true;
    } catch (error: any) { result.ok = false; result.errcode = error.errcode; }
    result.elapsed_ms = Date.now() - started;
  } else if (mode === 'catalog-hold' || mode === 'catalog-open') {
    process.env.PLATFORM_ADMIN_USERNAME = 'startup-operator';
    process.env.PLATFORM_ADMIN_PASSWORD = 'Synthetic startup administrator fixture';
    const p = await import('../../src/platform/platform'); close = p._resetPlatformDb;
    signal(marker + '-started'); const ready = p.platformDb();
    result.operators = ready.prepare('SELECT COUNT(*) AS n FROM platform_users').get()!.n;
    result.busy_timeout = ready.prepare('PRAGMA busy_timeout').get()!.timeout; result.ok = true;
  } else if (mode === 'catalog-memory') {
    process.chdir(output);
    const p = await import('../../src/platform/platform'); close = p._resetPlatformDb;
    const ready = p.platformDb(); result.ok = true; result.busy_timeout = ready.prepare('PRAGMA busy_timeout').get()!.timeout;
    result.memory_lock_files = fs.readdirSync(output).filter(name => name.endsWith('.startup-lock'));
  } else if (mode === 'catalog-retry') {
    const p = await import('../../src/platform/platform');
    p.platformDb(); p._resetPlatformDb();
    const raw = new DatabaseSync(process.env.PLATFORM_DB_PATH!);
    raw.exec("CREATE TRIGGER startup_seed_refusal BEFORE INSERT ON platform_users BEGIN SELECT RAISE(ABORT,'Synthetic startup seed failure'); END");
    process.env.PLATFORM_ADMIN_USERNAME = 'startup-operator';
    process.env.PLATFORM_ADMIN_PASSWORD = 'Synthetic startup administrator fixture';
    try { p.platformDb(); result.first_failed = false; } catch { result.first_failed = true; }
    raw.exec('DROP TRIGGER startup_seed_refusal'); raw.close();
    const ready = p.platformDb(); result.operators = ready.prepare('SELECT COUNT(*) AS n FROM platform_users').get()!.n;
    result.busy_timeout = ready.prepare('PRAGMA busy_timeout').get()!.timeout; result.ok = true; close = p._resetPlatformDb;
  } else {
    if (mode === 'memory') process.chdir(output);
    const d = await import('../../src/shared/db'); close = d.closeAllConnections;
    signal(marker + '-started'); const conn = d.getDb();
    if (mode === 'seed') {
      d.setSetting('startup_sentinel', 'Synthetic saved setting');
      const employee = Number(conn.prepare("INSERT INTO employees(employee_no,name) VALUES('STARTUP-1','Synthetic Startup Employee')").run().lastInsertRowid);
      const period = Number(conn.prepare("INSERT INTO attendance_periods(label,start_date,end_date) VALUES('STARTUP-1','2032-01-01','2032-01-15')").run().lastInsertRowid);
      const form = conn.prepare("SELECT id FROM form_definitions WHERE slug='hr_payroll'").get();
      if (!form || typeof form.id !== 'number') throw new Error('Disposable payroll form fixture is missing');
      conn.prepare("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'paid','STARTUP-1',1)")
        .run(form.id, 'STARTUP-PAYROLL-1', JSON.stringify({ employee_id: employee, cutoff_id: period, payroll_period: 'STARTUP-1', total_earnings: 1000, net_pay: 1000 }));
    }
    result.ok = true; result.busy_timeout = conn.prepare('PRAGMA busy_timeout').get()!.timeout;
    result.transaction_open = conn.isTransaction;
    if (mode === 'memory') result.memory_lock_files = fs.readdirSync(output).filter(name => name.endsWith('.startup-lock'));
  }
} catch (error: any) {
  result.ok = false; result.errcode = error.errcode; result.message = error.message;
  process.exitCode = 1;
} finally {
  close(); fs.writeFileSync(path.join(output, marker + '.json'), JSON.stringify(result));
}
