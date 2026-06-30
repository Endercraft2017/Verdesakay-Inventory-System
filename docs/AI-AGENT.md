# AI Agent — Developer & Admin Reference

> **Last updated:** 2026-06-29

The AI Assistant is a right-rail tool in the Verdesakay Office System that lets users query data and take actions using natural language. It is powered by **Cerebras** (OpenAI-compatible API) and runs a server-side agentic loop that executes tools against the live SQLite database on the user's behalf.

---

## Architecture Overview

```
User types message
       │
       ▼
POST /api/ai/chat  (Bearer token)
       │
       ▼
src/routes/ai.routes.ts
  - builds system prompt with user context
  - filters tools to those user can call (via effective permissions)
  - calls Cerebras API with tool specs
       │
       ▼
Cerebras (llama-4-scout-17b-16e-instruct)
  - may call 0-N tools per turn
       │
       ▼
src/ai-tools.ts  executeTool()
  - checks permission again (defence in depth)
  - runs the tool against the SQLite DB
  - returns ToolResult {success, data|error}
       │
       ▼
Tool result fed back to Cerebras
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

| Environment variable | Default | Description |
|---|---|---|
| `CEREBRAS_API_KEY` | *(required)* | Your Cerebras API key. The assistant returns a 503 if this is unset. |
| `CEREBRAS_MODEL` | `llama-4-scout-17b-16e-instruct` | Cerebras model to use. |

Set these before starting the server:

```bash
# Windows PowerShell
$env:CEREBRAS_API_KEY = "csk-..."
npm start

# Or in a .env-style wrapper / Windows environment variables
```

---

## Permission Model

Tools are gated by the caller's **effective permissions**, which are resolved when the user's session is loaded (`src/auth.ts → userFromToken`):

1. The user's `role` maps to a default permission set (`src/permissions.ts → ROLE_DEFAULTS`).
2. Admin can grant or revoke individual permissions per user via `users.permission_overrides` (sparse JSON diff).
3. The merged set is stored on `req.user.permissions: Permission[]`.

The AI route calls `getToolsForUser(user)` which filters the full tool catalogue down to only those covered by a permission the user holds. The model only *sees* the tools it can call — it cannot be tricked into calling a tool it doesn't have access to.

### Role → default tools

| Role | Key capabilities |
|---|---|
| `admin` | All 28 tools |
| `admin_staff` | Inventory CRUD + adjust, order CRUD, messages, forms, personal tools |
| `accounting` | Inventory view, order create/edit, messages, forms, personal tools |
| `warehouse` | Inventory CRUD + adjust, order view, messages, forms, personal tools |
| `releasing` | Inventory view + adjust, order view/edit, messages, forms, personal tools |
| `csr` | Inventory view, order create/edit, messages, forms, personal tools |
| `hr` | User list, messages, forms, personal tools |
| `marketing` | Inventory view, order view, messages, forms, personal tools |

Personal tools (notes, tasks) are available to **every authenticated user** regardless of role.

---

## Tool Catalogue

All tools are defined in `src/ai-tools.ts`. The full list by category:

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

The client should include the full conversation history on every request (the server is stateless — it does not store conversation history).

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

- **Conversation history** is kept in the `aiHistory` closure array and cleared when the drawer closes. It grows by one `{role:'user', content}` + one `{role:'assistant', content}` per round-trip.
- **Typing indicator** — three bouncing dots shown while waiting for the backend.
- **Tool chips** — displayed above the reply to show which tools were called (e.g. `search inventory`, `get order`).
- **Markdown** — light rendering: `**bold**`, `` `code` ``, and line breaks.
- **Error handling** — Cerebras/network errors appear inline as red-tinted messages.

---

## Adding a New Tool

1. Add the tool name to the `ToolName` union in `src/ai-tools.ts`.
2. Add a `Permission | null` entry to `TOOL_PERMISSION`.
3. Add the `CerebrasTool` spec to `TOOL_SPECS` (OpenAI function-calling format).
4. Add a `case` in the `executeTool` switch.
5. If a new permission is needed, add it to `src/types.ts → Permission` and `src/permissions.ts → ALL_PERMISSIONS` + `ROLE_DEFAULTS`.
6. Add a row to the **Tool Catalogue** table above and to the **API catalog** in `docs/ARCHITECTURE.md §4`.
7. Write a test in `tests/ai.test.ts`.

---

## Security Notes

- **Double permission check:** `getToolsForUser` filters what tools the model sees; `executeTool` re-checks the permission before executing. A compromised LLM cannot call a tool by name if the caller doesn't hold the permission.
- **User scoping:** Personal tools (notes, tasks, bookmarks) always filter by `user.id` — no cross-user data access is possible through the AI.
- **No prompt injection in tool results:** Tool results are passed back to Cerebras as structured JSON tool-response messages, not injected into the system prompt.
- **Input validation:** Messages are validated by zod before reaching the agentic loop (max 40 messages, 8000 chars each).
- **Rate limiting:** The `/api/ai/chat` route inherits the standard Express middleware stack but does NOT currently have its own rate limiter — consider adding one if the endpoint is exposed beyond a trusted LAN.
