# SQLite startup ownership and recovery

24 October 2026. Applies to updated processes using the same configured local tenant/catalog
database paths. The [contract](../audits/sqlite-startup-contract.md) records reproduced failures,
state boundaries and verification. This is application initialization coordination, not permission
to use SQLite on an unverified shared/network filesystem or approval for multiple hosted replicas.

## Normal behavior

Cold `getDb()` and catalog initialization take SQLite writer ownership of an adjacent technical
file, `<database path>.startup-lock`. The first process performs the existing backup/schema/
migration/history/seed sequence. A second cooperating process waits for ownership, then rechecks
the database through the same sequence. Existing cached connections bypass this startup gate.

Gate acquisition has a ten-second SQLite busy budget. While initializing, the business connection
also has a ten-second busy budget per SQLite operation; it returns to the previous zero-wait
policy before being returned. This is not a ten-second total startup SLA. Large migrations,
backup work and repeated contention need representative hosting acceptance.
Because Node's SQLite calls are synchronous, a cold tenant first opened during an HTTP request
can block that process's event loop while it waits/initializes. Other requests and health probes
can be delayed too. This fix does not certify request latency or capacity under that contention.
Processes must use the same configured database/gate path; distinct symlink/hard-link aliases
to one business file are not a supported way to share initialization ownership.

The lock file contains no application credential or business schema. It can remain empty and
remain on disk after a clean shutdown or process death. Its existence does not mean a process
still owns it. **Do not delete, rename or replace it while any process may be using the database.**
SQLite/OS locking releases ownership when the holder closes or dies; deleting a live path can
create separate inodes and defeat coordination. Parent directory permissions must allow creating
the adjacent technical file, as well as the existing database/WAL artifacts.

## Failure or interrupted startup

1. Inspect the process error and health/readiness. A startup that throws must not be treated as
   ready. Persistent competing ownership can produce SQLite error 5 after the wait budget.
2. Check for a legitimate migration/startup or long-running writer using that local database.
   Let it finish, or stop it through the normal process supervisor before retrying startup.
3. Do not clear the lock path as a workaround. Retry once the competing process has finished.
   A failed tenant/catalog initialization is closed and removed from its process cache.
4. If migration, permissions, storage or integrity fails, follow the existing backup/restore
   procedure and the original error. Waiting does not repair corrupt data or make an arbitrary
   historical migration crash-atomic. Preserve pre-migration backups and original evidence.
5. During restore/rollback, stop all processes using the database first. Restore the documented
   database/uploads/keys; an absent technical lock file is recreated on the next cold open.

Do not run mixed old/new build migrations against the same file: old builds do not honor this
gate. Explicit `forceMigrate` maintenance and destructive lifecycle actions are not converted into
general online distributed transactions by this change. Preserve the existing maintenance and
offline payroll authority procedures.

## Verification and rollout limits

`tests/sqlite-initialization.test.ts` uses disposable databases and independent child processes
to exercise the two original races, kill/restart, unrelated paths, actual timeout/retry and
catalog failure recovery. It never injects barriers into production code. The test worker is
typechecked with the rest of the project. The ten-second timeout test intentionally takes that
long and has an explicit 35-second harness budget for child launch/cleanup; its assertions remain.
Private `:memory:` tenant/catalog connections bypass the filesystem gate; regression checks
ensure initialization creates no startup file for those connections.

Vitest's default test/hook execution budgets are now 60 seconds after retained integration
timeouts. The startup contention case keeps its explicit 35 second test budget and real 10 second
SQLite wait. These harness settings do not change production request deadlines or startup
budgets. The shared mobile test fixture also awaits local draft storage and closes test windows;
its intentionally pending-network and unhandled-error controls remain effective. Those are
validation corrections, not application performance fixes. Observed long authenticated requests
on the test host remain an open investigation.

Production hosting/storage, Windows filesystem/installer acceptance, power loss, mixed-version
rollout and full restore remain separate evidence. There is no new owner engineering task or
required configuration variable for this local fix. Keep wider production-release holds open.
The app-level checks here use Node 22.22.0 and 24.19.0. The declared `>=22.13` minimum has a
demonstrated pre-existing SQLite API mismatch in payroll/sync guards; see the contract's
runtime probe. Treat minimum-runtime support as open engineering work, and use a tested,
supported patched runtime for subsequent staging acceptance.
