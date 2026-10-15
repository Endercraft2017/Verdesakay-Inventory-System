# Incident and breach response

DRAFT — incident lead/deputy, security/privacy/counsel contacts and communication channels: [OWNER]. Establish out-of-band access if the main service is compromised.

1. Open a restricted incident ID/timeline; capture UTC and local times, affected tenants/assets, request IDs, detection source and initial impact. Preserve logs/snapshots with access control and chain of custody; do not copy credentials into tickets or Git.
2. Triage severity: account takeover/cross-tenant access/financial data loss or ongoing disclosure is urgent. Name the incident commander, technical lead and communications lead. Contain by revoking affected sessions/keys, isolating hosts or disabling the affected integration; preserve evidence and continuity of essential operations.
3. Determine entry point, affected versions, data categories/subjects/regions, time window and access/exfiltration evidence. Assess the historical token's original deployment and revocation. Rotate exposed credentials and dependent keys safely; deletion from history alone is insufficient.
4. Privacy lead and counsel assess notification duties for the actual jurisdictions, contracts and facts. Record awareness time and applicable deadlines; GDPR's conditional 72-hour regulator deadline is not a universal rule. Prepare approved regulator/customer/individual notices with facts, likely consequences, mitigations and contact. Record who approved and when; do not make unsupported statements that no data was accessed.
5. Eradicate, patch, restore from a verified safe baseline, reconcile business operations and monitor recurrence. Technical lead verifies fix, privacy lead completes notices and follow-ups, commander authorizes closure. Keep evidence under the approved retention/legal hold.

## Postmortem template

Incident ID/date/severity/lead; customer and data impact; detection and response timeline; root causes and contributing controls; what worked/failed; recovery/RPO/RTO; notification decisions and evidence; corrective actions with owner/due/verification; lessons and runbook updates. Use a learning review without hiding accountability. Exercise credential leakage and host-loss scenarios before launch and at least annually; record measured response gaps.
