# Runtime preflight and recovery

Compatibility floors are **22.22.0 in Node 22.x** and **24.19.0 in Node 24.x**. Use a maintained
patch; official current versions observed 24 October 2026 are **22.23.4** / **24.22.1**. The
recommended standalone `.node-version` pin is 24.22.1. Other majors, prereleases and malformed
versions are refused until qualified. Floors express compatibility, not indefinite security
approval for every old patch. Recheck upstream patches/support before release; Node 22's current
schedule ends support on 30 April 2027. No automatic calendar-based shutdown is introduced.

After selecting the runtime and installing the matching lockfile, run:

```sh
node --version
npm ci
npm run runtime:check
```

Normal installs enforce the engine policy through `.npmrc`. An npm install override cannot
bypass the executable admission check. The check tests SQLite in private memory and does not
open, create, migrate or repair tenant/catalog databases. It checks actual transaction-state
transitions, an FTS5 query and changeset capture/session availability. Unsupported-version
errors use `UNSUPPORTED_NODE_RUNTIME`; missing compiled capabilities use `UNSUPPORTED_SQLITE_RUNTIME`.
Server, tenant initialization, catalog access and migration entry points encounter admission
before application data paths. Very old Node versions lacking `node:sqlite` may fail at module
linking before a direct server import can format the error; the dedicated runtime command has
no static SQLite import and should be used first.

If startup is refused, preserve existing files and upgrade the actual runtime that starts the
process. Changing `.node-version` alone does not change a running host, shell or installed app.
On Windows a newly installed Node version may require a new terminal/service process. Re-run
the check in that same service/build environment. Embedded Electron has its own Node/SQLite;
upgrading standalone Node does not update it. The locked Electron release metadata lists Node
24.21.0, which satisfies the version floor, but the actual Windows binary/capabilities and its
outstanding security advisory still require verification. No native installer acceptance is
claimed by Linux tests or metadata.

If an unsupported runtime already touched data, stop it using the existing shutdown procedure
and preserve DB/WAL/SHM files and backups consistently. Do not manually commit an uncertain open
transaction, delete startup-lock files, erase outboxes/commands, or upgrade a markerless received
payroll command by assumption. The old-runtime experiment leaves an uncommitted inbox row after
a marker fault; process/connection rollback is distinct from proving all historical work correct.
Follow [payroll replay recovery](payroll-cloud-replay.md), [payroll posting retries](payroll-post-retries.md)
and [startup recovery](sqlite-startup.md) for existing evidence and reconciliation. No real-company
data were examined by this increment, and no automated historical repair is added.

After upgrading, run the private preflight before normal startup/migrations. Then use the
existing backup, health, tenant and sync smoke procedure. A successful preflight proves the
tested APIs/features for that process; it does not verify filesystem durability, business data,
provider delivery, concurrency capacity or the entire installed build.

This change adds no schema migration. If rollback is necessary, use a matching earlier app and
lockfile on a known-compatible maintained runtime; reverting to e077a49 restores the misleading
22.13 declaration and removes early admission. Do not roll back to the demonstrated unsafe 22.13
runtime as a recovery shortcut. Preserve all business files and follow the existing restore
procedure if their integrity cannot be established.

The [audit contract and evidence](../audits/runtime-support-contract.md) distinguish simulated
version-policy tests, real old-runtime experiments, actual current/floor checks and external
verification. Broader release holds remain open; no new owner coding task is required.
