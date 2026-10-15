# Owner actions before production release

Status: conditional readiness, not an unconditional launch approval. The code/tests and documents in this branch reduce risk; external configuration, legal approval and several product gaps remain. Do not put passwords or production personal data into chat/Git.

## Release blockers — do these first

| Priority | You need to do | Completion evidence |
|---|---|---|
| High — live configuration | Provide the staging/production URL, hosting owner, region, real peak simultaneous users and critical workflows. A staging URL is a test copy; peak users means how many people use it at the same time. Authorize any remote load test separately. | Named target, capacity/latency/error goals, isolated staging |
| High — credentials | Review/revoke the historical committed bearer token in its original deployment; rotate any related exposed credentials. Review Git/host/DNS/operator access and enable provider MFA. | Private incident/access record, verified revocation |
| High — recovery | Configure persistent private volumes and encrypted offsite/versioned backups, separately recoverable keys, named operator/deputy and backup alerts. Choose tolerable data loss (RPO) and downtime (RTO), then perform the isolated restore drill. | Dated successful restore with measured RPO/RTO and attachment/business checks |
| High — app access | App MFA/step-up and native OS-secure credential storage are still missing. For restricted initial operation, document whether the owner accepts this risk and what network/device/access limits apply; otherwise implement before internet launch. | Reviewed implementation or explicit time-limited risk decision |
| High — legal/privacy | Fill every OWNER placeholder, confirm business name/address/contact/jurisdictions, actual vendors/regions/retention, refund/billing terms and rights/breach deadlines; obtain counsel approval. | Approved/versioned public policies, signed B2B DPA/MSA/SLA as needed |
| High — operations | Enable external uptime/error/disk/backup alerts and test delivery; set support/on-call contacts; configure HTTPS/proxy/WAF/origin access and verify Secure cookies from outside. | Alert exercise, TLS/config evidence, staffed runbooks |
| High — release controls | Protect production with PR review and required CI; review the unresolved dependency advisory and historical secret finding rather than bypassing gates. | Green required checks or documented scoped exception with expiry |
| High — AI | Set NODE_ENV=production (business mutations are then blocked); approve provider retention/training/region/DPA and hard billing caps. Leave AI disabled until reviewed. | Provider settings and spending alert test |

## Required owner decisions

- Public legal/privacy/security/billing/support addresses and document effective dates. Draft pages are linked in the product but explicitly unapproved; replace draft status only after approval.
- Employee monitoring/location notices, access to government identifiers/payroll, legal holds, statutory retention and secure rights-export delivery. The rights process is manual; this release does not promise automatic erasure.
- Supported platforms and devices. Run actual Windows Electron install/update/certificate smoke and Android/iOS release/signing/permissions/offline/shared-device checks before distribution. Browser tests do not certify these artifacts.
- Whether customer contracts require SSO/MFA, residency, BAA, independent penetration testing or SOC 2. These are not currently evidenced; do not promise them.
- Sales/support hours, severity targets, maintenance notices, recovery objectives and contractual availability/credits. Measure before promising.

## Follow-up engineering backlog

MFA/step-up and secure native storage; comprehensive per-endpoint strict schemas and adversarial scope coverage; hard AI per-user cost reservations and fuller AI audit/DLP evaluations; complete retention/rights automation after legal approval; real-device/offline recovery coverage; live-volume capacity tests and independent authenticated penetration testing. See the original 233-check scorecard and remediation supplement for status. Do not interpret a passing local test suite as completion of all checklist items.

## First operating week

Verify alerts and backups daily; review access, errors, failed logins, AI spend, disk growth and sync queues; run the critical workflow smoke after each change. Assign owners/dates to unresolved findings, preserve release evidence and schedule the first restore and incident exercises. Use the contract/data/security/runbook documents as operational records, not just files to keep in the repository.
