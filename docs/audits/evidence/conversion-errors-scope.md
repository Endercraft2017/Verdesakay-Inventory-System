# Conversion error boundary — 19 October 2026

Base: 9782b527d9f01809bfb466c6df1e53f0b09f3252, production.

Moderate scoped finding: authenticated document editors could receive dependency exception
messages from import/export catch blocks as 400 JSON. This bypassed the existing generic
500 response wrapper. No exploit of server secrets or cross-tenant access was demonstrated.

Resolution: DocumentInputError identifies authored limit/format feedback. Unreadable imports
receive generic 400 feedback; unexpected exports forward a fresh generic exception to the
central 500 handler, discarding untrusted status/expose/message properties. Responses include
server-generated request IDs. Injected synthetic sensitive paths never appear in export logs
or client responses. Original document editing, storage and conversion success behavior is
unchanged. This is not an app-wide typed error contract or incident diagnosis system.

Research accessed 19 October 2026:
https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
OWASP recommends generic unexpected-error responses and server-side correlation. The local
implementation records safe event metadata; raw dependency messages are deliberately omitted
because they can contain user content or provider data. Richer protected diagnostics remain
an operational design task.

Remaining API-06 review queue:
- src/platform/support.routes.ts: add/reply catches stringify both Zod and database failures.
- src/platform/platform.routes.ts: owner details/support/module-related catch blocks mix domain,
  validation and storage failures; must retain useful public validation without exposing storage.
- src/modules/inventory/suppliers.routes.ts and src/modules/hr/hr.routes.ts: CSV parser catches.
- src/app.ts central handler: arbitrary numeric status/expose properties and 503 exclusions.
These are source-review leads, not claims that every path leaks secrets. Inject each failure,
classify deliberate business errors and verify clients before changing status semantics.

The mobile recovery test exposed a fixed-delay rendering race under the initial full run.
Focused unchanged rerun passed; its waits now use existing bounded element polling for editor,
retry and confirmed states. No mobile runtime assets changed. Preserve the initial full-run
failure alongside final verification rather than reporting it as an uninterrupted pass.
