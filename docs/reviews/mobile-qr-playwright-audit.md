# Mobile QR receiving and releasing acceptance audit

Audit started 2026-10-15, Asia/Manila. Branch: `restructure/module-architecture`.

## Scope and method

Repeat with `npm run test:mobile:qr`. The script starts a disposable loopback Express
server with separate SQLite databases/uploads and test accounts. Production data and
infrastructure are untouched. Production/QC prerequisites are seeded through the
real APIs; receiving and releasing run through the mobile UI at 390×844 using narrow
`receiving_clerk` and `releasing_clerk` accounts.

The UI opens the actual print sheet using server-provided label templates. Playwright
saves the sheet to PDF and decodes its QR image. That same image is turned into a
Y4M video frame supplied through Chromium's virtual camera. The application's
`getUserMedia` and scanner/decoder run normally. No scanner callbacks or successful
stock API responses are mocked. Network failure injection is limited to deliberately
losing a response after a real allocation commits, and refusing a template download.
The lost allocation resumes from restored IndexedDB and retries the identical body
and idempotency key; the database contains one allocation.

Artifacts are under ignored `work/mobile-qr-audit/`: machine-readable `report.json`,
unit/batch label PDFs and warehouse-out screenshots. These are disposable fixture
labels; they do not refer to a live company and must not be used as production tags.

## Confirmed findings and fixes

| Finding | Fix and evidence |
| --- | --- |
| A valid non-serialized batch was refused if another production run of the same product had serialized units. | Only unspecified bulk entry is subject to the broad serial-history guard. An explicit batch still must pass its own non-serialized, product, build-state, location and free-quantity checks. The real browser flow now receives/releases both tracking types of the same product. |
| QR preview compared a CKD component's fulfillment mode literally with the unit/batch build mode. | Physical `ckd_component` stock maps to standard/assembled, consistently with stock availability and allocation. The commercial CKD parent remains excluded. API regressions cover both batch preview and a serialized component that is correctly unavailable before RTS. |
| A failed unit-label-template request could open a blank print sheet and report labels ready. | Template download failure now reaches the existing error UI; missing/blank unit templates are refused before opening a sheet. Playwright aborts the request and verifies an error with no popup. |

PWA cache is bumped for the merged mobile assets. The audit preserves concurrent
semi-built finishing-conversion and company-login changes.

## Automated acceptance checks

1. Actual print sheets produce decodable immutable unit and batch QR PDFs, without stock changes.
2. The wrong virtual-camera sticker leaves confirmation disabled and moves no stock.
3. A batch camera scan receives only the counted quantity, leaving the rest unreceived.
4. An exact batch quantity is allocated to its sale without stock-out; interrupted-response recovery applies it once with the same request identity.
5. Reload during handoff cannot silently release stock.
6. Batch proof and signature are uploaded, attached to the slip, and warehouse-out consumes the selected stock once.
7. A unit camera scan receives that exact QA-passed unit.
8. Unit allocation selects the exact record and leaves stock unchanged until warehouse-out.
9. Unit proof/signature attachments and warehouse-out complete under the releasing role.
10. Read-only QR lookup distinguishes the specific sold unit from remaining stock of the same product and exposes no generic Stock In/Out actions for that record.
11. Each narrow clerk role is refused the other role's stock transition.
12. Camera unavailability exposes no manual verification form and keeps confirmation disabled.
13. Failed template download reports an error without a blank print sheet.

Validation: TypeScript passed; 172 focused regressions across seven files passed;
all 13 Playwright checks passed without page errors. The frozen full run passed
all 2,747 tests across 264 files. This includes the concurrent finishing-conversion
and company-login work. PWA cache v101 covers the merged mobile assets.

## Remaining limits

**Handoff draft recovery is unfinished.** Reloading loses unsubmitted handoff photos,
signature and token-verification state. The test confirms stock remains unchanged
and final confirmation is unavailable until recapture. This is safe blocking, not
durable recovery. Final-slip response-loss recovery and signature-upload recovery
remain part of that follow-up. Delivery completion is outside this QR audit.

**Physical device acceptance is still required.** A virtual camera proves the browser
scanner path, not phone autofocus, lighting, sticker placement, printer output or
Bluetooth printing. Headless PDF generation verifies print-sheet content, not paper.

The print error fix adds no new screen layout. Exact Figma context and screenshot
metadata were retrieved for node 74:316; no new pixel-match certification is claimed.

## Physical acceptance checklist

Use a test/staging company with the audited code, not the disposable fixture PDFs.

- Print fresh unit and non-serialized batch stickers, attach them, and scan them with the actual phone over HTTPS.
- As RTS clerk, try a wrong sticker, then receive the correct unit and a partial batch into the selected warehouse. Verify exact stock and remaining quantities.
- As releasing clerk, accept the sale and scan its stock. Check wrong product, build state and warehouse refusals; allocate the correct quantity and verify stock has not left yet.
- Check the recipient token, capture a real proof photo and signature, then confirm warehouse-out. Verify the slip, attached evidence, exact unit/batch assignment and resulting stock.
- Scan again using an authorized read-only account and verify current stock plus the specific unit/batch details.
- Test camera permission denial and interrupted allocation/retry. Until durable handoff recovery is implemented, expect a page restart during proof capture to require recapture.

## Follow-up, 2026-10-16

The original limits above describe the earlier snapshot. The follow-up extends the
same real-backend audit with a persistent Chromium profile, preserving actual
IndexedDB Blob files through browser process restarts. Exported Playwright storage
state is insufficient for photo/signature Blob bytes and is no longer used for that
claim. It injects committed response loss for attachment, final slip, delivery start
and POD, checks original keys/JSON and one stock transition, and exercises baseline
account visibility/API denial and desktop permission revocation on focus.

Final releasing and delivery now have durable drafts/attempts. Hardware acceptance
remains open. The current handoff records the final validation results.
