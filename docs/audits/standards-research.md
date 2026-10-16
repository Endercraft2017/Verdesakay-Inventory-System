# Standards research and implementation record

Reviewed 16 October 2026. Supplements the uploaded audit guide and the second-pass audit;
it does not replace their findings or imply certification. The guide is reference material;
the user's request determines the authorized work. Recommendations below are engineering
decisions unless identified as a requirement of a particular standard. No production access,
deployment or destructive data operation is implied by a standard's recommendation.

## Authoritative baseline

| Source checked | Application to this app | Verification and outstanding evidence |
|---|---|---|
| [OWASP ASVS 5.0.0](https://owasp.org/projects/asvs) | Use versioned verification requirements for authentication, authorization, validation, files, sessions and communications. Target applicable Level 2 controls for business and employee data; this is a target, not achieved assurance. | The existing handbook scorecard is not a complete ASVS crosswalk. Requirement-by-requirement applicability, evidence and independent review remain necessary before making an ASVS claim. |
| [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), final 2025 | Password-only accounts need a stronger password policy; AAL2 requires offering phishing-resistant authentication. TOTP is useful but is not phishing-resistant. | Current eight-character minimum and optional tenant MFA do not establish AAL2. Password policy and hashing migration, passkeys/security keys, console MFA and sensitive-action reauthentication remain engineering work. Existing credentials require a deliberate migration, not a login-breaking global validator change. |
| [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) | Factor replacement needs existing-factor verification; session possession alone is insufficient. Rate limits and session termination constrain account takeover. | Self-service disable/recovery already verify password and an existing code. This change adds a shared account failure budget and revokes other sessions when disabling MFA. Administrator resets, policy changes and out-of-band change notifications still need stronger protection. |
| [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | Prefer Argon2id for new password storage; bcrypt is a legacy choice with an input byte limit. | Current bcrypt cost 10 meets the legacy cost floor, but accepting up to 128 characters risks silent truncation beyond 72 bytes. Plan versioned hash verification and opportunistic migration; test Unicode, long passwords and old credentials. Do not claim NIST conformance while this remains unresolved. |
| [OWASP MASVS-STORAGE-1](https://mas.owasp.org/MASVS/controls/MASVS-STORAGE-1/) and [Android Keystore](https://developer.android.com/privacy-and-security/keystore) | Native persistent credentials need OS-backed protection, with backup, logout and device-lock behavior tested. | Native bearer compatibility is not secure storage. Audit localStorage, IndexedDB and queued credentials together; integrate a maintained native adapter and fail closed if unavailable. Hardware backing depends on the device and must be checked rather than assumed. Physical Android evidence and an actual iOS implementation remain missing. |
| [NIST SSDF 1.1 final](https://csrc.nist.gov/pubs/sp/800/218/final) | Secure development, artifact integrity, dependency response and reviewable release evidence. | Existing tests/scans contribute evidence, but branch protections, unresolved advisories, historical-secret response and release provenance remain open. [SSDF 1.2](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd) is listed as an initial public draft; do not present it as the final baseline. |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Target applicable AA criteria across complete workflows, including keyboard operation, focus, accessible authentication and errors. | Login axe checks and selected Playwright workflows are limited evidence. All-screen AA conformance and assistive-technology testing have not been established. |
| [OWASP GenAI project](https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/) | Treat retrieved text and model output as untrusted; enforce authorization outside the model, constrain tools and resource consumption. | The project now advertises a 2026 edition; older 2025 risk identifiers must retain their edition. Existing read-only production tools and bounded network access reduce risk; adversarial disclosure/output tests, privacy filtering and external audit integrity remain incomplete. A complete 2026 crosswalk has not been performed. |

Apple's [Keychain services](https://developer.apple.com/documentation/security/keychain-services)
was also checked as the intended iOS API. The research tool could not extract its detailed
JavaScript-rendered documentation; no specific accessibility/backup configuration is asserted
as verified from that page.

## Concrete change in this increment

`core/auth.routes.ts` now applies one shared account-and-tenant limiter to setup, enable,
disable and recovery-code replacement, after authentication and the existing online gate.
Ten failed verifications in fifteen minutes block further attempts, including attempts from
another session or another factor endpoint. Successful operations do not spend the failure
budget. A blocked request receives 429 and Retry-After before a factor is consumed or changed.
Disabling MFA with the current password and an existing single-use factor ends other sessions.
The verified current session remains active.

The limiter uses the existing express-rate-limit library rather than custom cryptography.
Its in-memory store is per server process: horizontal replicas need a shared limiter store
before claiming a deployment-wide ten-attempt ceiling. Restarting the process clears the
budget. Existing enrollment expiry/session binding and five-attempt login challenges remain.

Regression tests exercise cross-session/cross-endpoint blocking, non-consumption of a valid
recovery code when blocked, required factor proof, other-session revocation and retention of
the current session. The source-only route-class check and typecheck also pass. Full-suite
and Playwright outcomes are recorded in the validation results after completion.

## Priority and resolution

| Priority | Gap | Resolution and acceptance evidence |
|---|---|---|
| High | Console password-only authentication and sensitive administrator actions | Implement MFA/passkeys and server-bound fresh verification, protect recovery, test hijacked/old sessions and privilege boundaries. |
| High | Password-only minimum and bcrypt truncation | Centralize versioned modern hashes, preserve legacy verification during migration, enforce researched policy on new credentials, test Unicode/length boundaries and both account stores. |
| High | Native persisted bearer tokens | OS-backed vault plus startup migration and removal from queue/storage copies; test unavailable vault, logout, backup/restore and real-device extraction. |
| High | Historical credential and dependency gate failures | Revoke/rotate exposed credentials, investigate exposure, resolve or explicitly assess each advisory; never hide failures to obtain a green release. |
| Medium–High | API/error contracts, data lifecycle and AI disclosure controls | Extend strict schemas and safe errors; implement scoped export/deletion/retention with legal holds and auditable dry runs; adversarially test AI data access/output. Severity depends on affected route/data. |
| Medium | Accessibility coverage and release evidence | Expand complete keyboard/assistive workflows and signed release/restore evidence; selected browser scans cannot close these controls. |

These are open engineering tasks, not instructions for the owner to implement code. Account
access, legal/business retention choices, physical-device observation and live infrastructure
evidence may require owner participation. No claim that every standard or every app feature
has been audited follows from this research increment. Handbook scorecard totals remain the
previous snapshot; new findings above must be reconciled before final release sign-off.
