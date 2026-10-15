import {it,expect} from 'vitest';
import {setupApp,cleanup} from './helpers';
it('upgrades template history foreign keys without losing saved snapshots',async()=>{
 const ctx=await setupApp();try{
  const mod=await import('../src/shared/db');
  const before=mod.queryAll('SELECT id,template_id,snapshot,label,created_at FROM doc_studio_versions ORDER BY id');expect(before.length).toBeGreaterThan(0);
  mod.db.exec(`DROP TRIGGER doc_studio_version_before;DROP TRIGGER doc_studio_version_after;DROP TRIGGER doc_studio_version_insert;
    ALTER TABLE doc_studio_versions RENAME TO saved_history;
    CREATE TABLE doc_studio_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,snapshot TEXT NOT NULL,label TEXT NOT NULL DEFAULT 'Saved template',created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO doc_studio_versions SELECT * FROM saved_history;DROP TABLE saved_history;
    CREATE INDEX idx_doc_versions ON doc_studio_versions(template_id,id);`);
  mod.setSetting('schema_version',76);mod.closeAllConnections();mod.init();
  const key=mod.queryAll<{on_update:string}>('PRAGMA foreign_key_list(doc_studio_versions)')[0];expect(key?.on_update).toBe('CASCADE');
  for(const snapshot of before)expect(mod.queryOne('SELECT id,template_id,snapshot,label,created_at FROM doc_studio_versions WHERE id=?',(snapshot as any).id)).toEqual(snapshot);
  expect(mod.queryAll('PRAGMA foreign_key_check')).toEqual([]);
 }finally{cleanup(ctx);}
});
