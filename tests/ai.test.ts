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

function makeCerebrasReply(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined }, finish_reason: 'stop' }],
  };
}

function makeCerebrasToolCall(id: string, name: string, args: object) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function mockFetch(...responses: object[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = responses[Math.min(call++, responses.length - 1)];
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/ai/chat', () => {
  beforeEach(() => { process.env.CEREBRAS_API_KEY = 'test-key'; });
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

  it('send_message tool creates a real message', async () => {
    // Create a second user to message
    const recipient = await createEmployee(ctx.api, adminToken, { role: 'admin_staff' });

    mockFetch(
      makeCerebrasToolCall('tc5', 'send_message', {
        recipient_id: recipient.id,
        subject: 'AI Test',
        body: 'Hello from AI',
      }),
      makeCerebrasReply('Message sent!'),
    );

    const res = await ctx.api
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [{ role: 'user', content: `Message user ${recipient.id}` }] });

    expect(res.status).toBe(200);
    const step = res.body.steps[0];
    expect(step.result.success).toBe(true);
    // Tool confirms who it was sent to
    expect(step.result.data.sent_to).toBeTruthy();
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

// ─── Tool execution unit tests (no HTTP) ──────────────────────────────────

describe('executeTool unit tests', () => {
  it('adjust_stock rejects zero change', async () => {
    const { executeTool } = await import('../src/ai-tools');
    // Need a user object — we'll build a minimal one
    const { db } = await import('../src/db');
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
    const { executeTool } = await import('../src/ai-tools');
    const { db } = await import('../src/db');
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
    const { executeTool } = await import('../src/ai-tools');
    const { db } = await import('../src/db');
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
    const { executeTool } = await import('../src/ai-tools');
    const { db } = await import('../src/db');
    const user = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number };
    const result = await executeTool('create_order', {
      type: 'purchase', items: [{ name: 'Bond paper', quantity: 2, unit_price: 150 }],
    }, {
      id: user.id, username: 'admin', full_name: 'Admin', role: 'admin',
      department_id: null, active: 1, department_name: null,
      permissions: ['orders.create'],
    });
    expect(result.success).toBe(true);
    expect((result.data as { number: string }).number).toMatch(/^PR-\d{5}$/);
  });

  it('update_user refuses to demote the last active administrator', async () => {
    const { executeTool } = await import('../src/ai-tools');
    const { db } = await import('../src/db');
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
    const { executeTool } = await import('../src/ai-tools');
    const { db } = await import('../src/db');
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
