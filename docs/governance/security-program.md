# Security ownership and evidence program

Owner and deputy for security, privacy, infrastructure, engineering and billing: [OWNER: names and private escalation channels]. Maintain a restricted evidence folder with dates, reviewers and links; no secrets or production personal data in Git.

- Access: named individual accounts; least privilege; review platform, hosting, DNS, Git, DB, mail, AI and backup access quarterly and at role changes. Offboard immediately, revoke sessions/keys and verify. MFA on provider/operator accounts; app MFA remains a gap.
- Secrets: put production secrets in the host's private secret store, separate staging/production and tenant credentials, assign rotation/revocation owners. Keep encryption and offsite backup keys separately recoverable with restricted access. Review the historical token artifact, revoke the original session/related credentials and document exposure; deleting a file from HEAD does not revoke it.
- Vendors: register hosting/regions, SMTP, AI, push, QuickBooks, backup storage, DNS and monitoring; record data, DPA, subprocessors, security evidence, residency, outage/exit plan, renewal and contact. Verify provider billing caps and alerts before enabling AI.
- Vulnerabilities: triage critical issues same day, high within one business day; target remediation critical 72h/high 14d/medium 30d subject to documented risk acceptance. These are proposed internal targets, not customer SLAs. Track advisory, reachable path, mitigation, reviewer, expiry and patch date. Never silently ignore an audit failure.
- AI: production must set NODE_ENV=production, inspect enabled tools/provider, use least-privilege datasets and adversarial/cross-tenant evaluations. Read-only business mode does not eliminate disclosure or cost risk. Keep human review for generated reports/forms.
- Change control: reviewed PRs, protected production branch, required tests/secrets/dependency checks, build provenance and release/rollback record. Store approved risk exceptions with owner and expiry.
- Compliance calendar: monthly dependency/secrets review and billing check; quarterly access/vendor/retention review and restore drill; annual incident exercise, external penetration-test scope, legal-policy review and insurance assessment. Revisit on new regions/features/vendors/incidents.

Evidence register fields: control/check ID, status (verified/partial/unverified), evidence date/link, accountable owner, next due, exception and expiry. SOC 2 readiness can reuse these records; no attestation exists merely because this file exists.
