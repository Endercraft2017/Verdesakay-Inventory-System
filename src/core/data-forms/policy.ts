import type { Request, Response } from 'express';
import { nextSequence } from '../../shared/db';
import type { FieldDef, FormScope, Permission } from '../../shared/types';
import { PAYROLL_FORM_SLUG } from '../../modules/payroll/pay-access';
import { ValidationError } from '../../shared/validation';
export function parseFields(raw: string | null): unknown[] {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

export function parseActions(raw: string | null): unknown[] {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

export function parseData(raw: string | null): Record<string, unknown> {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/** Next record number for a form definition, e.g. FM-00001 (counter in settings). */
export function nextRecordNumber(prefix: string, formId: number): string {
  return nextSequence(`form_seq_${formId}`, prefix);
}

export const FORM_SCOPES: FormScope[] = ['hr', 'inventory', 'admin', 'accounting'];
export const ANY_FORMS_MANAGE: Permission[] = FORM_SCOPES.map((s) => `forms.manage.${s}` as Permission);

/** A form's required permission depends on its own `scope`, not just the route — so this is a
    plain check called inline rather than a static requirePermission(...) middleware. General
    (null-scope) forms require *all four* forms.manage.* — deliberately stricter than any single
    section, so a form nobody explicitly sectioned doesn't become manageable by whichever role
    happens to hold just one scope. In practice only admin holds all four by default, making
    General effectively admin-managed, the right default for an unowned bucket. Writes the 403
    itself and returns whether the caller may proceed. Also the read gate for form_definitions/
    records and form_records/:id (there's no separate forms.view.<scope> tier for this system —
    manage is the only permission level, so browsing a section's records requires the same
    permission as managing them; a self-filer's own submissions stay visible via the separate,
    ownership-scoped GET /me/requests instead). */
export function canManageScope(req: Request, res: Response, scope: FormScope | null): boolean {
  const ok = scope
    ? req.user!.permissions.includes(`forms.manage.${scope}` as Permission)
    : FORM_SCOPES.every((s) => req.user!.permissions.includes(`forms.manage.${s}` as Permission));
  if (!ok) res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  return ok;
}

/** Read/write gate for one form's RECORDS. Payslips (the hr_payroll form) are pay data, so they
    take payroll.view to read and payroll.manage to write instead of the HR section's
    forms.manage.hr (modules/payroll/pay-access.ts); every other form uses canManageScope. Writes
    the 403 itself and returns whether the caller may proceed. */
export function canAccessRecords(req: Request, res: Response, form: { scope: FormScope | null; slug: string }, write: boolean): boolean {
  if (form.slug === PAYROLL_FORM_SLUG) {
    const ok = req.user!.permissions.includes(write ? 'payroll.manage' : 'payroll.view');
    if (!ok) res.status(403).json({ error: 'Forbidden: payslips need the payroll permission' });
    return ok;
  }
  return canManageScope(req, res, form.scope);
}

export function hasFormScopeAccess(permissions: Permission[], scope: FormScope | null): boolean {
  return scope
    ? permissions.includes(`forms.manage.${scope}` as Permission)
    : ANY_FORMS_MANAGE.every((permission) => permissions.includes(permission));
}

/** Required checkboxes are consent: only an explicit checked value is accepted.
 * Mobile historically stores Yes/No, while desktop stores booleans. */
export function validateRequiredCheckboxes(rawFields: FormDefinitionFields, data: Record<string, unknown>): void {
  const fields = typeof rawFields === 'string' ? parseFields(rawFields) : rawFields;
  if (!Array.isArray(fields)) return;
  for (const field of fields as FieldDef[]) {
    if (field.type === 'checkbox' && field.required && data[field.key] !== true && data[field.key] !== 'Yes') {
      throw new ValidationError(`"${field.label}" must be checked`);
    }
  }
}
type FormDefinitionFields = string | FieldDef[];
