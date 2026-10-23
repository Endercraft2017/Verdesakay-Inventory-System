# Mobile Approvals review

Chunk 21 covers three existing surfaces: the approval deck, leave-balance confirmation,
and decision warnings. It preserves the mobile shell, request fields, avatar, timeline,
Reject / Note / Approve controls, and swipe/Previous/Next navigation.

## Decision contract

- Notes are optional, limited to 1,000 characters, and held by request kind/ID for the
  current sign-in. Switching cards, Undo, and failed reads retain the note.
- A decision captures its item, note and account. The same card stays visible during
  the existing 4.2-second Undo period and sending. Repeated or detached controls
  cannot decide another card. Continue review advances after a confirmed receipt.
- Leaving during Undo cancels the unsent decision. Sending is never flushed by a
  rerender. Leaving after sending begins leaves an unconfirmed result; aborting the
  browser request is not evidence that the server rolled it back.
- A lost response, timeout, or server failure blocks new decisions until Check latest
  status reads `/me/approvals`. Matching kind/ID in authorized history confirms its
  recorded status on this server. Fresh pending data permits an explicit new review.
  Missing from both pending and recent history proves neither outcome.
- An explicit retry of the exact uncertain body reuses its idempotency key. Changing
  the decision/note or adding a balance override uses a distinct body/key.
- Failed reads retain existing details and require a successful refresh before another
  decision. Permission refusals and account changes clear private review state.

## Dialogs and receipts

The balance dialog displays the exact server warning, request identity, and captured
note. Keep pending receives initial focus. Only Approve below balance sends an override.
The server still owns approval permissions, own-request restrictions, balances,
transaction rules and payroll locks. No backend rules or schema changed.

Receipts use the actual returned status. Site-PC saves explicitly await cloud
confirmation; clashes keep the existing status; an approved correction with
`applied:false` explains the missing cutoff, without inferring that explanation from
a clash or history alone. Information-change explanations are retained verbatim.
All returned warnings can be reopened from the last result on the existing screen.

Both app-owned dialogs trap keyboard focus, close with Escape, restore focus, and
make the background inert. They use the existing theme tokens. Mobile service-worker
cache v144 refreshes the revised assets.

## Verification

`tests/mobile-approval-balance.test.ts` exercises ownership, deferred decisions,
refresh gates, uncertain-result reconciliation, retry identity, permissions, dialogs,
and truthful receipts. Existing API/integrity tests cover server approval rules.
Actual-source Chromium checks use fictional fixtures only: no live approvals or
business writes. They cover the three surfaces in both themes, keyboard behavior,
and viewport widths 320, 360, 768, 1024 and 1440 pixels. Targeted axe scans supplement
these checks; they do not substitute for physical-device or screen-reader testing.

Focused verification passed 59 tests across the approval UI and existing approval/API
integrity suites. Actual-source Chromium passed 52 checks and 13 targeted axe scans
without violations, including long details and short-viewport dialog scrolling.

Final `npm run check` passed TypeScript and all 3,132 tests across 300 files.
