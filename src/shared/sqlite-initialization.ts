import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Only cold initialization waits. Returned business connections retain zero-wait writes. */
export const INITIALIZATION_WAIT_MS = 10_000;

/** Serialize synchronous initialization without nesting the business DB's migration transactions.
 * SQLite owns the process lock, including release after a crash. Keep this technical file in
 * place: unlinking a live lock path could let another process acquire a different inode. */
export function withDatabaseInitialization<T>(file: string, initialize: () => T): T {
  // Each :memory: connection is private; it must not create a filesystem lock.
  if (file === ':memory:') return initialize();
  const filename = path.resolve(file);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const gate = new DatabaseSync(filename + '.startup-lock');
  let locked = false;
  try {
    gate.exec(`PRAGMA busy_timeout = ${INITIALIZATION_WAIT_MS}; BEGIN IMMEDIATE;`);
    locked = true;
    return initialize();
  } finally {
    try { if (locked) gate.exec('ROLLBACK'); }
    finally { gate.close(); }
  }
}
