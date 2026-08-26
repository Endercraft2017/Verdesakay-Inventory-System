# Verdesakay Office System — Codebase Reference Map

> **This is the single source of truth for how the code is organized.**
> Before adding code, check here for an existing function/route/type to reuse instead of
> writing a duplicate. **When you change the code, update this file in the same commit.**
> Last verified: 2026-08-25 (HR Employees 201 file + Time Keeping, auto-seeded HR Payroll form
> and Employee ID Card template; DocEditor HTML/CSS mode now a real CodeMirror 6 editor —
> the project's first vendored external frontend dependency).
>
> For a **detailed per-file breakdown** (every export, function, and route with signatures,
> callers, and gotchas) see **[docs/README.md](README.md)**, which indexes
> **[docs/reference/](reference/)** — one markdown file per source file. This file stays the
> high-level map; `reference/` is where you go to actually change a specific file.

---

## 1. Overview

A LAN office system: **inventory**, **forms/files**, **user accounts with roles &
departments**, and **internal messaging**. One PC runs the server; other PCs use it in a
browser.

**Roles & permissions:** 8 roles (`admin`, `admin_staff`, `accounting`, `warehouse`,
`releasing`, `csr`, `hr`, `marketing`) each with granular per-feature permission defaults
defined in `src/permissions.ts`. Admins can override permissions per-individual via the
Accounts UI. Resolved effective permissions are a `Permission[]` on every `AuthUser`.
`forms.manage` (create/edit/delete form definitions + global variables) is admin-only by default.

- **Backend:** Node.js + Express + TypeScript (run with `tsx`, no build step).
- **Database:** SQLite via Node's built-in `node:sqlite` (file: `data.db`).
- **Frontend:** vanilla HTML/CSS/JavaScript SPA in `public/` (no framework, no build step for the
  app itself). One exception: `public/js/vendor/codemirror-bundle.js` — a pre-built CodeMirror 6
  bundle, the project's only external frontend dependency, vendored (not loaded from a CDN, since
  this is a LAN app that may run with no internet access) — see its row in §2 for what it is and
  how to rebuild it.
- **Auth:** bearer session tokens in the `sessions` table (12 h expiry); bcrypt passwords.
- **Validation:** `zod` schemas (`src/validation.ts`). **Security:** `helmet` + login
  rate-limiting. **Tests:** `vitest` + `supertest` (`tests/`).

### Request flow
```
Browser (public/js/*) --fetch--> Express (src/app.ts)
  -> helmet, json/urlencoded, login rate-limit, request log
  -> route (src/routes/*.ts): requireAuth -> requirePermission(key)? -> parseBody(zod)
  -> DB helpers (queryOne/queryAll/run in src/db.ts) -> node:sqlite
  -> JSON response  |  errors -> central handler in app.ts
```

---

## 2. Directory map (every source file, one line each)

### Backend (`/` and `src/`)
| File | Responsibility |
|---|---|
| `server.ts` | Entry point: `init()` DB, schedule session cleanup, `createApp()`, listen on `0.0.0.0:PORT`. |
| `src/app.ts` | **`createApp()`** — builds the Express app: middleware, route mounts, static serving, SPA fallback, central error handler. Imported by both `server.ts` and tests. |
| `src/db.ts` | DB connection + schema (`init()`), `migrate()` (idempotent `ALTER TABLE` for older DBs), seeding, **typed query helpers `queryOne` / `queryAll` / `run`**, **`getSetting`/`setSetting`** (JSON key-value `settings` store), `cleanupSessions()`, `newToken()`, `DB_PATH`/`UPLOAD_DIR` (env-overridable). |
| `src/auth.ts` | Session + RBAC: `createSession`, `destroySession`, `userFromToken` (resolves permissions), `getToken`, **middleware `requireAuth`, `requirePermission(key)`, `requireAnyPermission([keys])`, `requireRole(role)`**. |
| `src/permissions.ts` | `ALL_PERMISSIONS` (22 keys), `ROLE_DEFAULTS` map, **`resolvePermissions(role, overrides)`** — merges sparse `permission_overrides` diff with role defaults. Imported by `auth.ts`. |
| `src/types.ts` | All shared domain types (`Role` 8-variant enum, `Permission` 22-variant union, `UserRow`, `AuthUser` — includes `permissions: Permission[]`, `InventoryItem`, `FormRow`, `MessageRow`, `Employee`, `AttendancePeriod`, `AttendanceRecord`, …) + Express `Request` augmentation (`req.user`, `req.token`). |
| `src/validation.ts` | All `zod` request schemas + **`parseBody(schema, data)`** + `ValidationError`. Includes `roleEnum` (all 8 roles) + `permissionOverridesSchema`. |
| `src/routes/auth.routes.ts` | `/api/auth` — login, logout, me, change-password. |
| `src/routes/users.routes.ts` | `/api/users` — list, create, update, reset-password; departments list/create/rename/delete; **`PUT /:id/permissions`** (permission overrides). Guarded by `requirePermission('users.manage')`, except: `POST /departments` also accepts `hr.manage` (`requireAnyPermission`) — HR builds out its own department list without full account-management rights; `DELETE /departments/:id` also accepts `hr.manage`, but only when the department has zero `users`/`inventory_items`/`forms` referencing it (a department only used by `employees`, or unused entirely, is within HR's own domain) — `users.manage` callers delete unconditionally as before. Rename stays `users.manage`-only. |
| `src/routes/inventory.routes.ts` | `/api/inventory` — list/search, stats, detail+history, create, update, **adjust (stock in/out, transactional)**, delete, **`attributes` JSON round-trip**, **`form-config` GET/PUT** (item-form customization). |
| `src/routes/forms.routes.ts` | `/api/forms` — list (dept-visibility), upload (multer), download, delete. |
| `src/routes/messages.routes.ts` | `/api/messages` — inbox/sent, unread-count, send, mark-read, delete. |
| `src/routes/personal.routes.ts` | `/api/notes`, `/api/tasks`, `/api/bookmarks` — per-user CRUD for the right-rail tools (every query scoped to `req.user!.id`). Mounted at `/api`. |
| `src/routes/orders.routes.ts` | `/api/orders` — Job, Sale & Purchase orders CRUD (one router, `?type=sale\|job\|purchase`). Auto numbers (`SO-#####`/`JO-#####`/`PR-#####`) + **server-computed totals**, line items in a transaction. |
| `src/routes/templates.routes.ts` | `/api/templates` — document templates (read 🔑, write 👑) + `/company` profile (read 🔑, write 👑). |
| `src/routes/form-builder.routes.ts` | `/api/form-definitions`, `/api/form-records`, `/api/global-variables` — admin-managed custom form types (with JSON field defs), per-form record CRUD (auto-numbered), and global template variables. Also `POST /form-definitions/:id/import` — bulk-create records from the payroll "Summary" CSV (multer memory storage; optional `pay_date` body field stamped onto every row); 400s unless the target form's slug is `hr_payroll`. |
| `src/hr-payroll-import.ts` | `parseCsvRows()` (small RFC4180-ish CSV tokenizer) + `parsePayrollSummaryCsv()` — extracts `PayrollSlip` records from the payroll "Summary" CSV export: one row per employee (occasionally two, when a mid-cutoff rate change splits a row — the second has no No./Name of its own and inherits the last-seen employee), department taken from section-header rows scanned top-down, payroll period from the sheet's title cell. Every value is read at a **fixed column index** (`COL` map); `basic_salary`/`total_earnings`/`total_deductions` are **recomputed from the parts** rather than trusting the sheet's own totals, because the sheet nets the late/undertime deduction into its "BASIC PAY" column while our form (and the printed slip) treats it as a pure deduction line — reusing the sheet's totals as-is would double-count that deduction against NET PAY. Pure, no I/O — unit tested directly. |
| `src/routes/hr.routes.ts` | `/api/hr` — **Employees** master list CRUD (`hr.view`/`hr.manage`): the 201 file — auto-numbered (`employee_no`, `EMP-#####`), `status` (probationary/regular/resigned/terminated), department/position/daily_rate, statutory numbers (SSS/PhilHealth/Pag-IBIG/TIN), a `photo` data URI, filterable by `department_id`/`status`. **`/employees/:id/documents`** — 201-file document uploads (multer `diskStorage`, same shape as `forms.routes.ts`), `hr.view` read / `hr.manage` write. **Time Keeping**: cutoff periods (`attendance_periods`) with a daily time-in/out roster (`attendance_records`, one row per employee per date, pre-populated blank for the period's date range when an employee is added). `POST /periods/:id/generate-payslips` creates/updates one record per roster employee in the `hr_payroll` form (matched by employee name + period, so re-generating updates rather than duplicates) — prefills identity/rate/period only, leaving hours/earnings/deductions for manual entry via the existing Form Records UI. |

### Frontend (`public/`)
| File | Responsibility |
|---|---|
| `public/index.html` | App shell: login screen + **ECOUNT-style chrome** (utility bar w/ menu search + site map, top primary menu `#primary-nav`, secondary `#subnav`, workspace = `#tree-nav` \| `#view` \| `#rail`); loads all scripts in order (nav-config before app). |
| `public/js/nav-config.js` | **`NAV`** (declarative 3-tier nav tree: primary → subtabs → leaves) + **`ROUTE_NAMES`**. The single source of truth for navigation; browser global + CommonJS export for tests. |
| `public/js/item-form-config.js` | **`ITEM_FORM_DEFAULTS`** (the ECOUNT-style item field catalog: 7 tabs, per-field type/default/visible/required) + **`ITEM_FORM_TABS`** + **`ITEM_CORE_KEYS`**. Default layout for the New/Edit Item form; admin overrides saved server-side and merged over it. Browser global + CommonJS export for tests. |
| `public/js/doc-template.js` | **`renderTemplate(body, ctx)`** — safe `{{var}}` / `{{#items}}` / `{{#if}}` renderer (HTML-escaped) for printable docs + **`ORDER_VARIABLES`** (editor palette catalog). Browser global + CommonJS for tests. |
| `public/js/vendor/codemirror-bundle.js` | The project's **only external frontend dependency** — a pre-built, minified IIFE bundle (CodeMirror 6: `codemirror` + `@codemirror/lang-html` + `@codemirror/autocomplete` + `@codemirror/language`), vendored rather than loaded from a CDN (this is a LAN app — a CDN import would silently break the editor with no internet at the deployed site). Attaches one global, `window.CMBundle = { mount(container, {doc, onChange, getVariables, dark}) }`, returning `{getValue(), setValue(text), destroy(), focus()}`. Three completion sources feed `autocompletion({override: [...]})` — **`override` replaces every default completion source, so all three must be listed explicitly, not just the custom one** (an earlier version of this bundle only listed the custom source, which silently killed CM's own HTML tag/attribute and CSS value/color completions — confirmed and fixed): 1) a custom `{{variable}}`/`{{= formula(...)}}` source (this app's own syntax, unknown to any language server — reuses `getVariables()`, same list as Visual mode); 2) `htmlCompletionSource` (CM's own HTML tags/attributes + nested CSS *value* completion, e.g. `color: r` → `red`); 3) a custom CSS *property-name* source (`color`, `background`, `padding`, …, scoped to inside a `<style>` block via the syntax tree) — needed because `@codemirror/lang-css`'s own property-name completion stays silent for a bare, still-being-typed identifier right after `{` (confirmed directly against the unmodified upstream package: its nesting-capable CSS grammar can't yet tell "start of a declaration" from "start of a nested rule selector" at that position, so it offers nothing rather than guess). `codemirror-bundle.src.js` (same folder) is the un-bundled entry source; **to rebuild** (e.g. to upgrade CodeMirror): in a scratch dir, `npm install codemirror @codemirror/lang-html @codemirror/autocomplete @codemirror/language`, copy in `codemirror-bundle.src.js` as `entry.js`, then `npx esbuild entry.js --bundle --minify --format=iife --global-name=CMBundle --outfile=codemirror-bundle.js` and copy the result back — no dependency is ever added to this project's own `package.json`. |
| `public/js/doc-editor.js` | **`DocEditor.open(opts)`** — full-screen Word-style visual template editor (Visual ⇄ HTML/CSS modes, tabbed ribbon, table tools, formula builder, variable picker/autocomplete). The ribbon is a **tab strip** (`Home` / `Insert` / `Layout`, plus a contextual `Table` tab shown only while the cursor is inside a table, auto-returning to `Home` on exit) — only the active tab's panel is visible, so the toolbar stays a fixed ~2-row height regardless of window width instead of wrapping or scrolling. Each panel is built from **labeled groups** (`groupHTML(caption, buttons)` — a row of controls with a caption underneath, e.g. "Font", "Paragraph", "Page Setup", mirroring Word's own ribbon structure); Insert/Layout use larger icon-over-label `.doc-tile` buttons (few, higher-level commands), Home/Table stay compact icon-only (dense, frequent commands) — same split Word itself uses; Insert also has Symbol (₱/©/°/… picker), Text Box, and Signature Line; Home's "Editing" group has Find (moved off the top bar, mirroring where Word itself puts it); Layout's "Preview" group also has the movable-preview toggle. The top bar (`.doc-fs-bar`) splits into a scrolling region (`.doc-fs-bar-scroll` — name/type select (`.doc-fs-type-top`, narrower than the Layout tab's page-size/orientation selects, which share the base `.doc-fs-type` class but get their own `.doc-tile-select select{width:80px}` override)/period/mode toggle, icon-only Preview + Variables buttons) and a **pinned, never-scrolling `.doc-fs-bar-actions`** (Save/Close) — Preview is deliberately reachable from *both* the top bar and the Layout tab (two `[data-preview]` elements, wired via `querySelectorAll` not `querySelector`), since it's frequent enough to want in the always-visible bar, unlike Find which lives only in the Home tab — Save and Close must never be reachable only via horizontal scroll; trimming the scroll region's contents (Find/Preview relocated, Variables icon-only, shorter name/period widths, ellipsis'd title) keeps it under one screen-width in practice. Combo selects with long option text (paragraph style, font name, font size, table style) have explicit compact widths + ellipsis truncation rather than sizing to their widest option. **Page setup is exact-size, not just A4/Letter**: `parsePageStyle(body)`/`pageStyleTag(widthMm, heightMm, marginMm)` store the real `widthMm`/`heightMm`/`marginMm` (plus a derived `preset` — `a4`/`letter`/`custom`) in the saved `<style data-docpage>` `@page` rule; the Layout tab's Size select offers A4/Letter (with an Orientation select) or Custom (with direct Width/Height-in-mm number inputs plus a **⇄ swap button** that exchanges them — the portrait/landscape toggle for a custom size, since "orientation" isn't meaningful for an arbitrary W×H the way it is for a fixed preset), plus an always-present Margin (mm) field that also sets the on-screen canvas `padding` live, not just the print `@page{margin}` — old templates saved with the legacy `size: a4|letter portrait|landscape` format still parse correctly. `pageDims(widthMm, heightMm)` converts mm → on-screen px at 96dpi for the canvas. **`bodyToEditorHtml(body)`** turns stored `{{var}}` tokens into non-editable "chip" `<span>`s for the canvas; a `{{var}}` used as an `<img src="…">` is special-cased (a chip can't live inside an attribute value without breaking the tag) — it's shown as a neutral placeholder image with the real token stashed in `data-var-src`, restored by **`serializeEditor(el)`** on save. **The "HTML / CSS" mode is a real `window.CMBundle`-mounted CodeMirror editor** (mounted lazily on first switch, since mounting into a `display:none` container mismeasures line layout), not a plain textarea — real HTML/CSS syntax highlighting + CM's own tag/attribute/property/color completions, *plus* a custom completion source for this app's own `{{variable}}`/`{{= formula(...)}}` syntax (same variable list as Visual mode's `{{` autocomplete, same six formula function names as `formulaDialog()`'s `FNS`), and its `onChange` fires the same `dirty = true; refreshPreview()` as every other edit path, so the movable Preview panel updates live while typing. `getCode()`/`setCode(text)` wrap the CM instance everywhere the old `code.value` used to be read/written (`currentBody()`, `setMode()`, the save handler); theme (light/dark) and syntax-highlight colors are picked once at mount time from `document.documentElement`'s `data-theme` (or `prefers-color-scheme`) and don't live-update if the app theme is toggled mid-edit. Pure helpers also exported CommonJS for tests. **Floating objects** (Word-style movable/resizable shapes, text boxes, and "wrap text" for images/tables): one mechanism, a `.doc-float` wrapper (`contenteditable="false"`, `position:absolute`, `left/top/width/height` in **percent of the page** — not px, so the editor canvas and the physically-different-sized print/preview page (`UI.printableHtml`'s plain `body`, also `position:relative` now) still place a float in visually the same spot — and `data-wrap="front"/"behind"` driving `z-index` (behind = `-1`, relying on the ordinary CSS rule that a negative-z-index absolute descendant paints below its ancestor's normal-flow siblings — no stacking-context wrapper needed)). Insert-tab's new "Shapes" group (Rectangle/Oval/Line, `data-ins="shape-rect\|shape-oval\|shape-line"`) and the "Text Box" tile all go through `insertFloat(kind)`, appended directly as a `surface` child (not via `execCommand('insertHTML')`, which doesn't handle absolutely-positioned content predictably). Text boxes (and a promoted table's own `<table>`) re-enable `contenteditable="true"` on an inner child — the same **nested editable-island** pattern this file already used for `{{variable}}` chips (`contenteditable="false"` ancestor, `contenteditable="true"` descendant). Clicking a plain `<img>`/`<table>` not already inside a float shows a small "wrap text" bar (`promoteToFloat(target, 'front'\|'behind')`) that wraps it in place (position computed from its current rendered rect, so nothing jumps); a floated image/table's own toolbar can unwrap it back inline. Selecting a float (`selectFloat`) dynamically appends 8 `.doc-float-handle` resize handles + a `.doc-float-toolbar` (wrap toggle, delete, fill/border color for shapes) as children — created only while selected, so they're normally never in saved HTML; `serializeEditor()` also defensively strips them plus `.selected` before saving, the same way it already stripped `.cell-sel`. Drag/resize track `mousedown`→`mousemove`→`mouseup` (px math converted to page-relative `%` on commit, `onChange()` called once on mouseup — not per-move, mirroring the existing table column-resize pattern) and don't conflict with the Excel-style cell-selection handler (that one already no-ops for any non-`td/th` mousedown target). Because `serializeEditor()` strips `contenteditable` from every element before saving (so it never round-trips through storage), `wireToolbar()` exposes `normalizeFloats()` — called after both places that reload a full `surface.innerHTML` from saved/serialized HTML (initial open, and the code→visual mode switch) — to re-apply `contenteditable="false"`/`"true"` so reloaded floats are still atomic drag targets with working editable islands. `sanitizeHtml`'s paste allowlist was extended for this (`position` — but value-restricted to `absolute\|relative\|static`, since `fixed`/`sticky` could let pasted content escape the page and overlay app chrome — plus `left/top/right/bottom/height/z-index/border/border-color/border-radius`, `data-float-kind`/`data-wrap`, and the `doc-float*` class family). |
| `public/js/hr-payroll-print.js` | **`buildPayrollSlipsHtml(dataList)`** — printable HTML for HR Payroll records: A4 pages, 2 employees per page × 2 identical copies each (2x2 CSS grid, column-major so each employee's copy-pair is cut together), NET PAY computed as `total_earnings - total_deductions`. Standalone (not the shared order-centric doc_template engine). Browser global + CommonJS for tests. |
| `public/css/styles.css` | All styling (green/blue brand theme via CSS tokens, ECOUNT chrome: util-bar/topnav/subnav/tree/rail, tables, modals, toasts, site map). |
| `public/js/api.js` | **`API`** — fetch wrapper with token handling (`get/post/put/del/upload`), 401 → logout. |
| `public/js/ui.js` | **`UI`** — `esc`, `toast`, `fmtDate/fmtDateShort/fmtBytes`, `initials`, **`modal()`**, `confirmDialog()`, **`drawer()`** (right-docked, single-instance), **`contextMenu(x,y,items)`**, **`helpIcon(text)`** (hover/tap tooltip), **`printableHtml(html,title)`** (wraps a fragment in a full HTML doc + the print stylesheet — used as an iframe's `srcdoc`), **`icon(name,size)`** (inline SVG set), **`emptyState(...)`**. **Every print flow in the app is the preview-modal + iframe pattern** (`UI.modal({bodyHTML: '<iframe>', onOpen: (ov) => iframe.srcdoc = UI.printableHtml(...), onConfirm: (ov) => iframe.contentWindow.print()})` — see `printSlips()` in `form-records.js`, `generateId()` in `hr-employees.js`, `printOrder()` in `orders.js`, `openPreview()` in `templates.js`, the image branch of `printFile()` in `forms.js`). There used to also be a `printDocument()` helper that opened a real `window.open()` popup and wrote the HTML into it — **removed**, since a new browser window/tab can be popup-blocked outright by some browsers/extensions regardless of click-gesture timing, while an `<iframe>` inside an already-open `UI.modal()` never opens a new window, so it can't be popup-blocked at all. (`forms.js`'s PDF branch still uses a plain `window.open(blobUrl, '_blank')` — a direct navigation, not the open-then-write pattern that was the problem — so it's unaffected.) |
| `public/js/tools.js` | Right-rail personal tools: **AI assistant** + **Email** (UI-only previews), **Notes** / **Scheduler** (tasks) / **Bookmarks** (per-user, via `/api/notes\|tasks\|bookmarks`), and **right-click-to-bookmark** on nav items. |
| `public/js/app.js` | **`App`** — auth (login/logout/session resume), chrome rendering (`renderPrimaryNav`/`renderSubnav`/`renderTree` from `NAV`), hash router (`register`/**`navigate(name, filter)`**), **`currentLocation()`** (for bookmarks), menu search + site map, unread-badge + tool rail, **theme** (`applyTheme`/`toggleTheme`, persisted in `localStorage('vds_theme')`). **`App.hasPermission(key)`** — checks `me.permissions` array; used by views to conditionally show controls. |
| `public/js/views/dashboard.js` | Dashboard: stats cards, low-stock list, recent messages. |
| `public/js/views/inventory.js` | Inventory table: search/filter, **config-driven 7-tab create/edit modal** (renders from `ITEM_FORM_DEFAULTS` merged with the saved layout; core fields → columns, the rest → `attributes`), **admin "Option" customizer** (show/hide·required·default, saved via `form-config`), stock adjust modal, history modal, delete. Honors `filter.low`. |
| `public/js/views/forms.js` | Forms table: upload modal, authenticated blob download, delete, **Print** (PDFs open in a new tab via the browser's native viewer; images preview in a modal + iframe, same pattern as templates/orders below — Office files = download only). |
| `public/js/views/orders.js` | Job, Sale & Purchase orders (route `orders`, `filter.type`): list, create/edit with **inventory-backed line-item editor** (live totals), **Print** (renders the type's template into a preview modal + iframe — see the printing note under `ui.js`), delete. |
| `public/js/views/form-builder.js` | Form Builder admin view (route `form-builder`): manage form definitions (name, slug, prefix, icon, fields editor) + Global Variables manager. Requires `forms.manage`. |
| `public/js/views/form-records.js` | Form Records view (route `form-records`): without `filter.form_id` shows a form index card grid; with `filter.form_id=X` shows records list + create/edit modal dynamically generated from the form's field definitions (`filter.period` optionally pre-selects the period filter — used when jumping here from Time Keeping's "Generate Payslips"). When the form's slug is `hr_payroll`, adds **Upload CSV** (posts file + optional `pay_date` to the import route) and **Print Slips** toolbar buttons. Print Slips opens a **preview tab first** (no auto `window.print()`) with a floating Print/Close bar — printing (and the OS/browser print-settings dialog: paper, copies, printer) only happens once the user clicks Print. |
| `public/js/views/templates.js` | Document templates (route `templates`): list, editor (variable **palette** + live iframe **preview**), preview/print (list's eye icon / non-admin row click — a preview modal + iframe, not `window.open()`), admin-only CRUD, **company profile** editor. `SAMPLE` mock context feeds both this preview and the editor's own preview — includes an `employee` block (name/employee_no/position/department/photo placeholder) alongside `company`/`order`/`items`, so HR-oriented templates (e.g. "Employee ID Card") preview with realistic data too. |
| `public/js/views/messages.js` | Inbox/sent tabs, open/read thread, compose/reply modal, delete. Honors `filter.box` (Inbox/Sent tree leaves). |
| `public/js/views/admin.js` | Accounts (`users.manage` permission): user table with all 8 roles, create/edit/reset-password, add department. Honors `filter.tab==='departments'` (opens manager). Edit user has **"Customize Permissions"** button → `UI.drawer()` with grouped checkboxes per permission key, ★ marks current overrides, Reset/Save via `PUT /users/:id/permissions`. |
| `public/js/views/account.js` | My Account: profile + change own password. |
| `public/js/views/hr.js` | HR (route `hr`): module launcher grid. Payroll card looks up the `hr_payroll` form and jumps to Form Records; Employees/Time Keeping cards navigate to the two modules below; Leave Management is still "Coming soon". |
| `public/js/views/hr-employees.js` | Employees master list / 201 file (route `hr-employees`, `hr.view`/`hr.manage`): name, department, position, daily rate, employment status, start date, SSS/PhilHealth/Pag-IBIG/TIN, a photo (resized client-side to a small JPEG **data URI** via canvas before upload — no server-side image storage), and per-employee **201 documents** (upload/download/delete, editing only). Filterable by department/status, with inline **add/delete department** buttons next to the Department select (posts/deletes via `/users/departments`, allowed for `hr.manage` too — see the API catalog; delete is blocked server-side if the department is still used outside HR). **Generate ID** renders the "Employee ID Card" document template (`renderTemplate()`) with a `{company, employee, today}` context and shows it in a **preview modal + iframe** (same pattern as `printSlips()` in `form-records.js` — see the printing note under `ui.js`). Delete is blocked with a 409 if the employee has attendance history (set status to resigned/terminated instead). |
| `public/js/views/hr-timekeeping.js` | Time Keeping (route `hr-timekeeping`): without `filter.period_id`, a **cutoff list** (label + date range + employee count, create/delete). With `filter.period_id=X`, the **cutoff detail**: roster table (employee, dept, days logged), **Add Employee** picker (mirrors `pickInventory()` in `orders.js`, filterable by department/status), a **daily grid modal** per employee (one row per date in the cutoff's range, editable `time_in`/`time_out`/`notes`, saved via `PUT /hr/periods/:id/attendance`), and **Generate Payslips** (creates/updates `hr_payroll` records for the roster, then offers to jump to Form Records filtered to that period). |

### Tests (`tests/`)
| File | Covers |
|---|---|
| `tests/helpers.ts` | `setupApp()` (isolated temp DB + uploads), `login`, `createEmployee`, `cleanup`. |
| `tests/unit.test.ts` | zod schemas + bcrypt (pure, no HTTP). |
| `tests/frontend-nav.test.ts` | nav-config sanity: every tree leaf → registered route, admin-only correct, ids unique (loads `nav-config.js` in a sandbox). |
| `tests/item-form-config.test.ts` | item-form catalog sanity: unique keys, valid tabs, core keys ↔ real columns, choice fields have options (sandbox-loads `item-form-config.js`). |
| `tests/auth.test.ts` | login, me, logout, RBAC (`users.manage` guard), last-admin guard, change-password. |
| `tests/departments.test.ts` | usage counts, create/rename/delete, duplicate-name rejection, FK-set-null on delete, RBAC (`users.manage` for everything; `hr.manage` can create and can delete but never rename — and its delete is 409-blocked if a user/item/form still references the department, while `employees`-only usage is fine). |
| `tests/inventory.test.ts` | CRUD, stock in/out + history, negative-stock guard, low-stock filter, search, stats, **`attributes` round-trip, `form-config` GET/PUT + admin-only guard**. |
| `tests/forms.test.ts` | upload/download round-trip, department visibility, delete permissions. |
| `tests/messages.test.ts` | send, inbox/sent, unread count, mark-read, self-message guard, delete. |
| `tests/personal.test.ts` | notes/tasks/bookmarks CRUD, **per-user isolation** (no cross-user read/update/delete), auth + validation. |
| `tests/orders.test.ts` | order create (auto number + **server-computed totals**, ignores client totals), list by type, update-replaces-items, delete cascade, validation, auth. Covers `sale`, `job`, `purchase` types. |
| `tests/templates.test.ts` | default seeds, **admin-only** template CRUD, company profile get/put (employee 403). |
| `tests/form-builder.test.ts` | form definition CRUD + auth (`forms.manage` guards), record create/update/delete + auto-numbering per form, cascade on form delete, global variable upsert/delete, **HR Payroll CSV import** (400 for non-`hr_payroll` forms, 404 unknown form, 400 missing file, pay-date stamping, correct field extraction + `completed` status on success). |
| `tests/hr-payroll-import.test.ts` | `parsePayrollSummaryCsv` pure-function tests (rows built positionally via a `row()`/`COL` helper, not hand-typed comma strings, so column offsets can't silently drift): department tagging from header rows, mid-cutoff rate-change row splitting, computed (not sheet-trusted) earnings/deductions totals, footer-row rejection (label text landing in the days-worked column by coincidence), empty input. |
| `tests/hr-payroll-print.test.ts` | `buildPayrollSlipsHtml` (sandbox-loaded like `doc-template.js`): NET PAY math, 2-copies-per-employee, 2-per-page grouping with blank-slot padding for odd counts, string/number coercion, empty-list handling. |
| `tests/doc-template.test.ts` | renderer: vars, items loop, `{{#if}}` (incl. nested), HTML-escaping, missing-var, palette catalog. |
| `tests/doc-editor.test.ts` | `bodyToEditorHtml`/`serializeEditor` round-trips (plain vars, formulas, control tokens, repeatable item rows, checkboxes) — including that a `{{var}}` inside an `<img src="…">` becomes a placeholder image with the token preserved via `data-var-src` rather than corrupting the tag, and an ordinary (non-variable) image src is left alone. Plus `sanitizeHtml` paste-hardening; the find/replace helper; and page setup — `parsePageStyle`/`pageStyleTag`/`pageDims` mm-based size+margin round-trips, custom-size detection (`preset: 'custom'`), and backward-compatible parsing of the legacy `size: a4|letter portrait|landscape` format. |
| `tests/hr.test.ts` | HR Payroll form auto-seeding, employee CRUD (auto `employee_no`, default `probationary` status, statutory-number fields, photo data-URI validation, department/status filters), 201-file document upload/list/download/delete, delete-blocked-with-attendance-history (409), cutoff creation, adding an employee pre-populates blank day rows for the full date range, bulk daily attendance save (replace-in-place), **Generate Payslips** (creates a `form_records` row per roster employee, re-generating updates instead of duplicating, 400 on an empty roster), `hr.view`/`hr.manage` permission enforcement. |
| `tests/hr-migration.test.ts` | Regression test for the `employees` rebuild migration: seeds a raw pre-upgrade DB (old `active` flag + a real `attendance_records` FK reference to it), then imports `src/db` and asserts `init()` doesn't throw, `employee_no`/`status` are correctly backfilled, the FK reference survives, and the `employee_seq` counter is advanced past the backfilled numbers (else the next created employee would collide on `employee_no`). |

---

## 3. Data model (SQLite — defined in `src/db.ts` `init()`)

| Table | Key columns | Notes |
|---|---|---|
| `departments` | id, name (unique) | Seeded: Administration, Operations, Finance, Human Resources, IT. |
| `users` | id, username (unique), full_name, password_hash, role (8 variants), department_id→departments, active, **`permission_overrides` (JSON `{}`)** | 8 roles: `admin`, `admin_staff`, `accounting`, `warehouse`, `releasing`, `csr`, `hr`, `marketing`. `permission_overrides` stores only the sparse diff vs role defaults; resolved by `resolvePermissions()` on every request. Seeded admin on first run. |
| `sessions` | token (PK), user_id→users, expires_at | Bearer tokens; cleaned hourly + on demand. |
| `inventory_items` | id, name, sku (unique), category, department_id, quantity, unit, min_quantity, location, notes, **attributes (JSON)** | `quantity <= min_quantity` ⇒ low stock. `attributes` holds the extended ECOUNT-style fields (see `item-form-config.js`); added via `migrate()` on older DBs. |
| `inventory_transactions` | id, item_id→items, user_id, change, balance_after, reason | Append-only stock history; written on create + every adjust. |
| `forms` | id, title, …, stored_name, original_name, department_id (null=all staff), uploaded_by | File on disk in `uploads/`, metadata in DB. |
| `messages` | id, sender_id, recipient_id, subject, body, read_at | Inbox = recipient, Sent = sender. |
| `settings` | key (PK), value (JSON), updated_at | Generic app-wide key-value store (via `getSetting`/`setSetting`). Holds `item_form_config` (the saved item-form layout). |
| `notes` | id, user_id→users (CASCADE), title, body, created_at, updated_at | Per-user notes (right-rail Notes tool). |
| `tasks` | id, user_id→users (CASCADE), title, due_date, done, created_at | Per-user tasks (right-rail Scheduler). |
| `bookmarks` | id, user_id→users (CASCADE), label, route, params (JSON), created_at | Per-user saved nav destinations (right-rail Bookmarks). |
| `orders` | id, type(`sale`\|`job`\|`purchase`), number (unique), customer_*, order_date, status, currency, subtotal, tax_percent, tax_amount, total, created_by | Job/Sale/Purchase order header. Number from `settings` counters (`order_seq_sale\|job\|purchase`); totals computed server-side. |
| `order_items` | id, order_id→orders (CASCADE), item_id→inventory_items (null), name, sku, description, quantity, unit, unit_price, line_total, sort | Order line items; may link an inventory item or be custom. |
| `doc_templates` | id, name, type(`sale`\|`job`\|`purchase`\|`generic`), body (HTML+`{{vars}}`), created_by | Printable templates; default Sale/Job/Purchase + "HR Payroll Slip" + **"Employee ID Card"** (`{{employee.*}}`/`{{company.*}}`; **front + back CR-80 cards side by side** on one 177.2mm×54mm landscape page — its own embedded `<style data-docpage>@page{size:177.2mm 54mm;margin:3mm}</style>` opens it already sized correctly in the editor's Layout tab as a "Custom" size) seeded on first run (`seedTemplates()`), all editable afterward like any other template. |
| `doc_variables` | id, scope(`global`\|`template`), template_id→doc_templates (CASCADE, null when global), category, key, label, source_type(`constant`\|`field`\|`formula`), value, field_path, formula, data_type(`text`\|`number`\|`currency`\|`date`), sort | Admin-defined custom `{{var}}`s for the template editor's palette — **distinct from `global_variables` below** (older, simpler key/value pairs). UNIQUE per `(scope, template_id, key)`. `field_path` binds to a `DATA_SOURCE_CATALOG` entry (`src/doc-catalog.ts`); `formula` holds a `doc-formula.js`-evaluated expression. Managed via `/api/templates/variables*` (§4). |
| `form_definitions` | id, name, slug (unique), number_prefix, icon, fields (JSON `FieldDef[]`), created_by | Admin-created custom form types. Each field becomes a `{{key}}` template variable. Not auto-seeded in general — the one exception is **`HR Payroll`** (slug `hr_payroll`, prefix `PAY`, 22 fields: employee/period/rate/OT info + earnings + deductions breakdown), auto-seeded by `seedHrPayrollForm()` in `src/db.ts` (same pattern as `seedTemplates()`) so Time Keeping's "Generate Payslips" always has a target form, even on a fresh install. |
| `form_records` | id, form_def_id→form_definitions (CASCADE), number (unique, auto `PREFIX-#####`), data (JSON key→value), status, created_by | Submitted records for any custom form. Auto-numbered per form via `settings` counter `form_seq_<id>`. |
| `global_variables` | key (PK), label, value, updated_by | Admin-managed key-value pairs injectable as `{{global.key}}` in any template. |
| `employees` | id, **employee_no (unique, `EMP-#####`)**, name, department_id→departments (SET NULL), position, daily_rate, **status** (`probationary`\|`regular`\|`resigned`\|`terminated`, CHECK), start_date, sss_no, philhealth_no, pagibig_no, tin_no, **photo (data: URI)** | The 201 file — distinct from `users` (system login accounts); picked into Time Keeping cutoffs and feeds identity/rate into generated payslips. `photo` is a client-resized data URI, not a disk file (see `hr-employees.js`) — no server-side image storage or serving endpoint needed. |
| `employee_documents` | id, employee_id→employees (CASCADE), title, stored_name, original_name, mime_type, size_bytes, uploaded_by | Uploaded 201-file documents (contracts, certificates, IDs, …); file on disk in `uploads/`, metadata in DB — same pattern as `forms`, but HR-only visibility (`hr.view`/`hr.manage`) instead of department visibility. |
| `attendance_periods` | id, label, start_date, end_date, created_by | A pay "cutoff". `label` is also stamped as `form_records.period` when payslips are generated for it. |
| `attendance_records` | id, period_id→attendance_periods (CASCADE), employee_id→employees (RESTRICT), work_date, time_in, time_out, notes, **UNIQUE(period_id, employee_id, work_date)** | One row per employee per day within a cutoff — existence of any row is what makes an employee "on the roster". Rows are pre-created blank for the full date range when an employee is added to a cutoff (`ensureRosterDays` in `hr.routes.ts`); hours are entered/edited manually, never auto-computed. |

Foreign keys are ON; deleting a user/department cascades or nulls as defined per column.

---

## 4. API catalog (the anti-duplication index)

All routes are under `/api`. **Auth** column: 🔓 none · 🔑 any logged-in user · 🔐 specific permission required · 👑 `users.manage` permission (replaces the old "admin only").
Bodies are validated by the named schema in `src/validation.ts`.

| Method & path | Auth | Purpose | Handler | Schema |
|---|---|---|---|---|
| POST `/auth/login` | 🔓 | Log in, return token+user | auth.routes | loginSchema |
| POST `/auth/logout` | 🔑 | Invalidate current token | auth.routes | — |
| GET `/auth/me` | 🔑 | Current user | auth.routes | — |
| POST `/auth/change-password` | 🔑 | Change own password | auth.routes | changePasswordSchema |
| PUT `/auth/profile` | 🔑 | Update own display name | auth.routes | updateProfileSchema |
| GET `/users` | 🔑 | Directory (full fields if `users.manage`) | users.routes | — |
| POST `/users` | 👑 | Create account (any of 8 roles) | users.routes | createUserSchema |
| PUT `/users/:id` | 👑 | Update name/role/dept/active | users.routes | updateUserSchema |
| POST `/users/:id/reset-password` | 👑 | Reset a user's password | users.routes | resetPasswordSchema |
| PUT `/users/:id/permissions` | 👑 | Save sparse permission overrides | users.routes | permissionOverridesSchema |
| GET `/users/departments/list` | 🔑 | List departments (id+name, for selects) | users.routes | — |
| GET `/users/departments` | 👑 | Departments + usage counts (manager) | users.routes | — |
| POST `/users/departments` | 🔐`users.manage` or `hr.manage` | Add department | users.routes | createDepartmentSchema |
| PUT `/users/departments/:id` | 👑 | Rename department | users.routes | updateDepartmentSchema |
| DELETE `/users/departments/:id` | 🔐`users.manage` (any) or `hr.manage` (only if unused by users/items/forms) | Delete department (FK sets refs null) | users.routes | — |
| GET `/inventory` | 🔑 | List (`?q=`, `?department_id=`, `?category=`, `?low=1`) | inventory.routes | — |
| GET `/inventory/stats` | 🔑 | Dashboard totals | inventory.routes | — |
| GET `/inventory/categories` | 🔑 | Distinct categories (for filters) | inventory.routes | — |
| GET `/inventory/form-config` | 🔑 | Saved item-form layout (or `null`) | inventory.routes | — |
| PUT `/inventory/form-config` | 🔐`inventory.configure` | Save item-form layout (show/hide·required·default) | inventory.routes | formConfigSchema |
| GET `/inventory/:id` | 🔑 | Item (+ parsed `attributes`) + last 50 movements | inventory.routes | — |
| POST `/inventory` | 🔑 | Create item (core cols + `attributes` JSON) | inventory.routes | createItemSchema |
| PUT `/inventory/:id` | 🔑 | Update details + `attributes` (not qty) | inventory.routes | updateItemSchema |
| POST `/inventory/:id/adjust` | 🔑 | Stock in/out (transactional) | inventory.routes | adjustStockSchema |
| DELETE `/inventory/:id` | 🔑 | Delete item + history | inventory.routes | — |
| GET `/forms` | 🔑 | List visible forms | forms.routes | — |
| POST `/forms` | 🔑 | Upload (multipart `file`) | forms.routes | (multipart fields) |
| GET `/forms/:id/download` | 🔑 | Download (visibility-checked) | forms.routes | — |
| DELETE `/forms/:id` | 🔐`forms.delete` | Delete (uploader or `forms.delete` permission) | forms.routes | — |
| GET `/messages?box=` | 🔑 | Inbox or sent | messages.routes | — |
| GET `/messages/unread-count` | 🔑 | Unread badge count | messages.routes | — |
| POST `/messages` | 🔑 | Send message | messages.routes | sendMessageSchema |
| POST `/messages/:id/read` | 🔑 | Mark read | messages.routes | — |
| DELETE `/messages/:id` | 🔑 | Delete (sender/recipient) | messages.routes | — |
| GET/POST `/notes`, PUT/DELETE `/notes/:id` | 🔑 | Per-user notes CRUD (scoped to caller) | personal.routes | noteSchema |
| GET/POST `/tasks`, PUT/DELETE `/tasks/:id` | 🔑 | Per-user tasks CRUD (scoped to caller) | personal.routes | taskSchema / updateTaskSchema |
| GET/POST `/bookmarks`, DELETE `/bookmarks/:id` | 🔑 | Per-user bookmarks (scoped to caller) | personal.routes | bookmarkSchema |
| GET `/orders?type=&q=`, GET `/orders/:id` | 🔑 (no permission check at all — any logged-in user) | List / detail (+items). **Known bug:** the `type` filter only matches `'sale'`/`'job'`; `?type=purchase` silently returns orders of *all* types unfiltered | orders.routes | — |
| POST `/orders`, PUT `/orders/:id`, DELETE `/orders/:id` | 🔑 | Create (auto number)/update/delete; totals computed server-side; type `sale\|job\|purchase` | orders.routes | create/updateOrderSchema |
| GET `/templates?type=`, GET `/templates/:id` | 🔑 | List / detail document templates | templates.routes | — |
| GET `/templates/variables/catalog` | 🔑 | Bindable data-source fields (`DATA_SOURCE_CATALOG`) for the variable builder | templates.routes | — |
| GET `/templates/variables?template_id=` | 🔑 | Global `doc_variables` + a template's local ones | templates.routes | — |
| POST `/templates/variables` | 🔐`templates.edit` | Create a `doc_variables` row (409 on duplicate key in scope) | templates.routes | docVariableSchema |
| PUT `/templates/variables/:id` | 🔐`templates.edit` | Update a `doc_variables` row (key/scope fixed) | templates.routes | docVariableSchema |
| DELETE `/templates/variables/:id` | 🔐`templates.edit` | Delete a `doc_variables` row | templates.routes | — |
| GET `/form-definitions`, GET `/form-definitions/:id` | 🔑 | List / detail custom form types (fields parsed from JSON) | form-builder.routes | — |
| POST `/form-definitions` | 🔐`forms.manage` | Create form definition | form-builder.routes | formDefinitionSchema |
| PUT `/form-definitions/:id` | 🔐`forms.manage` | Update form definition (name/slug/prefix/icon/fields) | form-builder.routes | formDefinitionSchema |
| DELETE `/form-definitions/:id` | 🔐`forms.manage` | Delete form + cascade records | form-builder.routes | — |
| GET `/form-definitions/:id/records` | 🔑 | List records for a form (`?q=`, `?status=`) | form-builder.routes | — |
| GET `/form-definitions/:id/periods` | 🔑 | Distinct `period` labels already used by this form's records (feeds the period filter in Form Records) | form-builder.routes | — |
| GET `/form-records/:id` | 🔑 | Single record (data parsed, includes form_name) | form-builder.routes | — |
| POST `/form-records` | 🔑 | Create record (auto-numbered per form) | form-builder.routes | createFormRecordSchema |
| PUT `/form-records/:id` | 🔑 | Update record data + status | form-builder.routes | updateFormRecordSchema |
| DELETE `/form-records/:id` | 🔑 | Delete record | form-builder.routes | — |
| GET `/global-variables` | 🔑 | List all global variables | form-builder.routes | — |
| PUT `/global-variables/:key` | 🔐`forms.manage` | Upsert a global variable | form-builder.routes | globalVariableSchema |
| DELETE `/global-variables/:key` | 🔐`forms.manage` | Delete a global variable | form-builder.routes | — |
| POST `/form-definitions/:id/import` | 🔑 (no extra permission check — see gotcha) | Bulk-create records from the payroll "Summary" CSV; requires `period` in the body, 400 unless form slug is `hr_payroll` | form-builder.routes | (multer `file` + required `period` + optional `pay_date`, parsed by `hr-payroll-import.ts`) |
| POST/PUT/DELETE `/templates(/:id)` | 🔐`templates.edit` | Manage templates | templates.routes | templateSchema |
| GET `/templates/company` · PUT `/templates/company` | 🔑 · 🔐`templates.company` | Company profile for `{{company.*}}` | templates.routes | companyProfileSchema |
| GET `/hr/employees` | 🔐`hr.view` | List employees (`?q=`, `?department_id=`, `?status=`) | hr.routes | — |
| POST `/hr/employees`, PUT `/hr/employees/:id` | 🔐`hr.manage` | Create (auto `employee_no`)/update an employee | hr.routes | employeeSchema |
| DELETE `/hr/employees/:id` | 🔐`hr.manage` | Delete (409 if attendance history exists — set status instead) | hr.routes | — |
| GET `/hr/employees/:id/documents` | 🔐`hr.view` | List 201-file documents for an employee | hr.routes | — |
| POST `/hr/employees/:id/documents` | 🔐`hr.manage` | Upload a document (multipart `file` + `title`) | hr.routes | (multipart) |
| GET `/hr/employees/:id/documents/:docId/download` | 🔐`hr.view` | Download a document | hr.routes | — |
| DELETE `/hr/employees/:id/documents/:docId` | 🔐`hr.manage` | Delete a document | hr.routes | — |
| GET `/hr/periods` | 🔐`hr.view` | List cutoffs (+ `employee_count`) | hr.routes | — |
| GET `/hr/periods/:id` | 🔐`hr.view` | Cutoff header + roster (`days_logged`/`days_total` per employee) | hr.routes | — |
| POST `/hr/periods` | 🔐`hr.manage` | Create a cutoff | hr.routes | attendancePeriodSchema |
| PUT `/hr/periods/:id` | 🔐`hr.manage` | Update label/dates; extends day-rows to cover a widened range | hr.routes | attendancePeriodSchema |
| DELETE `/hr/periods/:id` | 🔐`hr.manage` | Delete cutoff + cascade attendance | hr.routes | — |
| POST `/hr/periods/:id/employees` | 🔐`hr.manage` | Add an employee to the roster (pre-creates blank day rows) | hr.routes | addRosterEmployeeSchema |
| DELETE `/hr/periods/:id/employees/:employeeId` | 🔐`hr.manage` | Remove an employee from the roster | hr.routes | — |
| GET `/hr/periods/:id/attendance?employee_id=` | 🔐`hr.view` | One employee's daily rows for this cutoff | hr.routes | — |
| PUT `/hr/periods/:id/attendance` | 🔐`hr.manage` | Replace one employee's daily rows (time-in/out/notes) | hr.routes | saveAttendanceSchema |
| POST `/hr/periods/:id/generate-payslips` | 🔐`hr.manage` | Create/update one `hr_payroll` record per roster employee (identity/rate/period only; hours left blank for manual entry) | hr.routes | generatePayslipsSchema |
| GET `/health` | 🔓 | Liveness check | app.ts | — |

---

## 5. Conventions (follow these to keep the code consistent)

- **DB access:** always go through `queryOne<T>` / `queryAll<T>` / `run` from `src/db.ts`.
  Don't call `db.prepare(...)` directly in routes (the helpers centralize the typed cast).
  Use `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` only for multi-statement transactions
  (see the inventory `adjust` handler).
- **Validation:** every request body is parsed with `parseBody(schema, req.body)`. Add new
  rules as a schema in `src/validation.ts`, never inline in a route.
- **Types:** shared row/response shapes live in `src/types.ts`. Reuse them; don't redefine.
- **Auth:** routers call `router.use(requireAuth)`; feature-gated handlers add
  `requirePermission('permission.key')` from `src/auth.ts` (preferred over the older
  `requireRole('admin')`). Read the caller via `req.user!`. Frontend checks use
  `App.hasPermission('key')`. The permission list lives in `src/permissions.ts`; the sparse
  per-user overrides are stored in `users.permission_overrides` (JSON) and resolved on every
  request in `userFromToken()`.
- **Errors:** return `res.status(n).json({ error: 'message' })`. Thrown `ValidationError`
  (or anything with a numeric `status`) is shaped by the central handler in `app.ts`.
- **Frontend:** views register with `App.register('name', async (view, filter) => {...})` and
  reuse `API`, `UI.modal`, `UI.toast`, `UI.esc`. Always `UI.esc()` user data before inserting
  HTML. The optional `filter` arg comes from the nav tree leaf (deep-link); honor it via the
  view's existing internal state, never duplicate behavior.
- **Navigation:** the chrome (top primary menu, sub-tabs, left tree, site map, menu search) is
  generated entirely from **`NAV` in `public/js/nav-config.js`** — the single source of truth.
  To add/move a destination, edit `NAV` (a leaf = `{label, icon, route, filter?}`); every
  `route` must be a registered view (`ROUTE_NAMES`, enforced by `tests/frontend-nav.test.ts`).
  Do **not** hand-wire nav buttons in `index.html`. Navigate programmatically via
  `App.navigate(route, filter?)`.
- **Icons:** use `UI.icon('name')` (inline SVG, inherits text color) — do not add emoji or
  icon fonts. Add new glyphs to the `ICONS` map in `ui.js`.
- **Theming:** all colors come from CSS variables defined in `public/css/styles.css` under
  `:root`/`[data-theme='light']` (light) and `[data-theme='dark']` (dark). **Never hard-code
  a hex color in a component** — add or reuse a token (`--surface`, `--text`, `--accent`, …)
  so both themes stay correct. The active theme is the `data-theme` attribute on `<html>`,
  set pre-paint by an inline script in `index.html` and toggled via the right icon rail button.
  Empty tab states use `UI.emptyState(...)`.

---

## 6. "How to add X" recipes

**A new API endpoint**
1. Add a zod schema in `src/validation.ts` (if it takes a body).
2. Add the handler to the relevant `src/routes/*.routes.ts`, using `queryOne/queryAll/run`.
3. Add the row/response type to `src/types.ts` if new.
4. Add a test in the matching `tests/*.test.ts`.
5. **Add the row to the API catalog (§4) in this file.**

**A new item field (the common case — no DB change)**
1. Add a field def to `ITEM_FORM_DEFAULTS` in `public/js/item-form-config.js` (pick a `tab`,
   `type`, `default`; leave `core` off). It persists automatically into the `attributes` JSON —
   **no migration, schema, or route change.** Admins can show/hide it via the modal's Option panel.
2. To surface it in the table or filters, read `item.attributes.<key>` in `inventory.js`.

**A new *core* item column (only when it needs its own column — e.g. for SQL filtering)**
1. Add the column to `inventory_items` in `src/db.ts` (and an `ALTER` in `migrate()` for old DBs).
2. Extend `createItemSchema` / `updateItemSchema` and the INSERT/UPDATE in `inventory.routes.ts`.
3. Add the field to `InventoryItem` in `src/types.ts` and add `core: true` + the key to
   `ITEM_CORE_KEYS` in `item-form-config.js`.
4. Update §3 here. (`tests/item-form-config.test.ts` enforces core keys ↔ real columns.)

**A new document/template variable**
1. Add the field to the render context built in `printOrder`/`buildContext`
   ([public/js/views/orders.js](public/js/views/orders.js)) and to the editor `SAMPLE`
   ([public/js/views/templates.js](public/js/views/templates.js)).
2. List it in `ORDER_VARIABLES` ([public/js/doc-template.js](public/js/doc-template.js)) so it
   shows in the palette. Templates reference it as `{{group.key}}` (or `{{key}}` inside `{{#items}}`).

**A new frontend view/page**
1. Create `public/js/views/<name>.js` calling `App.register('<name>', (view, filter) => …)`.
2. Add `<name>` to `ROUTE_NAMES` and add a leaf (and primary/subtab if needed) in
   `public/js/nav-config.js` — do **not** hand-add a button to `index.html`.
3. Add a `<script>` tag for the file in `public/index.html`.
4. Update the frontend map in §2. (`tests/frontend-nav.test.ts` will fail if a leaf points
   to an unregistered route.)

---

## 7. Running, testing, building

| Command | What it does |
|---|---|
| `npm start` | Run the server via `tsx server.ts` (port 3000). |
| `npm run dev` | Same, with file-watch reload. |
| `npm run typecheck` | `tsc --noEmit` strict type check (no errors allowed). |
| `npm test` | Run the whole Vitest suite once, headless. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run check` | typecheck **and** test (use before every commit). |

Tests need no setup: each test file creates its own throwaway SQLite DB + uploads dir via
`setupApp()` and removes them after. See `tests/helpers.ts`.

See also **[DECISIONS.md](DECISIONS.md)** for why these tools were chosen.
