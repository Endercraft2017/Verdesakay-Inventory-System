/**
 * AI HR-forms tools — let the assistant read the memo / NTE / notice forms and *propose*
 * a new record for a human to review. Additive to src/ai-tools.ts the same way ai-analytics
 * is: getToolsForUser merges the specs in, executeTool delegates unknown names here.
 *
 * Reads are gated by the same forms.manage.<scope> permission the REST routes use.
 * `propose_form_record` never writes — it returns a draft the frontend opens in the normal
 * "New record" modal, so the user always confirms (and the real POST fires the form actions).
 */
import { queryAll, queryOne } from '../../shared/db';
import type { CerebrasTool, ToolResult } from './ai-tools';
import type { AuthUser, FormScope, Permission, FieldDef, FormAction } from '../../shared/types';

type HrFormToolName =
  | 'list_form_types'
  | 'search_form_records'
  | 'get_form_record'
  | 'propose_form_record';

const SCOPES: FormScope[] = ['hr', 'inventory', 'admin', 'accounting'];

function canManageScope(user: AuthUser, scope: FormScope | null): boolean {
  return scope
    ? user.permissions.includes(`forms.manage.${scope}` as Permission)
    : SCOPES.every((s) => user.permissions.includes(`forms.manage.${s}` as Permission));
}

/** Any of the read tools need at least hr.view or one forms.manage.* scope. */
function canUseHrFormTools(user: AuthUser): boolean {
  return user.permissions.includes('hr.view')
    || SCOPES.some((s) => user.permissions.includes(`forms.manage.${s}` as Permission));
}

function parse<T>(raw: unknown, fallback: T): T {
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return raw as T;
  try { return JSON.parse(String(raw ?? '')) as T; } catch { return fallback; }
}

interface DefRow {
  id: number; name: string; slug: string; scope: FormScope | null;
  fields: string; actions: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Specs
// ─────────────────────────────────────────────────────────────────────────────

const SPECS: Record<HrFormToolName, CerebrasTool> = {
  list_form_types: {
    type: 'function',
    function: {
      name: 'list_form_types',
      description:
        'List the data-form / memo / notice types (Notice to Explain, General Memo, Disciplinary Action, Return to Work, No Work Memo, HR Payroll, …), each with its fields and the automated actions it fires when a record is issued.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: "Filter by owning section: hr | inventory | admin | accounting." },
        },
      },
    },
  },
  search_form_records: {
    type: 'function',
    function: {
      name: 'search_form_records',
      description:
        'Search issued records of a form (e.g. all Notice to Explain records for an employee). Returns each record\'s number, status, created date and field values.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Form slug, e.g. nte, memo_general, disciplinary_action, return_to_work, no_work_memo.' },
          scope: { type: 'string', description: 'Or search every form in a section: hr | inventory | admin | accounting.' },
          q: { type: 'string', description: 'Case-insensitive text match over the record number and field values (e.g. an employee name).' },
          status: { type: 'string', description: 'draft | submitted | approved | rejected | completed | paid' },
          limit: { type: 'number', description: 'Max records (default 20, max 100).' },
        },
      },
    },
  },
  get_form_record: {
    type: 'function',
    function: {
      name: 'get_form_record',
      description: 'Get one issued form record in full by its id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'form_records.id' } },
        required: ['id'],
      },
    },
  },
  propose_form_record: {
    type: 'function',
    function: {
      name: 'propose_form_record',
      description:
        "Draft a new memo / notice / form record for the user to review and issue. Does NOT create or send anything — it returns a pre-filled draft the user confirms in the app, which then runs the form's actions (notify the employee, file to their 201, …). Use this whenever the user asks to issue/write/send an NTE, memo, disciplinary notice, etc.",
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Form slug, e.g. nte, memo_general, disciplinary_action, return_to_work.' },
          data: {
            type: 'object',
            description: 'Field values keyed by field key. Use the exact employee full name for the employee field. Include every required field you can.',
          },
        },
        required: ['slug', 'data'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function hrFormToolsForUser(user: AuthUser): CerebrasTool[] {
  if (!canUseHrFormTools(user)) return [];
  return Object.values(SPECS);
}

export function isHrFormTool(name: string): boolean {
  return name in SPECS;
}

export function executeHrFormTool(name: string, args: unknown, user: AuthUser): ToolResult {
  const n = name as HrFormToolName;
  if (!(n in SPECS)) return { success: false, error: `Unknown tool: ${name}` };
  if (!canUseHrFormTools(user)) return { success: false, error: 'Permission denied.' };
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (n) {
      case 'list_form_types': {
        const scope = typeof a.scope === 'string' ? a.scope : '';
        const rows = queryAll<DefRow>(
          `SELECT id, name, slug, scope, fields, actions FROM form_definitions
           ${scope ? 'WHERE scope = ?' : ''} ORDER BY scope, name`,
          ...(scope ? [scope] : []));
        return {
          success: true,
          data: rows
            .filter((r) => canManageScope(user, r.scope) || user.permissions.includes('hr.view'))
            .map((r) => ({
              id: r.id, name: r.name, slug: r.slug, scope: r.scope,
              fields: parse<FieldDef[]>(r.fields, []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required })),
              actions: parse<FormAction[]>(r.actions, []).map((x) => ({ type: x.type, run_on: x.run_on ?? 'create' })),
            })),
        };
      }

      case 'search_form_records': {
        const slug = typeof a.slug === 'string' ? a.slug : '';
        const scope = typeof a.scope === 'string' ? a.scope : '';
        const defs = queryAll<DefRow>(
          `SELECT id, name, slug, scope, fields, actions FROM form_definitions
           ${slug ? 'WHERE slug = ?' : scope ? 'WHERE scope = ?' : ''}`,
          ...(slug ? [slug] : scope ? [scope] : []))
          .filter((d) => canManageScope(user, d.scope));
        if (!defs.length) return { success: false, error: 'No matching form you can access.' };

        const status = typeof a.status === 'string' ? a.status.trim() : '';
        const q = typeof a.q === 'string' ? a.q.trim().toLowerCase() : '';
        const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
        const ids = defs.map((d) => d.id);
        const defById = new Map(defs.map((d) => [d.id, d]));
        let rows = queryAll<{ id: number; form_def_id: number; number: string; data: string; status: string; created_at: string }>(
          `SELECT id, form_def_id, number, data, status, created_at FROM form_records
           WHERE form_def_id IN (${ids.map(() => '?').join(',')}) ${status ? 'AND status = ?' : ''}
           ORDER BY id DESC LIMIT 500`,
          ...ids, ...(status ? [status] : []));
        const out = rows
          .map((r) => ({
            id: r.id, number: r.number, status: r.status, created_at: r.created_at,
            form: defById.get(r.form_def_id)?.name, slug: defById.get(r.form_def_id)?.slug,
            data: parse<Record<string, unknown>>(r.data, {}),
          }))
          .filter((r) => !q
            || r.number.toLowerCase().includes(q)
            || Object.values(r.data).some((v) => String(v ?? '').toLowerCase().includes(q)))
          .slice(0, limit);
        return { success: true, data: out };
      }

      case 'get_form_record': {
        const row = queryOne<{ id: number; number: string; data: string; status: string; created_at: string; name: string; scope: FormScope | null; slug: string }>(
          `SELECT fr.id, fr.number, fr.data, fr.status, fr.created_at,
                  fd.name, fd.scope, fd.slug
           FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id
           WHERE fr.id = ?`, Number(a.id));
        if (!row) return { success: false, error: 'Record not found.' };
        if (!canManageScope(user, row.scope)) return { success: false, error: 'Permission denied.' };
        return {
          success: true,
          data: { id: row.id, number: row.number, status: row.status, created_at: row.created_at, form: row.name, slug: row.slug, data: parse<Record<string, unknown>>(row.data, {}) },
        };
      }

      case 'propose_form_record': {
        const slug = typeof a.slug === 'string' ? a.slug : '';
        if (!slug) return { success: false, error: 'slug is required.' };
        const def = queryOne<DefRow>('SELECT id, name, slug, scope, fields, actions FROM form_definitions WHERE slug = ?', slug);
        if (!def) return { success: false, error: `No form with slug "${slug}".` };
        if (!canManageScope(user, def.scope)) return { success: false, error: `You cannot issue ${def.name} records.` };

        const fields = parse<FieldDef[]>(def.fields, []);
        const inData = (a.data && typeof a.data === 'object') ? a.data as Record<string, unknown> : {};
        // Keep only known field keys.
        const data: Record<string, unknown> = {};
        for (const f of fields) if (inData[f.key] != null) data[f.key] = inData[f.key];

        // Resolve the employee for a preview (exact name match, like the record modal).
        const empField = fields.find((f) => f.type === 'employee');
        let employee_match: { id: number; name: string; has_account: boolean } | null = null;
        if (empField && data[empField.key]) {
          const emp = queryOne<{ id: number; name: string; user_id: number | null }>(
            'SELECT id, name, user_id FROM employees WHERE name = ?', String(data[empField.key]).trim());
          if (emp) employee_match = { id: emp.id, name: emp.name, has_account: emp.user_id != null };
        }
        const missing_required = fields.filter((f) => f.required && !data[f.key]).map((f) => f.key);

        return {
          success: true,
          data: {
            proposed: true,
            form_def_id: def.id,
            slug: def.slug,
            form_name: def.name,
            data,
            employee_match,
            missing_required,
            actions: parse<FormAction[]>(def.actions, []).map((x) => x.type),
            note: 'Draft only — not issued. The user must review and confirm it in the app.',
          },
        };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
