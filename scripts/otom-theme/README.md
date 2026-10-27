# OTOM theme and screenshot showcase

Review branch is based on PR #2, not deployed to the application. Shared semantic
light/dark colors live in `public/css/otom-tokens.css`; legacy desktop/mobile
variables map to those values. Layouts, permissions and business handlers remain
owned by their existing modules. AFK³ parent pages do not load OTOM tokens.

Build the pinned Swiper bundle after editing `website/showcase.entry.js`:

    node scripts/otom-theme/build-showcase.mjs

Four modules are included: Coverflow, Autoplay, Navigation, A11y. Pagination was
evaluated; existing grouped selectors retain the HR-first story and form wiring.
The bundle and vendor CSS/license are checked in because marketing has no build
step at runtime. Swiper 14.3.0 is MIT licensed. No framework was added.

Generate fresh disposable real-backend captures, then export responsive WebP:

    node scripts/otom-theme/capture.mjs
    node scripts/otom-theme/images.mjs

`--before` captures require the baseline CSS from PR #2. Use an isolated baseline
checkout/restore; do not overwrite unrelated source changes. Fixtures create real
synthetic employees, draft payroll, exact component stocks, a production job and
an open sale; no production connection or payment/approval is made. The manifest
records original PNG, responsive WebP and source-style hashes.

Run the browser checks (system Chromium, local servers):

    node tests/website-experience.browser.mjs
    node tests/otom-theme-ui.browser.mjs
    node tests/website-showcase.browser.mjs

Playwright's ffmpeg binary is required for recording; use its existing install or
`PLAYWRIGHT_BROWSERS_PATH` pointing to a project-local cache. The suite creates an
18-second MP4 through system ffmpeg. Generated evidence is under `work/otom-theme`.

Build the guarded real-source private review after evidence passes:

    npm run ui:scratch -- --review=otom-theme

This uses the existing scratch ownership guard. Marketing source is copied with
relative assets; a review-only fetch transport blocks business writes. Evidence
and before/after comparisons are linked from `review.html`. Publish only under
`/reviews/otom-theme/` in the existing owner-private scratch Site; preserve its
root, other review directories and audience. App production rollout is separate.

Limitations: automated Chromium, emulated touch, synthetic records and injected
visibility-change event. No physical device/camera, operating-system tab switching,
production data or staff acceptance claim. Contrast/axe samples are not a full
accessibility certification or an exhaustive ERP page audit.
