const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(':memory:');
d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
const s = d.createSession(); d.exec("UPDATE t SET v='b'"); const c = s.changeset(); s.close();
const d2 = new DatabaseSync(':memory:'); d2.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
d2.applyChangeset(c);
d.function('datetime', { varargs: true }, () => 'x');
console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: d.prepare('select sqlite_version() v').get().v,
  changesetBytes: c.length, applied: d2.prepare('select v from t').get().v, udfOverride: d.prepare("select datetime('now') v").get().v }));
