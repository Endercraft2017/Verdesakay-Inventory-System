/** Document templates (admin-managed) + the company profile used by template variables.
    Reading is open to any logged-in user; editing is admin-only. */
import { Router } from 'express';
import { queryOne, queryAll, run, getSetting, setSetting } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, templateSchema, companyProfileSchema, docVariableSchema } from '../validation';
import type { DocTemplate, CompanyProfile, DocVariable } from '../types';
import { DATA_SOURCE_CATALOG } from '../doc-catalog';

const router = Router();
router.use(requireAuth);

const COMPANY_KEY = 'company_profile';
const EMPTY_COMPANY: CompanyProfile = { name: '', address: '', phone: '', email: '', logo_url: '' };

// GET /api/templates/company — company profile (for company.* variables)
router.get('/company', (_req, res) => {
  res.json({ ...EMPTY_COMPANY, ...(getSetting<Partial<CompanyProfile>>(COMPANY_KEY) || {}) });
});

// PUT /api/templates/company — save company profile
router.put('/company', requirePermission('templates.company'), (req, res) => {
  const input = parseBody(companyProfileSchema, req.body);
  const profile: CompanyProfile = {
    name: input.name ?? '', address: input.address ?? '', phone: input.phone ?? '',
    email: input.email ?? '', logo_url: input.logo_url ?? '',
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
router.post('/variables', requirePermission('templates.edit'), (req, res) => {
  const v = parseBody(docVariableSchema, req.body);
  try {
    const info = run(
      `INSERT INTO doc_variables
        (scope, template_id, category, key, label, source_type, value, field_path, formula, data_type, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.scope,
      v.scope === 'template' ? (v.template_id ?? null) : null,
      v.category,
      v.key,
      v.label,
      v.source_type,
      v.value ?? null,
      v.field_path ?? null,
      v.formula ?? null,
      v.data_type,
      v.sort
    );
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'A variable with that key already exists in this scope' });
  }
});

// PUT /api/templates/variables/:id (key + scope are fixed)
router.put('/variables/:id', requirePermission('templates.edit'), (req, res) => {
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
router.delete('/variables/:id', requirePermission('templates.edit'), (req, res) => {
  const info = run('DELETE FROM doc_variables WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Variable not found' }); return; }
  res.json({ ok: true });
});

// GET /api/templates?type=
router.get('/', (req, res) => {
  const { type } = req.query;
  const where = type === 'sale' || type === 'job' || type === 'generic' ? ' WHERE type = ?' : '';
  const params = where ? [type] : [];
  res.json(queryAll<DocTemplate>(`SELECT * FROM doc_templates${where} ORDER BY type, name`, ...params));
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
router.post('/', requirePermission('templates.edit'), (req, res) => {
  const input = parseBody(templateSchema, req.body);
  const info = run(
    'INSERT INTO doc_templates (name, type, body, created_by) VALUES (?, ?, ?, ?)',
    input.name,
    input.type,
    input.body,
    req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/templates/:id (admin)
router.put('/:id', requirePermission('templates.edit'), (req, res) => {
  const input = parseBody(templateSchema, req.body);
  const info = run(
    "UPDATE doc_templates SET name = ?, type = ?, body = ?, updated_at = datetime('now') WHERE id = ?",
    input.name,
    input.type,
    input.body,
    Number(req.params.id)
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

// DELETE /api/templates/:id (admin)
router.delete('/:id', requirePermission('templates.edit'), (req, res) => {
  const info = run('DELETE FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
