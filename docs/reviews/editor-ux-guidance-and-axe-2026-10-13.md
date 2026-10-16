# Editor UX guidance and axe result — 13 October 2026

Evaluated UI UX Pro Max at `7246805992a42b7bba37d4cac83b01416f0c6c44`:
reviewed its skill/search code, quick reference and focused UX searches for visible focus
and drag alternatives. Added an original project skill and CLAUDE routing rather than
importing a generated palette, framework or broad design-system reset. Provenance and
adaptation decisions are recorded in the skill's reference document.

Added local development dependencies Playwright and @axe-core/playwright and a repeatable
`test:editor:ux` command. The fixture server uses disposable DB/platform/uploads, real app
routes, a loopback port and real authenticated editor navigation. Artifacts remain in work/.

## Findings

The baseline had 13 repeated automated violations across 39 scans, not 13 unique defects:
- Six dialog scans included unnamed header Close buttons; fixed in shared UI.modal.
- Insert table also lacked associated Rows/Columns labels; fixed with explicit label links.
- Phone scans found undersized footer zoom targets and an obscured/small canvas corner.
  Zoom targets and invisible resize hit areas were enlarged while retaining compact visuals.
  The assistant bubble caused the obstruction; its existing action remains available in the
  editor rail, and the global floating launcher is hidden only while an editor is open.

Axe incomplete review also found unsupported labels on generic mode/word-count containers.
They now have appropriate group/status semantics. Mode selection uses aria-pressed; word
count has aria-live off to avoid announcing every keystroke.

## Result and limits

The strict pass completed 39 A/AA scans with zero automated violations and eight task checks
with no failures or runtime page errors. Typecheck and 131 focused frontend/editor regressions
passed. The browser task checks include actual keyboard focus and pointer dragging/undo.
Screenshots were reviewed in both themes and at phone/desktop sizes.

Axe still lists contrast cases requiring manual review, primarily gradients and non-text
symbols; they are retained in JSON, not silently excluded or certified. Real-user sessions,
full assistive-technology review and full ARIA toolbar navigation remain separate work.
The previously reported intermittent shared-save conflict is not changed or claimed resolved.
The harness uses a freshly seeded template; arbitrary authored document content can introduce
its own accessibility issues. This is a repeatable regression aid, not a full compliance claim.

Follow-up: the reproduced shared-save races and additional editor findings are addressed in
[the 14 October full scan](editor-full-scan-2026-10-14.md). The statement above records the earlier audit status.
