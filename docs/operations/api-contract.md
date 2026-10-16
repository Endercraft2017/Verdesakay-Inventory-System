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
