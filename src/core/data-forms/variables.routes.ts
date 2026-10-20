import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, memoTemplateBody } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody,
  formDefinitionSchema,
  linkFormTemplateSchema,
  templateSchema,
  createFormRecordSchema,
  updateFormRecordSchema,
  globalVariableSchema,
} from '../../shared/validation';
import { parsePayrollSummaryCsv } from '../../modules/payroll/hr-payroll-import';
import { PAYROLL_FORM_SLUG } from '../../modules/payroll/pay-access';
import { runFormActions } from '../form-actions';
import { cutoffIsPaid, notifyApprovers } from '../../modules/hr/workflow';
import { normalizeRequest, attachLeave, leaveWarnings, requestEmployeeId, scheduledLeaveDates } from '../../modules/hr/request-data';
import { REQUEST_SLUGS } from './request-types';
import { INFO_CHANGE_SLUG, prepareInfoChange } from '../../modules/hr/info-change';
import type { DocTemplate, FormDefinition, FormRecord, GlobalVariable, FormScope, Permission } from '../../shared/types';
import { syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { templateRevision, checkTemplateRevision, templateWrite, checkStudioPublish, studioPublished, migrateStudioDocument } from '../doc-template-version';

const router = Router();
router.use(requireAuth);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

import { parseFields, parseActions, parseData, nextRecordNumber, canManageScope, canAccessRecords, FORM_SCOPES, ANY_FORMS_MANAGE, validateRequiredCheckboxes } from './policy';
// ─── Global Variables ─────────────────────────────────────────────────────────

// GET /api/global-variables — list all (any user, for template rendering)
router.get('/global-variables', (_req, res) => {
  res.json(queryAll<GlobalVariable>('SELECT * FROM global_variables ORDER BY key'));
});

// PUT /api/global-variables/:key — upsert (any forms.manage.* — genuinely global/shared, not
// owned by one section)
router.put('/global-variables/:key', requirePermission('forms.variables'), syncClass('claim'), (req, res) => {
  const key = String(req.params.key ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(key)) {
    res.status(400).json({ error: 'Key must be lowercase letters, numbers, or underscores' });
    return;
  }
  const input = parseBody(globalVariableSchema, req.body);
  run(
    `INSERT INTO global_variables (key, label, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE
       SET label = excluded.label, value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key,
    input.label,
    input.value,
    req.user!.id
  );
  res.json({ ok: true });
});

// DELETE /api/global-variables/:key (any forms.manage.*)
router.delete('/global-variables/:key', requirePermission('forms.variables'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM global_variables WHERE key = ?', req.params.key);
  if (info.changes === 0) { res.status(404).json({ error: 'Variable not found' }); return; }
  res.json({ ok: true });
});


export default router;
