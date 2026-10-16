# New-password policy

The audit branch now requires **15–128 Unicode code points** whenever a password is created
or replaced. This follows the password-only minimum in
[NIST SP 800-63B-4 §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#passwordver).
MFA remains optional for some accounts, so the application uses the same minimum for all new
passwords. It permits spaces, Unicode, paste and password-manager-generated values. It does
not add uppercase/digit/symbol composition requirements or periodic password expiry.

The shared validator applies to HTTP account creation/change/reset, assisted recovery, signup,
workspace provisioning, development-only AI account creation, operator CLI/upsert and default
administrator/operator environment bootstrap. Direct provisioning and operator paths also enforce
the maximum and common-password blocklist. Authentication/current-password inputs accommodate
all allowed Unicode passwords without imposing the new minimum on an existing credential.

Existing passwords are **not** rewritten or rejected merely for being shorter. Existing
console bootstrap variables also do not overwrite an existing operator unless the explicit
reset switch is used. A reset switch cannot set a newly invalid password or remove passkeys.
First-time bootstrap needs a compliant password; a weak attempted bootstrap fails with an
explicit configuration error. No live password, account or hosting variable was changed.

The existing bundled whole-password common-value list is retained and supplemented with exact
long repeated/sequence values. The blocklist is case-insensitive; it is not a live breach feed
or a guarantee that a chosen phrase has never leaked. No password or hash is sent to a third
party for this check. Unicode code points count once; spaces remain part of the secret.
Normalization behavior of stored hashes is unchanged, preserving existing exact-byte passwords.
These changes implement the length and writer-consistency fix, not complete NIST conformance.

Desktop/mobile/signup hints match the minimum. Mobile cache v109 refreshes changed shell assets.
Older installed clients may still display an old hint until updated; the server remains the
validation boundary. Coordinate cloud and installed-host releases to make the new policy
consistent wherever new credentials can be written. Existing synchronized hash compatibility
and synchronous scrypt resource limits still apply; see [password-migration.md](password-migration.md).

`tests/password-policy.test.ts` exercises Unicode boundaries, unchanged legacy short-password
login, rejected short replacements, direct console/tenant provisioning and operator bootstrap
reset. `tests/admin-bootstrap-env.test.ts` tests default-admin bootstrap with missing, short,
common, oversized and valid values. Existing authentication/recovery/browser fixtures use
compliant synthetic credentials; explicit invalid-password cases remain invalid.

The owner does not need to change anything now. Final rollout checks are to verify ordinary
sign-in, reset and native/site behavior in staging, update installed clients and hosts, and
follow the controlled recovery process for known compromised credentials. Never send any
password or recovery code in chat.
