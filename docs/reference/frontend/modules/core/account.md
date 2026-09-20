# `public/js/views/account.js`

## Purpose
"My Account" self-service view: shows the logged-in user's own identity (name/username/role/department), lets them edit their own display name, and change their own password. No admin capability — every field except display name is read-only, and role/department are shown but never editable here.

## Registered route(s)
```js
App.register('account', async (view) => { ... })
```
Single registration; no `filter` argument is used.

## Structure / key functions
No named helper functions — the whole view is two inline event listeners built directly in the register callback:
- Header card: avatar icon, `me.full_name`, `@username · role badge · department` — all read from `App.getMe()` at render time (a snapshot, not reactive).
- **Profile details panel** — `#pf-name` input (editable), `#pf-save` click handler: trims and requires non-empty, `PUT /auth/profile` with `{ full_name }`, then calls `App.setMe({ full_name })` (patches the cached session user) and updates the header's `#acc-name` text directly (avoids a full view reload). Errors shown inline in `#pf-err`.
- **Change password panel** — `#cur-pw`/`#new-pw`/`#con-pw` password inputs, `#pw-save` click handler: client-validates new password length (≥6) and that new/confirm match, then `POST /auth/change-password` with `{ current_password, new_password }`; on success toasts and clears all three fields. Errors shown inline in `#pw-err`.

## API endpoints used
- `PUT /auth/profile` — update own `full_name`.
- `POST /auth/change-password` — change own password (`current_password` + `new_password`; server verifies the current password).

## Permissions honored
None — every logged-in user can reach and use this view for their own account; there is no `App.hasPermission` check anywhere in the file.

## Dependencies
- `App.register`, `App.getMe`, `App.setMe`.
- `API` (`put`, `post`).
- `UI` (`icon`, `esc`, `toast`).

## Notes / gotchas
- Username, role, and department are rendered as `disabled` inputs / plain text — this view has no path to change them; that only happens via `admin.js`'s `editUser()` (requires `users.manage`).
- `App.setMe({ full_name })` is a partial patch, not a refetch — it relies on the caller (`app.js`) merging the patch into the cached `me` object so that other chrome (e.g. any header greeting) picks up the new name without a full session reload.
- Server-side, `POST /auth/change-password` keeps the *current* session token alive and deletes all of the user's *other* sessions (`src/core/auth.routes.ts`) — so changing your own password here signs out other devices/tabs but not the one you're using, unlike the admin's "Reset password" flow which invalidates every session including the current one.
