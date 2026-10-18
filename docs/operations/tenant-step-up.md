# Recent verification for tenant administration

Implemented 2026-10-16. This is an additional check on existing permissions, not a grant of access.
A completed password sign-in (plus the existing second factor when enabled) starts a five-minute
verification window for that session. Temporary-password and mandatory-MFA-setup sessions do not
receive this proof. After the window expires the app asks for the current password and, if MFA is
enabled, a current authenticator code or unused recovery code. It retries the original action once
only after successful verification. Cancellation leaves the action unsaved.

## Protected scope

- Tenant account creation and edits, permission overrides, custom role creation/edit/deletion,
  privileged-MFA policy changes, and administrative revocation of another user's sessions.
- Trusted office-PC enrollment, voting-status changes and revocation.
- SMTP settings and test delivery, AI configuration and usage-budget reset, and QuickBooks
  connect/disconnect/auto-push configuration.

Existing password resets, assisted recovery and factor-management endpoints retain their own
explicit password/factor requirements; a recent-verification marker cannot substitute for those.
Ordinary inventory, clock, production, order and other offline business work is unchanged.
Department management, financial approvals, exports and every possible sensitive business action
are not all covered by this increment. AUTHZ-15 therefore remains open rather than becoming PASS.

## Server guarantees

`session_stepups` stores only the session-token digest, user ID, credential fingerprint and
server verification time. No password, OTP, raw session token or reusable recovery code is stored
there. Proof expires after five minutes, belongs to one live session, and invalidates when the
account password, role/permissions, active/setup state, enrolled factor or security policy changes.
Changing the policy preserves only the initiating operator's remaining window; it never moves
its verification timestamp forward. Failed password verification does not consume a recovery code.
The shared password-work queue provides bounded asynchronous password checks; the account failure
budget applies across security-verification operations. Session/status/factor context is checked
again after the asynchronous password work.

The table is node-local and excluded from replicated effects and sanitized office-PC snapshots.
Existing online-only account/integration routes refuse installed-node execution. A replayed command
has no direct user-session token and cannot manufacture verification proof. An offline office PC
cannot obtain fresh cloud verification or immediately learn of a cloud revocation while disconnected.

QuickBooks authorization state additionally binds the initiating live session, account/factor/
permission fingerprint and one-use generation. It lasts ten minutes, is invalidated by disconnect
or a newer connect attempt, and is checked again after asynchronous token exchange before tokens
are saved. Expired/revoked authorization requires starting Connect again. This is not a complete
provider certification: real Intuit acceptance, real provider concurrency and
reconciliation acceptance still need integration testing. Local lifecycle hardening was added
2026-10-18; see [quickbooks-lifecycle.md](quickbooks-lifecycle.md) for tested scope and limitations.

## Client and operational acceptance

The shared native dialog supports keyboard cancellation, focus restoration, labelled fields and
44px controls. Credentials remain in the active form/request only and fields clear after attempts
and closure. The API checks the original company/server and sign-in generation before retrying;
it refuses to replay under a different account/company. A missing dialog helper fails closed.
The mobile shell is cache v111 and includes the helper; native web/plugin assets were synchronized.
No new SDK compilation or physical-device verification is implied.

Automated tests use actual server endpoints, the sanitized snapshot builder, real recovery-code
consumption, session-expiry/revocation races and the actual browser API client. Playwright covers
Escape cancellation, failed verification, successful exact-action retry, recovery-code replay,
390×844 layout, keyboard focus and an axe scan. See the dated validation record for final results.
These checks do not establish all-screen accessibility or live proxy/device acceptance.

Before rollout, use isolated staging to check both desktop and phone clients with a real admin,
wait beyond five minutes and exercise account, policy and integration changes. Confirm account/
server switching cancels pending work and no credentials enter monitoring logs. Do not ask the
owner to send passwords, authenticator codes or recovery codes to support.

Sources reviewed 2026-10-16:
[OWASP Authentication — sensitive-feature reauthentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features),
[OWASP MFA — factor changes and recovery](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
The five-minute window is this application's engineering choice, not a claimed universal mandate.
