# Core provisioning recovery — 19 October 2026

Base: a192f1c6912ddcfe9cbb86885db20c82626f021a, production.

High scoped gaps: create published the catalog before owner initialization and could open an
unregistered preexisting database; import published a path before migration and used replacing
rename after a separate existence check; failed schema setup could leave a broken cached
connection. Core creation/import now prepares the database before registration. Catalog row,
company-ID allocation and core audit publish in one savepoint. No new schema is required.

Database and private import-staging paths are exclusively reserved. Existing files and SQLite
recovery artifacts, including dangling symlinks, block reuse. Caught failures close the affected
connection, verify bigint device/inode ownership, and remove only owned artifact families.
Published or replacement files are retained. Cleanup failures emit safe events and leave files
for review. Failed initialization evicts/closes its cached connection. Staging cleanup failure
after completed publication does not turn the successful import into a failed operation.

Regression cases cover existing-file preservation for create/import, catalog/audit rollback,
clean retry, selected owner readiness before registration, failed connection retry, incompatible
import/source preservation, replacement-file preservation, staging cleanup failure and dangling
recovery symlinks. Two real child processes exit from SQLite catalog-publication triggers; their
catalog has no tenant row after restart, their database remains, and a separate restarted
process receives a conflict without changing its bytes. No kill signal, power loss or live
hosting outage was tested. The process tests do not claim unattended recovery or exactly-once
HTTP orchestration.

Browser evidence: the first run passed 14 and failed the existing MFA disable scenario. The
captured server message was public code-length validation feedback, not a provisioning failure.
The same unmodified 15-scenario suite passed on rerun. The first text log is retained. Root cause
is unconfirmed; no MFA production fix or deterministic browser reliability is claimed. The
recovery code tests and full-suite results are recorded separately.

Research accessed 19 October 2026:
- https://nodejs.org/api/fs.html#file-system-flags
- https://www.sqlite.org/lang_savepoint.html
Exclusive creation and savepoint rollback/release semantics inform this boundary. Node notes
exclusive creation may not work on network filesystems; validate the actual volume before
rollout. Local file identity/process tests do not establish Windows or host power-loss behavior.

Remaining: reviewed quarantine/recovery of crash artifacts is manual; legacy artifacts are not
automatically adopted/deleted. Later route setup (modules/subscription/inquiry/invoice/email)
still needs durable orchestration/reconciliation and HTTP idempotency. Import schema/version,
credential/data sanitization and source/snapshot acceptance need broader review. Uploads and
migration/backup artifacts are preserved. API/diagnostic, dependency/history and external gates
remain open. See docs/operations/provisioning-recovery.md; whole-control totals are unchanged.
