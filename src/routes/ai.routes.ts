/**
 * AI Agent chat endpoint.
 *
 * POST /api/ai/chat
 *   Body: { messages: [{role:'user'|'assistant', content:string}][] }
 *   Response: { reply: string, steps: [{tool:string, args:object, result:object}][] }
 *
 * The route runs an agentic loop: it calls Cerebras, executes any tool calls, feeds the
 * results back, and continues until the model stops calling tools (or MAX_ITERATIONS hit).
 * All tool access is gated by the caller's effective permissions from auth.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { getToolsForUser, executeTool } from '../ai-tools';
import type { AuthUser } from '../types';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const MODEL = process.env.CEREBRAS_MODEL ?? 'llama-4-scout-17b-16e-instruct';
const MAX_ITERATIONS = 8;

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
    `When you take an action (create, update, delete, send), confirm what was done with the key details.`,
    `Format numbers clearly. Keep responses concise. If something is outside your permitted tools, say so politely.`,
  ].join('\n');
}

async function callCerebras(
  messages: CerebrasMessage[],
  tools: object[],
  apiKey: string,
): Promise<CerebrasResponse> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    max_tokens: 2048,
    temperature: 0.2,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(CEREBRAS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cerebras API error ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<CerebrasResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

router.post('/chat', async (req, res, next) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({ error: issue ? issue.message : 'Invalid request' });
      return;
    }
    const { messages } = parsed.data;
    const user = req.user!;

    const apiKey = process.env.CEREBRAS_API_KEY ?? '';
    if (!apiKey) {
      res.status(503).json({ error: 'AI is not configured — set CEREBRAS_API_KEY on the server.' });
      return;
    }

    const tools = getToolsForUser(user);
    const today = new Date().toISOString().slice(0, 10);

    const cebrasMsgs: CerebrasMessage[] = [
      { role: 'system', content: buildSystemPrompt(user, today) },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    const steps: Array<{ tool: string; args: unknown; result: unknown }> = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await callCerebras(cebrasMsgs, tools, apiKey);
      const choice = response.choices[0];
      if (!choice) break;
      const msg = choice.message;
      cebrasMsgs.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Model gave a final answer
        res.json({ reply: msg.content ?? '', steps });
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
    res.json({ reply: lastAssistant?.content ?? 'Unable to complete the request.', steps });
  } catch (e) {
    next(e);
  }
});

export default router;
