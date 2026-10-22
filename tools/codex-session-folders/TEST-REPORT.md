# Playwright verification

Final result: **8 passed, 0 failed** (7.2 seconds), Playwright 1.64.1 and its bundled Chromium, Linux, 2026-10-22.

The real unpacked Manifest V3 extension was loaded into Chromium using `launchPersistentContext`. The fixture intercepts a ChatGPT URL and supplies synthetic sidebar HTML. Chrome storage was real; no real OpenAI account was used.

Verified:

1. `/local/` and `/c/` recognition; folder creation/assignment; collapse after reload; link navigation.
2. Rename and duplicate-name validation; search; deleting folders unfiles links while preserving native rows and controls.
3. Dynamically added/removed rows, native title changes, sidebar replacement, and panel remounting.
4. Backup export/import using Chrome storage; invalid JSON; filtering unsafe URLs and treating HTML-like labels as text.
5. Changes propagate between tabs; keyboard creation works.
6. Native controls remain clickable; screenshot captured; panel foreground/background adapt to light and dark color schemes.
7. Panel waits for a late sidebar and ignores session links appearing only in conversation content.

8. Regression fixture with a separate global icon rail, broad outer sidebar wrapper, fixed chat history, and conversation pane: verifies deepest suitable container, collapsed initial height under 60px, no horizontal overlap, hidden/expanded sidebar transitions, and retained folder state.

Screenshot: `preview.png` is a synthetic fixture, not the user's account.

Limit: authenticated live Codex compatibility, branded browsers, multiple simultaneous edits, and future sidebar redesigns were not verified. This is a tested preview, not a guarantee that every production sidebar layout is supported.

Version 0.1.1 addresses the live overlap reported in the user screenshots. The regression reconstructs that layout; authenticated DOM access was still unavailable.
