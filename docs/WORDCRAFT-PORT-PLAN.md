# Wordcraft port into the existing document studio

## Objective and scope

Port useful Wordcraft behavior into our vanilla JavaScript editor and TypeScript/Express
system, incrementally. Keep SQLite, existing template HTML, form/default assignments,
permissions, revision checks, offline behavior, field tokens and grid printing. This is a
multi-phase implementation, not a claim of full Word or Canva parity or a Rust/WASM embed.

Source reference: https://github.com/storytold/wordcraft at
`d8940cb317aee9ee9d8921d878c1c2f2329baf42` (reviewed 2026-10-12).
`crates/engine/src/lib.rs` supplies the command registry reference;
`crates/engine/src/session.rs` supplies the reference behavior for selection-aware undo,
typing groups and command boundaries. Its document, layout and format crates are references
for later phases. Upstream is alpha: validate behavior ourselves, especially DOCX and layout.
Use MIT licensing for any translated/copied source and retain its copyright/license notice.
Do not import upstream branding or bundled assets without their individual license review.
The initial browser-history adaptation is independently implemented against our DOM model.

## Delivery rules

- Work in phase order. Record delivered slices and unresolved items here on every handoff.
- Finish and verify a slice before adding controls for the next capability.
- Keep existing HTML readable and reversible; new document models need lossless adapters
  and fixture-based migration checks before replacing the current saved representation.
- Keep UI in our existing components/tokens; no React, Tailwind or Rust runtime conversion.
- Multipage designs must never enable grid/continuous printing, in UI or backend.
- Verify keyboard, caret, undo/redo, save/reopen and print behavior with real browser input.
- Shared publication must still use current permissions and revision/conflict protection.
- A shipped slice is not completion of its entire phase. No full-parity claims.

## Phases and acceptance gates

| Phase | Work | Acceptance gate | Status |
|---|---|---|---|
| 1. Editing foundation | Selection bookmarks, input transactions, composition safety, command dispatch, shortcuts, reliable clipboard and list editing | Undo/redo restores content and selection; unrelated edits are separate; IME creates one edit; chips survive; browser and regression checks pass | Slices 1–3 verified; acceptance consolidation next |
| 2. Document model and formatting | Typed blocks/runs, styles and inheritance, semantic positions, HTML adapters, progressively replace execCommand | Existing template corpus round-trips without lost fields/styles; commands work without DOM-dependent state | Planned |
| 3. Tables and page layout | Word-style cell/row/column commands, split/merge, repeat headers, sizing, section/page flow, wrapping and running content | Table and section fixtures match preview/print; no lost rows, extra blank sheets or multipage grids | Planned |
| 4. Review and references | Structural/format revisions, comments anchored to model positions, footnotes/endnotes, references and contents | Accept/reject and undo preserve structure; references survive save/reopen and print | Planned |
| 5. Document interoperability | DOCX model mapping and round-trip corpus; explicit unsupported-feature preservation/reporting | Real Word/Docs/LibreOffice fixtures inspected for content and page fidelity; originals recoverable | Planned |
| 6. Design tools and hardening | Model-backed objects/layers, accessible keyboard workflows, performance, mobile input and release audit | Representative long docs and mixed designs pass save/print/device checks with documented limits | Planned |

## Phase 1 slices

1. Selection-aware history and explicit edit boundaries; native undo input routing;
   defer DOM normalization during composition. **Completed and verified.**
2. Central command registry (enabled/active state, keyboard and toolbar dispatch), migrate
   formatting commands incrementally; predictable focus after dialogs. **Completed slice.**
3. Clipboard transactions and model-ready text/list commands; cover Enter/Tab, deletion at
   boundaries, atomic tokens, selection direction and accessible navigation. **Implemented.**
4. Consolidate acceptance fixtures and hand off to phase 2. Composition with tracked
   revisions remains unsupported until the tracking implementation can preserve it safely.

## Current verification and handoff

Baseline: production commit `37e6dea`, HTML snapshot history, browser execCommand formatting,
paragraph-only tracked changes. This foundation release is being integrated into the
production branch; record the commit and deployment result at release.
Tests/results and exact remaining next action are recorded here after the slice is verified.

### Phase 1, slice 1 — implementation record

Implemented locally:
- Selection bookmarks preserve anchor/focus direction, adjacent text-node normalization,
  empty cells and positions around field chips across HTML snapshot restoration.
- Input kinds and caret movement delimit undo groups; toolbar activation and paste create
  boundaries. Native history input and keyboard shortcuts use editor history. Undo is
  available immediately after the first edit and redo clears after branching edits.
- Composition defers normalization, autocomplete and shared snapshot reconciliation;
  committed text forms one undo step. In-flight room responses are reconciled later.
- Undo refreshes word count and schedules shared recovery, preserving the publication path.
- Mobile shell cache bumped for the shared editor asset changes; no mobile visual redesign.

Verified: real Chromium replacement typing, backwards selection restoration, redo caret,
Japanese IME via the browser composition API, and saving through the shared form/template
API. Existing browser checks also verify two-page preview/PDF, section sizes, contents
page numbers, tracked text, disabled multipage grids and Save at a narrow viewport.
Focused regression tests include composition-time server responses and immediate Undo.
Full-suite result: 2,203 tests passed across 213 files; typecheck passed.

Follow-on action at the slice-1 checkpoint: phase 1, slice 2, command and dialog dispatch
(now implemented below). Do not begin the block/run model migration until phase 1's
clipboard/list behavior is verified. No WASM runtime, schema changes or production
rollout are part of this slice. Upstream source is a pinned behavioral reference; no
upstream assets or translated Rust code have been bundled in this slice.

### Phase 1, slice 2 — completed and verified

Current task: central command dispatch for toolbar/keyboard formatting, enabled/active
state and selection preservation across controls/dialogs. Retain the browser formatting
adapter until phase 2 replaces commands incrementally with the document model.


Slice-2 implementation:
- Stable command identifiers wrap the current browser formatting adapter: inline styles,
  paragraph/list formatting, font/size/color, link/HTML insertion and undo/redo.
- Toolbar and Ctrl/Cmd+B/I/U share command dispatch. Browser undo input and Ctrl/Cmd+Z/Y
  use registered history commands; availability follows the actual history stack.
- Commands capture/restore backwards selections across focus changes and refuse locked
  selections. Editable text islands inside floating objects remain format-capable.
- Toolbar formatting buttons publish active state through `aria-pressed`.
- Insert/link/paragraph dialogs restore document focus on confirmation/cancellation.
  Failed browser commands do not report successful edits.

Verification: seven focused command tests; existing editor regression tests; real Chromium
Ctrl+B with undo/redo, font changes, link selection/focus and immediate typing after the
dialog, shared save, plus the unchanged multipage print/grid/browser checks.
Full-suite result: 2,210 tests passed across 214 files; typecheck passed.

Next action: **phase 1, slice 3**, clipboard and list transactions (Enter/Tab, boundary
deletion, atomic field tokens and accessible navigation). Document-model migration is
still phase 2 and must preserve existing template HTML and bindings.


### Phase 1, slice 3 — clipboard and keyboard editing

- Copy writes canonical template HTML and plain `{{field}}` tokens; paste rebuilds atomic
  field chips, sanitizes rich HTML and treats ordinary plain text as text.
- Cut uses the command transaction and refuses selections crossing locked content.
  Tracked text cut/paste remains owned by the existing review input handlers.
- Tab/Shift+Tab changes list nesting. Native Enter continues lists and exits empty items;
  paragraph input creates its own undo boundary. Composition and review guards remain.
- Table Tab traverses physical cells once (including merged spans), skips locked cells,
  and adds a data row at the end with the logical column width. Header-only tables gain
  a body row. Row creation and its resulting caret are undoable together.
- Arrow movement and Backspace/Delete treat adjacent field chips and checkboxes atomically.
  Tracked structural/token edits remain blocked until the revision-model phase.

Verified in Chromium: canonical copy/paste and whole-token cut/undo, native list Enter and
empty-item exit, Tab nesting/outdent, merged-cell table navigation/new row, shared save.
Previously verified command, IME and print checks were rerun on the latest production code.
Newer production security patches and side-panel changes are retained. Browser fixtures and
collaboration fixtures use valid test passwords under the stronger password policy.
Release checks: full run passed 2,223 tests with one stale password-minimum assertion
from production. The assertion now matches the eight-character policy; all 38 tests in
the affected unit/editor/collaboration files pass on rerun, including the additional
atomic-token caret regression. Typecheck and all four browser checks pass. Mobile
shared-asset cache version: v75. Delivery target: restructure/module-architecture.

Next: phase 1 acceptance consolidation, then phase 2's typed block/run model and lossless
HTML adapters. Keep existing design pages, tables and template bindings covered by fixtures.
Do not describe this release as a full Wordcraft engine conversion.

Final integration also preserves the newer personal checklist/scheduling and HR-warning
changes on production; the editor model and storage schema are unchanged by this port.

Final integration check: typecheck passes and all 74 tests across the seven affected
editor/collaboration, notes, HR, sync and unit files pass.
