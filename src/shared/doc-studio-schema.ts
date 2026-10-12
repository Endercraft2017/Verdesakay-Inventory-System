import type { DatabaseSync } from 'node:sqlite';

/** Tenant-local durable studio data. Called after the existing template columns migrate. */
export function createStudioSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_studio_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Saved template',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_doc_versions ON doc_studio_versions(template_id,id);
    CREATE TABLE IF NOT EXISTS doc_studio_drafts (
      document_key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(document_key,user_id)
    );
    CREATE TABLE IF NOT EXISTS doc_studio_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('style','asset','brand')),
      name TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS doc_studio_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_key TEXT NOT NULL,
      block_id TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_doc_comments ON doc_studio_comments(document_key,id);
    CREATE TABLE IF NOT EXISTS doc_studio_rooms (
      document_key TEXT PRIMARY KEY, snapshot TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, saved_revision TEXT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS doc_studio_presence (
      document_key TEXT NOT NULL, client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      touched_at INTEGER NOT NULL, PRIMARY KEY(document_key,client_id)
    );
  `);
  for(const [table,prefix] of [['doc_templates','template'],['form_definitions','form']]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS doc_studio_cleanup_${prefix} AFTER DELETE ON ${table} BEGIN
      DELETE FROM doc_studio_drafts WHERE document_key='${prefix}:'||OLD.id;
      DELETE FROM doc_studio_rooms WHERE document_key='${prefix}:'||OLD.id;
      DELETE FROM doc_studio_comments WHERE document_key='${prefix}:'||OLD.id;
      DELETE FROM doc_studio_presence WHERE document_key='${prefix}:'||OLD.id;
    END;`);
  }
  const snapshot = (row: string) => `json_object('name',${row}.name,'type',${row}.type,'period',${row}.period,
    'body',${row}.body,'copiesPerRecord',${row}.copies_per_record,'recordsPerPage',${row}.records_per_page,
    'tileFill',${row}.tile_fill,'continuous',${row}.tile_continuous,'repeatCount',${row}.repeat_count,'gapXmm',${row}.grid_gap_x_mm,'gapYmm',${row}.grid_gap_y_mm)`;
  for (const [event, row, name] of [['BEFORE UPDATE','OLD','before'],['AFTER UPDATE','NEW','after'],['AFTER INSERT','NEW','insert']]) {
    db.exec(`DROP TRIGGER IF EXISTS doc_studio_version_${name}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS doc_studio_version_${name} ${event} ON doc_templates BEGIN
      INSERT INTO doc_studio_versions(template_id,snapshot)
        SELECT ${row}.id,${snapshot(row!)}
        WHERE COALESCE((SELECT snapshot FROM doc_studio_versions WHERE template_id=${row}.id ORDER BY id DESC LIMIT 1),'') != ${snapshot(row!)};
      DELETE FROM doc_studio_versions WHERE template_id=${row}.id AND id NOT IN
        (SELECT id FROM doc_studio_versions WHERE template_id=${row}.id ORDER BY id DESC LIMIT 100);
    END;`);
  }
}
