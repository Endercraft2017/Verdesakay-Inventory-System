# Real-code UI scratch preview

Run from the repository root after `npm ci`:

```sh
npm run ui:scratch:batch
npm run ui:scratch:batch:serve
npm run test:ui:scratch:batch
```

The builder recreates `work/ui-scratch/index.html` from the current app source.
The server serves those same bytes on workspace loopback port 4178. That address
is not reachable at localhost on a remote user's computer. Deliver the owner-only
HTTPS Site specified in AGENTS.md and docs/design/ui-scratch-hosting.json.
This workspace's managed Chromium blocks direct `file://` previews; verification
uses loopback. Opening a downloaded file in another browser is not covered by
that loopback test.

Only `work/ui-scratch/` is disposable. Cleanup requires its matching ownership
manifest and refuses symbolic links and unknown files or empty folders. Keep
user files and retained investigation evidence elsewhere. The builder constructs
the new payload before clearing owned output. Templates, adapters and review
notes live here, outside generated output. A clean build removes old verification
evidence; the verification command generates and embeds fresh evidence.

For the current three Chunk 28 views, app scripts are copied verbatim and hashed.
The current list and optional photo presentations run against the same shared
shell/styles and row handlers for comparison. Update the selected sources, fixtures and notes
when reviewing a different chunk; no parallel hand-styled phone mock is used.

Preview adapters isolate transport, profile, stock records and storage in memory.
The actual picker, queue, saved-request model, handlers and Quick Orbit run in
the frames. Unsupported routes are explicitly labeled. Fixture reset and reload
start fresh sessions; they do not prove crash persistence. CSP forbids external
connections. No real account token or production record is embedded.

`test:ui:scratch` needs installed Chromium (`CHROME_PATH` can override its path)
and local process/network permission. It runs Playwright, axe, geometry/source
checks, guarded rebuild cases, then the actual app against an automatically
created and removed SQLite backend. The latter uses native IndexedDB to check
reload/replay, partial correction, competing tabs and authenticated image reads. Results and screenshots are
inside the generated HTML and `evidence/`. Physical devices, cameras, actual site
synchronization and observed employee task performance require separate checks.

The approved Batch Stock In/Out list/photo changes are registered in the mobile
bootstrap and v162 shell cache. The SO/CKD/JO preparation examples remain draft-only
review helpers; they are not imported into production routes and do not post stock.
Publishing this scratch Site never deploys the application. The original shared
Work review helper remains available through the ui:scratch:shared commands.

The default ui:scratch commands now review the current workflow Guides task.
Use the explicit batch aliases above to recreate this retained batch review.
The batch cleanup guard intentionally refuses output owned by another builder;
preserve unowned work and follow its ownership checks when switching reviews.

Current review: workflow step destinations, shared mobile palette and native
Products & BOM editor. Sample BOM PUTs change only isolated iframe memory; reset
clears them. `scripts/browser/mobile-bom-live-check.mjs` separately runs the actual
mobile editor against a throwaway SQLite/API server, including durable reload,
unknown-result retry, stale-definition refusal, empty BOM confirmation and new
product setup. Stock and existing job component plans are compared before/after.
