# `src/modules/ai/ai-tools.ts`

## Purpose
Defines the full catalogue of tools the AI Assistant (Cerebras-backed agentic loop) can call, the
permission each tool requires, the OpenAI-style function-calling specs sent to the model, and the
`executeTool()` dispatcher that actually runs a named tool against the SQLite DB on behalf of the
calling user. This is the code-level implementation behind the conceptual overview in
`docs/AI-AGENT.md`.

## Routes / Exports

### `ToolName` union (line ~34)
28 string literals, grouped by domain:
- Utility: `get_departments`
- Inventory: `search_inventory`, `get_inventory_item`, `get_inventory_stats`, `create_inventory_item`, `update_inventory_item`, `adjust_stock`, `delete_inventory_item`
- Orders: `search_orders`, `get_order`, `create_order`, `update_order`, `delete_order`
- Messages: `get_messages`, `send_message`, `get_unread_count`, `mark_message_read`
- Forms: `get_forms`
- Users: `list_users`, `create_user`, `update_user`
- Notes: `get_notes`, `create_note`, `update_note`, `delete_note`
- Tasks: `get_tasks`, `create_task`, `update_task`, `delete_task`

Note: `ToolName` is a local (non-exported) type — `executeTool`'s `name` parameter is typed
`string` and cast to `ToolName` internally via `name as ToolName`.

### `TOOL_PERMISSION: Record<ToolName, Permission | null>` (line ~46)
Maps every tool to the single `Permission` key (from `src/shared/types.ts`) required to call it, or
`null` for tools open to any authenticated user (utility + all Notes/Tasks tools). Exact mapping:

| Tool | Permission |
|---|---|
| `get_departments` | `null` |
| `search_inventory`, `get_inventory_item`, `get_inventory_stats` | `inventory.view` |
| `create_inventory_item` | `inventory.create` |
| `update_inventory_item` | `inventory.edit` |
| `adjust_stock` | `inventory.adjust` |
| `delete_inventory_item` | `inventory.delete` |
| `search_orders`, `get_order` | `orders.view` |
| `create_order` | `orders.create` |
| `update_order` | `orders.edit` |
| `delete_order` | `orders.delete` |
| `get_messages`, `get_unread_count`, `mark_message_read` | `messages.view` |
| `send_message` | `messages.send` |
| `get_forms` | `forms.view` |
| `list_users`, `create_user`, `update_user` | `users.manage` |
| `get_notes`/`create_note`/`update_note`/`delete_note`, `get_tasks`/`create_task`/`update_task`/`delete_task` | `null` |

Note `create_order`/`update_order`/`delete_order` here map to `orders.create`/`orders.edit`/`orders.delete`,
but `ALL_PERMISSIONS` in `src/shared/permissions.ts` only actually defines `orders.view`/`orders.create`/`orders.edit`/`orders.delete`
— consistent. (There is no separate `orders.delete` role default granted to any role except `admin`; see permissions.ts.)

### `TOOL_SPECS: Record<ToolName, CerebrasTool>` (line ~82)
One `CerebrasTool` (OpenAI function-calling shape: `{type:'function', function:{name, description, parameters}}`)
per tool name, hand-written JSON-schema `parameters` describing the arguments the LLM may supply.
Highlights of shape/constraints baked into the specs (not enforced by zod — these are advisory to
the LLM only; the actual tool functions do their own coercion/guards):
- `search_inventory`: `query`, `department_id`, `category`, `low_stock_only` — all optional.
- `create_inventory_item`: requires `name`; optional `sku`, `category`, `department_id`, `quantity`, `unit`, `min_quantity`, `location`, `notes`.
- `adjust_stock`: requires `id`, `change`; optional `reason`.
- `create_order`/`update_order`: `items` array of `{name, sku?, description?, quantity, unit?, unit_price}` (`name`/`quantity`/`unit_price` required per item); `type` enum `['sale','job']` (note: does **not** include `'purchase'`, unlike the actual `orders` table/route which supports `sale|job|purchase` — an AI-created "purchase" order is not directly supported by this tool spec).
- `send_message`: requires `recipient_id`, `body`; optional `subject`.
- `create_user`: requires `username`, `full_name`, `password`; `role` enum of all 8 roles; optional `department_id`.
- `update_user`: requires `id`; optional `full_name`, `role`, `department_id`, `active`.
- Personal tools mirror the shapes of `noteSchema`/`taskSchema` in `src/shared/validation.ts` but are hand-declared here, not derived from those schemas.

### `getToolsForUser(user: AuthUser): CerebrasTool[]` (exported, line ~584)
Filters `TOOL_SPECS` down to the tools whose `TOOL_PERMISSION` entry is `null` or is included in
`user.permissions`. This is the **first** permission gate — the model is never even shown a tool
name it isn't allowed to call. Called by `src/modules/ai/ai.routes.ts` both to build the system
prompt's tool-name list and to pass as the `tools` array to the Cerebras chat-completions call.

### `executeTool(name: string, args: unknown, user: AuthUser): Promise<ToolResult>` (exported, line ~599)
The dispatcher. Always resolves to a `ToolResult` (`{success: boolean, data?: unknown, error?: string}`)
— never throws; a `try/catch` around the whole `switch` converts any thrown error into
`{success: false, error: <message>}`.

Flow:
1. Coerces `args` to `Record<string, unknown>` (`a`), defaulting to `{}`.
2. **Second permission gate** (defence-in-depth): looks up `TOOL_PERMISSION[name as ToolName]`; if
   it's a real (non-null/undefined) permission key the caller doesn't hold, returns
   `{success:false, error:'Permission denied.'}` without executing anything. This re-checks even
   though `getToolsForUser` already filtered — protects against a compromised/malicious model
   naming a tool it wasn't offered.
3. `switch (name as ToolName)` dispatches to one case block per tool (28 cases + `default` ->
   `{success:false, error:'Unknown tool: ' + name}`).

### Individual tool behavior (by case)

**Utility**
- `get_departments` — `SELECT id, name FROM departments ORDER BY name`. No args.

**Inventory**
- `search_inventory({query?, department_id?, category?, low_stock_only?})` — builds a dynamic
  `WHERE` from the optional filters (`LIKE` on name/sku/category/location for `query`; exact match
  on `department_id`/`category`; `quantity <= min_quantity` for `low_stock_only`). Joins
  `departments` for `department_name`, computes `low_stock` boolean column. `LIMIT 50`, ordered by
  name (case-insensitive).
- `get_inventory_item({id})` — joins `departments`; 404-equivalent `{success:false,error:'Item not found.'}`
  if missing. Parses the `attributes` JSON column into an object (empty object on parse failure).
  Appends `history`: last 20 `inventory_transactions` rows (with `user_name` joined) ordered newest first.
- `get_inventory_stats()` — aggregate totals (`total_items`, `total_quantity`, `low_stock_count`,
  `category_count`) plus `top_categories` (top 10 by item count). No args.
- `create_inventory_item({name, sku?, category?, department_id?, quantity?, unit?, min_quantity?, location?, notes?})`
  — inserts into `inventory_items` (`quantity` defaults to 0 via `Number(a.quantity ?? 0)`, `unit`
  defaults to `'pcs'` at the DB layer... actually defaults are applied inline: `unit` uses
  `a.unit ?? 'pcs'`, `min_quantity` uses `Number(a.min_quantity ?? 0)`). If the initial quantity is
  non-zero, also inserts an `inventory_transactions` row with `reason: 'Initial stock'` — **not
  wrapped in an explicit transaction** (unlike `adjust_stock`), so the two inserts could in theory
  diverge on a mid-operation crash.
- `update_inventory_item({id, name?, sku?, category?, department_id?, unit?, min_quantity?, location?, notes?})`
  — 404 if item missing. Builds a dynamic `SET` clause from whichever fields are `!== undefined`
  in `a` (any explicitly-passed field, including explicit `null`, is written; omitted fields are
  left alone). Always bumps `updated_at`. Does **not** touch `quantity`.
- `adjust_stock({id, change, reason?})` — `change` must coerce to non-zero (`Number(a.change)`);
  404 if item missing; computes `newQty = item.quantity + change`, rejected with an error if
  negative *(fixed 2026-08-25 — see Notes)*, matching `inventory.routes.ts`'s `/adjust` endpoint.
  Wrapped in an explicit `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK`
  transaction across the `UPDATE inventory_items` + `INSERT inventory_transactions`.
- `delete_inventory_item({id})` — 404 if missing; hard `DELETE FROM inventory_items` (cascades to
  transaction history via FK `ON DELETE CASCADE` defined in `src/shared/db.ts`).

**Orders**
- `search_orders({type?, query?})` — `type` filters exact match (`'sale'`/`'job'` per the tool spec,
  though the underlying SQL doesn't itself restrict the value); `query` does `LIKE` on
  `number`/`customer_name`. Joins `users` for `created_by_name`. `LIMIT 30`, newest first.
- `get_order({id})` — 404 if missing; joins `users` for `created_by_name`; appends all
  `order_items` for that order ordered by `sort`.
- `create_order({type, customer_name?, customer_contact?, order_date?, status?, currency?, tax_percent?, notes?, items})`
  — auto-numbers via the `settings` counter `order_seq_<type>` (incremented with `getSetting`/`setSetting`),
  prefix `SO-` for `type==='sale'` else `JO-` (i.e. any non-`'sale'` type, including an unlisted
  `'purchase'`, gets the `JO-` prefix here — the tool has no dedicated `PR-` prefix branch, unlike
  `orders.routes.ts`). Computes `subtotal` from `Σ quantity*unit_price`, `tax_amount = subtotal * tax_percent/100`,
  `total = subtotal + tax_amount` — all server-side, ignoring any client-supplied total. Whole
  insert (order header + line items) wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`.
- `update_order({id, ...fields, items})` — 404 if missing; recomputes subtotal/tax/total the same
  way; **deletes all existing `order_items` for the order and reinserts** the new list (full
  replace, not a diff); wrapped in a transaction; bumps `updated_at`.
- `delete_order({id})` — 404 if missing; hard delete (cascades line items via FK).

**Messages**
- `get_messages({box?})` — `box` is `'sent'` or defaults to `'inbox'` for any other value. Inbox
  query joins sender info, sent query joins recipient info. `LIMIT 20`, newest first. Always
  scoped to the calling `user.id`.
- `send_message({recipient_id, subject?, body})` — rejects messaging self
  (`Number(a.recipient_id) === user.id`); looks up an **active** recipient (`active = 1`) —
  404-equivalent error if not found/inactive; inserts into `messages`.
- `get_unread_count()` — count of the caller's inbox messages with `read_at IS NULL`.
- `mark_message_read({id})` — 404 if message doesn't exist; ownership check
  (`msg.recipient_id !== user.id` → `'Not your message.'`); sets `read_at = datetime('now')`.

**Forms**
- `get_forms({category?})` — visibility restricted to `f.department_id IS NULL OR f.department_id = ?`
  using `user.department_id ?? -1` (so a user with no department only sees company-wide forms —
  note this tool does **not** grant `users.manage` holders visibility into every department's
  forms the way `forms.routes.ts`'s `visibilityClause` does; it's a flat department match
  regardless of the caller's other permissions). Optional exact `category` filter.

**Users**
- `list_users({department_id?, active_only?})` — joins `departments`; optional filters; returns
  `id, username, full_name, role, active, created_at, department_name`. No `password_hash` exposed.
- `create_user({username, full_name, password, role?, department_id?})` — dynamically
  `import('bcryptjs')` then `hashSync(password, 10)`; lower-cases/trims the username; `role`
  defaults to `'admin_staff'` if omitted (`a.role ?? 'admin_staff'`) — **note this differs from the
  zod `createUserSchema` default of the same value used by `users.routes.ts`, but this tool does
  not run the request through zod at all** — no username-format regex, no duplicate-username
  check, no password-length enforcement beyond whatever the model supplies. A duplicate username
  will throw a SQLite UNIQUE-constraint error, which the outer `try/catch` turns into
  `{success:false, error: <sqlite error message>}`.
- `update_user({id, full_name?, role?, department_id?, active?})` — 404 if missing; dynamic
  `SET` clause from defined fields; `{success:false, error:'Nothing to update.'}` if no fields
  given. **No "last active admin" guard** — unlike `PUT /api/users/:id` in `users.routes.ts`,
  this tool will happily demote or deactivate the last remaining admin account.

**Notes** (all scoped to `user.id`; ownership re-checked on update/delete)
- `get_notes()` — all notes for the caller, newest-updated first.
- `create_note({title?, body})` — insert; returns new `id`.
- `update_note({id, title?, body?})` — 404 if note missing; `'Not your note.'` if owned by
  someone else; dynamic `SET` (only supplied fields), bumps `updated_at`.
- `delete_note({id})` — same not-found/ownership checks; hard delete.

**Tasks** (mirror of Notes, scoped to `user.id`)
- `get_tasks()` — ordered `done, due_date NULLS LAST, created_at`.
- `create_task({title, due_date?})` — insert; returns new `id`.
- `update_task({id, title?, due_date?, done?})` — 404/ownership checks; dynamic `SET`;
  `done` coerced to `1`/`0`.
- `delete_task({id})` — 404/ownership checks; hard delete.

## Dependencies
- `./db` — `db` (raw connection, for `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` in `adjust_stock`,
  `create_order`, `update_order`), `queryOne`, `queryAll`, `run` (typed query helpers),
  `getSetting`/`setSetting` (order-number sequence counters in the `settings` table).
- `./types` — `AuthUser` (the caller, carrying `.permissions`, `.id`, `.department_id`), `Permission`
  (the union type `TOOL_PERMISSION` values are drawn from).
- `bcryptjs` — dynamically imported only inside `create_user` (`hashSync`), so it's not a
  top-level dependency of the module.

## Used by
- `src/modules/ai/ai.routes.ts` — imports `getToolsForUser` (to build the system prompt and the
  Cerebras `tools` payload) and `executeTool` (to run each tool call the model requests).
- `tests/ai.test.ts` — exercises the AI chat route (and therefore this module) end-to-end (grep
  confirms this is the only other referencing file besides `app.ts`'s indirect mount of
  `ai.routes.ts`).

## Notes / gotchas
- `create_inventory_item`'s two inserts (item + initial-stock transaction) are **not** wrapped in
  a DB transaction, unlike `adjust_stock`, `create_order`, and `update_order` which explicitly use
  `BEGIN`/`COMMIT`/`ROLLBACK`. A crash between the two inserts would leave an item with no matching
  "Initial stock" transaction row.
- **(Fixed 2026-08-25)** `adjust_stock` (AI tool) used to skip the negative-balance guard that
  `POST /api/inventory/:id/adjust` enforces — now rejects a change that would drop `quantity`
  below zero, same as the HTTP route.
- **(Fixed 2026-08-25)** `create_user`/`update_user` (AI tools) used to skip zod validation and
  the "don't strip the last admin" guard entirely, relying only on the `users.manage` permission
  gate plus whatever the LLM chose to pass. Both now run through `createUserSchema`/
  `updateUserSchema` (`src/shared/validation.ts`) and `update_user` replicates `users.routes.ts`'s
  last-active-admin guard (blocks demoting/disabling the sole remaining `admin`, and clears
  sessions on disable) — same behavior as the REST route.
- **(Fixed 2026-08-25)** `create_order`'s tool spec used to advertise only `type: 'sale'|'job'`
  and its number-prefix logic treated any non-`'sale'` type as `'JO-'` — the AI couldn't create a
  purchase order with a correct `PR-` number the way `/api/orders` can (and a model that ignored
  the enum and passed `'purchase'` anyway would have gotten a wrongly-prefixed `JO-` number).
  `type` now accepts `'purchase'`, mapped to the `PR-` prefix and `order_seq_purchase` counter,
  with an explicit rejection for anything else. `update_order` never took a `type` field (an
  order's type is immutable after creation, matching the REST route and the frontend), so it
  needed no change.
- Every tool function returns plain, unescaped DB rows as `data` — the caller (Cerebras) receives
  this as a JSON tool-response message, and `ai.routes.ts`'s docstring notes this is deliberate
  (structured tool-response messages, not string-injected into the prompt) to reduce prompt-injection risk.
