import { DatabaseSync } from 'node:sqlite';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE tx(id INTEGER PRIMARY KEY AUTOINCREMENT, change INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), day TEXT DEFAULT (date('now')));`);

// ---- Request clock: override datetime()/date() so 'now' = the command's occurred_at. ----
const helper = new DatabaseSync(':memory:');       // un-overridden SQLite for the real date math
let clock = null;                                   // null = live server time
for (const fn of ['datetime', 'date', 'time', 'julianday']) {
  const stmts = new Map();
  db.function(fn, { varargs: true, deterministic: false }, (...args) => {
    if (clock && args[0] === 'now') args[0] = clock;
    const sql = `SELECT ${fn}(${args.map(() => '?').join(',')}) AS v`;
    if (!stmts.has(sql)) stmts.set(sql, helper.prepare(sql));
    return stmts.get(sql).get(...args).v;
  });
}
clock = '2026-09-29 16:45:00';
db.exec(`INSERT INTO tx(change) VALUES (-5)`);
let r = db.prepare('SELECT * FROM tx').get();
ok(r.created_at === '2026-09-29 16:45:00' && r.day === '2026-09-29', `column DEFAULT (datetime('now')) uses the command clock: ${r.created_at} / ${r.day}`);
ok(db.prepare(`SELECT datetime('now','-1 day') v`).get().v === '2026-09-28 16:45:00', 'modifiers still work on the command clock');
ok(db.prepare(`SELECT datetime('2026-01-01','+1 month') v`).get().v === '2026-02-01 00:00:00', 'non-now calls behave like built-in');
clock = null;
const live = db.prepare(`SELECT datetime('now') v`).get().v;
ok(Math.abs(Date.parse(live + 'Z') - Date.now()) < 5000, 'clock=null falls back to real server time');

// ---- ID injection: node-range IDs on INSERT without an explicit id. ----
const NODE = 7, BASE = NODE * 2 ** 37; let counter = 0; const plan = [];
function injectId(sql, params) {
  const m = /^\s*INSERT\s+INTO\s+("?)(\w+)\1\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
  if (!m || /\bid\b/i.test(m[3])) return [sql, params];
  const id = BASE + ++counter; plan.push([m[2], id]);
  return [sql.replace(m[0], m[0].replace(`(${m[3]})`, `(id, ${m[3]})`) ) .replace(/VALUES\s*\(/i, 'VALUES (?, '), [id, ...params]];
}
const [sql, params] = injectId('INSERT INTO tx (change) VALUES (?)', [3]);
db.prepare(sql).run(...params);
const last = db.prepare('SELECT max(id) m FROM tx').get().m;
ok(last === BASE + 1 && Number.isSafeInteger(last), `node-range id injected: ${last} (= 7*2^37+1, safe integer)`);
// Another node's higher-range row replicated in must not disturb our allocation
db.prepare('INSERT INTO tx (id, change) VALUES (?, ?)').run(9 * 2 ** 37 + 4, 1);
const [sql2, p2] = injectId('INSERT INTO tx (change) VALUES (?)', [4]); db.prepare(sql2).run(...p2);
ok(db.prepare('SELECT id FROM tx WHERE change=4').get().id === BASE + 2, 'allocation unaffected by other nodes\' rows (AUTOINCREMENT would have jumped to node 9\'s range)');
const auto = db.prepare('INSERT INTO tx (change) VALUES (5)').run().lastInsertRowid;
ok(Number(auto) === 9 * 2 ** 37 + 5, `confirms plain AUTOINCREMENT is unsafe: it gave ${auto} (node 9's range)`);
ok(65535 * 2 ** 37 + 2 ** 37 - 1 <= Number.MAX_SAFE_INTEGER, 'max node (65535) x max counter stays within JS safe integers');
console.log('allocation plan:', JSON.stringify(plan));
