import dns from 'node:dns/promises';
/**
 * Tests for the AI agent route (POST /api/ai/chat).
 *
 * Cerebras is mocked via global fetch mock — no network calls are made.
 * Tests cover:
 *   - Auth guard (401 without token)
 *   - 503 when CEREBRAS_API_KEY is missing
 *   - Basic chat (direct reply, no tools)
 *   - Agentic tool execution (search_inventory)
 *   - Permission filtering (hr role cannot see inventory tools)
 *   - Tool execution: search_inventory, get_inventory_stats, send_message, get_notes
 *   - Validation: empty messages array, content too long
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});

afterAll(() => cleanup(ctx));

// ─── Fetch mock helpers ────────────────────────────────────────────────────

function makeCerebrasReply(content: string, totalTokens?: number) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined }, finish_reason: 'stop' }],
    ...(totalTokens != null ? { usage: { total_tokens: totalTokens } } : {}),
  };
}

function makeCerebrasToolCall(id: string, name: string, args: object, totalTokens?: number) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
    ...(totalTokens != null ? { usage: { total_tokens: totalTokens } } : {}),
  };
}

function mockFetch(...responses: object[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = responses[Math.min(call++, responses.length - 1)];
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/ai/chat', () => {
  beforeEach(() => { process.env.CEREBRAS_API_KEY = 'test-key'; vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never); });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CEREBRAS_API_KEY; });

  it('401 without a token', async () => {
    const res = await ctx.api.post('/api/ai/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('503 when CEREBRAS_API_KEY is not set', async () => {
    delete process.env.CEREBRAS_API_KEY;
    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('400 with empty messages array', async () => {
    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it('400 when message content is empty string', async () => {
    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: '' }] });
    expect(res.status).toBe(400);
  });

  it('returns a plain reply (no tool calls)', async () => {
    mockFetch(makeCerebrasReply('Hello! How can I help you today?'));
    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'Hello' }] });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Hello! How can I help you today?');
    expect(res.body.steps).toEqual([]);
  });

  it('executes a tool and feeds the result back', async () => {
    // First call: model asks for inventory stats
    // Second call: model replies with final text
    mockFetch(
      makeCerebrasToolCall('tc1', 'get_inventory_stats', {}),
      makeCerebrasReply('You have 0 items and 0 low-stock alerts.'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'How many items are in inventory?' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('0');
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].tool).toBe('get_inventory_stats');
    expect(res.body.steps[0].result.success).toBe(true);
  });

  it('executes search_inventory and returns item data', async () => {
    // Create a test item first
    await ctx.api
      .post('/api/inventory')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test Widget', sku: 'TW-001', quantity: 50, unit: 'pcs' });

    mockFetch(
      makeCerebrasToolCall('tc2', 'search_inventory', { query: 'Widget' }),
      makeCerebrasReply('Found 1 item: Test Widget (50 pcs).'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'Find Widget items' }] });

    expect(res.status).toBe(200);
    const step = res.body.steps[0];
    expect(step.tool).toBe('search_inventory');
    const items = step.result.data as Array<{ name: string }>;
    expect(items.some((i) => i.name === 'Test Widget')).toBe(true);
  });

  it('permission filtering: hr role cannot call search_inventory', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });

    // Simulate model trying to call search_inventory (which hr can't use)
    mockFetch(
      makeCerebrasToolCall('tc3', 'search_inventory', {}),
      makeCerebrasReply('I cannot search inventory with your permissions.'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${hr.token}`)
      .send({ messages: [{ role: 'user', content: 'Show me all inventory' }] });

    expect(res.status).toBe(200);
    // The tool result should indicate failure
    const step = res.body.steps[0];
    expect(step.result.success).toBe(false);
    expect(step.result.error).toMatch(/permission/i);
  });

  it('personal tools are available to all roles', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });

    mockFetch(
      makeCerebrasToolCall('tc4', 'get_notes', {}),
      makeCerebrasReply('You have no notes yet.'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${hr.token}`)
      .send({ messages: [{ role: 'user', content: 'Show my notes' }] });

    expect(res.status).toBe(200);
    expect(res.body.steps[0].tool).toBe('get_notes');
    expect(res.body.steps[0].result.success).toBe(true);
  });

  it('send_message waits for the person to confirm, then sends exactly once', async () => {
    // Create a second user to message
    const recipient = await createEmployee(ctx.api, adminToken, { role: 'admin_staff' });

    mockFetch(
      makeCerebrasToolCall('tc5', 'send_message', {
        recipient_id: recipient.id,
        subject: 'AI Test',
        body: 'Hello from AI',
      }),
      makeCerebrasReply('Ready to send — please confirm.'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: `Message user ${recipient.id}` }] });

    expect(res.status).toBe(200);
    // Nothing was sent yet: the call is parked for confirmation.
    expect(res.body.steps[0].result.data.status).toBe('awaiting_confirmation');
    expect(res.body.pending).toHaveLength(1);
    const { queryOne } = await import('../src/shared/db');
    const sentCount = () => queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%Hello from AI%'")!.n;
    expect(sentCount()).toBe(0);

    const id = res.body.pending[0].id;
    const confirm = await ctx.api.post(`/api/ai/actions/${id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.ok).toBe(true);
    expect(confirm.body.result.data.sent_to).toBeTruthy();
    expect(sentCount()).toBe(1);
    // A second click (or a replay) does nothing.
    expect((await ctx.api.post(`/api/ai/actions/${id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(404);
    expect(sentCount()).toBe(1);
  });

  it('a prepared action can be cancelled, and only by the person it was prepared for', async () => {
    mockFetch(
      makeCerebrasToolCall('tc5b', 'delete_note', { id: 999 }),
      makeCerebrasReply('Confirm to delete.'),
    );
    const res = await ctx.api.post('/api/ai/chat').set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'delete note 999' }] });
    const id = res.body.pending[0].id;
    const other = await createEmployee(ctx.api, adminToken, { role: 'admin_staff' });
    const otherToken = await login(ctx.api, other.username, other.password);
    expect((await ctx.api.post(`/api/ai/actions/${id}/confirm`).set('Authorization', `Bearer ${otherToken}`).send({})).status).toBe(404);
    expect((await ctx.api.post(`/api/ai/actions/${id}/cancel`).set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(200);
    expect((await ctx.api.post(`/api/ai/actions/${id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(404);
  });

  it('get_departments tool returns seeded departments', async () => {
    mockFetch(
      makeCerebrasToolCall('tc6', 'get_departments', {}),
      makeCerebrasReply('Departments loaded.'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: 'List departments' }] });

    expect(res.status).toBe(200);
    const depts = res.body.steps[0].result.data as Array<{ name: string }>;
    expect(depts.some((d) => d.name === 'Finance')).toBe(true);
    expect(depts.some((d) => d.name === 'IT')).toBe(true);
  });

  it('handles multi-turn conversation (history round-trip)', async () => {
    mockFetch(makeCerebrasReply('Got your follow-up!'));

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        messages: [
          { role: 'user', content: 'What is the inventory count?' },
          { role: 'assistant', content: 'There are 1 items.' },
          { role: 'user', content: 'Show me the details.' },
        ],
      });

    expect(res.status).toBe(200);
    // Verify the fetch was called once (history forwarded correctly)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const calledBody = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit).body as string);
    // Should include system + 3 history messages = 4 total
    expect(calledBody.messages.length).toBe(4);
  });
});

describe('GET/DELETE /api/ai/messages — saved conversation history', () => {
  const hdr = () => ({ Authorization: `Bearer ${adminToken}` });
  beforeEach(async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    process.env.CEREBRAS_API_KEY = 'test-key';
    await ctx.api.delete('/api/ai/messages').set(hdr()); // clean slate
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CEREBRAS_API_KEY; });

  it('starts empty, then saves the user turn and the reply after a successful chat', async () => {
    expect((await ctx.api.get('/api/ai/messages').set(hdr())).body).toEqual([]);

    mockFetch(makeCerebrasReply('Hi there!'));
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'Hello' }] });

    const saved = (await ctx.api.get('/api/ai/messages').set(hdr())).body;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(saved[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
    expect(saved[1].steps).toBeUndefined(); // no tool calls this turn
  });

  it('persists the tool-call trail alongside the assistant reply', async () => {
    mockFetch(
      makeCerebrasToolCall('tcs1', 'get_notes', {}),
      makeCerebrasReply('You have no notes.'),
    );
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'notes?' }] });

    const saved = (await ctx.api.get('/api/ai/messages').set(hdr())).body;
    expect(saved[1].steps).toHaveLength(1);
    expect(saved[1].steps[0].tool).toBe('get_notes');
  });

  it('accumulates across multiple turns, in order', async () => {
    mockFetch(makeCerebrasReply('First reply'));
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'One' }] });
    mockFetch(makeCerebrasReply('Second reply'));
    await ctx.api.post('/api/ai/chat').set(hdr())
      .send({ messages: [{ role: 'user', content: 'One' }, { role: 'assistant', content: 'First reply' }, { role: 'user', content: 'Two' }] });

    const saved = (await ctx.api.get('/api/ai/messages').set(hdr())).body;
    expect(saved.map((m: { content: string }) => m.content)).toEqual(['One', 'First reply', 'Two', 'Second reply']);
  });

  it('does not persist a turn when the LLM call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'will fail' }] });
    expect(res.status).toBe(500);
    expect((await ctx.api.get('/api/ai/messages').set(hdr())).body).toEqual([]);
  });

  it('DELETE clears the conversation; each user only sees their own', async () => {
    const bob = await createEmployee(ctx.api, adminToken, { username: 'bob_ai' });

    mockFetch(makeCerebrasReply('Admin reply'));
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'admin says hi' }] });
    mockFetch(makeCerebrasReply('Bob reply'));
    await ctx.api.post('/api/ai/chat').set({ Authorization: `Bearer ${bob.token}` })
      .send({ messages: [{ role: 'user', content: 'bob says hi' }] });

    expect((await ctx.api.get('/api/ai/messages').set(hdr())).body).toHaveLength(2);
    expect((await ctx.api.get('/api/ai/messages').set({ Authorization: `Bearer ${bob.token}` })).body).toHaveLength(2);

    await ctx.api.delete('/api/ai/messages').set(hdr());
    expect((await ctx.api.get('/api/ai/messages').set(hdr())).body).toEqual([]);
    // bob's conversation is untouched by admin's delete
    expect((await ctx.api.get('/api/ai/messages').set({ Authorization: `Bearer ${bob.token}` })).body).toHaveLength(2);
  });

  it('requires auth', async () => {
    expect((await ctx.api.get('/api/ai/messages')).status).toBe(401);
    expect((await ctx.api.delete('/api/ai/messages')).status).toBe(401);
  });
});

describe('token usage cap', () => {
  const hdr = () => ({ Authorization: `Bearer ${adminToken}` });
  beforeEach(async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    process.env.CEREBRAS_API_KEY = 'test-key';
    // Clean slate: no cap, zero usage, before each test in this block.
    await ctx.api.put('/api/ai/config').set(hdr()).send({ token_cap: 0 });
    await ctx.api.post('/api/ai/reset-usage').set(hdr());
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CEREBRAS_API_KEY; });

  it('accumulates usage.total_tokens from the LLM response, summed across every call in one turn', async () => {
    mockFetch(
      makeCerebrasToolCall('tu1', 'get_notes', {}, 120),
      makeCerebrasReply('Done.', 80),
    );
    const res = await ctx.api.post('/api/ai/chat').set(hdr())
      .send({ messages: [{ role: 'user', content: 'notes?' }] });
    expect(res.status).toBe(200);

    const cfg = await ctx.api.get('/api/ai/config').set(hdr());
    expect(cfg.body.tokens_used).toBe(200); // 120 + 80, not just the last call's 80
  });

  it('refuses a new chat once usage reaches the cap, with a clear 402', async () => {
    const fetchSpy = mockFetch(makeCerebrasReply('First.', 500));
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'hi' }] });
    await ctx.api.put('/api/ai/config').set(hdr()).send({ token_cap: 500 }); // exactly at usage
    fetchSpy.mockClear(); // isolate the call count check below to just the next request

    const res = await ctx.api.post('/api/ai/chat').set(hdr())
      .send({ messages: [{ role: 'user', content: 'again?' }] });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/cap/i);
    expect(globalThis.fetch).not.toHaveBeenCalled(); // blocked before ever calling the LLM
  });

  it('a cap of 0 never blocks, regardless of usage', async () => {
    mockFetch(makeCerebrasReply('Fine.', 999_999));
    const first = await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(first.status).toBe(200);

    mockFetch(makeCerebrasReply('Still fine.', 1));
    const second = await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'hi again' }] });
    expect(second.status).toBe(200);
  });

  it('reset-usage clears the counter (cap unchanged) and unblocks further chat', async () => {
    mockFetch(makeCerebrasReply('First.', 300));
    await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'hi' }] });
    await ctx.api.put('/api/ai/config').set(hdr()).send({ token_cap: 300 });

    const blocked = await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'again' }] });
    expect(blocked.status).toBe(402);

    const reset = await ctx.api.post('/api/ai/reset-usage').set(hdr());
    expect(reset.body.tokens_used).toBe(0);
    expect(reset.body.token_cap).toBe(300); // cap itself is untouched by a reset

    mockFetch(makeCerebrasReply('Working again.', 1));
    const after = await ctx.api.post('/api/ai/chat').set(hdr()).send({ messages: [{ role: 'user', content: 'once more' }] });
    expect(after.status).toBe(200);
  });

  it('reset-usage and a negative/absurd token_cap are both users.manage-gated', async () => {
    const wh = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    expect((await ctx.api.post('/api/ai/reset-usage').set('Authorization', `Bearer ${wh.token}`)).status).toBe(403);
    expect((await ctx.api.put('/api/ai/config').set(hdr()).send({ token_cap: -5 })).status).toBe(400);
  });
});

// ─── Tool execution unit tests (no HTTP) ──────────────────────────────────

describe('executeTool unit tests', () => {
  it('adjust_stock rejects zero change', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    // Need a user object — we'll build a minimal one
    const { db } = await import('../src/shared/db');
    const user = db.prepare('SELECT u.id, u.role FROM users u LIMIT 1').get() as { id: number; role: string };
    const result = await executeTool('adjust_stock', { id: 999, change: 0 }, {
      id: user.id, username: 'admin', full_name: 'Admin', role: user.role as 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['inventory.adjust'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-zero/i);
  });

  it('send_message rejects self-messages', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    const { db } = await import('../src/shared/db');
    const user = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number };
    const result = await executeTool('send_message', { recipient_id: user.id, body: 'hello' }, {
      id: user.id, username: 'admin', full_name: 'Admin', role: 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['messages.send'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/yourself/i);
  });

  it('adjust_stock rejects a change that would drop quantity below zero', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    const { db } = await import('../src/shared/db');
    const user = db.prepare('SELECT u.id, u.role FROM users u LIMIT 1').get() as { id: number; role: string };
    const admin = {
      id: user.id, username: 'admin', full_name: 'Admin', role: user.role as 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['inventory.adjust', 'inventory.create'] as const,
    };
    const created = await executeTool('create_inventory_item', {
      name: 'AI Widget', sku: 'AI-NEG-1', category: 'General', quantity: 5, unit: 'pcs', min_quantity: 0,
    }, { ...admin, permissions: [...admin.permissions] });
    expect(created.success).toBe(true);
    const itemId = (created.data as { id: number }).id;
    const result = await executeTool('adjust_stock', { id: itemId, change: -10 }, { ...admin, permissions: [...admin.permissions] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not enough stock/i);
  });

  it('create_order supports purchase orders with a PR- number', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    const { db } = await import('../src/shared/db');
    const user = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number };
    const caller = (permissions: string[]) => ({
      id: user.id, username: 'admin', full_name: 'Admin', role: 'admin',
      department_id: null, active: 1, department_name: null, permissions,
    }) as never;
    const order = { type: 'purchase', items: [{ name: 'Bond paper', quantity: 2, unit_price: 150 }] };
    // Purchase orders are purchasing's (src/modules/inventory/order-access.ts): orders.create alone is refused.
    expect((await executeTool('create_order', order, caller(['orders.create']))).success).toBe(false);
    const result = await executeTool('create_order', order, caller(['orders.create', 'purchasing.manage']));
    expect(result.success).toBe(true);
    expect((result.data as { number: string }).number).toMatch(/^PR-\d{5}$/);
    // type comes back so the frontend can build a "View purchase request" link (public/js/tools.js's
    // actionForStep()) without having to re-derive it from the order number's prefix.
    expect((result.data as { type: string }).type).toBe('purchase');
  });

  it('update_user refuses to demote the last active administrator', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    const { db } = await import('../src/shared/db');
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: number };
    const result = await executeTool('update_user', { id: admin.id, role: 'admin_staff' }, {
      id: admin.id, username: 'admin', full_name: 'Admin', role: 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['users.manage'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/last active administrator/i);
  });

  it('create_user rejects an invalid username via the same validation as the REST route', async () => {
    const { executeTool } = await import('../src/modules/ai/ai-tools');
    const { db } = await import('../src/shared/db');
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: number };
    const result = await executeTool('create_user', {
      username: 'AN INVALID USERNAME!', full_name: 'Test', password: 'password123',
    }, {
      id: admin.id, username: 'admin', full_name: 'Admin', role: 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['users.manage'],
    });
    expect(result.success).toBe(false);
  });
});
