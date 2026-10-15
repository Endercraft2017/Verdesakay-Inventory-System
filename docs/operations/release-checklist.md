# Release decision record

Release/commit [OWNER]; date/time [OWNER]; operator/reviewer [OWNER]; environment and customer scope [OWNER]. Keep this record with the deployment evidence. An unchecked applicable blocker means hold release or record an explicit approved risk exception with expiry.

- [ ] Confirm exact source commit, approved PR and required CI results; investigate dependency/security failures separately from passing application tests.
- [ ] Confirm NODE_ENV=production, supported Node version, private environment secrets, fresh bootstrap password and distinct staging/production credentials.
- [ ] Verify external HTTPS, trusted proxy hops, Secure/HttpOnly/SameSite cookies, CSP/HSTS and blocked direct storage/DB access; test owner-console restrictions.
- [ ] Verify tenant isolation and least-privilege access with actual supported clients; record MFA/native storage disposition and historical credential revocation.
- [ ] Confirm provider billing caps, alerts and approved data-processing terms before enabling AI/integrations; verify production AI cannot mutate business records.
- [ ] Capture encrypted recoverable backup of every affected DB and uploads; verify offsite copy/key availability and a recent successful full restore drill.
- [ ] Review schema compatibility, tenant migration plan, write/sync reconciliation and rollback trigger. Record the compatible rollback application/data snapshot.
- [ ] Run staging critical workflows: account login/logout/revocation, inventory receipt/adjustment, orders/production/QC/release, HR/payroll review, upload/download/print and offline replay under the correct actor, as applicable to licensed modules.
- [ ] Review target-volume latency/error/capacity results and representative devices. Do not substitute the small local read probe for a live capacity commitment.
- [ ] Fill and approve legal/privacy/refund/AI/security documents; execute applicable B2B agreements; establish rights-request and breach contacts/deadlines.
- [ ] Test external alert delivery, backup failure/disk alerts, on-call/deputy access and customer support/status communication.
- [ ] Confirm native/Electron signing/install/update/certificate/device testing if distributing those artifacts.
- [ ] Record go/hold decision, known limitations, explicit exceptions, customer/maintenance communication and next verification time.

After deployment: verify health plus authenticated business smoke, request IDs/errors, queue/sync lag, disk growth and backup schedule. Stop/rollback on tenant leakage, credential compromise, financial/stock corruption or unacceptable error/latency; invoke incident lead and preserve accepted writes. Record actual outcome and retrospective actions.
