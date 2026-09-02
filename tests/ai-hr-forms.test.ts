/** AI HR-forms tools — executed directly (no LLM). Permission gating + the propose flow
    which must NOT persist anything. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { ALL_PERMISSIONS } from '../src/permissions';
import type { AuthUser, Permission } from '../src/types';

let ctx: TestContext;
let token: string;
let exec: typeof import('../src/ai-hr-forms').executeHrFormTool;
let toolsFor: typeof import('../src/ai-hr-forms').hrFormToolsForUser;

const authHdr = () => ({ Authorization: `Bearer ${token}` });
const user = (perms: Permission[]): AuthUser => ({
  id: 1, username: 'admin', full_name: 'Admin', role: 'admin',
  department_id: null, active: 1, department_name: null, permissions: perms,
});
const admin = () => user([...ALL_PERMISSIONS]);

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  const mod = await import('../src/ai-hr-forms');
  exec = mod.executeHrFormTool;
  toolsFor = mod.hrFormToolsForUser;
});
afterAll(() => cleanup(ctx));

describe('ai-hr-forms: gating', () => {
  it('hides all tools from a user with neither hr.view nor forms.manage.*', () => {
    expect(toolsFor(user(['inventory.view'])).length).toBe(0);
    expect(exec('list_form_types', {}, user(['inventory.view']))).toMatchObject({ success: false });
  });

  it('exposes the tools to an HR user', () => {
    const names = toolsFor(user(['hr.view'])).map((t) => t.function.name);
    expect(names).toContain('list_form_types');
    expect(names).toContain('propose_form_record');
  });
});

describe('ai-hr-forms: list + propose', () => {
  it('list_form_types includes the seeded NTE with its actions', () => {
    const r = exec('list_form_types', { scope: 'hr' }, admin());
    expect(r.success).toBe(true);
    const nte = (r.data as Array<{ slug: string; actions: Array<{ type: string }> }>).find((f) => f.slug === 'nte');
    expect(nte).toBeTruthy();
    expect(nte!.actions.map((a) => a.type)).toContain('notify_employee');
  });

  it('propose_form_record returns a draft and writes nothing', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(authHdr())
      .send({ employee_no: 'TEST-AI-1', name: 'AI Propose Target', daily_rate: 500 });

    const recordsBefore = async () => {
      const list = await ctx.api.get('/api/form-definitions').set(authHdr());
      const nte = list.body.find((f: { slug: string }) => f.slug === 'nte');
      return (await ctx.api.get(`/api/form-definitions/${nte.id}/records`).set(authHdr())).body.length;
    };
    const before = await recordsBefore();

    const r = exec('propose_form_record', {
      slug: 'nte',
      data: { employee_name: 'AI Propose Target', subject: 'Tardiness', junk_key: 'dropped' },
    }, admin());
    expect(r.success).toBe(true);
    const d = r.data as {
      proposed: boolean; slug: string; form_def_id: number;
      data: Record<string, unknown>; employee_match: { id: number; has_account: boolean } | null;
      missing_required: string[];
    };
    expect(d.proposed).toBe(true);
    expect(d.slug).toBe('nte');
    expect(d.data.subject).toBe('Tardiness');
    expect(d.data).not.toHaveProperty('junk_key'); // unknown keys stripped
    expect(d.employee_match?.id).toBe(emp.body.id);
    expect(d.employee_match?.has_account).toBe(false);
    expect(d.missing_required).toContain('incident_date');

    expect(await recordsBefore()).toBe(before); // nothing persisted
  });

  it('propose_form_record denies a scope the user cannot manage', () => {
    const r = exec('propose_form_record', { slug: 'nte', data: {} }, user(['hr.view']));
    expect(r).toMatchObject({ success: false });
  });
});
