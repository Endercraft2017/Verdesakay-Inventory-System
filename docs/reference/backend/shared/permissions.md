# `src/shared/permissions.ts`

## Purpose
Defines the full permission-key universe, each role's default permission set, and the function that merges a user's sparse per-user overrides on top of their role's defaults to produce their effective permission list. This is the policy layer `src/shared/auth.ts`'s middleware consults on every request.

## Exports / Public API

```ts
export const ALL_PERMISSIONS: Permission[]
```
The canonical list of all 22 permission keys, grouped by feature area (must stay in sync with the `Permission` union type in `src/shared/types.ts` — nothing enforces this automatically beyond TypeScript rejecting an out-of-union string literal):
`inventory.view`, `inventory.create`, `inventory.edit`, `inventory.delete`, `inventory.adjust`, `inventory.configure`, `orders.view`, `orders.create`, `orders.edit`, `orders.delete`, `forms.view`, `forms.upload`, `forms.delete`, `forms.manage`, `messages.view`, `messages.send`, `templates.view`, `templates.edit`, `templates.company`, `users.manage`, `hr.view`, `hr.manage`.

```ts
export function resolvePermissions(role: Role, overrides: Record<string, boolean> = {}): Permission[]
```
Computes a user's effective permission array. Builds a `Set` from that role's entry in `ROLE_DEFAULTS`, then iterates `ALL_PERMISSIONS` in canonical order (so the returned array's ordering is always the same, regardless of override insertion order) and for each key `p`:
- `overrides[p] === true` → included (explicit grant, even if not in role defaults).
- `overrides[p] === false` → excluded (explicit revoke, even if in role defaults).
- key absent from `overrides` → included only if `defaults.has(p)` (falls through to the role default).

This is called on every authenticated request inside `userFromToken()` in `src/shared/auth.ts` — permissions are **not** cached/stored resolved anywhere; they're recomputed fresh from `role` + `permission_overrides` each time a session token is looked up.

```ts
export function roleDefaults(role: Role): Permission[]
```
Returns a defensive copy (`[...(ROLE_DEFAULTS[role] ?? [])]`) of a role's default permission list with no overrides applied. **Not currently called anywhere in the backend** — grep confirms no route or other backend module imports it. (The frontend's `public/js/views/admin.js` independently hardcodes its own `ROLE_DEFAULTS` map for the permission-customization UI rather than fetching this from the server — see Notes.)

### `ROLE_DEFAULTS` (module-private constant, not exported)
`Record<Role, Permission[]>` — one entry per one of the 8 roles. Notable shapes:
- `admin`: `[...ALL_PERMISSIONS]` — every permission, always. This is what makes `admin` special: even permission overrides can't reduce below what `admin` effectively needs, since nothing in the app currently restricts an admin's own overrides (though the mechanism would technically allow revoking a permission from an admin account if an override were set on it).
- `admin_staff`: inventory (view/create/edit/adjust — no delete/configure), orders (view/create/edit — no delete), forms (view/upload/delete — no manage), messages (view/send), templates (view only).
- `accounting`: inventory view-only; orders (view/create/edit); forms (view/upload); messages; templates view.
- `warehouse`: inventory (view/create/edit/adjust); orders view-only; forms (view/upload); messages.
- `releasing`: inventory (view/adjust only — no create/edit); orders (view/create/edit); forms (view/upload); messages; templates view.
- `csr`: inventory view-only; orders (view/create/edit); forms (view/upload); messages; templates view.
- `hr`: forms (view/upload/delete); messages; templates view; **`hr.view`, `hr.manage`** (no inventory/orders permissions at all).
- `marketing`: forms (view/upload only); messages; templates view (the most restricted role — no inventory, orders, or HR access at all).

No role other than `admin` has `users.manage`, `inventory.delete`, `inventory.configure`, `forms.manage`, `templates.edit`, or `templates.company` by default — those are admin-only defaults, though any of them can be individually granted to a specific user via `permission_overrides`.

## Internal / non-exported helpers
None beyond `ROLE_DEFAULTS` itself (a data constant, not a function).

## Dependencies
- `./types` — `Role`, `Permission` (type-only import).

## Used by
- `src/shared/auth.ts` — `resolvePermissions` is called inside `userFromToken()` on every authenticated request; this is the only call site of `resolvePermissions`.
- `src/core/users.routes.ts` — imports `ALL_PERMISSIONS` and uses it in the `PUT /:id/permissions` handler to iterate every known permission key when building/validating the sparse `overrides` object saved to `users.permission_overrides`.

## Notes / gotchas
- **`ALL_PERMISSIONS` and the `Permission` union in `src/shared/types.ts` must be kept manually in sync** — they're two independent hand-written lists. TypeScript will catch a permission string used somewhere that isn't in the `Permission` type, but it will *not* catch a permission that's in the `Permission` type but missing from `ALL_PERMISSIONS` (or vice versa) — such a drift would silently make that permission un-overridable via `resolvePermissions`'s iteration (since it only walks `ALL_PERMISSIONS`) even though the type system allows it elsewhere.
- **Permissions are resolved fresh on every request**, not cached on the session row — changing a role's `ROLE_DEFAULTS` in code, or a user's `permission_overrides` in the DB, takes effect on that user's very next request, with no need to invalidate anything.
- **`roleDefaults()` is dead code from the backend's perspective** — the admin UI (`public/js/views/admin.js`) duplicates the role-default table client-side (`ROLE_DEFAULTS` constant there) instead of calling an endpoint backed by this function. If `ROLE_DEFAULTS` here is ever changed, the frontend's copy in `admin.js` must be updated in lockstep by hand, or the "Customize Permissions" drawer's ★ (this-is-a-default) markers will drift out of sync with actual server-side defaults.
- The sparse-diff override model (`true` = force-on, `false` = force-off, absent = inherit default) means **clearing** a user's customization back to role defaults requires deleting the key from `permission_overrides`, not just setting it to match the default value — setting `overrides[p] = true` when `p` is already a role default is a no-op in effect but still counts as an explicit override going forward (e.g. if that role's defaults later change to no longer include `p`, this user would keep it anyway).
