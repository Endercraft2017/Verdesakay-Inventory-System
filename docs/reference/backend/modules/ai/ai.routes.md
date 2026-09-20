# `src/modules/ai/ai.routes.ts`

## Purpose
Implements the single AI Assistant endpoint, `POST /api/ai/chat`: builds a system prompt scoped to
the caller's identity/permissions, drives an agentic loop against the Cerebras chat-completions API
(OpenAI-compatible), executes any tool calls the model requests via `src/modules/ai/ai-tools.ts`, and returns
the final natural-language reply plus a step-by-step trace of tool calls.

## Routes / Exports

Only one router-level middleware and one route.

| Method & path | Auth | Body schema | Description |
|---|---|---|---|
| (all) | `requireAuth` (`router.use(requireAuth)`, line 19) | — | Every route on this router requires a valid session; `req.user!` is guaranteed non-null after this point. |
| `POST /chat` (mounted at `/api/ai/chat`) | 🔑 any logged-in user | `chatSchema` | Agentic chat turn: runs the tool-calling loop and returns `{reply, steps}`. |

### `chatSchema`
```ts
z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).min(1).max(40),
})
```
Validated with `chatSchema.safeParse(req.body)` directly (not via the shared `parseBody` helper
from `src/shared/validation.ts` — this route does its own inline 400 handling instead of throwing a
`ValidationError`).

### `POST /chat` — step by step
1. `chatSchema.safeParse` — on failure, responds `400 {error: <first zod issue message>}` directly
   (does not use the central error handler's `ValidationError` path).
2. Reads `req.user!` (guaranteed by `requireAuth`).
3. Reads `process.env.CEREBRAS_API_KEY`; if unset/empty, responds `503 {error: 'AI is not configured — set CEREBRAS_API_KEY on the server.'}`.
4. `tools = getToolsForUser(user)` — the permission-filtered tool list (see `src/modules/ai/ai-tools.ts`).
5. Builds the initial Cerebras message list: one `system` message from `buildSystemPrompt(user, today)`
   followed by the client-supplied `messages` (role/content only — no history persisted server-side;
   the client resends full history each turn per the file's top comment).
6. Runs up to `MAX_ITERATIONS = 8` loop iterations:
   - Calls `callCerebras(cebrasMsgs, tools, apiKey)`.
   - Takes `response.choices[0]`; if absent, breaks out of the loop entirely.
   - Pushes the assistant message onto `cebrasMsgs`.
   - If the assistant message has no `tool_calls` (or an empty array), that's the final answer:
     responds `200 {reply: msg.content ?? '', steps}` and returns immediately.
   - Otherwise, for each `tool_calls` entry: parses `tc.function.arguments` as JSON (falls back to
     `{}` on parse failure), calls `executeTool(tc.function.name, args, user)`, appends
     `{tool, args, result}` to `steps`, and pushes a `role:'tool'` message (with `tool_call_id`,
     `name`, and `content: JSON.stringify(result)`) back onto `cebrasMsgs` for the next iteration.
7. If the loop exhausts all 8 iterations without a final (non-tool-call) answer, responds `200`
   with the **last assistant message that had non-null content** found by scanning `cebrasMsgs`
   in reverse (`reply: lastAssistant?.content ?? 'Unable to complete the request.'`), plus the
   accumulated `steps`.
8. Any thrown error (e.g. a Cerebras HTTP failure surfaced by `callCerebras`) is passed to `next(e)`,
   landing in `app.ts`'s central error handler.

**Success response (200):** `{ reply: string, steps: Array<{tool: string, args: unknown, result: ToolResult}> }`

**Error cases:**
| Status | When |
|---|---|
| 400 | `chatSchema` validation fails (empty/oversized `messages`, bad `role`, empty/oversized `content`) |
| 401 | No/invalid/expired bearer token (via `requireAuth`) |
| 503 | `CEREBRAS_API_KEY` env var not set |
| 500 | Cerebras API returns non-OK status (`callCerebras` throws `Cerebras API error <status>: <body>`), or any other unexpected exception — caught by the central handler in `app.ts` |

### Helper functions (not exported)
- `buildSystemPrompt(user: AuthUser, today: string): string` — assembles a multi-line system
  prompt: identity line (`user.full_name`, `role`, optional `department_name`), today's date
  (`YYYY-MM-DD`), a comma-joined list of the tool names the user can call (from
  `getToolsForUser(user)`), and behavioral instructions (use tools instead of guessing, confirm
  mutating actions with key details, stay concise, decline politely if outside permitted tools).
- `callCerebras(messages, tools, apiKey): Promise<CerebrasResponse>` — POSTs to
  `https://api.cerebras.ai/v1/chat/completions` with `{model, messages, max_tokens: 2048, temperature: 0.2}`,
  adding `tools`/`tool_choice: 'auto'` only if `tools.length > 0`. Throws on a non-OK HTTP response
  (includes up to 400 chars of the response body in the error message). `MODEL` is read once at
  module load from `process.env.CEREBRAS_MODEL ?? 'llama-4-scout-17b-16e-instruct'`.

### Local type shapes (Cerebras / OpenAI-compatible)
`ToolCall` (`{id, type:'function', function:{name, arguments: string}}`), `CerebrasMessage`
(`{role: 'system'|'user'|'assistant'|'tool', content: string|null, tool_calls?, tool_call_id?, name?}`),
`CerebrasChoice` (`{message, finish_reason}`), `CerebrasResponse` (`{choices: CerebrasChoice[]}`).
These are hand-declared, not imported from an SDK.

## Dependencies
- `express` — `Router`.
- `zod` — `z`, for `chatSchema`.
- `../auth` — `requireAuth` middleware.
- `../ai-tools` — `getToolsForUser`, `executeTool` (the tool catalogue and dispatcher this route drives).
- `../types` — `AuthUser` (typing `buildSystemPrompt`'s parameter).
- Global `fetch` (Node's built-in) — calls the Cerebras HTTP API directly, no SDK dependency.

## Used by
- `src/app.ts` — mounted as `app.use('/api/ai', aiRoutes)`.
- `tests/ai.test.ts` — exercises `POST /api/ai/chat` end-to-end (mocks or exercises the Cerebras
  call and asserts tool-permission filtering, error statuses, etc.).
- `public/js/tools.js` — the frontend's right-rail AI Assistant (`openAI()`) is the sole browser
  caller of `POST /api/ai/chat`.

## Notes / gotchas
- The endpoint is **stateless**: no conversation history is stored server-side between requests;
  the frontend (`aiHistory` in `public/js/tools.js`) is responsible for resending the full
  transcript (bounded to 40 messages / 8000 chars each by `chatSchema`).
- There is no dedicated rate limiter on `/api/ai/chat` (unlike `/api/auth/login`, which has
  `loginLimiter` in `app.ts`) — it only inherits the global Express middleware stack.
- Tool permission is checked **twice**: once implicitly by `getToolsForUser` (the model is never
  shown a disallowed tool name), and again inside `executeTool` in `ai-tools.ts` (defence in depth
  against a model naming a tool outside what it was offered).
- If `response.choices[0]` is ever undefined (malformed Cerebras response), the loop silently
  `break`s and falls through to the iteration-cap fallback response rather than erroring.
- Tool-call argument JSON-parse failures are swallowed silently (`args = {}`), so a malformed
  tool-call from the model results in the tool executing with empty args rather than an explicit error.
