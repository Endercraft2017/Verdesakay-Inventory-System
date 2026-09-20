# AI Agent — Developer & Admin Reference

> **Last updated:** 2026-06-29

The AI Assistant is a right-rail tool in the Verdesakay Office System that lets users query data and take actions using natural language. It is powered by any OpenAI-compatible LLM (Gemini Flash-Lite by default) and runs a server-side agentic loop that executes tools against the live SQLite database on the user's behalf.

---

## Architecture Overview

```
User types message
       │
       ▼
POST /api/ai/chat  (Bearer token)
       │
       ▼
src/modules/ai/ai.routes.ts
  - builds system prompt with user context
  - filters tools to those user can call (via effective permissions)
  - calls the LLM API with tool specs
       │
       ▼
The LLM (default: gemini-2.5-flash-lite)
  - may call 0-N tools per turn
       │
       ▼
src/modules/ai/ai-tools.ts  executeTool()
  - checks permission again (defence in depth)
  - runs the tool against the SQLite DB
  - returns ToolResult {success, data|error}
       │
       ▼
Tool result fed back to the LLM
  - loop continues up to 8 iterations
  - stops when model returns no tool_calls
       │
       ▼
Response: { reply: string, steps: [{tool, args, result}][] }
       │
       ▼
public/js/tools.js  openAI()
  - shows typing indicator while waiting
  - renders tool-activity chips above the reply
  - appends bot message with light markdown rendering
```

---

## Configuration

**Per-tenant, BYO key.** Settings live in the `settings` k/v store (key `ai_config` + the
AES-encrypted `ai_api_key`) via `src/modules/ai/ai-config.ts`, editable at **AI Assistant → AI
settings** (`users.manage`) or `PUT /api/ai/config` — `{model, base_url, api_key}`. Any
**OpenAI-compatible** chat-completions endpoint works; the modal has presets for Gemini /
OpenAI / Groq / Cerebras / OpenRouter. The env vars below are the **platform fallback**
when a tenant hasn't set its own key. `GET /api/ai/config` returns
`{model, base_url, has_key, key_source: 'tenant'|'platform'|'none'}` — never the key.

**Platform default: Google Gemini Flash-Lite** ("mini") — modest reasoning, ~1M-token
context, cheap — via its OpenAI-compatibility endpoint. Point a tenant/env at any other
provider as needed.

| Environment variable | Default | Description |
|---|---|---|
| `AI_API_KEY` (or legacy `CEREBRAS_API_KEY`) | *(fallback)* | Platform API key, used when a tenant has none. 503 if neither is set. |
| `AI_MODEL` (or `CEREBRAS_MODEL`) | `gemini-2.5-flash-lite` | Default model. |
| `AI_BASE_URL` (or `CEREBRAS_URL`) | `…/v1beta/openai/chat/completions` (Gemini) | Default chat-completions endpoint. |

Gemini config: model `gemini-2.5-flash-lite`, endpoint
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, an
`AIza…` API key.

Set the platform fallback key before starting the server (or leave it unset and have each
tenant add their own under **AI Assistant → AI settings**):

```bash
# Windows PowerShell — Gemini (the default provider)
$env:AI_API_KEY = "AIza..."
npm start
```

---

## Permission Model

Tools are gated by the caller's **effective permissions**, which are resolved when the user's session is loaded (`src/shared/auth.ts → userFromToken`):

1. The user's `role` maps to a default permission set (`src/shared/permissions.ts → ROLE_DEFAULTS`).
2. Admin can grant or revoke individual permissions per user via `users.permission_overrides` (sparse JSON diff).
3. The merged set is stored on `req.user.permissions: Permission[]`.

The AI route calls `getToolsForUser(user)` which filters the full tool catalogue down to only those covered by a permission the user holds. The model only *sees* the tools it can call — it cannot be tricked into calling a tool it doesn't have access to.

### Role → default tools

| Role | Key capabilities |
|---|---|
| `admin` | Every tool |
| `admin_staff` | Inventory CRUD + adjust, order CRUD, messages, forms, personal tools |
| `accounting` | Inventory view, order create/edit, messages, forms, personal tools |
| `warehouse` | Inventory CRUD + adjust, order view, messages, forms, personal tools |
| `releasing` | Inventory view + adjust, order view/edit, messages, forms, personal tools |
| `csr` | Inventory view, order create/edit, messages, forms, personal tools |
| `hr` | User list, messages, forms, HR forms/memos (read + propose), attendance reports, personal tools |
| `marketing` | Inventory view, order view, messages, forms, personal tools |

Personal tools (notes, tasks) are available to **every authenticated user** regardless of role.

---

## Tool Catalogue

All tools are defined in `src/modules/ai/ai-tools.ts`. The full list by category:

### Utility

| Tool | Permission | Description |
|---|---|---|
| `get_departments` | *none* | List all departments (id + name). |

### Inventory

| Tool | Permission | Description |
|---|---|---|
| `search_inventory` | `inventory.view` | Search/filter items (keyword, dept, category, low-stock). Returns ≤ 50. |
| `get_inventory_item` | `inventory.view` | Full item details + last 20 stock movements. |
| `get_inventory_stats` | `inventory.view` | Dashboard totals: count, qty, low-stock, top categories. |
| `create_inventory_item` | `inventory.create` | Create item; initial qty recorded as first transaction. |
| `update_inventory_item` | `inventory.edit` | Update item details (not quantity). |
| `adjust_stock` | `inventory.adjust` | Stock in/out; appends to audit trail. |
| `delete_inventory_item` | `inventory.delete` | Permanent delete of item + history. |

### Orders

| Tool | Permission | Description |
|---|---|---|
| `search_orders` | `orders.view` | List orders, filter by type / keyword. Returns ≤ 30. |
| `get_order` | `orders.view` | Order detail with all line items. |
| `create_order` | `orders.create` | Create order with auto-number (SO-#####/JO-#####); server computes totals. |
| `update_order` | `orders.edit` | Replace order items; server recomputes totals. |
| `delete_order` | `orders.delete` | Permanent delete of order + line items. |

### Messages

| Tool | Permission | Description |
|---|---|---|
| `get_messages` | `messages.view` | Inbox or sent (most recent 20). |
| `send_message` | `messages.send` | Send an internal message by recipient user ID. |
| `get_unread_count` | `messages.view` | Number of unread inbox messages. |
| `mark_message_read` | `messages.view` | Mark one message as read. |

### Forms / Documents

| Tool | Permission | Description |
|---|---|---|
| `get_forms` | `forms.view` | List visible forms (dept-scoped + company-wide). |

### User Management

| Tool | Permission | Description |
|---|---|---|
| `list_users` | `users.manage` | Full user directory (id, role, dept, active). |
| `create_user` | `users.manage` | Create a new account with hashed password. |
| `update_user` | `users.manage` | Change name, role, dept, or active status. |

### Personal Tools (no permission required)

| Tool | Description |
|---|---|
| `get_notes` | List the caller's notes. |
| `create_note` | Create a note. |
| `update_note` | Update a note (caller's own only). |
| `delete_note` | Delete a note (caller's own only). |
| `get_tasks` | List the caller's tasks (pending first). |
| `create_task` | Create a task with optional due date. |
| `update_task` | Update title, due date, or done status. |
| `delete_task` | Delete a task. |

### Analytics & reporting (`src/modules/ai/ai-analytics.ts`)

Read-only report tools, merged into `getToolsForUser` / `executeTool` and gated the same way.

| Tool | Permission | Description |
|---|---|---|
| `attendance_report` | `hr.view` | Per-employee days recorded / present / absent / late + late minutes over a range. |
| `chronic_lateness` | `hr.view` | Employees late on ≥ N days (time-in later than shift start + grace). |
| `absence_report` | `hr.view` | Ranked unexcused absences (no time-in, no linked leave/OT form). |
| `leave_ot_summary` | `hr.view` | Counts of leave / OT / half-day / offset / holiday-work forms per employee. |
| `activity_report` | `audit.view` | What happened: counts by action / user / module + a sample. `date` or from/to. |
| `low_stock_report` | `inventory.view` | Items at/under reorder level, with shortfall + supplier. |
| `reorder_suggestions` | `inventory.view` | Low-stock items + suggested order qty (to `min × target_multiple`). |
| `dead_stock` | `inventory.view` | Items with stock but no movement in N days. |
| `stock_movement_summary` | `inventory.view` | Total in / out / net over a range + biggest movers. |
| `job_order_report` | `inventory.view` | MO counts by status + units ordered/done/scrapped. |
| `qc_report` | `inventory.view` | QA/QC pass–fail counts, pass rate, top failure remarks. |
| `run_analytics_query` | `audit.view` | Escape hatch: one read-only `SELECT`/`WITH` (no writes, no stacked statements, no `users`/`sessions`). |
| `create_report_document` | *(any user)* | `src/modules/ai/ai-reporting.ts` — turns a Markdown report into HTML + `.docx` files under `UPLOAD_DIR`; downloaded via `GET /api/ai/reports/:name` (auth-checked, name-allowlisted). |
| `send_email` | `mail.send` | `src/modules/ai/ai-mail.ts` — sends an email through the company mailbox (`src/shared/mailer.ts`, BYO SMTP; recorded in `mail_log`). Offered only when configured *and* the user holds `mail.send`. |

### Knowledge search / RAG (`src/modules/ai/rag.ts`, `src/modules/ai/ai-rag.ts`)

| Tool | Permission | Description |
|---|---|---|
| `search_knowledge` | *(any user)* | FTS5/BM25 search over unstructured text — uploaded files & policies (text files' bodies are indexed; binaries are metadata-only), item / order / job-order notes, QC failure remarks, form-record details, and the `docs/*.md` + `README.md`. Each chunk carries an ACL (permission key) + optional `dept_id`; results are filtered per-chunk to what the caller may see. |

The index (`doc_chunks` FTS5 virtual table) is **rebuilt lazily** — `retrieve()` re-indexes if it's older than 5 minutes — and can be forced with **`POST /api/ai/reindex`** (`audit.view`).

### HR forms / memos / notices (`src/modules/ai/ai-hr-forms.ts`)

Read the data-form / memo / NTE catalogue and **propose** (never issue) a new record. Offered
to any user with `hr.view` or at least one `forms.manage.<scope>`.

| Tool | Permission | Description |
|---|---|---|
| `list_form_types` | hr.view or forms.manage.* | Every form definition with its fields and configured actions (notify employee, file to 201, …). |
| `search_form_records` | forms.manage.`<scope>` of the form | Search issued records by slug/scope/status/text; returns field values. |
| `get_form_record` | forms.manage.`<scope>` | One record in full by id. |
| `propose_form_record` | forms.manage.`<scope>` | **Does not write.** Returns a pre-filled draft `{ proposed: true, form_def_id, slug, form_name, data, employee_match, missing_required }`. |

The `propose_form_record` result renders a **"Review & issue &lt;form&gt;"** button under the
assistant's reply (`public/js/tools.js` `actionForStep`). Clicking it calls
`App.openFormRecordDraft(...)`, which opens the normal Data Forms "New record" modal
pre-filled — the user edits/confirms, and the real `POST /api/form-records` runs the form's
actions (`src/core/form-actions.ts`). The AI never issues or sends a memo directly.

---

## API Reference

### `POST /api/ai/chat`

**Auth:** Bearer token (any logged-in user)

**Request body:**
```json
{
  "messages": [
    { "role": "user", "content": "How many items are low on stock?" }
  ]
}
```

The client includes recent conversation history on every request — the `/chat` call itself is stateless per request. As a side effect of a successful call, though, the route saves the new user message and the final assistant reply (+ `steps`) to `ai_messages`, scoped to the caller, so the conversation survives reloads/new sessions until the user clears it (see `GET`/`DELETE /api/ai/messages` below).

| Field | Type | Notes |
|---|---|---|
| `messages` | array | 1 – 40 messages. Each has `role` (`user` or `assistant`) and `content` (1 – 8000 chars). |

**Successful response (200):**
```json
{
  "reply": "There are 3 items below their minimum stock level…",
  "steps": [
    { "tool": "get_inventory_stats", "args": {}, "result": { "success": true, "data": {…} } }
  ]
}
```

**Error responses:**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "…" }` | Invalid request body. |
| 401 | `{ "error": "Not authenticated" }` | Missing or expired session. |
| 503 | `{ "error": "AI is not configured…" }` | `CEREBRAS_API_KEY` not set. |
| 500 | `{ "error": "Internal server error" }` | Cerebras API error or unexpected exception. |

---

### `GET /api/ai/messages`

**Auth:** Bearer token (any logged-in user, own conversation only)

Returns the caller's saved conversation, oldest first: `[{ id, role, content, steps?, created_at }]`. `steps` is the tool-call trail (present only on an assistant turn that used tools), so record/report links still render after a reload.

### `DELETE /api/ai/messages`

**Auth:** Bearer token (any logged-in user)

Permanently deletes the caller's saved conversation. This is the only way it goes away — nothing expires or auto-clears it otherwise.

---

## Agentic Loop

The route runs at most **8 iterations** per request:

```
iteration 1:
  call Cerebras → model returns tool_calls
  execute each tool → collect ToolResult
  append tool results to message thread

iteration 2:
  call Cerebras (now with tool results in context) → model may call more tools or give final answer
  ...

stop when: model returns no tool_calls  OR  8 iterations reached
```

The `steps` array in the response contains every `(tool, args, result)` triplet in order, which the frontend renders as small activity chips above the reply.

---

## Frontend Integration (`public/js/tools.js`)

The `openAI()` function in the right-rail tools manages the UI. Key points:

- **Conversation history** — the saved conversation (`GET /api/ai/messages`) is loaded and replayed into the chat pane every time the drawer opens, so it survives closing the drawer, reloading the page, or logging back in later; a "Clear conversation" button in the header (`DELETE /api/ai/messages`) is the only way to wipe it. The `aiHistory` closure array is just the recent-context window sent to the LLM each turn (capped at `AI_HISTORY_LIMIT` = 38, under the route's 40-message ceiling) — it grows by one `{role:'user', content}` + one `{role:'assistant', content}` per round-trip and is reseeded from the saved history whenever the drawer opens.
- **Typing indicator** — three bouncing dots shown while waiting for the backend.
- **Tool chips** — displayed above the reply to show which tools were called (e.g. `search inventory`, `get order`).
- **Markdown** — light rendering: `**bold**`, `` `code` ``, and line breaks.
- **Error handling** — Cerebras/network errors appear inline as red-tinted messages.

---

## Adding a New Tool

1. Add the tool name to the `ToolName` union in `src/modules/ai/ai-tools.ts`.
2. Add a `Permission | null` entry to `TOOL_PERMISSION`.
3. Add the `CerebrasTool` spec to `TOOL_SPECS` (OpenAI function-calling format).
4. Add a `case` in the `executeTool` switch.
5. If a new permission is needed, add it to `src/shared/types.ts → Permission` and `src/shared/permissions.ts → ALL_PERMISSIONS` + `ROLE_DEFAULTS`.
6. Add a row to the **Tool Catalogue** table above and to the **API catalog** in `docs/ARCHITECTURE.md §4`.
7. Write a test in `tests/ai.test.ts`.

---

## Security Notes

- **Double permission check:** `getToolsForUser` filters what tools the model sees; `executeTool` re-checks the permission before executing. A compromised LLM cannot call a tool by name if the caller doesn't hold the permission.
- **User scoping:** Personal tools (notes, tasks, bookmarks) always filter by `user.id` — no cross-user data access is possible through the AI.
- **No prompt injection in tool results:** Tool results are passed back to Cerebras as structured JSON tool-response messages, not injected into the system prompt.
- **Input validation:** Messages are validated by zod before reaching the agentic loop (max 40 messages, 8000 chars each).
- **Rate limiting:** The `/api/ai/chat` route inherits the standard Express middleware stack but does NOT currently have its own rate limiter — consider adding one if the endpoint is exposed beyond a trusted LAN.
