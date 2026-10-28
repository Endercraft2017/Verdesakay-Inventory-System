> Historical implementation review. Superseded by the approved OTOM theme/showcase rollout on 2026-10-28. The native `product-showcase.js` and CSS were replaced by the reviewed, pinned Swiper controller (`website/showcase.entry.js`). Current runtime verification is in `tests/website-showcase.browser.mjs`; pinned research and coverage are in `docs/design/otom-theme-review.json`. The inquiry notification fixes from the live branch remain unchanged.

# Product showcase motion review

## Deeper work within the requested scope

1. A product designer would make the motion explain the module choice while preserving screenshot readability, loading recovery, keyboard focus and inquiry context.
2. Start with the six real local source-rendered captures, the current marketing markup, handlers and approved green palette. These captures contain synthetic demonstration records; they are not live ERP sessions.
3. Use a bounded native DOM/CSS component, Genjutsu's motion and CSS guidance, Taste's component-scope composition and browser critique, Hallmark's control-state and reduced-motion guidance, and Brag's product-specific pacing principles.
4. Browser observation at desktop and phone sizes, correct image/caption pairing, successful interaction checks, and a motion recording provide independent evidence. Mocked DOM tests establish state behavior; they do not certify real-device performance or usability.

Rewritten brief: Build a real timed 3D showcase of the existing OTOM product captures, with readable active media, stable captions, module selection, full-size links and a preserved inquiry path. Keep both brands' identities and existing business behavior. Verify automatic and manual motion, pause, reduced motion, responsive geometry, failed images, and script-free content before publishing the private review.

## Interaction thesis

The attendance cutoff, draft payslip and employee view take turns at the front of a shallow 3D stage before the warehouse, production and sales screens enter; the visitor can stop the tour and ask to see the selected workflow.

Allowed patterns: one timed 3D screenshot carousel, perspective on its adjacent screenshots, a transform progress line, restrained shadows on the floating image planes, numbered slide position in the transport, existing OTOM brand and page conventions.

The user's preceding request supplied the direction: a timed 3D screenshot carousel with the already approved green theme. This iteration implements that direction as a component; it does not deal a new palette or redesign unrelated routes.

## Source and stack

- Native HTML/CSS and browser JavaScript. No runtime package or paid service added.
- Six real WebP images already present in `website/assets/screens`.
- `product-showcase.js` builds image planes from the existing `data-tour-screen` metadata and emits `otom:screenchange` with `{id,title,brief,source}`. The page's `experience.js` continues to own inquiry-field suggestion and preserves edited visitor text.
- A desktop active image remains front-facing. Adjacent screens use 16-degree Y rotation and a 180-pixel depth offset; they are decorative and excluded from the accessibility tree.
- Automatic transitions last 700 ms, separated by a 5,500 ms scheduling interval. Manual pointer transitions take 380 ms; keyboard changes and reduced motion are immediate.
- The stage reserves the same aspect ratio across slides. Portrait employee screenshots keep their own proportions inside it.

## Skills actually applied

- Genjutsu `cast`, `css-native`, `motion-principles`, and easing guidance: native APIs matched to this existing stack; intentional depth; separate cinematic and frequent-input timing; transform/opacity animation; pause and reduced-motion handling. Its proposed direction/preview gates are already answered by the user's preceding carousel instruction and existing private-preview preference. No additional dependency was needed.
- Leonxlnx Taste Skill: its explicit single-component exception preserves the surrounding design and skips a new direction draw. The real screenshots form the main visual; caption and control geometry remain stable while the images move. Browser critique is owned by the final review task.
- Nutlope Hallmark: component scope preserves brand tokens; the controls cover default, hover, focus, pressed, disabled and loading behavior; error recovery retains the previous correct view. No new page-level scaffold or random theme was applied.
- latent-spaces Brag: its planning principles inform a concrete product story and readable holds. This is an interactive browser component, not a rendered Brag/Hyperframes launch video. No Brag video-render pass is claimed.

## Verification completed in this implementation task

`node --test tests/product-showcase.node.mjs tests/website-acquisition.node.mjs`: 19 passing tests.

Nine new DOM-state tests check six real source-image references, accessible active slide, no-JS links, visibility-gated timed advance, matching caption and full-size link, first-pointer-click Pause/focus regression, explicit Play, manual stop, inquiry edit retention, keyboard selection, runtime reduced-motion changes, failed-image preservation, stale-load race suppression, hover suspension tab visibility, and horizontal-versus-vertical touch gestures.

The ten existing acquisition tests pass without API or contract changes. JavaScript syntax checks pass. These tests mock images, visibility and timers; actual decoding, perspective, page geometry, browser input, and frame rendering require the separate browser review. This implementation task did not run browser automation or a production workflow.

## Limits

The showcase animates still screenshots. It does not simulate button clicks inside those screenshots or claim a completed live transaction. Sales remains visibly in development. The source marketing page's existing auth and inquiry handlers are untouched; real email receipt is still a separate verification item. Reduced-motion users receive a static, manually selected view. Browsers without IntersectionObserver retain manual selection and do not start autoplay.

## Managed browser review completed

The parent reviewed the generated private preview in Chromium through Sites/CUA. The page source, CSS and handlers were reused; only preview paths, a collapsed review note, analytics removal and isolated transport differ. All six screenshot assets decoded at their actual dimensions. Screenshot perspective, manual selection, caption/full-size-link pairing, selected-workflow inquiries and preservation of an edited OTOM inquiry were checked. Automatic slide changes were observed after returning the stage to view; source tests separately exercise exact timer scheduling and interruptions.

Same-origin frames rendered the actual pages at outer widths 360, 390, 768 and 1440 pixels. Content widths were 345, 375, 753 and 1425 due to browser scrollbars. Neither marketing page had body overflow at those sizes; all six topic buttons were 44 pixels high. The 360-pixel AFK frame was checked again after navigation settled. These are browser frames, not physical devices.

AFK selected Production carried `intent=otom&screen=production` into the contact form and suggested the matching workflow. OTOM selected Production opened the matching inquiry; a manually edited workflow remained after selecting Sales. Preview transport blocks delivery and sign-in.

Independent review of the two actual desktop screenshots found no blocking visual issue: a sharp central screen, visible recessed planes, stable caption and distinct existing brand palettes. Still captures do not prove frame rate. Reduced-motion changes, touch direction, image errors, stale-load races and hidden-tab timing are covered by DOM-state tests with mocked platform signals; an OS-level reduced-motion or physical-device test was not performed in this browser review. No current hosted Lighthouse/axe or live email result is asserted.
