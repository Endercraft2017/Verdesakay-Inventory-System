# Playwright verification — v0.2.0

Final result: **11 passed, 0 failed** in 10.8 seconds, Playwright 1.64.1 with its bundled Chromium on Linux, 2026-10-23.

The actual unpacked Manifest V3 extension was loaded with `launchPersistentContext`. Real Chrome extension storage and temporary profiles were used. Network routing supplied synthetic ChatGPT pages; no real account or authenticated conversations were used.

Verified:

1. `/local/` and `/c/` session recognition, folder creation/assignment, collapse/reload, and navigation.
2. Rename/duplicate-name validation, search, unfiling on folder deletion, and preservation of native controls.
3. Dynamic and virtualized sidebar rows, title changes, replacement, and remounting.
4. JSON backup export/import, invalid JSON, unsafe URL filtering, and inert HTML-like labels.
5. Updates between browser tabs and keyboard folder creation.
6. Native controls and light/dark color schemes.
7. Delayed sidebar mounting and ignoring session links in conversation content.
8. Separate global rail/chat-history/main-pane layout: compact initial height, sidebar boundaries, narrowing/hiding/restoring, retained folders.
9. Hide button, restore launcher, persistence across reloads, Escape, and keyboard focus recovery.
10. Real pointer move/resize, saved position and dimensions after reload, and viewport shrinking to 400×400 with reachable close/restore controls.
11. Keyboard move/resize, docking, retained folders after sidebar removal, and restoring in floating mode when the native sidebar is unavailable.

`preview.png` shows the floating glass panel. `preview-docked.png` shows its compact initial docked state. Both are synthetic fixtures.

Limits: the user's authenticated live DOM and Opera were not directly tested. Changes to Codex markup may require selector adjustments. Simultaneous edits in different tabs remain last-write-wins. Passing fixture tests does not establish live compatibility.
