# Workspace creation/import failure recovery

Updated 19 October 2026. Engineering behavior is local-test verified; hosted filesystem and
Windows process/power-loss acceptance remain separate release work.

## Implemented boundary

Core create/import prepares the database before registering the workspace in `platform.db`.
Creation installs the selected owner credentials first. Import validates a private copy,
removes old login sessions and finishes migration before publication. Catalog registration,
company-ID allocation and the core provisioning audit entry commit together in a savepoint.
Until publication succeeds, normal tenant resolution cannot route requests to the database.

Database slots use exclusive creation. Existing database files, SQLite sidecars and dangling
recovery-file symlinks block an attempt with a safe conflict. Import staging is exclusively
reserved too. Caught failures close/evict the affected tenant connection and remove only the
owned database and sidecars. Device/inode identity is compared with bigint stats; a replacement
file or an already-published catalog entry prevents deletion. Failure to clean up emits a safe
`provisioning_cleanup_failed` event and leaves artifacts blocked for review. Staging cleanup
failure emits `provisioning_staging_cleanup_failed` without undoing a completed import.

A real process exit can leave an unregistered database or private `.import-*` artifact. The
core does not automatically reuse, publish or erase it on restart. A new attempt gets a
conflict when the final database/recovery slot is occupied. This deliberately requires review;
it is not an automatic resume or distributed transaction system.

## Review an interrupted attempt

This is an operator/engineering procedure, not a tenant-admin task. No owner action is needed
for local tests. Do not run it against the original/default company or an already used tenant.

1. Stop all server, worker, CLI and migration writers sharing the volume. Confirm the configured
   `DATA_DIR`, platform DB and slug; do not infer them from a filename alone.
2. Preserve verified backups of the catalog and the entire artifact family (`.db`, `-wal`,
   `-shm`, `-journal`, associated `.import-*` files). Preserve the original import snapshot.
   SQLite sidecars may contain the latest committed data; never discard them as temporary junk.
3. Check the catalog and core provisioning audit. If the slug exists, preserve its files and
   investigate the registered workspace. A lost HTTP response can follow a successful publish;
   do not delete/recreate that account or assume the request made no changes.
4. If the slug is absent, inspect a copy offline for integrity, actual owner account and business
   data. An unregistered file may predate this release or be a customer database; absence from
   the catalog does not prove it is disposable. Never adopt a seeded default login automatically.
5. After documenting the provenance and recovery decision, move the whole unregistered artifact
   family together to a private quarantine on the same volume, retain its hashes/backups, and
   retry normal create/import using a verified source and chosen owner credentials. Do not
   overwrite or manually register an unexplained database. Keep the original import unchanged.
6. Verify catalog/audit, selected owner login, expected imported records and old-session rejection
   before reopening service. Escalate uncertain ownership or cleanup failures; preserve evidence.

## Limits and remaining engineering

Signup and console local catalog setup now participates in publication: subscription/modules,
payment lock, owner contacts, inquiry linkage and applicable first invoice/audits commit or roll
back together. See workspace-onboarding.md for the exact failure matrix. Covered HTTP creation routes now commit scoped completed-response receipts with local setup;
same-key retry can replay a committed acknowledgement. New/no keys still need reconciliation.
Reliable notification delivery still needs an outbox/worker. External notifications remain outside the local transaction.
Existing legacy suspended/orphaned workspaces are not automatically converted or deleted.
Uploads, private migration snapshots and backup artifacts are preserved, not broadly removed.

The file reservation assumes trusted private storage with working exclusive-create semantics.
Node documents that exclusive flags may not work on network filesystems. Verify the actual
hosting volume and Windows behavior; power-loss/fsync and multi-host storage acceptance are
not established by process-exit tests. Filesystem changes and catalog commits do not form one
atomic transaction. Cleanup failures retain blocked artifacts instead of guessing ownership.

Research: [Node filesystem flags](https://nodejs.org/api/fs.html#file-system-flags) and
[SQLite savepoints](https://www.sqlite.org/lang_savepoint.html), accessed 19 October 2026.
Tests: `tests/provisioning-recovery.test.ts`, existing console/import/settings/signup suites,
and actual-app Playwright checks. See the dated audit validation results for exact outcomes.
