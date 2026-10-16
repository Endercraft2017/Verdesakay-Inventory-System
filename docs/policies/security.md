# Security information and reporting

DRAFT — owner contact and operating controls require approval before launch.

The application uses server-side authorization, separate tenant databases, hashed passwords, revocable sessions, HttpOnly browser-session cookies with CSRF request checks, nonce-based script CSP, request identifiers and private API cache controls. Production AI business mutations are blocked; reports and drafts remain available under the user's permissions. Deployment must enable HTTPS and protect database/upload/backup storage. Repository tests provide evidence of selected controls, not an independent penetration test or certification.

Known release limitations include optional tenant MFA enrollment, missing owner-console MFA/fresh step-up, native bearer storage pending OS secure-storage migration, a historical credential exposure requiring owner review, one remaining high runtime dependency advisory with no published patch at audit time (inspected verification path not invoked), and unverified live backups/alerts/restore capacity. Authenticator seeds are encrypted, recovery codes are hashed and one-use; deployment-wide enrollment must still be managed. Details and dated scope are in the repository audit; do not advertise controls that are only planned.

Report vulnerabilities privately to [OWNER: security address and encryption channel]. Include affected URL/version, minimal reproduction and impact; exclude other people's records and credentials. Stop when access is demonstrated, do not delete data or disrupt service, and coordinate disclosure. Scope/safe-harbor terms, acknowledgement target and update cadence: [OWNER]. No bug bounty or legal safe harbor is promised by this draft.

Hosting region, subprocessors, encryption/key ownership, incident contact, last independent test and restoration commitments: [OWNER: verified facts only].
