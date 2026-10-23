# Dependency review, installation and re-evaluation

The formatter advisory that motivated this investigation was withdrawn upstream.
**No parser override or dependency upgrade is delivered.** package.json and
package-lock.json remain identical to production commit 212ff016. The candidate
and its successful tests are preserved solely as experiment evidence.

## Install and verify the delivered graph

Use manifests from the same reviewed commit and a clean npm ci. The audit used
`npm ci --ignore-scripts --no-audit --no-fund`; production-only comparison installs
also used `--omit=dev`. Disabling installation scripts does not establish a complete
Electron/native build. Follow the separate reviewed build/signing procedure.

`npm ls mammoth argparse sprintf-js node-forge --omit=dev --json` should show the
unchanged Mammoth 1.13.0 → argparse 1.0.10 → sprintf-js 1.0.3 chain and node-forge
1.4.0 for this lock. Do not copy the discarded candidate override into deployed settings.
Keep dependency license notices in distributed artifacts.

On 23 October, both `npm audit --omit=dev --json` and an explicit full-root
`npm audit --include=dev --json` return **one high / zero moderate**, exit 1.
The high Forge finding remains open. The moderate entries disappeared from the
advisory feed after withdrawal; they were not fixed by a delivered code change.
A failed advisory lookup is not a clean result. Save timestamps, raw reports and
lock/commit hashes when reassessing; do not compare counts without checking causes.

## Recheck a future fix

Inspect upstream advisories, patch/release source and installed callers first.
Demonstrate the applicable failure and define expected behavior before changing
versions. Review a minimal lock diff, perform clean installs and run appropriate
conversion, permissions, error-redaction, browser and broader regression tests.
Never use `npm audit fix --force`, hand-edited node_modules or suppressed findings
solely to make a scanner green. A major transitive override needs compatibility
evidence and an ongoing maintenance reason, even when its initial tests pass.

The retained candidate exercised Mammoth's actual CLI, including style maps,
HTML/Markdown, spaces in paths, image output and rejected arguments. Its argparse 2
used v1 compatibility that argparse 3 removes. It is not an approved upgrade recipe.

The delivered browser regression submits malformed DOCX, preserves the draft,
retries a real document, reviews the preview before Apply and undoes the local edit.
Existing focused application regressions can be run with:

```sh
npx vitest run tests/document-conversion.test.ts tests/document-conversion-errors.test.ts tests/messages.test.ts tests/doc-editor-studio.test.ts
```

## Failure and recovery

Stop rollout of an artifact whose installation, graph or conversion fails. Preserve
its dependency tree, commit/lock hashes and a synthetic reproduction. Keep real
Word files, chat attachments, authenticated browser traces and secrets out of public
reports. Restore a complete verified artifact rather than mixing manifests with old
node_modules. This documentation/test increment has no schema/data migration.
Do not roll back payroll/email schema or data as part of dependency investigation.

The high node-forge finding has no offered upstream fix in the final report.
Restricted observed use is not a release exception. Independent review, historical
secret revocation and all existing production gates remain open. The owner is not
being asked to implement missing engineering or approve this discarded candidate.
