# Assisted account recovery

Implemented 16 October 2026. This is a security workflow, not legal clearance or a claim that
the whole application is production-ready. Follow the customer's agreement and your approved
privacy/support procedures. Establish the appropriate legal basis and retention requirements
with qualified advice for your actual jurisdiction; no jurisdiction-specific conclusion is
made here.

## Choose the correct action

- Forgotten password, authenticator still available: use password recovery/reset. The existing
  authenticator remains enabled. Password resets revoke sessions and pending MFA login challenges.
- Lost authenticator, recovery codes available: use a saved single-use recovery code to sign in
  and replace the factor through the normal password-and-factor-verified account controls.
- Lost authenticator and recovery codes: use the assisted recovery process below.

There is no reusable bypass credential, support login-as-user token or master password.

## Independently verify the requester

Contact the authorized customer representative using established company details recorded
before the request. Verify authority against the customer agreement and your existing account
records. An incoming email/chat, knowledge of an invoice, urgency or a new telephone number
alone is insufficient. Pause unusual cases and recent contact-change cases for investigation.
Never change the recovery email and approve recovery as a single support action.

Record a support ticket/reference and a concise reason. Keep verification evidence in your
approved support system with access controls; do not paste identity documents, passwords,
authenticator seeds, codes or unnecessary personal data into the application reason fields.
The app records the assertion/reference; it cannot establish whether a human actually performed
the identity check. Train and review approvers accordingly.

## Tenant administrator assisting another account

Accounts & Roles → Recover 2-step. The assisting administrator needs `users.manage`, their own
enrolled MFA, their current password and an unused authenticator/recovery code. They must supply
a verification reference and reason. They cannot use this route to recover their own account.
This is a trusted administrator helping another account; it does not require a second tenant
administrator in addition to that assisting administrator. The requester/approver identity is
recorded explicitly in the tenant recovery event.

## Provider support assisting the tenant owner

Owner console → select company → Owner login recovery. Enter your current console password,
the verified reason and ticket/reference, then Request authenticator recovery. The existing
owner email receives advance notice and a cancellation link. No sign-in credentials change.
The customer can explicitly confirm cancellation from that link during the waiting period;
opening an email-preview GET alone does not cancel anything. Support can also cancel a pending
request with fresh password verification.

**Solo support waits at least 24 hours.** Re-check the case through established company contacts,
refresh the approvals and enter your current password and renewed verification reference to
complete it. A 15-minute recovery link is then sent to the existing email address. The request
expires after 48 hours. The same operator can complete the request; no second account/person
is needed, and adding another operator cannot bypass the waiting period. Changed owner/contact/
credential state, cancellation, replay and wrong-company approval are rejected.

The waiting period is deliberately enforced on the server; the browser cannot shorten it.
Recovery codes and assistance from another verified tenant administrator offer the normal
alternatives when the customer needs access sooner. Do not create a duplicate operator account
or weaken MFA to avoid the wait. A failed or expired request requires a new verified request.
If the process stops in `notifying` or `issuing`, investigate delivery and audit state before
starting another case; do not manually mark it approved.

For enrolled console operators, console writes also require a user-verified passkey within
five minutes; the recovery action still requires its explicit current password and verification
reference. Windows Hello and a separate backup key are implemented; real-device enrollment and
mandatory-policy rollout remain pending. Follow [console-passkeys.md](console-passkeys.md).
Advance notice, cancellation and the waiting period complement those controls; they do not
prove the human identity check or legal authority.

## Recovery link and completion

Working tenant email and a configured HTTPS public origin are required. A 32-byte random token
is emailed only to the account's existing email, expires after 15 minutes and is stored as a
digest. API responses, approval lists and logs do not return the bearer link. The app does not
guarantee provider delivery merely because a provider accepted a message.

Issuing a link leaves the old password, authenticator and sessions in place. A failed send
invalidates the pending link. On redemption, a single database transaction claims the nonce,
checks the recorded contact and credential fingerprint, saves the owner's chosen password,
removes the old factor/recovery codes, invalidates pending MFA sign-in challenges and reset
links, and revokes sessions. A notification is attempted through the existing email channel.
The customer receives no automatic full session.

The customer signs in with the new password and must enroll the authenticator before workspace
access, even when the workspace-wide privileged-MFA policy is off. Normal HTTP access,
WebSocket authentication and command-actor resolution reject incomplete recovery. Schema 84
adds the synchronized non-secret `users.mfa_recovery_required` flag so updated office hosts
also enforce this restriction after receiving it. Authenticator secrets remain cloud-only.
Completing enrollment clears the restriction, marks recovery complete and produces fresh
single-use recovery codes. Factor changes cancel outstanding assisted links.
Save these in the customer's password manager or another protected location.

## Operational limits and owner preparation

- Solo support needs no second operator. Document your authority, independent callback checks,
  24-hour review and escalation procedure. Complete Windows Hello/passkey console protection
  before claiming phishing-resistant support authentication. Never share console credentials.
- Configure and test the customer's existing email channel and the correct public HTTPS origin.
  Path tenancy uses TENANT_PATH_HOST; subdomain tenancy additionally needs APP_DOMAIN. Test
  actual delivery using staging accounts before relying on recovery.
- Publish the approved recovery procedure/contact, train support against social engineering,
  and decide verification-evidence retention and escalation ownership.
- The existing password-only reset tools are separate and preserve MFA. They now require fresh
  operator proof/reasons; an enrolled tenant administrator must also provide their existing
  factor. Older console temporary-password fallback is not the MFA-recovery mechanism.
- No-email, lost-email, inactive-account and sandbox MFA recovery fail closed. Escalate these
  cases; no new-contact or raw-link fallback is supplied by this implementation.
- Recovery/audit records are retained in the tenant/control-plane databases. They are not an
  externally immutable archive or a complete automated retention/legal-hold implementation.
- Recovery approvals are rate-limited per account within each process. Multi-replica stores,
  offline/partitioned site acceptance and real email delivery still require deployment evidence.
  A site disconnected before recovery cannot receive its restriction or revocation until it
  reconnects; this partition limit is not solved by the synchronized flag. Upgrade all hosts
  to schema 84 before rollout. Enrollment takes place on the cloud.

The design follows [OWASP MFA recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
and [password reset guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
The solo-support waiting period and specific timeouts are application design decisions, not claims
that OWASP mandates those exact values for every service.
