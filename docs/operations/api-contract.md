# API compatibility and inventory

The current protocol is the existing `/api` REST interface. Desktop, mobile and installed-PC
sync clients share it. There is no complete OpenAPI specification yet; the per-module references
in `docs/reference/backend/` and registered-route security regression test are the current
inventory. Do not describe that inventory as a complete machine-readable contract.

Preserve field meaning and existing routes when adding features. Validate writes on the server;
never rely on UI permissions. Additive fields must not expose credentials or personal data to
new readers. For incompatible changes, introduce an explicitly versioned route, support old
installed clients through a documented migration period, and obtain an owner-approved retirement
date before removing the old route. The release checklist must identify affected offline clients,
rollback limitations and database migration requirements.

Before claiming contract completeness, generate an OpenAPI inventory from actual registrations,
attach real request/response schemas and permission requirements, and validate it against route
coverage. Do not manufacture permissive schemas merely to reach a documentation percentage.

## Creation retries (19 October 2026)

POST /api/signup and authenticated POST /_platform/api/tenants optionally accept an
Idempotency-Key UUID v4. The updated forms send one random key per page/modal and reuse it on
retry. Same scope/key/parsed body returns the original completed 201 with Idempotency-Replayed:
true for 24 hours, behind the current route gates. Different details, expired keys or unavailable
workspaces return 409; invalid key format returns 400. Errors are not cached. No-key clients
retain the existing behavior and must reconcile uncertain acknowledgements before creating again.
This is not a general API idempotency/OpenAPI completeness claim. The full storage, password
verifier, competing-writer, retention and recovery contract is in workspace-onboarding.md.
