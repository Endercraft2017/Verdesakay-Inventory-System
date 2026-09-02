/**
 * Form actions — automated side effects a form definition fires when one of its records is
 * created (or advances to `approved`). Configured per-form as `form_definitions.actions`
 * (JSON), edited in Form Builder, and seeded on the ready-made HR memo/notice forms
 * (src/db.ts seedMemoForms).
 *
 * Every action is best-effort: a failure is recorded and returned as a warning string, never
 * thrown — issuing the record must not fail because (say) SMTP is down. Idempotency is per
 * (record, action type): once an action has a `success` row in form_record_action_runs it is
 * not run again, so re-saving / re-approving a record is safe.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, queryOne, queryAll, run, uploadDir } from './db';
import { notifyUser } from './push';
import { sendMail, mailReady } from './mailer';
import { companyProfile } from './ph-payroll-report-data';
import { resolvePermissions } from './permissions';
import type { FormAction, FormDefinition, FieldDef, Role } from './types';

export type ActionTrigger = 'create' | 'approved';

interface RunArgs {
  recordId: number;
  recordNumber: string;
  formDef: Pick<FormDefinition, 'id' | 'name' | 'fields' | 'actions' | 'template_id'>;
  data: Record<string, unknown>;
  trigger: ActionTrigger;
  actingUserId: number;
}

interface ResolvedEmployee {
  id: number;
  name: string;
  user_id: number | null;
  email: string | null;
  department_id: number | null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return raw as T;
  try { return JSON.parse(String(raw ?? '')) as T; } catch { return fallback; }
}

/** The employee this record is about — from a field of type `employee` (value is the name),
 *  else a plain `employee_name` / `employee_id` in the data. Null if none / no match. */
function resolveEmployee(fields: FieldDef[], data: Record<string, unknown>): ResolvedEmployee | null {
  const empField = fields.find((f) => f.type === 'employee');
  const name = empField ? data[empField.key] : (data.employee_name ?? data.employee);
  const id = data.employee_id;
  let row: ResolvedEmployee | undefined;
  if (id != null && String(id).trim() !== '') {
    row = queryOne<ResolvedEmployee>(
      `SELECT e.id, e.name, e.user_id, u.email, e.department_id
       FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`, Number(id));
  }
  if (!row && name != null && String(name).trim() !== '') {
    row = queryOne<ResolvedEmployee>(
      `SELECT e.id, e.name, e.user_id, u.email, e.department_id
       FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.name = ?`, String(name).trim());
  }
  return row ?? null;
}

/** Substitute {number} {form} {employee} {link} {field:KEY} in a short notify template. */
function fillTemplate(tpl: string, ctx: { number: string; form: string; employee: string; link: string; data: Record<string, unknown> }): string {
  return tpl
    .replace(/\{number\}/g, ctx.number)
    .replace(/\{form\}/g, ctx.form)
    .replace(/\{employee\}/g, ctx.employee)
    .replace(/\{link\}/g, ctx.link)
    .replace(/\{field:([a-z0-9_]+)\}/gi, (_m, k: string) => String(ctx.data[k] ?? ''));
}

/** Render a form's linked doc_template body to standalone HTML by plain {{key}} substitution
 *  (no formula engine — see docs). Used to file a snapshot of the notice into the 201 file. */
function renderTemplateHtml(templateId: number | null, ctx: Record<string, unknown>): string | null {
  if (!templateId) return null;
  const tpl = queryOne<{ body: string }>('SELECT body FROM doc_templates WHERE id = ?', templateId);
  if (!tpl) return null;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) flat[k] = v == null ? '' : String(v);
  const co = companyProfile();
  flat['company.name'] = String(co.name ?? '');
  flat['company.address'] = String(co.address ?? '');
  flat['company.phone'] = String(co.phone ?? '');
  flat['company.email'] = String(co.email ?? '');
  const body = tpl.body.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, k: string) => flat[k] ?? '');
  return `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
}

function alreadySucceeded(recordId: number, type: string): boolean {
  return !!queryOne<{ id: number }>(
    "SELECT id FROM form_record_action_runs WHERE form_record_id = ? AND action_type = ? AND status = 'success'",
    recordId, type);
}

function logRun(recordId: number, type: string, status: 'success' | 'skipped' | 'error', detail: string): void {
  run('INSERT INTO form_record_action_runs (form_record_id, action_type, status, detail) VALUES (?, ?, ?, ?)',
    recordId, type, status, detail.slice(0, 500));
}

/** Run every configured action whose `run_on` matches `trigger`. Returns human-readable
 *  warnings for actions that were skipped or failed (shown to the user as a toast). */
export function runFormActions(args: RunArgs): { warnings: string[] } {
  const warnings: string[] = [];
  const actions = parseJson<FormAction[]>(args.formDef.actions, []);
  if (!actions.length) return { warnings };
  const fields = parseJson<FieldDef[]>(args.formDef.fields, []);
  const due = actions.filter((a) => (a.run_on ?? 'create') === args.trigger);
  if (!due.length) return { warnings };

  const employee = resolveEmployee(fields, args.data);
  const link = `#/form-records?form_id=${args.formDef.id}`;
  const tplCtx: Record<string, unknown> = {
    ...args.data,
    number: args.recordNumber,
    today: new Date().toISOString().slice(0, 10),
  };

  for (const action of due) {
    if (alreadySucceeded(args.recordId, action.type)) continue;
    try {
      switch (action.type) {
        case 'notify_employee': {
          if (!employee) { warnings.push('Notify employee: no employee on this record'); logRun(args.recordId, action.type, 'skipped', 'no employee'); break; }
          if (!employee.user_id) { warnings.push(`Notify employee: ${employee.name} has no login account`); logRun(args.recordId, action.type, 'skipped', 'no user_id'); break; }
          const subject = fillTemplate(action.subject || '{form} — {number}', { number: args.recordNumber, form: args.formDef.name, employee: employee.name, link, data: args.data });
          const body = fillTemplate(
            action.body || 'You have been issued a {form} ({number}). Please review it with HR.',
            { number: args.recordNumber, form: args.formDef.name, employee: employee.name, link, data: args.data });
          const info = run('INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?)',
            args.actingUserId, employee.user_id, subject, body);
          void notifyUser(employee.user_id, { title: subject, body: body.length > 140 ? body.slice(0, 137) + '…' : body, url: '#/messages' });
          logRun(args.recordId, action.type, 'success', `message ${info.lastInsertRowid}`);
          break;
        }
        case 'save_to_201': {
          if (!employee) { warnings.push('File to 201: no employee on this record'); logRun(args.recordId, action.type, 'skipped', 'no employee'); break; }
          const html = renderTemplateHtml(args.formDef.template_id, tplCtx);
          if (!html) { warnings.push('File to 201: this form has no printable template'); logRun(args.recordId, action.type, 'skipped', 'no template'); break; }
          const stored = `mm-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.html`;
          fs.writeFileSync(path.join(uploadDir(), stored), html, 'utf8');
          const title = `${args.formDef.name} ${args.recordNumber}`;
          const info = run(
            `INSERT INTO employee_documents (employee_id, title, stored_name, original_name, mime_type, size_bytes, uploaded_by)
             VALUES (?, ?, ?, ?, 'text/html', ?, ?)`,
            employee.id, title, stored, `${title}.html`, Buffer.byteLength(html), args.actingUserId);
          logRun(args.recordId, action.type, 'success', `employee_document ${info.lastInsertRowid}`);
          break;
        }
        case 'email_employee': {
          if (!employee) { warnings.push('Email employee: no employee on this record'); logRun(args.recordId, action.type, 'skipped', 'no employee'); break; }
          if (!employee.email) { warnings.push(`Email employee: ${employee.name} has no email on file`); logRun(args.recordId, action.type, 'skipped', 'no email'); break; }
          if (!mailReady()) { warnings.push('Email employee: company email is not configured'); logRun(args.recordId, action.type, 'skipped', 'smtp off'); break; }
          const html = renderTemplateHtml(args.formDef.template_id, tplCtx)
            || `<p>You have been issued a ${args.formDef.name} (${args.recordNumber}).</p>`;
          const subject = fillTemplate(action.subject || '{form} — {number}', { number: args.recordNumber, form: args.formDef.name, employee: employee.name, link, data: args.data });
          void sendMail({ to: employee.email, subject, html }, args.actingUserId)
            .then((r) => logRun(args.recordId, action.type, r.ok ? 'success' : 'error', r.error || 'sent'))
            .catch((e) => logRun(args.recordId, action.type, 'error', String(e)));
          break;
        }
        case 'notify_hr': {
          const recipients = new Set<number>();
          if (employee?.department_id) {
            const head = queryOne<{ head_user_id: number | null }>('SELECT head_user_id FROM departments WHERE id = ?', employee.department_id);
            if (head?.head_user_id) recipients.add(head.head_user_id);
          }
          if (!recipients.size) {
            for (const u of queryAll<{ id: number; role: Role; permission_overrides: string | null }>(
              'SELECT id, role, permission_overrides FROM users WHERE active = 1')) {
              let ov: Record<string, boolean> = {};
              try { ov = u.permission_overrides ? JSON.parse(u.permission_overrides) : {}; } catch { ov = {}; }
              if (resolvePermissions(u.role, ov).includes('hr.manage')) recipients.add(u.id);
            }
          }
          recipients.delete(args.actingUserId);
          if (!recipients.size) { warnings.push('Notify HR: no HR recipient found'); logRun(args.recordId, action.type, 'skipped', 'no recipient'); break; }
          const subject = `${args.formDef.name} issued — ${args.recordNumber}`;
          const body = `A ${args.formDef.name} (${args.recordNumber}) was issued${employee ? ` for ${employee.name}` : ''}.`;
          for (const rid of recipients) {
            run('INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?)', args.actingUserId, rid, subject, body);
            void notifyUser(rid, { title: subject, body, url: link });
          }
          logRun(args.recordId, action.type, 'success', `${recipients.size} recipient(s)`);
          break;
        }
        case 'create_followup_task': {
          const dueDate = action.due_field ? String(args.data[action.due_field] ?? '').slice(0, 10) : '';
          const title = (action.title || `Follow up: ${args.formDef.name} ${args.recordNumber}`)
            + (employee ? ` (${employee.name})` : '');
          const info = run('INSERT INTO tasks (user_id, title, due_date, notes) VALUES (?, ?, ?, ?)',
            args.actingUserId, title, dueDate || null, `Auto-created from ${args.formDef.name} ${args.recordNumber}`);
          logRun(args.recordId, action.type, 'success', `task ${info.lastInsertRowid}`);
          break;
        }
        case 'apply_no_work':
          // No runtime effect — consumed by src/routes/hr.routes.ts generate-payslips, which
          // reads records of any form whose actions include apply_no_work.
          break;
        default:
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`${action.type}: ${msg}`);
      logRun(args.recordId, action.type, 'error', msg);
    }
  }
  return { warnings };
}

/** Form definition ids whose `actions` include `apply_no_work` — the set generate-payslips
 *  should pull company-wide no-work ranges from (in addition to the seeded `no_work_memo`). */
export function noWorkFormIds(): number[] {
  const rows = queryAll<{ id: number; actions: string }>(
    "SELECT id, actions FROM form_definitions WHERE actions LIKE '%apply_no_work%'");
  return rows
    .filter((r) => parseJson<FormAction[]>(r.actions, []).some((a) => a.type === 'apply_no_work'))
    .map((r) => r.id);
}
