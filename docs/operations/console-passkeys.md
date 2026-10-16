# Owner-console passkeys

Implemented on the `production` audit branch, 2026-10-16. This is an application control;
physical Windows Hello, production HTTPS/proxy behavior, and the console's external access
policy still need verification before release. No live account or hosting setting was changed.

## Behavior and boundaries

The console uses pinned SimpleWebAuthn server 14.0.3 and browser 14.0.0. Registration and
sign-in require WebAuthn user verification (for example Windows Hello PIN/biometrics or a
FIDO2 key's PIN). The browser bundle is self-hosted; rebuild it using
`node scripts/vendor-console-passkeys.mjs`. Its license ships beside the bundle.

- First enrollment requires an authenticated operator session and the current password.
  Enrolling a key revokes the operator's other sessions.
- Once enrolled, password verification issues only a five-minute, single-use WebAuthn
  challenge. It does **not** issue an authenticated session. Successful signed verification
  opens the usual separate HttpOnly console session.
- Existing password-only sessions cannot access enrolled operators' console data. Console
  writes require passkey verification within the last five minutes; reads require a session
  that completed verification. The UI requests verification before retrying a rejected write.
- Enrollment challenges are session-bound. All challenges bind the account password hash,
  credential set, purpose, configured origin/RP ID and expiry. Used or failed verification
  challenges cannot be replayed. Signature counters are updated with a compare-and-swap.
- Adding another key requires a fresh existing passkey and password. Removing one requires
  both and revokes other sessions. The last key cannot be removed. Maximum ten per operator.
- Public keys, counters, transport/device metadata and names live in platform.db. The server
  never receives the Windows PIN, fingerprint, face image or passkey private key.
- Changing/resetting a console password does not remove its passkeys. Tenant recovery cannot
  reset console factors. There is no support master code or password-only fallback for an
  enrolled console operator. Lose every key and ordinary console sign-in remains blocked.

User verification is required, but device attestation is not requested. Credentials may be
synced by a provider. This does not prove hardware binding or NIST AAL3. External VPN/access
restrictions, tenant-wide step-up, and multi-instance rate limiting remain separate controls.

## Safe rollout — owner completes this last

1. Before deployment, the release operator configures `PLATFORM_WEBAUTHN_ORIGIN` to the exact
   stable console HTTPS origin, for example `https://console.example.com`, without a path.
   `PUBLIC_APP_URL` is a fallback only if it is the **same** origin used for this console.
   Never use an arbitrary request Host header. HTTP localhost is allowed only outside production.
   A later hostname change needs a deliberate credential migration; old RP credentials will
   not work on an unrelated domain.
2. On the trusted Windows computer, set up Windows Hello under Windows **Settings → Accounts
   → Sign-in options**, then open the console in a supported current browser over HTTPS.
3. Sign in, open **Account & security → Manage passkeys**, enter the current console password,
   and choose **Add passkey**. Choose Windows Hello when the browser offers it.
4. Enroll a separate FIDO2 USB security key that supports user verification, or another trusted
   independent authenticator. Keep it somewhere safe. Another copy on the same lost computer
   is not an independent backup. Test sign-out/sign-in with each before relying on it.
5. Choose **Require passkeys for all operators**, verifying with the enrolled key. Alternatively
   the release operator sets `PLATFORM_REQUIRE_PASSKEY=true` after planning enrollment.
   Until either policy is enabled, **unenrolled** operators retain the existing password-only
   behavior. Once enabled, their password session can only enroll a key, inspect setup or log
   out; tenant provisioning, recovery and data access remain blocked.
6. Test both authenticators, cancelled prompts, an old session and a sensitive console action
   in staging. Save dated evidence and keep the backup accessible before production enforcement.

The stored require-passkeys policy persists in platform.db. Setting the environment variable
false does not undo it. There is no UI policy-disable endpoint. Do not edit the database merely
to bypass a lost key; use the tested independent backup. Any future emergency server-level
recovery needs a separately reviewed, logged, offline operational procedure.

## Local verification and remaining evidence

`tests/platform-passkeys.test.ts` checks configuration, password/session boundaries, invalid and
replayed enrollment, expiry, password-change invalidation, mandatory setup, stale proof and
last-key protection. `tests/e2e/passkeys.spec.ts` runs the actual browser WebAuthn APIs with a
Chromium virtual authenticator and real cryptographic registration/authentication verified by
the server, including login replay rejection and policy activation. This proves those local
flows; it does not simulate Windows hardware, physical backup custody or a real reverse proxy.

Primary references reviewed on 2026-10-16:
[SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server),
[browser](https://simplewebauthn.dev/docs/packages/browser),
[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), and
[OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
