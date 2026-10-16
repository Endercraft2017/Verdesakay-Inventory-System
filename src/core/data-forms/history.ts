import { db, queryOne, queryAll, run } from '../../shared/db';
import { parseData } from './policy';
import { withFormChange } from '../../shared/form-history-context';
import type { FormRecord, FieldDef } from '../../shared/types';

export function definitionForRecord(record: Pick<FormRecord, 'form_def_id' | 'definition_version'>) {
  const row = queryOne<{ definition: string }>('SELECT definition FROM form_definition_versions WHERE form_id=? AND version=?', record.form_def_id, record.definition_version ?? 1);
  return row ? JSON.parse(row.definition) as { name: string; fields: FieldDef[]; slug: string; actions?: import('../../shared/types').FormAction[] } : null;
}
export function recordResponse(record: FormRecord) {
  return { ...record, data: typeof record.data === 'string' ? parseData(record.data) : record.data, schema: definitionForRecord(record) };
}
export function recordRevisions(recordId: number, formId: number) {
  return queryAll<{ revision: number; definition_version: number; data: string; status: string; reason: string | null; source: string; created_at: string; changed_by_name: string | null }>(
    'SELECT r.*,COALESCE(r.changed_by_name,u.full_name) AS changed_by_name FROM form_record_revisions r LEFT JOIN users u ON u.id=r.changed_by WHERE r.record_id=? ORDER BY r.revision DESC', recordId
  ).map(row => ({ ...row, data: parseData(row.data), schema: definitionForRecord({ form_def_id: formId, definition_version: row.definition_version }) }));
}
/** Savepoint keeps the correction and its snapshots atomic, including inside a larger transaction. */
export function correctRecord(_record: FormRecord, actor: number, reason: string | undefined, source: string, write: () => void): void {
  db.exec('SAVEPOINT form_correction');
  try {
    withFormChange({actor,name:queryOne<{full_name:string}>('SELECT full_name FROM users WHERE id=?',actor)?.full_name,reason,source},write);
    db.exec('RELEASE form_correction');
  } catch (error) { db.exec('ROLLBACK TO form_correction'); db.exec('RELEASE form_correction'); throw error; }
}
