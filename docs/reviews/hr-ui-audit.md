# HR visual audit — 10 October 2026

This review covers the desktop web application's complete HR navigation surface and its shared record forms. It focuses on visual hierarchy, readable content, consistent light/dark themes, responsive layout, and dialog presentation. Redirects and end-to-end workflow behavior are a separate follow-up.

## Scope and method

The real frontend scripts and shared styles were rendered in Chromium with local sample API responses. The primary matrix contains 48 named screen/dialog states at 1440 × 1000 and 390 × 1000, each in light and dark mode: 192 render combinations. Screenshots and document/container bounds were inspected, with targeted rerenders after fixes. Additional checks covered 320px, 768px and 1024px breakpoints and the bottoms of long dialogs. Reduced motion was enabled for stable screenshot capture; the stylesheet retains the existing preference-aware entry/hover animations.

| Area | Screens and states reviewed |
| --- | --- |
| Overview | Attendance cards, requests, cutoff attention panel, module tiles |
| Employees | Directory, create/edit, Basic Info, Pay & Schedule, Payroll Rules, Leave & Records, import, numbering, rate change, asset issuance, ID preview |
| Contact verification | Worklist, contact values and change-history dialog |
| Company assets | Status cards, filters, register, return dialog |
| Timekeeping | Cutoff list, new cutoff, roster, daily-time grid, add employees, generate payslips |
| Timekeeping settings | Policy, shift editor, punch log, geofence, kiosk devices, holidays, no-work declarations |
| Payroll | Bundled records, record editor, payslip detail and print preview, worksheets, 13th-month pay, final-pay worksheet, statutory tables |
| Leave and HR forms | Leave records/editor, HR form gallery used by Memos & Notices |
| Anonymous reports | Worklist and case-detail dialog |
| Form setup | HR builder, new-form dialog, common-form gallery |
| Kiosk | Attendance screen and camera-unavailable presentation |

All HR view source files were included in the presentation inventory. Shared editors and nested dialogs inherit the HR dialog treatment; the matrix above names the specific rendered states rather than claiming every possible data combination was tested.

## Findings addressed

- Employee filters occupied full rows on desktop and mixed with primary actions. They now have a separate, labelled filter strip, with a compact header and clear create/import controls.
- Hidden controls could appear because component display rules overrode the browser's `[hidden]` behavior. HR screens and dialogs now honor that attribute.
- Employee photo and identity inputs were squeezed into narrow columns on phones. The identity block now stacks and provides full-width fields.
- HR-owned payroll and record pages lacked the section's header treatment, particularly when opened by form ID. A presentation marker now follows the HR section and HR-owned forms without changing navigation targets.
- Dialogs lacked consistent headers, tabs and footers, and the AI bubble overlapped their content. HR dialogs now appear above the bubble and keep their actions visible while the body scrolls.
- Dense attendance, contact-history, asset and payroll tables could clip columns or wrap headings into individual letters. Their containers now scroll horizontally with readable minimum table widths.
- Clipped accessibility labels inside the roster created a document-level horizontal scrollbar. Those labels are now anchored without changing their accessible text.
- Light-mode secondary and status text lacked sufficient contrast. The light palette was darkened; dark-mode colors retain their existing contrast.
- The kiosk referenced an undefined muted-color variable and exceeded narrow viewports. It now uses the shared text token and responsive card layout.
- Empty HR overview panels reserved excessive vertical space. They now use bounded content regions instead of fixed 420px bodies.
- A single payslip detail preview became blank when its configured template was missing. It now uses the same fallback template as the printable payroll layout, with a regression test.

## Verification and limits

JavaScript syntax checks and TypeScript checking passed. The frontend bootstrap/navigation/HR and payroll-print suites passed all 45 tests. The text/status token pairs measured in both themes met 4.5:1 contrast; this is a palette check, not a claim that every custom template passes a complete accessibility audit. Browser measurements checked page and dialog overflow, and targeted screenshots verified the corrected layouts.

The sample responses are not production employee data. This review does not validate real camera hardware, scanning, geolocation, uploads, email delivery, payroll calculations, database writes, or printer output. Print previews intentionally remain white documents inside a themed dialog. Tenant-customized templates can have their own layout constraints.

The standalone `/m` application is a separate interface and was not redesigned in this desktop HR pass. Redirect correctness, permissions across real sessions, workflow recovery/error behavior, and task-based UX testing remain the next audit.
