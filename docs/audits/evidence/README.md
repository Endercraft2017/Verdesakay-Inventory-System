# Local audit evidence

All requests and screenshots use synthetic local fixtures. npm reports were
queried after explicit operator consent. Gitleaks output deliberately omits
credential values, matched source lines and historical author identities.

The ZAP High metadata alert is a confirmed local SPA fallback false positive;
see the regression in tests/production-security.test.ts and the narrative report.
Missing CSP was fixed; the remediation re-scan records broad HTTPS images and inline styles as residual Medium CSP findings. Raw npm high-level gate remains nonzero for the
unpatched node-forge advisory; reachability analysis is in dependency-audit.md.

These artifacts do not establish live production controls or native-platform
release readiness. Screenshots show desktop inventory and mobile Home (390x844).

Only trailing whitespace was normalized in text/HTML tool outputs for version control.

Remediation evidence files use the prefix `remediation-`. Original outputs are retained to distinguish audit stages. The updated source scan found only the reviewed fixed token alphabet; public, console and policy documents had no findings. Full history still has the real historical credential issue.


`alert-monitor-*` records the owner-alert observation increment: focused/full regression,
TypeScript/schema checks, actual disposable server startup, browser results and redacted
staged secret scan. Scope and verification distinguish completed checks from live release
gates. The initial browser label assertion failure is retained; its screenshot/trace paths in
raw output refer to transient work artifacts, not archived attachments. No deployment or
provider message was sent. Whole-control totals and release hold remain unchanged.
