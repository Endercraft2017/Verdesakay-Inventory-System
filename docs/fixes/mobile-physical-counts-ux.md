# Mobile physical count views

Chunk 26 implements the approved history, exact-position picker, recording form, independent review and saved-attempt views. It retains the existing rounded cards, pill buttons, inventory header and navigation. The existing barcode/QR picker and camera/manual scanner remain in use.

History combines search over the latest loaded records with lifecycle filtering. Cards separate item/shelf identity, state, found quantity and difference. Empty results and unavailable reads have distinct messages. Only authorized counters see recording controls.

The picker verifies current item metadata before enabling the snapshot action. Build state is shown for finished products; new part counts use standard stock. Snapshot loading locks immediately. Existing assignments retain their task, item, location and build identity. Old drafts retain their original snapshot and scanned evidence; metadata is refreshed independently when absent.

Recording groups identity and live Book / Found / Difference totals. Untracked quantities and every displayed batch require explicit whole numbers from zero to 1,000,000. Serial identities remain separate, with one row and removal action per scan. Duplicate, oversized and typed book labels are rejected. A count note remains required. Refreshing explicitly discards the observation and reloads even when the route URL is unchanged.

Review keeps the permitted decision near the summary, with serial, batch and audit evidence in expandable sections. Self approval is unavailable; stale snapshots and unresolved serial identities cannot use a generic correction. Batch reservations remain protected, and the server still validates provenance. Verification is offered when separately corrected stock and tracked identities match. Linked discrepancy/direct-sale closure remains a separate decision and never moves stock.

Reads are bounded and owned by one route/account/server. Writes lock before asynchronous storage and retain their exact payload and idempotency key. Count-only request handling adds a 15-second bound and validates response identity, lifecycle, totals and original submitted evidence. Incomplete responses remain uncertain. Saved legacy attempts use their original keys and bodies. Site-PC acknowledgements remain pending until command confirmation; conflicts require reconciliation. Reviewing an outcome reads current records before releasing the attempt.

The count read API adds item type and unit metadata. No stock correction, permission, reservation, recurrence, discrepancy or provenance rules changed. No schema migration or dependency is required. The service-worker shell is version 152 and includes all new assets.

Verification uses focused frontend tests for invalid quantities, exact serials, repeated actions, missing/late/timed-out reads, timed-out/incomplete writes, ownership and recovery. Real-backend browser checks use disposable SQLite fixtures for independent review, guarded application, assignments, lost responses, offline recovery, linked-source closure, QR lookup, light/dark accessibility, long content, keyboard use and repeated refresh. The proposed interactive mock remains a simulated design reference; implementation screenshots come from the actual app. Physical camera hardware and production deployment require separate verification.
