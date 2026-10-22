import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { db } from '../shared/db';
import type { DocTemplate } from '../shared/types';

/** Content-derived revision also detects writes from other template entry points.
 * Unlike second-resolution updated_at, two saves in one second cannot share a revision. */
export function templateRevision(template: DocTemplate): string {
  return createHash('sha256').update(JSON.stringify([
    template.id, template.name, template.type, template.period, template.body,
    template.copies_per_record, template.records_per_page, template.tile_fill,
    template.repeat_count, template.tile_continuous, template.grid_gap_x_mm, template.grid_gap_y_mm, template.updated_at,
  ])).digest('hex');
}

export function checkTemplateRevision(template: DocTemplate, expected: unknown, res: Response): boolean {
  if (typeof expected !== 'string' || !expected) {
    res.status(428).json({ error: 'Reload this template before saving; its revision is required.' });
    return false;
  }
  if (expected !== templateRevision(template)) {
    res.status(409).json({ error: 'This template changed since you opened it. Your changes are still in the editor. Copy your work before closing, then reopen the latest template.' });
    return false;
  }
  return true;
}

/** A savepoint makes revision checks and subsequent writes one database snapshot. */
export function templateWrite<T>(work: () => T): T {
  db.exec('SAVEPOINT template_write');
  try {
    const result = work(); db.exec('RELEASE template_write'); return result;
  } catch (error) {
    db.exec('ROLLBACK TO template_write'); db.exec('RELEASE template_write'); throw error;
  }
}

/** Publishing must include the shared working version so in-flight remote edits cannot disappear. */
export function checkStudioPublish(templateId: number | string, expected: number | undefined, res: Response): boolean {
  const row=db.prepare('SELECT version FROM doc_studio_rooms WHERE document_key=?').get(typeof templateId==='number'?'template:'+templateId:templateId) as {version:number}|undefined;
  if(row && row.version!==expected){res.status(409).json({error:'The shared document has newer edits. Sync the shared session before saving.'});return false;}
  return true;
}
export function studioPublished(template: DocTemplate): void {
  const snapshot={body:template.body,name:template.name,type:template.type,period:template.period||'',
    copiesPerRecord:template.copies_per_record,recordsPerPage:template.records_per_page,tileFill:template.tile_fill,
    continuous:!!template.tile_continuous,gapXmm:template.grid_gap_x_mm,gapYmm:template.grid_gap_y_mm,repeatCount:template.repeat_count};
  db.prepare('UPDATE doc_studio_rooms SET snapshot=?,saved_revision=?,version=version+1,updated_at=datetime(\'now\') WHERE document_key=?')
    .run(JSON.stringify(snapshot),templateRevision(template),'template:'+template.id);
}
export function migrateStudioDocument(oldKey:string,newKey:string):void {
  for(const table of ['doc_studio_drafts','doc_studio_rooms','doc_studio_comments','doc_studio_presence'])
    db.prepare(`UPDATE ${table} SET document_key=? WHERE document_key=?`).run(newKey,oldKey);
}
