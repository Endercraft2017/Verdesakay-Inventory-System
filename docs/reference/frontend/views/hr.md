# `public/js/views/hr.js`

## Purpose
HR module launcher: a card grid linking to the four HR sub-areas (Payroll, Employees, Time Keeping, Leave Management). Purely a navigation hub — no data tables or forms of its own. Reached via the `hr` nav destination (top-level HR menu).

## Registered route(s)
```js
App.register('hr', async (view) => { ... })
```
No `filter` handling — this view has no state that could be deep-linked into.

## Structure / key functions
- **`MODULES`** — array of 4 card descriptors `{ icon, title, hint, action }`:
  - **Payroll** → `openPayroll()`.
  - **Employees** → `App.navigate('hr-employees')`.
  - **Time Keeping** → `App.navigate('hr-timekeeping')`.
  - **Leave Management** → `action: null` (renders a "Coming soon" badge instead of being clickable; not wired to any route).
- **`openPayroll()`** *(async)* — looks up the auto-seeded `hr_payroll` form definition via `GET /form-definitions` (finds the one with `slug === 'hr_payroll'`), then `App.navigate('form-records', { form_id: hrPayroll.id })` to jump straight into that form's records list. Falls back to `App.navigate('form-records')` (the form index grid) if the lookup fails or the form isn't found — this can't normally happen since `seedHrPayrollForm()` guarantees it exists, but the fallback covers a fresh DB where seeding hasn't run yet.
- Card click wiring: iterates rendered `[data-mod]` elements, attaches `card.onclick = m.action` only when `m.action` is truthy (Leave Management's card stays inert).

## API endpoints used
- `GET /form-definitions` — used solely to resolve the `hr_payroll` form's id for the Payroll card's deep link.

## Permissions honored
None directly in this file. Note that downstream routes it links to are permission-gated themselves (`hr-employees`/`hr-timekeeping` check `hr.view`/`hr.manage` server-side via `/api/hr/*`, and `form-records` for a form a user can't see would simply come back empty/error) — this launcher does not pre-filter its cards by `App.hasPermission`, so a user without HR access still sees all four cards and would hit permission errors deeper in the flow rather than at this screen.

## Dependencies
- `App.register`, `App.navigate`.
- `API.get`.
- `UI` (`icon`, `esc`).

## Notes / gotchas
- This view does not gate itself on `hr.view`/`hr.manage` the way `hr-employees.js`/`hr-timekeeping.js` implicitly rely on server-side permission checks — anyone who can reach the `hr` nav item sees the launcher grid regardless of role. If the nav tree (`nav-config.js`) doesn't already restrict who sees the `hr` primary/subtab entry, that's the actual gate; this file adds none of its own.
- "Leave Management" is a static placeholder; adding it later means giving it an `action` here (route via `App.navigate`) plus registering the corresponding view/route elsewhere, per the "new frontend view" recipe in `docs/ARCHITECTURE.md` §6.
