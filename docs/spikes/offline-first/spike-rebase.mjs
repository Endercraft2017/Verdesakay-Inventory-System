import { DatabaseSync } from 'node:sqlite';
import { invertChangeset } from './invert.mjs';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const mk = () => { const d = new DatabaseSync(':memory:');
  d.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, note TEXT, photo BLOB, price REAL);
    CREATE TABLE stock(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), qty INTEGER NOT NULL);
    CREATE TABLE tx(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), change INTEGER, reason TEXT);
    INSERT INTO items VALUES (1,'bolt','old note',x'00ff',1.5); INSERT INTO stock VALUES (1,1,10);`); return d; };
const snap = d => JSON.stringify(['items','stock','tx'].map(t => d.prepare(`SELECT * FROM ${t} ORDER BY id`).all()),
  (k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : typeof v === 'bigint' ? String(v) : v);
const capture = (d, sql) => { const s = d.createSession(); d.exec(sql); const c = s.changeset(); s.close(); return c; };
const N7 = 7 * 2 ** 37; // node 7's ID range

// A pending local command on node 7: withdraw 5, new tx row, edit note, new item with blob, delete nothing.
const node = mk(), cloud = mk(); const before = snap(node);
const pendingSql = `UPDATE stock SET qty = qty - 5 WHERE id=1;
  INSERT INTO tx VALUES (${N7 + 1}, 1, -5, 'Released to JO-00042');
  UPDATE items SET note='edited offline', price=NULL WHERE id=1;
  INSERT INTO items VALUES (${N7 + 1}, 'washer', NULL, x'deadbeef', 0.25);`;
const local = capture(node, pendingSql);

// 1) invert restores exactly the pre-command state
node.applyChangeset(invertChangeset(local));
ok(snap(node) === before, 'apply(invert(local)) restores the exact prior state (ints, text, NULL, blob, real)');
// 2) invert(invert(c)) == c
ok(Buffer.compare(Buffer.from(invertChangeset(invertChangeset(local))), Buffer.from(local)) === 0, 'invert(invert(c)) is byte-identical to c');

// 3) full rebase: redo local, then cloud confirms another site's +10 receipt; node rebases.
node.exec(pendingSql);
const effectA = capture(cloud, `UPDATE stock SET qty = qty + 10 WHERE id=1; INSERT INTO tx VALUES (1, 1, 10, 'GRN-00003');`);
node.exec('BEGIN');
node.applyChangeset(invertChangeset(local));             // roll back optimistic work
node.applyChangeset(effectA);                            // apply confirmed effect in authority order
const rerun = capture(node, pendingSql);                 // re-run pending command (same allocation plan IDs)
node.exec('COMMIT');
ok(node.prepare('SELECT qty FROM stock WHERE id=1').get().qty === 15, 'rebase: 10 +10 (confirmed) -5 (pending) = 15, nothing lost');
// 4) the cloud replays the same command -> converges with node
cloud.exec(pendingSql);
ok(snap(cloud) === snap(node), 'cloud replay of the command converges to the node\'s rebased state');
// 5) conflict detection: applying a stale effect whose old values don't match is reported, not silent
const other = mk(); other.exec('UPDATE stock SET qty = 99 WHERE id=1');
const conflicts = []; other.applyChangeset(effectA, { onConflict: (t) => { conflicts.push(t); return 2; /* ABORT? see below */ } });
ok(conflicts.length > 0, 'stale-effect apply surfaces a conflict callback (type ' + conflicts.join(',') + ')');
