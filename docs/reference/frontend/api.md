# `public/js/api.js`

## Purpose
Thin `fetch` wrapper that centralizes API base path, bearer-token auth header, JSON
(de)serialization, and 401 handling for every network call the SPA makes.

## Exports / Public API

Attached as the global `const API` (IIFE, no `module.exports` — browser-only, not
unit-tested directly).

- **`API.getToken()`** → `string | null`. Reads `localStorage['vds_token']`.
- **`API.setToken(t)`** → stores the session token in `localStorage['vds_token']`.
- **`API.clearToken()`** → removes it.
- **`API.get(path)`**, **`API.post(path, body)`**, **`API.put(path, body)`**,
  **`API.del(path)`** → thin wrappers over the internal `request(method, path, body)`.
  `path` is appended to `/api` (e.g. `API.get('/inventory')` → `GET /api/inventory`).
- **`API.upload(path, formData)`** → `request('POST', path, formData, true)` — sends a
  `FormData` body as multipart (no `Content-Type` header set manually; the browser sets
  the multipart boundary).

### Internal: `request(method, path, body, isForm)`
- Builds headers: `Authorization: Bearer <token>` if a token exists.
- If `isForm` is true, `body` (a `FormData`) is passed through untouched as the payload.
  Otherwise, if `body !== undefined`, it's `JSON.stringify`'d and
  `Content-Type: application/json` is set.
- Calls `fetch('/api' + path, { method, headers, body: payload })`.
- **On HTTP 401**: calls `API.clearToken()`, then `window.App.showLogin()` if `window.App`
  exists, then throws `Error('Session expired. Please sign in again.')` — this is the
  single global session-expiry handler; individual views don't need to check for 401.
- Parses the response body as JSON only if the `Content-Type` response header contains
  `application/json`; otherwise `data` stays `null`.
- **On non-OK response** (`!res.ok`, and not 401): throws `Error(data?.error || 'Request
  failed (<status>)')` — so callers can just `catch (e) { UI.toast(e.message, 'error') }`.
- Returns the parsed JSON body (or `null`) on success.

## Internal structure
Single IIFE closure. `TOKEN_KEY = 'vds_token'` is the only piece of module state (besides
`localStorage`, which is the actual persistence). No caching, no request queue, no retry
logic — every call hits the network directly.

## Dependencies
- `window.App.showLogin` (soft dependency, checked with `if (window.App)` — API can be used
  before `App` exists, e.g. during `App.boot()`'s own session-resume call).
- Nothing else; this is the lowest-level frontend module and is loaded first in
  `index.html` (`<script src="/js/api.js">` before `ui.js`, `app.js`, and every view).

## Used by
Every view file and `app.js`/`tools.js` call `API.get/post/put/del/upload` for all backend
communication — effectively the entire `public/js/modules/*/*.js` set, plus `app.js` (login,
logout, session resume, department list, unread count) and `tools.js` (notes/tasks/
bookmarks). `doc-editor.js` does not call `API` directly (callers pass `onSave`/`getVariables`
closures that use `API` on the editor's behalf).

## Notes / gotchas
- There is no automatic retry or offline queueing — a failed request is just a thrown
  `Error` with a `.message`; UI code is expected to catch and `UI.toast()` it.
- `API` doesn't know about specific routes/schemas; it's purely transport. Route-specific
  validation errors surface as `data.error` strings from the server's central error handler
  (see `src/app.ts`).
- Because 401 handling calls `window.App.showLogin()` directly, any code that calls `API.*`
  before `App` is defined (unlikely in practice, since `api.js` loads first but `App.boot()`
  runs on `DOMContentLoaded`) would silently skip that redirect.
