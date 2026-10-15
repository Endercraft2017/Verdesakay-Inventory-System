# Production operating runbooks

DRAFT — assign operator/deputy, host/provider, private emergency channel and approved service targets [OWNER]. Commands below use existing scripts; inspect their `--help` and deployment paths before a real operation. Never run restore/purge against live storage as a test.

## Preflight and deployment

Use a separate staging host, tenant DBs, uploads, credentials and integrations. Pin supported Node (22.13+; CI 22/24), install from lockfile with `npm ci`, set NODE_ENV=production and a strong private bootstrap ADMIN_PASSWORD for a fresh DB. Configure APP_URL/tenant origins, HTTPS proxy and BEHIND_PROXY according to `docs/DEPLOY-RAILWAY.md`/hosting code, mount persistent DB/upload/data volumes and keep them private. Do not expose SQLite, backup files, .env or owner-console credentials. Verify Secure cookies, HSTS and request IDs from the real external URL.

Require reviewed tests, secret/dependency scan disposition, policy approval, pre-release backup and staging smoke. Record commit, schema version, config diff, build/runtime, actor, time and rollback decision. Migrate tenants using `npm run migrate:all` only with verified backups and matching environment. Run desktop/mobile/native smoke when distributing those artifacts; web tests do not certify their binaries.

## Backup and isolated restore

Inventory all tenant/platform DBs, uploads and encryption keys; choose approved RPO/RTO [OWNER]. Use `npm run backup` and `npm run backup:list`; configure encrypted offsite storage using `npm run backup:offsite` and existing offsite docs. Keep offsite credentials/keys recoverable separately, restrict deletion, enable storage versioning/immutability where supported, and alert on backup age/failure/capacity. A backup feature is not proof that scheduled offsite copies exist.

Restore only into a separate isolated directory/host using `npm run backup:restore` with the selected backup arguments; read `scripts/backup.ts` usage first. Disable mail/push/AI/QuickBooks/sync side effects in the drill. Verify DB integrity and tenant mapping, sign-in, restricted roles, attachment opening, stock totals, recent orders, payroll sample and session/security controls. Measure backup age (RPO) and elapsed recovery (RTO), record failures and evidence, destroy drill data safely. Reapply deletion suppression/legal holds. Test loss of the primary host and loss of normal operator access, not just a same-disk file copy.

## Rollback

Stop writes/sync, record last accepted operations and snapshot current state. A previous application binary may not understand the migrated schema: do not simply swap commits after a schema change. Restore a mutually compatible application+DB+upload snapshot into isolation, validate and obtain incident-lead authorization before cutover. Account for accepted writes after the snapshot; reconcile rather than silently lose stock/payroll changes. Document outage and customer communication.

## Monitoring and overload/DDoS

External HTTPS uptime and authenticated canary, structured request/error alerts, CPU/memory/event-loop, disk/WAL/upload space, backup age, queue/sync lag, login failures, AI usage/cost and integration failures need dashboards and paging [OWNER]. Set alert thresholds from staging capacity tests and actual peak concurrency. `/api/health` alone does not prove all business paths or offsite backup health.

Put public traffic behind the chosen TLS/WAF/rate-limiting service. Restrict direct origin access where supported, bound uploads/connections and verify trusted proxy hops. During overload identify ingress vs application vs disk pressure, enable provider mitigations, throttle optional AI/heavy reports, preserve authoritative business operations, and avoid retry storms. Load-test only local or explicitly authorized staging targets; define latency/error thresholds and recovery behavior before raising load.

## Support and service interruption

Support channel, hours/timezone, severity response/update targets and deputy: [OWNER]. Never ask for passwords or full payroll exports. Record tenant, request ID, time, reproducible redacted steps and impact. Escalate cross-tenant access, credential leakage, financial corruption or widespread outage immediately to the incident lead. Publish customer updates through approved channels with confirmed facts; keep sensitive details private.
