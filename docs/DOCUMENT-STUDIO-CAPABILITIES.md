# Document studio: balanced Word and Canva implementation

The product direction is a balanced document and visual-design editor. Full Word/Canva
parity is not implemented. This inventory separates delivered tools from remaining work.

## Delivered

- Theme-consistent editor chrome, light/dark modes and responsive tools.
- Inline text formatting, headings, lists, paragraph spacing/indentation, find/replace,
  browser spellcheck, document outline and word count.
- Table insertion, row/column editing, merge/split, drag column sizing, equal columns,
  styles, borders, padding, alignment, header rows and row print settings.
- Images, text boxes, basic shapes, object positioning/sizing, rotation, opacity, corner
  radius, snap guides, page alignment, distribution, grouping, layers, locks/visibility.
- Page setup, page breaks, running headers/footers, page numbers, measured pagination,
  print previews, PDF via the browser and configurable grid printing.
- Data fields, repeating rows, conditional content, formulas and real-record preview.
- Local/server recovery, undo/redo, saved history, shared editing, conflict resolution,
  comments and reusable company assets/styles.
- Multiple layouts per form and explicit form/built-in defaults.
- DOCX content import with a conversion preview, append/replace, original-file download,
  undo and conversion notes; DOCX export with supported document formatting and embedded
  raster images. Word layouts are not a lossless representation of freeform HTML designs;
  repeating/conditional template logic requires HTML export for reuse.
- HTML document export and a File-menu shortcut to print/PDF preview.
- Heading-linked contents lists with live title updates, measured print page numbers and
  grid-copy-specific anchors; genuine Word contents fields that refresh in Word.
- Picture crop-to-fill, focal points, circle/ellipse/diamond masks, corner radius,
  brightness/contrast/saturation/grayscale, alternative text and image replacement.

- Explicit visual design pages: add, duplicate, rename, reorder, delete and independent
  backgrounds. Objects move and resize relative to their own page. Multipage designs and
  forced page boundaries disable grids in the editor, validation and legacy print paths.
- Named document styles with shared updates and direct-format overrides, plus hierarchical
  numbered lists. Definitions travel with the template and become Word paragraph styles.
- Sections with columns, gaps, backgrounds, page dimensions, margins and page starts.
  Single-column sections use measured sheets; column sections use native browser pagination.
- Linked numbered notes in the editor; genuine footnotes in Word export.
- Paragraph text revisions with reviewer attribution, accept/reject (individual/all), undo
  and session-opening text comparison. Prints use proposed final text; editable DOCX retains
  revision markup. Structural edits still use undo/history, not tracked revisions.
- Word export includes running headers, footers, page fields and section properties.

## Remaining document capabilities

1. Broader DOCX layout/style fidelity, including running fields, custom CSS, linked images
   and freeform graphics. Current conversion reports its limitations and retains originals.
2. User-created style families, advanced numbering schemas and language-aware typography.
   Named styles, hierarchical lists and measured/Word contents are implemented.
3. Bottom-of-page browser footnotes, endnotes, citations and bibliographies. Editor notes
   are linked at the document end; Word export uses actual footnotes.
4. Structural/formatting revisions, composition-input tracking and detailed saved-version
   comparison. Paragraph text review and block-anchored comments are implemented.
5. Accessible keyboard navigation and richer language-specific spelling tools.

## Remaining design capabilities

1. Mixed-size visual design pages and animation. Explicit pages/backgrounds are implemented.
2. Advanced image-editing handles, additional masks/filters and visible figure captions.
   Basic crop, masks, focal points, replacement, filters and alt text are implemented.
3. Richer shape/vector tools, gradients, shadows and reusable grouped components.
4. Managed image/font uploads with search, licensing metadata and brand governance.
5. Direct PNG/JPEG/SVG/PDF export with selectable resolution and predictable layout.
6. Template collections and locked brand layouts.

## Verification required for each capability

A tool must round-trip through saved templates, copied layouts, undo/redo, drafts, shared
sessions and version history. Design content must match record previews and exported
output. Exercise empty/long content, merged tables, images, narrow screens and both
themes. Larger model changes require migration tests and preservation of existing HTML
templates. Existing basic controls do not establish full compatibility with Word/Canva.

## Wordcraft port: editing foundation

The phased implementation is tracked in `WORDCRAFT-PORT-PLAN.md`. The first slice adds
selection-aware undo/redo (including backwards selections), explicit typing boundaries,
immediate Undo availability and native browser history-input routing. Composition input
is kept in one history transaction with DOM refresh and shared-room replacement deferred
until completion. Normal composition is supported; composition with tracked revisions
remains a documented limitation. This slice retains the HTML model and execCommand;
the model migration remains in phase 2.

The second slice introduces shared command dispatch for inline/paragraph/list formatting,
font/size/color, links/HTML insertion and history. Toolbar and keyboard formatting share
enabled/active state, backwards selections survive control/dialog focus changes, and
insert dialogs return focus to the document. Locked selections refuse commands; editable
text islands within floating objects remain supported. Browser formatting is still the
adapter behind these commands; typed model-backed editing is a later phase.

Clipboard copy preserves canonical field bindings; paste sanitizes rich HTML and rebuilds
atomic field chips. Plain text uses a text command. Cut and adjacent-token deletion use
undoable transactions and respect locked selections. Tab changes list nesting or navigates
table cells (including merged cells), adding a data row at the table's end. Native Enter
continues/exits lists. Tracked structural/token edits remain outside the review scope.

## Document model foundation

A versioned browser model and canonical HTML adapters preserve fields, repeat rows,
unknown HTML, SVG, sections/design pages and review/notes markup. Paragraph alignment
uses immutable model changes and patches live attributes without replacing text/chip nodes.
Existing HTML remains the saved representation. Model-backed typing, inline formatting,
semantic ranges and layout are subsequent slices; this is not a full engine replacement.
