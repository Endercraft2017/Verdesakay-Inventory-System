# CLAUDE.md

Follow the module architecture and reuse workflow in the global `~/.claude/CLAUDE.md`. The module
catalog is `docs/modules/catalog.md` and the pipeline map is `docs/modules/pipelines.md`; read the
relevant records before changing code and update them after.

## Stack and commands

- Node + Express + TypeScript (`tsx`), SQLite via `node:sqlite`, vanilla JS frontends
  (`public/js/` desktop, `public/mobile/` PWA). Tests: Vitest + supertest + jsdom.
- `npm run typecheck` · `npm test` (full suite, ~8 min) · `npx vitest run tests/<file>` ·
  `npm run db:types` after any schema change.
- New tables can go in `createSchema()` (always re-run, `IF NOT EXISTS`); column changes need a
  `migrate()` step plus a `SCHEMA_VERSION` bump.

## Mobile Figma implementation

The active mobile redesign is implemented incrementally on this branch. Before changing anything under `public/mobile/`, read:

- `docs/guides/Verdesakay_Mobile_Claude_Code_Handoff.md`
- `docs/guides/mobile-role-ux-spec.md`
- `docs/guides/shop-floor-to-delivery-sop.md`
- `docs/modules/catalog.md`
- `docs/modules/pipelines.md`

Canonical Figma file:

https://www.figma.com/design/quipCMr7ChPNSYpzFQCM50

Use exact node IDs from the handoff. Retrieve each node's screenshot and design context individually. The shared board `46:515` is too large for one accurate extraction; shared Home is `46:519`.

## Project constraints

- The mobile app is vanilla HTML/CSS/JavaScript, not React.
- Do not add Tailwind or paste Figma's generated React/Tailwind output.
- Translate designs into the existing `MApp.route` architecture and reusable factories under `public/mobile/lib/`.
- Reuse the current API client, scanner, photo, location, signature, queue, push, and DOM helpers.
- The persistent dock is Home, Work, Clock, Inbox, Profile for every employee.
- Clock is universal. Scan and role operations belong to Work or Quick Orbit.
- UI visibility never replaces backend permission enforcement.
- Never show an offline-queued stock/stage action as server-confirmed.
- Keep private phone numbers and unnecessary personal data out of operational screens.
- Final stock and stage transitions are online-only, atomic, auditable, and idempotent.

## Current V2 foundation

- `public/mobile/mobile-v2.css`: design tokens and V2 shell overrides.
- `public/mobile/lib/quick-orbit.js`: movable, edge-snapping universal and role-aware actions.
- `public/mobile/modules/core/notifications.js`: current employee activity adapter.
- `public/mobile/app.js`: stable navigation and route ownership.
- `public/mobile/sw.js`: V2 shell precache. Bump the cache version for every shell asset change.

The Notifications route currently composes existing employee-scoped APIs. Do not mistake it for a durable notification ledger. A future backend notification feed may replace its loader while preserving the route/UI contract.

## Required workflow

1. Inspect the current route, backend endpoint, permission gate, validation schema, and tests.
2. Retrieve the exact Figma node and screenshot.
3. Reuse or extend shared mobile primitives before adding screen-specific markup.
4. Implement all relevant loading, empty, error, offline/draft, conflict, submitting, blocked, and completion states.
5. Add focused tests and keep `tests/frontend-mobile.test.ts` route inventory current.
6. Bump the service-worker cache version and shell list when assets change.
7. Run `npm run typecheck`, focused Vitest tests, then `npm test`.
8. Render at 390×844 and compare with the Figma screenshot.

Do not describe planned behavior as implemented. Record unresolved backend/design dependencies explicitly.
