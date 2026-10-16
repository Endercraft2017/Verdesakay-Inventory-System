# Password storage migration

Engineering change, 16 October 2026. This document covers password hashes, not MFA rollout
or a complete authentication assurance claim. No live databases were migrated during development.

## Implemented behavior

All application password writers and verifiers use `shared/password-hash.ts`: tenant account
creation/change/reset, first-run seed, provisioning, operator bootstrap/CLI/change, assisted
owner reset, personal-profile password confirmation and the AI account-creation tool.
New hashes use Node's built-in scrypt with N=131072, r=8, p=1, a random 16-byte salt and a
64-byte result. The serialized format includes a version and fixed parameters; verification
rejects unknown formats or cost parameters before performing a derivation. Comparisons of
derived bytes use constant-time comparison. Passwords are not trimmed or truncated.

[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
recommends Argon2id first, and scrypt at these parameters when Argon2id is unavailable.
The app supports Node 22.13 and Electron's Node 24; scrypt is available in the supported
runtime without introducing a native password-hashing package or requiring an experimental
Argon2 API. The implementation uses the [Node crypto API](https://nodejs.org/api/crypto.html#cryptoscryptsyncpassword-salt-keylen-options).

Existing bcrypt hashes remain verifiable for inputs up to 72 UTF-8 bytes. A successful
password check at cloud tenant or console login replaces a bcrypt hash using a conditional update
against the old hash. A failed password never changes the credential. For MFA accounts this
hash upgrade does not issue a session; the existing second-factor challenge still applies.
New credentials verify their entire input, including suffixes beyond 72 bytes and Unicode.
Installed site logins verify both formats but do not rewrite cloud-owned credentials.

Legacy bcrypt inputs above 72 bytes are rejected because the old hash cannot authenticate
their suffix. These users must use password recovery or an administrator-assisted reset.
An original password cannot be recovered from a hash. Do not attempt to invent or restore
its discarded suffix, and do not automatically store an unverified suffix as a new password.

## Before deploying

1. Use staging and an isolated restore of a real-size backup, including files and encryption
   keys. Preserve the current rollback artifacts; do not test migration against live records.
2. Use a coordinated maintenance window: stop sign-ins and update the cloud and all installed
   desktop/site hosts before reopening access. New cloud binaries migrate at successful login;
   there is no separate migration-enable switch. Older binaries cannot verify
   scrypt hashes received through user synchronization. Do not roll back to a binary that
   only understands bcrypt after credentials have migrated.
3. Exercise old-account login, MFA login, password reset, owner recovery, native login and
   offline site login/sync. Check that cross-account/tenant credentials remain invalid.
4. Budget approximately 128 MiB of working memory per active scrypt derivation, plus runtime
   overhead. The configured 192 MiB is a memory ceiling, not proof of allocated/resident
   usage. Measure actual memory and sign-in latency on deployment hardware.
5. Public tenant/console sign-in now uses bounded asynchronous scrypt: one active job,
   eight queued and a ten-second queue wait; saturation returns 503/Retry-After. Existing
   authenticated writers/CLI/bootstrap still have synchronous helpers. Measure actual memory
   and sign-in/admin-write latency; this is not a blanket event-loop or capacity guarantee.
   See [password-work-budget.md](password-work-budget.md).
6. Confirm there is a usable recovery channel for legacy long-password accounts. Generic
   login errors intentionally do not reveal whether an account exists or needs recovery.

## What the owner needs to do

No immediate password change, secret sharing or live deployment is requested. When a tested
staging release is ready, help verify access on the actual office computers and phones and
keep recovery information in a password manager. The separate console-MFA setup will need
Windows Hello and an independent backup key, as described in
[console-passkeys.md](console-passkeys.md); it is separate from this hash change. Never send passwords, authenticator seeds or recovery codes in chat.

## New-password policy follow-up

New or replaced passwords now require 15–128 Unicode code points through the shared policy,
including direct console/tenant provisioning and environment bootstrap. Existing shorter
credentials remain usable. See [new-password-policy.md](new-password-policy.md) for Unicode,
blocklist, compatibility and rollout limits. This does not force arbitrary periodic expiry.
Console passkeys and fresh console write verification are implemented separately; enrollment
and independent backups still need a staged rollout. Native storage, broader tenant step-up
and the other release findings remain separate work.
