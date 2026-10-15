import { configureFormHistoryConnection } from './form-history-context';
import type { DatabaseSync } from 'node:sqlite';

/** Composite keys make schema snapshots stable across cloud/PC sync. */
export function createFormHistorySchema(conn: DatabaseSync): void {
  configureFormHistoryConnection(conn);
  const snapshot = `json_object('name',name,'slug',slug,'number_prefix',number_prefix,'icon',icon,
    'fields',json(CASE WHEN json_valid(fields) THEN fields ELSE '[]' END),'actions',json(CASE WHEN json_valid(actions) THEN actions ELSE '[]' END),'scope',scope)`;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS form_definition_versions (
      form_id INTEGER NOT NULL REFERENCES form_definitions(id) ON UPDATE CASCADE ON DELETE CASCADE,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      legacy_baseline INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(form_id,version)
    );
    CREATE TABLE IF NOT EXISTS form_record_revisions (
      record_id INTEGER NOT NULL REFERENCES form_records(id) ON UPDATE CASCADE ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      definition_version INTEGER NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      changed_by_name TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(record_id,revision)
    );
    CREATE TABLE IF NOT EXISTS payslip_deduction_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      before_values TEXT NOT NULL,
      after_values TEXT NOT NULL,
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_by_name TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deduction_history_record ON payslip_deduction_history(record_id,id);
    CREATE TABLE IF NOT EXISTS form_user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      favorites TEXT NOT NULL DEFAULT '[]',
      recent TEXT NOT NULL DEFAULT '[]',
      views TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO form_definition_versions(form_id,version,definition,created_by,created_at,legacy_baseline)
      SELECT id,version,${snapshot},created_by,COALESCE(updated_at,created_at),1 FROM form_definitions;
    UPDATE form_records SET definition_version=(SELECT version FROM form_definitions WHERE id=form_def_id)
      WHERE definition_version IS NULL;
    INSERT OR IGNORE INTO form_record_revisions(record_id,revision,definition_version,data,status,changed_by,source,created_at)
      SELECT id,revision,definition_version,data,status,created_by,'baseline',COALESCE(updated_at,created_at) FROM form_records;
    CREATE TRIGGER IF NOT EXISTS form_definition_initial_version AFTER INSERT ON form_definitions WHEN form_history_enabled() BEGIN
      INSERT OR IGNORE INTO form_definition_versions(form_id,version,definition,created_by,reason,created_at)
        SELECT id,version,${snapshot},created_by,version_reason,created_at FROM form_definitions WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS form_definition_next_version AFTER UPDATE OF name,slug,number_prefix,icon,fields,actions,scope ON form_definitions
    WHEN form_history_enabled() AND (OLD.name!=NEW.name OR OLD.slug!=NEW.slug OR OLD.number_prefix!=NEW.number_prefix OR OLD.icon!=NEW.icon
      OR OLD.fields!=NEW.fields OR OLD.actions!=NEW.actions OR OLD.scope IS NOT NEW.scope) BEGIN
      UPDATE form_definitions SET version=CASE WHEN NEW.version>OLD.version THEN NEW.version ELSE OLD.version+1 END WHERE id=NEW.id;
      INSERT OR IGNORE INTO form_definition_versions(form_id,version,definition,created_by,reason,created_at)
        SELECT id,version,${snapshot},form_change_actor(),form_change_reason(),form_change_time() FROM form_definitions WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS form_record_initial_revision AFTER INSERT ON form_records WHEN form_history_enabled() BEGIN
      UPDATE form_records SET definition_version=(SELECT version FROM form_definitions WHERE id=NEW.form_def_id)
        WHERE id=NEW.id AND definition_version IS NULL;
      INSERT OR IGNORE INTO form_record_revisions(record_id,revision,definition_version,data,status,changed_by,source,created_at)
        SELECT id,revision,definition_version,data,status,created_by,'created',created_at FROM form_records WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS form_record_next_revision AFTER UPDATE OF data,status ON form_records
    WHEN form_history_enabled() AND (OLD.data IS NOT NEW.data OR OLD.status IS NOT NEW.status) BEGIN
      UPDATE form_records SET revision=CASE WHEN NEW.revision>OLD.revision THEN NEW.revision ELSE OLD.revision+1 END WHERE id=NEW.id;
      INSERT OR IGNORE INTO form_record_revisions(record_id,revision,definition_version,data,status,changed_by,changed_by_name,reason,source,created_at)
        SELECT id,revision,definition_version,data,status,form_change_actor(),form_change_name(),form_change_reason(),form_change_source(),form_change_time() FROM form_records WHERE id=NEW.id;
    END;
  `);
}
