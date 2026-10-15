# Dependency audit — 16 October 2026

The operator explicitly approved sending dependency names/versions to npm's advisory API. Root, launcher and mobile lockfiles were scanned, compatible fixes applied, and the remaining reachable major-version issues addressed deliberately. No forced blanket audit fix was used.

| Lockfile | Before | After | Remaining interpretation |
|---|---|---|---|
| Root | 1 Critical, 8 High, 13 Moderate | 0 Critical, 1 High, 8 Moderate | High is node-forge signature-verification advisory with no upstream fix; the affected verification path is not used by application code. Eight Moderate entries are the Electron builder downloader/logging dependency chain |
| Launcher | 1 Critical, 18 High, 4 Moderate | 0 Critical, 0 High, 8 Moderate | Maintained Electron/build tooling replaces obsolete Electron 31/builder 25; remaining Moderate chain is build/download tooling |
| Mobile | 0 Critical, 0 High, 3 Moderate | 0 advisories | Scoped xcode → uuid override retains the CLI version and fixes UUID bounds issue; xcode generateUuid API compatibility and build:web verified |
| Root runtime only (`--omit=dev`) | Not separately recorded before fixes | 0 Critical, 1 High, 0 Moderate | Same node-forge advisory, discussed below |

Counts are npm's vulnerable-package counts, including propagated dependency entries, not counts of unique CVEs. Results reflect the advisory service at scan time and do not include vendored browser libraries or compiled native artifacts.

## Applied changes

- Root locked Express **4.22.3**, proxy-addr **2.0.8**, Multer **2.4.0**, Nodemailer **10.1.1**, Vitest **4.1.12** and compatible transitive fixes. Nodemailer needed a deliberate major-version update and its Transporter type import was adapted; SMTP/messaging and full app tests are rerun.
- Launcher moved from Electron **31** / electron-builder **25** ranges to Electron **^44.7.2** / electron-builder **^26.15.3**. This fixes the obsolete runtime and Critical tar/build-chain findings. Windows packaging, code signing and installation remain unverified here; do not publish a launcher binary solely from a lockfile scan.
- Mobile uses a targeted `xcode.uuid: ^11.1.1` override. The used CommonJS v4/24-character UUID generation API was exercised successfully against the installed overridden package; the web bundle build also passed. Android/iOS packaging and device testing are separate release gates.

## Unpatched node-forge advisory: reachability exception

**GHSA-86w9-cpqp-85rv** affects RSA PKCS#1 v1.5 **signature verification** in node-forge through 1.4.0; npm reports no fix. Repository references to node-forge are confined to `src/desktop/lan-tls.ts`, which generates RSA keys, constructs/parses local certificates and **signs** certificates. No application call to forge RSA signature verification, certificate-chain verification or forge TLS exists. Network TLS authentication is handled by Node/OpenSSL. The LAN certificate tests exercise generated certificates with Node crypto/TLS primitives.

On that inspected call graph, the vulnerable verification operation is not reachable from a remote request or this application's LAN trust decisions. This is an **unreachable-path assessment**, not a vendor patch or a general assertion that node-forge is safe. Monitor for an upstream fix; replace/update it when available. Any new forge verification call invalidates this assessment and must block release. Do not use it to implement trust checks in future work.

The raw `npm audit --audit-level=high` CI command still reports this High until it is patched or a repository owner adopts a narrowly scoped exception policy. No broad suppression, automatic downgrade or misleading zero-vulnerability report was added.

## Remaining Moderate build-tool chain

The remaining root/launcher findings propagate from `sprintf-js` through roarr/global-agent/@electron/get into Electron builder packaging/download tools. They are not in the Express runtime dependency tree. npm suggests moving electron-builder to 26.5.0 to avoid this chain, a downgrade relative to the installed 26.17.0; that can reintroduce newer packaging issues and was not applied blindly. Use controlled build inputs, do not build untrusted projects with secrets, and track the upstream chain. They remain documented findings, not silently cleared advisories.

## CI and limitations

CI includes advisory scans of all three lockfiles. Its status must be reviewed after push; branch protection/required checks and secret-exposure remediation are not established by adding workflow files. Full-history Gitleaks also retains one historical bearer artifact finding. A successful local unit/browser run does not override security gates, an unsigned native build, or the other readiness report blockers.
