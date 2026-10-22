# Payroll copy and editor review notes — 22 October 2026

The final copy UI was inspected at 1440, 1024, 768 and 390 pixels in light and dark themes,
plus its blocked stale state. The editor Home view was also inspected in both themes at desktop
and phone widths. Existing Save/Close responsive bounds are checked at all four widths by the
editor task gate. These are reviewer observations of synthetic browser output, not participant
sessions or Windows/Android/printer/assistive-technology acceptance.

Findings corrected:

- The initial faded draft watermark failed contrast checks. Drafts now have a dark per-copy
  heading/wordmark on white, with a visible batch notice. Preview documents have main landmarks
  and a heading sequence compatible with the seeded layout. Arbitrary customer layouts are not certified.
- Resizing an already open preview could shrink the tile while retaining the old source scale,
  clipping the right side. A scoped ResizeObserver refits tiles and disconnects on closure.
  Bounding-box checks and updated screenshots show both columns preserved at each tested width.
  The physical-paper representation becomes small on narrow screens; this does not replace
  review of values in payroll or native print preview and real paper acceptance.
- Disabling Print after a source change lost keyboard focus. Focus now moves to the persistent
  error; Escape closes the preview and returns to the invoking button. Old money is cleared.
- The broader editor gate found label-content-name-mismatch in 52 of 94 scans. Visible text is
  retained in generated control names; File/Help and ribbon Hide/Show names match visible words;
  style cards expose their full text. An intermediate pass still found File in 37 scans; that
  explicit override was corrected too. No rule, tag or selector was disabled or excluded.

Incomplete automated checks remain explicit:

- Final editor results contain 90 color-contrast and 55 label-content-name-mismatch rule
  occurrences across scans (not necessarily distinct controls). There are 107 distinct
  rule/HTML pairs: 76 contrast nodes and 31 label-name nodes.
- Contrast reasons among distinct nodes: background images 37, gradients 8, partial obscuration
  15, overlap 4, and non-text glyphs 12. Representative theme/layout images were reviewed for
  readable controls and unobscured actions. Exact contrast under every native background,
  overlap, rendering state and browser remains a manual acceptance task; these are not promoted
  to automated passes or a WCAG conformance claim.
- Label-name incompletes concern symbolic controls such as Bold/Italic/Underline, indent/zoom
  and the symbol picker. Source names include the function/insert-symbol description. The W3C
  Label in Name guidance distinguishes symbolic text from human-language labels. Actual speech
  recognition, screen-reader announcements and symbol comprehension still need user testing.
- The payroll copy scan itself has zero violations and two gradient-contrast incomplete nodes
  (dialog heading and Print button). The themes/screenshots were inspected; exact native/assistive
  conformance is not established by this review.

Full raw editor results and concise copy scan evidence are retained. Authenticated trace ZIPs
stay in ignored work/ and are not published. The complete release remains on hold; this review
adds evidence without changing any whole-control status.
