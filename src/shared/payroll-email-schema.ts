import type {DatabaseSync} from 'node:sqlite';
/** Cloud-only intents. No cascading business foreign keys: release history survives source deletion. */
export function createPayrollEmailSchema(conn:DatabaseSync):void {
 conn.exec(`
 CREATE TABLE IF NOT EXISTS payroll_email_versions (kind TEXT NOT NULL,entity TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(kind,entity));
 CREATE TABLE IF NOT EXISTS payroll_email_releases (
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
 CREATE INDEX IF NOT EXISTS payroll_email_work ON payroll_email_releases(state,seq);
 CREATE INDEX IF NOT EXISTS payroll_email_record ON payroll_email_releases(record_id,seq);
 CREATE UNIQUE INDEX IF NOT EXISTS payroll_email_first ON payroll_email_releases(record_id)
  WHERE confirmed_at IS NOT NULL AND retry_of IS NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS payroll_email_successor ON payroll_email_releases(retry_of)
  WHERE confirmed_at IS NOT NULL AND retry_of IS NOT NULL;
 CREATE TABLE IF NOT EXISTS payroll_email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL REFERENCES payroll_email_releases(id),
  state TEXT NOT NULL,
  code TEXT NOT NULL,
  actor_id INTEGER,
  created_at INTEGER NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS payroll_email_transition BEFORE UPDATE OF state ON payroll_email_releases
 WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='review' AND NEW.state IN ('queued','cancelled','expired')) OR
  (OLD.state='queued' AND NEW.state IN ('sending','cancelled','expired')) OR
  (OLD.state='sending' AND NEW.state IN ('accepted','not_accepted','unknown'))
 ) BEGIN SELECT RAISE(ABORT,'Invalid payroll email state transition'); END;
 `);
 // Monotonic fences remember edits even if values are later changed back. Only approval
 // dependencies are tracked; normal session activity does not invalidate a review.
 const specs:Array<[string,string,string|null,string]>=[
  ['form_records','id',null,'form_records'],['employees','id','user_id,name,employee_no,status','employees'],
  ['users','id','email,active,password_hash,role,permission_overrides,department_id,mfa_recovery_required,password_change_required','users'],
  ['roles',"'all'",null,'roles'],['user_mfa','user_id',null,'mfa'],
  ['doc_templates','id',null,'templates'],['doc_variables',"'all'",null,'variables'],
  ['global_variables',"'all'",null,'globals'],['settings','key',null,'settings']
 ];
 for(const [table,key,columns,kind] of specs)for(const action of ['INSERT','UPDATE','DELETE']){
  const row=action==='DELETE'?'OLD':'NEW',entity=key==="'all'"?key:`CAST(${row}.${key} AS TEXT)`;
  conn.exec(`CREATE TRIGGER IF NOT EXISTS payroll_email_fence_${table}_${action} AFTER ${action}${action==='UPDATE'&&columns?' OF '+columns:''} ON ${table}${table==='form_records'?` WHEN ${row}.form_def_id IN (SELECT id FROM form_definitions WHERE slug='hr_payroll')`:''}
   BEGIN INSERT INTO payroll_email_versions(kind,entity,version) VALUES('${kind}',${entity},1)
   ON CONFLICT(kind,entity) DO UPDATE SET version=version+1; END;`);
 }
}
