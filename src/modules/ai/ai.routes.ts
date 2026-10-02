/**
 * AI Agent chat endpoint.
 *
 * POST /api/ai/chat
 *   Body: { messages: [{role:'user'|'assistant', content:string}][] }
 *   Response: { reply: string, steps: [{tool:string, args:object, result:object}][] }
 *
 * The route runs an agentic loop: it calls the LLM, executes any tool calls, feeds the
 * results back, and continues until the model stops calling tools (or MAX_ITERATIONS hit).
 * All tool access is gated by the caller's effective permissions from auth.ts.
 *
 * GET/DELETE /api/ai/messages — the caller's conversation persists in `ai_messages` across
 * sessions/reloads (saved as a side effect of each successful /chat turn) until they clear
 * it via DELETE. Each user has exactly one running conversation, no multi-thread history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../shared/auth';
import { getToolsForUser, executeTool } from './ai-tools';
import { REPORT_FILE_RE } from './ai-reporting';
import { reindex } from './rag';
import { uploadDir, queryAll, run } from '../../shared/db';
import { getAiConfig, activeAiConfig, saveAiConfig, addTokenUsage, tokenCapReached, resetTokenUsage } from './ai-config';
import { enforceQuota, recordAiCall } from '../../platform/quota';
import { parseBody, aiConfigSchema } from '../../shared/validation';
import type { AuthUser } from '../../shared/types';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);

// POST /api/ai/reindex — rebuild the knowledge-search index now (admin).
router.post('/reindex', requirePermission('audit.view'), (_req, res) => {
  try {
    res.json({ ok: true, chunks: reindex() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Reindex failed' });
  }
});

// GET /api/ai/reports/:name — download a report the assistant generated
router.get('/reports/:name', (req, res) => {
  const name = req.params.name;
  if (!REPORT_FILE_RE.test(name)) {
    res.status(400).json({ error: 'Bad report name' });
    return;
  }
  const file = path.join(uploadDir(), name);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'Report not found — it may have been cleared.' });
    return;
  }
  const nice = name.replace(/^ai-report-/, '').replace(/-\d{10,}-[a-f0-9]+(\.\w+)$/, '$1');
  res.download(file, nice);
});

// ─────────────────────────────────────────────────────────────────────────────
// Saved chat history — persists per user across sessions until they clear it.
// ─────────────────────────────────────────────────────────────────────────────

interface AiMessageRow {
  id: number; role: 'user' | 'assistant'; content: string; steps: string | null; created_at: string;
}

// GET /api/ai/messages — the caller's saved conversation, oldest first
router.get('/messages', (req, res) => {
  const rows = queryAll<AiMessageRow>(
    'SELECT id, role, content, steps, created_at FROM ai_messages WHERE user_id = ? ORDER BY id',
    req.user!.id
  );
  res.json(rows.map((r) => ({ ...r, steps: r.steps ? JSON.parse(r.steps) : undefined })));
});

// DELETE /api/ai/messages — clear the caller's saved conversation
// The assistant, its key and its history are cloud-only (D8): on an installed PC these say so.
router.delete('/messages', syncClass('online'), (req, res) => {
  run('DELETE FROM ai_messages WHERE user_id = ?', req.user!.id);
  res.json({ ok: true });
});

function saveTurn(userId: number, userContent: string, reply: string, steps: unknown[]): void {
  run('INSERT INTO ai_messages (user_id, role, content) VALUES (?, ?, ?)', userId, 'user', userContent);
  run(
    'INSERT INTO ai_messages (user_id, role, content, steps) VALUES (?, ?, ?, ?)',
    userId,
    'assistant',
    reply,
    steps.length ? JSON.stringify(steps) : null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 12; // room for multi-step report building

// GET /api/ai/config — model / endpoint / whether a key is set (key never returned)
router.get('/config', requirePermission('users.manage'), (_req, res) => {
  res.json(getAiConfig());
});

// PUT /api/ai/config — { model?, base_url?, api_key?, token_cap? } (api_key '' clears → env
// fallback; token_cap 0 = unlimited)
router.put('/config', requirePermission('users.manage'), syncClass('online'), (req, res) => {
  saveAiConfig(parseBody(aiConfigSchema, req.body));
  res.json(getAiConfig());
});

// POST /api/ai/reset-usage — zero the running token counter (doesn't touch the cap itself)
router.post('/reset-usage', requirePermission('users.manage'), syncClass('online'), (_req, res) => {
  resetTokenUsage();
  res.json(getAiConfig());
});

// ─────────────────────────────────────────────────────────────────────────────
// Request schema
// ─────────────────────────────────────────────────────────────────────────────

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(40),
});

// ─────────────────────────────────────────────────────────────────────────────
// Cerebras types (OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CerebrasMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface CerebrasChoice {
  message: CerebrasMessage;
  finish_reason: string;
}

interface CerebrasResponse {
  choices: CerebrasChoice[];
  /** Standard OpenAI-compatible usage block — present on every non-streaming provider this
      app talks to (OpenAI, Gemini's OpenAI-compat endpoint, Groq, Cerebras, OpenRouter).
      Optional defensively; a provider that omits it just doesn't meter that call. */
  usage?: { total_tokens?: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(user: AuthUser, today: string): string {
  const toolNames = getToolsForUser(user).map((t) => t.function.name).join(', ');
  return [
    `You are the Verdesakay Office System AI Assistant — a helpful, professional, concise assistant embedded in a company's LAN office application.`,
    ``,
    `Current user: ${user.full_name} | Role: ${user.role}${user.department_name ? ` | Department: ${user.department_name}` : ''}.`,
    `Today's date: ${today}.`,
    ``,
    `You have access to the following tools: ${toolNames}.`,
    `Use tools whenever the user asks about real data — never guess at quantities, IDs, or names. If a lookup returns nothing, say so clearly.`,
    `For any count, ranking, total, or "who/what always…" question, call an analytics/report tool (or run_analytics_query) — never estimate a number from memory or prose.`,
    `For questions about policies, uploaded files, notes, or QC/failure reasons, call search_knowledge and answer from the returned passages (cite their ref labels).`,
    `For reports, gather the data with tools first, then present it as a clear titled summary with sections and tables. Offer create_report_document if the user wants a file.`,
    `When you take an action (create, update, delete, send), confirm what was done with the key details.`,
    `Format numbers clearly. Keep responses concise. If something is outside your permitted tools, say so politely.`,
  ].join('\n');
}

async function callLlm(
  messages: CerebrasMessage[],
  tools: object[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<CerebrasResponse> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 2048,
    temperature: 0.2,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<CerebrasResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

router.post('/chat', syncClass('online'), async (req, res, next) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({ error: issue ? issue.message : 'Invalid request' });
      return;
    }
    const { messages } = parsed.data;
    const user = req.user!;
    // The client always appends the new turn as the last user message before posting —
    // that's what gets saved to ai_messages alongside the reply (see saveTurn below).
    const newUserMessage = [...messages].reverse().find((m) => m.role === 'user');

    const { api_key: apiKey, base_url: baseUrl, model } = activeAiConfig();
    if (!apiKey) {
      res.status(503).json({ error: 'AI is not configured. An admin can add an API key under the AI Assistant settings.' });
      return;
    }
    if (tokenCapReached()) {
      res.status(402).json({ error: 'The AI Assistant\'s token usage cap has been reached. An admin can raise it or reset usage under AI Assistant settings.' });
      return;
    }
    enforceQuota('ai_calls_month');
    recordAiCall();

    const tools = getToolsForUser(user);
    const today = new Date().toISOString().slice(0, 10);

    const cebrasMsgs: CerebrasMessage[] = [
      { role: 'system', content: buildSystemPrompt(user, today) },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    const steps: Array<{ tool: string; args: unknown; result: unknown }> = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Re-check before every call, not just once at the top — a single chat turn can make
      // several LLM calls across the tool-use loop below, and each one spends real tokens;
      // this stops a long multi-step turn as soon as it crosses the cap instead of only
      // catching it on the *next* turn.
      if (i > 0 && tokenCapReached()) {
        res.status(402).json({ error: 'The AI Assistant\'s token usage cap was reached mid-conversation. An admin can raise it or reset usage under AI Assistant settings.' });
        return;
      }
      const response = await callLlm(cebrasMsgs, tools, apiKey, baseUrl, model);
      addTokenUsage(response.usage?.total_tokens ?? 0);
      const choice = response.choices[0];
      if (!choice) break;
      const msg = choice.message;
      cebrasMsgs.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Model gave a final answer
        const reply = msg.content ?? '';
        if (newUserMessage) saveTurn(user.id, newUserMessage.content, reply, steps);
        res.json({ reply, steps });
        return;
      }

      // Execute each tool call and feed results back
      for (const tc of msg.tool_calls) {
        let args: unknown = {};
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        const result = await executeTool(tc.function.name, args, user);
        steps.push({ tool: tc.function.name, args, result });

        cebrasMsgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
    }

    // Hit the iteration cap — return whatever the model last said
    const lastAssistant = [...cebrasMsgs].reverse().find((m) => m.role === 'assistant' && m.content);
    const reply = lastAssistant?.content ?? 'Unable to complete the request.';
    if (newUserMessage) saveTurn(user.id, newUserMessage.content, reply, steps);
    res.json({ reply, steps });
  } catch (e) {
    next(e);
  }
});

export default router;
