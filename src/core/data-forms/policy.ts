import type { Request, Response } from 'express';
import { queryOne, nextFormRecordNumber } from '../../shared/db';
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
export function nextRecordNumber(prefix: string, _formId: number): string {
  return nextFormRecordNumber(prefix);
}

export const FORM_SCOPES: FormScope[] = ['hr', 'inventory', 'admin', 'accounting'];
export const ANY_FORMS_MANAGE: Permission[] = FORM_SCOPES.map((s) => `forms.manage.${s}` as Permission);

/** Definition management remains scoped to its owning section. General forms require
 * all four management permissions; record entry is checked separately below. */
export function canManageScope(req: Request, res: Response, scope: FormScope | null): boolean {
  const ok = scope
    ? req.user!.permissions.includes(`forms.manage.${scope}` as Permission)
    : FORM_SCOPES.every((s) => req.user!.permissions.includes(`forms.manage.${s}` as Permission));
  if (!ok) res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  return ok;
}

/** Entry requires both the account capability and a grant on this particular form.
 * Always load current grants: revocations also apply to sync replay and direct record URLs. */
export function canEnterForm(req:Request, form:{id?:number;form_def_id?:number;scope:FormScope|null}):boolean {
  if(form.scope!=='inventory'||!req.user!.permissions.includes('forms.fill.inventory'))return false;
  const row=queryOne<{entry_access:string}>('SELECT entry_access FROM form_definitions WHERE id=?',form.form_def_id??form.id??0);
  try {const access=JSON.parse(row?.entry_access||'{}');return Array.isArray(access.roles)&&access.roles.includes(req.user!.role)||Array.isArray(access.users)&&access.users.includes(req.user!.id);}catch{return false;}
}

/** Payslips use their independent payroll permissions. Inventory entry is restricted to
 * assigned forms; callers additionally enforce draft-only writes and manager-only deletes. */
export function canAccessRecords(req: Request, res: Response, form: { id?:number;form_def_id?:number;scope: FormScope | null; slug: string }, write: boolean): boolean {
  if (form.slug === PAYROLL_FORM_SLUG) {
    const ok = req.user!.permissions.includes(write ? 'payroll.manage' : 'payroll.view');
    if (!ok) res.status(403).json({ error: 'Forbidden: payslips need the payroll permission' });
    return ok;
  }
  if(canEnterForm(req,form))return true;
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
