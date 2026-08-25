# `src/types.ts`

## Purpose
The single source of truth for shared backend domain types: DB row shapes, API-response shapes, the `Role`/`Permission` enums, and the Express `Request` augmentation that gives `req.user`/`req.token` types everywhere. Mirrors the schema in `src/db.ts` — kept in sync by hand (no codegen).

## Exports / Public API

### Enums
```ts
export type Role = 'admin' | 'admin_staff' | 'accounting' | 'warehouse'
  | 'releasing' | 'csr' | 'hr' | 'marketing';
export type Permission = 'inventory.view' | 'inventory.create' | 'inventory.edit'
  | 'inventory.delete' | 'inventory.adjust' | 'inventory.configure'
  | 'orders.view' | 'orders.create' | 'orders.edit' | 'orders.delete'
  | 'forms.view' | 'forms.upload' | 'forms.delete' | 'forms.manage'
  | 'messages.view' | 'messages.send'
  | 'templates.view' | 'templates.edit' | 'templates.company'
  | 'users.manage' | 'hr.view' | 'hr.manage';
```
8-variant and 22-variant string-literal unions respectively. Must be kept in sync by hand with `roleEnum` in `src/validation.ts` and `ALL_PERMISSIONS`/`ROLE_DEFAULTS` in `src/permissions.ts` — nothing enforces this automatically.

### Row / entity interfaces
Each mirrors a table in `src/db.ts` (`init()`). One-line summaries (see `db.md` for full column semantics):
- `Department` — `{ id, name, created_at }`.
- `UserRow` — full `users` row including `password_hash` (never sent to clients — used only where the raw row is read for auth, e.g. login).
- `AuthUser` — the sanitized, request-attached user shape: same as `UserRow` minus `password_hash`, plus `department_name` (joined) and `permissions: Permission[]` (computed by `resolvePermissions()`, not a DB column). This is what `req.user` is typed as everywhere.
- `SessionRow` — `{ token, user_id, created_at, expires_at }`.
- `InventoryItem` — includes `attributes: string | Record<string, unknown> | null` (raw JSON string as stored, or parsed object once a route parses it for a response) and optional `department_name`/`low_stock` (join/computed fields present only on certain queries).
- `InventoryTransaction` — stock-history row, optional `user_name` (joined).
- `FormRow` — uploaded file metadata (`forms` table).
- `MessageRow` — `{ id, sender_id, recipient_id, subject, body, read_at, created_at }`.
- `Note`, `Task`, `Bookmark` — per-user personal-tool rows.
- `OrderType = 'sale' | 'job' | 'purchase'`.
- `Order` — header row, optional `created_by_name` (joined) and `items?: OrderItem[]` (attached by the detail-fetch route, not present on list queries).
- `OrderItem` — line item, nullable `item_id` (custom/non-inventory-linked lines allowed).
- `DocTemplate` — `{ id, name, type, period, body, created_by, created_at, updated_at }`.
- `EmployeeStatus = 'probationary' | 'regular' | 'resigned' | 'terminated'`.
- `Employee` — the 201-file row; `photo: string | null` holds a data URI, not a file path; optional `department_name` (joined).
- `EmployeeDocument` — 201-file document metadata, optional `uploaded_by_name` (joined).
- `AttendancePeriod` — a payroll cutoff; optional `employee_count` (computed, roster size).
- `AttendanceRecord` — one employee/day row within a cutoff.
- `FieldDef` — one field definition inside a `form_definitions.fields` JSON array: `{ key, label, type: 'text'|'number'|'date'|'select'|'textarea'|'checkbox', required, options: string[], default: string }` (`options` only meaningful for `type: 'select'`).
- `FormDefinition` — `fields: string | FieldDef[]` (raw JSON string in the DB row; parsed array once a route deserializes it), optional `record_count`.
- `FormRecord` — `data: string | Record<string, unknown>` (same raw/parsed duality as `fields` above), optional `created_by_name`/`form_name` (joined).
- `GlobalVariable` — `{ key, label, value, updated_by, updated_at }`.
- `CompanyProfile` — `{ name, address, phone, email, logo_url }` (not a DB row — this shape is actually persisted via the `settings` key-value store under a single key, not its own table; see `templates.routes.ts`).
- `DocVariable` — a `doc_variables` registry row (constant / bound field / formula variable for the document-template editor).
- `CatalogEntry` / `CatalogGroup` — `{ path, label }` / `{ group, items: CatalogEntry[] }`, the shape of `DATA_SOURCE_CATALOG` in `src/doc-catalog.ts`.

### Express augmentation
```ts
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      token?: string;
    }
  }
}
```
Module augmentation (not a value export) that adds `user`/`token` as optional typed properties on every Express `Request` object throughout the codebase, so `req.user!.id` etc. type-checks in route handlers after `requireAuth` middleware has run. This block has side effects purely at the type level — it must be present in a file that's part of the TypeScript compilation for the augmentation to apply project-wide, but requires no explicit import elsewhere (ambient augmentation).

## Internal / non-exported helpers
None — this file contains only type/interface declarations, no runtime logic.

## Dependencies
None (no imports) — this is a leaf module in the dependency graph, imported by nearly everything else.

## Used by
Nearly every backend TypeScript file: `src/auth.ts` (`AuthUser`, `Role`), `src/permissions.ts` (`Role`, `Permission`), `src/doc-catalog.ts` (`CatalogGroup`), and every file under `src/routes/*.ts` (`users.routes.ts`, `hr.routes.ts`, `templates.routes.ts`, `personal.routes.ts`, `orders.routes.ts`, `inventory.routes.ts`, `auth.routes.ts`, `form-builder.routes.ts`, `ai.routes.ts`) for the relevant row/response types. Also `src/ai-tools.ts`.

## Notes / gotchas
- **No runtime validation lives here** — these are compile-time-only TypeScript types. A `SELECT` in a route file that doesn't actually match a declared interface's shape will not error; the mismatch only shows up as `undefined`/wrong-typed data at the point a field is read, since `queryOne`/`queryAll` in `src/db.ts` cast rather than parse.
- **Raw-vs-parsed JSON duality** appears repeatedly (`InventoryItem.attributes`, `FormDefinition.fields`, `FormRecord.data`) — each is typed as a union of the raw stored string and its parsed form specifically because the same interface is reused for "row straight out of the DB" and "shape sent back to the client after a route parses the JSON column." Callers must check which state they're in; the type alone doesn't disambiguate.
- Three enums must be kept manually consistent across files: `Role`/`Permission` here, `roleEnum` (and the analogous inline permission-key validation) in `src/validation.ts`, and `ALL_PERMISSIONS`/`ROLE_DEFAULTS` in `src/permissions.ts`. Adding an 8th... 9th role or 23rd permission means touching all three files (plus the frontend's own duplicated copies, e.g. `admin.js`'s `ROLE_DEFAULTS`).
- `CompanyProfile` is the one interface here that doesn't correspond to its own table — worth remembering when searching for "where is company profile stored" (`settings` table, single JSON blob, via `getSetting`/`setSetting`).
