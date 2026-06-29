/** Document templates (admin-managed) + the company profile used by template variables.
    Reading is open to any logged-in user; editing is admin-only. */
import { Router } from 'express';
import { queryOne, queryAll, run, getSetting, setSetting } from '../db';
import { requireAuth, requireRole } from '../auth';
import { parseBody, templateSchema, companyProfileSchema } from '../validation';
import type { DocTemplate, CompanyProfile } from '../types';

const router = Router();
router.use(requireAuth);

const COMPANY_KEY = 'company_profile';
const EMPTY_COMPANY: CompanyProfile = { name: '', address: '', phone: '', email: '', logo_url: '' };

// GET /api/templates/company — company profile (for company.* variables)
router.get('/company', (_req, res) => {
  res.json({ ...EMPTY_COMPANY, ...(getSetting<Partial<CompanyProfile>>(COMPANY_KEY) || {}) });
});

// PUT /api/templates/company — save company profile (admin)
router.put('/company', requireRole('admin'), (req, res) => {
  const input = parseBody(companyProfileSchema, req.body);
  const profile: CompanyProfile = {
    name: input.name ?? '', address: input.address ?? '', phone: input.phone ?? '',
    email: input.email ?? '', logo_url: input.logo_url ?? '',
  };
  setSetting(COMPANY_KEY, profile);
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
router.post('/', requireRole('admin'), (req, res) => {
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
router.put('/:id', requireRole('admin'), (req, res) => {
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
router.delete('/:id', requireRole('admin'), (req, res) => {
  const info = run('DELETE FROM doc_templates WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
