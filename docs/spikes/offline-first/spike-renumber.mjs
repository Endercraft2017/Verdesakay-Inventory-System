import { DatabaseSync } from 'node:sqlite';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, note TEXT);
  CREATE TABLE lines(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, sku TEXT);
  CREATE TABLE tags(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, hits INTEGER DEFAULT 1);
  INSERT INTO orders(id, number) VALUES (9*${2**37}+3, 'SO-FROM-NODE9');`); // another node's row already replicated

// Allocator: node 7. In replay mode it would consume a recorded plan instead of the counter.
const BASE = 7 * 2 ** 37; const counters = new Map(); const plan = [];
const alloc = t => { const n = (counters.get(t) ?? 0) + 1; counters.set(t, n); plan.push([t, BASE + n]); return BASE + n; };
const TABLES = new Set(['orders', 'lines', 'tags']);
const insertTarget = sql => (/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(sql) || [])[1];

// Statement wrapper = what the db Proxy's prepare() would hand back in node mode.
function prepare(sql) {
  const stmt = db.prepare(sql), table = insertTarget(sql);
  if (!table || !TABLES.has(table)) return stmt;
  const hw = db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 1)`);
  return { run(...p) {
    const before = hw.get().m; const r = stmt.run(...p);
    const fresh = db.prepare(`SELECT id FROM ${table} WHERE id > ? ORDER BY id`).all(before).map(x => x.id);
    let last = r.lastInsertRowid;
    for (const tmp of fresh) { const id = alloc(table);
      db.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(id, tmp); if (Number(tmp) === Number(last)) last = id; }
    return { ...r, lastInsertRowid: last };
  } };
}

const s = db.createSession();
db.exec('BEGIN');
// multi-line insert + child rows through lastInsertRowid (the pattern used 87 times)
const o = prepare(`INSERT INTO orders
    (number, note) VALUES (?, ?)`).run('SO-P7-0001', 'offline order');
ok(o.lastInsertRowid === BASE + 1, `parent got node-range id ${o.lastInsertRowid}`);
prepare('INSERT INTO lines (order_id, sku) VALUES (?, ?)').run(o.lastInsertRowid, 'BOLT');
prepare('INSERT INTO lines (order_id, sku) VALUES (?, ?)').run(o.lastInsertRowid, 'NUT');
// multi-row VALUES and INSERT ... SELECT
prepare(`INSERT INTO tags (name) VALUES ('a'), ('b')`).run();
prepare(`INSERT INTO tags (name) SELECT sku FROM lines`).run();
// INSERT OR IGNORE hitting an existing row, and an upsert that updates instead of inserting
const ig = prepare(`INSERT OR IGNORE INTO tags (name) VALUES ('a')`).run();
prepare(`INSERT INTO tags (name) VALUES ('b') ON CONFLICT(name) DO UPDATE SET hits = hits + 1`).run();
db.exec('COMMIT');
const cs = s.changeset(); s.close();

const lines = db.prepare('SELECT * FROM lines ORDER BY id').all();
ok(lines.every(l => l.order_id === BASE + 1) && lines[0].id === BASE + 1 && lines[1].id === BASE + 2, 'children reference the renumbered parent; own ids in node range');
const tags = db.prepare('SELECT * FROM tags ORDER BY id').all();
ok(tags.length === 4 && tags.every(t => t.id > BASE && t.id < BASE + 2 ** 37), 'multi-row VALUES + INSERT…SELECT all renumbered (' + tags.map(t => t.name + '=' + (t.id - BASE)).join(' ') + ')');
ok(ig.changes === 0 && tags.find(t => t.name === 'b').hits === 2, 'OR IGNORE / ON CONFLICT DO UPDATE allocate nothing and keep existing ids');
ok(db.prepare('SELECT count(*) c FROM orders WHERE id > ?').get(BASE + 2 ** 37).c === 1, 'node 9 row untouched');

// The changeset must describe final ids only (no temp ids), so replicas never see them.
const replica = new DatabaseSync(':memory:');
replica.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, note TEXT);
  CREATE TABLE lines(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, sku TEXT);
  CREATE TABLE tags(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, hits INTEGER DEFAULT 1);`);
replica.applyChangeset(cs);
const ids = ['orders', 'lines', 'tags'].flatMap(t => replica.prepare(`SELECT id FROM ${t}`).all().map(r => r.id));
ok(ids.length === 7 && ids.every(id => id > BASE && id < BASE + 2 ** 37), 'changeset carries only final node-range ids (temp ids cancelled out): ' + ids.length + ' rows');
console.log('plan:', JSON.stringify(plan.map(([t, id]) => [t, id - BASE])));
