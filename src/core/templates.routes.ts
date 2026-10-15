/** Document templates (admin-managed) + the company profile used by template variables.
    Reading is open to any logged-in user; editing is admin-only. */
import { z } from 'zod';
import {canEnterForm} from './data-forms/policy';
import type {FormDefinition} from '../shared/types';
import type {Request,Response,NextFunction} from 'express';
import { BUILTIN_DOCUMENTS } from '../shared/document-defaults';
import { Router } from 'express';
import studioRoutes from './doc-studio.routes';
import { queryOne, queryAll, run, getSetting, setSetting } from '../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../shared/auth';
import { parseBody, templateSchema, companyProfileSchema, docVariableSchema } from '../shared/validation';
import type { DocTemplate, CompanyProfile, DocVariable } from '../shared/types';
import { templateRevision, checkTemplateRevision, templateWrite, checkStudioPublish, studioPublished } from './doc-template-version';
import { DATA_SOURCE_CATALOG } from './doc-catalog';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);
router.use('/studio', studioRoutes);

// Document templates are read by whoever prints documents from them: the template editors, orders,
// purchasing, accounting and form records. The company header (/company) stays readable by all.
const broadDocRead = requireAnyPermission(['templates.view', 'orders.view', 'purchasing.view', 'accounting.view', 'forms.view']);
function docRead(req:Request,res:Response,next:NextFunction){
  const id=Number(req.params.id||req.query.template_id);
  if(['/variables','/:id'].includes(req.route?.path)&&Number.isSafeInteger(id)&&id>0&&queryAll<FormDefinition>('SELECT fd.* FROM form_definitions fd JOIN form_template_links l ON l.form_id=fd.id WHERE l.template_id=?',id).some(form=>canEnterForm(req,form))){next();return;}
  broadDocRead(req,res,next);
}

const COMPANY_KEY = 'company_profile';
const EMPTY_COMPANY: CompanyProfile = {
  name: '', address: '', phone: '', email: '', logo_url: '', compress_images: true,
};

// GET /api/templates/company — company profile (for company.* variables)
router.get('/company', (_req, res) => {
  res.json({ ...EMPTY_COMPANY, ...(getSetting<Partial<CompanyProfile>>(COMPANY_KEY) || {}) });
});

// PUT /api/templates/company — save company profile
router.put('/company', requirePermission('templates.company'), syncClass('claim'), (req, res) => {
  const input = parseBody(companyProfileSchema, req.body);
  const profile: CompanyProfile = {
    name: input.name ?? '', address: input.address ?? '', phone: input.phone ?? '',
    email: input.email ?? '', logo_url: input.logo_url ?? '',
    compress_images: input.compress_images,
  };
  setSetting(COMPANY_KEY, profile);
  res.json({ ok: true });
});

// ---- Template variables (custom, categorized, data-bound) ----

// GET /api/templates/variables/catalog — the bindable data-source fields
router.get('/variables/catalog', (_req, res) => {
  res.json(DATA_SOURCE_CATALOG);
});

// GET /api/templates/variables?template_id= — global vars + that template's local vars
router.get('/variables', docRead, (req, res) => {
  const tid = req.query.template_id ? Number(req.query.template_id) : 0;
  res.json(
    queryAll<DocVariable>(
      `SELECT * FROM doc_variables
       WHERE scope = 'global' OR (scope = 'template' AND template_id = ?)
       ORDER BY category, sort, label`,
      tid
    )
  );
});

// POST /api/templates/variables
router.post('/variables', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const v = parseBody(docVariableSchema, req.body);
  const templateId = v.scope === 'template' ? (v.template_id ?? null) : null;
  const dupe = queryOne(
    'SELECT id FROM doc_variables WHERE scope = ? AND IFNULL(template_id, 0) = IFNULL(?, 0) AND key = ?',
    v.scope, templateId, v.key
  );
  if (dupe) {
    res.status(409).json({ error: 'A variable with that key already exists in this scope' });
    return;
  }
  const info = run(
    `INSERT INTO doc_variables
      (scope, template_id, category, key, label, source_type, value, field_path, formula, data_type, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.scope, templateId, v.category, v.key, v.label, v.source_type,
    v.value ?? null, v.field_path ?? null, v.formula ?? null, v.data_type, v.sort
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/templates/variables/:id (key + scope are fixed)
router.put('/variables/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const v = parseBody(docVariableSchema, req.body);
  const info = run(
    `UPDATE doc_variables SET category = ?, label = ?, source_type = ?, value = ?, field_path = ?,
       formula = ?, data_type = ?, sort = ?, updated_at = datetime('now')
     WHERE id = ?`,
    v.category, v.label, v.source_type, v.value ?? null, v.field_path ?? null,
    v.formula ?? null, v.data_type, v.sort, Number(req.params.id)
  );
  if (info.changes === 0) { res.status(404).json({ error: 'Variable not found' }); return; }
  res.json({ ok: true });
});

// DELETE /api/templates/variables/:id
router.delete('/variables/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM doc_variables WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Variable not found' }); return; }
  res.json({ ok: true });
});

// Stable assignments for native documents; renaming a layout never changes its purpose.
router.get('/defaults',docRead,(_req,res)=>res.json(BUILTIN_DOCUMENTS.map(item=>({...item,...queryOne<{template_id:number|null;template_name:string|null}>('SELECT d.template_id,t.name AS template_name FROM document_defaults d LEFT JOIN doc_templates t ON t.id=d.template_id WHERE d.key=?',item.key)}))));
router.get('/defaults/:key',docRead,(req,res)=>{
 const item=BUILTIN_DOCUMENTS.find(d=>d.key===req.params.key);if(!item){res.status(404).json({error:'Document type not found'});return;}
 const tpl=queryOne<DocTemplate>('SELECT t.* FROM document_defaults d JOIN doc_templates t ON t.id=d.template_id WHERE d.key=?',item.key);
 if(!tpl){res.status(409).json({error:'Choose a default layout in Document Templates → Built-in defaults'});return;}
 res.json({...tpl,revision:templateRevision(tpl)});
});
router.put('/defaults/:key',requirePermission('templates.edit'),syncClass('claim'),(req,res)=>{
 const item=BUILTIN_DOCUMENTS.find(d=>d.key===req.params.key);if(!item){res.status(404).json({error:'Document type not found'});return;}
 const input=parseBody(z.object({template_id:z.number().int().positive()}),req.body);
 const tpl=queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id=?',input.template_id);if(!tpl){res.status(404).json({error:'Template not found'});return;}
 if(tpl.type!==item.type){res.status(400).json({error:'Choose a template with the matching document type'});return;}
 run('UPDATE document_defaults SET template_id=? WHERE key=?',tpl.id,item.key);res.json({ok:true});
});

// GET /api/templates?type=&period=
router.get('/', docRead, (req, res) => {
  const { type, period } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (type === 'sale' || type === 'job' || type === 'purchase' || type === 'generic') {
    conditions.push('type = ?'); params.push(type);
  }
  if (typeof period === 'string' && period) {
    conditions.push('period = ?'); params.push(period);
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  res.json(queryAll<DocTemplate>(`SELECT id,name,type,period,copies_per_record,records_per_page,tile_fill,repeat_count,tile_continuous,grid_gap_x_mm,grid_gap_y_mm,created_at,updated_at FROM doc_templates${where} ORDER BY period DESC, type, name`, ...params));
});

// GET /api/templates/:id
router.get('/:id', docRead, (req, res) => {
  const tpl = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (!tpl) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ...tpl, revision: templateRevision(tpl) });
});

// POST /api/templates (admin)
router.post('/', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const input = parseBody(templateSchema, req.body);
  const result = templateWrite(() => {
    if (input.source_template_id) {
      const source = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', input.source_template_id);
      if (!source) { res.status(404).json({ error: 'Source template not found' }); return; }
      if (!checkTemplateRevision(source, input.source_revision, res)) return;
    }
    const info = run(
      'INSERT INTO doc_templates (name, type, period, body, copies_per_record, records_per_page, tile_fill, repeat_count, tile_continuous, grid_gap_x_mm, grid_gap_y_mm, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.name, input.type, input.period ?? null, input.body, input.copies_per_record,
      input.records_per_page, input.tile_fill, input.repeat_count, input.tile_continuous ? 1 : 0, input.grid_gap_x_mm, input.grid_gap_y_mm, req.user!.id
    );
    if (input.source_template_id) {
      run(`INSERT INTO doc_variables
        (scope, template_id, category, key, label, source_type, value, field_path, formula, data_type, sort)
        SELECT scope, ?, category, key, label, source_type, value, field_path, formula, data_type, sort
        FROM doc_variables WHERE scope = 'template' AND template_id = ?`, info.lastInsertRowid, input.source_template_id);
    }
    const saved = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', info.lastInsertRowid)!;
    return { id: info.lastInsertRowid, revision: templateRevision(saved) };
  });
  if (result) res.status(201).json(result);
});

// PUT /api/templates/:id (admin)
router.put('/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const result = templateWrite(() => {
    const input = parseBody(templateSchema, req.body);
    const existing = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', Number(req.params.id));
    if (!existing) { res.status(404).json({ error: 'Template not found' }); return; }
    if (!checkTemplateRevision(existing, input.expected_revision, res) || !checkStudioPublish(existing.id, input.studio_version, res)) return;
    const info = run(
      "UPDATE doc_templates SET name = ?, type = ?, period = ?, body = ?, copies_per_record = ?, records_per_page = ?, tile_fill = ?, repeat_count = ?, tile_continuous = ?, grid_gap_x_mm = ?, grid_gap_y_mm = ?, updated_at = datetime('now') WHERE id = ?",
      input.name,
      input.type,
      input.period ?? null,
      input.body,
      input.copies_per_record,
      input.records_per_page,
      input.tile_fill,
      input.repeat_count,
      input.tile_continuous ? 1 : 0, input.grid_gap_x_mm, input.grid_gap_y_mm,
      Number(req.params.id)
    );
    if (info.changes === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    const saved = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', Number(req.params.id))!;
    studioPublished(saved);
    return { ok: true, revision: templateRevision(saved) };
  });
  if (result) res.json(result);
});

// DELETE /api/templates/:id (admin)
router.delete('/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  if(queryOne('SELECT key FROM document_defaults WHERE template_id=?',Number(req.params.id))){res.status(409).json({error:'This template is a built-in document default. Choose a replacement in Built-in defaults before deleting it.'});return;}
  const info = run('DELETE FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
