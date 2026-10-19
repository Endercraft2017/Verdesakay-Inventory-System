# Public signup work admission and uncertain responses

Implemented 19 October 2026. High scoped availability gap: public signup formerly performed
synchronous scrypt for request receipts and owner credentials, followed by another bootstrap
hash during database initialization. Several source addresses could delay unrelated requests
despite the per-IP limiter. This increment moves public hashing/verification to the existing
bounded native-crypto budget and removes redundant bootstrap hashing. It does not make all
database setup asynchronous or prove hosted capacity.

## Request lifecycle and limits

`POST /api/signup` retains SIGNUPS_OPEN, existing parsed schema and ten attempts/hour/IP.
Those controls run before resource admission; matching replays and busy attempts still count.
One validated signup request per Node process may be active, including replay and time spent
waiting for crypto. There is no signup waiting list. Another valid request receives 503,
Retry-After: 5 and “Registration is busy. Try again shortly.” Admission releases in finally
on success, replay, validation/service failure or native-crypto rejection. The route uses
no-store responses. This is a retry suggestion, not automatic retry or a throughput promise.

Keyed receipt creation/verification and owner hashing use shared/password-work.ts: one active
native password job, eight waiting jobs maximum and ten-second queue wait. Public tenant/
console login and inquiry verifiers share that budget; signup does not hold it around tenant
SQL setup or recursively acquire it. The owner and receipt hashes run as separate jobs, with
existing waiting work able to progress between them. Saturation/queue expiry returns the same
safe registration busy response; the underlying sign-in wording is not shown on signup.

Native async scrypt uses libuv's worker pool; it is not an independent process. The current
versioned N=131072/r=8/p=1 format and salt/input checks remain. One active KDF bounds this
module's expensive crypto concurrency, not the whole process's memory or all crypto users.
No native KDF cancellation or hard end-to-end server deadline is claimed. A stuck native job
could leave signup busy until process recovery; independent availability/incident monitoring
and representative hardware/memory measurements remain operational gates.

## Race, credential and data boundaries

The public receipt uses the existing signup:v1 scope, canonical parsed input, hashed random
UUID and slow salted verifier. No raw password/request/key or cheap password oracle is added.
After awaited verification, the live receipt verifier, response, tenant binding, expiry and
source availability are checked before replay. A newly competing receipt conflicts. The final
save still uses uniqueness inside the source/setup/invoice/alert publication transaction.
Matching replay bypasses owner hashing and database creation. Retention and tombstones are
unchanged; never delete a receipt to force another signup.

`createTenantForPublicSignup` snapshots trusted input, validates before native hashing and
rechecks current catalog state afterward. It accepts the password, not a caller-supplied hash.
The quote/subscription uses the server pricing snapshot captured for that request; a later
price change does not reprice it during owner hashing. Catalog/source revalidation does not
promise a live pricing refresh. File reservation and initialization occur only after hashing
succeeds. Core publication and
owned-file recovery are shared with synchronous createTenant; a competing registered workspace
is not overwritten. Catalog/schema setup and tenant SQLite/file work remain synchronous.

Trusted database initialization reuses the prepared owner hash only for a valid non-default,
uncached, empty reserved regular database. It rejects symlinks, nonempty/existing connections
and malformed hashes. The password-hash module alone owns encoded-format validation. Owner
username/email/hash/first-login flag are set before catalog publication. A crash can still
leave an unregistered file for reviewed recovery, never automatic adoption. See
[provisioning recovery](provisioning-recovery.md).

Synchronous CLI/operator creation uses the same fresh initialization to avoid duplicate hashing.
The default installation's first admin still requires the configured strong bootstrap password;
this change does not remove that default-account rule or reset existing users. Provisioned
workspaces use the chosen owner's credential rather than a transient global bootstrap hash.
No HTTP field can supply the trusted prepared hash. No tenant schema version, stored credential
format, dependency, session/authentication policy or receipt retention change was needed.

## Browser and support handling

The signup form aborts fetch/body reading after a twenty-second application timer, clears it
on completion and re-enables the button after failure. It retains the same in-memory random key
and all fields for retry. Only a 201 JSON acknowledgement with a valid slug may navigate to the
workspace. Null/HTML/wrong-status responses do not indicate success. Duplicate active submission
is ignored. No password/key is placed in localStorage by this change.

Abort or a lost response does not roll the server back: work can finish after the browser
stops waiting. Retry the same page with the original details/key. A committed different payload
conflicts; check the existing workspace before starting another request. A pre-commit failure
can accept corrected input with the same key. Reload/new page/new key/no-key clients remain
outside same-request duplicate protection. Browser suspension can delay timers. There is no
automatic retry loop, captcha, email-ownership verification or distributed signup/storage quota.

## Rollout, rollback and acceptance

Use disposable/staging data to verify busy responses under shared crypto saturation, health
response while hashing waits, chosen-owner login, protected replay, fault cleanup, and the
committed-response-loss browser journey. Ensure valid deployment bootstrap configuration for
supported rollback versions. Receipts and credentials remain readable by the old synchronous
preparer; old code restores the event-loop bottleneck and ignores the new browser deadline.
Never restore an old catalog or remove a reserved database without duplicate/provider review.

Before release, measure signup/login/inquiry contention, event-loop latency during synchronous
schema setup, memory/disk growth and representative bursts on the actual supported host. Agree
admission/error targets and independent alerts; maintain process/topology restrictions for
SQLite authority. Broader authenticated synchronous hashes, distributed abuse/edge controls,
other API retry receipts and the remaining scorecard controls stay open. No host settings,
provider credentials, real signup, external alert destination or deployment changed here.

Exact local results and scope: docs/audits/evidence/signup-budget-verification.json. Research
references: docs/audits/standards-research.md. Local tests are not full-control release approval.
