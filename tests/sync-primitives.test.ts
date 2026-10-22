/** Offline-first sync building blocks (src/sync/): changeset invert/filter, HLC, ULID, the
 *  write-target parser and the SQL clock override. Pure — no app, no tenant DB. */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { invertChangeset, filterChangeset, changesetTables } from '../src/sync/changeset';
import { formatHlc, parseHlc, receiveHlc, tickHlc, ulid } from '../src/sync/ids-util';
import { writeTarget } from '../src/sync/ids';
import { isCloudOnlySetting, isReplicated } from '../src/sync/node';
import { installClockOverride } from '../src/sync/clock';
import { syncStore } from '../src/shared/sync-context';

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, note TEXT, photo BLOB, price REAL);
          CREATE TABLE stock(id INTEGER PRIMARY KEY, item_id INTEGER, qty INTEGER NOT NULL);
          CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER);
          INSERT INTO items VALUES (1, 'bolt', 'old', x'00ff', 1.5); INSERT INTO stock VALUES (1, 1, 10);`);
  return d;
}
const snap = (d: DatabaseSync) => JSON.stringify(
  ['items', 'stock', 'sessions'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),
  (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v),
);
function capture(d: DatabaseSync, sql: string): Uint8Array {
  const s = d.createSession();
  d.exec(sql);
  const c = s.changeset();
  s.close();
  return c;
}
const CHANGE = `UPDATE stock SET qty = qty - 5 WHERE id = 1;
  UPDATE items SET note = 'edited', price = NULL WHERE id = 1;
  INSERT INTO items VALUES (962072674305, 'washer', NULL, x'dead', 0.25);
  DELETE FROM items WHERE id = 1 AND 0;
  INSERT INTO sessions VALUES ('tok', 1);`;

describe('changeset invert', () => {
  it('undoes inserts, updates (incl. NULL / blob / real) and restores the exact prior state', () => {
    const d = db();
    const before = snap(d);
    const c = capture(d, CHANGE);
    expect(snap(d)).not.toBe(before);
    expect(d.applyChangeset(invertChangeset(c))).toBe(true);
    expect(snap(d)).toBe(before);
  });

  it('undoes a delete', () => {
    const d = db();
    const before = snap(d);
    const c = capture(d, 'DELETE FROM stock WHERE id = 1');
    d.applyChangeset(invertChangeset(c));
    expect(snap(d)).toBe(before);
  });

  it('is its own inverse, byte for byte', () => {
    const c = capture(db(), CHANGE);
    expect(Buffer.from(invertChangeset(invertChangeset(c))).equals(Buffer.from(c))).toBe(true);
  });
});

describe('changesets and foreign-key actions', () => {
  // Why src/sync/rebase.ts applies changesets with foreign keys off: the session already
  // recorded the rows an ON DELETE SET NULL / CASCADE changed, so letting the action fire again
  // while undoing edits a row the changeset is about to touch — and the apply aborts.
  const fkDb = () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE tx (id INTEGER PRIMARY KEY, change INTEGER);
      CREATE TABLE flag (id INTEGER PRIMARY KEY, tx_id INTEGER REFERENCES tx(id) ON DELETE SET NULL);`);
    return d;
  };
  const cmd = 'INSERT INTO tx VALUES (1, -5); INSERT INTO flag VALUES (1, 1);';

  it('undoing with FK actions on conflicts', () => {
    const d = fkDb();
    const undo = invertChangeset(capture(d, cmd));
    expect(d.applyChangeset(undo)).toBe(false);
  });

  it('undoing with FK actions off restores the prior state exactly', () => {
    const d = fkDb();
    const undo = invertChangeset(capture(d, cmd));
    d.exec('PRAGMA foreign_keys = OFF');
    expect(d.applyChangeset(undo)).toBe(true);
    d.exec('PRAGMA foreign_keys = ON');
    expect(d.prepare('SELECT (SELECT COUNT(*) FROM tx) + (SELECT COUNT(*) FROM flag) AS n').get()).toEqual({ n: 0 });
    expect(d.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('changeset filter', () => {
  it('drops whole tables and keeps the rest applicable', () => {
    const d = db();
    const c = capture(d, CHANGE);
    expect(changesetTables(c)).toEqual({ stock: 1, items: 2, sessions: 1 });
    const kept = filterChangeset(c, (t) => t !== 'sessions');
    expect(changesetTables(kept)).toEqual({ stock: 1, items: 2 });
    const other = db();
    expect(other.applyChangeset(kept)).toBe(true);
    expect(other.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(other.prepare('SELECT qty FROM stock').get()).toEqual({ qty: 5 });
  });

  it('filters everything out to an empty changeset', () => {
    const c = capture(db(), "INSERT INTO sessions VALUES ('x', 2)");
    expect(filterChangeset(c, (t) => t !== 'sessions').length).toBe(0);
  });
});

describe('hybrid logical clock', () => {
  it('never goes backwards when the PC clock does', () => {
    const a = tickHlc(null, 7, 1000);
    const b = tickHlc(a, 7, 900); // clock set back
    const c = tickHlc(b, 7, 900);
    expect(formatHlc(a) < formatHlc(b)).toBe(true);
    expect(formatHlc(b) < formatHlc(c)).toBe(true);
    expect(parseHlc(formatHlc(c))).toEqual(c);
  });

  it('orders local events after a remote event from a PC whose clock runs ahead', () => {
    const remote = { ms: 5000, counter: 3, node: 2 };
    const merged = receiveHlc(tickHlc(null, 7, 1000), remote, 7, 1000);
    expect(formatHlc(merged) > formatHlc(remote)).toBe(true);
    expect(formatHlc(tickHlc(merged, 7, 1001)) > formatHlc(merged)).toBe(true);
  });
});

describe('ulid', () => {
  it('is 26 Crockford chars, time-ordered, and encodes the given time only in its prefix', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(ulid(1_000).slice(0, 10)).toBe(a.slice(0, 10));
  });
});

describe('what never leaves the cloud', () => {
  it('tables and settings of online-only features, and every credential', () => {
    for (const t of ['doc_studio_drafts', 'doc_studio_rooms', 'doc_studio_presence', 'doc_studio_comments', 'doc_studio_versions', 'password_resets', 'qbo_links', 'mail_log', 'ai_messages', 'sessions', 'push_subscriptions', 'sync_nodes']) {
      expect(isReplicated(t)).toBe(false);
    }
    for (const k of ['_secret_key', 'vapid_keys', 'ai_api_key', 'ai_config', 'mail_settings', 'mail_smtp_pass', 'qbo_tokens', 'qbo_config']) {
      expect(isCloudOnlySetting(k)).toBe(true);
      expect(isReplicated('settings', [k])).toBe(false);
    }
    // What an installed PC does need still travels.
    for (const k of ['company_profile', 'clock_hmac_key', 'payroll_policy', 'sync_main_host']) expect(isReplicated('settings', [k])).toBe(true);
    for (const t of ['doc_studio_library', 'users', 'inventory_items', 'kiosk_devices']) expect(isReplicated(t)).toBe(true);
  });
});

describe('writeTarget', () => {
  it('finds the written table for every INSERT / UPDATE / DELETE shape in use', () => {
    expect(writeTarget('INSERT INTO orders (a) VALUES (?)')).toBe('orders');
    expect(writeTarget('\n  INSERT OR IGNORE INTO tags (name) VALUES (?)')).toBe('tags');
    expect(writeTarget('insert into "tx" ("change") values (?)')).toBe('tx'); // Kysely
    expect(writeTarget('REPLACE INTO settings (key) VALUES (?)')).toBe('settings');
    expect(writeTarget('UPDATE inventory_stock SET quantity = 1')).toBe('inventory_stock');
    expect(writeTarget('update "users" set "x" = ?')).toBe('users');
    expect(writeTarget('DELETE FROM sessions WHERE token = ?')).toBe('sessions');
    expect(writeTarget('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe('?');
    expect(writeTarget('SELECT * FROM orders')).toBeNull();
    expect(writeTarget('WITH x AS (SELECT 1) SELECT * FROM x')).toBeNull();
  });
});

describe('SQL clock override', () => {
  it("makes 'now' the command clock — also in column DEFAULTs — and changes nothing else", () => {
    const d = new DatabaseSync(':memory:');
    installClockOverride(d);
    d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT DEFAULT (datetime('now')), day TEXT DEFAULT (date('now')))");
    const clock = '2026-09-29 08:45:00.000';
    syncStore.run({ mode: 'replay', clock, plan: [], cursor: { id: 0, seq: 0 } }, () => {
      d.exec('INSERT INTO t (id) VALUES (1)');
      expect(d.prepare("SELECT datetime('now', '-1 day') AS v").get()).toEqual({ v: '2026-09-28 08:45:00' });
      expect(d.prepare('SELECT datetime() AS v').get()).toEqual({ v: '2026-09-29 08:45:00' });
      expect(d.prepare("SELECT strftime('%H:%M', 'now') AS v").get()).toEqual({ v: '08:45' });
      expect(d.prepare("SELECT date('2026-01-31', '+1 day') AS v").get()).toEqual({ v: '2026-02-01' });
    });
    expect(d.prepare('SELECT at, day FROM t').get()).toEqual({ at: '2026-09-29 08:45:00', day: '2026-09-29' });
    const live = (d.prepare("SELECT datetime('now') AS v").get() as { v: string }).v;
    expect(Math.abs(Date.parse(live.replace(' ', 'T') + 'Z') - Date.now())).toBeLessThan(5000);
  });
});
