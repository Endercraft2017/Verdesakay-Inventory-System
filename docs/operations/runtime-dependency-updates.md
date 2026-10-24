# Runtime dependency updates and rollback

The 24 October [remediation contract](../audits/dependency-remediation-2026-10-24.md) updates
only body-parser, Multer, Zod and Nodemailer. It does not deploy a hosted service or migrate
business data. Release hold remains open: runtime node-forge, separate desktop/build findings,
the quoted-local-part limitation and existing release blockers are not exceptions or approvals.

Use the tested commit and its lockfile with `npm ci`, rather than re-resolving ranges during a
release. Confirm `npm ls --omit=dev` and run runtime/full-root `npm audit` separately; nonzero
advisory exits are expected until all findings receive an explicit disposition. The audit used
`--ignore-scripts` for controlled clean-install comparisons; that does not verify an Electron
binary download, native installer, or arbitrary install lifecycle. Follow the existing build
process for those targets and independently check the actual installed binaries.

Before cutover, preserve the current application build, configuration and normal database/upload
backups using the existing backup procedure. Observe parser errors, process exits, upload
completion/cleanup and mail attempt states after restart. A parser crash before this fix may
already have interrupted unrelated accepted work: use each workflow's durable receipt/outbox
recovery rules. Health returning after restart is not proof that every interrupted action is safe
to repeat.

For mail, preserve queued/accepted/unknown records and event history. Follow
[payroll email recovery](payroll-email-release.md) and the existing platform outbox procedure;
never resend accepted/unknown mail merely because packages or processes changed. No delivery
receipt, provider idempotency guarantee or exactly-once send is introduced here. Sender and
recipient addresses used for reviewed payroll must remain single plain mailboxes. Do not expand
address syntax support until the strict quoted-mailbox experiment and actual adapters establish
exactness.

If a regression requires rollback, stop the affected instance using the normal runbook, restore
the prior application build plus **its matching lockfile**, install that graph, and restart with
the same compatible database/configuration. This change has no schema rollback. Reverting to
06179a8 reintroduces the demonstrated public compressed-body crash and other vulnerable packages;
record that exposure and restrict public ingress while evaluating a safer fixed build. Do not
delete startup locks, outboxes, event rows or local sync commands to make a rollback appear clean.
Do not mix manifests, lockfiles or installed node_modules from different graphs.

To repeat the bounded local checks:

```sh
npm run typecheck
npx vitest run tests/dependency-advisories.test.ts
npx vitest run tests/payroll-email.test.ts tests/upload-tenant-context.test.ts
npm test
npm run test:e2e
```

The intentionally unresolved experiment remains executable separately:

```sh
node --import tsx scripts/audits/nodemailer-mailbox-experiment.ts
```

It sends synthetic data only to a disposable loopback TLS SMTP peer and currently exits **1**
because the exact quoted mailbox is changed. Do not weaken that assertion, count it as a passed
gate, or use a real customer/provider address to repeat it. Optional `DEPENDENCY_EVIDENCE_DIR`
retains synthetic command/message captures; the peer's complete `commands` array is authoritative
for quoted paths, since its older convenience `to` list splits at spaces.
