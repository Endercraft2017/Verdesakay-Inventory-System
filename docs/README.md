# Documentation Index

Start here. This folder has two layers:

- **Concept docs** (root of `docs/`) — how the system is organized, why it's built this way,
  and how the AI assistant feature works.
- **[`reference/`](reference/)** — one detailed markdown file **per source file**, covering
  its purpose, every exported function/route, who calls it, and any gotchas. Open these when
  you're about to change or extend a specific file.

## Production audit

- [Current engineering handoff and owner steps](audits/engineering-handoff.md)
- [Recent tenant administrative verification](operations/tenant-step-up.md)
- [Second audit and unresolved release gates](audits/second-pass-audit.md)
- [All 233 handbook controls](audits/production-scorecard.md)
- [Validation evidence and limits](audits/validation-results.md)
- [Owner actions](OWNER-ACTIONS.md)
- [Public policy drafts](policies/README.md), [B2B contract templates](governance/contracts.md),
  [data governance](governance/data-governance.md), [security program](governance/security-program.md),
  [operating runbooks](operations/runbooks.md), [incident response](operations/incidents.md),
  [release checklist](operations/release-checklist.md) and [API compatibility](operations/api-contract.md).

## Concept docs

| File | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **The map.** System overview, roles/permissions model, one-line-per-file directory map, full DB schema, full API catalog, coding conventions, "how to add X" recipes, run/test commands. Read this first. |
| [AI-AGENT.md](AI-AGENT.md) | The AI Assistant feature: agentic loop, tool catalogue, permission gating, Cerebras integration, how to add a new AI tool. |
| [EMAIL-SETUP.md](EMAIL-SETUP.md) | **Admin how-to** for turning on email: the BYO-SMTP settings fields, a per-provider quick reference (Gmail, M365, Brevo, …), the "I have a domain name" cases, and troubleshooting. |
| [SAAS-READINESS.md](SAAS-READINESS.md) | Assessment + phased plan for running this as a multi-tenant SaaS: database-per-tenant, the schema sweep, control-plane tables. Phases 1–2 landed. |
| [SAAS-OPERATIONS.md](SAAS-OPERATIONS.md) | **Operator guide** for multi-tenant mode: the env vars (`APP_DOMAIN`, `PLATFORM_DB_PATH`, …), tenant resolution, provisioning via `npm run tenant:*`, self-serve sign-up, per-tenant backups. |
| [GO-TO-MARKET.md](GO-TO-MARKET.md) | Who to sell to and at what price (PH upper-SMB / low-mid-market first), the positioning vs ECOUNT / Sprout / Dynamics, the feature pillars that close deals, and a prioritized list of what to build/harden vs what can wait. |
| [PH-PAYROLL-COMPLIANCE.md](PH-PAYROLL-COMPLIANCE.md) | Current (2026) SSS / PhilHealth / Pag-IBIG / withholding-tax figures, the BIR & agency outputs a customer must file (2316, 1601-C, 1604-C, Alphalist, R-3, RF-1, MCRF), and the phased plan to build the statutory payroll engine. |
| [ACCOUNTING-SYSTEM-PLAN.md](ACCOUNTING-SYSTEM-PLAN.md) | Research-backed plan for a full double-entry accounting module (chart of accounts, GL, journals, AR/AP, VAT/EWT registers, PFRS-for-SMEs financial statements, BIR books of accounts / CAS). Today's "Accounting" section is tax reporting only; this is the roadmap to a real ledger. |
| [guides/](guides/) | **User-facing how-tos** — plain-language, task-focused guides for training staff on each feature. One per feature, added when the feature ships. |
| [OWNER-ACTIONS.md](OWNER-ACTIONS.md) | **Owner checklist** — the setup and security tasks only the owner can do (phone, password manager, Cloudflare/Backblaze/Railway dashboards), each with why, steps and how to tell it worked. |
| [DECISIONS.md](DECISIONS.md) | Why the stack is what it is (TypeScript, `tsx`, `node:sqlite`, `zod`, `vitest`, etc.) — the reasoning behind big choices, not a changelog. |

## Reference docs (per source file)

Backend docs mirror `src/`'s `shared/` / `platform/` / `core/` / `modules/<name>/`
layout (see [modules/catalog.md](modules/catalog.md) for what each owns); frontend
view docs mirror `public/js/modules/<name>/` the same way. Not every source file has
a doc yet — this table only lists ones that exist.

### Backend — top level (`docs/reference/backend/`)

| Source file | Doc |
|---|---|
| `server.ts` | [server.md](reference/backend/server.md) |
| `src/app.ts` | [app.md](reference/backend/app.md) |

### Backend — shared (`docs/reference/backend/shared/`)

| Source file | Doc |
|---|---|
| `src/shared/db.ts` | [db.md](reference/backend/shared/db.md) |
| `src/shared/auth.ts` | [auth.md](reference/backend/shared/auth.md) |
| `src/shared/permissions.ts` | [permissions.md](reference/backend/shared/permissions.md) |
| `src/shared/types.ts` | [types.md](reference/backend/shared/types.md) |
| `src/shared/validation.ts` | [validation.md](reference/backend/shared/validation.md) |

### Backend — core (`docs/reference/backend/core/`)

| Source file | Doc |
|---|---|
| `src/core/doc-catalog.ts` | [doc-catalog.md](reference/backend/core/doc-catalog.md) |
| `src/core/auth.routes.ts` | [auth.routes.md](reference/backend/core/auth.routes.md) |
| `src/core/users.routes.ts` | [users.routes.md](reference/backend/core/users.routes.md) |
| `src/core/forms.routes.ts` | [forms.routes.md](reference/backend/core/forms.routes.md) |
| `src/core/messages.routes.ts` | [messages.routes.md](reference/backend/core/messages.routes.md) |
| `src/core/personal.routes.ts` | [personal.routes.md](reference/backend/core/personal.routes.md) |
| `src/core/templates.routes.ts` | [templates.routes.md](reference/backend/core/templates.routes.md) |
| `src/core/form-builder.routes.ts` | [form-builder.routes.md](reference/backend/core/form-builder.routes.md) |

### Backend — modules (`docs/reference/backend/modules/<name>/`)

| Source file | Doc |
|---|---|
| `src/modules/inventory/inventory.routes.ts` | [inventory.routes.md](reference/backend/modules/inventory/inventory.routes.md) |
| `src/modules/inventory/orders.routes.ts` | [orders.routes.md](reference/backend/modules/inventory/orders.routes.md) |
| `src/modules/hr/hr.routes.ts` | [hr.routes.md](reference/backend/modules/hr/hr.routes.md) |
| `src/modules/payroll/hr-payroll-import.ts` | [hr-payroll-import.md](reference/backend/modules/payroll/hr-payroll-import.md) |
| `src/modules/ai/ai-tools.ts` | [ai-tools.md](reference/backend/modules/ai/ai-tools.md) |
| `src/modules/ai/ai.routes.ts` | [ai.routes.md](reference/backend/modules/ai/ai.routes.md) |

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

### Frontend — modules (`docs/reference/frontend/modules/<name>/`)

| Source file | Doc |
|---|---|
| `public/js/modules/core/dashboard.js` | [dashboard.md](reference/frontend/modules/core/dashboard.md) |
| `public/js/modules/core/forms.js` | [forms.md](reference/frontend/modules/core/forms.md) |
| `public/js/modules/core/messages.js` | [messages.md](reference/frontend/modules/core/messages.md) |
| `public/js/modules/core/form-builder.js` | [form-builder.md](reference/frontend/modules/core/form-builder.md) |
| `public/js/modules/core/form-records.js` | [form-records.md](reference/frontend/modules/core/form-records.md) |
| `public/js/modules/core/templates.js` | [templates.md](reference/frontend/modules/core/templates.md) |
| `public/js/modules/core/admin.js` | [admin.md](reference/frontend/modules/core/admin.md) |
| `public/js/modules/core/account.js` | [account.md](reference/frontend/modules/core/account.md) |
| `public/js/modules/inventory/inventory.js` | [inventory.md](reference/frontend/modules/inventory/inventory.md) |
| `public/js/modules/inventory/orders.js` | [orders.md](reference/frontend/modules/inventory/orders.md) |
| `public/js/modules/hr/hr.js` | [hr.md](reference/frontend/modules/hr/hr.md) |
| `public/js/modules/hr/hr-employees.js` | [hr-employees.md](reference/frontend/modules/hr/hr-employees.md) |
| `public/js/modules/hr/hr-timekeeping.js` | [hr-timekeeping.md](reference/frontend/modules/hr/hr-timekeeping.md) |

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
