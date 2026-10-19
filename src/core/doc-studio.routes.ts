import { syncClass } from '../sync';
import { isMultiPageDocument, MULTIPAGE_GRID_ERROR } from '../shared/document-layout';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { exportDocx, importDocx, DocumentInputError } from './document-conversion';
import { queryAll, queryOne, run } from '../shared/db';
import { parseBody } from '../shared/validation';
import type { DocTemplate, Permission } from '../shared/types';
import { templateRevision, templateWrite } from './doc-template-version';
import { mergeSnapshots } from './doc-studio-merge';

const router=Router();
const snapshotSchema=z.object({
  body:z.string().max(5_000_000), name:z.string().max(120), type:z.enum(['sale','job','purchase','generic']),
  period:z.string().max(60).nullable().optional(), copiesPerRecord:z.coerce.number().int().min(1).max(6),
  recordsPerPage:z.coerce.number().int().min(1).max(6), tileFill:z.enum(['blank','repeat']),
  gapXmm:z.coerce.number().min(0).max(30).default(6), gapYmm:z.coerce.number().min(0).max(30).default(6),
  continuous:z.union([z.boolean(),z.literal(0),z.literal(1)]).transform(Boolean),repeatCount:z.coerce.number().int().min(1).max(100),
}).refine(s=>s.copiesPerRecord*s.recordsPerPage<=12,'Print grid cannot exceed 12 cells').refine(s=>!isMultiPageDocument(s.body)||(s.copiesPerRecord===1&&s.recordsPerPage===1&&!s.continuous),MULTIPAGE_GRID_ERROR);
const draftSchema=z.object({snapshot:snapshotSchema,expected_version:z.number().int().nonnegative()});
const roomSchema=z.object({snapshot:snapshotSchema,base:snapshotSchema,expected_version:z.number().int().nonnegative(),client_id:z.string().regex(/^[\w-]{8,80}$/)});
const commentSchema=z.object({body:z.string().trim().min(1).max(4000),block_id:z.string().regex(/^[\w-]{0,100}$/).default('')});
const librarySchema=z.object({kind:z.enum(['style','asset','brand']),name:z.string().trim().min(1).max(100),value:z.record(z.string(),z.unknown()),expected_version:z.number().int().nonnegative().optional()}).refine(x=>JSON.stringify(x.value).length<=5_000_000,'Asset too large');
type Row={version:number;snapshot:string;saved_revision?:string};

function resolve(req:Request,res:Response): {key:string;template:DocTemplate|null} | null {
  const raw=String(req.params.key||'');const match=/^(template|form):(\d+)$/.exec(raw);
  if(!match && !/^new-template:[^/\\\u0000]{1,140}$/u.test(raw)){res.status(400).json({error:'Invalid document identity'});return null;}
  if(match && (!Number.isSafeInteger(Number(match[2])) || Number(match[2])<1)){res.status(400).json({error:'Invalid document ID'});return null;}
  let template:DocTemplate|null=null, key=match?match[1]+':'+Number(match[2]):raw;
  let allowed=req.user!.permissions.includes('templates.edit');
  const newForm=/^new-template:form-(\d+)-/.exec(raw);
  if(newForm){const form=queryOne<{scope:string|null}>('SELECT scope FROM form_definitions WHERE id=?',Number(newForm[1]));if(!form){res.status(404).json({error:'Form not found'});return null;}allowed=form.scope?req.user!.permissions.includes(`forms.manage.${form.scope}` as Permission):['hr','inventory','admin','accounting'].every(s=>req.user!.permissions.includes(`forms.manage.${s}` as Permission));}
  if(match?.[1]==='form') {
    const form=queryOne<{scope:string|null;template_id:number|null}>('SELECT scope,template_id FROM form_definitions WHERE id=?',Number(match[2]));
    if(!form){res.status(404).json({error:'Form not found'});return null;}
    allowed=form.scope?req.user!.permissions.includes(`forms.manage.${form.scope}` as Permission):['hr','inventory','admin','accounting'].every(s=>req.user!.permissions.includes(`forms.manage.${s}` as Permission));
    if(form.template_id){key='template:'+form.template_id;template=queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id=?',form.template_id)||null;}
  }else if(match){
    template=queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id=?',Number(match[2]))||null;
    if(!template){res.status(404).json({error:'Template not found'});return null;}
    if(!allowed){const forms=queryAll<{scope:string|null}>('SELECT f.scope FROM form_definitions f JOIN form_template_links l ON l.form_id=f.id WHERE l.template_id=?',template.id);allowed=forms.some(f=>f.scope?req.user!.permissions.includes(`forms.manage.${f.scope}` as Permission):['hr','inventory','admin','accounting'].every(s=>req.user!.permissions.includes(`forms.manage.${s}` as Permission)));}
  }
  if(!allowed){res.status(403).json({error:'You do not have permission to edit this document'});return null;}
  return {key,template};
}
function normalizeGrid(snapshot:Record<string,unknown>){return typeof snapshot.body==='string'&&isMultiPageDocument(snapshot.body)?{...snapshot,copiesPerRecord:1,recordsPerPage:1,continuous:false,repeatCount:1}:snapshot;}
function seed(t:DocTemplate){return normalizeGrid({body:t.body,name:t.name,type:t.type,period:t.period||'',copiesPerRecord:t.copies_per_record,recordsPerPage:t.records_per_page,tileFill:t.tile_fill,continuous:!!t.tile_continuous,gapXmm:t.grid_gap_x_mm,gapYmm:t.grid_gap_y_mm,repeatCount:t.repeat_count});}
function presence(key:string){run('DELETE FROM doc_studio_presence WHERE touched_at<?',Date.now()-30_000);return queryAll('SELECT p.client_id,p.user_id,u.full_name FROM doc_studio_presence p JOIN users u ON u.id=p.user_id WHERE p.document_key=?',key);}

router.get('/documents/:key/history',(req,res)=>{const d=resolve(req,res);if(!d)return;res.json(d.template?queryAll('SELECT id,label,created_at FROM doc_studio_versions WHERE template_id=? ORDER BY id DESC LIMIT 100',d.template.id):[]);});
router.get('/documents/:key/history/:id',(req,res)=>{const d=resolve(req,res);if(!d)return;const row=d.template&&queryOne<{snapshot:string}>('SELECT snapshot FROM doc_studio_versions WHERE template_id=? AND id=?',d.template.id,Number(req.params.id));if(!row){res.status(404).json({error:'Version not found'});return;}res.json(normalizeGrid(JSON.parse(row.snapshot)));});
router.get('/documents/:key/draft',(req,res)=>{const d=resolve(req,res);if(!d)return;const row=queryOne<Row>('SELECT * FROM doc_studio_drafts WHERE document_key=? AND user_id=?',d.key,req.user!.id);res.json(row?{snapshot:normalizeGrid(JSON.parse(row.snapshot)),version:row.version}:null);});
router.put('/documents/:key/draft',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const input=parseBody(draftSchema,req.body);const result=templateWrite(()=>{const row=queryOne<Row>('SELECT version FROM doc_studio_drafts WHERE document_key=? AND user_id=?',d.key,req.user!.id);if((row?.version||0)!==input.expected_version){res.status(409).json({error:'This draft was updated on another device. Recover that draft before replacing it.'});return;}run(`INSERT INTO doc_studio_drafts(document_key,user_id,snapshot,version) VALUES(?,?,?,1) ON CONFLICT(document_key,user_id) DO UPDATE SET snapshot=excluded.snapshot,version=doc_studio_drafts.version+1,updated_at=datetime('now')`,d.key,req.user!.id,JSON.stringify(input.snapshot));return {version:input.expected_version+1};});if(result)res.json(result);});
router.delete('/documents/:key/draft',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const version=Number(req.query.version);if(!Number.isSafeInteger(version)||version<1){res.status(400).json({error:'Draft version required'});return;}const info=run('DELETE FROM doc_studio_drafts WHERE document_key=? AND user_id=? AND version=?',d.key,req.user!.id,version);if(!info.changes){res.status(409).json({error:'Draft changed on another device; it was preserved'});return;}res.json({ok:true});});

router.get('/documents/:key/room',(req,res)=>{const d=resolve(req,res);if(!d)return;const row=queryOne<Row>('SELECT * FROM doc_studio_rooms WHERE document_key=?',d.key);res.json({snapshot:row?normalizeGrid(JSON.parse(row.snapshot)):d.template?seed(d.template):null,version:row?.version||0,saved_revision:d.template?templateRevision(d.template):null,room_saved_revision:row?.saved_revision||null,presence:presence(d.key)});});
router.put('/documents/:key/room',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const input=parseBody(roomSchema,req.body);const result=templateWrite(()=>{const row=queryOne<Row>('SELECT * FROM doc_studio_rooms WHERE document_key=?',d.key);let snapshot:Record<string,unknown>=input.snapshot;
  if((row?.version||0)!==input.expected_version){const merged=mergeSnapshots(input.base,input.snapshot,row?normalizeGrid(JSON.parse(row.snapshot)):d.template?seed(d.template):{});if(merged.conflicts.length){res.status(409).json({error:'Another editor changed the same content. Your local draft is preserved.',conflicts:merged.conflicts,snapshot:row?normalizeGrid(JSON.parse(row.snapshot)):null,version:row?.version||0});return;}snapshot=merged.snapshot;}
  // An external saved edit must be reconciled before changing a stale shared room.
  const revision=d.template?templateRevision(d.template):null;
  if(row?.saved_revision&&revision!==row.saved_revision){res.status(409).json({error:'The saved template changed outside this shared session. Reload the saved version before publishing.',saved_revision:revision});return;}
  snapshot=parseBody(snapshotSchema,snapshot);
  const version=(row?.version||0)+1;
  run(`INSERT INTO doc_studio_rooms(document_key,snapshot,version,saved_revision,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(document_key) DO UPDATE SET snapshot=excluded.snapshot,version=excluded.version,updated_by=excluded.updated_by,updated_at=datetime('now')`,d.key,JSON.stringify(snapshot),version,revision,req.user!.id);
  return {snapshot,version,saved_revision:revision};});if(result)res.json(result);});
router.post('/documents/:key/reset',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const input=parseBody(z.object({expected_version:z.number().int().nonnegative()}),req.body);if(!d.template){res.status(400).json({error:'Save this template first'});return;}const result=templateWrite(()=>{const row=queryOne<Row>('SELECT version FROM doc_studio_rooms WHERE document_key=?',d.key);if((row?.version||0)!==input.expected_version){res.status(409).json({error:'The shared session changed; review it before resetting'});return;}const snapshot=seed(d.template!),revision=templateRevision(d.template!);run('UPDATE doc_studio_rooms SET snapshot=?,saved_revision=?,version=version+1 WHERE document_key=?',JSON.stringify(snapshot),revision,d.key);return {snapshot,version:input.expected_version+1,saved_revision:revision};});if(result)res.json(result);});
router.post('/documents/:key/presence',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const input=parseBody(z.object({client_id:z.string().regex(/^[\w-]{8,80}$/)}),req.body);run('INSERT INTO doc_studio_presence(document_key,client_id,user_id,touched_at) VALUES(?,?,?,?) ON CONFLICT(document_key,client_id) DO UPDATE SET user_id=excluded.user_id,touched_at=excluded.touched_at',d.key,input.client_id,req.user!.id,Date.now());res.json(presence(d.key));});
router.delete('/documents/:key/presence/:client',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;run('DELETE FROM doc_studio_presence WHERE document_key=? AND client_id=? AND user_id=?',d.key,String(req.params.client),req.user!.id);res.json({ok:true});});
router.get('/documents/:key/comments',(req,res)=>{const d=resolve(req,res);if(!d)return;res.json(queryAll('SELECT c.*,u.full_name FROM doc_studio_comments c LEFT JOIN users u ON u.id=c.created_by WHERE c.document_key=? ORDER BY c.id DESC LIMIT 200',d.key));});
router.post('/documents/:key/comments',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const input=parseBody(commentSchema,req.body);const info=run('INSERT INTO doc_studio_comments(document_key,block_id,body,created_by) VALUES(?,?,?,?)',d.key,input.block_id,input.body,req.user!.id);res.status(201).json({id:info.lastInsertRowid});});
router.put('/documents/:key/comments/:id',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const {resolved}=parseBody(z.object({resolved:z.boolean()}),req.body);const info=run('UPDATE doc_studio_comments SET resolved=? WHERE id=? AND document_key=?',resolved?1:0,Number(req.params.id),d.key);if(!info.changes){res.status(404).json({error:'Comment not found'});return;}res.json({ok:true});});
router.delete('/documents/:key/comments/:id',syncClass('online'),(req,res)=>{const d=resolve(req,res);if(!d)return;const info=run('DELETE FROM doc_studio_comments WHERE id=? AND document_key=? AND created_by=?',Number(req.params.id),d.key,req.user!.id);if(!info.changes){res.status(403).json({error:'Only the comment author can delete it'});return;}res.json({ok:true});});

const conversionSchema=z.object({body:z.string().max(5_000_000),name:z.string().max(120).default('Document'),widthMm:z.number().min(10).max(2000),heightMm:z.number().min(10).max(2000),marginMm:z.number().min(0).max(500)}).refine(v=>v.marginMm*2<Math.min(v.widthMm,v.heightMm),'Margins must leave room for content');
const documentUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:0}});
router.post('/documents/:key/export-docx',syncClass('online'),async(req,res,next)=>{
 if(!resolve(req,res))return;const input=parseBody(conversionSchema,req.body);
 try{const converted=await exportDocx(input);res.json({data:converted.buffer.toString('base64'),warnings:converted.warnings,filename:(input.name.replace(/[^\p{L}\p{N} _.-]/gu,'_')||'Document')+'.docx'});}catch(err){if(err instanceof DocumentInputError){res.status(400).json({error:err.message,request_id:res.locals.requestId});return;}next(new Error('Document export failed'));}
});
router.post('/documents/:key/import-docx',syncClass('online'),(req,res,next)=>{if(resolve(req,res))next();},(req,res,next)=>{documentUpload.single('file')(req,res,error=>{if(error){res.status(error instanceof multer.MulterError&&error.code==='LIMIT_FILE_SIZE'?413:400).json({error:'Choose one DOCX file up to 8 MB'});return;}next();});},async(req,res)=>{
 if(!req.file||!req.file.originalname.toLowerCase().endsWith('.docx')){res.status(400).json({error:'Choose a DOCX file up to 8 MB'});return;}
 try{res.json(await importDocx(req.file.buffer));}catch(err){res.status(400).json({error:err instanceof DocumentInputError?err.message:'Could not read this DOCX. Choose a valid document and try again.',request_id:res.locals.requestId});}
});

router.get('/library',(_req,res)=>res.json(queryAll<{value:string}>('SELECT l.*,u.full_name FROM doc_studio_library l LEFT JOIN users u ON u.id=l.created_by ORDER BY l.kind,l.name').map(r=>({...r,value:JSON.parse(r.value)}))));
router.post('/library',syncClass('claim'),(req,res)=>{if(!req.user!.permissions.includes('templates.company')){res.status(403).json({error:'Company library permission required'});return;}const input=parseBody(librarySchema,req.body);const info=run('INSERT INTO doc_studio_library(kind,name,value,created_by) VALUES(?,?,?,?)',input.kind,input.name,JSON.stringify(input.value),req.user!.id);res.status(201).json({id:info.lastInsertRowid,version:1});});
router.put('/library/:id',syncClass('claim'),(req,res)=>{if(!req.user!.permissions.includes('templates.company')){res.status(403).json({error:'Company library permission required'});return;}const input=parseBody(librarySchema,req.body);const info=run(`UPDATE doc_studio_library SET kind=?,name=?,value=?,version=version+1,updated_at=datetime('now') WHERE id=? AND version=?`,input.kind,input.name,JSON.stringify(input.value),Number(req.params.id),input.expected_version??0);if(!info.changes){res.status(409).json({error:'Library entry changed; reload it before replacing'});return;}res.json({ok:true,version:input.expected_version!+1});});
router.delete('/library/:id',syncClass('claim'),(req,res)=>{if(!req.user!.permissions.includes('templates.company')){res.status(403).json({error:'Company library permission required'});return;}const info=run('DELETE FROM doc_studio_library WHERE id=? AND version=?',Number(req.params.id),Number(req.query.version)||0);if(!info.changes){res.status(409).json({error:'Library entry changed; reload it before deleting'});return;}res.json({ok:true});});
export default router;
