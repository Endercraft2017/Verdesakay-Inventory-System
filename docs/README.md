# Documentation Index

Start here. This folder has two layers:

- **Concept docs** (root of `docs/`) — how the system is organized, why it's built this way,
  and how the AI assistant feature works.
- **[`reference/`](reference/)** — one detailed markdown file **per source file**, covering
  its purpose, every exported function/route, who calls it, and any gotchas. Open these when
  you're about to change or extend a specific file.

## Concept docs

| File | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **The map.** System overview, roles/permissions model, one-line-per-file directory map, full DB schema, full API catalog, coding conventions, "how to add X" recipes, run/test commands. Read this first. |
| [AI-AGENT.md](AI-AGENT.md) | The AI Assistant feature: agentic loop, tool catalogue, permission gating, Cerebras integration, how to add a new AI tool. |
| [EMAIL-SETUP.md](EMAIL-SETUP.md) | **Admin how-to** for turning on email: the BYO-SMTP settings fields, a per-provider quick reference (Gmail, M365, Brevo, …), the "I have a domain name" cases, and troubleshooting. |
| [SAAS-READINESS.md](SAAS-READINESS.md) | Assessment of what it takes to run this as a multi-tenant SaaS: database-per-tenant vs shared schema, a table-by-table schema sweep, the connection-singleton blocker, control-plane tables, and a phased plan. |
| [GO-TO-MARKET.md](GO-TO-MARKET.md) | Who to sell to and at what price (PH upper-SMB / low-mid-market first), the positioning vs ECOUNT / Sprout / Dynamics, the feature pillars that close deals, and a prioritized list of what to build/harden vs what can wait. |
| [PH-PAYROLL-COMPLIANCE.md](PH-PAYROLL-COMPLIANCE.md) | Current (2026) SSS / PhilHealth / Pag-IBIG / withholding-tax figures, the BIR & agency outputs a customer must file (2316, 1601-C, 1604-C, Alphalist, R-3, RF-1, MCRF), and the phased plan to build the statutory payroll engine. |
| [guides/](guides/) | **User-facing how-tos** — plain-language, task-focused guides for training staff on each feature. One per feature, added when the feature ships. |
| [DECISIONS.md](DECISIONS.md) | Why the stack is what it is (TypeScript, `tsx`, `node:sqlite`, `zod`, `vitest`, etc.) — the reasoning behind big choices, not a changelog. |

## Reference docs (per source file)

### Backend — core (`docs/reference/backend/`)

| Source file | Doc |
|---|---|
| `server.ts` | [server.md](reference/backend/server.md) |
| `src/app.ts` | [app.md](reference/backend/app.md) |
| `src/db.ts` | [db.md](reference/backend/db.md) |
| `src/auth.ts` | [auth.md](reference/backend/auth.md) |
| `src/permissions.ts` | [permissions.md](reference/backend/permissions.md) |
| `src/types.ts` | [types.md](reference/backend/types.md) |
| `src/validation.ts` | [validation.md](reference/backend/validation.md) |
| `src/doc-catalog.ts` | [doc-catalog.md](reference/backend/doc-catalog.md) |
| `src/ai-tools.ts` | [ai-tools.md](reference/backend/ai-tools.md) |
| `src/hr-payroll-import.ts` | [hr-payroll-import.md](reference/backend/hr-payroll-import.md) |

### Backend — routes (`docs/reference/backend/routes/`)

| Source file | Doc |
|---|---|
| `src/routes/auth.routes.ts` | [auth.routes.md](reference/backend/routes/auth.routes.md) |
| `src/routes/users.routes.ts` | [users.routes.md](reference/backend/routes/users.routes.md) |
| `src/routes/inventory.routes.ts` | [inventory.routes.md](reference/backend/routes/inventory.routes.md) |
| `src/routes/forms.routes.ts` | [forms.routes.md](reference/backend/routes/forms.routes.md) |
| `src/routes/messages.routes.ts` | [messages.routes.md](reference/backend/routes/messages.routes.md) |
| `src/routes/personal.routes.ts` | [personal.routes.md](reference/backend/routes/personal.routes.md) |
| `src/routes/orders.routes.ts` | [orders.routes.md](reference/backend/routes/orders.routes.md) |
| `src/routes/templates.routes.ts` | [templates.routes.md](reference/backend/routes/templates.routes.md) |
| `src/routes/form-builder.routes.ts` | [form-builder.routes.md](reference/backend/routes/form-builder.routes.md) |
| `src/routes/hr.routes.ts` | [hr.routes.md](reference/backend/routes/hr.routes.md) |
| `src/routes/ai.routes.ts` | [ai.routes.md](reference/backend/routes/ai.routes.md) |

### Frontend — core libraries (`docs/reference/frontend/`)

| Source file | Doc |
|---|---|
| `public/js/api.js` | [api.md](reference/frontend/api.md) |
| `public/js/ui.js` | [ui.md](reference/frontend/ui.md) |
| `public/js/app.js` | [app.md](reference/frontend/app.md) |
| `public/js/tools.js` | [tools.md](reference/frontend/tools.md) |
| `public/js/nav-config.js` | [nav-config.md](reference/frontend/nav-config.md) |
| `public/js/item-form-config.js` | [item-form-config.md](reference/frontend/item-form-config.md) |
| `public/js/doc-template.js` | [doc-template.md](reference/frontend/doc-template.md) |
| `public/js/doc-editor.js` | [doc-editor.md](reference/frontend/doc-editor.md) |
| `public/js/doc-context.js` | [doc-context.md](reference/frontend/doc-context.md) |
| `public/js/doc-formula.js` | [doc-formula.md](reference/frontend/doc-formula.md) |
| `public/js/hr-payroll-print.js` | [hr-payroll-print.md](reference/frontend/hr-payroll-print.md) |

### Frontend — views (`docs/reference/frontend/views/`)

| Source file | Doc |
|---|---|
| `public/js/views/dashboard.js` | [dashboard.md](reference/frontend/views/dashboard.md) |
| `public/js/views/inventory.js` | [inventory.md](reference/frontend/views/inventory.md) |
| `public/js/views/forms.js` | [forms.md](reference/frontend/views/forms.md) |
| `public/js/views/orders.js` | [orders.md](reference/frontend/views/orders.md) |
| `public/js/views/messages.js` | [messages.md](reference/frontend/views/messages.md) |
| `public/js/views/form-builder.js` | [form-builder.md](reference/frontend/views/form-builder.md) |
| `public/js/views/form-records.js` | [form-records.md](reference/frontend/views/form-records.md) |
| `public/js/views/templates.js` | [templates.md](reference/frontend/views/templates.md) |
| `public/js/views/admin.js` | [admin.md](reference/frontend/views/admin.md) |
| `public/js/views/account.js` | [account.md](reference/frontend/views/account.md) |
| `public/js/views/hr.js` | [hr.md](reference/frontend/views/hr.md) |
| `public/js/views/hr-employees.js` | [hr-employees.md](reference/frontend/views/hr-employees.md) |
| `public/js/views/hr-timekeeping.js` | [hr-timekeeping.md](reference/frontend/views/hr-timekeeping.md) |

### Tests

| | Doc |
|---|---|
| `tests/*.test.ts` + `tests/helpers.ts` | [tests.md](reference/tests.md) — one table per test file, what it covers |

## How to use this

- **Changing existing behavior?** Open the reference doc for the file you're touching first —
  it lists every export, every caller, and known gotchas so you don't break something else.
- **Adding something new?** Check [ARCHITECTURE.md §6 "How to add X"](ARCHITECTURE.md#6-how-to-add-x-recipes)
  for the recipe, then use the reference docs to find the right file to extend.
- **Keep it in sync.** `ARCHITECTURE.md` says to update it in the same commit as a code change;
  the same applies here — if you add/rename/remove a file or change its public API, update (or
  add) its `reference/` doc in the same commit.
