/** Document templates (admin-managed) + the company profile used by template variables.
    Reading is open to any logged-in user; editing is admin-only. */
import { Router } from 'express';
import { queryOne, queryAll, run, getSetting, setSetting } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { parseBody, templateSchema, companyProfileSchema, docVariableSchema } from '../shared/validation';
import type { DocTemplate, CompanyProfile, DocVariable } from '../shared/types';
import { DATA_SOURCE_CATALOG } from './doc-catalog';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);

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
router.get('/variables', (req, res) => {
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

// GET /api/templates?type=&period=
router.get('/', (req, res) => {
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
  res.json(queryAll<DocTemplate>(`SELECT id,name,type,period,copies_per_record,records_per_page,tile_fill,created_at,updated_at FROM doc_templates${where} ORDER BY period DESC, type, name`, ...params));
});

// GET /api/templates/:id
router.get('/:id', (req, res) => {
  const tpl = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (!tpl) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(tpl);
});

// POST /api/templates (admin)
router.post('/', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const input = parseBody(templateSchema, req.body);
  const info = run(
    'INSERT INTO doc_templates (name, type, period, body, copies_per_record, records_per_page, tile_fill, repeat_count, tile_continuous, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.name,
    input.type,
    input.period ?? null,
    input.body,
    input.copies_per_record,
    input.records_per_page,
    input.tile_fill,
    input.repeat_count,
    input.tile_continuous ? 1 : 0,
    req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/templates/:id (admin)
router.put('/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const input = parseBody(templateSchema, req.body);
  const info = run(
    "UPDATE doc_templates SET name = ?, type = ?, period = ?, body = ?, copies_per_record = ?, records_per_page = ?, tile_fill = ?, repeat_count = ?, tile_continuous = ?, updated_at = datetime('now') WHERE id = ?",
    input.name,
    input.type,
    input.period ?? null,
    input.body,
    input.copies_per_record,
    input.records_per_page,
    input.tile_fill,
    input.repeat_count,
    input.tile_continuous ? 1 : 0,
    Number(req.params.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

// DELETE /api/templates/:id (admin)
router.delete('/:id', requirePermission('templates.edit'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
