import type { DatabaseSync } from 'node:sqlite';

export function createFormTemplateSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS form_template_links (
    form_id INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
    PRIMARY KEY(form_id,template_id)
  );
  DROP TRIGGER IF EXISTS form_template_default_update;
  CREATE TRIGGER form_template_default_update AFTER UPDATE OF template_id ON form_definitions
  WHEN form_history_enabled() AND NEW.template_id IS NOT NULL BEGIN
    INSERT OR IGNORE INTO form_template_links VALUES(NEW.id,NEW.template_id);
  END;
  DROP TRIGGER IF EXISTS form_template_default_insert;
  CREATE TRIGGER form_template_default_insert AFTER INSERT ON form_definitions
  WHEN form_history_enabled() AND NEW.template_id IS NOT NULL BEGIN
    INSERT OR IGNORE INTO form_template_links VALUES(NEW.id,NEW.template_id);
  END;
  DROP TRIGGER IF EXISTS form_template_deleted;
  CREATE TRIGGER form_template_deleted BEFORE DELETE ON doc_templates WHEN form_history_enabled() BEGIN
    UPDATE form_definitions SET template_id=(SELECT MIN(template_id) FROM form_template_links WHERE form_id=form_definitions.id AND template_id<>OLD.id)
    WHERE template_id=OLD.id;
  END;`);
}
