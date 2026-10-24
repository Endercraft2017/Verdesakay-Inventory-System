# Recovery after an interrupted offline adoption copy

This procedure concerns the original-company adoption CLI, not ordinary tenant
creation/import, payroll synchronization or restoring a live tenant. See the
[existing cutover procedure](../VERDESAKAY-TENANT-CUTOVER.md) and
[runtime support](runtime-support.md). The historical Verdesakay cutover is recorded
as complete; this fix is not an instruction to run it again.

The prior implementation fails on Node 24.22.1 after claiming the destination
upload directory: recursive `cpSync(errorOnExist: true, force: false)` rejects that
directory. The updated implementation keeps the exclusive directory claim and
copies verified manifest files using `COPYFILE_EXCL`. It still refuses occupied
destinations. Neither upgrading Node nor installing this patch automatically
resumes or cleans up an earlier attempt.

1. Stop all server/worker/scheduled writers and keep them stopped during review.
   Verify the actual runtime with `npm run runtime:check`. The CLI's
   `--server-stopped` flag only records your assertion; it cannot stop writers.
2. Preserve the source DB and its WAL/SHM files, original uploads, platform catalog,
   all `.adopt-default-*` recovery directories, partial destination and original
   stdout/stderr/exit result. Keep backups/keys under existing access controls.
   Do not delete a directory merely because it is empty or unregistered.
3. Read the intended slug's catalog row/provisioning log and the exact reported
   paths. Inspect `source.db`, `platform.db`, backup uploads and any
   `verification.json` in recovery. Check SQLite integrity and byte/hash manifests
   against the preserved inputs. `verification.json` is written after destination
   verification, before catalog registration; it alone does not prove publication.
4. An absent tenant plus partial destination means **incomplete adoption**, not a
   usable company. An interrupted run before the second file copy leaves its
   first copied file and recovery snapshots; an ordinary repeat refuses the
   destination. This is expected containment. Do not force an overwrite, register
   the partial copy by hand, or retry using a different slug to sidestep review.
5. After establishing ownership, stopped writers, intact source/backups, absence
   of a registered tenant and absence of subsequent business writes, an operator
   may quarantine only the reviewed unregistered destination outside the upload
   source tree and retain it as evidence. A fresh preview/apply then starts from
   intact source data on the patched runtime/code. This is a manual recovery
   decision; no automated removal/resume is delivered here.
6. If registration exists, reconcile catalog, verified target and provisioning
   history first. A lost CLI response is not evidence of failure. After any new
   company writes, reverting to the original source requires reconciliation.
   Resume normal use only after the original login, known records, uploads,
   scoped URL and backup checks in the cutover runbook pass.

No schema migration or data conversion is introduced by this fix. Reverting the
code restores the current-Node copy failure; it does not require downgrading to
an old security patch or change which database is authoritative.

Local tests cover actual Linux Node 22/24 runtime families, competing claims and
SIGKILL before a destination file copy. They do not cover power loss, disk failure,
all crash points, Windows reparse points, network filesystems, malicious filesystem
writers or an actual hosted cutover. Node documents that file copy is not atomic.
The existing source/destination manifest checks and stopped-writer prerequisite
remain necessary. An empty file manifest does not account for empty directories,
ACLs or all filesystem metadata. Independent operational review and actual-host
backup/restore acceptance remain required before a real migration.
