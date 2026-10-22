CREATE UNIQUE INDEX payroll_email_first ON payroll_email_releases(record_id)
  WHERE confirmed_at IS NOT NULL AND retry_of IS NULL;
CREATE INDEX payroll_email_record ON payroll_email_releases(record_id,seq);
CREATE UNIQUE INDEX payroll_email_successor ON payroll_email_releases(retry_of)
  WHERE confirmed_at IS NOT NULL AND retry_of IS NOT NULL;
CREATE INDEX payroll_email_work ON payroll_email_releases(state,seq);
CREATE TABLE payroll_email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL REFERENCES payroll_email_releases(id),
  state TEXT NOT NULL,
  code TEXT NOT NULL,
  actor_id INTEGER,
  created_at INTEGER NOT NULL
 );
CREATE TABLE payroll_email_releases (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  record_number TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  recipient_user_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('review','queued','sending','accepted','not_accepted','unknown','cancelled','expired')),
  actor_id INTEGER NOT NULL,
  session_hash TEXT NOT NULL,
  actor_stamp TEXT NOT NULL,
  credential_stamp TEXT NOT NULL,
  source_stamp TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  recipient_mask TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  proof_hash TEXT NOT NULL,
  payload TEXT,
  retry_of TEXT,
  reason TEXT,
  evidence_reference TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  claimed_at INTEGER,
  finished_at INTEGER,
  outcome_code TEXT
 );
CREATE TABLE payroll_email_versions (kind TEXT NOT NULL,entity TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(kind,entity));
CREATE TRIGGER payroll_email_fence_doc_templates_DELETE AFTER DELETE ON doc_templates
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('templates',CAST(OLD.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_doc_templates_INSERT AFTER INSERT ON doc_templates
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('templates',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_doc_templates_UPDATE AFTER UPDATE ON doc_templates
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('templates',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_doc_variables_DELETE AFTER DELETE ON doc_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('variables','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_doc_variables_INSERT AFTER INSERT ON doc_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('variables','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_doc_variables_UPDATE AFTER UPDATE ON doc_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('variables','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_employees_DELETE AFTER DELETE ON employees
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('employees',CAST(OLD.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_employees_INSERT AFTER INSERT ON employees
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('employees',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_employees_UPDATE AFTER UPDATE OF user_id,name,employee_no,status ON employees
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('employees',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_form_records_DELETE AFTER DELETE ON form_records WHEN OLD.form_def_id IN (SELECT id FROM form_definitions WHERE slug='hr_payroll')
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('form_records',CAST(OLD.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_form_records_INSERT AFTER INSERT ON form_records WHEN NEW.form_def_id IN (SELECT id FROM form_definitions WHERE slug='hr_payroll')
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('form_records',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_form_records_UPDATE AFTER UPDATE ON form_records WHEN NEW.form_def_id IN (SELECT id FROM form_definitions WHERE slug='hr_payroll')
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('form_records',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_global_variables_DELETE AFTER DELETE ON global_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('globals','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_global_variables_INSERT AFTER INSERT ON global_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('globals','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_global_variables_UPDATE AFTER UPDATE ON global_variables
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('globals','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_roles_DELETE AFTER DELETE ON roles
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('roles','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_roles_INSERT AFTER INSERT ON roles
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('roles','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_roles_UPDATE AFTER UPDATE ON roles
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('roles','all',1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_settings_DELETE AFTER DELETE ON settings
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('settings',CAST(OLD.key AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_settings_INSERT AFTER INSERT ON settings
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('settings',CAST(NEW.key AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_settings_UPDATE AFTER UPDATE ON settings
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('settings',CAST(NEW.key AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_user_mfa_DELETE AFTER DELETE ON user_mfa
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('mfa',CAST(OLD.user_id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_user_mfa_INSERT AFTER INSERT ON user_mfa
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('mfa',CAST(NEW.user_id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_user_mfa_UPDATE AFTER UPDATE ON user_mfa
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('mfa',CAST(NEW.user_id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_users_DELETE AFTER DELETE ON users
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('users',CAST(OLD.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_users_INSERT AFTER INSERT ON users
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('users',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_fence_users_UPDATE AFTER UPDATE OF email,active,password_hash,role,permission_overrides,department_id,mfa_recovery_required,password_change_required ON users
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('users',CAST(NEW.id AS TEXT),1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;
CREATE TRIGGER payroll_email_transition BEFORE UPDATE OF state ON payroll_email_releases
 WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='review' AND NEW.state IN ('queued','cancelled','expired')) OR
  (OLD.state='queued' AND NEW.state IN ('sending','cancelled','expired')) OR
  (OLD.state='sending' AND NEW.state IN ('accepted','not_accepted','unknown'))
 ) BEGIN SELECT RAISE(ABORT,'Invalid payroll email state transition'); END;
