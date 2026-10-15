# Local audit evidence

All requests and screenshots use synthetic local fixtures. npm reports were
queried after explicit operator consent. Gitleaks output deliberately omits
credential values, matched source lines and historical author identities.

The ZAP High metadata alert is a confirmed local SPA fallback false positive;
see the regression in tests/production-security.test.ts and the narrative report.
Missing CSP remains open. Raw npm high-level gate remains nonzero for the
unpatched node-forge advisory; reachability analysis is in dependency-audit.md.

These artifacts do not establish live production controls or native-platform
release readiness. Screenshots show desktop inventory and mobile Home (390x844).

Only trailing whitespace was normalized in text/HTML tool outputs for version control.
