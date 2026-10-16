# Public password-verification budget

Public tenant and console password sign-in now use Node's asynchronous native scrypt API.
The existing `scrypt$v1$131072$8$1$...` format, salt, full-input checks and timing-safe
comparison are unchanged. Legacy bcrypt uses its supported cooperative async comparison;
verified legacy credentials can upgrade to the same versioned scrypt format. Installed hosts
continue to verify without rewriting synchronized legacy hashes.

`shared/password-work.ts` admits one active password job per process, at most eight waiting
jobs, and a ten-second maximum queue wait. A full/expired queue returns HTTP 503 with
`Retry-After: 5`; it does not create a session. Tenant and console public login share this
budget, leaving other libuv work slots available. Counters contain only active/queued counts,
not identities, passwords or hashes. This is backpressure, not a promised sign-in throughput.

After async verification, both login paths re-read account credentials and status before issuing
anything. A concurrent password reset, rename or deactivation invalidates the old result.
Temporary password expiry is checked again and malformed expiry fails closed. A legacy hash
upgrade uses a conditional update. Tenant database context is retained across queued work.
Console passkey challenge creation also checks that its verified password snapshot is still
current after asynchronous option generation.

The internal synchronous helpers remain for bootstrap/CLI and existing authenticated password
writers/factor operations. Those paths can still block the event loop; this increment removes
the public scrypt sign-in bottleneck, not every synchronous operation in the app. Legacy bcrypt
is cooperative JavaScript rather than a dedicated native worker. Queue limits apply per process,
not across replicas; existing request/account limits remain process-local. Measure actual memory,
latency and representative sign-in bursts on staging hardware before changing deployment size.

Tests exercise real async scrypt/event-loop progress, verified legacy upgrade, queue saturation,
FIFO, expiry and failure recovery. HTTP tests cover stale-password/deactivation/rename/temporary
expiry races, shared tenant/console backpressure and separate tenant database contexts. Browser
regressions exercise password + passkey/MFA/recovery flows. No live load test was performed.

Primary references reviewed 2026-10-16:
[Node 24 crypto.scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback),
[Node event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop), and
[OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
