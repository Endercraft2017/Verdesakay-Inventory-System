# `src/validation.ts`

## Purpose
Every request-body validation rule for the API lives here as `zod` schemas, plus the `parseBody` helper routes call to apply them and the `ValidationError` class the central error handler (`src/app.ts`) turns into a 400 response. Keeps validation out of route handlers entirely (per `docs/ARCHITECTURE.md` §5: "never inline in a route").

## Exports / Public API

### Core
```ts
export class ValidationError extends Error {
  status = 400;
  constructor(message: string)
}
```
Thrown by `parseBody` on invalid input. Has a `status = 400` instance property, which is exactly what `src/app.ts`'s central error handler looks for (`'status' in err && typeof err.status === 'number'`) to pick the response code — so throwing a `ValidationError` anywhere in a request's call chain (not just from `parseBody`) yields a 400 with `err.message` as the body.

```ts
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T
```
Runs `schema.safeParse(data)`. On failure, builds a message from the *first* issue only (`result.error.issues[0]`): `"<path>: <message>"` if the issue has a path (e.g. `"password: String must contain at least 6 character(s)"`), or just `<message>` if it doesn't, then throws `ValidationError(msg)`. On success, returns `result.data` (the parsed/coerced/defaulted output, not the raw input — schemas below apply `.default()`/`.coerce`/preprocessing, so the returned object can differ from what was posted).

### Shared primitive builders (not exported, but foundational — documented since every schema below composes from them)
- `trimmed = z.string().trim()` — base string type with whitespace trimmed.
- `optionalText = trimmed.max(2000).optional().nullable()` — the common "short free text, optional" pattern.
- `optionalId` — a `z.preprocess` that maps `''`/`undefined`/`null` to `null`, then validates as `z.coerce.number().int().positive().nullable()` — used for every optional FK id field (`department_id`, `item_id`, etc.) so an empty string from an HTML form submits cleanly as "no selection."
- `boolish` — a `z.preprocess` accepting a real boolean or the strings `'1'`/`'0'`/`'true'`/`'false'` (case-insensitive for `'true'`), coercing to `z.boolean()` — handles both JSON `true/false` and form-encoded string bodies.
- `intCoerce = z.coerce.number().int()`.
- `numCoerce = z.coerce.number()` (defined lower in the file, used by order/HR schemas).

### Auth schemas
- `loginSchema` — `{ username: trimmed.min(1), password: string.min(1) }`.
- `changePasswordSchema` — `{ current_password: string.min(1), new_password: string.min(6) }`.
- `updateProfileSchema` — `{ full_name: trimmed.min(1).max(120) }`.

### Users / departments
- `roleEnum` (not exported) — `z.enum(['admin','admin_staff','accounting','warehouse','releasing','csr','hr','marketing'])` — the 8 roles; must stay in sync with `Role` in `src/types.ts`.
- `createUserSchema` — `username` (lowercased, regex `^[a-z0-9._-]{3,30}$`), `full_name` (1-120 chars), `password` (min 6), `role` (defaults `'admin_staff'`), `department_id` (`optionalId`).
- `updateUserSchema` — same fields as create but all optional (partial update), plus `active: boolish.optional()`.
- `resetPasswordSchema` — `{ new_password: string.min(6) }`.
- `createDepartmentSchema` / `updateDepartmentSchema` (alias of create) — `{ name: trimmed.min(1).max(80) }`.
- `permissionOverridesSchema` — `{ overrides: Record<string, boolean> }`, refined to reject more than 50 keys — the body shape for `PUT /users/:id/permissions`.

### Inventory
- `attributesSchema` — `z.record(string.max(64), string.max(2000)|number|boolean|null)`, refined to ≤200 keys, `.optional()`. The extended ECOUNT-style item fields, stored as one JSON blob (`inventory_items.attributes`).
- `createItemSchema` — `name` (required, 1-160), `sku`/`category`/`location`/`notes` (`optionalText`), `department_id` (`optionalId`), `quantity` (`intCoerce`, default 0), `unit` (max 40, optional/nullable), `min_quantity` (`intCoerce.min(0)`, default 0), `attributes` (`attributesSchema`).
- `updateItemSchema` — same shape as create but every field optional (no `quantity` field at all — quantity is only ever changed via `adjustStockSchema`, never a direct update, per the API catalog's "Update details + attributes (not qty)" note).
- `formConfigSchema` — `z.array({ key, visible: boolish, required: boolish, ...passthrough }).max(500)` — the admin-saved item-form layout customization; `.passthrough()` lets each entry carry additional fields (e.g. `default`) beyond the three validated ones.
- `adjustStockSchema` — `{ change: intCoerce refined non-zero, reason: optionalText }` — stock in/out delta; `change` of `0` is explicitly rejected.

### Messages
- `sendMessageSchema` — `{ recipient_id: coerce.number().int().positive(), subject: optional/nullable max 200, body: min 1 max 5000 }`.

### Personal tools
- `noteSchema` — `{ title: optional/nullable max 200, body: min 1 max 20000 }`.
- `taskSchema` — `{ title: min 1 max 300, due_date: optional/nullable max 40, done: boolish.optional() }`.
- `updateTaskSchema` — same as `taskSchema` but `title` optional too (partial update).
- `bookmarkSchema` — `{ label: min 1 max 200, route: min 1 max 80, params: Record<string,...>.optional().nullable() }`.

### Orders / documents
- `orderItemSchema` (not exported) — `{ item_id: optionalId, name: min 1 max 200, sku/description: optionalText, quantity: numCoerce.min(0) default 1, unit: optional, unit_price: numCoerce.min(0) default 0 }`.
- `orderFields` (not exported, spread into both order schemas) — `customer_name`/`customer_contact`/`notes` (`optionalText`), `order_date`/`status` (optional/nullable, max 40), `currency` (max 10, optional/nullable), `tax_percent` (`numCoerce.min(0).max(100)` default 0), `items: array(orderItemSchema).min(1).max(300)` — every order needs at least one line item.
- `createOrderSchema` — `{ type: enum(['sale','job','purchase']), ...orderFields }`.
- `updateOrderSchema` — `orderFields` alone (type is immutable after creation — not included).
- `templateSchema` — `{ name: min 1 max 120, type: enum(['sale','job','purchase','generic']) default 'generic', period: optional max 60, body: min 1 max 5,000,000 }` — the 5MB body cap accommodates large WYSIWYG-editor-generated HTML/CSS templates.
- `companyProfileSchema` — `{ name, address, phone, email, logo_url }`, all `optional().nullable()` with individual max lengths.
- `docVariableSchema` — `{ scope: enum(['global','template']) default 'global', template_id: optionalId, category: min 1 max 60 default 'Custom', key: regex ^[a-zA-Z_][\w]{0,63}$, label: min 1 max 120, source_type: enum(['constant','field','formula']) default 'constant', value/field_path/formula: optional text fields, data_type: enum(['text','number','currency','date']) default 'text', sort: intCoerce default 0 }`.

### Form builder
- `fieldTypeEnum` (not exported) — `z.enum(['text','number','date','select','textarea','checkbox'])`.
- `fieldDefSchema` — `{ key: regex ^[a-z0-9_]+$ max 64, label: min 1 max 120, type: fieldTypeEnum, required: boolish default false, options: array(text max 200) max 100 default [], default: text max 500 default '' }` — mirrors `FieldDef` in `src/types.ts`.
- `formDefinitionSchema` — `{ name: min 1 max 120, slug: regex ^[a-z0-9_]+$ max 60, number_prefix: regex ^[A-Z0-9]+$ max 10 default 'FM', icon: max 40 default 'file', fields: array(fieldDefSchema) max 100 default [] }`.
- `createFormRecordSchema` — `{ form_def_id: coerce.number().int().positive(), data: Record<string,...> default {}, status: max 40 default 'draft' }`.
- `updateFormRecordSchema` — `{ data: same record type default {}, status: max 40 optional }`.
- `globalVariableSchema` — `{ label: min 1 max 120, value: max 2000 default '' }`.

### HR: employees / time keeping
- `employeeStatusEnum` (not exported) — `z.enum(['probationary','regular','resigned','terminated'])`.
- `optionalIdText` (not exported) — `trimmed.max(40).optional().nullable()`, used for the statutory-number fields.
- `employeeSchema` — `{ name: min 1 max 160, department_id: optionalId, position: max 120 optional/nullable, daily_rate: numCoerce.min(0) default 0, status: employeeStatusEnum default 'probationary', start_date: max 40 optional/nullable, sss_no/philhealth_no/pagibig_no/tin_no: optionalIdText, photo: preprocess('' -> null) then string max 2,000,000 chars matching /^data:image\// optional/nullable }` — the 2MB cap bounds the client-resized JPEG data URI.
- `attendancePeriodSchema` — `{ label: min 1 max 120, start_date: min 1 max 40, end_date: min 1 max 40 }`, `.refine(end_date >= start_date)` with the error attached to the `end_date` path.
- `timeOfDay` (not exported) — `union([trimmed.max(20), null]).optional()`.
- `attendanceDaySchema` (not exported) — `{ work_date: min 1 max 40, time_in/lunch_out/lunch_in/time_out: timeOfDay, notes: optionalText, shift_id?, form_record_id(s)?, holiday_type?, rest_day?, min_hours_decision? }`. `lunch_out`/`lunch_in` are the day's lunch bracket — recorded/displayed only, never read by the payroll engine.
- `saveAttendanceSchema` — `{ employee_id: coerce.number().int().positive(), days: array(attendanceDaySchema).max(62) }` — the 62-day cap is a sanity bound (covers any realistic cutoff length, including a full two-month range).
- `addRosterEmployeeSchema` — `{ employee_id: coerce.number().int().positive() }`.
- `generatePayslipsSchema` — `{ payroll_period: min 1 max 120, pay_date: max 40 optional/nullable }`.

### Inferred types
```ts
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
```
Only these five schemas have a named inferred-type export; the rest are consumed inline via `parseBody(schema, ...)`'s generic return type at each call site rather than a separately exported type alias.

## Internal / non-exported helpers
The primitive builders (`trimmed`, `optionalText`, `optionalId`, `boolish`, `intCoerce`, `numCoerce`) and the several schema pieces noted "(not exported)" above (`roleEnum`, `orderItemSchema`, `orderFields`, `fieldTypeEnum`, `employeeStatusEnum`, `optionalIdText`, `timeOfDay`, `attendanceDaySchema`) — all module-local, composed into the exported schemas.

## Dependencies
- `zod` (`z`) — the only import.

## Used by
Every route module that accepts a request body: `src/routes/users.routes.ts`, `src/routes/hr.routes.ts`, `src/routes/templates.routes.ts`, `src/routes/personal.routes.ts`, `src/routes/orders.routes.ts`, `src/routes/inventory.routes.ts`, `src/routes/auth.routes.ts`, `src/routes/form-builder.routes.ts` — each calls `parseBody(<schema>, req.body)` at the top of the relevant handler and imports whichever named schemas it needs, plus `ValidationError` where a route needs to throw a 400 for a reason zod itself can't express (e.g. a business-rule check after parsing).

## Notes / gotchas
- **`parseBody` reports only the first validation issue**, not all of them — a request failing multiple rules gets one error message back; the client doesn't learn about the second problem until it fixes the first and resubmits.
- **Zod schemas here both validate and transform**: `.default(...)`, `.coerce.number()`, and the custom `z.preprocess(...)` calls (`optionalId`, `boolish`) mean `parseBody`'s return value is not simply "the input, if valid" — it can differ from what was posted (empty string → `null`, `'1'` → `true`, missing `quantity` → `0`, etc.). Route code should use the parsed result, not `req.body`, after calling `parseBody`.
- **`roleEnum` and `employeeStatusEnum`/`fieldTypeEnum` etc. are separate hand-maintained enums** that must track `Role`/`EmployeeStatus`/`FieldDef['type']` in `src/types.ts` — a role or status added to one without the other will surface as either a TypeScript mismatch (types.ts side) or a runtime 400 (validation.ts side rejecting an otherwise-valid value), not a compile error tying the two together.
- `updateItemSchema` intentionally has no `quantity` field — attempting to update quantity through `PUT /inventory/:id` is simply ignored by the schema (unknown keys aren't errors in zod's default non-strict object mode, but they also aren't captured in the parsed output), reinforcing that stock changes must go through `POST /inventory/:id/adjust` (`adjustStockSchema`) so every change is logged to `inventory_transactions`.
- `formConfigSchema` uses `.passthrough()` — the only schema in the file that deliberately allows extra unvalidated keys through, because the item-form layout's per-field config can carry more properties (`default`, etc.) than the two this schema explicitly checks (`visible`, `required`).
